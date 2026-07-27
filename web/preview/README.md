# 設備動畫預覽(dev only)

## 3D 機種預覽(現行)

用合成 snapshot 檢視全部 11 種設備的 3D 動畫,不必啟後端。每個機種各給「健康」與
「退化 / 故障 / 教師停機」兩組資料,用來驗收 [docs/animation_binding.md](../../docs/animation_binding.md)
的綁定表與視覺語彙是否真的接上資料。

```bash
cd web
npx vite                       # 起 dev server
# 逐台看(一次一個 Canvas,避免超過瀏覽器 WebGL context 上限)
#   http://localhost:5173/preview/models3d.html?i=0
# 廠內產線視圖(一個 Canvas 多台)
#   http://localhost:5173/preview/models3d.html?line=1
# 機械手臂正運動學核對(畫出 fk() 算出的取放點)
#   http://localhost:5173/preview/models3d.html?i=2&fkdebug=1

# 自動截圖 + console 錯誤檢查(本環境已內建 Chromium)
node preview/shot3d.mjs /tmp/shots
```

`shot3d.mjs` 會把所有 console error / pageerror 收集起來一起印。**這是離線資源回歸的
第一道防線** —— 專案常駐校內 5090、學生走 LAN,3D 層不得依賴任何 CDN(drei 的
`<Environment preset>` 會抓 .hdr、`<Text>` 會抓字型資料,兩者都已改成本地實作)。

## 2D 機台預覽(舊,俯瞰層仍在用)

`src/world/machines.ts` 只剩俯瞰層的 `darken()` 等工具仍在用;廠內動畫已全面改 3D。

```bash
npx esbuild preview/machines.ts --bundle --format=iife --outfile=preview/bundle.js
# 瀏覽器開 preview/machines.html
node preview/shot.mjs .
```

`bundle.js` 與 `*.png` 為產生物,已由 `.gitignore` 排除。
