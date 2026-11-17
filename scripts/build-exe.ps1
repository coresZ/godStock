[CmdletBinding()]
param(
    [switch]$DebugBuild,
    [switch]$SkipFrontend,
    [switch]$NoCopy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$started = Get-Date

function Write-Step([string]$text) {
    Write-Host ""
    Write-Host "==> $text" -ForegroundColor Cyan
}

function Fail([string]$message) {
    Write-Host "构建失败：$message" -ForegroundColor Red
    exit 1
}

function Require-Command([string]$name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Fail "找不到命令 $name，请先安装并加入 PATH。"
    }
}

Write-Host "天梯 · Windows exe 构建" -ForegroundColor Yellow
Write-Host "项目目录：$root"

Require-Command "pnpm"
Require-Command "cargo"

$tauriConfig = Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw -Encoding utf8 | ConvertFrom-Json
$version = [string]$tauriConfig.version
$profile = if ($DebugBuild) { "debug" } else { "release" }
$exePath = Join-Path $root "src-tauri\target\$profile\tianti.exe"

if (Get-Process -Name "TianTi" -ErrorAction SilentlyContinue) {
    Fail "检测到 TianTi.exe 正在运行，请先关闭应用再构建，否则 exe 可能被占用。"
}

if (-not $SkipFrontend) {
    Write-Step "构建前端（TypeScript 检查 + Vite）"
    Push-Location $root
    try {
        & pnpm build
        if ($LASTEXITCODE -ne 0) { Fail "前端构建失败（exit $LASTEXITCODE）。" }
    }
    finally {
        Pop-Location
    }
}
else {
    Write-Step "跳过前端构建"
}

if (-not (Test-Path (Join-Path $root "dist\index.html"))) {
    Fail "dist/index.html 不存在，请先运行前端构建（不要同时使用 -SkipFrontend）。"
}

Write-Step "构建 Rust $profile exe"
$cargoArgs = @(
    "build",
    "--manifest-path", (Join-Path $root "src-tauri\Cargo.toml"),
    "--features", "custom-protocol"
)
if (-not $DebugBuild) {
    $cargoArgs += "--release"
}
& cargo @cargoArgs
if ($LASTEXITCODE -ne 0) { Fail "Rust 构建失败（exit $LASTEXITCODE）。" }

if (-not (Test-Path $exePath)) {
    Fail "没有找到构建产物：$exePath"
}

$resultPath = $exePath
if (-not $NoCopy) {
    $releaseDir = Join-Path $root "release"
    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    $resultName = if ($DebugBuild) { "TianTi-debug.exe" } else { "TianTi.exe" }
    $resultPath = Join-Path $releaseDir $resultName
    Copy-Item $exePath $resultPath -Force
}

$size = (Get-Item $resultPath).Length
$elapsed = (Get-Date) - $started

Write-Host ""
Write-Host "构建完成" -ForegroundColor Green
Write-Host "版本：v$version"
Write-Host "输出：$resultPath"
Write-Host ("大小：{0:N0} 字节（{1:N1} MB）" -f $size, ($size / 1MB))
Write-Host ("耗时：{0:mm\:ss}" -f $elapsed)
Write-Host ""
Write-Host "未生成 zip、SHA-256 或 GitHub Release。需要发版时再单独执行发布流程。" -ForegroundColor DarkGray
