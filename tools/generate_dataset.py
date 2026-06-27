"""資料集產生器 —— 階段二訓練用的標註歷史資料(headless、快轉、無需 DB / Docker)。

直接驅動引擎(不開協定 / API),把每台設備跑過多次「劣化 → 故障 → 維修」循環,
逐筆輸出觀測訊號 + ground-truth + 監督式標籤。產出 dataset/<device>.csv,給學生直接訓練
故障診斷 / RUL / 預測性維護模型。

每筆欄位:
  sim_t, sim_h, state, <各觀測 tag...>,
  gt_health_min  : 當下最差元件真實健康度(0~1)
  gt_rul_sim_s   : 引擎估計剩餘壽命(sim 秒;待機時空)
  is_sensor_fault: 該筆是否處於感測器故障期(讀值脫鉤真實)
  cycle_id       : 第幾個劣化循環(每次維修 +1)
  ttf_sim_s      : 距本循環實際故障的時間(sim 秒;末循環未故障則空=censored)
  fail_within_24h: 24 sim 小時內是否會故障(0/1;分類標籤)

⚠ 全部為合成數據(synthetic),帶 ground-truth,僅供教學。

用法:
  python tools/generate_dataset.py --sim-days 120 --step-min 5 --out dataset
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.world import World  # noqa: E402

SENSOR_TYPES = ["sensor_drift", "sensor_bias", "sensor_stuck", "sensor_noise"]
HORIZON_24H = 24 * 3600.0


def _sensor_target(device) -> str | None:
    """挑一個適合注入感測器故障的 float tag(溫度/振動/電流類)。"""
    prefer = [t.name for t in device.tags
              if t.datatype == "float32" and any(k in t.name for k in ("temp", "vibration", "current", "soc"))]
    return prefer[0] if prefer else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="scenarios/default_park.yaml")
    ap.add_argument("--out", default="dataset")
    ap.add_argument("--sim-days", type=float, default=120.0, help="總模擬天數")
    ap.add_argument("--step-min", type=float, default=5.0, help="取樣解析度(模擬分鐘)")
    ap.add_argument("--repair-hours", type=float, default=3.0, help="故障後維修停機(sim 小時)")
    ap.add_argument("--sensor-fault-prob", type=float, default=0.3, help="每循環注入感測器故障的機率")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    world = World.from_yaml(root / args.scenario)
    rng = np.random.default_rng(args.seed)

    out_dir = root / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    dt = args.step_min * 60.0
    total = args.sim_days * 86400.0
    repair = args.repair_hours * 3600.0

    # 每台設備:CSV writer、欄位、目前循環緩衝、狀態機
    files, writers, tag_names = {}, {}, {}
    buffers, cycle_id, fault_handled, pending_reset = {}, {}, {}, {}
    for d in world.devices.values():
        # 排除 "state" tag,避免與下面可讀的字串 state 欄撞名(state 已用字串呈現)
        tag_names[d.id] = [t.name for t in d.tags if t.name != "state"]
        f = open(out_dir / f"{d.id}.csv", "w", newline="", encoding="utf-8")
        w = csv.writer(f)
        w.writerow(["sim_t", "sim_h", "state"] + tag_names[d.id]
                   + ["gt_health_min", "gt_rul_sim_s", "is_sensor_fault", "cycle_id", "ttf_sim_s", "fail_within_24h"])
        files[d.id], writers[d.id] = f, w
        buffers[d.id], cycle_id[d.id], fault_handled[d.id], pending_reset[d.id] = [], 0, False, None

    def maybe_inject_sensor(d):
        if rng.random() < args.sensor_fault_prob:
            tag = _sensor_target(d)
            if tag:
                ft = SENSOR_TYPES[int(rng.integers(0, len(SENSOR_TYPES)))]
                d.inject_fault(ft, tag, severity=float(rng.uniform(0.5, 1.0)))

    # 第一個循環也可能有感測器故障
    for d in world.devices.values():
        maybe_inject_sensor(d)

    sim_t = 0.0
    stats = {d.id: {"rows": 0, "faults": 0} for d in world.devices.values()}
    n_steps = int(total / dt)
    for step in range(n_steps):
        world.clock._sim_t += dt
        sim_t = world.clock.now()
        snap = world.step(dt)

        for d in world.devices.values():
            # 維修時間到 → reset 開新循環(本 tick 的 snapshot 仍是舊狀態,跳過,下 tick 才記新循環)
            if pending_reset[d.id] is not None and sim_t >= pending_reset[d.id]:
                d.reset()
                cycle_id[d.id] += 1
                fault_handled[d.id] = False
                pending_reset[d.id] = None
                maybe_inject_sensor(d)
                continue
            if fault_handled[d.id]:
                continue   # 故障維修窗,不記錄(保持各循環乾淨收在故障點)

            pub = snap["devices"][d.id]
            gt = d.ground_truth()
            comps = gt["components"]
            h_min = round(min((c["health"] for c in comps), default=1.0), 4)
            rul = gt["rul_sim_s"]
            row = {
                "sim_t": round(sim_t, 1), "sim_h": round(sim_t / 3600.0, 3),
                "state": pub["state"],
                "gt_health_min": h_min,
                "gt_rul_sim_s": "" if rul is None else round(rul, 1),
                "is_sensor_fault": int(gt["is_sensor_fault"]),
                "cycle_id": cycle_id[d.id],
                "tags": {k: round(v, 4) for k, v in pub["tags"].items()},
            }
            buffers[d.id].append(row)

            # 進入故障 → 結算本循環(回填 ttf / 標籤)→ 排程維修
            if pub["state"] == "fault":
                fault_t = d._fault_onset_sim_t or sim_t
                for r in buffers[d.id]:
                    ttf = max(0.0, fault_t - r["sim_t"])
                    r["ttf_sim_s"] = round(ttf, 1)
                    r["fail_within_24h"] = int(ttf <= HORIZON_24H)
                _flush(writers[d.id], tag_names[d.id], buffers[d.id])
                stats[d.id]["rows"] += len(buffers[d.id])
                stats[d.id]["faults"] += 1
                buffers[d.id] = []
                fault_handled[d.id] = True
                pending_reset[d.id] = sim_t + repair

    # 末循環(未故障)以 censored 寫出
    for d in world.devices.values():
        for r in buffers[d.id]:
            r["ttf_sim_s"] = ""
            r["fail_within_24h"] = ""
        _flush(writers[d.id], tag_names[d.id], buffers[d.id])
        stats[d.id]["rows"] += len(buffers[d.id])
        files[d.id].close()

    manifest = {
        "synthetic": True,
        "scenario": args.scenario,
        "sim_days": args.sim_days, "step_min": args.step_min,
        "devices": stats,
        "columns_note": "gt_* / ttf_* / fail_within_24h 為 ground-truth 標籤;state/tags 為學生可見觀測值",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"資料集已輸出到 {out_dir}/(合成數據)")
    for did, s in stats.items():
        print(f"  {did:10} rows={s['rows']:>7}  faults={s['faults']}")


def _flush(writer, tags, rows):
    for r in rows:
        writer.writerow(
            [r["sim_t"], r["sim_h"], r["state"]]
            + [r["tags"].get(t, "") for t in tags]
            + [r["gt_health_min"], r["gt_rul_sim_s"], r["is_sensor_fault"],
               r["cycle_id"], r.get("ttf_sim_s", ""), r.get("fail_within_24h", "")]
        )


if __name__ == "__main__":
    main()
