@echo off
robocopy "%~dp0." "%USERPROFILE%\.gemini\config\plugins\agy2-stream-stats" /E /XD node_modules .git /NFL /NDL /NJH /NJS
echo [agy2-stream-stats] Synced to global plugins directory.
