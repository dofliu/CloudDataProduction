# 用專案 .venv 啟動引擎(避免誤用全域 Python — 全域那支版本會漂移)。
# 用法:  .\run-engine.ps1            常駐 / 排程器 / NSSM 都呼叫這支。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$py = Join-Path $root ".venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Host "[run-engine] 找不到 .venv,請先建立:" -ForegroundColor Yellow
    Write-Host "  python -m venv .venv"
    Write-Host "  .\.venv\Scripts\python.exe -m pip install -r requirements.txt"
    exit 1
}

# 確認鎖定版相依(pymodbus 3.6.9)在位,否則早點報錯而不是跑到一半崩
& $py -c "import pymodbus,amqtt,asyncua,fastapi,numpy; assert pymodbus.__version__=='3.6.9', 'pymodbus 不是 3.6.9:'+pymodbus.__version__"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[run-engine] venv 相依不符,請執行:.\.venv\Scripts\python.exe -m pip install -r requirements.txt" -ForegroundColor Yellow
    exit 1
}

$env:PYTHONIOENCODING = "utf-8"
Write-Host "[run-engine] 以 venv Python 啟動:$py" -ForegroundColor Green
& $py (Join-Path $root "main.py")
