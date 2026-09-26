@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo 正在检查项目环境配置……
call pnpm run --silent start:web:check
set "BENCH_WEB_CHECK=%ERRORLEVEL%"
if not "%BENCH_WEB_CHECK%"=="0" goto needenv
echo.
echo 正在启动网页与 API（直接进入，不进入交互向导）……
echo   网页：http://127.0.0.1:4317
echo   API ：http://127.0.0.1:4318/api/health
echo 按 Ctrl+C 停止。
echo.
call pnpm dev
set "BENCH_WEB_EXIT=%ERRORLEVEL%"
echo.
echo 网页与 API 已退出（退出码 %BENCH_WEB_EXIT%）。
pause
exit /b %BENCH_WEB_EXIT%

:needenv
echo.
echo [无法直接启动] 项目环境配置不完整，未启动任何服务。
echo   下一步：先运行 pnpm start，在向导里补齐环境配置（它会写 .env），再运行本脚本。
echo   本脚本不会自动修改 .env，也不会进入启动向导。
pause
exit /b 1
