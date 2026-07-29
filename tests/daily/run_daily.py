"""每日模擬測試:跑當天的操作情境,把引擎面的判定與畫面用的 telemetry 都吐出來。

回答的問題不是「程式有沒有 crash」,而是**在這個操作情境下,平台的資料還正確嗎**。
所以每個情境都帶一組 `expect`(見 scenarios.yaml),跑完逐條判定 PASS / FAIL。

情境依日期輪替 —— 同一天重跑得到同一個(可重現),不同天走到不同情境。

用法:
    python3 tests/daily/run_daily.py [--date YYYY-MM-DD] [--key <情境>] [--out <目錄>]

輸出:
    <out>/result.json          判定結果 + 引擎面數字
    web/preview/frames_daily.json   給瀏覽器逐幀重播用(shoot_daily.mjs 會讀)
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import yaml  # noqa: E402

from engine.world import World  # noqa: E402

CATALOG = Path(__file__).with_name("scenarios.yaml")
DEFAULT_SCENARIO = ROOT / "scenarios" / "default_park.yaml"
FRAMES_OUT = ROOT / "web" / "preview" / "frames_daily.json"

# 這些 tag 是累積量,只能增不能減
MONOTONIC = ["part_count", "shot_count", "stroke_count", "cycle_count",
             "wafer_count", "energy_total", "running_hours"]
RUNNING_STATES = {"running", "moving", "charging", "tool_change"}
# 不生產的唯讀量測設備,不要求它「運轉」
NON_PRODUCER = {"energy_meter"}


def pick_scenario(cat: list[dict], on: date, key: str | None) -> dict:
    if key:
        for s in cat:
            if s["key"] == key:
                return s
        raise SystemExit(f"找不到情境 {key};可用:{[s['key'] for s in cat]}")
    # 依「距 epoch 的天數」輪替 —— 與月份長度無關,不會有某些情境永遠輪不到
    return cat[on.toordinal() % len(cat)]


def apply_injections(world: World, spec: list[dict]) -> list[dict]:
    """對每個 template 挑前 n 台注入。挑法是固定的(依 device id 排序),所以可重現。"""
    applied = []
    by_tmpl: dict[str, list] = {}
    for d in sorted(world.devices.values(), key=lambda x: x.id):
        by_tmpl.setdefault(d.template, []).append(d)
    for item in spec:
        tmpl = item["template"]
        target = item.get("component") or item.get("tag")
        ftype = item["fault_type"]
        sev = float(item.get("severity", 1.0))
        for d in by_tmpl.get(tmpl, [])[: int(item.get("count", 1))]:
            d.inject_fault(ftype, target, severity=sev)
            applied.append({"device": d.id, "template": tmpl, "target": target,
                            "fault_type": ftype, "severity": sev})
    return applied


def stop_devices(world: World, n: int) -> list[str]:
    """關掉前 n 台 producer 的 run_enable(教師停機)。"""
    stopped = []
    for d in sorted(world.devices.values(), key=lambda x: x.id):
        if d.template in NON_PRODUCER:
            continue
        for c in d.command_coils:
            if c.name == "run_enable":
                c.value = False
                stopped.append(d.id)
                break
        if len(stopped) >= n:
            break
    return stopped


def run(scn: dict, park: dict) -> dict:
    world = World(park)
    mult = park["sim"]["time_multiplier"]
    hz = park["sim"]["tick_hz"]

    # 暖機到指定的模擬時刻(two_shift 設備只有 06:00–22:00 運轉)
    warm_s = float(scn.get("warmup_h", 10.0)) * 3600
    for _ in range(200):
        world.clock.advance((warm_s / 200) / mult)
        world.step(warm_s / 200)

    applied = apply_injections(world, scn.get("inject", []) or [])
    stopped = stop_devices(world, int(scn["stop"])) if scn.get("stop") else []

    # 觀測窗:切成 120 幀,前端重播用得到,趨勢判定也夠細
    FRAMES = 120
    obs_s = float(scn.get("observe_min", 40)) * 60
    dt = obs_s / FRAMES

    # 前端載具(web/preview/verify.html)是用 **template 名**當 device key 找設備的
    # (見 tests/animation/capture_frames.py 的慣例)。這裡用的是真實園區、key 是真實
    # 設備 id,所以每個要截圖的機種補一個別名 —— 而且**優先指向被注入 / 被停機的那台**,
    # 報告才會拍到真的出事的機器,不是隨便一台正常的。
    hurt = {a["device"] for a in applied} | set(stopped)
    rep: dict[str, str] = {}
    for tmpl in scn.get("shoot", []) or []:
        cands = sorted(d.id for d in world.devices.values() if d.template == tmpl)
        if cands:
            rep[tmpl] = next((c for c in cands if c in hurt), cands[0])

    frames, first, last = [], None, None
    seen_states: dict[str, set[str]] = {}
    bad_num: list[str] = []
    series: dict[str, dict[str, list[float]]] = {}   # tag → device → 值序列

    for i in range(FRAMES):
        world.clock.advance(dt / mult)
        snap = world.step(dt)
        devs = snap["devices"]
        if first is None:
            first = {k: dict(v["tags"]) for k, v in devs.items()}
        last = {k: dict(v["tags"]) for k, v in devs.items()}
        for did, s in devs.items():
            seen_states.setdefault(did, set()).add(s["state"])
            for k, v in s["tags"].items():
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                    bad_num.append(f"{did}.{k}")
                series.setdefault(k, {}).setdefault(did, []).append(float(v))
        aliased = dict(devs)
        for tmpl, did in rep.items():
            if did in devs:
                aliased[tmpl] = devs[did]
        frames.append({"sim_t": snap.get("sim_t", i * dt), "multiplier": mult, "devices": aliased})

    FRAMES_OUT.parent.mkdir(parents=True, exist_ok=True)
    FRAMES_OUT.write_text(json.dumps({"time_multiplier": mult, "frames": frames}), encoding="utf-8")

    return {"world": world, "frames": frames, "first": first, "last": last,
            "seen_states": seen_states, "bad_num": bad_num, "series": series,
            "applied": applied, "stopped": stopped, "rep": rep}


def evaluate(scn: dict, r: dict) -> list[dict]:
    """逐條判定。每條都回 {name, ok, detail} —— detail 要能讓人不看程式就懂為什麼。"""
    out: list[dict] = []

    def add(name: str, ok: bool, detail: str) -> None:
        out.append({"name": name, "ok": bool(ok), "detail": detail})

    states = r["seen_states"]
    faulted = [d for d, st in states.items() if "fault" in st]
    devs = r["world"].devices

    # ── 不分情境都要成立的 ──────────────────────────────
    add("沒有 NaN / Inf", not r["bad_num"],
        "全部乾淨" if not r["bad_num"] else f"出現:{sorted(set(r['bad_num']))[:8]}")

    regress = [f"{did}.{t}" for did in r["last"] for t in MONOTONIC
               if t in r["first"].get(did, {}) and t in r["last"][did]
               and r["last"][did][t] < r["first"][did][t] - 1e-6]
    add("累積量只增不減", not regress,
        "件數 / 電能 / 運轉時數全部單調" if not regress else f"倒退:{regress[:8]}")

    exp = scn.get("expect", {}) or {}

    # ── 情境專屬 ────────────────────────────────────────
    if "any_fault" in exp:
        want = bool(exp["any_fault"])
        got = len(faulted) > 0
        add(f"{'應該' if want else '不應該'}有設備進入 fault", got == want,
            f"實際 {len(faulted)} 台進入 fault" + (f":{faulted[:6]}" if faulted else ""))

    if exp.get("all_running"):
        idle = [d for d, st in states.items()
                if devs[d].template not in NON_PRODUCER and not (st & RUNNING_STATES)]
        add("所有 producer 都在運轉", not idle,
            "全部運轉中" if not idle else f"整段沒運轉:{idle[:8]}(共 {len(idle)})")
    elif exp.get("all_running") is False:
        idle = [d for d, st in states.items()
                if devs[d].template not in NON_PRODUCER and not (st & RUNNING_STATES)]
        add("非上班時段:設備應停著(而非資料凍住或算成故障)", len(idle) > 0 and not faulted,
            f"{len(idle)} 台停著、{len(faulted)} 台故障(故障應為 0)")

    if exp.get("stopped_still"):
        # 被停機的設備:動作類 tag 在觀測窗內不該再變動
        moving = []
        for did in r["stopped"]:
            for tag in ("pos_x", "ram_position", "belt_speed", "spindle_speed", "speed"):
                vals = r["series"].get(tag, {}).get(did)
                if vals and (max(vals) - min(vals)) > 1e-6:
                    moving.append(f"{did}.{tag}")
        add("教師停機的設備機構真的停住", not moving,
            f"{len(r['stopped'])} 台被停機,動作量全部靜止" if not moving
            else f"仍在動:{moving[:8]}")

    def trend(tag: str, want_up: bool, min_ratio: float = 0.03):
        """看被注入的設備上,某 tag 頭尾是否有明顯變化(避免拿雜訊當趨勢)。"""
        targets = [x["device"] for x in r["applied"]]
        hits, flats = [], []
        for did in targets:
            vals = r["series"].get(tag, {}).get(did)
            if not vals or len(vals) < 20:
                continue
            head = sum(vals[:10]) / 10
            tail = sum(vals[-10:]) / 10
            moved = (tail > head * (1 + min_ratio)) if want_up else (tail < head * (1 - min_ratio))
            (hits if moved else flats).append(f"{did}({head:.2f}→{tail:.2f})")
        if not (hits or flats):
            return
        word = "上升" if want_up else "下降"
        add(f"{tag} 在被注入的設備上呈{word}趨勢",
            len(hits) >= max(1, len(hits + flats) // 2),
            f"{word} {len(hits)} 台 / 未動 {len(flats)} 台;例:{(hits or flats)[:3]}")

    for tag in exp.get("trend_up", []) or []:
        trend(tag, True)
    for tag in exp.get("trend_down", []) or []:
        trend(tag, False)

    # 訊號脫鉤:濾網阻塞的診斷特徵是「電流上升但流量下降」—— 單看一個訊號會漏掉重點,
    # 這也正是 W8 要學生分辨的東西。
    for pair in exp.get("decouple", []) or []:
        up_tag, down_tag = pair["up"], pair["down"]
        good, bad = [], []
        for did in [x["device"] for x in r["applied"]]:
            u = r["series"].get(up_tag, {}).get(did)
            d = r["series"].get(down_tag, {}).get(did)
            if not u or not d or len(u) < 20:
                continue
            du = sum(u[-10:]) / 10 - sum(u[:10]) / 10
            dd = sum(d[-10:]) / 10 - sum(d[:10]) / 10
            (good if du > 0 and dd < 0 else bad).append(f"{did}(Δ{up_tag}={du:+.2f}, Δ{down_tag}={dd:+.2f})")
        if good or bad:
            add(f"{up_tag} 上升而 {down_tag} 下降(兩訊號脫鉤)",
                len(good) >= max(1, len(good + bad) // 2),
                f"符合 {len(good)} 台 / 不符 {len(bad)} 台;例:{(good or bad)[:3]}")

    if exp.get("sensor_marked"):
        marked = [a["device"] for a in r["applied"] if a["fault_type"].startswith("sensor_")]
        ok = all(any(x.get("kind") == "sensor" for x in devs[d]._injected) for d in marked) if marked else False
        add("感測器故障被標記為 sensor 型(不是設備故障)", ok,
            f"{len(marked)} 台注入感測器故障,引擎皆記為 sensor 型" if ok
            else "有設備把感測器故障記成了設備故障")

    # ── 故障的設備不可以還在生產 ────────────────────────
    # state=fault 卻回報 spindle_speed=8000 / 件數持續增加,是兩套互相矛盾的資料:
    # 學生用 Modbus 讀會看到「故障中的機台正在全速加工」。這條不分情境都要成立。
    RATE_TAGS = ["spindle_speed", "stroke_rate", "belt_speed", "screw_speed",
                 "rotor_rpm", "flow", "throughput"]
    COUNTERS = ["part_count", "shot_count", "stroke_count", "wafer_count", "cycle_count"]
    still_running, still_counting = [], []
    for did in faulted:
        # 只看「進入 fault 之後」的後半段,避開故障發生當下的過渡
        for tag in RATE_TAGS:
            vals = r["series"].get(tag, {}).get(did)
            if vals and abs(sum(vals[-20:]) / 20) > 1e-3:
                still_running.append(f"{did}.{tag}={sum(vals[-20:]) / 20:.1f}")
        for tag in COUNTERS:
            vals = r["series"].get(tag, {}).get(did)
            if vals and vals[-1] > vals[len(vals) // 2] + 1e-6:
                still_counting.append(f"{did}.{tag}")
    if faulted:
        add("故障的設備已停止運轉(速率類 tag 歸零)", not still_running,
            f"{len(faulted)} 台故障,速率類 tag 全部歸零" if not still_running
            else f"仍回報運轉速率:{sorted(set(still_running))[:8]}")
        add("故障的設備不再累積產出", not still_counting,
            f"{len(faulted)} 台故障,件數不再增加" if not still_counting
            else f"故障後仍在計件:{sorted(set(still_counting))[:8]}")

    # ── 跨 tag 的物理不變量(手臂:末端方位角 ≡ J1)────────
    worst, n = 0.0, 0
    for d in devs.values():
        if d.template != "robot_arm_6axis":
            continue
        tags = {t.name: t.value for t in d.tags}
        if "tcp_x" not in tags:
            continue
        bearing = math.degrees(math.atan2(tags["tcp_y"], tags["tcp_x"]))
        worst = max(worst, abs((bearing - tags["joint_angle_1"] + 180) % 360 - 180))
        n += 1
    if n:
        add("手臂末端座標與六軸角度一致", worst < 2.0,
            f"{n} 台,方位角與 joint_angle_1 最大偏差 {worst:.2f}°(容許 2°)")

    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None, help="YYYY-MM-DD;決定今天輪到哪個情境")
    ap.add_argument("--key", default=None, help="指定情境(覆蓋日期輪替)")
    ap.add_argument("--scenario", default=str(DEFAULT_SCENARIO))
    ap.add_argument("--out", default=str(ROOT / "artifacts" / "daily"))
    a = ap.parse_args()

    on = datetime.strptime(a.date, "%Y-%m-%d").date() if a.date else date.today()
    doc = yaml.safe_load(CATALOG.read_text(encoding="utf-8"))
    cat = doc["scenarios"]
    known = doc.get("known_issues", []) or []
    scn = pick_scenario(cat, on, a.key)

    park = yaml.safe_load(Path(a.scenario).read_text(encoding="utf-8"))["park"]
    print(f"=== {on} · 情境「{scn['title']}」({scn['key']}) ===")
    print(f"    {scn.get('why','')}")

    r = run(scn, park)
    checks = evaluate(scn, r)
    # 標記已知待修:失敗但已登記在案的,歸為 known 而不是 new —— 報告的紅色要留給新問題
    for c in checks:
        c["known"] = None
        if not c["ok"]:
            for k in known:
                if k["match"] in c["name"]:
                    c["known"] = {"since": k.get("since", ""), "note": k.get("note", "")}
                    break
    for c in checks:
        mark = "PASS" if c["ok"] else ("KNOWN" if c["known"] else "FAIL")
        print(f"  {mark:5s} {c['name']}\n        {c['detail']}")

    devs = r["world"].devices
    states: dict[str, int] = {}
    for did, st in r["seen_states"].items():
        states["fault" if "fault" in st else ("running" if st & RUNNING_STATES else "idle")] = \
            states.get("fault" if "fault" in st else ("running" if st & RUNNING_STATES else "idle"), 0) + 1

    failed = [c for c in checks if not c["ok"] and not c["known"]]
    known_hit = [c for c in checks if not c["ok"] and c["known"]]
    result = {
        "date": on.isoformat(), "scenario": scn["key"], "title": scn["title"],
        "why": scn.get("why", ""), "checks": checks,
        "passed": len([c for c in checks if c["ok"]]),
        "known": len(known_hit), "failed": len(failed),
        "devices": len(devs), "companies": len(park["companies"]),
        "state_counts": states,
        "injected": r["applied"], "stopped": r["stopped"],
        "shoot": scn.get("shoot", []),
        # 每個截圖機種實際拍的是哪一台(優先是被注入 / 被停機的那台)
        "shoot_device": r["rep"],
        "frames": len(r["frames"]),
    }
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(checks)} 項,通過 {result['passed']}"
          f",已知待修 {result['known']},**新問題 {result['failed']}**")
    print(f"寫入 {out/'result.json'} 與 {FRAMES_OUT}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
