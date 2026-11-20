#!/usr/bin/env bash
# L1+L2（Kali 侧）：启动控制面副本 + Node Agent（mTLS）
# 前提：sudo bash scripts/l0-kali.sh 已跑通（TUN + mesh IP 10.14.14.2）、证书已分发
# 用法： bash scripts/node-kali.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TLS_DIR="${TLS_DIR:-.state/tls}"
CERT="${CERT:-kali}"
CONTROL_PORT="${CONTROL_PORT:-18101}"
AGENT_PORT="${AGENT_PORT:-17100}"
MESH_IP="${MESH_IP:-10.14.14.2}"
PEER_CONTROL="${PEER_CONTROL:-https://192.168.70.1:18100}"
mkdir -p .state/logs

stop_port() {
  local port="$1"
  local pids
  pids="$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $NF}' | grep -o 'pid=[0-9]*' | cut -d= -f2 || true)"
  if [ -n "${pids:-}" ]; then
    kill $pids 2>/dev/null || true
    sleep 0.5
  fi
}

stop_port "$CONTROL_PORT"
stop_port "$AGENT_PORT"

echo "[node-kali] 控制面副本 -> https://0.0.0.0:$CONTROL_PORT (peer $PEER_CONTROL)"
setsid nohup python3 -u -m cluster control --node-id kali-router --port "$CONTROL_PORT" \
  --peers "$PEER_CONTROL" --tls-dir "$TLS_DIR" --cert-name "$CERT" \
  >>.state/logs/control-kali.log 2>&1 </dev/null &
sleep 2

echo "[node-kali] Node Agent -> https://0.0.0.0:$AGENT_PORT (mesh $MESH_IP)"
setsid nohup python3 -u -m cluster agent --node-id kali-node --port "$AGENT_PORT" \
  --control "https://${MESH_IP}:${CONTROL_PORT}" --control "$PEER_CONTROL" \
  --tls-dir "$TLS_DIR" --cert-name "$CERT" --mesh-ip "$MESH_IP" \
  --advertise "https://192.168.70.145:${AGENT_PORT}" \
  --plugins examples/plugins --plugins examples/plugins-extra/kali \
  >>.state/logs/agent-kali.log 2>&1 </dev/null &
sleep 3

echo "[node-kali] 健康检查"
python3 - <<'PY'
import json, ssl, urllib.request
ctx = ssl.create_default_context(cafile=".state/tls/ca.crt")
ctx.load_cert_chain(".state/tls/kali.crt", ".state/tls/kali.key")
for url in ("https://127.0.0.1:17100/health", "https://127.0.0.1:18101/control/health"):
    try:
        with urllib.request.urlopen(url, context=ctx, timeout=8) as resp:
            print(" ", url, "->", json.dumps(json.loads(resp.read().decode()), ensure_ascii=False)[:200])
    except Exception as exc:
        print(" ", url, "FAILED:", exc)
PY
