"""内置自检：不依赖外部网络，把 L0~L5 的关键不变量跑一遍。

`python -m cluster selfcheck` 会执行这里的 run_selfcheck()，
覆盖：指标采样、能力描述符、CAS 唯一赢家、三副本 quorum 认领、准入、三种适配器、端到端任务。
"""

from __future__ import annotations

import json
import shutil
import socket
import tempfile
import threading
import time
from pathlib import Path

from . import httpjson
from .l2_control import ControlNode, Ledger, QuorumLedger
from .l3_capability import Capability
from .l4_adapters import McpAdapter, SkillAdapter, load_plugins
from .l5_orchestrator import Orchestrator
from .l1_agent import Agent
from .metrics import MetricsCollector
from .policy import AdmissionPolicy, admission_ok

ROOT = Path(__file__).resolve().parent.parent
RESULTS: list[tuple[str, bool, str]] = []


def _record(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail and not ok else ""))
    return ok


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


# ---------------------------------------------------------------- 单项检查
def check_metrics() -> bool:
    collector = MetricsCollector()
    first = collector.sample()
    time.sleep(0.2)
    second = collector.sample()
    ok = (
        second.get("cpu_percent") is not None
        and second.get("mem_percent") is not None
        and second.get("mem_total_mb", 0) > 0
        and second.get("os") in ("windows", "linux", "darwin")
    )
    return _record("L1 metrics sample", ok, json.dumps({k: second.get(k) for k in ("cpu_percent", "mem_percent", "net_unit")}))


def check_capability() -> bool:
    cap = Capability(
        cap_id="skill:uppercase@1.0.0",
        kind="skill",
        name="uppercase",
        version="1.0.0",
        input_schema={"type": "object", "properties": {"text": {"type": "string"}}},
        requirements={"os": ["windows", "linux"]},
        cost_model={"est_cpu_ms": 20, "est_mem_mb": 32},
        tags=["demo"],
    )
    ok = (
        not cap.validate()
        and cap.matches({"cap_ids": ["skill:uppercase@1.0.0"]})
        and cap.matches({"any_of": ["uppercase"]})
        and not cap.matches({"kind": "api"})
        and not cap.matches({"cap_ids": ["skill:other"]})
    )
    bad = Capability(cap_id="", kind="nope", name="")
    ok = ok and len(bad.validate()) >= 3
    return _record("L3 capability descriptor", ok)


def check_ledger_cas() -> bool:
    ledger = Ledger()
    ledger.put("k", {"v": 0})
    base = ledger.version("k")
    winners: list[int] = []
    lock = threading.Lock()

    def race(i: int) -> None:
        if ledger.cas("k", base, {"winner": i}):
            with lock:
                winners.append(i)

    threads = [threading.Thread(target=race, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    ok = len(winners) == 1 and ledger.get("k").value == {"winner": winners[0]}
    return _record("L2 CAS 唯一赢家（8 线程）", ok, f"winners={winners}")


def check_quorum() -> bool:
    """三副本：两个 Router 并发认领同一任务，只能有一个赢。"""
    ports = [free_port() for _ in range(3)]
    urls = [f"http://127.0.0.1:{p}" for p in ports]
    nodes = [
        ControlNode(node_id=f"q{i}", host="127.0.0.1", port=ports[i], peers=[u for u in urls if u != urls[i]], dispatch_interval=5)
        for i in range(3)
    ]
    for node in nodes:
        node.start()
    try:
        time.sleep(0.4)
        task_id = "t-quorum"
        base = 0
        results: list[bool] = []
        lock = threading.Lock()

        def claim(node: ControlNode) -> None:
            got = node.ledger.cas(f"claims/{task_id}", base, {"router": node.node_id})
            with lock:
                results.append(got)

        threads = [threading.Thread(target=claim, args=(nodes[i],)) for i in (0, 1)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        time.sleep(1.4)  # 等 anti-entropy 收敛
        values = [node.ledger.get(f"claims/{task_id}").value for node in nodes]
        winners = sum(1 for r in results if r)
        converged = len({json.dumps(v, sort_keys=True) for v in values}) == 1
        ok = winners == 1 and results.count(False) == 1 and converged
        return _record("L2 quorum CAS（3 副本并发认领唯一赢家 + 收敛）", ok, f"winners={winners} values={values}")
    finally:
        for node in nodes:
            node.stop()


def check_admission() -> bool:
    policy = AdmissionPolicy(cpu_percent_max=80, mem_percent_max=80, max_workers=2)
    busy, why = admission_ok({"cpu_percent": 95, "mem_percent": 10, "workers": 0}, policy)
    full, why2 = admission_ok({"cpu_percent": 1, "mem_percent": 1, "workers": 2}, policy)
    fine, _ = admission_ok({"cpu_percent": 10, "mem_percent": 10, "workers": 1}, policy)
    ok = (not busy) and (not full) and fine
    return _record("L2/L5 准入控制", ok, f"{why} / {why2}")


def check_adapters() -> bool:
    plugins = ROOT / "examples" / "plugins"
    adapters, errors = load_plugins(plugins)
    kinds = {a.kind for a in adapters}
    ok = {"skill", "mcp"} <= kinds and not errors

    skill = next((a for a in adapters if a.kind == "skill"), None)
    if skill is not None:
        result = skill.invoke(skill.name, {"text": "cluster"})
        ok = ok and result["ok"] and result["output"].get("upper") == "CLUSTER"

    mcp = next((a for a in adapters if a.kind == "mcp"), None)
    if mcp is not None:
        try:
            caps = mcp.describe()
            tool = next((c.tool for c in caps if c.tool == "add"), caps[0].tool if caps else None)
            if tool == "add":
                res = mcp.invoke("add", {"a": 2, "b": 3})
                ok = ok and res["ok"] and "5" in json.dumps(res["output"])
            else:
                ok = ok and bool(caps)
        finally:
            mcp.close()
    return _record("L4 适配器（skill + mcp）", ok, "; ".join(errors))


def check_end_to_end() -> bool:
    """控制面 + Agent（真插件）→ 跨层任务闭环。"""
    control = ControlNode(node_id="selfcheck-router", host="127.0.0.1", port=free_port(), dispatch_interval=0.2).start()
    tmp = Path(tempfile.mkdtemp(prefix="cluster-plugins-"))
    try:
        shutil.copytree(ROOT / "examples" / "plugins", tmp / "plugins")
        api_spec = tmp / "plugins" / "apis" / "cluster-health.yaml"
        api_spec.write_text(
            api_spec.read_text(encoding="utf-8").replace("http://127.0.0.1:18100", f"http://127.0.0.1:{control.port}"),
            encoding="utf-8",
        )
        agent = Agent(
            node_id="selfcheck-node",
            host="127.0.0.1",
            port=free_port(),
            control_urls=[f"http://127.0.0.1:{control.port}"],
            plugins_dir=str(tmp / "plugins"),
            mesh_ip="127.0.0.1",
            metrics_interval=0.5,
            heartbeat_interval=1.0,
        ).start()
        try:
            time.sleep(1.2)
            orch = Orchestrator(f"http://127.0.0.1:{control.port}")
            state = orch.state()
            cap_ids = {c["cap_id"] for c in state["capabilities"]}
            ok = any(c.startswith("skill:uppercase") for c in cap_ids) and any(c.startswith("mcp:echo") for c in cap_ids)
            ok = ok and any(c.startswith("api:cluster-health") for c in cap_ids)

            skill_task = orch.submit({"cap_ids": ["skill:uppercase@1.0.0"]}, {"text": "hello cluster"}, timeout=15)
            skill_result = orch.wait(skill_task["task_id"], timeout=20)
            ok = ok and skill_result.get("status") == "done" and skill_result["output"]["upper"] == "HELLO CLUSTER"

            mcp_task = orch.submit({"all_of": ["echo/add"]}, {"a": 40, "b": 2}, timeout=15)
            mcp_result = orch.wait(mcp_task["task_id"], timeout=20)
            ok = ok and mcp_result.get("status") == "done" and "42" in json.dumps(mcp_result.get("output"))

            api_task = orch.submit({"cap_ids": ["api:cluster-health@1.0.0"]}, {}, timeout=15)
            api_result = orch.wait(api_task["task_id"], timeout=20)
            ok = ok and api_result.get("status") == "done" and api_result.get("output", {}).get("ok") is True

            dispatch = orch.state()["dispatch_log"]
            ok = ok and any(item.get("event") == "dispatched" for item in dispatch)
            return _record("端到端：控制面 + Agent + skill/mcp/api 三种能力", ok, json.dumps(dispatch[-2:], ensure_ascii=False))
        finally:
            agent.stop()
    finally:
        control.stop()
        shutil.rmtree(tmp, ignore_errors=True)


def check_orchestrator_capacity() -> bool:
    control = ControlNode(node_id="cap-router", host="127.0.0.1", port=free_port(), dispatch_interval=0.2).start()
    try:
        agent = Agent(
            node_id="cap-node",
            host="127.0.0.1",
            port=free_port(),
            control_urls=[f"http://127.0.0.1:{control.port}"],
            plugins_dir=str(ROOT / "examples" / "plugins"),
            mesh_ip="127.0.0.1",
            metrics_interval=0.5,
            heartbeat_interval=1.0,
        ).start()
        try:
            time.sleep(1.0)
            orch = Orchestrator(f"http://127.0.0.1:{control.port}")
            capacity = orch.capacity({"cap_ids": ["skill:uppercase@1.0.0"]}, headroom=0.0)
            ok = len(capacity["ready"]) >= 1 and capacity["blocked"] == []
            spawned = orch.maybe_spawn_subagent({"cap_ids": ["skill:uppercase@1.0.0"]}, {"text": "auto"}, headroom=0.0)
            ok = ok and spawned["spawned"] and spawned["task"]["task_id"]
            deferred = orch.maybe_spawn_subagent({"cap_ids": ["skill:does-not-exist@0"]}, {}, headroom=0.5)
            ok = ok and not deferred["spawned"] and deferred["reason"] == "insufficient_capacity"
            return _record("L5 按实时容量决定是否开子智能体", ok, json.dumps(capacity["ready"][:1], ensure_ascii=False))
        finally:
            agent.stop()
    finally:
        control.stop()


def check_tls() -> bool:
    """自签 CA + 双向认证：无证书客户端必须被拒。"""
    from . import mtls

    try:
        tmp = Path(tempfile.mkdtemp(prefix="cluster-tls-"))
    except OSError:
        return _record("mTLS 双向认证", False, "tmpdir failed")
    try:
        mtls.init_ca(tmp)
        mtls.issue(tmp, "srv", sans=["IP:127.0.0.1", "DNS:localhost"])
        mtls.issue(tmp, "cli", sans=["DNS:cli"])
        server_tls = httpjson.TLSOptions(
            cafile=str(tmp / "ca.crt"), certfile=str(tmp / "srv.crt"), keyfile=str(tmp / "srv.key"), require_client_cert=True
        )
        port = free_port()
        server = httpjson.Server("127.0.0.1", port, lambda m, p, b: (200, {"ok": True}), tls=server_tls).start()
        try:
            good = httpjson.TLSOptions(
                cafile=str(tmp / "ca.crt"), certfile=str(tmp / "cli.crt"), keyfile=str(tmp / "cli.key")
            )
            resp = httpjson.get_json(f"https://127.0.0.1:{port}/", tls=good)
            if resp.get("ok") is not True:
                return _record("mTLS 双向认证", False, "带证书请求失败")
            refused = False
            try:
                httpjson.get_json(f"https://127.0.0.1:{port}/", tls=httpjson.TLSOptions(cafile=str(tmp / "ca.crt")))
            except Exception:  # noqa: BLE001 - 预期被拒
                refused = True
            return _record("mTLS 双向认证（无证书被拒）", refused)
        finally:
            server.stop()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


CHECKS = [
    check_metrics,
    check_capability,
    check_ledger_cas,
    check_admission,
    check_adapters,
    check_tls,
    check_quorum,
    check_end_to_end,
    check_orchestrator_capacity,
]


def run_selfcheck(verbose: bool = True) -> bool:
    RESULTS.clear()
    if verbose:
        print("cluster selfcheck")
    started = time.time()
    for check in CHECKS:
        try:
            check()
        except Exception as exc:  # noqa: BLE001 - 自检要跑完所有项
            _record(check.__name__, False, f"{type(exc).__name__}: {exc}")
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    total = len(RESULTS)
    if verbose:
        print(f"\n{passed}/{total} checks passed in {time.time() - started:.1f}s")
    return passed == total
