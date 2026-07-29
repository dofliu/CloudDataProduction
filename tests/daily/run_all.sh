#!/usr/bin/env bash
# 每日模擬測試一鍵執行:跑當天情境 → 截圖 → 產出圖文報告。
#
#   bash tests/daily/run_all.sh [--key <情境>] [--date YYYY-MM-DD]
#
# 產出 artifacts/daily/report.html(自包含,截圖已內嵌,可離線開 / 直接發布)。
# 離開碼:0 = 沒有新問題(已知待修不算);1 = 有新問題或畫面錯誤。
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=artifacts/daily
mkdir -p "$OUT"

echo "── 1/4 引擎面:跑當天情境 ──────────────────────"
python3 tests/daily/run_daily.py --out "$OUT" "$@"
ENGINE_RC=$?          # 1 = 有失敗判定(含已知待修);細分交給下面的 result.json

echo
echo "── 2/4 起 dev server ─────────────────────────"
if ! curl -sf -o /dev/null http://localhost:5173/preview/verify.html; then
  ( cd web && nohup npx vite --port 5173 > /tmp/vite-daily.log 2>&1 & )
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null http://localhost:5173/preview/verify.html && break
    sleep 1
  done
fi
curl -sf -o /dev/null http://localhost:5173/preview/verify.html || {
  echo "dev server 起不來:"; cat /tmp/vite-daily.log; exit 1; }
echo "ok"

echo
echo "── 3/4 畫面:逐台前後對照截圖 ──────────────────"
node tests/daily/shoot_daily.mjs "$OUT"
SHOT_RC=$?

echo
echo "── 4/4 組報告 ────────────────────────────────"
python3 tests/daily/build_report.py --dir "$OUT" | tee "$OUT/summary.json"

# 只有「新問題」或畫面錯誤才算失敗 —— 已知待修不該每天把這支腳本弄紅
NEW=$(python3 -c "import json;print(json.load(open('$OUT/summary.json'))['failed'])")
if [ "$NEW" -gt 0 ] || [ "$SHOT_RC" -ne 0 ]; then
  echo "→ 有新問題,離開碼 1"
  exit 1
fi
echo "→ 沒有新問題"
exit 0
