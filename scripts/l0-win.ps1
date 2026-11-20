# L0（Windows 侧）：no-tun + smoltcp 加入 EasyTier mesh，并建好到 Kali 的端口转发
# 用法： powershell -ExecutionPolicy Bypass -File scripts\l0-win.ps1
#
# 两个环境事实（本机实测）：
#   1. Windows 非管理员无法创建 Wintun 网卡 -> 用 --no-tun --use-smoltcp；
#   2. 工具/控制台退出会带走同作业内的子进程 -> easytier-core 用 WMI(Win32_Process.Create)
#      拉起，脱离当前作业，命令返回后仍在跑。

param(
    [string]$Network = "cluster-lab",
    [string]$Secret = "lab-secret-2026",
    [string]$MeshIp = "10.14.14.1",
    [string]$Peer = "tcp://192.168.70.145:11010",  # no-tun 模式下引导必须用 underlay 真实 IP，不能用 mesh IP
    [string]$KaliMeshIp = "10.14.14.2",
    [switch]$WithForwards = $false
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$cfg = Join-Path $Root ".state\net\win.toml"
$log = Join-Path $Root ".state\logs\easytier-win.log"
$cmd = Join-Path $Root ".state\net\easytier-win.cmd"
New-Item -ItemType Directory -Force -Path (Split-Path $cfg), (Split-Path $log) | Out-Null

Write-Host "[l0-win] 生成配置 -> $cfg"
python -m cluster net init --network $Network --secret $Secret --mesh-ip $MeshIp --peer $Peer --no-tun --smoltcp --need-p2p --out $cfg | Out-Null

# 幂等重启：先清掉上一轮的 easytier-core
Get-Process easytier-core -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "[l0-win] 停止旧实例 pid=$($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

$core = (python -c "from cluster import l0_network; print(l0_network.find_binaries('.')[0])").Trim()
Write-Host "[l0-win] core = $core"

# 启动包装脚本（cmd 里做 cd + 重定向，便于以后手工重启）
$launcher = "@echo off`r`ncd /d `"$Root`"`r`n`"$core`" -c `"$cfg`" >> `"$log`" 2>&1`r`n"
[IO.File]::WriteAllText($cmd, $launcher, (New-Object System.Text.ASCIIEncoding))
# 用 start_bg.py（DETACHED_PROCESS + breakaway）拉起，避免控制台/作业关闭时被带走
python scripts\start_bg.py (Join-Path $Root ".state\logs\easytier-start.log") cmd.exe /c "$cmd"
Write-Host "[l0-win] easytier-core 已脱离启动"
Start-Sleep -Seconds 7

Write-Host "[l0-win] peer 状态"
python -m cluster net status --json --out (Join-Path $Root ".state\evidence\net-win.json")

# 出站：Windows -> Kali。默认关闭——本机实测 no-tun + port_forward 会让 easytier-core
# 在应用补丁后直接退出；改为让上层用 underlay 地址直连（控制面的 url 列表本就是多地址）。
if ($WithForwards) {
    foreach ($port in @(17100, 18101)) {
        python -m cluster net forward --proto tcp --bind "127.0.0.1:$port" --dst "${KaliMeshIp}:$port" | Out-Null
    }
    Write-Host "[l0-win] port-forward 规则"
    python -m cluster net forward --list
} else {
    Write-Host "[l0-win] 跳过 port-forward（-WithForwards 才启用）"
}
