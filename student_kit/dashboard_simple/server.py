# -*- coding: utf-8 -*-
"""學生自建監控台 · 純 Python 版(不用 Streamlit)。

只用標準庫 http.server 起一個小網站:
  - 瀏覽器負責畫面(index.html + 原生 JS,無框架)。
  - 這支 Python 伺服器負責「講工業協定」——瀏覽器不能直接說 Modbus/OPC-UA/MQTT,
    所以由本伺服器用 client.py 連設備讀值,再以 JSON 回給前端。

執行:
    pip install -r requirements.txt
    python server.py                 # 預設 http://localhost:8090
平台(資料來源)需先啟動(預設 http://localhost:8077)。

資料/運算全部重用同目錄 ../dashboard/client.py(與 Streamlit 版共用一份邏輯)。
"""
from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# 重用 Streamlit 版的純資料層(client.py):三協定 reader + 統計 / 分析 / 繳交
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "dashboard"))
import client as C  # noqa: E402

PORT = int(os.getenv("DASH_PORT", "8090"))
INDEX = os.path.join(HERE, "index.html")

# MQTT 連線較貴(建連 + 等 CONNACK):每台主機常駐一個訂閱者訂 park/#,快取整園區最近狀態,
# 之後即時讀直接取快取(~即時)。第一次某主機才建連。
_MQTT_WATCHERS: dict = {}


def _mqtt_live(host: str, port: int, conn: dict) -> dict:
    key = (host, port)
    r = _MQTT_WATCHERS.get(key)
    if r is None:
        r = C.MqttReader(host, port)
        r.start_watch("park/#")
        _MQTT_WATCHERS[key] = r
    vals = r.latest_device(conn)
    if not vals:  # 剛建連、該設備快取還沒到:退回一次阻塞讀
        vals = r.read_device(conn)
    return vals


def _device_protocols(dev: dict) -> list:
    """這台設備目錄裡實際公布了哪些協定(未來可能不是每台都三種全上,見 docs/ROADMAP 未來想法)。"""
    conn = dev.get("connection", {}) or {}
    out = []
    if (conn.get("modbus") or {}).get("unit_id") is not None:
        out.append("modbus")
    if (conn.get("opcua") or {}).get("endpoint"):
        out.append("opcua")
    if (conn.get("mqtt") or {}).get("topic"):
        out.append("mqtt")
    return out or ["modbus"]


def _analyze(api: str, device: str, q: dict) -> dict:
    """④ 分析:相關 r / 趨勢斜率 / 越界計數 / 時段平均。"""
    kind = q.get("kind", ["corr"])[0]
    if kind == "corr":
        _, ya = C.get_history(api, device, q["a"][0], 5000)
        _, yb = C.get_history(api, device, q["b"][0], 5000)
        r = C.pearson(ya, yb)
        n = min(len(ya), len(yb))
        return {"kind": "corr", "r": r, "n": n,
                "a": ya[:n][:400], "b": yb[:n][:400]}  # 抽樣點供前端畫散點
    if kind == "slope":
        xs, ys = C.get_history(api, device, q["tag"][0], 5000)
        return {"kind": "slope", "slope": C.slope_per_hour(xs, ys), "n": len(ys)}
    if kind == "count":
        _, ys = C.get_history(api, device, q["tag"][0], 8000)
        thr = float(q.get("threshold", ["0"])[0])
        return {"kind": "count", "count": C.count_over(ys, thr), "threshold": thr, "n": len(ys)}
    if kind == "hod":
        xs, ys = C.get_history(api, device, q["tag"][0], 8000)
        hr = int(q.get("hour", ["14"])[0])
        return {"kind": "hod", "hour": hr, "mean": C.hour_of_day_mean(xs, ys, hr)}
    return {"error": f"未知分析類型 {kind}"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_a):  # 靜音:不要每個 request 都印一行
        pass

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json; charset=utf-8")

    # 所有資料端點統一走這裡:出錯回 JSON,前端好顯示
    def _dispatch(self, path: str, q: dict, body: dict | None):
        api = (q.get("api") or [os.getenv("PLATFORM_API", "http://localhost:8077")])[0]
        host = (q.get("host") or ["localhost"])[0]
        device = (q.get("device") or [None])[0]

        if path == "/data/catalog":
            cat = C.get_catalog(api)
            return {"devices": [{"id": d["id"], "kind": d.get("kind"), "name": d.get("name"),
                                 "tags": [t["name"] for t in d.get("tags", [])],
                                 "protocols": _device_protocols(d)}
                                for d in cat.get("devices", [])],
                    "protocol_mode": cat.get("protocol_mode"), "synthetic": cat.get("synthetic")}

        if path == "/data/live":
            proto = (q.get("proto") or ["modbus"])[0]
            cat = C.get_catalog(api)
            conn = C.device_conn(cat, device)
            if not conn:
                return {"error": f"找不到設備 {device}"}
            if proto == "mqtt":  # 走常駐訂閱快取(快);其餘協定每次建連即讀
                vals = _mqtt_live(host, int((conn["mqtt"].get("port") or 1883)), conn)
            else:
                vals = C.read_live(conn, proto, host)
            try:
                info = C.api_get(api, f"/api/devices/{device}")
                state = info.get("state")
            except Exception:
                state = None
            units = {n: s["unit"] for n, s in conn["tags"].items()}
            return {"proto": proto, "state": state, "values": vals, "units": units,
                    "conn": {"modbus_port": conn["port"], "unit_id": conn["unit_id"],
                             "opcua": conn["opcua"], "mqtt": conn["mqtt"]}}

        if path == "/data/history":
            tag = q["tag"][0]
            lim = int((q.get("limit") or ["2000"])[0])
            xs, ys = C.get_history(api, device, tag, lim)
            return {"tag": tag, "x": xs, "y": ys, "n": len(ys)}

        if path == "/data/stats":
            _, ys = C.get_history(api, device, q["tag"][0], 5000)
            return {"tag": q["tag"][0], "stats": C.describe(ys), "y": ys}

        if path == "/data/analyze":
            return _analyze(api, device, q)

        if path == "/data/submit":
            token = None
            student, pw = body.get("student"), body.get("password")
            if pw:
                token = C.login(api, student, pw)
            payload = {k: v for k, v in body.items() if k != "password"}
            return C.submit(api, payload, token)

        return {"error": f"未知端點 {path}"}

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            with open(INDEX, "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if u.path == "/favicon.ico":
            return self._send(204, b"", "image/x-icon")
        if u.path.startswith("/data/"):
            try:
                return self._json(self._dispatch(u.path, parse_qs(u.query), None))
            except Exception as e:  # 任何協定 / 網路錯誤都回 JSON,前端顯示紅字
                return self._json({"error": f"{type(e).__name__}: {e}"}, 200)
        return self._send(404, b"not found", "text/plain")

    def do_POST(self):
        u = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except Exception:
            body = {}
        if u.path.startswith("/data/"):
            try:
                return self._json(self._dispatch(u.path, parse_qs(u.query), body))
            except Exception as e:
                return self._json({"error": f"{type(e).__name__}: {e}"}, 200)
        return self._send(404, b"not found", "text/plain")


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[dashboard] 學生監控台(純 Python)啟動於 http://localhost:{PORT}")
    print(f"[dashboard] 資料來源平台預設 {os.getenv('PLATFORM_API', 'http://localhost:8077')};"
          f"可在頁面側欄改。Ctrl-C 結束。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n[dashboard] 已關閉。")
        srv.shutdown()


if __name__ == "__main__":
    main()
