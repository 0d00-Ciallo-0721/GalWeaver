# QMAI 快速启动 - 开发模式
# 右键 → 使用 PowerShell 运行
$ErrorActionPreference = "Continue"
$host.ui.RawUI.WindowTitle = "QMAI Dev"

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $dir

Write-Host "`n  QMAI - Galgame 剧本写作系统`n" -ForegroundColor Cyan

# 跳过 typecheck 和 Rust 检查，直接启动
if (-not (Test-Path "node_modules")) {
    Write-Host "[安装] npm install..." -ForegroundColor Yellow
    npm install
}

Write-Host "[启动] npm run tauri dev..." -ForegroundColor Green
Write-Host "http://localhost:1420`n"

npm run tauri dev
