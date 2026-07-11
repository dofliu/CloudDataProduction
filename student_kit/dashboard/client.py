# -*- coding: utf-8 -*-
"""學生自建客戶端 · 資料層(可獨立測試,app.py 的 UI 呼叫這裡)。

這支示範「一個學生該怎麼做」:
  - 用 Modbus 直連設備讀即時值(工業協定接取)。
  - 用平台 REST /api/history 撈歷史做統計 / 分析。
  - 用 /api/submissions 繳交作業,拿自動批改分數。

刻意把「資料/運算」與「畫面」分離:這支純函式好測、好重用;app.py 只管畫。
"""
from __future__ import annotations

import statistics as _st
from typing import Dict, List, Optional, Tuple

import requests
from pymodbus.client import ModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadDecoder


# ── 平台 REST(公開讀 + 繳交)──────────────────────────────
def api_get(base: str, path: str, params: dict | None = None, token: str | None = None) -> dict:
    h = {"Authorization": f"Bearer {token}"} if token else {}
    r = requests.get(base.rstrip("/") + path, params=params or {}, headers=h, timeout=8)
    r.raise_for_status()
    return r.json()


def api_post(base: str, path: str, body: dict, token: str | None = None) -> dict:
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    r = requests.post(base.rstrip("/") + path, json=body, headers=h, timeout=8)
    if r.status_code >= 400:
        raise RuntimeError(f"{path} → {r.status_code}: {r.text[:200]}")
    return r.json()


def login(base: str, username: str, password: str) -> Optional[str]:
    """登入取 session token(登入非必需;讀取 / 繳交作業都公開,登入只為認領 / 寫設定點)。"""
    try:
        return api_post(base, "/api/auth/login", {"username": username, "password": password}).get("token")
    except Exception:
        return None


def get_catalog(base: str) -> dict:
    return api_get(base, "/api/catalog")


def get_park(base: str) -> dict:
    return api_get(base, "/api/park")


def device_conn(catalog: dict, device_id: str) -> Optional[dict]:
    """從設備目錄取出這台的連線資訊:Modbus 埠 / unit_id、以及每個 tag 的 register / 型別 / 單位。"""
    dev = next((d for d in catalog.get("devices", []) if d.get("id") == device_id), None)
    if dev is None:
        return None
    mb = (dev.get("connection", {}) or {}).get("modbus", {}) or {}
    tags = {t["name"]: {"register": t["modbus_register"], "datatype": t["datatype"], "unit": t.get("unit", "")}
            for t in dev.get("tags", [])}
    return {"port": mb.get("port", 6020), "unit_id": mb.get("unit_id", 1), "tags": tags}


# ── Modbus 即時讀(工業協定)──────────────────────────────
class ModbusReader:
    """薄封裝:連上後可反覆讀某台設備各 tag 的即時值(float32/int16/int32,big-endian)。"""

    def __init__(self, host: str, port: int):
        self.cli = ModbusTcpClient(host, port=port)
        self.cli.connect()

    def close(self):
        self.cli.close()

    def read(self, unit: int, register: int, datatype: str) -> Optional[float]:
        width = 1 if datatype == "int16" else 2
        rr = self.cli.read_holding_registers(address=register, count=width, slave=unit)
        if rr.isError():
            return None
        dec = BinaryPayloadDecoder.fromRegisters(rr.registers, byteorder=Endian.BIG, wordorder=Endian.BIG)
        if datatype == "int16":
            return dec.decode_16bit_int()
        if datatype == "int32":
            return dec.decode_32bit_int()
        return dec.decode_32bit_float()

    def read_device(self, conn: dict) -> Dict[str, Optional[float]]:
        """一次讀完該設備所有 tag。conn 來自 device_conn()。"""
        out = {}
        for name, spec in conn["tags"].items():
            out[name] = self.read(conn["unit_id"], spec["register"], spec["datatype"])
        return out


# ── 歷史 + 統計 + 分析(對應各週作業)──────────────────────
def get_history(base: str, device: str, tag: str, limit: int = 3000) -> Tuple[List[float], List[float]]:
    """回傳 (sim_hours, values):sim 小時軸與觀測值,供畫趨勢 / 算統計。"""
    r = api_get(base, "/api/history", {"device": device, "tag": tag, "limit": limit})
    pts = r.get("points", [])
    xs = [p["sim_t"] / 3600.0 for p in pts if p.get("value") is not None]
    ys = [p["value"] for p in pts if p.get("value") is not None]
    return xs, ys


def describe(values: List[float]) -> Dict[str, float]:
    """敘述統計(對應 stats 作業的六個統計量)。"""
    if not values:
        return {}
    s = sorted(values)
    def pct(p):
        k = (len(s) - 1) * p
        lo = int(k); hi = min(lo + 1, len(s) - 1)
        return s[lo] + (s[hi] - s[lo]) * (k - lo)
    return {
        "n": len(values),
        "mean": _st.mean(values), "std": _st.pstdev(values),
        "min": min(values), "max": max(values),
        "median": _st.median(values), "p95": pct(0.95),
    }


def pearson(a: List[float], b: List[float]) -> Optional[float]:
    """皮爾森相關(對應 correlation 作業)。取兩序列前 n 個對齊。"""
    n = min(len(a), len(b))
    if n < 2:
        return None
    a, b = a[:n], b[:n]
    ma, mb = _st.mean(a), _st.mean(b)
    va = sum((x - ma) ** 2 for x in a); vb = sum((y - mb) ** 2 for y in b)
    if va <= 0 or vb <= 0:
        return None
    return sum((a[i] - ma) * (b[i] - mb) for i in range(n)) / (va ** 0.5 * vb ** 0.5)


def slope_per_hour(hours: List[float], values: List[float]) -> Optional[float]:
    """線性趨勢斜率 dy/dx(每小時變化量,對應 slope 作業)。"""
    n = min(len(hours), len(values))
    if n < 2:
        return None
    x, y = hours[:n], values[:n]
    mx, my = _st.mean(x), _st.mean(y)
    vx = sum((xi - mx) ** 2 for xi in x)
    if vx <= 0:
        return None
    return sum((x[i] - mx) * (y[i] - my) for i in range(n)) / vx


def count_over(values: List[float], threshold: float) -> int:
    """超過門檻的樣本數(對應 count_over 作業)。"""
    return sum(1 for v in values if v > threshold)


def hour_of_day_mean(hours: List[float], values: List[float], hour: int) -> Optional[float]:
    """某 hour-of-day 的平均(對應 aggregate 作業)。hours 為 sim 小時軸。"""
    picked = [values[i] for i in range(min(len(hours), len(values))) if int(hours[i] % 24) == hour]
    return _st.mean(picked) if picked else None


def submit(base: str, payload: dict, token: str | None = None) -> dict:
    """繳交作業並取回自動批改結果(對應第 5 點:完成指定作業)。"""
    return api_post(base, "/api/submissions", payload, token)
