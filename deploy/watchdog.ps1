# 引擎看門狗:啟動引擎(run-engine.ps1),並輪詢 /api/health;連續失敗就重啟。
# 用 health-poll 而非只看行程是否存活 —— 連「卡住但沒崩」也能救(常駐 5090 主機適用)。
#
# 手動跑:   .\deploy\watchdog.ps1
# 開機自動: 用 deploy\install-startup-task.ps1 註冊成系統啟動工作。
param(
    [string]$HealthUrl = "http://127.0.0.1:8077/api/health",
    [int]$IntervalSec = 30,        # 多久檢查一次
    [int]$FailThreshold = 3,       # 連續幾次失敗才重啟
    [int]$GraceSec = 25            # 啟動後給多久暖機才開始判定
)
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$runEngine = Join-Path $root "run-engine.ps1"
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir "watchdog.log"

function Log($msg) {
    $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    $line | Tee-Object -FilePath $log -Append
}

function Start-Engine {
    Log "啟動引擎:$runEngine"
    $engineLog = Join-Path $logDir "engine.log"
    # 用獨立 PowerShell 程序跑 run-engine.ps1,stdout/err 導到 engine.log
    $p = Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$runEngine`"" `
        -RedirectStandardOutput $engineLog -RedirectStandardError "$engineLog.err" `
        -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds $GraceSec
    return $p
}

function Test-Health {
    try {
        $r = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5
        return [bool]$r.ok
    } catch { return $false }
}

Log "=== watchdog 起動(health=$HealthUrl, 每 ${IntervalSec}s, 連 $FailThreshold 次失敗重啟)==="
$proc = Start-Engine
$fails = 0
while ($true) {
    Start-Sleep -Seconds $IntervalSec
    if (Test-Health) {
        if ($fails -gt 0) { Log "恢復正常(先前失敗 $fails 次)" }
        $fails = 0
    } else {
        $fails++
        Log "health 失敗 $fails/$FailThreshold"
        if ($fails -ge $FailThreshold) {
            Log "達門檻,重啟引擎"
            if ($proc -and -not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force } catch {} }
            # 清掉可能殘留佔埠的 python(本專案埠區)
            foreach ($port in 8077,6020,6041,6083,6023) {
                $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
                if ($c) { $c.OwningProcess | Select-Object -Unique | ForEach-Object {
                    $pr = Get-Process -Id $_ -ErrorAction SilentlyContinue
                    if ($pr -and $pr.ProcessName -eq 'python') { try { Stop-Process -Id $pr.Id -Force } catch {} } } }
            }
            Start-Sleep -Seconds 3
            $proc = Start-Engine
            $fails = 0
        }
    }
}
