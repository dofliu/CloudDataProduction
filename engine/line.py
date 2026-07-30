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

from typing import Dict, List, Optional

from .device import Device, InputRegPoint

# 各 producer template 的「完成一件」累積量 tag
COUNT_TAGS: Dict[str, str] = {
    "cnc_machining_center": "part_count",
    "injection_molding": "shot_count",
    "stamping_press": "stroke_count",
    "semi_process_chamber": "wafer_count",
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


class _Station:
    def __init__(self, device: Device, role: str):
        self.device = device
        self.role = role                    # source / mid / sink / handler / terminal
        self.in_buf = 0                     # 入料緩衝(producer 非首站)
        self.out_buf = 0                    # 出料緩衝(producer 非末站)
        self.on_belt: List[float] = []      # terminal 輸送帶:帶上各工件的剩餘輸送秒數
        self.prev_count: Optional[int] = None   # 累積量 tag 上次讀值(None=尚未初始化)
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
    def gate(self) -> None:
        for i, st in enumerate(self.stations):
            d = st.device
            if st.role in ("mid", "sink"):
                d.line_has_input = st.in_buf > 0
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
                        else down.in_buf + lk["in_hand"] < IN_CAP)):
                up.out_buf -= 1                            # 工件上手(從上游出料取走)
                lk["in_hand"] += 1

    def view(self) -> dict:
        return {
            "company": self.company_id,
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

    def gate(self) -> None:
        for line in self.lines:
            line.gate()

    def advance(self, dt_sim: float) -> None:
        for line in self.lines:
            line.advance(dt_sim)

    def view(self) -> List[dict]:
        return [line.view() for line in self.lines]
