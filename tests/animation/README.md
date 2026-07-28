# 動畫 ↔ 模擬資料 一致性驗證

回答一個問題:**畫面上機台 / 工件的位置、動作、座標,是不是真的對應到模擬引擎產生的生產資料?**

不是靠肉眼看,也不是靠 mock。做法是:

```
engine.World.step()          真實模擬,錄下 telemetry
        ↓  frames_*.json
瀏覽器裡跑真正的 3D 元件      一格一格餵進去
        ↓  probe:* 探針
讀出 three.js 場景中機構的實際世界座標
        ↓  線性回歸
與引擎發出的 tag 值比對:斜率要等於契約寫的比例,R² 要 ≈ 1
```

線性回歸(而不是單點比對)是刻意的,它一次抓四種錯:

| 錯誤 | 表現 |
|------|------|
| 接錯 tag / tag 不存在 | R² 崩到接近 0 |
| 軸向對調(X 接到 Z) | 本項 R² 低,但交叉項 R²≈1 |
| 比例錯(mm↔單位換算) | slope 不等於契約值 |
| 符號反了 | slope 為負 |

## 怎麼跑

```bash
# 1) 從真實引擎錄兩份 telemetry(slow / fast)
python3 tests/animation/capture_frames.py web/preview

# 2) 起 dev server
cd web && npx vite &

# 3) 跑驗證(playwright 裝在 web/,腳本會自己指過去)
node tests/animation/verify_animation.mjs
```

失敗會以 exit code 1 結束,並列出每一項的 slope / R² / tag 變動範圍。

**CI**:`.github/workflows/verify.yml` 會自動跑這三套 ——
`verify_scenario.py`(純 Python,幾十秒)與前端 `tsc + build` 每次 push / PR 都跑;
瀏覽器那套(`shot3d.mjs` 的無 CDN 檢查 + `verify_animation.mjs` 的 27 項)較慢,
跑在 PR、手動觸發、以及 main 的 push。Chromium 路徑用 `PLAYWRIGHT_CHROMIUM`
環境變數指定,不設就交給 playwright 自己找。

## 為什麼要錄兩份

| 擷取 | multiplier | dt_sim / 幀 | 用途 |
|------|-----------|------------|------|
| `slow` | 1 | 0.25 s | 取樣遠高於機構循環頻率 → 畫面**必須逐幀精確追隨**遙測座標。座標正確性的斷言全在這份。 |
| `fast` | 120 | 120 s | 課堂實際設定。dt 遠大於循環週期,`pos_*` / `ram_position` 完全 aliasing,契約規定改走 L3 自由播放並在畫面標倍率;這份驗那個行為與純插值量(AGV 位置 / 朝向)。 |

兩份都先暖機到模擬日 **10:00** —— `two_shift` 設備(沖壓機等)只在 06:00–22:00 運轉,
從 00:00 開始錄會錄到一整段「正確地停著」的資料,量不到動作。

## 探針

場景裡 `name` 以 `probe:` 開頭的空 `Object3D`,零渲染成本,只為了讓測試讀得到世界座標:

| 探針 | 位置 | 對應的 tag |
|------|------|-----------|
| `probe:tool_tip` | CNC 刀尖 | `pos_x` / `pos_y` / `pos_z` |
| `probe:ram` | 沖壓機上模面 | `ram_position` |
| `probe:agv_body` / `probe:agv_nose` | AGV 車體中心 / 車頭 | `pos_x` / `pos_y` / `heading` |
| `probe:j2_pivot` / `probe:tcp` | 手臂 J1 後的樞紐 / 夾爪中心 | `joint_angle_1..6` |
| `probe:blade_edge` / `probe:rotor_mark` | 風機葉片前緣 / 轉子 | `pitch_angle` / `rotor_rpm` |
| `probe:belt_part0` | 輸送帶第 0 個工件 | `belt_speed` |

驗證載具是 `web/preview/verify.html`(+ `verify.tsx`),可以直接用瀏覽器開來手動翻幀:

```
http://localhost:5173/preview/verify.html?device=cnc_machining_center&capture=slow
```

載具透過各機種元件的 `debug` prop(`MachineProps.debug`)把探針回報器掛進 Canvas。
這個 prop 是**測試接縫**,正式畫面永遠不傳。

## 已知的物理限制(不是 bug)

- **沖壓機**:引擎的行程是 1 秒一次(60 spm),而 telemetry 是 1–4 Hz。取樣本身就在
  Nyquist 邊界甚至以下,`ram_position` 每次都落在同一組相位上。因此契約規定滑塊走
  L3 自由播放,測試驗的是「行程範圍完整(0~120 mm 對應 3.0 模型單位)+ 畫面有標倍率」,
  而不是逐幀對應。要逐幀對得上,得讓引擎以更高頻率發布 `ram_position`。
- **課堂設定(×120)下的週期性動作**:同理。畫面節拍是換算後的,**數值一律以點位為準**,
  而且畫面角落一定有「動畫慢放 ×N」的標示。見 [docs/animation_binding.md](../../docs/animation_binding.md) §1 鐵則三。
