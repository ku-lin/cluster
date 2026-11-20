"""命令行入口：网络层、证书、Agent、控制面、任务、演示与自检。"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

from . import httpjson, l0_network, mtls, winproc
from .httpjson import TLSOptions
from .l1_agent import Agent
from .l2_control import ControlNode
from .l5_orchestrator import Orchestrator
from .policy import AdmissionPolicy

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".state"


def _tls(args) -> TLSOptions | None:
    if not getattr(args, "tls_dir", None):
        return None
    base = Path(args.tls_dir)
    name = getattr(args, "cert_name", None)
    certfile = base / f"{name}.crt" if name else None
    keyfile = base / f"{name}.key" if name else None
    return TLSOptions(
        cafile=str(base / "ca.crt"),
        certfile=str(certfile) if certfile else None,
        keyfile=str(keyfile) if keyfile else None,
        require_client_cert=True,
    )


def _utf8_console() -> None:
    """Windows 控制台默认不是 UTF-8，中文/符号会抛 UnicodeEncodeError。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError, OSError):
            pass


def _print(obj) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2, default=str))


# ---------------------------------------------------------------- net
def cmd_net_fetch(args) -> int:
    version = args.version
    tag = f"v{version}"
    os_tag = l0_network.os_tag()
    arch = "x86_64"
    if os_tag not in ("windows", "linux"):
        print(f"暂不支持自动下载 {os_tag} 版本，请手动放置二进制到 .cache/easytier/")
        return 2
    name = f"easytier-{os_tag}-{arch}-{tag}.zip"
    url = f"https://github.com/EasyTier/EasyTier/releases/download/{tag}/{name}"
    target_dir = ROOT / ".cache" / ("win" if os_tag == "windows" else "linux")
    target_dir.mkdir(parents=True, exist_ok=True)
    zip_path = target_dir / name
    print(f"downloading {url}")
    urllib.request.urlretrieve(url, zip_path)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(target_dir)
    exe = ".exe" if os_tag == "windows" else ""
    core = target_dir / f"easytier-{os_tag}-{arch}" / f"easytier-core{exe}"
    cli = target_dir / f"easytier-{os_tag}-{arch}" / f"easytier-cli{exe}"
    if os_tag != "windows":
        for path in (core, cli):
            path.chmod(0o755)
    _print({"core": str(core), "cli": str(cli), "exists": core.exists() and cli.exists()})
    return 0


def cmd_net_init(args) -> int:
    peers = args.peer or []
    listeners = args.listen or [f"tcp://0.0.0.0:{l0_network.DEFAULT_PORT}", f"udp://0.0.0.0:{l0_network.DEFAULT_PORT}"]
    text = l0_network.render_config(
        network_name=args.network,
        network_secret=args.secret,
        ipv4=args.mesh_ip,
        listeners=listeners,
        peers=peers,
        no_tun=args.no_tun,
        use_smoltcp=args.smoltcp,
        need_p2p=args.need_p2p,
        lazy_p2p=args.lazy_p2p,
        enable_udp_broadcast_relay=args.udp_broadcast,
        proxy_networks=args.proxy_network or [],
        hostname=args.hostname,
    )
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    _print({"config": str(out), "content": text})
    return 0


def cmd_net_up(args) -> int:
    core, cli = l0_network.find_binaries(ROOT)
    mesh = l0_network.Mesh(core, cli)
    log = args.log or str(STATE / "logs" / "easytier.log")
    print(f"starting {core} -c {args.config} (log: {log})")
    mesh.start(args.config, log, detached=bool(args.detach))
    if args.detach:
        _print({"pid": mesh.proc.pid if mesh.proc else None, "log": log})
        return 0
    try:
        assert mesh.proc is not None
        return mesh.proc.wait()
    except KeyboardInterrupt:
        mesh.stop()
        return 0


def cmd_net_status(args) -> int:
    core, cli = l0_network.find_binaries(ROOT)
    mesh = l0_network.Mesh(core, cli)
    evidence = mesh.evidence()
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
    print(l0_network.summarize(evidence["peers"]))
    if args.json:
        _print(evidence)
    return 0


def cmd_net_forward(args) -> int:
    core, cli = l0_network.find_binaries(ROOT)
    mesh = l0_network.Mesh(core, cli)
    if args.list:
        _print(mesh.port_forwards())
        return 0
    print(mesh.add_port_forward(args.proto, args.bind, args.dst))
    _print(mesh.port_forwards())
    return 0


def cmd_net_frp(args) -> int:
    templates = l0_network.frp_templates(args.host_ip, args.token)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, text in templates.items():
        (out_dir / name).write_text(text, encoding="utf-8")
    _print({"written": [str(out_dir / n) for n in templates]})
    return 0


# ---------------------------------------------------------------- certs
def cmd_certs_init(args) -> int:
    _print(mtls.init_ca(args.dir, cn=args.cn))
    return 0


def cmd_certs_issue(args) -> int:
    _print(mtls.issue(args.dir, args.name, sans=args.san or [f"DNS:{args.name}"]))
    return 0


def cmd_certs_verify(args) -> int:
    _print(mtls.verify(args.dir, args.name))
    return 0


# ---------------------------------------------------------------- control / agent
def cmd_control(args) -> int:
    tls = _tls(args)
    policy = AdmissionPolicy.from_dict(json.loads(args.policy) if args.policy else None)
    node = ControlNode(
        node_id=args.node_id,
        host=args.host,
        port=args.port,
        peers=args.peers or [],
        tls=tls,
        token=args.token,
        policy=policy,
        advertise_url=args.advertise,
    ).start()
    print(f"[control:{args.node_id}] listening on {'https' if tls else 'http'}://{args.host}:{node.port} peers={node.peers}")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        node.stop()
        return 0


def cmd_agent(args) -> int:
    tls = _tls(args)
    policy = AdmissionPolicy.from_dict(json.loads(args.policy) if args.policy else None)
    agent = Agent(
        node_id=args.node_id,
        host=args.host,
        port=args.port,
        control_urls=args.control or [],
        plugins_dir=args.plugins or [str(ROOT / "examples" / "plugins")],
        tls=tls,
        token=args.token,
        policy=policy,
        mesh_ip=args.mesh_ip,
        extra_urls=args.advertise or [],
    ).start()
    print(
        f"[agent:{args.node_id}] listening on {agent.url} (advertise {agent.advertise_url()}) "
        f"caps={len(agent.caps)} plugins={len(agent.adapters)} errors={len(agent.plugin_errors)}"
    )
    for err in agent.plugin_errors:
        print(f"  plugin warning: {err}")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        agent.stop()
        return 0


# ---------------------------------------------------------------- UI 网关
def cmd_ui(args) -> int:
    """L6：给前端（DSH 插件）用的回环 REST 网关，控制面/节点都不需要改。"""
    from .ui_api import UiGateway

    tls = _tls(args)
    gateway = UiGateway(
        control=args.control,
        tls=tls,
        token=args.token,
        host=args.host,
        port=args.port,
        state_dir=args.state_dir,
        win_root_base=args.win_root_base,
        linux_root_base=args.linux_root_base,
        wait_seconds=args.wait,
        allow_origins=args.allow_origin or None,
    ).start()
    print(f"[ui] token file: {Path(args.state_dir) / 'token'}")
    print(f"[ui] health: http://{args.host}:{gateway.port}/api/health")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        gateway.stop()
        return 0


# ---------------------------------------------------------------- 任务
def cmd_submit(args) -> int:
    orch = Orchestrator(args.control, tls=_tls(args), token=args.token)
    caps_raw = args.caps or (Path(args.caps_file).read_text(encoding="utf-8") if args.caps_file else "")
    input_raw = args.input or (Path(args.input_file).read_text(encoding="utf-8") if args.input_file else "")
    caps = json.loads(caps_raw) if caps_raw else {}
    payload = json.loads(input_raw) if input_raw else {}
    submitted = orch.submit(caps, payload, timeout=args.timeout)
    print(f"submitted {submitted['task_id']} -> {submitted['status']}")
    if args.wait:
        result = orch.wait(submitted["task_id"], timeout=args.wait)
        _print(result)
        return 0 if result.get("status") == "done" else 1
    return 0


def cmd_status(args) -> int:
    orch = Orchestrator(args.control, tls=_tls(args), token=args.token)
    state = orch.state()
    if args.json:
        _print(state)
        return 0
    router = state["router"]
    print(f"router {router['node_id']} peers={router['peers']} quorum={router['quorum']} policy={router['policy']}")
    print("\nnodes:")
    for node in state["nodes"]:
        metrics = node.get("metrics") or {}
        print(
            f"  {node['node_id']:<12} {node.get('os', '?'):<8} mesh={node.get('mesh_ip') or '-':<12} "
            f"alive={node.get('alive')} caps={node.get('caps')} "
            f"cpu={metrics.get('cpu_percent')}% mem={metrics.get('mem_percent')}% workers={metrics.get('workers')}"
        )
    print(f"\ncapabilities: {len(state['capabilities'])}")
    for cap in state["capabilities"]:
        print(f"  {cap['cap_id']:<40} node={cap['node_id']:<12} kind={cap['kind']}")
    print(f"\ntasks: {len(state['tasks'])}")
    for task in state["tasks"][-10:]:
        print(f"  {task['id']:<14} {task['status']:<9} node={task.get('node_id')} cap={task.get('cap_id')}")
    return 0


def cmd_caps(args) -> int:
    orch = Orchestrator(args.control, tls=_tls(args), token=args.token)
    state = orch.state()
    _print({"capabilities": state["capabilities"]})
    return 0


# ---------------------------------------------------------------- demo
def cmd_demo(args) -> int:
    """本机单进程演示：1 控制面 + 1 Agent + 一次任务，打印全链路。"""
    from . import l4_adapters

    plugins = Path(args.plugins)
    control = ControlNode(node_id="demo-router", host="127.0.0.1", port=0, policy=AdmissionPolicy(max_workers=4)).start()
    agent = Agent(
        node_id="demo-node",
        host="127.0.0.1",
        port=0,
        control_urls=[f"http://127.0.0.1:{control.port}"],
        plugins_dir=str(plugins),
        mesh_ip="127.0.0.1",
        policy=AdmissionPolicy(max_workers=4),
        metrics_interval=0.5,
        heartbeat_interval=1.0,
    ).start()
    try:
        time.sleep(1.5)
        orch = Orchestrator(f"http://127.0.0.1:{control.port}")
        caps = [c["cap_id"] for c in orch.state()["capabilities"]]
        print("capabilities:", caps)
        target = next((c for c in caps if c.startswith("skill:")), caps[0] if caps else None)
        if target is None:
            print("no capabilities loaded; check --plugins")
            return 2
        submitted = orch.submit({"cap_ids": [target]}, {"text": "hello cluster"}, timeout=15)
        result = orch.wait(submitted["task_id"], timeout=20)
        _print({"task": result})
        return 0 if result.get("status") == "done" else 1
    finally:
        agent.stop()
        control.stop()


def cmd_selfcheck(args) -> int:
    """跑一遍内置断言（不依赖网络），再跑 unittest。"""
    from .selfcheck import run_selfcheck

    ok = run_selfcheck(verbose=True)
    if not ok:
        return 1
    if args.with_unittest:
        proc = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
            cwd=str(ROOT),
            **winproc.hidden_kwargs(),
        )
        return proc.returncode
    return 0


# ---------------------------------------------------------------- 解析
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cluster", description="分布式多机 Agent 集群（L0 EasyTier → L5 编排）")
    sub = parser.add_subparsers(dest="command", required=True)

    net = sub.add_parser("net", help="L0 网络层（EasyTier / frp）")
    net_sub = net.add_subparsers(dest="net_cmd", required=True)

    p = net_sub.add_parser("fetch", help="下载当前平台的 EasyTier 二进制到 .cache/")
    p.add_argument("--version", default=l0_network.EASYTIER_VERSION)
    p.set_defaults(func=cmd_net_fetch)

    p = net_sub.add_parser("init", help="生成 EasyTier TOML 配置")
    p.add_argument("--network", default="cluster-lab")
    p.add_argument("--secret", required=True)
    p.add_argument("--mesh-ip", required=True)
    p.add_argument("--peer", action="append")
    p.add_argument("--listen", action="append")
    p.add_argument("--no-tun", action="store_true")
    p.add_argument("--smoltcp", action="store_true")
    p.add_argument("--need-p2p", action="store_true")
    p.add_argument("--lazy-p2p", action="store_true")
    p.add_argument("--udp-broadcast", action="store_true")
    p.add_argument("--proxy-network", action="append")
    p.add_argument("--hostname")
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_net_init)

    p = net_sub.add_parser("up", help="用配置启动 easytier-core")
    p.add_argument("--config", required=True)
    p.add_argument("--log")
    p.add_argument("--detach", action="store_true")
    p.set_defaults(func=cmd_net_up)

    p = net_sub.add_parser("status", help="打印 peer 表并落盘证据")
    p.add_argument("--json", action="store_true")
    p.add_argument("--out")
    p.set_defaults(func=cmd_net_status)

    p = net_sub.add_parser("forward", help="管理 port-forward（no-tun 节点访问对端）")
    p.add_argument("--proto", default="tcp", choices=["tcp", "udp"])
    p.add_argument("--bind")
    p.add_argument("--dst")
    p.add_argument("--list", action="store_true")
    p.set_defaults(func=cmd_net_forward)

    p = net_sub.add_parser("frp", help="生成方案二（中心化）的 frps/frpc 模板")
    p.add_argument("--host-ip", required=True)
    p.add_argument("--token", default="<换成足够长的随机串>")
    p.add_argument("--out", default=str(STATE / "frp"))
    p.set_defaults(func=cmd_net_frp)

    certs = sub.add_parser("certs", help="mTLS 自签 CA 与节点证书")
    cert_sub = certs.add_subparsers(dest="certs_cmd", required=True)
    p = cert_sub.add_parser("init")
    p.add_argument("--dir", default=str(STATE / "tls"))
    p.add_argument("--cn", default="cluster-ca")
    p.set_defaults(func=cmd_certs_init)
    p = cert_sub.add_parser("issue")
    p.add_argument("--dir", default=str(STATE / "tls"))
    p.add_argument("--name", required=True)
    p.add_argument("--san", action="append")
    p.set_defaults(func=cmd_certs_issue)
    p = cert_sub.add_parser("verify")
    p.add_argument("--dir", default=str(STATE / "tls"))
    p.add_argument("--name", required=True)
    p.set_defaults(func=cmd_certs_verify)

    p = sub.add_parser("control", help="L2 控制面（多副本，对等）")
    p.add_argument("--node-id", required=True)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=18100)
    p.add_argument("--peers", action="append", help="其他控制面副本 URL")
    p.add_argument("--tls-dir")
    p.add_argument("--cert-name")
    p.add_argument("--token")
    p.add_argument("--policy", help="JSON：{cpu_percent_max,mem_percent_max,max_workers}")
    p.add_argument("--advertise")
    p.set_defaults(func=cmd_control)

    p = sub.add_parser("agent", help="L1 Node Agent")
    p.add_argument("--node-id", required=True)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=17100)
    p.add_argument("--control", action="append", help="控制面 URL，可多个")
    p.add_argument("--plugins", action="append", default=None, help="插件目录，可多次给")
    p.add_argument("--tls-dir")
    p.add_argument("--cert-name")
    p.add_argument("--token")
    p.add_argument("--mesh-ip")
    p.add_argument("--advertise", action="append", help="额外可达地址（如 underlay IP），可多次给")
    p.add_argument("--policy")
    p.set_defaults(func=cmd_agent)

    p = sub.add_parser("ui", help="L6 前端网关（回环 HTTP，给 DSH 插件用）")
    p.add_argument("--control", required=True, help="控制面 URL，如 https://127.0.0.1:18100")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=18150)
    p.add_argument("--state-dir", default=str(STATE / "ui"))
    p.add_argument("--win-root-base", default=str(STATE / "workspaces"))
    p.add_argument("--linux-root-base", default="~/cluster-test/workspaces")
    p.add_argument("--wait", type=float, default=8.0, help="Router 对话里等任务结束的秒数")
    p.add_argument("--allow-origin", action="append", help="额外允许的浏览器 Origin")
    p.add_argument("--tls-dir")
    p.add_argument("--cert-name")
    p.add_argument("--token")
    p.set_defaults(func=cmd_ui)

    p = sub.add_parser("submit", help="提交任务")
    p.add_argument("--control", required=True)
    p.add_argument("--caps", help='JSON：{"cap_ids":["skill:uppercase@1.0.0"]} 或 {"all_of":[...]}')
    p.add_argument("--caps-file", help="从文件读 required_caps JSON（Windows 传参更稳）")
    p.add_argument("--input", help="JSON 输入")
    p.add_argument("--input-file", help="从文件读 input JSON")
    p.add_argument("--timeout", type=float, default=30)
    p.add_argument("--wait", type=float, default=0)
    p.add_argument("--tls-dir")
    p.add_argument("--cert-name")
    p.add_argument("--token")
    p.set_defaults(func=cmd_submit)

    p = sub.add_parser("status", help="看集群状态")
    p.add_argument("--control", required=True)
    p.add_argument("--json", action="store_true")
    p.add_argument("--tls-dir")
    p.add_argument("--cert-name")
    p.add_argument("--token")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("caps", help="导出能力注册表")
    p.add_argument("--control", required=True)
    p.add_argument("--tls-dir")
    p.add_argument("--cert-name")
    p.add_argument("--token")
    p.set_defaults(func=cmd_caps)

    p = sub.add_parser("demo", help="本机单进程闭环演示")
    p.add_argument("--plugins", default=str(ROOT / "examples" / "plugins"))
    p.set_defaults(func=cmd_demo)

    p = sub.add_parser("selfcheck", help="内置断言 + 单元测试")
    p.add_argument("--with-unittest", action="store_true")
    p.set_defaults(func=cmd_selfcheck)

    return parser


def main(argv: list[str] | None = None) -> int:
    _utf8_console()
    args = build_parser().parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
