# QMAI 开发服务器 — 常驻后台脚本
# 右键 → 使用 PowerShell 运行，或终端中 .\start.ps1
# 关闭窗口即停止服务

$ErrorActionPreference = "Continue"
$host.ui.RawUI.WindowTitle = "QMAI Dev Server"

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "╔══════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║     QMAI 开发服务器              ║" -ForegroundColor Cyan
Write-Host "║  关闭此窗口停止服务              ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

Set-Location -LiteralPath $projectDir

if (-not (Test-Path "node_modules")) {
    Write-Host "[安装] npm install..." -ForegroundColor Yellow
    npm install
}

Write-Host "[启动] npm run tauri dev..." -ForegroundColor Green
Write-Host ""

npm run tauri dev

Write-Host "[停止] 服务已关闭" -ForegroundColor Red
Read-Host "按回车退出"
