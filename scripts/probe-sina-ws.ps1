# 天梯 · 实时行情 WebSocket 探针
#
# 只读试验：连接新浪公开行情推送 wss://hq.sinajs.cn/wskt，打印 N 秒内的消息。
# 不写入数据库、不改动应用数据。仅供个人学习复盘，请勿高频重连。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe-sina-ws.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe-sina-ws.ps1 -Codes "sh000001,sz002187" -Seconds 30

[CmdletBinding()]
param(
    [string]$Codes = "sh000001,sz399001,sz399006,sz002187",
    [int]$Seconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$uri = [Uri]("wss://hq.sinajs.cn/wskt?list=$Codes")
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.Options.SetRequestHeader("Origin", "https://finance.sina.com.cn")

$cts = New-Object System.Threading.CancellationTokenSource
$cts.CancelAfter(([Math]::Max(5, $Seconds) + 8) * 1000)

Write-Host "连接 $uri" -ForegroundColor Cyan
Write-Host "只读探针，$Seconds 秒后自动断开。" -ForegroundColor DarkGray

try {
    $ws.ConnectAsync($uri, $cts.Token).Wait()
    Write-Host "已连接，等待推送……" -ForegroundColor Green

    $buffer = New-Object byte[] 16384
    $segment = New-Object System.ArraySegment[byte] -ArgumentList @(, $buffer)
    $started = [Diagnostics.Stopwatch]::StartNew()
    $count = 0
    $pending = $ws.ReceiveAsync($segment, $cts.Token)

    while ($started.ElapsedMilliseconds -lt ($Seconds * 1000) -and $ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
        if (-not $pending.Wait(250)) { continue }
        $result = $pending.Result
        if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
            Write-Host "服务端关闭连接。" -ForegroundColor Yellow
            break
        }
        $count++
        $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $result.Count)
        foreach ($line in ($text -split "`n")) {
            $line = $line.Trim()
            if (-not $line -or $line.StartsWith("sys_")) { continue }
            $stamp = (Get-Date).ToString("HH:mm:ss.fff")
            $short = if ($line.Length -gt 220) { $line.Substring(0, 220) + "…" } else { $line }
            Write-Host "[$stamp] $short"
        }
        $pending = $ws.ReceiveAsync($segment, $cts.Token)
    }

    Write-Host ""
    Write-Host "共收到 $count 帧 / $($started.Elapsed.TotalSeconds.ToString('0.0')) 秒。" -ForegroundColor Green
    Write-Host "说明：这是约 3 秒一次的行情快照，不是逐笔成交；接口非官方，可能随时失效。" -ForegroundColor DarkGray
}
catch {
    $base = $_.Exception.GetBaseException()
    if ($base -is [System.OperationCanceledException]) {
        Write-Host "已到探针时长，正常断开。" -ForegroundColor Green
    }
    else {
        Write-Host "失败：$($base.Message)" -ForegroundColor Red
        Write-Host "如果本机网络无法访问新浪行情，请换网络再试；应用本身不依赖这个探针。" -ForegroundColor DarkGray
        exit 1
    }
}
finally {
    try { $ws.Abort() } catch { }
    try { $ws.Dispose() } catch { }
    $cts.Dispose()
}
