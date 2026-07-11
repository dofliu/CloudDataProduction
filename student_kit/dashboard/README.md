# 學生自建監控台(範例作品)

一個「學生該交出什麼」的完整示範:自己寫的 client,連上設備讀資料、看即時值/趨勢/狀態、
做統計與分析、並把結果繳交給平台自動批改。老師可拿它當參考解答;學生可照這骨架長出自己的。

畫面(五個分頁)對應課程要求:

| 分頁 | 做什麼 | 對應課程 |
|---|---|---|
| ① 即時監控 | 用 **Modbus** 直連讀即時值 + 狀態 + 即時折線 | 接取 / 監控 |
| ② 趨勢 | 用 `/api/history` 撈歷史畫趨勢 | 儲存查詢 / 視覺化 |
| ③ 統計 | mean/std/min/max/median/p95 + 分佈 | 敘述統計 |
| ④ 分析 | 訊號相關 r、趨勢斜率、越界計數、時段平均 | 分析 |
| ⑤ 繳交作業 | 自動算值 → `POST /api/submissions` → 顯示分數 | 完成指定作業 |

## 本機測試步驟

1. **先啟動平台(伺服器)**——在 repo 根目錄:
   ```bash
   # .env 建議:MODBUS_ENABLED=true(即時監控要用)、DB_BACKEND=sqlite(歷史要用)
   python main.py            # 或 .\run-engine.ps1
   ```
   確認 http://localhost:8077/api/health 回 `ok:true`。

2. **裝這支客戶端的相依、跑起來**——在本資料夾:
   ```bash
   pip install -r requirements.txt
   streamlit run app.py
   ```
   瀏覽器會自動開(預設 http://localhost:8501)。

3. 側欄填:平台 API `http://localhost:8077`、設備主機 `localhost`、學號、(選填)密碼。
   選一台設備,就能在五個分頁操作。

## 說明

- **登入非必需**:讀資料、繳交作業都公開;登入(帳密)只有「認領公司 / 寫設定點」才需要。
- **資料誠信**:平台資料為合成(synthetic)、帶 ground-truth,繳交即自動比對計分。
- **架構**:`client.py` 是純資料/運算層(好測、可重用);`app.py` 只負責畫面。想換成
  Flask / Dash / 純 CLI,重用 `client.py` 即可。
