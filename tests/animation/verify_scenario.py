"""場景健全性驗證:每一間工廠、每一台設備都真的跑得起來、資料合理、且畫得出來。

回答的問題是「**所有**工廠與設備都確認過了嗎」,所以不抽樣 —— 把場景整個載進引擎跑一段,
逐台檢查:

  1. 引擎面:每台設備都有 tag、值不是 NaN/Inf、producer 真的會運轉、
     累積量(part_count / shot_count / …)只增不減。
  2. 前端面:每個 template 都有對應的 3D 模型,而且動畫綁定表(docs/animation_binding.md)
     裡宣告要用的 tag,引擎真的有發 —— 這就是先前 `tank_pressure` / `yaw_angle` 那類
     「讀到 undefined」的缺陷,靜態就能擋掉。
  3. 場景面:公司 / 設備 id 不重複、每廠至少一台 producer、組合有多樣性。

用法:
    python3 tests/animation/verify_scenario.py [scenarios/class_park.yaml ...]
"""
from __future__ import annotations

import math
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import yaml  # noqa: E402

from engine.world import World  # noqa: E402

WEB_WORLD = ROOT / "web" / "src" / "world"
BINDING_DOC = ROOT / "docs" / "animation_binding.md"

# 不生產、不退化的「唯讀量測」型設備 —— 這些不要求 running
NON_PRODUCER = {"energy_meter"}
# 受班表影響的設備允許在非上班時段 idle
MONOTONIC_TAGS = ["part_count", "shot_count", "stroke_count", "cycle_count",
                  "wafer_count", "energy_total", "energy_kwh", "total_energy", "running_hours"]

FAIL: list[str] = []
INFO: list[str] = []


def fail(msg: str) -> None:
    FAIL.append(msg)
    print(f"  FAIL  {msg}")


def ok(msg: str) -> None:
    print(f"  PASS  {msg}")


# ── 1. 場景結構 ───────────────────────────────────────────
def check_structure(path: Path, park: dict) -> None:
    companies = park["companies"]
    cids = [c["id"] for c in companies]
    dids = [d["id"] for c in companies for d in c["devices"]]
    names = [c["name"] for c in companies]

    dup_c = [k for k, v in Counter(cids).items() if v > 1]
    dup_d = [k for k, v in Counter(dids).items() if v > 1]
    dup_n = [k for k, v in Counter(names).items() if v > 1]
    (ok if not dup_c else fail)(f"公司 id 不重複({len(cids)} 間)" if not dup_c else f"公司 id 重複:{dup_c}")
    (ok if not dup_d else fail)(f"設備 id 不重複({len(dids)} 台)" if not dup_d else f"設備 id 重複:{dup_d}")
    (ok if not dup_n else fail)("公司名不重複" if not dup_n else f"公司名重複:{dup_n}")

    empty = [c["id"] for c in companies if not c["devices"]]
    (ok if not empty else fail)("每間公司都有設備" if not empty else f"沒有設備的公司:{empty}")

    no_prod = [c["id"] for c in companies
               if all(d["template"] in NON_PRODUCER for d in c["devices"])]
    (ok if not no_prod else fail)(
        "每間公司都至少有一台 producer(學生才有東西可診斷)" if not no_prod
        else f"只有唯讀量測設備的公司:{no_prod}")

    combos = {tuple(sorted(d["template"] for d in c["devices"])) for c in companies}
    ratio = len(combos) / len(companies)
    (ok if ratio >= 0.3 else fail)(
        f"設備組合多樣性:{len(combos)} 種組合 / {len(companies)} 間公司(比值 {ratio:.2f})")

    used = {d["template"] for c in companies for d in c["devices"]}
    INFO.append(f"{path.name}: 使用 {len(used)} 種 template")
    return used


# ── 2. 每個 template 都有 3D 模型 ─────────────────────────
def check_models(used: set[str]) -> None:
    src = (WEB_WORLD / "FactoryLine3D.tsx").read_text(encoding="utf-8")
    block = src[src.index("const MODELS"):src.index("/** 各機種在產線視圖中的縮放")]
    mapped = set(re.findall(r"^\s*(\w+):", block, re.M))
    missing = used - mapped
    (ok if not missing else fail)(
        f"場景用到的 {len(used)} 種 template 都有 3D 模型" if not missing
        else f"沒有 3D 模型的 template:{sorted(missing)}")


# ── 3. 綁定表宣告的 tag,引擎真的有發 ─────────────────────
def check_binding_tags(world: World) -> None:
    """把 docs/animation_binding.md §4 表格裡的 `tag` 全撈出來,對照引擎實際發的 tag。

    這正是 tank_pressure / yaw_angle / voltage / current 那批缺陷的靜態防線。
    """
    doc = BINDING_DOC.read_text(encoding="utf-8")
    sec = doc[doc.index("## 4. 逐機種綁定表"):doc.index("## 5. 實作結構")]

    tags_by_tmpl: dict[str, set[str]] = {}
    for d in world.devices.values():
        tags_by_tmpl.setdefault(d.template, set()).update(t.name for t in d.tags)
        tags_by_tmpl[d.template].update(s.name for s in d.setpoints)
        tags_by_tmpl[d.template].update(c.name for c in d.command_coils)

    cur = None
    bad: list[str] = []
    checked = 0
    for line in sec.splitlines():
        m = re.match(r"### 4\.\d+ `(\w+)`", line)
        if m:
            cur = m.group(1)
            continue
        if cur is None or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.split("|")]
        if len(cells) < 4:
            continue
        # 第 2 欄是「引擎欄位」,裡面的 `xxx` 就是 tag 名
        for name in re.findall(r"`(\w+)`", cells[2]):
            if name in {"state", "coils", "run_enable", "reset_fault"}:
                continue
            checked += 1
            avail = tags_by_tmpl.get(cur, set())
            if avail and name not in avail:
                bad.append(f"{cur}.{name}")
    if bad:
        fail(f"綁定表宣告了引擎沒有的 tag({len(bad)} 個):{sorted(set(bad))}")
    else:
        ok(f"綁定表宣告的 {checked} 個 tag,引擎全部都有發")


# ── 4. 逐台設備跑一段,檢查資料健全 ───────────────────────
def check_runtime(world: World, park: dict, steps: int = 60) -> None:
    mult = park["sim"]["time_multiplier"]
    hz = park["sim"]["tick_hz"]
    dt_sim = mult / hz

    # 先暖機到模擬日 10:00,兩班制設備才在運轉
    for _ in range(200):
        world.clock.advance((10 * 3600 / 200) / mult)
        world.step(10 * 3600 / 200)

    first = {d.id: {t.name: t.value for t in d.tags} for d in world.devices.values()}
    seen_states: dict[str, set[str]] = {did: set() for did in world.devices}
    bad_num: list[str] = []
    for _ in range(steps):
        world.clock.advance(1.0 / hz)
        snap = world.step(dt_sim)
        for did, s in snap["devices"].items():
            seen_states[did].add(s["state"])
            for k, v in s["tags"].items():
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                    bad_num.append(f"{did}.{k}")

    (ok if not bad_num else fail)(
        f"全部 {len(world.devices)} 台設備、{steps} 拍內沒有 NaN / Inf" if not bad_num
        else f"出現 NaN / Inf:{sorted(set(bad_num))[:10]}")

    last = {d.id: {t.name: t.value for t in d.tags} for d in world.devices.values()}

    # producer 必須真的運轉過
    idle_only = [did for did, st in seen_states.items()
                 if world.devices[did].template not in NON_PRODUCER
                 and not (st & {"running", "moving", "charging"})]
    (ok if not idle_only else fail)(
        "所有 producer 在觀測窗內都運轉過" if not idle_only
        else f"整段都沒運轉的 producer:{idle_only[:10]}(共 {len(idle_only)})")

    # 累積量只增不減
    regress = []
    for did in world.devices:
        for tag in MONOTONIC_TAGS:
            if tag in first[did] and tag in last[did] and last[did][tag] < first[did][tag] - 1e-6:
                regress.append(f"{did}.{tag}")
    (ok if not regress else fail)(
        "累積量(件數 / 電能 / 運轉時數)全部只增不減" if not regress
        else f"累積量倒退:{regress[:10]}")

    # 每台至少有一個 tag 在動(不是整台凍住)
    frozen = [did for did in world.devices
              if all(abs(last[did][k] - first[did].get(k, 0)) < 1e-9 for k in last[did])]
    (ok if not frozen else fail)(
        "沒有整台數值凍住的設備" if not frozen else f"數值完全沒變的設備:{frozen[:10]}")


def verify(path: Path) -> None:
    print(f"\n=== {path} ===")
    park = yaml.safe_load(path.read_text(encoding="utf-8"))["park"]
    used = check_structure(path, park)
    check_models(used)
    world = World(park)
    check_binding_tags(world)
    check_runtime(world, park)


def main() -> None:
    paths = [Path(p) for p in sys.argv[1:]] or [
        ROOT / "scenarios" / "class_park.yaml",
        ROOT / "scenarios" / "default_park.yaml",
    ]
    print("場景健全性驗證(不抽樣,逐廠逐台)")
    for p in paths:
        verify(p)
    print()
    for i in INFO:
        print(f"  · {i}")
    print(f"\n失敗 {len(FAIL)} 項")
    for f in FAIL:
        print(f"  - {f}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
