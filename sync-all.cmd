@echo off
echo ========================================================
echo  Syncing Antigravity Extensions to Global Plugins Folder
echo ========================================================

call "%~dp0extensions\agy2-stream-stats\sync.cmd"
call "%~dp0extensions\workspace-navigator\sync.cmd"
call "%~dp0extensions\omp-vibe\sync.cmd"

echo.
echo All extensions successfully synced and up to date!
