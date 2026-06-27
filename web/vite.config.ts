import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 開發伺服器把 /api 與 /ws 代理到後端世界(預設 8077),
// 前端一律用相對路徑,正式環境同源也能跑。後端埠不同就改這裡的 target。
const BACKEND = "http://127.0.0.1:8077";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
});
