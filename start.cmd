@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
call pnpm start
set "BENCH_START_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %BENCH_START_EXIT%
