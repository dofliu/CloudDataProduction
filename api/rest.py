"""FastAPI:REST 控制面(docs/04 §REST API)。

P0 提供:園區 / 目錄 / 設備即時值 / 歷史查詢 / 讀寫模擬時鐘。
引擎主迴圈、Modbus server、Historian flush 都掛在同一進程的 lifespan 裡
(docs/01:REST + 引擎同進程)。教師面 auth 在 P0 先寬鬆(P2 起強制)。
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from adapters.modbus_server import ModbusAdapter
from engine.course import CourseManager
from engine.world import World
from historian.writer import Historian
from .catalog import build_catalog
from .submissions import SubmissionStore
from .diagnostics import run_diagnostics
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


class FaultRequest(BaseModel):
    device: str
    fault_type: str                 # sudden/gradual/intermittent/cascading/sensor_*
    target: str                     # 退化元件名(設備故障)或 tag 名(感測器故障)
    severity: float = 1.0
    onset_sim_s: Optional[float] = None
    params: dict = {}


class ClaimRequest(BaseModel):
    student_id: str


class FactoryRequest(BaseModel):
    description: Optional[str] = None    # 自然語言建廠
    yaml: Optional[str] = None           # 或直接給公司設定 YAML


class PredictionRequest(BaseModel):
    device: str
    student: str = "anon"
    predicted_fault: str = "fault"
    eta_sim_s: Optional[float] = None
    confidence: float = 1.0


class SessionResetRequest(BaseModel):
    """教師「重置課堂資料」的可選範圍(預設全清)。"""
    claims: bool = True         # 公司認領
    tickets: bool = True        # 工單
    predictions: bool = True    # 階段二預測
    oee: bool = True            # OEE 累積器
    devices: bool = True        # 把所有設備修回健康(清故障 / 注入)


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
) -> FastAPI:
    public_host = config.get("public_host", "127.0.0.1")
    teacher_token = config.get("teacher_token", "")

    def require_teacher(authorization: str = Header(None)):
        """教師面 auth:需 Authorization: Bearer <teacher_token>。未設 token 則開放(dev)。"""
        if not teacher_token:
            return
        if authorization != f"Bearer {teacher_token}":
            raise HTTPException(401, "教師面端點需要有效的 teacher token")

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

    # 課程情境(教師手動套用每週條件)+ 作業自動比對(對 ground-truth 計分)
    course = CourseManager(world, path=config.get("course_file", "scenarios/course_weeks.yaml"))
    submissions = SubmissionStore(world, historian, course, persist=state)

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
        world.subscribe(telemetry_mgr.on_message)        # telemetry → 瀏覽器
        world.subscribe_events(events_mgr.on_message)     # 事件 → 瀏覽器
        world.subscribe_events(tickets.on_event)          # 故障事件 → 自動開工單
        world.subscribe_events(predictions.on_event)      # 故障事件 → 比對預測命中
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

    @app.get("/api/history")
    async def get_history(
        device: str = Query(..., description="設備 id"),
        tag: str = Query(..., description="tag 名稱,如 vibration_rms"),
        from_: Optional[float] = Query(None, alias="from", description="起始 wall epoch 秒"),
        to: Optional[float] = Query(None, description="結束 wall epoch 秒"),
        limit: int = Query(5000, ge=1, le=50000),
    ):
        if device not in world.devices:
            raise HTTPException(404, f"無此設備:{device}")
        rows = await historian.query(device, tag, from_, to, limit)
        return {
            "device": device,
            "tag": tag,
            "count": len(rows),
            "degraded": historian.degraded,  # True 表示來自 in-memory fallback
            "points": rows,
        }

    # ── 工單 / 評分(學生面公開)──────────────────────────
    @app.get("/api/tickets")
    def list_tickets(owner: Optional[str] = None, status: Optional[str] = None):
        return {"tickets": tickets.list(owner=owner, status=status)}

    @app.post("/api/tickets/{ticket_id}/ack")
    def ack_ticket(ticket_id: str):
        t = tickets.ack(ticket_id)
        if t is None:
            raise HTTPException(404, f"無此工單:{ticket_id}")
        return t

    @app.post("/api/tickets/{ticket_id}/resolve")
    def resolve_ticket(ticket_id: str):
        t = tickets.resolve(ticket_id)
        if t is None:
            raise HTTPException(404, f"無此工單:{ticket_id}")
        return t

    # ── MES 工單(學生面公開唯讀;Phase 1)──────────────────
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

    # 學生可寫設定點(公開,受控範圍):唯一開放學生寫的控制面;後端夾限保護。
    @app.post("/api/devices/{device_id}/setpoint")
    def write_setpoint(device_id: str, req: SetpointRequest):
        device = world.devices.get(device_id)
        if device is None:
            raise HTTPException(404, f"無此設備:{device_id}")
        result = device.set_setpoint(req.name, req.value)
        if not result.get("ok"):
            raise HTTPException(400, result.get("error", "設定點寫入失敗"))
        return result

    # 學生認領公司(公開)
    def _save_owners():
        if state is not None:
            owners = {c["id"]: c["owner"] for c in world.park.get("companies", []) if c.get("owner")}
            state.save("owners", owners)

    @app.post("/api/companies/{company_id}/claim")
    def claim_company(company_id: str, req: ClaimRequest):
        for c in world.park.get("companies", []):
            if c.get("id") == company_id:
                c["owner"] = req.student_id or None
                _save_owners()                       # 認領寫穿,進程重啟不歸零
                return {"company": company_id, "owner": c["owner"]}
        raise HTTPException(404, f"無此公司:{company_id}")

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
        if body.devices:
            for d in world.devices.values():
                d.reset()                       # 清故障 / 感測器故障 / 注入 → 全綠開場
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
