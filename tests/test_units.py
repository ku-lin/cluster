import json
import threading
import time
import unittest

from cluster.l2_control import Entry, Ledger
from cluster.l3_capability import Capability, dedupe, find
from cluster.l4_adapters import SkillAdapter, load_plugins, parse_yaml
from cluster.metrics import MetricsCollector
from cluster.policy import AdmissionPolicy, admission_ok


class TestCapability(unittest.TestCase):
    def make(self, **kw):
        base = dict(cap_id="skill:upper@1.0.0", kind="skill", name="upper", version="1.0.0")
        base.update(kw)
        return Capability(**base)

    def test_validate_ok(self):
        self.assertEqual(self.make().validate(), [])

    def test_validate_rejects_bad_kind_and_id(self):
        problems = Capability(cap_id="", kind="weird", name="").validate()
        self.assertGreaterEqual(len(problems), 3)

    def test_validate_rejects_non_object_schema(self):
        problems = self.make(input_schema={"type": "array"}).validate()
        self.assertTrue(any("input_schema" in p for p in problems))

    def test_matching_queries(self):
        cap = self.make(tags=["demo"])
        self.assertTrue(cap.matches(None))
        self.assertTrue(cap.matches({"cap_ids": ["skill:upper@1.0.0"]}))
        self.assertTrue(cap.matches({"all_of": ["upper"]}))
        self.assertTrue(cap.matches({"any_of": ["nope", "upper"]}))
        self.assertTrue(cap.matches({"kind": "SKILL"}))
        self.assertTrue(cap.matches({"tags": ["demo"]}))
        self.assertFalse(cap.matches({"kind": "api"}))
        self.assertFalse(cap.matches({"cap_ids": ["other"]}))
        self.assertFalse(cap.matches({"all_of": ["upper", "missing"]}))

    def test_down_health_not_matched(self):
        cap = self.make(health={"status": "down"})
        self.assertFalse(cap.matches({"kind": "skill"}))

    def test_env_requirement(self):
        cap = self.make(requirements={"os": ["linux"]})
        self.assertTrue(cap.matches({}, {"os": "linux"}))
        self.assertFalse(cap.matches({}, {"os": "windows"}))

    def test_roundtrip_and_helpers(self):
        cap = self.make()
        again = Capability.from_dict(cap.to_dict())
        self.assertEqual(again.cap_id, cap.cap_id)
        self.assertEqual(len(find([cap], {"kind": "skill"})), 1)
        self.assertEqual(len(dedupe([cap, cap])), 1)


class TestLedger(unittest.TestCase):
    def test_put_bumps_version(self):
        ledger = Ledger()
        self.assertEqual(ledger.version("k"), 0)
        self.assertEqual(ledger.put("k", {"a": 1}).version, 1)
        self.assertEqual(ledger.put("k", {"a": 2}).version, 2)

    def test_cas_conflict(self):
        ledger = Ledger()
        ledger.put("k", "v1")
        base = ledger.version("k")
        self.assertTrue(ledger.cas("k", base, "winner"))
        self.assertFalse(ledger.cas("k", base, "loser"))
        self.assertEqual(ledger.get("k").value, "winner")

    def test_single_winner_under_threads(self):
        ledger = Ledger()
        ledger.put("k", "init")
        base = ledger.version("k")
        wins = []
        lock = threading.Lock()

        def race(i):
            if ledger.cas("k", base, i):
                with lock:
                    wins.append(i)

        threads = [threading.Thread(target=race, args=(i,)) for i in range(16)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(wins), 1)

    def test_merge_takes_higher_version(self):
        a, b = Ledger(), Ledger()
        a.put("k", "a1")
        a.put("k", "a2")
        b.put("k", "b1")
        changed = b.merge(a.dump())
        self.assertGreaterEqual(changed, 1)
        self.assertEqual(b.get("k").value, "a2")

    def test_merge_is_deterministic_on_tie(self):
        a, b = Ledger(), Ledger()
        a._data["k"] = Entry(version=1, value="x", ts=0)
        b._data["k"] = Entry(version=1, value="y", ts=0)
        b.merge(a.dump())
        first = b.get("k").value
        a.merge(b.dump())
        self.assertEqual(a.get("k").value, first)


class TestAdmission(unittest.TestCase):
    def test_limits(self):
        policy = AdmissionPolicy(cpu_percent_max=80, mem_percent_max=80, max_workers=2)
        self.assertTrue(admission_ok({"cpu_percent": 10, "mem_percent": 10, "workers": 0}, policy)[0])
        self.assertFalse(admission_ok({"cpu_percent": 90, "mem_percent": 10, "workers": 0}, policy)[0])
        self.assertFalse(admission_ok({"cpu_percent": 10, "mem_percent": 95, "workers": 0}, policy)[0])
        self.assertFalse(admission_ok({"cpu_percent": 1, "mem_percent": 1, "workers": 2}, policy)[0])

    def test_missing_metrics_fail_open(self):
        self.assertTrue(admission_ok(None, AdmissionPolicy())[0])

    def test_headroom(self):
        policy = AdmissionPolicy(cpu_percent_max=100, mem_percent_max=100)
        self.assertFalse(admission_ok({"cpu_percent": 85, "mem_percent": 1, "workers": 0}, policy, headroom=0.2)[0])

    def test_from_dict(self):
        policy = AdmissionPolicy.from_dict({"cpu_percent_max": 55, "max_workers": 1})
        self.assertEqual(policy.cpu_percent_max, 55)
        self.assertEqual(policy.max_workers, 1)


class TestYamlAndAdapters(unittest.TestCase):
    def test_parse_yaml_subset(self):
        data = parse_yaml(
            """
name: demo
version: "1.0.0"
list: [a, b, c]
nested:
  type: object
  properties:
    text: {type: string}
flag: true
count: 3
items:
  - one
  - two
"""
        )
        self.assertEqual(data["name"], "demo")
        self.assertEqual(data["list"], ["a", "b", "c"])
        self.assertEqual(data["nested"]["properties"]["text"]["type"], "string")
        self.assertTrue(data["flag"])
        self.assertEqual(data["count"], 3)
        self.assertEqual(data["items"], ["one", "two"])

    def test_skill_adapter_invoke(self):
        import json as _json
        from pathlib import Path

        root = Path(__file__).resolve().parent.parent / "examples" / "plugins" / "skills" / "uppercase"
        adapter = SkillAdapter({"name": "upper", "command": ["python", "run.py"]}, str(root / "skill.yaml"))
        result = adapter.invoke("upper", {"text": "abc", "reverse": True})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["output"]["upper"], "ABC")
        self.assertEqual(result["output"]["reversed"], "cba")
        self.assertIsInstance(_json.dumps(result["output"]), str)

    def test_skill_adapter_reports_failure(self):
        adapter = SkillAdapter({"name": "bad", "command": ["python", "-c", "raise SystemExit(3)"]}, "")
        result = adapter.invoke("bad", {})
        self.assertFalse(result["ok"])
        self.assertIn("exit 3", result["error"])

    def test_load_plugins_errors(self):
        adapters, errors = load_plugins("C:/definitely/not/here")
        self.assertEqual(adapters, [])
        self.assertTrue(errors)


class TestMetrics(unittest.TestCase):
    def test_sample_shape(self):
        collector = MetricsCollector()
        collector.sample()
        time.sleep(0.15)
        sample = collector.sample()
        for key in ("cpu_percent", "mem_percent", "mem_total_mb", "os", "ts"):
            self.assertIn(key, sample)
        self.assertGreater(sample["mem_total_mb"], 0)
        self.assertGreaterEqual(sample["cpu_percent"], 0)
        self.assertLessEqual(sample["cpu_percent"], 100)


if __name__ == "__main__":
    unittest.main()
