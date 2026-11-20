"""L0 网络层：EasyTier mesh（局域网直连优先、中继兜底）+ frp 中心化兜底模板。

本机实测（Windows 非管理员 + Kali VM，VMnet8 NAT）：
  - Windows 不能创建 Wintun 网卡（Failed to create adapter），因此默认 --no-tun --use-smoltcp；
  - no-tun 节点仍能拿到 mesh IP、仍能被对端访问（smoltcp 把入站 TCP 转给本机服务）；
  - Windows → Kali 方向需要 easytier-cli port-forward 建一条本地端口转发。
  见 README「安全边界与限制」。
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from . import winproc

EASYTIER_VERSION = "2.6.4"
DEFAULT_PORT = 11010


def os_tag() -> str:
    if os.name == "nt":
        return "windows"
    if platform.system().lower() == "linux":
        return "linux"
    return platform.system().lower()


def find_binaries(root: str | Path = ".") -> tuple[Path, Path]:
    """按 .cache/<os>/ 布局找 easytier-core / easytier-cli，找不到再看 PATH。"""
    base = Path(root).resolve()
    exe = ".exe" if os.name == "nt" else ""
    candidates = [
        base / ".cache" / ("win" if os.name == "nt" else "linux") / f"easytier-{os_tag()}-x86_64",
        base / ".cache" / "easytier",
    ]
    for folder in candidates:
        core, cli = folder / f"easytier-core{exe}", folder / f"easytier-cli{exe}"
        if core.exists() and cli.exists():
            return core, cli
    core = shutil.which("easytier-core")
    cli = shutil.which("easytier-cli")
    if core and cli:
        return Path(core), Path(cli)
    raise FileNotFoundError(
        "没找到 easytier-core/easytier-cli。先执行 `python -m cluster net fetch`（会下载 v"
        f"{EASYTIER_VERSION} 到 .cache/），或把二进制放进 .cache/easytier/。"
    )


def render_config(
    network_name: str,
    network_secret: str,
    ipv4: str | None = None,
    listeners: list[str] | None = None,
    peers: list[str] | None = None,
    no_tun: bool = False,
    use_smoltcp: bool = False,
    need_p2p: bool = False,
    lazy_p2p: bool = False,
    enable_udp_broadcast_relay: bool = False,
    proxy_networks: list[str] | None = None,
    hostname: str | None = None,
) -> str:
    """生成 EasyTier TOML 配置（字段与 easytier-core 打印的 config 一致）。"""
    listeners = listeners or [f"tcp://0.0.0.0:{DEFAULT_PORT}", f"udp://0.0.0.0:{DEFAULT_PORT}"]
    lines: list[str] = []
    if ipv4:
        lines.append(f'ipv4 = "{ipv4}"')
    if hostname:
        lines.append(f'hostname = "{hostname}"')
    lines.append("listeners = [")
    for item in listeners:
        lines.append(f'    "{item}",')
    lines.append("]")
    if proxy_networks:
        lines.append("proxy_networks = [")
        for item in proxy_networks:
            lines.append(f'    "{item}",')
        lines.append("]")
    lines.append("")
    lines.append("[network_identity]")
    lines.append(f'network_name = "{network_name}"')
    lines.append(f'network_secret = "{network_secret}"')
    for peer in peers or []:
        lines.append("")
        lines.append("[[peer]]")
        lines.append(f'uri = "{peer}"')
    lines.append("")
    lines.append("[flags]")
    if no_tun:
        lines.append("no_tun = true")
    if use_smoltcp:
        lines.append("use_smoltcp = true")
    if need_p2p:
        lines.append("need_p2p = true")
    if lazy_p2p:
        lines.append("lazy_p2p = true")
    if enable_udp_broadcast_relay:
        lines.append("enable_udp_broadcast_relay = true")
    lines.append("")
    return "\n".join(lines)


def frp_templates(host_public_ip: str, token_hint: str = "<换成足够长的随机串>") -> dict[str, str]:
    """方案二（中心化，仅主机有固定 IP）：frps/frpc 模板。"""
    frps = f"""# 有固定公网 IP 的主机：frps.toml
bindAddr = "0.0.0.0"
bindPort = 7000
auth.method = "token"
auth.token = "{token_hint}"
"""
    frpc = f"""# 无固定 IP 的节点：frpc.toml（把本机 Agent 端口映射到主机）
serverAddr = "{host_public_ip}"
serverPort = 7000
auth.method = "token"
auth.token = "{token_hint}"

[[proxies]]
name = "cluster-agent"
type = "tcp"
localIP = "127.0.0.1"
localPort = 17100
remotePort = 27100
"""
    return {"frps.toml": frps, "frpc.toml": frpc}


# ---------------------------------------------------------------- 进程管理
class Mesh:
    def __init__(self, core: Path, cli: Path) -> None:
        self.core = Path(core)
        self.cli = Path(cli)
        self.proc: subprocess.Popen | None = None
        self.log_path: Path | None = None

    def start(self, config_path: str | Path, log_path: str | Path, detached: bool = False) -> None:
        self.log_path = Path(log_path)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(self.log_path, "ab")
        kwargs: dict = {"stdout": handle, "stderr": subprocess.STDOUT, "stdin": subprocess.DEVNULL}
        if detached and os.name == "nt":
            flags = 0
            for name in ("DETACHED_PROCESS", "CREATE_NEW_PROCESS_GROUP", "CREATE_BREAKAWAY_FROM_JOB"):
                flags |= int(getattr(subprocess, name, 0))
            try:
                self.proc = subprocess.Popen([str(self.core), "-c", str(config_path)], **winproc.hidden_kwargs(flags=flags), **kwargs)
            except OSError:  # 不允许 breakaway 时退回普通分离进程
                fallback = int(getattr(subprocess, "DETACHED_PROCESS", 0)) | int(getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
                self.proc = subprocess.Popen([str(self.core), "-c", str(config_path)], **winproc.hidden_kwargs(flags=fallback), **kwargs)
        elif detached:
            self.proc = subprocess.Popen([str(self.core), "-c", str(config_path)], start_new_session=True, **kwargs)
        else:
            self.proc = subprocess.Popen([str(self.core), "-c", str(config_path)], **winproc.hidden_kwargs(), **kwargs)

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:  # pragma: no cover
                self.proc.kill()
        self.proc = None

    # ---- 只读查询 ---------------------------------------------------
    def _cli(self, *args: str, timeout: float = 15.0) -> str:
        proc = subprocess.run(
            [str(self.cli), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
            **winproc.hidden_kwargs(),
        )
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout).strip()[:400])
        return proc.stdout

    def peers(self) -> list[dict]:
        return json.loads(self._cli("-o", "json", "peer") or "[]")

    def node_info(self) -> dict:
        return json.loads(self._cli("-o", "json", "node") or "{}")

    def routes(self) -> list[dict]:
        return json.loads(self._cli("-o", "json", "route") or "[]")

    def port_forwards(self) -> list[dict]:
        try:
            raw = self._cli("port-forward", "list")
        except RuntimeError:
            return []
        rows = []
        for line in raw.splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) == 3 and cells[0].lower() in ("tcp", "udp"):
                rows.append({"proto": cells[0].lower(), "bind": cells[1], "dst": cells[2]})
        return rows

    def add_port_forward(self, proto: str, bind: str, dst: str) -> str:
        return self._cli("port-forward", "add", proto, bind, dst).strip()

    def evidence(self) -> dict:
        """一次性证据快照（peer 表 + 路由 + 节点信息 + 端口转发）。"""
        try:
            peers = self.peers()
        except Exception as exc:  # noqa: BLE001 - 证据收集不应中断
            peers = [{"error": str(exc)}]
        try:
            node = self.node_info()
        except Exception as exc:  # noqa: BLE001
            node = {"error": str(exc)}
        return {
            "ts": time.time(),
            "peers": peers,
            "node": node,
            "port_forwards": self.port_forwards(),
            "log": str(self.log_path) if self.log_path else None,
        }


def peer_is_direct(peer: dict) -> bool:
    """cost 字段：p2p=直连，relay/relay?=中继，Local=自己。"""
    cost = str(peer.get("cost", "")).lower()
    return cost in ("p2p", "direct", "local")


def mesh_ip(peers: list[dict], hostname: str | None = None) -> str | None:
    for peer in peers:
        if peer.get("cost", "").lower() == "local" and not hostname:
            return peer.get("ipv4")
        if hostname and peer.get("hostname") == hostname:
            return peer.get("ipv4")
    return None


def summarize(peers: list[dict]) -> str:
    rows = []
    for peer in peers:
        rows.append(
            f"{peer.get('ipv4', '?'):<14} {peer.get('hostname', '?'):<18} "
            f"cost={peer.get('cost', '?'):<6} lat={peer.get('lat_ms', '?'):<6} tunnel={peer.get('tunnel_proto', '?')}"
        )
    return "\n".join(rows) if rows else "(no peers)"


def python_cmd() -> str:
    return sys.executable
