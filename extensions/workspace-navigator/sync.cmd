@echo off
robocopy "%~dp0." "%USERPROFILE%\.gemini\config\plugins\workspace-navigator" /E /XD node_modules .git /NFL /NDL /NJH /NJS
echo [workspace-navigator] Synced to global plugins directory.
