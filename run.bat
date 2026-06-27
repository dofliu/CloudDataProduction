@echo off
REM 一鍵啟動 P0 世界:自動切到專案根目錄,用 venv 裡的 python 跑 main.py。
REM 雙擊本檔,或在終端機輸入 run.bat 即可。Ctrl+C 結束。
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo [錯誤] 找不到 .venv,請先建立虛擬環境並安裝相依:
    echo     python -m venv .venv
    echo     .venv\Scripts\python.exe -m pip install -r requirements.txt
    pause
    exit /b 1
)
".venv\Scripts\python.exe" main.py
pause
