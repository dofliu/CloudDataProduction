"""擷取真實引擎 telemetry,供前端動畫驗證使用(見 tests/animation/README.md)。

不是手寫的假資料 —— 這裡直接建一個含全部 11 種 template 的世界,用 `World.step()`
推進模擬時間,把每一拍的 `public_snapshot()` 原封不動存成 JSON。前端驗證再把這些
frame 一格一格餵進瀏覽器,讀出 three.js 場景中機構的**實際世界座標**回來比對。

會產生兩份擷取,對應契約(docs/animation_binding.md §1 鐵則三)的兩種情形:

  slow  multiplier=1、tick 4 Hz(dt_sim = 0.25 s)
        取樣遠高於各機構的循環頻率 → 畫面必須**逐幀精確追隨**遙測座標。
        座標正確性的斷言全部跑在這份上。

  fast  multiplier=120、tick 1 Hz(dt_sim = 120 s)—— 課堂實際設定
        dt 遠大於循環週期,pos_* / ram_position 完全 aliasing(每拍落在同一相位),
        契約規定此時走 L3 自由播放並在畫面標倍率。這份用來驗那個行為。

兩份都先暖機到模擬日的 10:00 —— `two_shift` 設備(沖壓機等)只在 06:00–22:00 運轉,
從 00:00 開始錄會錄到一整段「正確地停著」的資料,測不到動作。

用法:
    python3 tests/animation/capture_frames.py [輸出目錄]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from engine.world import World  # noqa: E402

TEMPLATES = [
    "cnc_machining_center", "robot_arm_6axis", "conveyor", "agv_mobile_robot",
    "air_compressor", "stamping_press", "injection_molding", "wind_turbine",
    "energy_meter", "semi_process_chamber", "heat_treat_furnace",
]

WARMUP_SIM_S = 10 * 3600.0      # 暖機到模擬日 10:00(兩班制設備已開工)

CAPTURES = [
    # name,   multiplier, tick_hz, frames
    ("slow",  1.0,        4.0,     160),   # 40 sim 秒,足夠涵蓋 CNC 45 s 循環的大半
    ("fast",  120.0,      1.0,     40),    # 課堂設定
]


def build_park(multiplier: float, tick_hz: float) -> dict:
    return {
        "name": "animation-verification",
        "sim": {"tick_hz": tick_hz, "time_multiplier": multiplier},
        "mes": {"enabled": False},
        "protocol_mode": "channel_mux",
        "companies": [{
            "id": "verify",
            "name": "動畫驗證廠",
            "industry": "mixed",
            # seed 固定 → 這份 frame 可重現
            "devices": [{"id": t, "template": t, "seed": 20260728 + i}
                        for i, t in enumerate(TEMPLATES)],
        }],
    }


def capture(name: str, multiplier: float, tick_hz: float, frames: int, out_dir: Path) -> Path:
    world = World(build_park(multiplier, tick_hz))
    dt_sim = multiplier / tick_hz

    # 暖機:用大步長快轉到 10:00,不記錄
    warm_steps = 200
    warm_dt = WARMUP_SIM_S / warm_steps
    for _ in range(warm_steps):
        world.clock.advance(warm_dt / max(1e-9, multiplier))
        world.step(warm_dt)

    recorded = []
    for _ in range(frames):
        world.clock.advance(1.0 / tick_hz)
        snap = world.step(dt_sim)
        recorded.append({
            "sim_t": snap["sim_t"],
            "multiplier": snap["multiplier"],
            "devices": snap["devices"],
        })

    payload = {
        "name": name,
        "source": "engine.World.step (real simulation, not mocked)",
        "templates": TEMPLATES,
        "time_multiplier": multiplier,
        "tick_hz": tick_hz,
        "dt_sim_per_frame": dt_sim,
        "warmup_sim_s": WARMUP_SIM_S,
        "frames": recorded,
    }
    out = out_dir / f"frames_{name}.json"
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    states = {d: recorded[0]["devices"][d]["state"] for d in TEMPLATES}
    running = [d for d, s in states.items() if s in ("running", "moving", "charging")]
    print(f"  {out.name}: frames={frames} dt_sim={dt_sim}s "
          f"sim_t {recorded[0]['sim_t']:.0f}→{recorded[-1]['sim_t']:.0f}s  running={len(running)}/{len(TEMPLATES)}")
    for d, s in states.items():
        if d not in running:
            print(f"      (idle) {d}: state={s}")
    return out


def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"capturing real engine telemetry → {out_dir}")
    for name, mult, hz, n in CAPTURES:
        capture(name, mult, hz, n, out_dir)


if __name__ == "__main__":
    main()
