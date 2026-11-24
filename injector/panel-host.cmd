@echo off
setlocal
cd /d "%~dp0"
echo [Antigravity 监控面板常驻守护程序]
echo 正在连接客户端，窗口打开或切换会话将自动注入面板...
echo 提示：保持此窗口在后台运行即可，按 Ctrl+C 可停止。
node panel-host.js
pause
