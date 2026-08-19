"""整合建廠自動上線(commissioning)—— A+B+C 一條龍。

教師指定設備組合(結構化,不必寫描述句)之後,這裡負責把「新工廠上線」的整套流程
自動走完,並產出可下載的交付文件:

  1. **配置**:白名單驗證 → 自動配 device id / duty / 預設退化(ai.factory_generator.compose_company)。
  2. **接線**:建得成產線就自動接 line:(依指定順序,引擎物料流即刻生效)。
  3. **上線**:world.add_company 熱載入 —— unit_id / OPC-UA folder / MQTT topic 自動配,
     三協定 adapter 動態掛上,免重啟(engine/world.py)。
  4. **點位表**:逐台列出全部點位(tag / setpoint / coil / DI / IR 的位址、FC、資料型別、
     單位、存取權)+ 三協定連線資訊,支援 JSON / CSV / Markdown 三種格式下載。
  5. **試連自測**:真的用 Modbus / OPC-UA / MQTT client 連回自己(loopback),
     逐台讀一個樣本值 —— 「上線」不是宣稱,是量出來的(api/diagnostics.py,scoped)。

本模組**不持有任何狀態**(鐵則一):config / 位址 / 帳全部問 world 現值。
點位表只含學生面資訊(位址 / 型別 / 單位),不含 ground-truth。
"""
from __future__ import annotations

import csv
import io
from typing import Optional

from engine.world import World


# ── 點位表(單一公司)──────────────────────────────────────
def points_doc(world: World, company_id: str, host: str) -> Optional[dict]:
    """回傳一間公司的完整點位表 + 連線資訊(JSON 結構)。公司不存在回 None。"""
    company = next((c for c in world.park.get("companies", []) or []
                    if c.get("id") == company_id), None)
    if company is None:
        return None
    devices = [d for d in world.devices.values() if d.company_id == company_id]
    cat = {e["id"]: e for e in world.catalog(host=host)["devices"]}
    entries = [cat[d.id] for d in devices if d.id in cat]
    return {
        "company": company_id,
        "name": company.get("name"),
        "product": company.get("product"),
        "line": company.get("line"),
        "protocol_mode": world.protocol_mode,
        "ports": world.ports,
        "host": host,
        "synthetic": True,       # 鐵則二:明確標示合成數據
        "devices": entries,
    }


def _point_rows(doc: dict) -> list[dict]:
    """點位表攤平成逐點列(CSV / Markdown 共用)。"""
    rows: list[dict] = []
    for dev in doc["devices"]:
        conn = dev.get("connection", {})
        mb = conn.get("modbus", {})
        ua = conn.get("opcua", {})
        mq = conn.get("mqtt", {})
        base = {"device": dev["id"], "template": dev["template"],
                "unit_id": mb.get("unit_id"),
                "opcua_folder": ua.get("node_folder"), "mqtt_topic": mq.get("topic")}
        for t in dev.get("tags", []):
            rows.append({**base, "point": t["name"], "object": "holding_register", "fc": "FC03",
                         "address": t["modbus_register"], "datatype": t["datatype"],
                         "unit": t.get("unit", ""), "access": "r",
                         "opcua_node": t.get("opcua_node", ""), "mqtt_field": t.get("mqtt_field", "")})
        for pnt in dev.get("setpoints", []) or []:
            rows.append({**base, "point": pnt["name"], "object": "setpoint(holding)", "fc": "FC03/FC06",
                         "address": pnt.get("register"),
                         "datatype": pnt.get("datatype", "int16"),
                         "unit": pnt.get("unit", ""), "access": "rw",
                         "opcua_node": pnt.get("opcua_node", ""), "mqtt_field": pnt.get("mqtt_field", "")})
        for pnt in dev.get("coils", []) or []:
            rows.append({**base, "point": pnt["name"], "object": "coil", "fc": "FC01/FC05",
                         "address": pnt.get("address"), "datatype": "bool",
                         "unit": "", "access": "r(學生)/w(教師)",
                         "opcua_node": pnt.get("opcua_node", ""), "mqtt_field": pnt.get("mqtt_field", "")})
        for pnt in dev.get("discrete_inputs", []) or []:
            rows.append({**base, "point": pnt["name"], "object": "discrete_input", "fc": "FC02",
                         "address": pnt.get("address"), "datatype": "bool",
                         "unit": "", "access": "r",
                         "opcua_node": pnt.get("opcua_node", ""), "mqtt_field": pnt.get("mqtt_field", "")})
        for pnt in dev.get("input_registers", []) or []:
            rows.append({**base, "point": pnt["name"], "object": "input_register", "fc": "FC04",
                         "address": pnt.get("address"), "datatype": pnt.get("datatype", "int16"),
                         "unit": pnt.get("unit", ""), "access": "r",
                         "opcua_node": pnt.get("opcua_node", ""), "mqtt_field": pnt.get("mqtt_field", "")})
    return rows


_CSV_FIELDS = ["device", "template", "point", "object", "fc", "address", "datatype",
               "unit", "access", "unit_id", "opcua_folder", "opcua_node", "mqtt_topic", "mqtt_field"]


def points_csv(doc: dict) -> str:
    """點位表 → CSV(utf-8-sig 讓 Excel 直接開不會亂碼)。"""
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=_CSV_FIELDS, extrasaction="ignore")
    w.writeheader()
    for r in _point_rows(doc):
        w.writerow(r)
    return "﻿" + buf.getvalue()


def points_markdown(doc: dict) -> str:
    """點位表 → Markdown 連線指引(新工廠的「交機文件」,可直接發給學生)。"""
    ports = doc["ports"]
    host = doc["host"]
    out = [
        f"# {doc['name']}({doc['company']})點位表與連線指引",
        "",
        f"> ⚠ 本平台所有數據皆為**合成(synthetic)**教學資料,非真實場域量測。",
        "",
        "## 連線資訊",
        "",
        f"- 協定模式:`{doc['protocol_mode']}`(三協定各共用一埠,以 unit_id / folder / topic 分設備)",
        f"- Modbus TCP:`{host}:{ports.get('modbus')}`(float32 佔 2 個 holding registers,big-endian)",
        f"- OPC-UA:`opc.tcp://{host}:{ports.get('opcua')}/clouddata/`",
        f"- MQTT:`{host}:{ports.get('mqtt')}`(整包 JSON;訂閱 `park/#` 收全部)",
    ]
    if doc.get("line"):
        out.append(f"- 產線物料流:{' → '.join(doc['line'])}(緩衝可讀 FC04 line_in/out_buffer)")
    out.append("")
    for dev in doc["devices"]:
        conn = dev.get("connection", {})
        mb, ua, mq = conn.get("modbus", {}), conn.get("opcua", {}), conn.get("mqtt", {})
        out += [
            f"## {dev['id']}(`{dev['template']}`)",
            "",
            f"- Modbus unit_id:`{mb.get('unit_id')}` · OPC-UA folder:`{ua.get('node_folder')}` · "
            f"MQTT topic:`{mq.get('topic')}`",
            "",
            "| 點位 | object | FC | 位址 | 型別 | 單位 | 存取 |",
            "|------|--------|----|------|------|------|------|",
        ]
        for r in _point_rows({**doc, "devices": [dev]}):
            out.append(f"| `{r['point']}` | {r['object']} | {r['fc']} | {r['address']} "
                       f"| {r['datatype']} | {r['unit']} | {r['access']} |")
        out.append("")
    return "\n".join(out)
