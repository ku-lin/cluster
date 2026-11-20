# L1+L2（Windows 侧）：启动控制面副本 + Node Agent（mTLS），并做健康检查
# 前提：已跑过 scripts\l0-win.ps1（mesh + port-forward 就绪）、证书在 $TlsDir
# 用法： powershell -ExecutionPolicy Bypass -File scripts\node-win.ps1
# 说明：服务用 scripts/start_bg.py 以脱离进程启动，PowerShell 退出不会带走它们。

param(
    [string]$TlsDir = ".state\tls",
    [string]$CertName = "win",
    [string]$ControlPort = "18100",
    [string]$AgentPort = "17100",
    [string]$MeshIp = "10.14.14.1",
    [string]$PeerControl = "https://192.168.70.145:18101"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$logs = Join-Path $Root ".state\logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Stop-Port($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $conn | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
            try { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } catch {}
        }
        Start-Sleep -Milliseconds 500
    }
}

Stop-Port $ControlPort
Stop-Port $AgentPort

Write-Host "[node-win] 控制面副本 -> https://0.0.0.0:$ControlPort (peer $PeerControl)"
python scripts\start_bg.py (Join-Path $logs "control-win.log") python -u -m cluster control `
    --node-id win-router --port $ControlPort --peers $PeerControl `
    --tls-dir $TlsDir --cert-name $CertName

Start-Sleep -Seconds 2

Write-Host "[node-win] Node Agent -> https://0.0.0.0:$AgentPort (mesh $MeshIp)"
python scripts\start_bg.py (Join-Path $logs "agent-win.log") python -u -m cluster agent `
    --node-id win-node --port $AgentPort `
    --control "https://127.0.0.1:$ControlPort" --control "https://192.168.70.145:18101" `
    --tls-dir $TlsDir --cert-name $CertName --mesh-ip $MeshIp --advertise "https://192.168.70.1:$AgentPort" `
    --plugins examples/plugins --plugins examples/plugins-extra/win

Start-Sleep -Seconds 3
Write-Host "[node-win] 健康检查（走 mTLS）"
python -m cluster status --control "https://127.0.0.1:$ControlPort" --tls-dir $TlsDir --cert-name $CertName
