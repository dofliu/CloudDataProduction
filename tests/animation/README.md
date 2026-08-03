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
瀏覽器那套(`shot3d.mjs` 的無 CDN 檢查 + `verify_animation.mjs` 的 38 項)較慢,
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
| `probe:j2_pivot` / `probe:tcp` | 手臂 J1 後的樞紐 / 夾爪中心 | `joint_angle_1..6`、`tcp_x/y/z` |
| `probe:blade_edge` / `probe:rotor_mark` | 風機葉片前緣 / 轉子 | `pitch_angle` / `rotor_rpm` |
| `probe:belt_part0` | 輸送帶第 0 個工件 | `belt_speed` |
| `probe:beacon_red` / `_amber` / `_green` | 三色柱燈(**材質**探針,回報 `emissiveIntensity`) | `state`、`coils.run_enable` |

材質探針是另一類:柱燈這種「會動的不是位置而是亮度」的元素,材質不在場景圖的走訪範圍內,
所以 `ProbeReporter` 額外從 Mesh 的 material 反查名稱。載具另有 `__forceState(v)` 接縫 ——
錄製窗內不一定有設備進入 fault,但柱燈語意必須驗得到那一格。

驗證載具是 `web/preview/verify.html`(+ `verify.tsx`),可以直接用瀏覽器開來手動翻幀:

```
http://localhost:5173/preview/verify.html?device=cnc_machining_center&capture=slow
```

載具透過各機種元件的 `debug` prop(`MachineProps.debug`)把探針回報器掛進 Canvas。
這個 prop 是**測試接縫**,正式畫面永遠不傳。

## 端到端 vs 逐軸

手臂那兩節分工不同,兩節都要有:

- **[2] 逐軸**:各關節的世界旋轉角 ↔ `joint_angle_n`。抓「某一軸接錯 / 轉反」。
- **[13] 端到端**:夾爪世界座標 ↔ 引擎 `tcp_x/y/z`。抓「每一軸角度都對,但連桿長度或
  零位校正錯了,夾爪落在錯的位置」—— 逐軸檢查對這種錯誤完全無感。

`tcp_x/y/z` 在引擎裡由 `forward_kinematics(joint_angle_1..6)` 算出,與關節角是同一組
狀態的兩種表述,所以它才有資格當標準答案。引擎端另有一道更便宜的檢查
(`verify_scenario.py::check_kinematics`),用一個與連桿長度無關的不變量:
J1 是基座偏擺軸,所以末端的水平方位角 `atan2(tcp_y, tcp_x)` 恆等於 `joint_angle_1`。
學生從 Modbus 讀六軸角度自己算正運動學,對得起來的就是這件事。

## 行程類檢查為什麼不能用「量到多少」當門檻

射出機模板與腔體晶圓這種「大部分時間停著、只在一小段快速移動」的機構,若從 Node 每
120 ms 打一次 `evaluate`(實際往返更久)會直接錯過行程頂點,量到的行程偏小 ——
那是取樣不足,不是動畫沒走到。改用 `recordProbe()` 在頁面內以 `requestAnimationFrame`
取樣。

**即使如此,量到的行程仍是真實值的下界,而且幀率越低漏得越多。** 這件事咬過兩次:

| | 本機(~8.7 fps) | CI runner(~6.8 fps) |
|---|---|---|
| 射出機模板行程 | 1.965 / 2.0 | **1.889 / 2.0** ← 卡在 1.9 的門檻上 |

同一份程式、同一份資料,只因為 CI 的軟體渲染慢兩成就紅了 —— 那是取樣不足,不是動畫
沒走到位。所以行程類的判定**不要拿「量到多少」直接比**,改成判對幀率免疫的性質:

- 腔體:判「進片側與出片側**都到達**」(要保證的是貫通),不比對行程有多接近 6.8。
- 射出機:判「走完至少 **90%** 的行程」而不是 95%。90% 仍分得出真正的壞掉
  (模板不動是 0%、只開一半是 50%),但不會因為少量到一兩幀就紅。

兩者的 detail 都會印出**兩端的實際值與當下幀率**,下次再紅時一眼看得出是真的壞了
還是取樣問題。

## 已知的物理限制(不是 bug)

- **沖壓機**:引擎的行程是 1 秒一次(60 spm),而 telemetry 是 1–4 Hz。取樣本身就在
  Nyquist 邊界甚至以下,`ram_position` 每次都落在同一組相位上。因此契約規定滑塊走
  L3 自由播放,測試驗的是「行程範圍完整(0~120 mm 對應 3.0 模型單位)+ 畫面有標倍率」,
  而不是逐幀對應。要逐幀對得上,得讓引擎以更高頻率發布 `ram_position`。
- **課堂設定(×120)下的週期性動作**:同理。畫面節拍是換算後的,**數值一律以點位為準**,
  而且畫面角落一定有「動畫慢放 ×N」的標示。見 [docs/animation_binding.md](../../docs/animation_binding.md) §1 鐵則三。

## 到位斷言(2026-08-03 新增)

線性回歸對「系統性落後一小段」不敏感 —— 補間永遠差最後一截時,lag 會被吸收進截距,
slope 與 R² 都還是漂亮的。因此另立三項**到位斷言**:

- **AGV 收斂後座標一致**(< 0.02 m):settle 之後車體必須與遙測座標一格不差。
  防的是指數趨近的漸近殘差(`deviceMotion.approach*` 的 `snapEps` 貼齊機制)。
- **AGV 連續播放不離路徑**(< 0.05 m):連續換幀、全程**不等收斂**,頁內 rAF 全速量
  車體到巡迴路徑折線的距離。防的是「兩拍之間直線切過轉角」—— 那只發生在收斂過程,
  settle 後看不到,必須這樣量(弧長鎖定 `agvLockS` 保證恆在路上)。
- **手臂下探落站**(水平 < 30 mm):取整段 `tcp_z` 最低的一幀,畫面夾爪的水平位置
  必須落在 setpoints 指定的取 / 放站上 —— 端到端驗「夾爪真的碰到料箱」。

手臂**刻意不做** CNC 式的 keyframe 相位鎖定:活廠取樣(5 s 一拍)對 8 s 取放循環
已低於 Nyquist,鎖相只會不停硬同步成瞬移;且畫面改吃本地重建的曲線,`encoder_drift`
感測器故障「手臂夾偏」的教學效果就消失了(畫面必須誠實反映讀值,鐵則一)。
