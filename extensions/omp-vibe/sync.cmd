@echo off
robocopy "%~dp0." "%USERPROFILE%\.gemini\config\plugins\omp-vibe" /E /XD node_modules .git /NFL /NDL /NJH /NJS
echo [omp-vibe] Synced to global plugins directory.
