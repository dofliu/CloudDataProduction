# 把看門狗註冊成「系統啟動時自動執行」的工作排程(開機即起、崩潰由 watchdog 自救)。
# 需以系統管理員執行 PowerShell。
#   解除安裝:  Unregister-ScheduledTask -TaskName "CloudDataProduction" -Confirm:$false
param(
    [string]$TaskName = "CloudDataProduction"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$watchdog = Join-Path $root "deploy\watchdog.ps1"

if (-not (Test-Path $watchdog)) { throw "找不到 $watchdog" }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`"" `
    -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
# 用 SYSTEM 帳戶,開機即起、不需登入
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "已註冊工作排程「$TaskName」(系統啟動時自動跑 watchdog)。" -ForegroundColor Green
Write-Host "立即啟動:Start-ScheduledTask -TaskName $TaskName"
Write-Host "看狀態:  Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
