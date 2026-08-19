"""整合建廠自動上線(commissioning)契約測試。

驗「A+B+C 一條龍」這條線的可驗證性質(引擎層,免協定 server):
  1. compose_company:template 白名單擋未知、count 夾限、順序 = 製程順序、
     建得成線就自動接 line:。
  2. 熱上線:add_company 之後 unit_id 不撞、≥50(避開既有定址)、
     新設備真的在推進(tag 有值)、產線帳真的在跑(snapshot.lines 有這間公司)。
  3. 點位表:涵蓋新公司全部設備與點位、位址在同設備同 object 內不重複、
     **不含 ground-truth**(health / 元件名不得洩漏 —— 那等於把答案發給學生)。
  4. CSV / Markdown 產得出來且行數對得上。
  5. REST 層(fastapi 可用時才跑):200 / 422 / 401、下載 header。

用法:
    python3 tests/test_commissioning.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.world import World  # noqa: E402
from ai.factory_generator import compose_company  # noqa: E402
from api.commissioning import _point_rows, points_csv, points_doc, points_markdown  # noqa: E402

FAIL: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {msg}")
    if not cond:
        FAIL.append(msg)


# ── 1. compose_company 規格 ─────────────────────────────
def check_compose() -> None:
    print("\n[1] compose_company:白名單 / 夾限 / 順序 / 自動接線")
    try:
        compose_company([{"template": "not_a_machine"}])
        check(False, "未知 template 要丟 ValueError")
    except ValueError:
        check(True, "未知 template 丟 ValueError(白名單擋下)")
    try:
        compose_company([])
        check(False, "空清單要丟 ValueError")
    except ValueError:
        check(True, "空清單丟 ValueError")

    cfg = compose_company([
        {"template": "laser_cutter"},
        {"template": "robot_arm_6axis"},
        {"template": "packaging_machine"},
    ], name="雷切包裝線")
    tmpls = [d["template"] for d in cfg["devices"]]
    check(tmpls == ["laser_cutter", "robot_arm_6axis", "packaging_machine"],
          f"設備依指定順序建置({tmpls})")
    ids = [d["id"] for d in cfg["devices"]]
    check(cfg.get("line") == ids, f"producer+手臂+producer 自動接線且依序({cfg.get('line')})")

    cfg2 = compose_company([{"template": "cnc_machining_center", "count": 99}])
    check(len(cfg2["devices"]) == 20, f"count 夾限在 20(99 → {len(cfg2['devices'])})")
    cfg3 = compose_company([{"template": "energy_meter", "count": 2}])
    check(cfg3.get("line") is None, "接不成線(無手臂)就不掛 line:")


# ── 2. 熱上線 ────────────────────────────────────────────
def check_hot_add(world: World) -> str:
    print("\n[2] 熱上線:unit_id 配址 / 引擎推進 / 產線帳")
    before_units = {(d.protocols.get("modbus", {}) or {}).get("unit_id")
                    for d in world.devices.values()}
    cfg = compose_company([
        {"template": "welding_cell"},
        {"template": "robot_arm_6axis"},
        {"template": "aoi_inspection"},
    ], name="焊接檢測線")
    result = world.add_company(cfg)
    cid = result["company"]
    new_ids = result["devices"]
    check(len(new_ids) == 3, f"3 台設備全部上線({new_ids})")

    units = [(world.devices[i].protocols.get("modbus", {}) or {}).get("unit_id") for i in new_ids]
    check(len(set(units)) == 3 and all(u >= 50 for u in units),
          f"unit_id 互不相同且 ≥50 避開既有定址({units})")
    check(not (set(units) & before_units), "unit_id 不與既有設備相撞")

    # 推進到工作時段,新設備要真的在發數據、產線帳要在跑
    world.clock.advance(10 * 3600 / max(1e-9, world.clock.time_multiplier))
    snap = None
    for _ in range(240):
        world.clock.advance(1.0 / world.clock.tick_hz)
        snap = world.step(world.clock.time_multiplier / world.clock.tick_hz)
    for i in new_ids:
        tags = snap["devices"][i]["tags"]
        check(all(v == v for v in tags.values()), f"{i} tag 全部有值且非 NaN({len(tags)} 點)")
    weld = snap["devices"][new_ids[0]]["tags"]
    check(weld.get("weld_count", 0) > 0, f"焊接站真的在完工(weld_count={weld.get('weld_count')})")
    ln = next((l for l in snap.get("lines", []) if l["company"] == cid), None)
    check(ln is not None, f"snapshot.lines 有這間公司的產線帳({cid})")
    if ln:
        aoi = snap["devices"][new_ids[2]]["tags"]
        moved = snap["devices"][new_ids[1]]["tags"].get("cycle_count", 0)
        check(aoi.get("inspected_count", 0) <= moved,
              f"下游守恆:AOI 檢數 {aoi.get('inspected_count')} ≤ 手臂搬運 {moved}(工件不憑空出現)")
    return cid


# ── 3. 點位表 ────────────────────────────────────────────
def check_points(world: World, cid: str) -> None:
    print("\n[3] 點位表:涵蓋 / 位址不重複 / 不洩 ground-truth")
    doc = points_doc(world, cid, host="10.0.0.9")
    dev_ids = {d.id for d in world.devices.values() if d.company_id == cid}
    check({d["id"] for d in doc["devices"]} == dev_ids, f"點位表涵蓋全部 {len(dev_ids)} 台設備")

    rows = _point_rows(doc)
    check(all(r["address"] is not None for r in rows), f"每個點位都有位址({len(rows)} 點)")
    dup = []
    for dev in dev_ids:
        seen = set()
        for r in rows:
            if r["device"] != dev:
                continue
            key = (r["object"], r["address"])
            # setpoint 與 holding 同屬 FC03 位址空間,合併查重
            key = ("holding", r["address"]) if "holding" in r["object"] else key
            if key in seen:
                dup.append((dev, key))
            seen.add(key)
    check(not dup, f"同設備同位址空間內位址不重複(重複:{dup[:3]})")

    blob = (points_csv(doc) + points_markdown(doc)).lower()
    leaks = [w for w in ("health", "ground_truth", "ground-truth", "degradation", "_fault_latched")
             if w in blob]
    check(not leaks, f"點位表不含 ground-truth 字樣(洩漏:{leaks})")

    csv_lines = points_csv(doc).strip().splitlines()
    check(len(csv_lines) == len(rows) + 1, f"CSV 行數 = 點位數 + 表頭({len(csv_lines)})")
    md = points_markdown(doc)
    check("合成" in md and "synthetic" in md.lower() or "合成" in md,
          "Markdown 指引明確標示合成數據(鐵則二)")
    check(points_doc(world, "no_such_company", host="x") is None, "查無公司回 None(REST 轉 404)")


# ── 4. REST 層(fastapi 可用才跑)────────────────────────
def check_rest() -> None:
    print("\n[4] REST 層:/api/factory/compose 與點位表下載")
    try:
        from fastapi.testclient import TestClient  # noqa
        from api.rest import create_app
    except ImportError:
        print("  SKIP  fastapi 未安裝(CI 契約測試只裝 numpy/PyYAML)—— 引擎層已在 [1-3] 驗過")
        return
    world = World.from_yaml(ROOT / "scenarios" / "default_park.yaml")
    app = create_app(world, None, None, {"teacher_token": "tt", "public_host": "10.0.0.5"})
    c = TestClient(app)
    hdr = {"Authorization": "Bearer tt"}
    r = c.post("/api/factory/compose", json={
        "name": "REST 整合廠", "selftest": False,
        "devices": [{"template": "injection_molding"}, {"template": "robot_arm_6axis"},
                    {"template": "packaging_machine"}]}, headers=hdr)
    check(r.status_code == 200, f"compose 成功({r.status_code})")
    j = r.json()
    check(j.get("line") == j.get("devices"), f"回應含自動接線結果({j.get('line')})")
    check(bool(j.get("points", {}).get("devices")), "回應內含完整點位表")
    r2 = c.get(f"/api/commissioning/{j['company']}?format=csv")
    check(r2.status_code == 200 and "attachment" in r2.headers.get("content-disposition", ""),
          "CSV 下載帶 attachment header")
    r3 = c.get(f"/api/commissioning/{j['company']}?format=md")
    check(r3.status_code == 200 and r3.text.startswith("# "), "Markdown 指引可下載")
    check(c.post("/api/factory/compose", json={"devices": [{"template": "nope"}]}, headers=hdr).status_code == 422,
          "未知 template → 422")
    check(c.post("/api/factory/compose", json={"devices": []}, headers=hdr).status_code == 422,
          "空清單 → 422")
    check(c.post("/api/factory/compose", json={"devices": [{"template": "conveyor"}]}).status_code == 401,
          "無教師 token → 401")
    check(c.get("/api/commissioning/no_such").status_code == 404, "查無公司 → 404")


def main() -> None:
    print("整合建廠自動上線(commissioning)契約測試")
    check_compose()
    world = World.from_yaml(ROOT / "scenarios" / "class_park.yaml")
    cid = check_hot_add(world)
    check_points(world, cid)
    check_rest()
    print(f"\n總計 {'全部通過' if not FAIL else f'{len(FAIL)} 項失敗'}")
    if FAIL:
        for m in FAIL:
            print(f"  - {m}")
        sys.exit(1)


if __name__ == "__main__":
    main()
