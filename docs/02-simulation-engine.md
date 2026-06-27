# 02 · 模擬引擎(心臟)

整套系統的成敗在這裡。學生階段二要訓練得出故障診斷 / 預測性維護模型,
數據就不能是 sine 波加雜訊。核心設計:**每台設備有看不見的健康狀態,
可觀測訊號是健康狀態的函數且彼此相關,故障是退化走到終點的結果。**

---

## 1. 隱藏健康狀態與退化過程

每台設備有一個或多個**退化元件**(component),各自有看不見的健康度
`h_i(t) ∈ [0, 1]`(1 = 健康,0 = 失效)。健康度由累積損傷 `D_i` 反推:

```
h_i = clip(1 − D_i / D_fail_i, 0, 1)
```

損傷依運轉條件、應力、時間**單調累積**(離散積分,對 sim 時間):

```
D_i(t+Δt) = D_i(t) + r_i · s_i(operating_point) · (1 + σ_i·ξ) · Δt_sim
```

- `r_i`:基礎退化率(每台設備、每元件可不同)。
- `s_i(operating_point)`:應力倍率,由當下運轉點決定。
  例:`s = (load/load_nom)^a · (speed/speed_nom)^b`,負載 / 轉速越高退化越快。
- `ξ ~ N(0,1)` 或 Gamma:隨機性,讓每台設備壽命有分散(reliability 上常用 Gamma process)。
- `Δt_sim = Δt_wall · time_multiplier`:時間加速的關鍵(見第 5 節)。

### 退化軌跡(trajectory)

每個元件可選不同軌跡,讓學生看見多樣劣化型態:

| trajectory | 行為 | 對應現實 |
|------------|------|----------|
| `linear` | 固定率累積 | 刀具磨耗、皮帶磨損 |
| `exponential` | 率隨損傷加速(`r_eff = r·(1+k·D)`) | 軸承劣化、裂紋擴展 |
| `random_shock` | 偶發跳變疊加緩慢累積 | 撞擊、過載事件 |
| `wiener` | 帶漂移的隨機游走 | 一般隨機劣化 |
| `step_then_run` | 健康一段後驟降 | 潛伏缺陷觸發 |

### 失效判定

任一 `h_i ≤ failure_threshold_i` 即觸發故障,故障型態由 `failure_mode` 決定
(見第 3 節)。失效後設備進入 `fault` 狀態,等待學生 / 老師處置(reset / 維修)。

---

## 2. 訊號模型(健康 → 觀測)

學生抓得到的只有觀測訊號 `y_j`,它是健康狀態 + 運轉點 + 動態 + 雜訊的合成:

```
y_j(t) = baseline_j(operating_point)            # 正常運轉該有的值
       + Σ_i g_ji(h_i)                          # 各退化元件對此訊號的貢獻
       + dynamics_j(t)                          # 熱滯後等時間動態
       + noise_j                                # 量測雜訊
```

### 關鍵:訊號彼此相關

這是「可訓練」的核心。同一個運轉點 / 同一個健康狀態同時驅動多個訊號:

- `vibration_rms = base_vib(load,speed) + A·(1−h_bearing)^p + noise` — 軸承退化 → 振動上升
- `current = f(load, h)`:效率隨退化下降,同樣出力要更大電流 → 電流微升
- `output / efficiency = nominal · η(h)` — 退化 → 效率 / 良率下降
- `temperature`:對負載有**一階熱滯後**(下方),非瞬時

學生因此能學到「振動先漲、電流後跟、效率掉、最後跳故障」這種**多訊號早期徵兆**,
而不是看一個布林旗標翻轉。

### 熱滯後(一階慣性)

溫度不會瞬間到位,用一階低通逼近目標溫度:

```
T(t+Δt) = T(t) + (T_target(load) − T(t)) · (1 − exp(−Δt_sim / τ))
```

`τ` 為熱時間常數。退化也可推高 `T_target`(摩擦增加 → 發熱增加),形成另一條相關線索。

---

## 3. 故障分類學(fault taxonomy)

注入故障 / 退化越界後,設備可表現為下列型態。**能教學生分辨「設備壞了」與「感測器壞了」**
是這套系統最有價值的教學點之一。

### 設備本體故障

| 型態 | 行為 | 教學重點 |
|------|------|----------|
| `sudden` / catastrophic | `h` 驟降至 ~0,訊號突跳 | 突發故障偵測 |
| `gradual` | `h` 緩降,訊號緩漂(PdM 主目標) | 趨勢 / 預測性維護 |
| `intermittent` | 訊號間歇異常後恢復 | 難纏的偶發故障 |
| `cascading` | 一元件故障牽動相關訊號連鎖惡化 | 根因分析 |

### 感測器故障(套在 `y_j` 之上,與真實 `h` 脫鉤)

| 型態 | 行為 |
|------|------|
| `stuck` | 數值卡死在最後一筆 |
| `drift` | `y += β·t` 緩慢漂移 |
| `bias` | `y += c` 固定偏移 |
| `noise_burst` | 雜訊變異數暴增 |
| `dropout` | 間歇遺失(NaN / 保持前值 + 缺洞) |

> 教學設計:同時注入「軸承漸進退化(設備故障)」與「溫度感測漂移(感測器故障)」,
> 讓學生判斷哪個訊號可信、故障根因在設備還是量測鏈。

實作上感測器故障是 `engine/sensor_faults.py` 的**後處理層**,套在真實訊號輸出之後,
完全不動 `h`,所以 ground-truth 仍然乾淨。

---

## 4. Ground-truth 標籤(自動評分與訓練的根基)

因為數據是引擎生成的,下列標籤天生存在,**只給老師面 / 評分用,學生面不可見**:

- `health_i`:每元件當下真實健康度。
- `RUL`(剩餘壽命):依當前損傷與退化率前推到失效門檻所需的 sim 時間。

  ```
  RUL_i = (D_fail_i − D_i) / (r_i · s_i · time_multiplier)   # 換算成 sim 秒
  RUL = min_i RUL_i
  ```

- `fault_type` / `fault_onset_time`:故障型態與真正起始時刻(算 lead time 用)。
- `is_sensor_fault`:此異常是否來自感測器而非設備。

> 學術誠信:這些是**明確標示的合成標籤**,用於教學與訓練完全正當;
> 系統任何輸出都標注「synthetic / simulated」,絕不宣稱為真實場域數據。

---

## 5. 時間加速(沒有它,run-to-failure 無法在課堂演示)

全域 `sim_clock`(`engine/clock.py`)持有 `time_multiplier`:

- `1×`:即時。`60×`:一分鐘走一小時。`3600×`:一秒走一小時。
- 所有退化積分、計時、RUL 都對 **sim 時間**計算,不對 wall clock。
- 老師可即時調倍率、暫停 / 續跑(`POST /api/sim/clock`)。

典型用法:平時 `60×` 讓設備數小時內自然劣化;要演示某次 run-to-failure 時切 `3600×`,
一節課內看完「健康 → 徵兆 → 故障 → 處置」完整週期。

---

## 6. Device 物件模型

```python
# engine/device.py(概念,非最終碼)
class DegradationComponent:
    name: str                 # "spindle_bearing"
    rate: float               # r_i
    trajectory: str           # linear / exponential / wiener / random_shock / step_then_run
    sigma: float              # 隨機強度
    D: float = 0.0            # 累積損傷
    D_fail: float = 1.0
    failure_threshold: float = 0.0
    @property
    def health(self) -> float: ...
    def step(self, dt_sim, operating_point): ...

class Tag:
    name: str; unit: str; datatype: str
    modbus_register: int; opcua_node: str; mqtt_field: str
    driver: Callable          # 由 signals.py 組出:health+運轉點+動態+雜訊 → 值

class Device:
    id: str; template: str; state: str   # idle/running/fault/maintenance...
    components: list[DegradationComponent]
    tags: list[Tag]
    duty_cycle: DutyProfile               # 班表 / 負載輪廓,驅動 operating_point
    def step(self, dt_sim):
        op = self.duty_cycle.operating_point(sim_now())
        for c in self.components: c.step(dt_sim, op)
        for t in self.tags: t.value = t.driver(op, self.components, dt_sim)
        self._update_state()              # 越界 → fault
```

`engine/world.py` 持有所有 Device、每個 tick 呼叫 `device.step()`、產生 snapshot 廣播。

---

## 7. 給後續開發者的提醒

- 退化參數要讓「自然壽命」落在合理 sim 時數(配合時間倍率,課堂內可達);別調到幾秒就壞。
- 同型設備之間用 `sigma` 與初始 `init_health` 製造個體差異 —— 學生模型才需要泛化,而非背一條曲線。
- baseline 與 `g_ji` 的物理量級要對(振動 mm/s、溫度 °C、電流 A),學生畫出來才像真的。
- duty cycle(兩班 / 三班 / 連續)會讓數據有日週期,對時序模型是好訊號,務必做。
