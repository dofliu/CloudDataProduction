# -*- coding: utf-8 -*-
"""學生自建客戶端 · 資料層(可獨立測試,app.py 的 UI 呼叫這裡)。

這支示範「一個學生該怎麼做」:
  - 用 Modbus / OPC-UA / MQTT 三種工業協定讀同一台設備的即時值(接取)。
  - 用平台 REST /api/history 撈歷史做統計 / 分析。
  - 用 /api/submissions 繳交作業,拿自動批改分數。

刻意把「資料/運算」與「畫面」分離:這支純函式好測、好重用;UI(Streamlit 或
純 HTML 伺服器)只管畫。三種協定各封裝成一個 Reader,對外統一 read_device(conn)。
"""
from __future__ import annotations

import json as _json
import statistics as _st
import time as _time
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
    """從設備目錄取出這台的三協定連線資訊,以及每個 tag 的 register / 型別 / 單位。

    回傳:
      port / unit_id      —— Modbus(channel-mux 下共用埠、以 unit_id 分設備)
      opcua.endpoint      —— OPC-UA 端點,node_folder 為位址空間路徑 Objects/<folder>/<tag>
      mqtt.host/port/topic —— MQTT broker 與該設備 <topic_prefix>/state 主題
      tags                —— {name: {register, datatype, unit}}
    """
    dev = next((d for d in catalog.get("devices", []) if d.get("id") == device_id), None)
    if dev is None:
        return None
    conn = dev.get("connection", {}) or {}
    mb = conn.get("modbus", {}) or {}
    ua = conn.get("opcua", {}) or {}
    mq = conn.get("mqtt", {}) or {}
    tags = {t["name"]: {"register": t["modbus_register"], "datatype": t["datatype"], "unit": t.get("unit", "")}
            for t in dev.get("tags", [])}
    return {
        "port": mb.get("port", 6020), "unit_id": mb.get("unit_id", 1), "tags": tags,
        "opcua": {"endpoint": ua.get("endpoint"), "node_folder": ua.get("node_folder")},
        "mqtt": {"host": mq.get("host"), "port": mq.get("port"), "topic": mq.get("topic")},
    }


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


# ── OPC-UA 即時讀(工業協定)────────────────────────────────
_OPCUA_NS = "http://clouddata.dof"  # 平台 OPC-UA 命名空間 URI(見 adapters/opcua_server.py)


class OpcuaReader:
    """薄封裝:連 OPC-UA server,瀏覽 Objects/<node_folder>/<tag> 讀即時值。

    用 asyncua 的同步 client(asyncua.sync.Client),對學生最直覺:connect → read → close。
    """

    def __init__(self, endpoint: str):
        from asyncua.sync import Client  # 延遲載入:沒裝 asyncua 時仍可用 Modbus/MQTT
        self.cli = Client(endpoint)
        self.cli.connect()
        self.idx = self.cli.get_namespace_index(_OPCUA_NS)

    def close(self):
        try:
            self.cli.disconnect()
        except Exception:
            pass

    def read_device(self, conn: dict) -> Dict[str, Optional[float]]:
        """讀該設備所有 tag。node_folder 如 'c01/cnc-01',逐段 get_child 到 tag 節點。"""
        folder = (conn.get("opcua") or {}).get("node_folder")
        if not folder:
            return {}
        base = [f"{self.idx}:{part}" for part in folder.split("/")]
        objects = self.cli.nodes.objects
        out: Dict[str, Optional[float]] = {}
        for name in conn["tags"]:
            try:
                node = objects.get_child(base + [f"{self.idx}:{name}"])
                out[name] = node.read_value()
            except Exception:
                out[name] = None
        return out


# ── MQTT 即時讀(工業協定,pub/sub)──────────────────────────
class MqttReader:
    """薄封裝:連 MQTT broker,訂閱 <topic_prefix>/state,取最近一包 JSON 的 tag 值。

    MQTT 是發布/訂閱:平台每 ~0.5s 發一次整包狀態(未保留),所以 read_device 訂閱後
    等最多 timeout 秒收下一包即回傳。一個 reader 可反覆讀不同設備。
    """

    def __init__(self, host: str, port: int):
        import paho.mqtt.client as mqtt  # 延遲載入
        try:  # paho-mqtt 2.x 需指定 callback API 版本;1.x 沒有這參數
            self.cli = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
        except AttributeError:
            self.cli = mqtt.Client()
        self._latest: Dict[str, dict] = {}
        self._connected = False
        self.cli.on_connect = self._on_connect
        self.cli.on_message = self._on_message
        self.cli.connect(host, port, keepalive=30)
        self.cli.loop_start()

    def _on_connect(self, _cli, _userdata, _flags, _rc, *_a):
        self._connected = True

    def _on_message(self, _cli, _userdata, msg):
        try:
            self._latest[msg.topic] = _json.loads(msg.payload)
        except Exception:
            pass

    def read_device(self, conn: dict, timeout: float = 6.0) -> Dict[str, Optional[float]]:
        topic = (conn.get("mqtt") or {}).get("topic")
        if not topic:
            return {}
        deadline = _time.monotonic() + timeout
        # 先等 CONNACK 再訂閱:太早 subscribe 會在連線建立前遺失(paho 不保證重送)
        while not self._connected and _time.monotonic() < deadline:
            _time.sleep(0.02)
        self._latest.pop(topic, None)
        self.cli.subscribe(topic)
        while _time.monotonic() < deadline and topic not in self._latest:
            _time.sleep(0.05)
        data = self._latest.get(topic)
        if not data:
            return {}
        tags = data.get("tags") or {}
        return {name: tags.get(name) for name in conn["tags"]}

    def start_watch(self, wildcard: str = "park/#", wait: float = 6.0) -> "MqttReader":
        """常駐訂閱整個園區:之後 latest_device() 直接取快取,適合連續刷新(免每次重連)。

        單次讀用 read_device() 即可;要反覆快速讀(如每 2 秒更新畫面)才需要這個。
        """
        deadline = _time.monotonic() + wait
        while not self._connected and _time.monotonic() < deadline:
            _time.sleep(0.02)
        self.cli.subscribe(wildcard)
        return self

    def latest_device(self, conn: dict) -> Dict[str, Optional[float]]:
        """從常駐訂閱的快取取該設備最近一包(需先 start_watch();沒收到過回 {})。"""
        data = self._latest.get((conn.get("mqtt") or {}).get("topic"))
        if not data:
            return {}
        tags = data.get("tags") or {}
        return {name: tags.get(name) for name in conn["tags"]}

    def close(self):
        try:
            self.cli.loop_stop()
            self.cli.disconnect()
        except Exception:
            pass


# ── 統一即時讀:依協定挑 Reader,讀完即關 ─────────────────────
def read_live(conn: dict, protocol: str, host: str) -> Dict[str, Optional[float]]:
    """一次性讀該設備所有 tag。protocol ∈ {modbus, opcua, mqtt};host 為設備主機。

    每呼叫一次建 / 關一次連線 —— 對「按一下更新」的介面夠用且無狀態外洩,符合鐵則一。
    """
    proto = (protocol or "modbus").lower()
    if proto == "opcua":
        endpoint = (conn.get("opcua") or {}).get("endpoint")
        if not endpoint:
            return {}
        # 目錄裡 endpoint 的 host 可能是 <world-host> 佔位,換成實際 host
        endpoint = _host_swap(endpoint, host)
        r = OpcuaReader(endpoint)
        try:
            return r.read_device(conn)
        finally:
            r.close()
    if proto == "mqtt":
        mq = conn.get("mqtt") or {}
        r = MqttReader(host, int(mq.get("port") or 1883))
        try:
            return r.read_device(conn)
        finally:
            r.close()
    r = ModbusReader(host, conn["port"])
    try:
        return r.read_device(conn)
    finally:
        r.close()


def _host_swap(endpoint: str, host: str) -> str:
    """把 opc.tcp://<某 host>:port/path 的 host 換成實際要連的 host。"""
    try:
        head, rest = endpoint.split("://", 1)
        _oldhost, tail = rest.split(":", 1)
        return f"{head}://{host}:{tail}"
    except Exception:
        return endpoint


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
