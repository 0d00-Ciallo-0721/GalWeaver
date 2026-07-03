@echo off
title QMAI
cd /d "%~dp0"

echo.
echo ==============================================
echo            QMAI Start
echo ==============================================
echo.

:: kill old instances
echo [0/3] Cleaning old processes...
taskkill /f /im qmai.exe >nul 2>&1
taskkill /f /im node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

:: check node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)

:: install deps
if not exist "node_modules" (
    echo [1/3] npm install...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed
        pause
        exit /b 1
    )
) else (
    echo [1/3] node_modules ok
)

:: typecheck
echo [2/3] typecheck...
call npm run typecheck
if %errorlevel% neq 0 (
    echo [ERROR] TypeScript errors found
    pause
    exit /b 1
)
echo [2/3] typecheck passed

:: start
echo [3/3] Starting...
echo.
echo Frontend: http://localhost:1420
echo Press Ctrl+C to stop
echo.

call npm run tauri dev

pause
