"""端到端与 mTLS 测试：全部跑在 127.0.0.1 的随机端口上。"""

import json
import shutil
import socket
import tempfile
import time
import unittest
from pathlib import Path

from cluster import httpjson
from cluster.l1_agent import Agent
from cluster.l2_control import ControlNode, QuorumLedger
from cluster.l5_orchestrator import Orchestrator
from cluster.policy import AdmissionPolicy

ROOT = Path(__file__).resolve().parent.parent


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class TestControlAgentLoop(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.control = ControlNode(node_id="it-router", host="127.0.0.1", port=free_port(), dispatch_interval=0.2).start()
        tmp = Path(tempfile.mkdtemp(prefix="cluster-it-"))
        cls.tmp = tmp
        shutil.copytree(ROOT / "examples" / "plugins", tmp / "plugins")
        spec = tmp / "plugins" / "apis" / "cluster-health.yaml"
        spec.write_text(
            spec.read_text(encoding="utf-8").replace("http://127.0.0.1:18100", f"http://127.0.0.1:{cls.control.port}"),
            encoding="utf-8",
        )
        cls.agent = Agent(
            node_id="it-node",
            host="127.0.0.1",
            port=free_port(),
            control_urls=[f"http://127.0.0.1:{cls.control.port}"],
            plugins_dir=str(tmp / "plugins"),
            mesh_ip="127.0.0.1",
            metrics_interval=0.4,
            heartbeat_interval=0.8,
            policy=AdmissionPolicy(max_workers=4),
        ).start()
        cls.orch = Orchestrator(f"http://127.0.0.1:{cls.control.port}")
        time.sleep(1.0)

    @classmethod
    def tearDownClass(cls):
        cls.agent.stop()
        cls.control.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_registry_has_three_kinds(self):
        state = self.orch.state()
        kinds = {cap["kind"] for cap in state["capabilities"]}
        node = next(n for n in state["nodes"] if n["node_id"] == "it-node")
        self.assertEqual(kinds, {"skill", "mcp", "api"}, f"plugin_errors={node.get('plugin_errors')}")
        self.assertTrue(node["alive"])
        self.assertIsNotNone(node["metrics"]["cpu_percent"])

    def test_task_wait_for_short_cap_id(self):
        submitted = self.orch.submit({"all_of": ["uppercase"]}, {"text": "abc"}, timeout=10)
        result = self.orch.wait(submitted["task_id"], timeout=15)
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["output"]["upper"], "ABC")
        self.assertEqual(result["elapsed_ms"] >= 0, True)

    def test_unknown_capability_is_queued_with_reason(self):
        submitted = self.orch.submit({"cap_ids": ["nope:nothing@0"]}, {}, timeout=10)
        time.sleep(1.0)
        record = self.orch.task(submitted["task_id"])
        self.assertEqual(record["status"], "queued")
        self.assertIn("capability", (record.get("reason") or "").lower())

    def test_agent_local_admission_rejects(self):
        agent_url = f"http://127.0.0.1:{self.agent.port}"
        self.agent.policy = AdmissionPolicy(cpu_percent_max=0, mem_percent_max=0, max_workers=0)
        response = httpjson.request_json(
            f"{agent_url}/tasks", {"id": "t-reject", "required_caps": {"all_of": ["uppercase"]}, "input": {"text": "x"}}
        )
        self.assertFalse(response["accepted"])
        self.assertIn("admission", response["reason"])
        self.agent.policy = AdmissionPolicy(max_workers=4)

    def test_invoke_endpoint(self):
        url = f"http://127.0.0.1:{self.agent.port}/invoke"
        response = httpjson.request_json(url, {"cap_id": "skill:uppercase@1.0.0", "args": {"text": "mtls"}})
        self.assertTrue(response["ok"])
        self.assertEqual(response["output"]["upper"], "MTLS")

    def test_dashboard_served(self):
        raw = httpjson.request_json(f"http://127.0.0.1:{self.control.port}/control/state")
        self.assertIn("router", raw)
        import urllib.request

        with urllib.request.urlopen(f"http://127.0.0.1:{self.control.port}/", timeout=5) as resp:
            body = resp.read().decode("utf-8")
        self.assertIn("集群面板", body)


class TestQuorumLedger(unittest.TestCase):
    def test_quorum_claim_single_winner(self):
        ports = [free_port() for _ in range(3)]
        urls = [f"http://127.0.0.1:{p}" for p in ports]
        nodes = [
            ControlNode(
                node_id=f"q{i}",
                host="127.0.0.1",
                port=ports[i],
                peers=[u for u in urls if u != urls[i]],
                dispatch_interval=5,
            )
            for i in range(3)
        ]
        for node in nodes:
            node.start()
        try:
            time.sleep(0.3)
            results = []
            import threading

            def claim(node):
                results.append(node.ledger.cas("claims/t1", 0, {"router": node.node_id}))

            threads = [threading.Thread(target=claim, args=(nodes[i],)) for i in (0, 1)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertEqual(sum(1 for r in results if r), 1)
            time.sleep(1.3)
            values = {json.dumps(n.ledger.get("claims/t1").value, sort_keys=True) for n in nodes}
            self.assertEqual(len(values), 1)
        finally:
            for node in nodes:
                node.stop()

    def test_quorum_size(self):
        ledger = QuorumLedger("a", ["http://p1", "http://p2"], None, None)
        self.assertEqual(ledger.quorum, 2)
        self.assertEqual(QuorumLedger("a", [], None, None).quorum, 1)


class TestMTLS(unittest.TestCase):
    def test_mutual_tls(self):
        from cluster import mtls

        tmp = Path(tempfile.mkdtemp(prefix="cluster-tls-"))
        try:
            mtls.init_ca(tmp)
            mtls.issue(tmp, "srv", sans=["IP:127.0.0.1"])
            mtls.issue(tmp, "cli", sans=["DNS:cli"])
            port = free_port()
            server = httpjson.Server(
                "127.0.0.1",
                port,
                lambda m, p, b: (200, {"ok": True, "path": p}),
                tls=httpjson.TLSOptions(
                    cafile=str(tmp / "ca.crt"),
                    certfile=str(tmp / "srv.crt"),
                    keyfile=str(tmp / "srv.key"),
                    require_client_cert=True,
                ),
            ).start()
            try:
                good = httpjson.TLSOptions(
                    cafile=str(tmp / "ca.crt"), certfile=str(tmp / "cli.crt"), keyfile=str(tmp / "cli.key")
                )
                self.assertTrue(httpjson.get_json(f"https://127.0.0.1:{port}/x", tls=good)["ok"])
                with self.assertRaises(Exception):
                    httpjson.get_json(f"https://127.0.0.1:{port}/x", tls=httpjson.TLSOptions(cafile=str(tmp / "ca.crt")))
            finally:
                server.stop()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
