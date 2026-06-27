# 01 · 分層架構與部署

## 分層(由心到皮)

```
┌─────────────────────────────────────────────────────────────────┐
│ 9. 接入層   LAN / Cloudflare Tunnel(HTTP) / Tailscale(原生協定)  │
├─────────────────────────────────────────────────────────────────┤
│ 7. 學生面          8. 模型部署鉤(階段二閉環)                      │
│   設備目錄(規格書)   學生模型訂閱遙測→推回預測→世界翻「預測故障」狀態 │
│   任務/工單板                                                      │
│   計分排名                                                         │
├─────────────────────────────────────────────────────────────────┤
│ 6. 教師控制台   上帝視角:建/改設備、注入故障、看 ground-truth      │
│ 5. 2D 等距世界  俯瞰→公司→設備→tag,純狀態驅動                     │
│ 2. 參考客戶端   老師的標準答案儀表板                                │
├─────────────────────────────────────────────────────────────────┤
│ 4. 世界 API     REST(控制面) + WebSocket(即時面)                 │
│ 3. Historian    TimescaleDB,階段一→階段二的橋                     │
│ 2. 協定轉接層   Modbus / OPC-UA / MQTT,讀同一份引擎狀態            │
├─────────────────────────────────────────────────────────────────┤
│ 1. 模擬引擎 ★   隱藏健康狀態 + 退化 + 相關訊號 + 時間加速 + 故障注入 │
│                 唯一持有狀態者。不知協定、不知畫面。                 │
└─────────────────────────────────────────────────────────────────┘
```

## 資料流

**寫入方向(引擎 → 外界)**
```
sim_clock tick(預設 10 Hz)
  → engine.world.step():推進每台設備的 health 與 signals
  → 更新共享狀態(in-memory snapshot)
  → 三條並行讀取:
       ① adapters 把 snapshot 映射到 Modbus register / OPC-UA node / MQTT payload
       ② WebSocket /ws/telemetry 廣播給 2D 世界與儀表板
       ③ historian.writer 批次寫入 TimescaleDB
```

**控制方向(外界 → 引擎)**
```
教師控制台 / MCP / web 表單
  → REST 控制面(POST /api/faults、/api/factory、/api/sim/clock …)
  → 改變引擎狀態(注入退化、建設備、調時間倍率)
```

**閉環方向(階段二)**
```
學生模型 ──訂閱──> MQTT / WebSocket 遙測
學生模型 ──POST──> /api/predictions(device, predicted_fault, eta, confidence)
  → scoring 用 ground-truth 比對「預測時間 vs 實際故障時間」→ 算 lead time
  → 該設備在 2D 世界翻成「預測故障(橘)」狀態
```

## 兩種落地,同一份程式碼

部署位置做成設定開關,Docker Compose 不變:

- **校內電腦教室(課堂用)**:5090 跑一份,全班連內網。延遲低、不受外網干擾。
  學生抓 IP、設 port —— 對應最真實的工廠心智模型。
- **校外隨時用**:同一份服務透過下面的接入層對外。

## 接入層:解決「5090 無公開 IP / 無網址」

關鍵是把流量分兩種,各走各的隧道:

| 流量類型 | 內容 | 通道 | 學生端 |
|----------|------|------|--------|
| HTTP/HTTPS | 2D 世界、儀表板、設備目錄、任務板、REST API | **Cloudflare Tunnel** | 只要瀏覽器,零安裝 |
| 原生 TCP | Modbus 502 / OPC-UA 4840 / MQTT 1883 | **Tailscale / ZeroTier mesh** | 裝 client 加入 tailnet,拿到穩定位址 |

> 為什麼不能全走 PaaS:工業協定是裸 TCP 不是 HTTP,多數 PaaS 只開 HTTP 埠。
> 自架 5090 + 上述隧道,協定完全自由 —— 這正是自架的最大好處。

校內 demo 直接走 LAN,完全不經隧道,最穩。

## 5090 的角色:一機三用

- **世界伺服器**:引擎 + API + adapters + web(GPU 對模擬器是綽綽有餘)。
- **Historian**:TimescaleDB 常駐,存所有歷史供階段二撈。
- **推論盒**:GPU 拿來跑階段二學生模型推論、甚至本機 LLM 做自然語言建廠與
  故障診斷 RAG 助手(可接既有 wind-turbine MCP / TAG-Wind 知識庫)。

## 連接埠策略(同時是教學點)

- **channel-mux(預設)**:一個 Modbus server 用 `unit_id` 分設備、一個 OPC-UA server
  用位址空間資料夾分設備、一個 MQTT broker 用 topic 分設備。**只開 3 個埠**,
  防火牆乾淨,也是真實工廠常見作法。
- **多埠模式(進階教學選項)**:每台設備獨立 port,預先開一段範圍(如 5000–5100),
  讓學生對比兩種定址思維。

## 安全提醒

對外開放時把 Tailscale ACL / Cloudflare Access 限制成校內帳號或學生群組;
別在公網裸開 502/4840/1883(會被掃描機器人亂連,雖無實害但干擾 demo)。
教師面 API(故障注入、ground-truth、建廠)一律需要 teacher token。
