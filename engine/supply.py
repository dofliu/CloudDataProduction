"""跨公司供應鏈 —— 你的產出是別人的進料。

`engine/line.py` 已經讓工件在**一間公司內**真實流動(CNC → 手臂 → CNC)。這一層把同一件事
往上推一階:**A 公司出貨的成品,變成 B 公司的原料**。

為什麼值得做:60 人的班,每個人守著自己那間廠,彼此沒有關係。接上供應鏈之後 ——

  - 你上游那位同學的機台壞了沒人管,**你的產線就餓料停機**。
  - 你自己停太久,下游同學的進料倉會塞爆,**反過來把你卡住**(阻塞)。

這是全班第一次感覺到彼此存在,也正好是「雲端生產 / 雲製造」那章的活教材:
供應鏈可視性、單一供應商風險、長鞭效應,都不用比喻,現場就在跑。

## 場景怎麼宣告

park 層:

    supply_chain:
      - {from: c01, to: c02, part: "精加工件", cap: 30, initial: 12, external_backup_h: 2}

  - `cap`      客戶端進料倉容量。塞滿 → 供應商出貨端阻塞(下游不收貨,你就得停)。
  - `initial`  開場庫存(不然開學第一分鐘全班一起餓料)。
  - `external_backup_h`  缺料超過這麼多**模擬小時**,外部備援供應商補一件。
      0 / 省略 = 沒有備援,上游不動你就一直餓著。

外部備援不是為了讓資料好看,是為了「單一供應商風險」這件事可以被量化:平台分別記
`delivered`(上游同學供的)與 `purchased`(外部備援補的),誰的廠長期靠外購一眼看得出來。
沒有備援時整條鏈會真的停 —— 那也是誠實的結果,教師可以刻意留一條沒備援的鏈當對照。

## 誰算供應商 / 誰算客戶

  - 公司有 `line:` 宣告 → 產出看那條產線的 `shipped`,消耗看**首站**的完工數(它吃原料)。
  - 公司沒有 `line:`(一人一廠常見)→ 產出與消耗都看該公司所有 producer 的累積量 tag。

兩種情況都不另設事件通道,直接讀學生從 Modbus 讀得到的同一組累積量(鐵則二:同一份資料,
不做兩套)。

鐵則一:庫存狀態只存在這裡(引擎),API / 前端只讀。
"""
from __future__ import annotations

from typing import Dict, List, Optional

from .device import Device
from .line import COUNT_TAGS

DEFAULT_CAP = 30
DEFAULT_INITIAL = 10


def _producers(world, company_id: str) -> List[Device]:
    return [d for d in world.devices.values()
            if d.company_id == company_id and d.template in COUNT_TAGS]


def _count_of(device: Device) -> int:
    tag_name = COUNT_TAGS.get(device.template)
    if tag_name is None:
        return 0
    t = next((x for x in device.tags if x.name == tag_name), None)
    return int(t.value) if t is not None else 0


class SupplyLink:
    """一條供應關係:上游公司 → 下游公司的進料倉。"""

    def __init__(self, world, spec: dict, up_line=None, down_line=None):
        self.world = world
        self.src: str = spec["from"]
        self.dst: str = spec["to"]
        self.part: str = spec.get("part") or "零件"
        self.cap = int(spec.get("cap", DEFAULT_CAP))
        self.stock = int(spec.get("initial", DEFAULT_INITIAL))
        self.backup_h = float(spec.get("external_backup_h") or 0.0)

        self.up_line = up_line          # 上游公司的 ProductionLine(可能沒有)
        self.down_line = down_line      # 下游公司的 ProductionLine(可能沒有)
        # 下游「吃原料」的設備:有產線 → 首站;沒有 → 所有 producer
        self.consumers: List[Device] = (
            [down_line.stations[0].device] if down_line is not None else _producers(world, self.dst))
        # 上游「出貨」的設備:有產線 → 末站;沒有 → 所有 producer(塞爆時擋它們)
        self.suppliers: List[Device] = (
            [up_line.stations[-1].device] if up_line is not None else _producers(world, self.src))

        self._prev_out: Optional[int] = None
        self._prev_in: Optional[int] = None
        self.delivered = 0        # 上游同學供的件數
        self.purchased = 0        # 外部備援補的件數
        self.consumed = 0         # 下游吃掉的件數
        self.starved_sim_s = 0.0  # 累計缺料時間(sim 秒)
        self.blocked_sim_s = 0.0  # 累計阻塞時間(倉滿,上游被卡)
        self._dry_s = 0.0         # 目前這段連續缺料多久(外部備援計時用)

    # ── 讀計數器 ───────────────────────────────────────────
    def _out_count(self) -> int:
        if self.up_line is not None:
            return int(self.up_line.shipped)
        return sum(_count_of(d) for d in _producers(self.world, self.src))

    def _in_count(self) -> int:
        if self.down_line is not None:
            return int(self.down_line.stations[0].count())
        return sum(_count_of(d) for d in _producers(self.world, self.dst))

    # ── 每 tick:設備 step 之後記帳 ──────────────────────────
    def advance(self, dt_sim: float) -> None:
        # 1. 上游出貨 → 進料倉(倉滿的部分留在上游,下一拍會把上游卡住)
        out = self._out_count()
        if self._prev_out is None:
            self._prev_out = out
        d_out = max(0, out - self._prev_out)
        self._prev_out = out
        if d_out:
            take = min(d_out, max(0, self.cap - self.stock))
            self.stock += take
            self.delivered += take

        # 2. 下游完工 → 吃掉進料(有做出東西才算吃掉,誠實)
        cin = self._in_count()
        if self._prev_in is None:
            self._prev_in = cin
        d_in = max(0, cin - self._prev_in)
        self._prev_in = cin
        if d_in:
            eat = min(d_in, self.stock)
            self.stock -= eat
            self.consumed += eat

        # 3. 缺料 / 阻塞計時 + 外部備援
        if self.stock <= 0:
            self.starved_sim_s += dt_sim
            self._dry_s += dt_sim
            if self.backup_h > 0 and self._dry_s >= self.backup_h * 3600.0:
                self.stock += 1                # 外部供應商補一件(有備援的鏈不會真的死)
                self.purchased += 1
                self._dry_s = 0.0
        else:
            self._dry_s = 0.0
        if self.stock >= self.cap:
            self.blocked_sim_s += dt_sim

    def view(self) -> dict:
        return {
            "from": self.src, "to": self.dst, "part": self.part,
            "stock": self.stock, "cap": self.cap,
            "delivered": self.delivered, "purchased": self.purchased, "consumed": self.consumed,
            "starved_h": round(self.starved_sim_s / 3600.0, 2),
            "blocked_h": round(self.blocked_sim_s / 3600.0, 2),
            "starving": self.stock <= 0,
            "blocking": self.stock >= self.cap,
            # 自給率:進料有多少比例真的來自上游同學(其餘靠外部備援買的)
            "self_sufficiency": (round(self.delivered / (self.delivered + self.purchased), 3)
                                 if (self.delivered + self.purchased) else None),
            "external_backup_h": self.backup_h or None,
        }


class SupplyChainManager:
    """園區級:解析 supply_chain: 宣告、每 tick 推進所有供應關係。"""

    def __init__(self, world):
        self.world = world
        self.links: List[SupplyLink] = []
        self.reload()

    def reload(self) -> None:
        """(重)解析 park 的 supply_chain:。建構期與熱載入建廠後都可呼叫。"""
        self.links = []
        specs = self.world.park.get("supply_chain") or []
        companies = {c.get("id") for c in self.world.park.get("companies", []) or []}
        by_company = {ln.company_id: ln for ln in getattr(self.world, "lines", None).lines} \
            if getattr(self.world, "lines", None) is not None else {}
        for spec in specs:
            src, dst = spec.get("from"), spec.get("to")
            if src not in companies or dst not in companies:
                print(f"[supply] 找不到公司({src} → {dst}),略過這條供應關係")
                continue
            if src == dst:
                print(f"[supply] {src} 不能供給自己,略過")
                continue
            link = SupplyLink(self.world, spec, up_line=by_company.get(src), down_line=by_company.get(dst))
            if not link.consumers:
                print(f"[supply] {dst} 沒有會生產的設備,吃不了料,略過 {src} → {dst}")
                continue
            if not link.suppliers:
                print(f"[supply] {src} 沒有會生產的設備,供不了料,略過 {src} → {dst}")
                continue
            self.links.append(link)

    def gate(self) -> None:
        """設備 step 之前設閘門。

        一間公司可能有多個上游 / 多個下游,所以要先彙總再套用:
          - 缺料 = **任一**上游斷貨就停(OR)—— 少一種料就做不出來,這是誠實的。
          - 阻塞 = **任一**下游倉滿就卡(OR)。
        供應鏈只管廠內產線**沒在管**的那些旗標:consumers 是首站 / 獨立 producer,
        suppliers 是末站 / 獨立 producer,LineManager 都不會在同一拍覆寫它們。
        """
        starve: Dict[str, bool] = {}
        block: Dict[str, bool] = {}
        touched: Dict[str, Device] = {}
        for link in self.links:
            for d in link.consumers:
                touched[d.id] = d
                if d.line_role is None:
                    d.line_role = "mid"       # 「需要進料」的角色
                d.line_enabled = True         # 沒有 line: 宣告的設備要先開閘門機制才看得到旗標
                starve[d.id] = starve.get(d.id, False) or (link.stock <= 0)
            for d in link.suppliers:
                touched[d.id] = d
                if d.line_role is None:
                    d.line_role = "sink"      # 「會出貨」的角色
                d.line_enabled = True
                block[d.id] = block.get(d.id, False) or (link.stock >= link.cap)
        for did, d in touched.items():
            if did in starve:
                d.line_has_input = not starve[did]
            if did in block:
                d.line_output_blocked = block[did]

    def advance(self, dt_sim: float) -> None:
        for link in self.links:
            link.advance(dt_sim)

    # ── 視圖 ───────────────────────────────────────────────
    def view(self) -> List[dict]:
        return [link.view() for link in self.links]

    def for_company(self, company_id: str) -> dict:
        """某公司的上下游關係(學生面:我等誰的料、誰在等我)。"""
        return {
            "company": company_id,
            "inbound": [l.view() for l in self.links if l.dst == company_id],
            "outbound": [l.view() for l in self.links if l.src == company_id],
        }

    def impact(self) -> List[dict]:
        """誰害到誰:目前正在餓料 / 阻塞的關係,教師面一眼看見連鎖反應。"""
        rows = []
        for l in self.links:
            if l.stock <= 0:
                rows.append({"kind": "starving", "from": l.src, "to": l.dst, "part": l.part,
                             "detail": f"{l.dst} 缺 {l.part},在等 {l.src} 出貨"})
            elif l.stock >= l.cap:
                rows.append({"kind": "blocking", "from": l.src, "to": l.dst, "part": l.part,
                             "detail": f"{l.dst} 進料倉滿,{l.src} 出貨端被卡住"})
        return rows
