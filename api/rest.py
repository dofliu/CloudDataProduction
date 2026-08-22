"""FastAPI:REST 控制面(docs/04 §REST API)。

P0 提供:園區 / 目錄 / 設備即時值 / 歷史查詢 / 讀寫模擬時鐘。
引擎主迴圈、Modbus server、Historian flush 都掛在同一進程的 lifespan 裡
(docs/01:REST + 引擎同進程)。教師面 auth 在 P0 先寬鬆(P2 起強制)。
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from adapters.modbus_server import ModbusAdapter
from .auth import AuthStore
from engine.course import CourseManager
from engine.world import World
from historian.writer import Historian
from .alarm_rules import AlarmRuleStore
from .catalog import build_catalog
from .levels import LevelManager
from .maintenance import MaintenanceStore
from .polls import PollManager
from .submissions import SubmissionStore
from .classroom import ClassroomManager
from .diagnostics import run_diagnostics
from .commissioning import points_csv, points_doc, points_markdown
from .oee import OeeEngine
from .predictions import PredictionStore
from .scenarios import ScenarioManager
from .scoring import ScoringEngine
from .tickets import TicketStore
from .ws import ConnectionManager, register_ws_routes


class ClockPatch(BaseModel):
    multiplier: Optional[float] = None
    paused: Optional[bool] = None


class CoilRequest(BaseModel):
    name: str                       # run_enable / reset_fault
    value: bool = True


class SetpointRequest(BaseModel):
    name: str                       # 如 pressure_setpoint / spindle_rpm_setpoint
    value: float                    # 工程值;後端一律夾限到該設定點範圍


class EngraveTextRequest(BaseModel):
    text: str                       # CNC 刻字文字(≤8 字,A–Z / 0–9 / 空白 / -)


class FaultRequest(BaseModel):
    device: str
    fault_type: str                 # sudden/gradual/intermittent/cascading/sensor_*
    target: str                     # 退化元件名(設備故障)或 tag 名(感測器故障)
    severity: float = 1.0
    onset_sim_s: Optional[float] = None
    params: dict = {}


class ResolveRequest(BaseModel):
    """結案必須帶處置動作 —— 選對才修得好(見 engine/repair.py)。
    診斷不出來可以用 overhaul(整機大修),一定成功但停機最久。"""
    action: str
    student: Optional[str] = None         # 未登入的班級用它記名;登入時以 session 為準


class MaintenanceRequest(BaseModel):
    """預防保養:在還沒壞之前做。停機會計入可用率損失,所以做太勤也會扣分。"""
    device: str
    action: str
    student: Optional[str] = None


class AlarmRuleRequest(BaseModel):
    """學生託管告警規則(平台代跑,對 ground-truth 算 F1 / lead time)。"""
    device: str
    tag: str
    threshold: float
    op: str = ">"                          # > >= < <=
    agg: str = "raw"                       # raw | ema(指數移動平均)
    window_s: float = 0.0                  # agg=ema 的時間常數(模擬秒)
    for_s: float = 0.0                     # 條件需持續多久才告警(模擬秒)
    student: Optional[str] = None


class LevelMarkRequest(BaseModel):
    """教師勾選人工判定的關卡(視覺化 demo / 期末報告)。"""
    student: str
    level: str
    done: bool = True


class ClaimRequest(BaseModel):
    student_id: Optional[str] = None      # 登入後由 session 推定;教師可代為指派


class LoginRequest(BaseModel):
    username: str
    password: str


class UserSpec(BaseModel):
    username: str
    password: str
    role: Optional[str] = None


class BulkUsersRequest(BaseModel):
    users: List[UserSpec] = []
    role: Optional[str] = None            # 預設角色(student)


class PasswordRequest(BaseModel):
    password: str


class FactoryRequest(BaseModel):
    description: Optional[str] = None    # 自然語言建廠
    yaml: Optional[str] = None           # 或直接給公司設定 YAML


class ComposeDeviceSpec(BaseModel):
    template: str
    count: int = 1


class ComposeRequest(BaseModel):
    """整合建廠(A+B+C 自動上線):結構化設備組合,順序 = 製程順序。"""
    devices: list[ComposeDeviceSpec]
    name: Optional[str] = None
    selftest: bool = True                # 上線後 loopback 試連(只測新廠那幾台)


class PredictionRequest(BaseModel):
    device: str
    student: str = "anon"
    predicted_fault: str = "fault"
    eta_sim_s: Optional[float] = None
    confidence: float = 1.0


class ClassroomAnswerRequest(BaseModel):
    """課堂練習作答:匿名以座號/學號,answer 可為數字或選項字串。"""
    exercise: str
    question: str
    student: str
    answer: object = None


class ClassroomLaunchRequest(BaseModel):
    """佈題可帶倒數(wall-clock 秒;學生盯的是教室的鐘,不是模擬時鐘)。"""
    duration_s: Optional[float] = None


class ClassroomExtendRequest(BaseModel):
    seconds: float = 120.0      # 延長倒數(可為負 = 提早收)


class PollOpenRequest(BaseModel):
    duration_s: Optional[float] = 120.0
    device: Optional[str] = None


class PollVoteRequest(BaseModel):
    poll: str
    option: str
    student: str


class PollCloseRequest(BaseModel):
    execute: bool = True        # 收票後是否真的照多數決去動引擎


class ClassroomStopRequest(BaseModel):
    reset: bool = True          # 收題時是否把設備修回健康


class SessionResetRequest(BaseModel):
    """教師「重置課堂資料」的可選範圍(預設全清)。"""
    claims: bool = True         # 公司認領
    tickets: bool = True        # 工單
    predictions: bool = True    # 階段二預測
    oee: bool = True            # OEE 累積器
    devices: bool = True        # 把所有設備修回健康(清故障 / 注入)
    maintenance: bool = True    # 保養紀錄
    alarm_rules: bool = True    # 學生託管告警規則與告警紀錄
    polls: bool = True          # 全班投票紀錄
    levels: bool = True         # 關卡的教師勾選紀錄(自動判定的關卡本就跟著資料歸零)


# ── 取數輔助(T14)────────────────────────────────────────
# wide 內部多撈的硬上限:limit × 序列數 可能很大,不能無上限打 DB。
# 超過就截斷並在回應標 truncated —— 靜靜少給資料比報錯更糟。
_MAX_FETCH_ROWS = 200_000


def _split_csv(raw: Optional[str]) -> List[str]:
    """逗號分隔字串 → 去空白、去重、保序的清單。"""
    if not raw:
        return []
    return [x for x in dict.fromkeys(p.strip() for p in raw.split(",")) if x]


def _csv_response(cols: List[str], rows: List[dict], stem: str) -> Response:
    """匯出 CSV。用 csv 模組而不是自己接字串 —— 值裡有逗號 / 引號時才不會把欄位切錯。

    帶 UTF-8 BOM:Excel 在中文 Windows 上預設用 CP950 開 CSV,沒有 BOM 會變亂碼,
    而這門課的學生多半就是用 Excel 先看一眼。
    """
    import csv as _csv
    import io as _io
    buf = _io.StringIO()
    w = _csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return Response("\ufeff" + buf.getvalue(),
                    media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{stem}.csv"'})


def create_app(
    world: World,
    historian: Historian,
    modbus: ModbusAdapter | None,
    config: dict,
    opcua=None,
    mqtt=None,
    multiport=None,
    control=None,
    state=None,
    access_log=None,
) -> FastAPI:
    public_host = config.get("public_host", "127.0.0.1")
    teacher_token = config.get("teacher_token", "")

    # WebSocket 即時面連線管理器(telemetry / events 兩通道)
    telemetry_mgr = ConnectionManager("telemetry")
    events_mgr = ConnectionManager("events")

    # 營運狀態持久化:開 state.db,開機載入工單/預測、還原 OEE 累積器、公司認領(進程重啟不歸零)
    if state is not None:
        state.connect()
        world.restore_oee(state.load("oee", {}))
        _saved_owners = state.load("owners", {}) or {}
        for _c in world.park.get("companies", []):
            if _c.get("id") in _saved_owners:
                _c["owner"] = _saved_owners[_c["id"]]

    # ── 身分層:帳號 / 登入 / 角色 ────────────────────────────
    auth = AuthStore(persist=state)

    def _bearer(authorization: Optional[str]) -> Optional[str]:
        if authorization and authorization.startswith("Bearer "):
            return authorization[7:]
        return None

    def auth_active() -> bool:
        """是否已啟用身分驗證(設了 teacher_token 或建了任何帳號)。未啟用 → dev 開放。"""
        return bool(teacher_token) or auth.has_users()

    def current_user(authorization: Optional[str]) -> Optional[dict]:
        """解出目前使用者:{username, role} 或 None。teacher_token 視為管理員(teacher)。"""
        tok = _bearer(authorization)
        if not tok:
            return None
        if teacher_token and tok == teacher_token:
            return {"username": "__admin__", "role": "teacher"}
        return auth.user_for_token(tok)

    def require_teacher(authorization: str = Header(None)):
        """教師面 auth:teacher 角色 session 或 teacher_token。完全未啟用身分驗證時(dev)放行。"""
        u = current_user(authorization)
        if u and u["role"] == "teacher":
            return
        if not auth_active():
            return
        raise HTTPException(401, "需要教師身分(請以教師帳號或管理員 token 登入)")

    # 工單 + 評分(工單訂閱故障事件自動開單)
    tickets = TicketStore(world, persist=state)
    scoring = ScoringEngine(world, tickets)

    # 階段二預測(發 prediction / prediction_hit 走 events 通道)
    predictions = PredictionStore(world, persist=state)
    predictions.set_emitter(events_mgr.broadcast)

    # 情境腳本(災難日);步驟事件走 events 通道
    scenarios = ScenarioManager(world)
    scenarios.set_emitter(events_mgr.broadcast)

    # OEE 設備總效率排名
    oee = OeeEngine(world)

    # 學生的兩個「有代價的決策」:預防保養(停機換壽命)與託管告警規則(門檻對不對)
    maintenance = MaintenanceStore(world, persist=state)
    alarm_rules = AlarmRuleStore(world, persist=state)
    alarm_rules.set_emitter(events_mgr.broadcast)

    # 課程情境(教師手動套用每週條件)+ 作業自動比對(對 ground-truth 計分)
    course = CourseManager(world, path=config.get("course_file", "scenarios/course_weeks.yaml"))
    submissions = SubmissionStore(world, historian, course, persist=state)
    # 課堂即時練習(重用 submissions 的誠實批改;佈題只呼叫既有引擎介面)
    classroom = ClassroomManager(world, submissions,
                                 path=config.get("classroom_file", "scenarios/classroom_exercises.yaml"),
                                 persist=state)

    # 全班投票(投完照多數決真的去動引擎;投票對象跟著課堂佈題那台)
    polls = PollManager(world, classroom=classroom,
                        path=config.get("polls_file", "scenarios/classroom_polls.yaml"),
                        persist=state)

    # 資料的一生九關:通關判定全部復用既有的誠實批改器與各 store,不自存進度(見 api/levels.py)
    levels = LevelManager(
        world, submissions, tickets, maintenance, alarm_rules, predictions,
        access_log=access_log,
        roster=lambda: [u["username"] for u in auth.list_users() if u.get("role") == "student"],
        path=config.get("levels_file", "scenarios/levels.yaml"), persist=state)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # 啟動順序:先連 Historian、起協定 server,再把各訂閱者掛進世界,最後起世界迴圈
        await historian.connect()
        historian.start_background()
        if opcua is not None:
            await opcua.start()
        if mqtt is not None:
            await mqtt.start()
        if modbus is not None:
            world.subscribe(modbus.on_snapshot)
        if control is not None:
            world.subscribe(control.on_snapshot)          # 教師控制埠:反射狀態 + 接受 FC05 寫線圈
        if multiport is not None:
            world.subscribe(multiport.on_snapshot)        # 同一 snapshot → 每台專屬埠
        if opcua is not None:
            world.subscribe(opcua.on_snapshot)            # 同一 snapshot → OPC-UA 節點
        if mqtt is not None:
            world.subscribe(mqtt.on_snapshot)             # 同一 snapshot → MQTT topic
        world.subscribe(historian.on_snapshot)
        world.subscribe_events(historian.on_event)       # 事件 → historian.events(MTBF / 停機 Pareto)
        world.subscribe_production(historian.on_pieces)  # 逐件明細 → production + 每小時彙總
        world.subscribe(telemetry_mgr.on_message)        # telemetry → 瀏覽器
        world.subscribe_events(events_mgr.on_message)     # 事件 → 瀏覽器
        world.subscribe_events(tickets.on_event)          # 故障事件 → 自動開工單
        world.subscribe_events(predictions.on_event)      # 故障事件 → 比對預測命中
        world.subscribe(alarm_rules.on_snapshot)          # 每 snapshot 評估學生託管的告警規則
        world.subscribe_events(alarm_rules.on_event)      # 故障事件 → 告警命中 / 漏報配對
        if modbus is not None:
            modbus.start_background()
        if control is not None:
            control.start_background()
        if multiport is not None:
            multiport.start_background()
        world_task = asyncio.create_task(world.run())

        async def oee_save_loop():                        # OEE 累積器定期落盤(每 30s),關閉時再存一次
            while True:
                await asyncio.sleep(30.0)
                if state is not None:
                    state.save("oee", world.oee_snapshot())
        oee_task = asyncio.create_task(oee_save_loop()) if state is not None else None
        print("[api] 世界已啟動,等待連線。")
        try:
            yield
        finally:
            world.stop()
            world_task.cancel()
            if oee_task is not None:
                oee_task.cancel()
            if multiport is not None:
                await multiport.stop()
            if mqtt is not None:
                await mqtt.stop()
            if opcua is not None:
                await opcua.stop()
            await historian.close()
            if state is not None:                         # 關閉前把 OEE 最後狀態落盤(工單/預測已寫穿)
                state.save("oee", world.oee_snapshot())
                state.close()
            print("[api] 已關閉。")

    app = FastAPI(
        title="CloudDataProduction · 虛擬智慧工業區(P0)",
        description="合成(synthetic)工業設備數據教學平台。所有數據皆為模擬,非真實場域量測。",
        version="0.1.0-p0",
        lifespan=lifespan,
    )

    # 開發期允許跨來源:Vite 開發伺服器(:5173)與瀏覽器直連 API / WS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── 身分驗證(登入 / 帳號)──────────────────────────────
    @app.get("/api/auth/status")
    def auth_status():
        """前端據此決定是否顯示登入頁。auth_required=False 時為 dev 開放模式。"""
        return {"auth_required": auth_active(), "has_users": auth.has_users()}

    @app.post("/api/auth/login")
    def auth_login(req: LoginRequest):
        r = auth.login(req.username, req.password)
        if r is None:
            raise HTTPException(401, "帳號或密碼錯誤")
        return r

    @app.post("/api/auth/logout")
    def auth_logout(authorization: str = Header(None)):
        auth.logout(_bearer(authorization))
        return {"ok": True}

    @app.get("/api/auth/me")
    def auth_me(authorization: str = Header(None)):
        u = current_user(authorization)
        if u is None:
            raise HTTPException(401, "未登入")
        return u

    @app.get("/api/auth/users", dependencies=[Depends(require_teacher)])
    def auth_list_users():
        return {"users": auth.list_users()}

    @app.post("/api/auth/users", dependencies=[Depends(require_teacher)])
    def auth_create_users(req: BulkUsersRequest):
        """教師批次建立帳號(名冊制)。role 預設 student。"""
        specs = [u.model_dump() for u in req.users]
        return auth.bulk_create(specs, default_role=req.role or "student")

    @app.post("/api/auth/users/{username}/password", dependencies=[Depends(require_teacher)])
    def auth_reset_password(username: str, req: PasswordRequest):
        try:
            return auth.set_password(username, req.password)
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.delete("/api/auth/users/{username}", dependencies=[Depends(require_teacher)])
    def auth_delete_user(username: str):
        return {"deleted": auth.delete_user(username)}

    @app.get("/api/students/overview", dependencies=[Depends(require_teacher)])
    def students_overview():
        """教師面:每位學生的進度總覽(認領 / 作業 / 工單 / 預測),一次組好。"""
        gb = {r["student"]: r for r in submissions.gradebook()}
        pred = {r["student"]: r for r in predictions.scores().get("ranking", [])}
        comp_by_owner = {}
        for c in world.park.get("companies", []):
            if c.get("owner"):
                comp_by_owner[c["owner"]] = c
        # 名單 = 學生帳號 ∪ 有認領 / 繳交 / 預測足跡者(涵蓋 legacy 免帳號資料)
        names = {u["username"] for u in auth.list_users() if u["role"] == "student"}
        names |= set(comp_by_owner) | set(gb) | set(pred)
        accounts = {u["username"] for u in auth.list_users()}
        rows = []
        for name in sorted(names):
            c = comp_by_owner.get(name)
            subs = submissions.list(student=name)
            tk = tickets.list(owner=name)
            g = gb.get(name)
            p = pred.get(name)
            rows.append({
                "student": name,
                "has_account": name in accounts,
                "company": {"id": c["id"], "name": c.get("name"),
                            "devices": len(c.get("devices", []) or [])} if c else None,
                "submissions": len(subs),
                "assignments_done": g["count"] if g else 0,
                "avg_score": g["avg"] if g else None,
                "tickets_open": sum(1 for t in tk if t["status"] in ("open", "acked")),
                "tickets_resolved": sum(1 for t in tk if t["status"] == "resolved"),
                "predictions": p["predictions"] if p else 0,
                "pred_hits": p["hits"] if p else 0,
            })
        return {"students": rows}

    @app.get("/api/students/{username}", dependencies=[Depends(require_teacher)])
    def student_detail(username: str):
        """教師面:單一學生細項(認領公司 + 每筆繳交 / 工單 / 預測)。總覽點進來用。"""
        company = next((c for c in world.park.get("companies", []) if c.get("owner") == username), None)
        return {
            "student": username,
            "company": {"id": company["id"], "name": company.get("name"),
                        "device_ids": [d.get("id") for d in company.get("devices", []) or []]} if company else None,
            "submissions": submissions.list(student=username),
            "tickets": tickets.list(owner=username),
            "predictions": predictions.list(student=username),
        }

    # ── 公開學生面 ─────────────────────────────────────────
    # 註:根路徑 "/" 保留給前端靜態檔(設 WEB_DIST 時);此為 API 資訊索引。
    @app.get("/api")
    def api_info():
        return {
            "name": "CloudDataProduction",
            "phase": "P0",
            "synthetic_data": True,
            "endpoints": ["/api/health", "/api/park", "/api/catalog", "/api/devices/{id}", "/api/history",
                          "/api/orders", "/api/submissions", "/api/course/status"],
        }

    @app.get("/api/health")
    def health():
        """輕量健康檢查(給排程器 / 監控輪詢):世界是否在跑、設備數、sim 時鐘、持久層狀態。"""
        return {
            "ok": world._running and len(world.devices) > 0,
            "running": world._running,
            "devices": len(world.devices),
            "sim_t": round(world.clock.now(), 1),
            "multiplier": world.clock.time_multiplier,
            "historian": "degraded(in-memory)" if historian.degraded else historian.backend,
            "synthetic": True,
        }

    @app.get("/api/park")
    def get_park():
        return world.park_view()

    @app.get("/api/catalog")
    def get_catalog():
        return build_catalog(world, host=public_host)

    @app.get("/api/diagnostics/protocols")
    async def diagnostics_protocols():
        # 戰情版 / 連線自測:用三協定 client 連回自己的 server(loopback)逐設備讀樣本值
        return await run_diagnostics(world, host="127.0.0.1", ports=world.ports)

    @app.get("/api/devices/{device_id}")
    def get_device(device_id: str):
        device = world.devices.get(device_id)
        if device is None:
            raise HTTPException(404, f"無此設備:{device_id}")
        return device.public_snapshot()

    # ── 取數介面(T14)────────────────────────────────────────
    #
    # 舊呼叫(?device=&tag=)**原封不動**:回傳形狀、欄位名、上限全部沒變 ——
    # 學生已經寫好的程式與既有前端不能因為升級而壞掉。
    # 只要用到任何新參數(devices / tags / bucket / shape / format / agg)才走新路徑。
    #
    # 為什麼要做這一段:一條產線的跨設備相關分析,先前得打幾十次 API 再自己對齊時間戳,
    # 取數本身變成作業的主要難度 —— 而這門課要教的是「怎麼從資料看出問題」,不是對時間戳。
    @app.get("/api/history")
    async def get_history(
        device: Optional[str] = Query(None, description="設備 id(舊參數,單台)"),
        tag: Optional[str] = Query(None, description="tag 名稱(舊參數,單支)"),
        devices: Optional[str] = Query(None, description="多設備,逗號分隔,如 d001,d002"),
        tags: Optional[str] = Query(None, description="多 tag,逗號分隔,如 vibration_rms,spindle_temp"),
        from_: Optional[float] = Query(None, alias="from", description="起始 wall epoch 秒"),
        to: Optional[float] = Query(None, description="結束 wall epoch 秒"),
        limit: int = Query(5000, ge=1, le=50000),
        bucket: float = Query(0.0, ge=0.0, le=86400.0,
                              description="時間桶秒數(0=原始點)。常用 1 / 60 / 3600"),
        shape: Optional[str] = Query(None, description="wide(預設,時間已對齊)| long"),
        agg: str = Query("avg", description="wide + bucket 時每格放哪個統計量:avg|min|max|count"),
        format: str = Query("json", description="json | csv"),
    ):
        legacy = (devices is None and tags is None and bucket <= 0
                  and shape is None and format == "json")
        dev_list = _split_csv(devices) or ([device] if device else [])
        tag_list = _split_csv(tags) or ([tag] if tag else [])
        if not dev_list or not tag_list:
            raise HTTPException(422, "需要 device/tag 或 devices/tags")
        unknown = [d for d in dev_list if d not in world.devices]
        if unknown:
            raise HTTPException(404, f"無此設備:{', '.join(unknown[:5])}")

        # ── 舊路徑:形狀完全不變 ──
        if legacy:
            rows = await historian.query(dev_list[0], tag_list[0], from_, to, limit)
            return {
                "device": dev_list[0],
                "tag": tag_list[0],
                "count": len(rows),
                "degraded": historian.degraded,  # True 表示來自 in-memory fallback
                "points": rows,
            }

        if agg not in Historian._AGGS:
            raise HTTPException(422, f"agg 需為 {'|'.join(Historian._AGGS)}")
        shape = (shape or "wide").lower()
        if shape not in ("wide", "long"):
            raise HTTPException(422, "shape 需為 wide 或 long")
        # limit 的語意依形狀而不同,否則 wide 會被切得坑坑洞洞:
        #   long → 就是回傳列數
        #   wide → **時間列數**。wide 一列要放齊所有序列,若照 long 的列數截斷,
        #          最舊那個時間點會少掉幾欄變成 null(學生拿到的表格右上角是破的)。
        #          所以內部多撈 n_series 倍,再取最後 limit 個時間點。
        n_series = max(1, len(dev_list) * len(tag_list))
        fetch = limit if shape == "long" else min(limit * n_series, _MAX_FETCH_ROWS)
        rows = await historian.query_multi(dev_list, tag_list, from_, to, bucket, fetch)
        truncated = len(rows) >= fetch
        # 要了卻一筆都沒有的序列要**講出來**。不是每台設備都有每一支 tag
        # (CNC 是 spindle_current、研磨機才是 motor_current),窗內沒資料也可能是
        # 那段時間沒運轉。靜靜少一欄,學生會以為那台沒問題 —— 那是誤導。
        present = {(r["device"], r["tag"]) for r in rows}
        missing = [f"{d}:{t}" for d in dev_list for t in tag_list if (d, t) not in present]
        meta = {
            "devices": dev_list, "tags": tag_list, "bucket_s": bucket,
            "shape": shape, "rows": len(rows), "truncated": truncated,
            "missing": missing,          # 要了但窗內無資料的序列(該設備沒這支 tag,或那段沒運轉)
            "degraded": historian.degraded,
            # 這座園區的 historian 是對**同一份 snapshot** 取樣的,一拍裡所有設備共用
            # 同一個 wall_t —— 所以原始點本來就對得齊,不必先降採樣才能並排。
            # 真工廠的多來源資料沒這個性質,教材要記得講這個差別。
            "note": "同一拍的所有設備共用同一個時間戳(模擬平台特性,真工廠需自行對齊)",
        }
        if shape == "long":
            if format == "csv":
                cols = (["t", "sim_t", "device", "tag", "value"] if bucket <= 0
                        else ["t", "sim_t", "device", "tag", "avg", "min", "max", "count"])
                return _csv_response(cols, rows, "history_long")
            return {**meta, "points": rows}

        # ── wide:一列一個時間點,每支序列一欄(時間已對齊,可直接丟 pandas)──
        # wide 是二維表格,一格只放得下**一個**統計量 —— 降採樣時由 ?agg= 決定放哪個;
        # 四個統計量都要就用 shape=long(那邊四欄都在)。
        value_key = "value" if bucket <= 0 else agg
        one_dev = len(dev_list) == 1
        table: dict = {}
        sim_of: dict = {}
        for r in rows:
            col = r["tag"] if one_dev else f"{r['device']}:{r['tag']}"
            table.setdefault(col, {})[r["t"]] = r.get(value_key)
            sim_of.setdefault(r["t"], r.get("sim_t"))
        cols = sorted(table)
        times = sorted(sim_of)[-limit:]          # 只留最後 limit 個**時間點**
        points = [{"t": t, "sim_t": sim_of.get(t),
                   **{c: table[c].get(t) for c in cols}} for t in times]
        truncated = truncated or len(sim_of) > len(times)
        if format == "csv":
            return _csv_response(["t", "sim_t", *cols], points, "history_wide")
        return {**meta, "columns": cols, "value": value_key,
                "rows": len(points), "truncated": truncated, "points": points}

    # ── 事件 / 逐件生產 / 每小時彙總(學生面公開唯讀)──────
    #
    # 這三支是「資料鏈」的取數入口(docs/資料盤點_生產數據完整性.md 的 P1)。
    # 先前這些資料只存在於當下:事件廣播完就沒了、產線帳只有即時視圖 —— 學生因此
    # 算不出 MTBF、做不出停機 Pareto、追溯不到一件不良品。
    #
    # ground-truth 一律不出現在這裡:事件不帶故障元件名、逐件明細只給品質結果
    # (良 / 不良 / 不良類型),要看「哪個元件在壞」仍得走教師面的 /api/devices/{id}/health。
    @app.get("/api/history/events")
    async def get_events(
        device: Optional[str] = Query(None, description="設備 id"),
        company: Optional[str] = Query(None, description="公司 id"),
        type: Optional[str] = Query(None, description="fault | state_change"),
        stop_reason: Optional[str] = Query(None, description="停機原因碼(見 /api/catalog)"),
        from_: Optional[float] = Query(None, alias="from", description="起始 wall epoch 秒"),
        to: Optional[float] = Query(None, description="結束 wall epoch 秒"),
        limit: int = Query(2000, ge=1, le=50000),
    ):
        if device is not None and device not in world.devices:
            raise HTTPException(404, f"無此設備:{device}")
        rows = await historian.query_events(device_id=device, company_id=company, ev_type=type,
                                            stop_reason=stop_reason, t_from=from_, t_to=to,
                                            limit=limit)
        return {"count": len(rows), "degraded": historian.degraded, "events": rows}

    @app.get("/api/production")
    async def get_production(
        device: Optional[str] = Query(None, description="設備 id"),
        company: Optional[str] = Query(None, description="公司 id"),
        serial: Optional[str] = Query(None, description="工件序號(追溯單一件)"),
        good: Optional[bool] = Query(None, description="true=只看良品 / false=只看不良"),
        defect: Optional[str] = Query(None, description="不良類型"),
        from_: Optional[float] = Query(None, alias="from", description="起始 wall epoch 秒"),
        to: Optional[float] = Query(None, description="結束 wall epoch 秒"),
        limit: int = Query(2000, ge=1, le=50000),
    ):
        """逐件生產明細(追溯用)。明細保留期較短(見 .env 的 PRODUCTION_RETENTION_DAYS),
        長期趨勢請用 /api/production/hourly。"""
        if device is not None and device not in world.devices:
            raise HTTPException(404, f"無此設備:{device}")
        rows = await historian.query_production(device_id=device, company_id=company,
                                                serial=serial, good=good, defect=defect,
                                                t_from=from_, t_to=to, limit=limit)
        return {"count": len(rows), "degraded": historian.degraded,
                "retention_days": historian.production_retention_days, "pieces": rows}

    @app.get("/api/production/hourly")
    async def get_production_hourly(
        device: Optional[str] = Query(None, description="設備 id"),
        company: Optional[str] = Query(None, description="公司 id"),
        from_: Optional[float] = Query(None, alias="from", description="起始 wall epoch 秒"),
        to: Optional[float] = Query(None, description="結束 wall epoch 秒"),
        limit: int = Query(5000, ge=1, le=50000),
    ):
        """每台每小時 × 每種結果的件數(defect="" 代表良品)。
        良率 = 良品件數 / 總件數;不良 Pareto = 依 defect 分組加總。"""
        if device is not None and device not in world.devices:
            raise HTTPException(404, f"無此設備:{device}")
        rows = await historian.query_production_hourly(device_id=device, company_id=company,
                                                       t_from=from_, t_to=to, limit=limit)
        good = sum(r["pieces"] for r in rows if not r["defect"])
        total = sum(r["pieces"] for r in rows)
        return {"count": len(rows), "degraded": historian.degraded,
                "totals": {"pieces": total, "good": good, "reject": total - good,
                           "yield": round(good / total, 4) if total else None},
                "buckets": rows}

    # ── 工單 / 評分(學生面公開)──────────────────────────
    @app.get("/api/tickets")
    def list_tickets(owner: Optional[str] = None, status: Optional[str] = None,
                     authorization: str = Header(None)):
        """學生面看不到 component / fault_type(那是根因 = 答案),只看得到症狀。
        教師身分才 reveal 根因。"""
        u = current_user(authorization)
        reveal = bool(u and u["role"] == "teacher") or not auth_active()
        return {"tickets": tickets.list(owner=owner, status=status, reveal=reveal)}

    @app.post("/api/tickets/{ticket_id}/ack")
    def ack_ticket(ticket_id: str):
        t = tickets.ack(ticket_id)
        if t is None:
            raise HTTPException(404, f"無此工單:{ticket_id}")
        return {"ok": True, "ticket": tickets._redact(t)}

    # 結案要選處置動作:選對才修得好,選錯照樣扣維修工時、工單退回處理中。
    # 動作清單與各自的「數據上長什麼樣」見 GET /api/repair/actions。
    @app.post("/api/tickets/{ticket_id}/resolve")
    def resolve_ticket(ticket_id: str, req: ResolveRequest, authorization: str = Header(None)):
        u = current_user(authorization)
        actor = (u["username"] if u else None) or req.student
        res = tickets.resolve(ticket_id, req.action, actor=actor)
        if not res.get("ok"):
            raise HTTPException(404 if "無此工單" in str(res.get("error", "")) else 400,
                                res.get("error", "處置失敗"))
        return res

    # 維修手冊(公開):有哪些處置動作、各要多少工時、在數據上長什麼樣。
    # 不含「哪台該用哪個」—— 那要學生自己從遙測判斷,所以給出去不會洩答案。
    @app.get("/api/repair/actions")
    def repair_actions():
        from engine.repair import manual
        return {"actions": manual(),
                "note": "選錯動作不會修好設備,但仍佔用 60% 工時(停機計入可用率損失)。"}

    # ── 預防保養(學生面,需認領授權)────────────────────────
    @app.post("/api/maintenance")
    def do_maintenance(req: MaintenanceRequest, authorization: str = Header(None)):
        device = world.devices.get(req.device)
        if device is None:
            raise HTTPException(404, f"無此設備:{req.device}")
        _authorize_setpoint_write(device, authorization)     # 只能保養自己認領公司的設備
        u = current_user(authorization)
        actor = (u["username"] if u else None) or req.student
        res = maintenance.apply(req.device, req.action, actor=actor)
        if not res.get("ok"):
            raise HTTPException(400, res.get("error", "保養失敗"))
        return res

    @app.get("/api/maintenance")
    def list_maintenance(actor: Optional[str] = None, device: Optional[str] = None):
        return {"maintenance": maintenance.list(actor=actor, device=device),
                "summary": maintenance.summary()}

    # ── 學生託管告警規則(平台代跑,對 ground-truth 算 F1 / lead time)──
    @app.post("/api/alarm_rules")
    def create_alarm_rule(req: AlarmRuleRequest, authorization: str = Header(None)):
        u = current_user(authorization)
        student = (u["username"] if u else None) or req.student or "anon"
        res = alarm_rules.add({**req.model_dump(), "student": student})
        if not res.get("ok"):
            raise HTTPException(400, res.get("error", "規則建立失敗"))
        return res

    @app.get("/api/alarm_rules")
    def list_alarm_rules(student: Optional[str] = None):
        return {"rules": alarm_rules.list(student=student),
                "alerts": alarm_rules.list_alerts(student=student)}

    @app.delete("/api/alarm_rules/{rule_id}")
    def delete_alarm_rule(rule_id: str, authorization: str = Header(None)):
        u = current_user(authorization)
        owner = None if (u and u["role"] == "teacher") else (u["username"] if u else None)
        res = alarm_rules.delete(rule_id, student=owner)
        if not res.get("ok"):
            raise HTTPException(400, res.get("error", "刪除失敗"))
        return res

    @app.get("/api/alarm_rules/scores")
    def alarm_rule_scores():
        return alarm_rules.scores()

    # ── 資料的一生九關 ─────────────────────────────────────
    @app.get("/api/levels")
    def level_defs():
        """關卡定義(公開):九關 + 支線徽章,含每關的提示與判定方式。"""
        return {"levels": levels.levels, "badges": levels.badges}

    @app.get("/api/levels/{student}")
    def level_status(student: str):
        """某學生的過關狀態:每關 done + 佐證一句話 + 下一關提示。全部現查,不快取。"""
        return levels.status(student)

    @app.get("/api/levels/board/all", dependencies=[Depends(require_teacher)])
    def level_board():
        """全班進度熱力圖:N×9 矩陣 + 每關卡關人數 + 瓶頸關。"""
        return levels.board()

    @app.post("/api/levels/mark", dependencies=[Depends(require_teacher)])
    def level_mark(req: LevelMarkRequest, authorization: str = Header(None)):
        """教師勾選人工判定的關卡(視覺化 demo / 期末報告)。"""
        u = current_user(authorization)
        res = levels.mark(req.student, req.level, req.done, by=(u or {}).get("username", "teacher"))
        if not res.get("ok"):
            raise HTTPException(400, res.get("error", "勾選失敗"))
        return res

    @app.get("/api/access_log")
    def get_access_log(device: Optional[str] = None):
        """協定端存取軌跡:哪台設備被讀了幾次、平均多久打一次。
        教 W2 接取 / W10 輪詢vs訂閱時可直接把學生自己的請求量投影出來。"""
        if access_log is None:
            return {"rows": [], "note": "未啟用協定存取軌跡"}
        return access_log.view(device)

    # ── MES 工單(學生面公開唯讀;Phase 1)──────────────────
    # ── 跨公司供應鏈(engine/supply.py;學生面公開唯讀)──────
    @app.get("/api/supply")
    def get_supply():
        """所有供應關係的進料倉狀態 + 目前正在餓料 / 阻塞的連鎖反應。
        全部現讀引擎(鐵則一:庫存真值在 engine/supply.py)。"""
        return {"links": world.supply.view(), "impact": world.supply.impact(),
                "synthetic": True}

    @app.get("/api/supply/{company_id}")
    def get_company_supply(company_id: str):
        """我等誰的料、誰在等我 —— 學生面的上下游視圖。"""
        if not any(c.get("id") == company_id for c in world.park.get("companies", [])):
            raise HTTPException(404, f"無此公司:{company_id}")
        return world.supply.for_company(company_id)

    @app.get("/api/orders")
    def list_orders(company: Optional[str] = None, device: Optional[str] = None,
                    status: Optional[str] = None):
        """公司的生產工單:設備因工單而運轉,無單則待機(不磨損)。
        參數 company / device / status 皆可選,用於過濾。"""
        return {
            "enabled": world.mes.enabled,
            "orders": world.mes.list_orders(company=company, device=device, status=status),
        }

    @app.get("/api/orders/summary")
    def orders_summary(company: Optional[str] = None):
        return world.mes.summary(company=company)

    # ── 作業自動比對(學生面公開繳交)──────────────────────
    @app.post("/api/submissions")
    async def post_submission(payload: dict):
        """繳交作業並自動對 ground-truth 計分。type: connect/stats/oee/anomaly(見 api/submissions.py)。"""
        try:
            return await submissions.submit(payload)
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.get("/api/submissions")
    def list_submissions(student: Optional[str] = None, week: Optional[str] = None, type: Optional[str] = None):
        return {"submissions": submissions.list(student=student, week=week, type=type)}

    @app.get("/api/submissions/leaderboard")
    def submissions_leaderboard(week: Optional[str] = None, type: Optional[str] = None):
        return {"leaderboard": submissions.leaderboard(week=week, type=type)}

    @app.get("/api/submissions/gradebook")
    def submissions_gradebook(week: Optional[str] = None, type: Optional[str] = None):
        """成績冊:每位學生每項作業取最佳分並彙整平均(期中/期末自動批改部分)。"""
        return {"gradebook": submissions.gradebook(week=week, type=type)}

    # ── 課程情境(狀態/週表公開唯讀;套用需教師 auth)────────
    @app.get("/api/course/status")
    def course_status():
        return course.status()

    @app.get("/api/course/weeks")
    def course_weeks():
        return {"weeks": course.list_weeks()}

    @app.post("/api/course/weeks/{n}/apply", dependencies=[Depends(require_teacher)])
    def course_apply(n: int):
        try:
            return course.apply_week(n)
        except KeyError as e:
            raise HTTPException(404, str(e))

    # ── 課堂即時練習(列表/目前佈題/作答=公開;佈題/收題/看板=教師)──
    @app.get("/api/classroom/exercises")
    def classroom_exercises():
        return {"name": classroom.name, "exercises": classroom.list_exercises()}

    @app.get("/api/classroom/exercises/{exercise_id}")
    def classroom_exercise(exercise_id: str):
        try:
            return classroom.get_exercise(exercise_id)
        except KeyError as e:
            raise HTTPException(404, str(e))

    @app.get("/api/classroom/active")
    def classroom_active():
        return classroom.active_view()

    @app.post("/api/classroom/answer")
    async def classroom_answer(req: ClassroomAnswerRequest):
        try:
            return await classroom.answer(req.exercise, req.question, req.student, req.answer)
        except KeyError as e:
            raise HTTPException(404, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/classroom/exercises/{exercise_id}/launch", dependencies=[Depends(require_teacher)])
    def classroom_launch(exercise_id: str, req: ClassroomLaunchRequest = ClassroomLaunchRequest()):
        try:
            return classroom.launch(exercise_id, duration_s=req.duration_s)
        except KeyError as e:
            raise HTTPException(404, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/classroom/extend", dependencies=[Depends(require_teacher)])
    def classroom_extend(req: ClassroomExtendRequest):
        """延長 / 提早收倒數(學生喊「再兩分鐘」時按一下)。"""
        res = classroom.extend(req.seconds)
        if not res.get("ok"):
            raise HTTPException(400, res.get("error", "沒有進行中的練習"))
        return res

    @app.post("/api/classroom/stop", dependencies=[Depends(require_teacher)])
    def classroom_stop(req: ClassroomStopRequest):
        return classroom.stop(reset=req.reset)

    @app.get("/api/classroom/board", dependencies=[Depends(require_teacher)])
    def classroom_board(exercise: Optional[str] = None):
        return classroom.board(exercise)

    @app.get("/api/classroom/gradebook", dependencies=[Depends(require_teacher)])
    def classroom_gradebook():
        return {"gradebook": classroom.gradebook()}

    # ── 全班投票(沒有正解的取捨題;收票後平台真的照多數決去動引擎)──
    @app.get("/api/polls")
    def list_polls():
        return {"polls": polls.list_polls()}

    @app.get("/api/polls/active")
    def poll_active():
        """學生手機 / 投影幕輪詢:題面 + 即時票數。票數公開 —— 投票不是考試,
        看得到風向才有討論。"""
        return polls.view()

    @app.post("/api/polls/{poll_id}/open", dependencies=[Depends(require_teacher)])
    def poll_open(poll_id: str, req: PollOpenRequest = PollOpenRequest()):
        res = polls.open(poll_id, duration_s=req.duration_s, device=req.device)
        if not res.get("ok"):
            raise HTTPException(400, res.get("error", "開票失敗"))
        return res

    @app.post("/api/polls/vote")
    def poll_vote(req: PollVoteRequest, authorization: str = Header(None)):
        u = current_user(authorization)
        student = (u["username"] if u else None) or req.student
        res = polls.vote(req.poll, req.option, student)
        if not res.get("ok"):
            raise HTTPException(400, res.get("error", "投票失敗"))
        return res

    @app.post("/api/polls/close", dependencies=[Depends(require_teacher)])
    async def poll_close(req: PollCloseRequest = PollCloseRequest()):
        res = polls.close(execute=req.execute)
        if not res.get("ok"):
            raise HTTPException(400, res.get("error", "收票失敗"))
        await events_mgr.broadcast({          # 投票結果進事件列,世界頁 / 投影幕看得到
            "type": "class_vote", "poll": res["closed"]["poll"],
            "winner": res["closed"]["winner_label"], "device": res["closed"]["device"],
            "detail": (res["closed"]["result"] or {}).get("detail"),
            "sim_t": world.clock.now(),
        })
        return res

    @app.get("/api/polls/history")
    def poll_history():
        """歷次全班決定與後果 —— 下一節課回來對照 OEE 用。"""
        return {"history": list(reversed(polls.history))}

    @app.get("/api/scores")
    def get_scores():
        return scoring.scores()

    @app.get("/api/oee")
    def get_oee():
        return oee.report()

    # ── 階段二:預測上傳 / 預測榜(學生面公開)──────────────
    @app.post("/api/predictions")
    async def post_prediction(req: PredictionRequest):
        try:
            return await predictions.add(req.model_dump())
        except KeyError:
            raise HTTPException(404, f"無此設備:{req.device}")

    @app.get("/api/predictions")
    def list_predictions(student: Optional[str] = None):
        return {"predictions": predictions.list(student=student)}

    @app.get("/api/predictions/scores")
    def prediction_scores():
        return predictions.scores()

    def _company_owner(company_id: Optional[str]) -> Optional[str]:
        for c in world.park.get("companies", []):
            if c.get("id") == company_id:
                return c.get("owner")
        return None

    def _authorize_setpoint_write(device, authorization: Optional[str]) -> None:
        """學生只能改自己認領公司的設備(教師不限;dev 未啟用身分驗證時放行)。"""
        user = current_user(authorization)
        if user and user["role"] == "teacher":
            return
        if user and user["role"] == "student":
            if _company_owner(device.company_id) != user["username"]:
                raise HTTPException(403, "只能修改你認領公司的設備")
            return
        if auth_active():
            raise HTTPException(401, "請先登入")

    # 學生可寫設定點(受控範圍):唯一開放學生寫的控制面;後端夾限 + 認領授權。
    @app.post("/api/devices/{device_id}/setpoint")
    def write_setpoint(device_id: str, req: SetpointRequest, authorization: str = Header(None)):
        device = world.devices.get(device_id)
        if device is None:
            raise HTTPException(404, f"無此設備:{device_id}")
        _authorize_setpoint_write(device, authorization)
        result = device.set_setpoint(req.name, req.value)
        if not result.get("ok"):
            raise HTTPException(400, result.get("error", "設定點寫入失敗"))
        return result

    # CNC 刻字便捷端點:一次把整串文字寫進 engrave_char_1..8(等同逐格 FC06)。
    # 只是 setpoint 寫入的糖衣 —— 狀態仍只存在引擎的 setpoints,不另存文字。
    @app.post("/api/devices/{device_id}/engrave_text")
    def write_engrave_text(device_id: str, req: EngraveTextRequest, authorization: str = Header(None)):
        from engine.templates._stroke_font import GLYPHS, MAX_CHARS
        device = world.devices.get(device_id)
        if device is None:
            raise HTTPException(404, f"無此設備:{device_id}")
        _authorize_setpoint_write(device, authorization)
        if not any(s.name == "engrave_char_1" for s in device.setpoints):
            raise HTTPException(400, f"設備 {device_id} 不支援刻字(非 CNC)")
        text = req.text.upper()
        if len(text) > MAX_CHARS:
            raise HTTPException(400, f"文字最長 {MAX_CHARS} 字:{req.text!r}")
        bad = sorted({c for c in text if c not in GLYPHS})
        if bad:
            raise HTTPException(400, f"不支援的字元:{bad}(可用 A–Z、0–9、空白、-)")
        codes = [float(ord(c)) for c in text] + [0.0] * (MAX_CHARS - len(text))
        for i, code in enumerate(codes):
            device.set_setpoint(f"engrave_char_{i + 1}", code)
        return {"ok": True, "device": device.id, "text": text,
                "setpoints": {f"engrave_char_{i + 1}": codes[i] for i in range(MAX_CHARS)}}

    # 學生認領公司:綁登入身分;一人一廠;不能搶別人已認領的。
    def _save_owners():
        if state is not None:
            owners = {c["id"]: c["owner"] for c in world.park.get("companies", []) if c.get("owner")}
            state.save("owners", owners)

    @app.post("/api/companies/{company_id}/claim")
    def claim_company(company_id: str, req: ClaimRequest, authorization: str = Header(None)):
        user = current_user(authorization)
        target = next((c for c in world.park.get("companies", []) if c.get("id") == company_id), None)
        if target is None:
            raise HTTPException(404, f"無此公司:{company_id}")
        if user and user["role"] == "student":
            owner_name = user["username"]                 # 身分由 session 決定,忽略 body
            if target.get("owner") and target["owner"] != owner_name:
                raise HTTPException(409, "這間公司已被其他人認領")
            others = [c for c in world.park.get("companies", [])
                      if c.get("owner") == owner_name and c.get("id") != company_id]
            if others:
                raise HTTPException(409, f"你已認領「{others[0].get('name')}」(一人一廠);請先釋放再認領")
        elif user and user["role"] == "teacher":
            owner_name = req.student_id or None            # 教師可代為指派 / 清除
        elif auth_active():
            raise HTTPException(401, "請先登入")
        else:
            owner_name = req.student_id or None            # dev 開放
        target["owner"] = owner_name
        _save_owners()
        return {"company": company_id, "owner": target["owner"]}

    @app.post("/api/companies/{company_id}/release")
    def release_company(company_id: str, authorization: str = Header(None)):
        """釋放認領(學生只能釋放自己的;教師任意)。"""
        user = current_user(authorization)
        target = next((c for c in world.park.get("companies", []) if c.get("id") == company_id), None)
        if target is None:
            raise HTTPException(404, f"無此公司:{company_id}")
        if user and user["role"] == "student" and target.get("owner") != user["username"]:
            raise HTTPException(403, "只能釋放你自己認領的公司")
        if auth_active() and not user:
            raise HTTPException(401, "請先登入")
        target["owner"] = None
        _save_owners()
        return {"company": company_id, "owner": None}

    # ── 教師面(需 teacher token)──────────────────────────
    @app.get("/api/devices/{device_id}/health", dependencies=[Depends(require_teacher)])
    def get_health(device_id: str):
        device = world.devices.get(device_id)
        if device is None:
            raise HTTPException(404, f"無此設備:{device_id}")
        return device.ground_truth()

    @app.post("/api/faults", dependencies=[Depends(require_teacher)])
    def inject_fault(req: FaultRequest):
        device = world.devices.get(req.device)
        if device is None:
            raise HTTPException(404, f"無此設備:{req.device}")
        return device.inject_fault(
            req.fault_type, req.target, req.severity, req.onset_sim_s, **(req.params or {})
        )

    @app.post("/api/factory", dependencies=[Depends(require_teacher)])
    def create_factory(req: FactoryRequest):
        import yaml as _yaml
        from ai.factory_generator import generate_factory
        if req.yaml:
            company_cfg = _yaml.safe_load(req.yaml)
        elif req.description:
            try:
                company_cfg = generate_factory(req.description, list(world.devices))
            except ValueError as e:
                raise HTTPException(422, str(e))
        else:
            raise HTTPException(422, "需提供 description 或 yaml")
        result = world.add_company(company_cfg)
        result["via"] = company_cfg.get("_via")          # llm / rule(給前端顯示走哪條)
        result["summary"] = company_cfg.get("_summary")
        return result

    @app.post("/api/factory/compose", dependencies=[Depends(require_teacher)])
    async def compose_factory(req: ComposeRequest):
        """整合建廠一條龍:配置 → 自動接線 → 熱上線 → 點位表 → 試連自測(api/commissioning.py)。"""
        from ai.factory_generator import compose_company
        try:
            company_cfg = compose_company([d.model_dump() for d in req.devices], name=req.name)
        except ValueError as e:
            raise HTTPException(422, str(e))
        result = world.add_company(company_cfg)
        cid = result["company"]
        result["via"] = "compose"
        result["summary"] = company_cfg.get("_summary")
        result["line"] = company_cfg.get("line")
        result["points"] = points_doc(world, cid, host=public_host)
        result["points_download"] = {
            "json": f"/api/commissioning/{cid}",
            "csv": f"/api/commissioning/{cid}?format=csv",
            "markdown": f"/api/commissioning/{cid}?format=md",
        }
        if req.selftest:
            # 只測新公司那幾台(loopback 真連線)。adapter 是「下一拍 snapshot 廣播」才
            # 動態掛上,而廣播有節流(broadcast_interval_s,課堂場景 5s)—— 不猜固定延遲,
            # 輪詢到三協定全通或超過一個廣播週期為止,回傳最後一次量測(通不通誠實回報)。
            import asyncio as _asyncio
            import time as _time
            deadline = _time.monotonic() + max(3.0, float(getattr(world, "broadcast_interval_s", 0.0)) + 3.0)
            only = set(result["devices"])
            while True:
                st = await run_diagnostics(world, host="127.0.0.1", ports=world.ports, only=only)
                if all(p["summary"]["reachable"] == p["summary"]["total"]
                       for p in st["protocols"].values()) or _time.monotonic() > deadline:
                    break
                await _asyncio.sleep(1.0)
            result["selftest"] = st
        return result

    @app.get("/api/commissioning/{company_id}")
    def commissioning_points(company_id: str, format: str = "json"):
        """點位表下載(公開唯讀 —— 內容與 /api/catalog 同級,只含學生面資訊)。"""
        doc = points_doc(world, company_id, host=public_host)
        if doc is None:
            raise HTTPException(404, f"無此公司:{company_id}")
        if format == "csv":
            return Response(points_csv(doc), media_type="text/csv; charset=utf-8",
                            headers={"Content-Disposition": f'attachment; filename="{company_id}_points.csv"'})
        if format in ("md", "markdown"):
            return Response(points_markdown(doc), media_type="text/markdown; charset=utf-8",
                            headers={"Content-Disposition": f'attachment; filename="{company_id}_points.md"'})
        return doc

    @app.post("/api/commissioning/{company_id}/selftest", dependencies=[Depends(require_teacher)])
    async def commissioning_selftest(company_id: str):
        """對單一公司重跑三協定 loopback 試連(不掃全園區)。"""
        ids = {d.id for d in world.devices.values() if d.company_id == company_id}
        if not ids:
            raise HTTPException(404, f"無此公司或公司沒有設備:{company_id}")
        return await run_diagnostics(world, host="127.0.0.1", ports=world.ports, only=ids)

    # 情境腳本(災難日):列出公開,執行需 teacher token
    @app.get("/api/scenarios")
    def list_scenarios():
        return {"scripts": scenarios.list_scripts(), "status": scenarios.status()}

    @app.post("/api/scenarios/{name}/run", dependencies=[Depends(require_teacher)])
    async def run_scenario(name: str):
        try:
            return await scenarios.run(name)
        except FileNotFoundError:
            raise HTTPException(404, f"無此情境腳本:{name}")
        except RuntimeError as e:
            raise HTTPException(409, str(e))

    @app.post("/api/scenarios/stop", dependencies=[Depends(require_teacher)])
    def stop_scenario():
        scenarios.stop()
        return {"stopped": True}

    @app.post("/api/devices/{device_id}/reset", dependencies=[Depends(require_teacher)])
    def reset_device(device_id: str):
        device = world.devices.get(device_id)
        if device is None:
            raise HTTPException(404, f"無此設備:{device_id}")
        return device.reset()

    @app.post("/api/session/reset", dependencies=[Depends(require_teacher)])
    def reset_session(body: SessionResetRequest = SessionResetRequest()):
        """教師「重置課堂資料」:清認領 / 工單 / 預測 / OEE,並把設備修回健康 —— 換班 / 下堂課
        一鍵歸零,不必刪 state.db。各項可個別關閉。狀態真值仍只在引擎(不違反鐵則 #1)。"""
        cleared: dict = {}
        if body.claims:
            n = sum(1 for c in world.park.get("companies", []) if c.get("owner"))
            for c in world.park.get("companies", []):
                c["owner"] = None
            _save_owners()
            cleared["claims"] = n
        if body.tickets:
            cleared["tickets"] = tickets.clear()
        if body.predictions:
            cleared["predictions"] = predictions.clear()
        if body.oee:
            world.reset_oee()
            if state is not None:
                state.save("oee", world.oee_snapshot())
            cleared["oee_reset"] = len(world.devices)
        if body.maintenance:
            cleared["maintenance"] = maintenance.clear()
        if body.alarm_rules:
            cleared["alarm_rules"] = alarm_rules.clear()
        if body.polls:
            cleared["polls"] = polls.clear()
        if body.levels:
            cleared["levels"] = levels.clear()
            if access_log is not None:
                cleared["access_log"] = access_log.clear()
        if body.devices:
            for d in world.devices.values():
                d.reset()                       # 清故障 / 感測器故障 / 注入 → 全綠開場
                d.repair_log.clear()            # 處置紀錄一併歸零(當作這學期沒發生過)
            cleared["devices_reset"] = len(world.devices)
        return {"reset": True, "cleared": cleared, "synthetic": True}

    @app.post("/api/devices/{device_id}/coil", dependencies=[Depends(require_teacher)])
    async def write_coil(device_id: str, req: CoilRequest):
        """教師寫命令線圈(FC05 的認證版):run_enable 停機/復機、reset_fault 清故障。"""
        device = world.devices.get(device_id)
        if device is None:
            raise HTTPException(404, f"無此設備:{device_id}")
        result = device.set_coil(req.name, req.value)
        if not result.get("ok"):
            raise HTTPException(400, result.get("error", "線圈寫入失敗"))
        await events_mgr.broadcast({                       # 廣播命令事件,前端事件列可見
            "type": "command", "device": device_id, "coil": req.name,
            "value": bool(req.value), "sim_t": world.clock.now(),
        })
        return result

    @app.get("/api/sim/clock")
    def get_clock():
        return world.clock.snapshot()

    @app.post("/api/sim/clock", dependencies=[Depends(require_teacher)])
    def set_clock(patch: ClockPatch):
        if patch.multiplier is not None:
            world.clock.set_multiplier(patch.multiplier)
        if patch.paused is not None:
            world.clock.set_paused(patch.paused)
        return world.clock.snapshot()

    # ── WebSocket 即時面 ───────────────────────────────────
    register_ws_routes(app, telemetry_mgr, events_mgr)

    # ── 靜態前端(選用):設 WEB_DIST 指向 web/dist,則同源提供世界/目錄/儀表板 ──
    # 讓「一條 Cloudflare Tunnel → :8077」同時涵蓋網頁 + API + WS,校外學生瀏覽器直連(見 docs/部署_對外連線.md)。
    web_dist = config.get("web_dist") or ""
    if web_dist and os.path.isdir(web_dist):
        from fastapi.staticfiles import StaticFiles
        app.mount("/", StaticFiles(directory=web_dist, html=True), name="web")  # 最後掛載,/api 與 /ws 仍優先
        print(f"[api] 同源提供前端靜態檔:{web_dist}")

    return app
