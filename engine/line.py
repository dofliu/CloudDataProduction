"""產線物料流(工件在設備之間真實傳遞)。

先前跨設備只有前端的「空間對位」:手臂與上下游機台的節拍各自獨立,畫面看起來像一條線,
引擎裡卻沒有工件在流(docs/animation_binding.md §4.12 的誠實邊界)。本模組把那條邊界
往引擎推:場景 YAML 在公司層宣告 `line:`(站序,由上游到下游),引擎維護站間緩衝與閘門:

    line: [cnc-a, arm-1, cnc-b, conveyor-1]

  - **producer**(CNC / 射出 / 沖壓 / 腔體):完成一件 → 出料緩衝 +1;
    出料緩衝滿(下游搬不走)→ 停機等待(不轉不磨,不罰可用率)。
    非首站的 producer 入料緩衝為 0 時 → 無料待機(同上)。首站視為原料無限。
  - **handler**(六軸手臂):事件驅動 —— 上游出料緩衝有件且下游入料緩衝有位時,
    授予一次搬運;手臂跑完一個取放循環(cycle_count +1)工件才落到下游。
    無料時手臂在取件點上方待命(引擎與畫面都停)。
  - **conveyor**(只能當末站):出貨端,吸收成品(shipped 累計)。

完工偵測不另設事件通道,直接看各 template 的**累積量 tag**(part_count / shot_count /
stroke_count / wafer_count / cycle_count)的整數進位 —— 學生從 Modbus 讀到的數字,
就是產線帳本用的數字(鐵則二:同一份資料,不做兩套)。

狀態(緩衝 / 在手 / 出貨)只存在引擎(鐵則一);對外有三個視圖:
  1. 設備目錄 / Modbus FC04:`line_in_buffer` / `line_out_buffer` 輸入暫存器。
  2. world snapshot 的 `lines`(前端產線視圖畫緩衝)。
  3. `GET /api/lines`(由 rest.py 讀 snapshot)。

計帳原則:無料待機與滿料阻塞都算 **no-demand**(不罰 OEE 可用率)—— 餓料不是設備的錯;
它降的是產出,學生會在產量與稼動看見(見 device._accumulate_oee 的 scheduled 邏輯)。
"""
from __future__ import annotations

import math

from typing import Dict, List, Optional

from .device import Device, InputRegPoint

# 各 producer template 的「完成一件」累積量 tag
COUNT_TAGS: Dict[str, str] = {
    "cnc_machining_center": "part_count",
    "injection_molding": "shot_count",
    "stamping_press": "stroke_count",
    "semi_process_chamber": "wafer_count",
    "welding_cell": "weld_count",
    "laser_cutter": "cut_count",
    "aoi_inspection": "inspected_count",
    "packaging_machine": "package_count",
}
HANDLER_TEMPLATES = {"robot_arm_6axis"}
TERMINAL_TEMPLATES = {"conveyor"}

OUT_CAP = 3     # 出料緩衝容量:滿了上游停機(等搬運)
IN_CAP = 3      # 入料緩衝容量:滿了手臂不再搬(等下游消化)
ARM_CYCLE_S = 8.0   # 手臂一次取放循環的 sim 秒(= robot_arm_6axis.CYCLE_PERIOD)。
                    # 一拍的搬運配額 = max(1, dt_sim / ARM_CYCLE_S) —— 大 dt(高倍速場景)
                    # 下手臂一拍能搬多件,才不會被 tick 粒度人為地變成產線瓶頸。
BELT_TRANSIT_S = 8.0   # 工件走完輸送帶的 sim 秒(帶長 8 m ÷ 額定 1 m/s)
BELT_CAP = 8           # 帶上最多同時幾件(滿了手臂等)

# 各 producer 的額定單件節拍(sim 秒)—— 只在該站的節拍 tag 讀不到有效值時(如待機中
# stroke_rate / throughput 歸零)當保底;運轉中一律以學生讀得到的 tag 現值換算。
# 數字對應各 template 的常數(cnc 45s / injection CYCLE_S=30 / press 60spm / chamber 25wph)。
NOMINAL_CYCLE_S: Dict[str, float] = {
    "cnc_machining_center": 45.0,
    "injection_molding": 30.0,
    "stamping_press": 1.0,
    "semi_process_chamber": 144.0,
    "welding_cell": 16.0,
    "laser_cutter": 24.0,
    "aoi_inspection": 15.0,
    "packaging_machine": 15.0,
}


class _Station:
    def __init__(self, device: Device, role: str):
        self.device = device
        self.role = role                    # source / mid / sink / handler / terminal
        self.in_buf = 0                     # 入料緩衝(producer 非首站)
        self.out_buf = 0                    # 出料緩衝(producer 非末站)
        self.on_belt: List[float] = []      # terminal 輸送帶:帶上各工件的剩餘輸送秒數
        self.prev_count: Optional[int] = None   # 累積量 tag 上次讀值(None=尚未初始化)
        self.need_items = 1                 # 本拍要完成幾件(= ceil(dt/節拍);gate() 更新)
        self.count_tag = None               # 累積量 tag 物件(快取)
        tag_name = COUNT_TAGS.get(device.template) or (
            "cycle_count" if device.template in HANDLER_TEMPLATES else None)
        if tag_name is not None:
            self.count_tag = next((t for t in device.tags if t.name == tag_name), None)

    def count(self) -> int:
        return int(self.count_tag.value) if self.count_tag is not None else 0


class ProductionLine:
    """一條產線:producer 與 handler 交錯的站序。handler 前後必是 producer(末站可為 conveyor)。"""

    def __init__(self, company_id: str, stations: List[_Station]):
        self.company_id = company_id
        self.stations = stations
        self.shipped = 0                    # 末站(conveyor 出貨 / 尾 producer 完成)累計
        # handler → (上游站, 下游站) 映射;in_hand = 已從上游取走、尚未放到下游的件數
        self.links: List[dict] = []
        for i, st in enumerate(stations):
            if st.role == "handler":
                self.links.append({"handler": st, "up": stations[i - 1], "down": stations[i + 1],
                                   "in_hand": 0, "prev_cycles": None, "moved": 0})

    # ── 每 tick,設備 step 之前:設閘門 ──────────────────────
    def gate(self, dt_sim: float = 0.0) -> None:
        for i, st in enumerate(self.stations):
            d = st.device
            if st.role in ("mid", "sink"):
                # 本拍會完成 ceil(dt/節拍) 件 —— 料要夠這一拍吃,不然一拍內就會把
                # 「完成量 > 入料量」做進累積量 tag(工件憑空出現)。dt ≤ 節拍時 need=1,
                # 與先前「有料就開」完全等價。
                cyc = self._cycle_s(st) or NOMINAL_CYCLE_S.get(d.template, 45.0)
                st.need_items = max(1, math.ceil(dt_sim / max(1e-6, cyc) - 1e-9)) if dt_sim > 0 else 1
                d.line_has_input = st.in_buf >= st.need_items
            if st.role in ("source", "mid"):
                d.line_output_blocked = st.out_buf >= OUT_CAP
            if st.role == "handler":
                # 手臂:被授予搬運才動。line_carry = 在手件數(配額由 advance() 授予/收回)
                d.line_carry = sum(lk["in_hand"] for lk in self.links if lk["handler"] is st)
            if st.role == "terminal":
                # 輸送帶:帶上有工件才轉,空帶待機(不空轉 —— 誠實反映在 belt_speed / state)
                d.line_has_input = len(st.on_belt) > 0

    # ── 每 tick,設備 step 之後:記帳 + 授予搬運 ─────────────
    def advance(self, dt_sim: float) -> None:
        # 0. terminal 輸送帶:帶真的有在轉(running)工件才前進;走完帶長 → 出貨
        for st in self.stations:
            if st.role != "terminal" or not st.on_belt:
                continue
            if not bool(getattr(st.device, "_last_op", {}).get("running")):
                continue                                   # 教師鎖停 / 故障:工件停在帶上
            remaining: List[float] = []
            for t in st.on_belt:
                t -= dt_sim
                if t <= 0.0:
                    self.shipped += 1
                else:
                    remaining.append(t)
            st.on_belt = remaining

        # 1. producer 完工進出料緩衝;非首站同時消耗入料
        for i, st in enumerate(self.stations):
            if st.role not in ("source", "mid", "sink"):
                continue
            cur = st.count()
            if st.prev_count is None:
                st.prev_count = cur
                continue
            delta = cur - st.prev_count
            st.prev_count = cur
            if delta <= 0:
                continue
            if st.role in ("mid", "sink"):                 # 消耗入料(有幾件算幾件)
                st.in_buf = max(0, st.in_buf - delta)
            if st.role in ("source", "mid"):
                st.out_buf += delta                        # 完工 → 出料緩衝(閘門下一拍生效)
            else:                                          # 尾站 producer:完成即出貨
                self.shipped += delta

        # 2. handler:完成的循環數 = 落到下游的件數;再依配額授予下一批搬運
        cap = max(1, int(dt_sim / ARM_CYCLE_S))            # 一拍最多搬幾件(見 ARM_CYCLE_S)
        for lk in self.links:
            h: _Station = lk["handler"]
            cycles = h.count()
            if lk["prev_cycles"] is None:
                lk["prev_cycles"] = cycles
            done = cycles - lk["prev_cycles"]
            lk["prev_cycles"] = cycles
            down: _Station = lk["down"]
            if done > 0 and lk["in_hand"] > 0:             # 每完成一個取放循環,一件抵達下游
                delivered = min(done, lk["in_hand"])
                lk["in_hand"] -= delivered
                lk["moved"] += delivered
                if down.role == "terminal":                # 放上輸送帶,走完帶長才算出貨
                    down.on_belt.extend([BELT_TRANSIT_S] * delivered)
                else:
                    down.in_buf += delivered
            up: _Station = lk["up"]
            while (lk["in_hand"] < cap and up.out_buf > 0
                   and (len(down.on_belt) + lk["in_hand"] < BELT_CAP if down.role == "terminal"
                        else down.in_buf + lk["in_hand"] < max(IN_CAP, down.need_items))):
                up.out_buf -= 1                            # 工件上手(從上游出料取走)
                lk["in_hand"] += 1

    # ── 產線層 KPI:純粹從帳上與學生讀得到的 tag 自算,不另存任何狀態 ──────
    def _cycle_s(self, st: _Station) -> Optional[float]:
        """該 producer 站目前的單件節拍(sim 秒)。由節拍類 tag 現值換算 ——
        學生自己讀 Modbus 也能算出同一個數字;讀不到有效值(待機)退回額定值。"""
        d = st.device
        val = {t.name: float(t.value) for t in d.tags}
        if d.template in ("cnc_machining_center", "injection_molding", "packaging_machine"):
            v = val.get("cycle_time", 0.0)
            return v if v > 0.5 else NOMINAL_CYCLE_S[d.template]
        if d.template == "aoi_inspection":
            v = val.get("inspect_time", 0.0)
            return v if v > 0.5 else NOMINAL_CYCLE_S[d.template]
        if d.template == "stamping_press":
            r = val.get("stroke_rate", 0.0)
            return 60.0 / r if r > 1.0 else NOMINAL_CYCLE_S[d.template]
        if d.template == "semi_process_chamber":
            w = val.get("throughput", 0.0)
            return 3600.0 / w if w > 1.0 else NOMINAL_CYCLE_S[d.template]
        return NOMINAL_CYCLE_S.get(d.template)   # 焊接 / 雷切:額定節拍(引擎常數,無節拍 tag)

    def kpi(self, sim_t: float) -> dict:
        """線層 KPI(教瓶頸分析與 Little's Law 用):
          wip                    帳上在製品 = 緩衝 + 在手 + 帶上(與 stations 各欄加總一致)
          bottleneck             節拍最長的 producer 站(理論瓶頸)
          line_balance           線平衡率 = Σ節拍 / (站數 × 瓶頸節拍),1.0 = 完全平衡
          utilization            各 producer 利用率 ≈ 完成件數 × 節拍 / 經過 sim 時間
                                 (對「日曆時間」算 —— 班外 / 餓料 / 阻塞都會誠實拉低它)
          bottleneck_utilization 瓶頸站的利用率(< 1 的缺口 = 排程外 + 餓料/阻塞損失)
          throughput_per_h       產線出貨速率(shipped / sim 時間)
        """
        wip = (sum(st.in_buf + st.out_buf for st in self.stations)
               + sum(lk["in_hand"] for lk in self.links)
               + sum(len(st.on_belt) for st in self.stations))
        out: dict = {"wip": wip}
        cycles = {st.device.id: c for st in self.stations
                  if st.role in ("source", "mid", "sink") and (c := self._cycle_s(st))}
        if cycles and sim_t > 0.0:
            bneck = max(cycles, key=lambda k: cycles[k])
            cmax = cycles[bneck]
            util = {st.device.id: round(min(1.0, st.count() * cycles[st.device.id] / sim_t), 3)
                    for st in self.stations if st.device.id in cycles}
            out.update({
                "bottleneck": bneck,
                "line_balance": round(sum(cycles.values()) / (len(cycles) * cmax), 3),
                "utilization": util,
                "bottleneck_utilization": util.get(bneck),
                "throughput_per_h": round(self.shipped / sim_t * 3600.0, 2),
            })
        return out

    def view(self, sim_t: float = 0.0) -> dict:
        return {
            "company": self.company_id,
            "kpi": self.kpi(sim_t),
            "stations": [
                {
                    "device": st.device.id,
                    "template": st.device.template,
                    "role": st.role,
                    "in_buffer": st.in_buf if st.role in ("mid", "sink") else None,
                    "out_buffer": st.out_buf if st.role in ("source", "mid") else None,
                    "carrying": (sum(lk["in_hand"] for lk in self.links if lk["handler"] is st)
                                 if st.role == "handler" else None),
                    "moved": (sum(lk["moved"] for lk in self.links if lk["handler"] is st)
                              if st.role == "handler" else None),
                    "on_belt": len(st.on_belt) if st.role == "terminal" else None,
                }
                for st in self.stations
            ],
            "shipped": self.shipped,
        }


class LineManager:
    """園區級:解析各公司的 line: 宣告、每 tick 推進所有產線。"""

    def __init__(self, world):
        self.world = world
        self.lines: List[ProductionLine] = []
        for company in world.park.get("companies", []) or []:
            self.register_company(company)

    def register_company(self, company_cfg: dict) -> None:
        """解析一間公司的 line:(建構期與熱載入建廠共用)。宣告不合法就整條略過並警告,
        不讓一條壞產線擋掉整個世界。"""
        ids = company_cfg.get("line") or []
        if not ids:
            return
        cid = company_cfg.get("id")
        stations: List[_Station] = []
        ok = True
        for i, did in enumerate(ids):
            device = self.world.devices.get(did)
            if device is None:
                print(f"[line] {cid}:找不到設備 {did},略過整條產線")
                ok = False
                break
            tmpl = device.template
            last = i == len(ids) - 1
            if tmpl in HANDLER_TEMPLATES:
                role = "handler"
            elif tmpl in TERMINAL_TEMPLATES:
                role = "terminal"
                if not last:
                    print(f"[line] {cid}:{did}(conveyor)只能當末站,略過整條產線")
                    ok = False
                    break
            elif tmpl in COUNT_TAGS:
                role = "sink" if last else ("source" if i == 0 else "mid")
            else:
                print(f"[line] {cid}:{did}({tmpl})不能當產線站,略過整條產線")
                ok = False
                break
            stations.append(_Station(device, role))
        if not ok or len(stations) < 2:
            return
        # handler 前後必須是 producer(terminal 只能接在 handler 之後)
        for i, st in enumerate(stations):
            if st.role == "handler":
                if i == 0 or i == len(stations) - 1:
                    print(f"[line] {cid}:手臂 {st.device.id} 不能當首/末站,略過整條產線")
                    return
                if stations[i - 1].role not in ("source", "mid"):
                    print(f"[line] {cid}:手臂 {st.device.id} 上游必須是 producer,略過整條產線")
                    return
        line = ProductionLine(cid, stations)
        self.lines.append(line)
        # 標記設備 + 掛可觀測 FC04 點位
        for st in stations:
            d = st.device
            d.line_enabled = True
            d.line_role = st.role
            self._attach_points(d, st)

    def _attach_points(self, device: Device, st: _Station) -> None:
        """把入/出料緩衝掛成輸入暫存器(FC04),學生從 Modbus 讀得到物料流。"""
        folder = (device.protocols.get("opcua", {}) or {}).get(
            "node_folder", f"{device.company_id}/{device.id}")
        addr = max((p.ir_address + p.register_width for p in device.input_registers), default=0)
        points = []
        if st.role in ("mid", "sink"):
            points.append(("line_in_buffer", lambda d, s=st: int(s.in_buf)))
        if st.role in ("source", "mid"):
            points.append(("line_out_buffer", lambda d, s=st: int(s.out_buf)))
        if st.role == "terminal":
            points.append(("line_on_belt", lambda d, s=st: len(s.on_belt)))
        for name, fn in points:
            device.input_registers.append(InputRegPoint(
                name=name, unit="count", datatype="int16", ir_address=addr,
                opcua_node=f"{folder}/ir_{name}", mqtt_field=f"ir_{name}", fn=fn, scale=1.0))
            addr += 1

    def gate(self, dt_sim: float = 0.0) -> None:
        for line in self.lines:
            line.gate(dt_sim)

    def advance(self, dt_sim: float) -> None:
        for line in self.lines:
            line.advance(dt_sim)

    def view(self) -> List[dict]:
        sim_t = float(self.world.clock.now())
        return [line.view(sim_t) for line in self.lines]
