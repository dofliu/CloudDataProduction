# 設備美術預覽(dev only)

用來單獨檢視 `src/world/machines.ts` 內每台設備的動畫,不必啟整個前端。

```bash
cd web
npx esbuild preview/machines.ts --bundle --format=iife --outfile=preview/bundle.js
# 用瀏覽器開 preview/machines.html(或任意靜態伺服器)即可看到全部設備動畫格點

# 選用:自動截圖(需 playwright,本環境已內建 Chromium)
node preview/shot.mjs .
```

`bundle.js` 與 `*.png` 為產生物,已由 `.gitignore` 排除。
