# 一鍵啟動 P0 世界:自動切到專案根目錄,用 venv 裡的 python 跑 main.py。
# 用法:在終端機輸入  .\run.ps1   (Ctrl+C 結束)
Set-Location -Path $PSScriptRoot
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Host "[錯誤] 找不到 .venv,請先建立虛擬環境並安裝相依:" -ForegroundColor Red
    Write-Host "    python -m venv .venv"
    Write-Host "    .venv\Scripts\python.exe -m pip install -r requirements.txt"
    exit 1
}
& $py (Join-Path $PSScriptRoot "main.py")
