@echo off
rem Launch the Antigravity API usage dashboard.
setlocal
cd /d "%~dp0"
python server.py --open %*
if errorlevel 1 (
  echo.
  echo 启动失败：请确认已安装 Python 并加入 PATH。
  pause
)
