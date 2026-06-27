"""P3 階段二範例:訂閱遙測 → 簡易趨勢判斷 → 在故障前 POST 預測。

這就是「把模型接回園區做即時推論」的最小骨架:一個訂閱遙測、推回預測的服務。
這裡用很笨的啟發式(振動越過門檻就預測故障)當示範;學生要做的是把它換成
自己用 Historian 歷史訓練出來的故障診斷 / RUL 模型。

命中(設備真的故障)就會在 2D 世界看到該設備翻橘、事件列出現 prediction_hit、
預測榜按 lead time 給分。

用法:python student_kit/p3_predictor.py --student S001 --threshold 5.0
"""
from __future__ import annotations

import argparse
import asyncio
import json
import urllib.request

import websockets


def post_prediction(api: str, body: dict) -> dict:
    req = urllib.request.Request(
        api + "/api/predictions", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--student", default="S001")
    ap.add_argument("--api", default="http://127.0.0.1:8077")
    ap.add_argument("--ws", default="ws://127.0.0.1:8077/ws/telemetry")
    ap.add_argument("--threshold", type=float, default=5.0, help="vibration_rms 觸發門檻 mm/s")
    args = ap.parse_args()

    predicted: set[str] = set()
    print(f"[{args.student}] 訂閱遙測,vibration_rms > {args.threshold} 就預測故障…")

    async with websockets.connect(args.ws) as ws:
        async for raw in ws:
            msg = json.loads(raw)
            for did, dev in msg["devices"].items():
                vib = dev["tags"].get("vibration_rms")
                if vib is None or did in predicted or dev["state"] == "fault":
                    continue
                if vib > args.threshold:
                    # 粗估:離門檻越遠信心越高;eta 隨便給(學生應由模型估)
                    conf = min(1.0, (vib - args.threshold) / 8.0 + 0.4)
                    try:
                        post_prediction(args.api, {
                            "device": did, "student": args.student,
                            "predicted_fault": "bearing_fault",
                            "eta_sim_s": 7200, "confidence": round(conf, 2),
                        })
                        predicted.add(did)
                        print(f"  🔮 預測 {did} 將故障(vib={vib:.1f}, conf={conf:.2f})")
                    except Exception as e:
                        print(f"  預測上傳失敗 {did}: {e}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
