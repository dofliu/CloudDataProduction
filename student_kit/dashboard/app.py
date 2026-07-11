# -*- coding: utf-8 -*-
"""學生自建監控/分析介面(Streamlit)。

一個學生可能長這樣的作品:連上設備 → 看即時值/趨勢/狀態 → 統計 → 分析 → 繳交作業。
執行:  pip install -r requirements.txt  然後  streamlit run app.py
(平台需先在同機或可達位址啟動;預設 API http://localhost:8077、Modbus 埠見設備目錄。)
"""
import time

import pandas as pd
import streamlit as st

import client as C

st.set_page_config(page_title="我的設備監控台", page_icon="🛠️", layout="wide")
st.title("🛠️ 我的設備監控與分析台")
st.caption("雲端生產數據導論 · 學生自建客戶端(連 Modbus 讀即時值、REST 撈歷史做分析、繳交作業)")

# ── 側欄:連線設定 ─────────────────────────────────────────
sb = st.sidebar
sb.header("連線設定")
api = sb.text_input("平台 API", "http://localhost:8077")
host = sb.text_input("設備主機(Modbus)", "localhost")
student = sb.text_input("我的學號", "s001")
pw = sb.text_input("密碼(選填,登入才需要)", "", type="password")
if "token" not in st.session_state:
    st.session_state.token = None
if sb.button("登入 / 重新整理"):
    st.session_state.token = C.login(api, student, pw) if pw else None
    st.cache_data.clear()

@st.cache_data(ttl=30)
def load_catalog(api_):
    return C.get_catalog(api_)

try:
    catalog = load_catalog(api)
except Exception as e:
    st.error(f"連不到平台 API({api}):{e}\n請確認平台已啟動、位址正確。")
    st.stop()

devices = [d["id"] for d in catalog.get("devices", [])]
device = sb.selectbox("選擇設備", devices, index=0 if devices else None)
conn = C.device_conn(catalog, device) if device else None
if conn:
    sb.caption(f"Modbus 埠 {conn['port']} · unit_id {conn['unit_id']} · {len(conn['tags'])} 個 tag")
tag_names = list(conn["tags"].keys()) if conn else []

tab_live, tab_trend, tab_stat, tab_ana, tab_submit = st.tabs(
    ["① 即時監控", "② 趨勢", "③ 統計", "④ 分析", "⑤ 繳交作業"])

# ── ① 即時監控:Modbus 讀 + 狀態 + 即時折線 ─────────────────
with tab_live:
    st.subheader(f"即時監控 · {device}")
    c_proto, c_auto = st.columns([2, 1])
    proto = c_proto.radio("讀取協定", ["modbus", "opcua", "mqtt"], horizontal=True,
                          format_func=lambda p: {"modbus": "Modbus", "opcua": "OPC-UA", "mqtt": "MQTT"}[p])
    auto = c_auto.checkbox("自動更新(每 2 秒)")
    try:
        info = C.api_get(api, f"/api/devices/{device}")
        state = info.get("state", "—")
    except Exception:
        state = "—"
    color = {"running": "🟢", "moving": "🟢", "idle": "⚪", "fault": "🔴"}.get(state, "🟡")
    st.markdown(f"### 狀態:{color} `{state}`")

    if conn:
        vals = C.read_live(conn, proto, host)  # 同一台設備、三種協定讀出的值應一致
        # 即時數值卡
        keys = [k for k in ("vibration_rms", "spindle_temp", "spindle_current", "motor_current",
                            "particle_count", "active_power") if k in vals]
        keys = (keys + [k for k in vals if k not in keys])[:6]
        cols = st.columns(len(keys) or 1)
        for c, k in zip(cols, keys):
            v = vals.get(k)
            c.metric(f"{k} ({conn['tags'][k]['unit']})", f"{v:.2f}" if isinstance(v, float) else v)
        # 即時折線緩衝(存在 session)
        buf = st.session_state.setdefault("buf", {})
        row = {k: vals.get(k) for k in keys}
        row["t"] = time.strftime("%H:%M:%S")
        seq = buf.setdefault(device, [])
        seq.append(row); del seq[:-120]
        df = pd.DataFrame(seq).set_index("t")
        st.line_chart(df, height=260)
        st.caption(f"這是你的 client 透過 {proto.upper()} 即時讀到的值;三種協定讀同一隱藏狀態,值應一致。")
    if auto:
        time.sleep(2)
        st.rerun()

# ── ② 趨勢:REST 歷史折線 ──────────────────────────────────
with tab_trend:
    st.subheader("歷史趨勢")
    c1, c2 = st.columns(2)
    tg = c1.selectbox("tag", tag_names, key="trend_tag")
    lim = c2.slider("取樣點數", 200, 8000, 2000, step=200)
    if tg and st.button("撈歷史畫趨勢"):
        xs, ys = C.get_history(api, device, tg, lim)
        if len(ys) < 2:
            st.warning("歷史資料不足;讓平台多跑一會兒,或換個 tag。")
        else:
            st.line_chart(pd.DataFrame({"sim_h": xs, tg: ys}).set_index("sim_h"), height=320)
            st.caption(f"共 {len(ys)} 點 · 來自 GET /api/history(sim 小時軸)。")

# ── ③ 統計:六統計量 + 分佈 ────────────────────────────────
with tab_stat:
    st.subheader("敘述統計")
    tg = st.selectbox("tag", tag_names, key="stat_tag")
    if tg and st.button("計算統計"):
        xs, ys = C.get_history(api, device, tg, 5000)
        d = C.describe(ys)
        if not d:
            st.warning("資料不足。")
        else:
            cols = st.columns(6)
            for c, k in zip(cols, ["mean", "std", "min", "max", "median", "p95"]):
                c.metric(k, f"{d[k]:.3f}")
            st.caption(f"n={d['n']}")
            st.bar_chart(pd.Series(ys, name=tg).value_counts(bins=20).sort_index(), height=240)
            st.session_state["stat_cache"] = (tg, d)

# ── ④ 分析:相關 / 趨勢斜率 / 越界計數 / 時段平均 ────────────
with tab_ana:
    st.subheader("分析")
    mode = st.radio("分析類型", ["訊號相關", "趨勢斜率", "越界計數", "時段平均(hour-of-day)"], horizontal=True)
    if mode == "訊號相關":
        c1, c2 = st.columns(2)
        ta = c1.selectbox("tag A", tag_names, key="corr_a")
        tb = c2.selectbox("tag B", tag_names, index=min(1, len(tag_names) - 1), key="corr_b")
        if st.button("算相關 r"):
            _, ya = C.get_history(api, device, ta, 5000)
            _, yb = C.get_history(api, device, tb, 5000)
            r = C.pearson(ya, yb)
            st.metric(f"r({ta}, {tb})", f"{r:.3f}" if r is not None else "—")
            n = min(len(ya), len(yb))
            if n > 1:
                st.scatter_chart(pd.DataFrame({ta: ya[:n], tb: yb[:n]}), x=ta, y=tb, height=320)
    elif mode == "趨勢斜率":
        tg = st.selectbox("tag", tag_names, key="slope_tag")
        if st.button("擬合斜率"):
            xs, ys = C.get_history(api, device, tg, 5000)
            sl = C.slope_per_hour(xs, ys)
            st.metric(f"{tg} 斜率", f"{sl:.4f} /h" if sl is not None else "—")
            if len(ys) > 1:
                st.line_chart(pd.DataFrame({"sim_h": xs, tg: ys}).set_index("sim_h"), height=280)
    elif mode == "越界計數":
        tg = st.selectbox("tag", tag_names, key="cnt_tag")
        thr = st.number_input("門檻 >", value=6.0)
        if st.button("計數"):
            _, ys = C.get_history(api, device, tg, 8000)
            n = C.count_over(ys, thr)
            st.metric(f"{tg} > {thr} 的樣本數", n)
            st.caption(f"共 {len(ys)} 點")
    else:
        tg = st.selectbox("tag", tag_names, key="hod_tag")
        hr = st.slider("小時 (0–23)", 0, 23, 14)
        if st.button("算時段平均"):
            xs, ys = C.get_history(api, device, tg, 8000)
            m = C.hour_of_day_mean(xs, ys, hr)
            st.metric(f"{tg} 第 {hr} 時平均", f"{m:.3f}" if m is not None else "—")

# ── ⑤ 繳交作業:自動算值 → POST → 顯示分數 ─────────────────
with tab_submit:
    st.subheader("繳交作業(自動批改)")
    week = st.text_input("週次", "4")
    typ = st.selectbox("作業型別", ["connect", "stats", "aggregate", "count_over", "correlation", "slope"])
    tg = st.selectbox("tag", tag_names, key="sub_tag") if typ != "connect" else st.selectbox("tag", tag_names, key="sub_tag2")
    payload = {"student": student, "type": typ, "device": device}
    if week:
        payload["week"] = int(week) if week.isdigit() else week

    computed = None
    if typ == "connect":
        if conn and st.button("讀即時值並帶入"):
            r = C.ModbusReader(host, conn["port"]); computed = r.read(conn["unit_id"], conn["tags"][tg]["register"], conn["tags"][tg]["datatype"]); r.close()
        payload["tag"] = tg
    elif typ == "stats":
        metric = st.selectbox("統計量", ["mean", "std", "min", "max", "median", "p95"])
        payload["tag"] = tg; payload["metric"] = metric
        if st.button("算統計並帶入"):
            _, ys = C.get_history(api, device, tg, 5000); computed = C.describe(ys).get(metric)
    elif typ == "aggregate":
        hr = st.slider("小時 (0–23)", 0, 23, 14, key="sub_hr")
        payload["tag"] = tg; payload["hour"] = hr
        if st.button("算時段平均並帶入"):
            xs, ys = C.get_history(api, device, tg, 8000); computed = C.hour_of_day_mean(xs, ys, hr)
    elif typ == "count_over":
        thr = st.number_input("門檻 >", value=6.0, key="sub_thr")
        payload["tag"] = tg; payload["threshold"] = thr
        if st.button("計數並帶入"):
            _, ys = C.get_history(api, device, tg, 8000); computed = C.count_over(ys, thr)
    elif typ == "correlation":
        tb = st.selectbox("tag B", tag_names, index=min(1, len(tag_names) - 1), key="sub_b")
        payload["tag_a"] = tg; payload["tag_b"] = tb
        if st.button("算相關並帶入"):
            _, ya = C.get_history(api, device, tg, 5000); _, yb = C.get_history(api, device, tb, 5000)
            computed = C.pearson(ya, yb)
    elif typ == "slope":
        payload["tag"] = tg
        if st.button("算斜率並帶入"):
            xs, ys = C.get_history(api, device, tg, 5000); computed = C.slope_per_hour(xs, ys)

    if computed is not None:
        st.session_state["computed"] = computed
    val = st.number_input("要繳交的值", value=float(st.session_state.get("computed", 0.0)), format="%.4f")
    payload["value"] = val

    if st.button("📤 送出繳交", type="primary"):
        try:
            res = C.submit(api, payload, st.session_state.token)
            (st.success if res.get("passed") else st.error)(f"分數 {res.get('score')} · {res.get('feedback')}")
        except Exception as e:
            st.error(f"繳交失敗:{e}")
    st.caption("送出即由平台對 ground-truth 自動批改;分數與回饋立即回來(對應課程第 5 點)。")
