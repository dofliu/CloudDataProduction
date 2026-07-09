"""MES(製造執行系統)最小核心 —— 工單驅動設備運轉(Phase 1)。

導入 MES 概念:每間公司有各自的訂單與生產排程。設備不再一啟動就永遠運轉,
而是「有工單才開工」。班表(engine/device.py 的 DutyProfile)當外層閘門,決定工廠
這時段開不開工;MES **疊在其上**,在開工時段內決定要不要跑(手上有沒有單)。

為什麼這對本平台重要(呼應設備老化問題):退化只在運轉時累積(engine/health.py),
所以工單一停、設備待機就不再磨損 —— 老化被生產節奏自然拉開,晚認領的學生不會
一進來就撞到全部故障的設備。故障 = 停線;resolve 工單後(device.reset)回線繼續
下一張單,世界常保有活的設備與連續可分析的歷史。

Phase 1 範圍:一張單綁一台設備、產生器維持 backlog、生產進度累積、完工換下一張、
`GET /api/orders`。**不含**製程路由(一單多站)、教師建單、交期 KPI(留待 Phase 2/3)。
鐵則:狀態只存在引擎 —— 所有工單狀態都在這裡,API / 前端只讀視圖,不自存。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np

# 會接工單的離散/批次製造設備。公用/連續/物流設備(空壓、電表、AGV、風機)不納入 MES,
# 維持既有 duty 行為(它們沒有「一張一張的生產工單」這種概念)。
PRODUCER_TEMPLATES = {
    "cnc_machining_center",
    "injection_molding",
    "robot_arm_6axis",
    "stamping_press",
    "heat_treat_furnace",
    "semi_process_chamber",
}

# 標準單件工時(模擬秒 / 件)。只用來把「訂單數量」換算成生產耗時,讓 /api/orders 的
# 數量有意義;實際節拍細節仍由各 template 的訊號模型決定。批次爐 / 腔體以「批」計較長。
STD_CYCLE_S: Dict[str, float] = {
    "cnc_machining_center": 90.0,
    "injection_molding": 25.0,
    "robot_arm_6axis": 40.0,
    "stamping_press": 12.0,
    "heat_treat_furnace": 600.0,
    "semi_process_chamber": 300.0,
}
DEFAULT_CYCLE_S = 90.0

# 每台設備至少維持這麼多張「未完成」工單(backlog),世界永遠有活可做。
MIN_BACKLOG = 2


@dataclass
class WorkOrder:
    id: str
    company_id: str
    device_id: str
    product: str
    qty: int
    cycle_s: float
    qty_done: float = 0.0           # 累積(浮點以便積分),對外顯示取 int
    status: str = "queued"          # queued → running → done
    released_t: float = 0.0         # 下單(釋出)模擬時刻
    due_t: float = 0.0              # 交期(模擬時刻;Phase 1 僅顯示,尚未評分)
    started_t: Optional[float] = None
    done_t: Optional[float] = None

    @property
    def progress(self) -> float:
        return 0.0 if self.qty <= 0 else min(1.0, self.qty_done / self.qty)

    def view(self) -> dict:
        return {
            "id": self.id,
            "company_id": self.company_id,
            "device_id": self.device_id,
            "product": self.product,
            "qty": self.qty,
            "qty_done": int(self.qty_done),
            "progress": round(self.progress, 3),
            "status": self.status,
            "released_sim_t": round(self.released_t, 1),
            "due_sim_t": round(self.due_t, 1),
            "started_sim_t": None if self.started_t is None else round(self.started_t, 1),
            "done_sim_t": None if self.done_t is None else round(self.done_t, 1),
        }

    def brief(self) -> dict:
        """給設備 snapshot 用的精簡視圖(學生面在世界 / 看板顯示當前在做哪張單)。"""
        return {
            "id": self.id, "product": self.product, "qty": self.qty,
            "qty_done": int(self.qty_done), "progress": round(self.progress, 3),
            "status": self.status,
        }


def _parse_products(company: dict) -> List[str]:
    """從公司的 product 欄位拆出產品名清單(中英頓號 / 逗號 / 斜線分隔)。"""
    raw = (company.get("product") or "").strip()
    if not raw:
        return []
    out: List[str] = []
    token = ""
    for ch in raw:
        if ch in "、,，/／;;":
            if token.strip():
                out.append(token.strip())
            token = ""
        else:
            token += ch
    if token.strip():
        out.append(token.strip())
    return out


class MES:
    """園區級 MES:持有各設備的工單佇列,每 tick 指派 / 推進生產。

    生命週期(由 World.step 呼叫):
      1. assign(sim_t)          —— 設備 step 前:定出每台當前工單、設 device.has_work。
      2.（World 推進所有設備)
      3. advance(dt_sim, sim_t) —— 設備 step 後:依實際是否運轉累積產量、完工換單、補 backlog。
    """

    def __init__(self, world, cfg: Optional[dict] = None):
        cfg = cfg or {}
        self.world = world
        self.enabled: bool = bool(cfg.get("enabled", True))
        seed = (int(getattr(world, "master_seed", 0)) ^ 0x4D4553) & 0x7FFFFFFF
        self._rng = np.random.default_rng(seed)

        self.queues: Dict[str, List[WorkOrder]] = {}   # device_id → 未完成單(FIFO,[0] 為當前)
        self.done: Dict[str, List[WorkOrder]] = {}     # device_id → 已完工(保留近 8 張供看板)
        self._managed: Dict[str, str] = {}             # device_id → company_id(僅 producer)
        self._products: Dict[str, List[str]] = {}      # company_id → 產品名清單
        self._seq: Dict[str, int] = {}                 # company_id → 工單流水號
        # 稼動率(order_density):1.0=班內滿載;<1 則工單間插入待機空檔(不轉不磨),
        # 讓「訂單密度」真的改變資料(待機比例↑、產出↓、退化↓)。空檔屬 no-demand,
        # 對排程算的可用率不罰(它降的是負荷/產出,不是可用率;見 device._accumulate_oee)。
        # 預設 1.0 → 零回歸。
        self.utilization: float = 1.0
        self._idle_until: Dict[str, float] = {}        # device_id → 空檔結束的 sim_t

        if self.enabled:
            self._build()

    # ── 建構:標記受管設備、鋪初始 backlog ──────────────────
    def _build(self) -> None:
        for company in self.world.park.get("companies", []) or []:
            cid = company.get("id")
            products = _parse_products(company)
            for dev_cfg in company.get("devices", []) or []:
                did = dev_cfg.get("id")
                device = self.world.devices.get(did)
                if device is None or device.template not in PRODUCER_TEMPLATES:
                    continue
                device.mes_enabled = True
                self._managed[did] = cid
                self._products.setdefault(cid, products)
                self._seq.setdefault(cid, 0)
                self.queues[did] = []
                self.done[did] = []
                self._seed_backlog(did)

    def register_company(self, company_cfg: dict) -> None:
        """熱載入(NL/LLM 建廠)新增公司後,把其中的 producer 設備納入 MES 並鋪初始工單。"""
        if not self.enabled:
            return
        cid = company_cfg.get("id")
        products = _parse_products(company_cfg)
        sim_t = float(self.world.clock.now())
        for dev_cfg in company_cfg.get("devices", []) or []:
            did = dev_cfg.get("id")
            device = self.world.devices.get(did)
            if device is None or device.template not in PRODUCER_TEMPLATES or did in self._managed:
                continue
            device.mes_enabled = True
            self._managed[did] = cid
            self._products.setdefault(cid, products)
            self._seq.setdefault(cid, 0)
            self.queues[did] = []
            self.done[did] = []
            self._refill(did, sim_t)

    def _seed_backlog(self, did: str) -> None:
        """鋪初始工單:讓第一張單帶隨機初始進度,使各設備在 t=0 就處於「生產中且錯開」,
        避免全部同時完工 / 同時開始退化。"""
        self._refill(did, sim_t=0.0)
        head = self.queues[did][0]
        head.qty_done = float(self._rng.integers(0, max(1, int(head.qty * 0.6) + 1)))
        head.status = "running"
        head.started_t = 0.0

    # ── 產生工單 ────────────────────────────────────────────
    def _gen_order(self, did: str, sim_t: float) -> WorkOrder:
        cid = self._managed[did]
        device = self.world.devices[did]
        self._seq[cid] += 1
        prods = self._products.get(cid) or [device.template]
        product = str(prods[int(self._rng.integers(len(prods)))]) if prods else device.template
        cycle = STD_CYCLE_S.get(device.template, DEFAULT_CYCLE_S)
        dur_h = 1.0 + 2.0 * float(self._rng.random())          # 目標耗時 1~3 模擬小時
        qty = max(1, int(round(dur_h * 3600.0 / cycle)))
        slack = 1.3 + 0.6 * float(self._rng.random())          # 交期給 1.3~1.9x 生產工時的餘裕
        due = sim_t + dur_h * 3600.0 * slack
        return WorkOrder(
            id=f"WO-{cid.upper()}-{self._seq[cid]:04d}",
            company_id=cid, device_id=did, product=product,
            qty=qty, cycle_s=cycle, released_t=sim_t, due_t=due,
        )

    def _refill(self, did: str, sim_t: float) -> None:
        q = self.queues[did]
        while len(q) < MIN_BACKLOG:
            q.append(self._gen_order(did, sim_t))

    # ── 每 tick:指派 ────────────────────────────────────────
    def assign(self, sim_t: float) -> None:
        if not self.enabled:
            return
        for did in self._managed:
            device = self.world.devices.get(did)
            if device is None:
                continue
            q = self.queues.get(did) or []
            active = q[0] if q else None
            in_gap = self.utilization < 1.0 and sim_t < self._idle_until.get(did, 0.0)
            device.has_work = (active is not None) and not in_gap   # 有單且不在空檔才允許開工
            device.mes_order = active.brief() if active is not None else None

    # ── 每 tick:推進生產 ────────────────────────────────────
    def advance(self, dt_sim: float, sim_t: float) -> None:
        if not self.enabled or dt_sim <= 0.0:
            return
        for did in self._managed:
            device = self.world.devices.get(did)
            if device is None:
                continue
            # 只有「實際在運轉且非故障」才算產出(故障停線、待機不產)
            ran = bool(getattr(device, "_last_op", {}).get("running")) and device.state != "fault"
            q = self.queues.get(did) or []
            if q and ran:
                head = q[0]
                if head.status == "queued":            # 首次實際生產才轉 running(非上班/待機時維持 queued)
                    head.status = "running"
                    head.started_t = sim_t
                head.qty_done += dt_sim / head.cycle_s
                if head.qty_done >= head.qty:
                    head.qty_done = float(head.qty)
                    head.status = "done"
                    head.done_t = sim_t
                    q.pop(0)
                    self.done[did].append(head)
                    self.done[did] = self.done[did][-8:]
                    if self.utilization < 1.0:      # 完工後插入待機空檔,讓長期稼動率≈utilization
                        runtime = head.qty * head.cycle_s
                        gap = runtime * (1.0 - self.utilization) / max(self.utilization, 0.05)
                        gap *= 0.6 + 0.8 * float(self._rng.random())   # 抖動,避免同步
                        self._idle_until[did] = sim_t + gap
            self._refill(did, sim_t)
            # 更新設備上的當前工單視圖(供 telemetry snapshot / 前端看板)
            device.mes_order = q[0].brief() if q else None

    def set_utilization(self, value: float) -> None:
        """設定稼動率(教師課程情境用)。1.0=滿載,越低待機空檔越多。"""
        self.utilization = float(min(1.0, max(0.05, value)))

    # ── 視圖(API 只讀)──────────────────────────────────────
    def list_orders(self, company: Optional[str] = None, device: Optional[str] = None,
                    status: Optional[str] = None, include_done: bool = True) -> List[dict]:
        rows: List[WorkOrder] = []
        for did, q in self.queues.items():
            rows.extend(q)
        if include_done:
            for did, dl in self.done.items():
                rows.extend(dl)
        out = []
        for o in rows:
            if company and o.company_id != company:
                continue
            if device and o.device_id != device:
                continue
            if status and o.status != status:
                continue
            out.append(o.view())
        # 排序:未完成優先(running→queued→done),再依交期
        rank = {"running": 0, "queued": 1, "done": 2}
        out.sort(key=lambda r: (rank.get(r["status"], 3), r["due_sim_t"]))
        return out

    def summary(self, company: Optional[str] = None) -> dict:
        orders = self.list_orders(company=company)
        by_status: Dict[str, int] = {}
        for o in orders:
            by_status[o["status"]] = by_status.get(o["status"], 0) + 1
        return {
            "enabled": self.enabled,
            "company": company,
            "managed_devices": sum(1 for d, c in self._managed.items()
                                   if company is None or c == company),
            "orders": by_status,
        }
