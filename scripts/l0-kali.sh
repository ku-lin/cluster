#!/usr/bin/env bash
# L0（Kali 侧）：以 root 建 TUN 加入 EasyTier mesh（局域网直连优先，跨网靠中继兜底）
# 用法： sudo bash scripts/l0-kali.sh
#
# 注意：[[peer]] 引导地址必须是"建网之前就可达"的地址。
#       Windows 侧是 no-tun，拿不到 mesh 网段路由，所以对端只能用 underlay IP；
#       mesh IP 只在对端已经有 TUN 时才可作引导。
set -euo pipefail

NETWORK="${NETWORK:-cluster-lab}"
SECRET="${SECRET:-lab-secret-2026}"
MESH_IP="${MESH_IP:-10.14.14.2}"
PEERS="${PEERS:-tcp://192.168.70.1:11010 tcp://10.14.14.1:11010}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CFG="$ROOT/.state/net/kali.toml"
LOG="$ROOT/.state/logs/easytier-kali.log"
mkdir -p "$(dirname "$CFG")" "$(dirname "$LOG")"

if [ "$(id -u)" -ne 0 ]; then
  echo "[l0-kali] 需要 root（创建 TUN）：sudo bash $0" >&2
  exit 1
fi

peer_args=()
for p in $PEERS; do peer_args+=(--peer "$p"); done

echo "[l0-kali] 生成配置 -> $CFG (peers: $PEERS)"
python3 -m cluster net init --network "$NETWORK" --secret "$SECRET" --mesh-ip "$MESH_IP" \
  "${peer_args[@]}" --need-p2p --out "$CFG" >/dev/null

CORE="$ROOT/.cache/linux/easytier-linux-x86_64/easytier-core"
if [ ! -x "$CORE" ]; then
  echo "[l0-kali] 缺少 $CORE；先执行 python3 -m cluster net fetch" >&2
  exit 1
fi

if pgrep -f "easytier-core -c $CFG" >/dev/null; then
  echo "[l0-kali] 已在运行（重载配置请先 pkill -f easytier-core）"
else
  setsid nohup "$CORE" -c "$CFG" >>"$LOG" 2>&1 </dev/null &
  sleep 5
fi

# .state 由 root 建，交还给调用者，避免之后 Agent 写不了日志
if [ -n "${SUDO_USER:-}" ]; then
  chown -R "$SUDO_USER":"$SUDO_USER" "$ROOT/.state" || true
fi

echo "[l0-kali] peer 状态"
python3 -m cluster net status --json --out "$ROOT/.state/evidence/net-kali.json"
