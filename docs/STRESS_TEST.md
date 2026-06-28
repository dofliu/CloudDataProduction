# 壓力測試 · Stress Test

> 工具:[tools/stress_test.py](../tools/stress_test.py)。模擬多名學生同時連線,量吞吐 / 延遲 / 穩定度,
> 並檢查壓力下世界迴圈是否被拖慢(以「有效 sim 倍率」判斷)。
> Tool: [tools/stress_test.py](../tools/stress_test.py) — simulates many concurrent students; measures
> throughput / latency / stability, and checks whether the simulation loop is slowed under load.

```powershell
.\.venv\Scripts\python.exe tools\stress_test.py --ws 80 --modbus 25 --rest 15 --secs 15
```

## 方法 · Method

三種負載同時打同一台 server(本機 Windows 11 / RTX 4080 開發機,純 Python in-memory)。
Three concurrent load types against one server (local Windows 11 dev machine, pure-Python in-memory).

- **WebSocket** `/ws/telemetry` 訂閱者 — 模擬開 2D 世界 / 儀表板。subscribers (2D world / dashboards).
- **Modbus TCP** 輪詢者 — 模擬學生自寫 client 連設備。pollers (students' own clients).
- **REST** 打 `/api/catalog`、`/api/oee`。REST hammering.
- **有效 sim 倍率 · effective sim multiplier** = 壓測期間 sim 時間推進 / wall 時間;接近設定倍率(100%)代表迴圈未被拖慢。
  ≈ configured multiplier (100%) means the world loop kept full speed under load.

## 結果 · Results(2026-06-28,本機實測)

| 負載 Load | 連線 Conn | 吞吐 Throughput | 延遲 p50 | 延遲 p95 | 錯誤 Err |
|-----------|-----------|------------------|----------|----------|----------|
| **情境 A** WS×80 + Modbus×25 + REST×15 | | | | | |
| WebSocket | 80/80 | 725 msg/s | 9.0 ms | 16 ms | 0 |
| Modbus TCP | 25/25 | 3028 read/s | 6.8 ms | 23 ms | 0 |
| REST | — | 496 req/s | 26 ms | 46 ms | 0 |
| **情境 B** WS×200 + Modbus×50 + REST×30 | | | | | |
| WebSocket | 200/200 | 1525 msg/s | 20 ms | 37 ms | 0 |
| Modbus TCP | 50/50 | 3953 read/s | 9 ms | 48 ms | 0 |
| REST | — | 323 req/s | 95 ms | 117 ms | 0 |

**Sim 時鐘 · Sim clock**:設定 600×,兩種情境下有效倍率均 ~600×(**100%**)——
世界迴圈在 280 並發連線下仍維持滿速。Effective multiplier ~600× (**100%**) in both — the world loop
held full speed even at 280 concurrent connections.

## 結論 · Conclusion

- **單機可穩定承載 200+ WS + 50 Modbus 並發、零錯誤、低延遲**;對一個班(數十人)裕度充足。
  A single machine sustains 200+ WS + 50 Modbus concurrently with **zero errors and low latency** —
  ample headroom for a class.
- **協定廣播未拖慢模擬迴圈**(sim 倍率維持 100%),驗證「狀態只在引擎、adapters 只是讀視圖」的解耦設計有效。
  Protocol broadcasting does **not** slow the simulation loop — validating the "state lives only in the
  engine; adapters are read-only views" decoupling.
- 情境 B 的 REST p50 上升(95 ms)主要來自壓測端 urllib 執行緒池排隊(client 端限制),非 server 瓶頸。
  The higher REST p50 in scenario B comes from the test client's blocking-urllib thread pool, not the server.

## 備註 · Notes

- 數據為本機開發機單跑;5090 主機(更強 CPU)上限更高。Numbers are from the dev machine; the 5090 host will scale higher.
- Historian 為 in-memory;接 TimescaleDB 後,大量歷史寫入的壓測另計。Historian is in-memory; DB-write load is separate.
