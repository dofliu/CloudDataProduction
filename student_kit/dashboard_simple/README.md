# 學生自建監控台 · 純 Python 版(不用 Streamlit)

跟隔壁 `../dashboard`(Streamlit 版)做同一件事,但**只用標準庫 `http.server` + 瀏覽器原生 JS**——
不裝 Streamlit、不裝 pandas、無前端框架。適合想「看清楚每一層在做什麼」的學生,或部署環境精簡時。

## 為什麼要有一支 Python 伺服器?

瀏覽器**不能**直接講 Modbus / OPC-UA / MQTT(那是 TCP 原生協定)。所以:

```
瀏覽器 (index.html, 原生 JS)  ──HTTP/JSON──▶  server.py  ──工業協定──▶  平台設備
      畫面 / 圖表 / 互動                     用 client.py 讀值           (模擬引擎)
```

`server.py` 是薄薄一層:收到前端的 `/data/*` 請求 → 呼叫 `../dashboard/client.py`
(與 Streamlit 版**共用同一份資料/運算邏輯**)→ 回 JSON。畫面全在 `index.html`。

## 五個分頁(對應課程要求)

| 分頁 | 做什麼 |
|---|---|
| ① 即時監控 | **可切換 Modbus / OPC-UA / MQTT** 三種協定讀同一台設備的即時值 + 狀態 |
| ② 趨勢 | `/api/history` 撈歷史,自製 SVG 折線圖 |
| ③ 統計 | mean/std/min/max/median/p95 + 分佈直方圖 |
| ④ 分析 | 訊號相關 r(散點)、趨勢斜率、越界計數、時段平均 |
| ⑤ 繳交作業 | 自動算值 → `POST /api/submissions` → 顯示分數 |

**協定切換是重點**:同一台設備、同一個隱藏健康狀態,用三種工業協定讀應得到一致的值。
這讓學生實際體會「協定只是傳輸方式,資料源頭是同一個」。

## 本機測試步驟

1. **先啟動平台**(repo 根目錄)。三種協定都要開:
   ```bash
   # .env 建議:MODBUS_ENABLED / OPCUA_ENABLED / MQTT_ENABLED 皆 true、DB_BACKEND=sqlite
   # MQTT 用內嵌 broker,需先 pip install amqtt
   python main.py
   ```
   確認 http://localhost:8077/api/health 回 `ok:true`。

2. **裝相依、起這支伺服器**(本資料夾):
   ```bash
   pip install -r requirements.txt
   python server.py            # 預設 http://localhost:8090
   ```
   瀏覽器開 http://localhost:8090。側欄填平台 API、設備主機、學號,選一台設備即可操作。

## 說明

- **登入非必需**:讀資料、繳交作業都公開;登入(帳密)只有寫入類作業 / 認領才需要。
- **資料誠信**:平台資料為合成(synthetic)、帶 ground-truth,繳交即自動比對計分。
- **共用邏輯**:所有讀取 / 統計 / 分析都在 `../dashboard/client.py`;這支只是換個 UI 外殼。
  想再換成 CLI / 別的框架,一樣重用 `client.py` 即可。
