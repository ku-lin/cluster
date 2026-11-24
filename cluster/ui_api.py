"""L6（算 UI 网关）：给 DSH 插件用的最小 REST 契约，数据全部来自真实控制面与节点。

为什么单独一个进程，而不是塞进 ControlNode：
    控制面跑的是 mTLS（客户端要证书），浏览器/前端不能也不该拿节点私钥。
    这里在 127.0.0.1 上开一个**只有回环可达**的明文 HTTP 网关，由它持证书去访问
    控制面与各 Node Agent；DSH 插件（Node 侧）再把这个网关代理成同源 /cluster-ui/api/*。
    因此控制面一个字节都不用改，也不需要重启它。

鉴权：
    首次启动生成 `<state_dir>/ui/token`（随机 32 字节 hex）。
    除 GET /api/health 外，所有请求都要 `Authorization: Bearer <token>`。

契约（前端唯一依赖，改动要同步 dsh-plugin 与 README）：
    GET  /api/health
    GET  /api/cluster
    GET  /api/hosts                 -> 主机 + 指标 + 挂在它下面的 agents
    GET  /api/agents                -> 扁平 agents 列表
    GET  /api/tasks?limit=20
    GET  /api/router/transcript?limit=50
    POST /api/router/message        {"text": "..."}      -> 对话驱动任务（确定性快路径）
    GET  /api/router/snapshot                            -> 精简集群快照（LLM 系统提示用）
    GET  /api/router/status                              -> 任务/能力/同步状态（cluster_status 工具用）
    POST /api/router/dispatch       {"cap_id", "payload", "node", "fanout"}    -> 结构化下发（写）
    POST /api/router/sync           {"workspace", "policy", "confirm": true}   -> 工作区同步（写，需二次确认）
    POST /api/router/log            {"items": [...]}     -> LLM 回合写回面板 transcript
    GET  /api/workspaces
    POST /api/workspaces            {"name": "...", "policy": "newest", "seed": true}
    GET  /api/workspaces/<name>/tree?depth=1             -> 各节点文件清单（真实 manifest）
    POST /api/workspace/sync        {"workspace": "..."}
    GET  /api/workspace/sync/status[?run_id=...]
    POST /api/workspace/sync/retry  {"run_id": "..."}
"""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import httpjson, uisummary
from .httpjson import TLSOptions
from .l3_capability import Capability
from .l5_orchestrator import Orchestrator
from .wssync import WS_CAP, SyncEngine, WorkspaceError

ROOT = Path(__file__).resolve().parent.parent
MAX_BODY = 256 * 1024


class UiError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


class _Server:
    """带 header 与 CORS 的最小 HTTP 服务。

    cluster.httpjson.Server 只把 (method, path, body) 交给 dispatch，拿不到 header，
    而这个网关需要 `Authorization: Bearer` 与浏览器预检；所以这里单独实现一个，
    出站请求仍然复用 httpjson.request_json。
    """

    def __init__(self, host: str, port: int, dispatch, allow_origins: list[str]) -> None:
        self.host = host
        self._port = port
        self._dispatch = dispatch
        self._origins = set(allow_origins)
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        if self._httpd is None:
            return self._port
        return int(self._httpd.server_address[1])

    def start(self) -> "_Server":
        dispatch = self._dispatch
        origins = self._origins

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "cluster-ui/1.0.0"

            def _cors(self) -> None:
                origin = self.headers.get("origin")
                if origin and origin in origins:
                    self.send_header("access-control-allow-origin", origin)
                    self.send_header("access-control-allow-headers", "authorization, content-type, x-cluster-token")
                    self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
                    self.send_header("vary", "origin")

            def _write(self, status: int, obj: Any) -> None:
                payload = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json; charset=utf-8")
                self.send_header("content-length", str(len(payload)))
                self.send_header("cache-control", "no-store")
                self._cors()
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def _handle(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                if length > MAX_BODY:
                    self._write(413, {"error": f"请求体超过 {MAX_BODY} 字节"})
                    return
                body: Any = {}
                if raw:
                    try:
                        body = json.loads(raw.decode("utf-8"))
                    except ValueError:
                        self._write(400, {"error": "body 不是 JSON"})
                        return
                headers = {k.lower(): v for k, v in self.headers.items()}
                try:
                    status, obj = dispatch(self.command, self.path, body, headers)
                except Exception as exc:  # noqa: BLE001
                    status, obj = 500, {"error": f"{type(exc).__name__}: {exc}"}
                self._write(status, obj)

            def do_GET(self) -> None:
                self._handle()

            def do_POST(self) -> None:
                self._handle()

            def do_PUT(self) -> None:
                self._handle()

            def do_DELETE(self) -> None:
                self._handle()

            def do_OPTIONS(self) -> None:
                self.send_response(204)
                self._cors()
                self.send_header("content-length", "0")
                self.end_headers()

            def log_message(self, *args: Any) -> None:
                return

        httpd = ThreadingHTTPServer((self.host, self._port), Handler)
        httpd.daemon_threads = True
        self._httpd = httpd
        self._thread = threading.Thread(target=httpd.serve_forever, name="cluster-ui-http", daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._httpd is not None:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None


class UiGateway:
    def __init__(
        self,
        control: str,
        tls: TLSOptions | None = None,
        token: str | None = None,
        host: str = "127.0.0.1",
        port: int = 18150,
        state_dir: str = ".state/ui",
        win_root_base: str = str(ROOT / ".state" / "workspaces"),
        linux_root_base: str = "~/cluster-test/workspaces",
        wait_seconds: float = 8.0,
        allow_origins: list[str] | None = None,
        tls_dir: str | None = None,
        cert_name: str | None = None,
    ) -> None:
        self.control = control.rstrip("/")
        self.tls = tls
        # 只用于在设置页如实展示（目录名 + 证书名），不参与任何认证逻辑。
        self._tls_dir = tls_dir
        self._cert_name = cert_name
        self.token = token
        self.host = host
        self.port = port
        self.allow_origins = allow_origins or ["http://127.0.0.1:3080", "http://localhost:3080"]
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.ui_token = self._load_token()
        self.orch = Orchestrator(self.control, tls=tls, token=token)
        self.wait_seconds = wait_seconds
        self._server: httpjson.Server | None = None
        self._state_lock = threading.RLock()
        self._node_cache: tuple[float, list[dict]] = (0.0, [])
        self._ledger_cache: tuple[float, dict] = (0.0, {})
        self._url_cache: dict[str, tuple[str, float]] = {}
        self._control_cache: tuple[float, dict] = (0.0, {})
        # 首屏趋势图的数据源：网关自己每 N 秒采一次，环形缓冲只留在内存里。
        # 不落盘（重启就是从零开始），也不进控制面（高频指标不该占控制面 HTTP）。
        self.history: dict[str, list[dict]] = {}
        self.history_limit = 120
        self._history_thread: threading.Thread | None = None
        self._history_stop = threading.Event()
        self.transcript_path = self.state_dir / "router.json"
        self.transcript: list[dict] = self._load_transcript()
        self.sync = SyncEngine(
            state_path=self.state_dir / "workspaces.json",
            call_node=self.call_node,
            list_nodes=self.live_nodes,
            win_root_base=win_root_base,
            linux_root_base=linux_root_base,
            journal=lambda msg: print(f"[ui] {msg}", flush=True),
        )

    # ------------------------------------------------------------ 启动/停止
    def _load_token(self) -> str:
        path = self.state_dir / "token"
        if path.exists():
            token = path.read_text(encoding="utf-8").strip()
            if token:
                return token
        token = secrets.token_hex(24)
        path.write_text(token, encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
        return token

    def start(self) -> "UiGateway":
        self._server = _Server(self.host, self.port, self.dispatch, self.allow_origins)
        self._server.start()
        self.port = self._server.port
        self._start_history()
        print(f"[ui] gateway listening on http://{self.host}:{self.port} -> {self.control}", flush=True)
        return self

    def stop(self) -> None:
        self._history_stop.set()
        if self._history_thread is not None:
            self._history_thread.join(timeout=3)
            self._history_thread = None
        if self._server is not None:
            self._server.stop()
            self._server = None

    # ------------------------------------------------------------ 采样历史
    def _start_history(self, interval: float = 5.0) -> None:
        """后台每 interval 秒记一次各节点 CPU/内存，给首屏趋势图。

        刻意不复用 hosts_view：那个会顺带算 agents/tasks/插件错误，开销比这里需要的大。
        采不到（控制面抖动）就跳过这一拍，历史里留个空档，不要伪造 0。
        """
        if self._history_thread is not None:
            return

        def loop() -> None:
            while not self._history_stop.wait(interval):
                try:
                    state = self.control_state(fresh=True)
                except Exception:  # noqa: BLE001 - 采样线程不能带崩网关
                    continue
                for node in state.get("nodes") or []:
                    metrics = node.get("metrics") or {}
                    uisummary.push_point(
                        self.history,
                        str(node.get("node_id")),
                        {
                            "ts": metrics.get("ts") or time.time(),
                            "cpu": metrics.get("cpu_percent"),
                            "mem": metrics.get("mem_percent"),
                            "workers": metrics.get("workers"),
                        },
                        self.history_limit,
                    )

        self._history_stop.clear()
        self._history_thread = threading.Thread(target=loop, name="cluster-ui-history", daemon=True)
        self._history_thread.start()

    # ------------------------------------------------------------ 上游
    def control_state(self, fresh: bool = False) -> dict:
        now = time.time()
        if not fresh and now - self._control_cache[0] < 1.0 and self._control_cache[1]:
            return self._control_cache[1]
        try:
            state = self.orch.state()
        except httpjson.HttpError as exc:
            raise UiError(503, f"控制面不可达: {exc}") from None
        self._control_cache = (now, state)
        return state

    def live_nodes(self) -> list[dict]:
        now = time.time()
        if now - self._node_cache[0] < 1.0 and self._node_cache[1]:
            return self._node_cache[1]
        state = self.control_state()
        ledger = self._ledger()
        nodes = []
        for node in state.get("nodes", []):
            if not node.get("alive"):
                continue
            record = (ledger.get(f"nodes/{node.get('node_id')}") or {}).get("value") or {}
            urls = list(dict.fromkeys([*([record.get("url")] if record.get("url") else []),
                                       *list(record.get("urls") or []), *([node.get("url")] if node.get("url") else [])]))
            nodes.append({**node, "urls": urls})
        self._node_cache = (now, nodes)
        return nodes

    def _ledger(self) -> dict:
        """`/control/state` 不暴露节点登记的备用地址，`/control/dump` 有。

        Windows 侧 EasyTier 是 no-tun（到不了 mesh 网段），所以必须拿到 underlay 地址
        （如 https://<underlay-ip>:17100）才连得上节点；这些地址只存在于 ledger 里的
        nodes/<id> 记录中。dump 每 5 秒取一次，够用且不打爆控制面。
        """
        now = time.time()
        if now - self._ledger_cache[0] < 5.0 and self._ledger_cache[1]:
            return self._ledger_cache[1]
        try:
            dump = httpjson.get_json(f"{self.control}/control/dump", timeout=5.0, tls=self.tls)
        except httpjson.HttpError:
            return self._ledger_cache[1] or {}
        entries = dump.get("entries") or {}
        self._ledger_cache = (now, entries)
        return entries

    def node_url(self, node: dict, force: bool = False) -> str | None:
        """节点对外可能有好几个地址（mesh / underlay / 本地转发），按顺序探测一次并缓存。

        顺序很重要：Windows 的 EasyTier 是 no-tun，mesh 网段地址从这台机器根本
        不可达，先把 mesh 地址排到最后，避免每次首调都先等一次超时。
        """
        node_id = str(node.get("node_id"))
        urls = list(dict.fromkeys([u for u in ([node.get("url")] + list(node.get("urls") or [])) if u]))
        if not urls:
            return None
        mesh = str(node.get("mesh_ip") or "")
        urls.sort(key=lambda u: 1 if mesh and f"//{mesh}:" in u else 0)
        cached = self._url_cache.get(node_id)
        now = time.time()
        if cached and not force and now - cached[1] < 60:
            return cached[0]
        for url in urls:
            try:
                httpjson.get_json(f"{url}/health", timeout=1.5, tls=self.tls)
                self._url_cache[node_id] = (url, now)
                return url
            except httpjson.HttpError:
                continue
        return urls[0]

    def node_record(self, node_id: str) -> dict:
        for node in self.live_nodes():
            if str(node.get("node_id")) == node_id:
                return node
        raise UiError(404, f"节点不在线: {node_id}")

    def call_node(self, node_id: str, args: dict, timeout: float = 30.0, cap_id: str = WS_CAP) -> dict:
        """定向调用某个节点上的能力（走 Node Agent 的 /invoke，同步返回）。"""
        try:
            node = self.node_record(node_id)
        except UiError as exc:
            return {"ok": False, "error": str(exc), "output": None, "elapsed_ms": 0}
        url = self.node_url(node)
        if not url:
            return {"ok": False, "error": f"{node_id}: no reachable url", "output": None, "elapsed_ms": 0}
        started = time.time()
        try:
            result = httpjson.request_json(
                f"{url}/invoke", {"cap_id": cap_id, "args": args, "timeout": timeout}, timeout=timeout + 5,
                token=self.token, tls=self.tls,
            )
        except httpjson.HttpError as exc:
            return {"ok": False, "error": str(exc), "output": None, "elapsed_ms": round((time.time() - started) * 1000, 1)}
        if not result.get("ok"):
            return {"ok": False, "error": result.get("error") or "invoke failed", "output": result.get("output"),
                    "elapsed_ms": result.get("elapsed_ms", round((time.time() - started) * 1000, 1))}
        output = result.get("output")
        # Skill 一律以退出码 0 + {"ok": false, "error": ...} 汇报业务失败（见 examples/plugins/skills/ws/run.py），
        # 所以这里要把 payload 里的 ok 也当成失败，否则会把"写盘被占用"当成成功。
        if isinstance(output, dict) and output.get("ok") is False:
            return {"ok": False, "error": output.get("error") or "operational failure", "output": output,
                    "elapsed_ms": result.get("elapsed_ms")}
        return result

    # ------------------------------------------------------------ 视图
    def agents_by_node(self, state: dict) -> dict[str, list[dict]]:
        running: dict[tuple[str, str], dict] = {}
        for task in state.get("tasks", []):
            if task.get("status") in ("running", "claimed", "queued") and task.get("node_id"):
                running[(str(task["node_id"]), str(task.get("cap_id")))] = task
        out: dict[str, list[dict]] = {}
        for raw in state.get("capabilities", []):
            node_id = str(raw.get("node_id"))
            try:
                cap = Capability.from_dict(raw)
            except TypeError:
                continue
            task = running.get((node_id, cap.cap_id))
            health = (raw.get("health") or {}).get("status") or "ready"
            status = "busy" if task else ("down" if health == "down" else "idle")
            out.setdefault(node_id, []).append(
                {
                    "agent_id": cap.cap_id,
                    "cap_id": cap.cap_id,
                    "node_id": node_id,
                    "kind": cap.kind,
                    "name": cap.name,
                    "version": cap.version,
                    "description": cap.description,
                    "tool": cap.tool,
                    "tags": cap.tags,
                    "status": status,
                    "health": health,
                    "cost_model": cap.cost_model,
                    "current_task": (task or {}).get("id"),
                }
            )
        for items in out.values():
            items.sort(key=lambda row: row["cap_id"])
        return out

    def hosts_view(self) -> dict:
        started = time.time()
        state = self.control_state(fresh=True)
        rtt = round((time.time() - started) * 1000, 1)
        agents = self.agents_by_node(state)
        live = {str(n.get("node_id")): n for n in self.live_nodes()}
        router = state.get("router") or {}
        tasks = state.get("tasks") or []
        items = []
        for node in state.get("nodes", []):
            node_id = str(node.get("node_id"))
            metrics = node.get("metrics") or {}
            items.append(
                {
                    "node_id": node_id,
                    "role": "router" if node_id == router.get("node_id") else "node",
                    "os": node.get("os"),
                    "mesh_ip": node.get("mesh_ip"),
                    "url": node.get("url"),
                    "urls": (live.get(node_id) or {}).get("urls") or ([node.get("url")] if node.get("url") else []),
                    "reachable_url": self._url_cache.get(node_id, (None, 0))[0],
                    "alive": node.get("alive"),
                    "metrics": {
                        "cpu_percent": metrics.get("cpu_percent"),
                        "mem_percent": metrics.get("mem_percent"),
                        "mem_used_mb": metrics.get("mem_used_mb"),
                        "mem_total_mb": metrics.get("mem_total_mb"),
                        "net_in_rate": metrics.get("net_in_rate"),
                        "net_out_rate": metrics.get("net_out_rate"),
                        "net_unit": metrics.get("net_unit"),
                        "workers": metrics.get("workers"),
                        "max_workers": metrics.get("max_workers") or node.get("max_workers"),
                        "cpu_count": metrics.get("cpu_count"),
                        "uptime_s": metrics.get("uptime_s"),
                        "ts": metrics.get("ts"),
                    },
                    "metrics_age_s": round(time.time() - float(metrics.get("ts") or 0), 1) if metrics.get("ts") else None,
                    "agents": agents.get(node_id, []),
                    "agent_count": len(agents.get(node_id, [])),
                    # 首屏趋势图：网关自己采的最近若干点（不含本次，本次在 metrics 里）。
                    "history": uisummary.history_of(self.history, node_id),
                    "plugin_errors": node.get("plugin_errors") or [],
                    "task_counts": {
                        "running": sum(1 for t in tasks if t.get("node_id") == node_id and t.get("status") in ("claimed", "running")),
                        "done": sum(1 for t in tasks if t.get("node_id") == node_id and t.get("status") == "done"),
                        "failed": sum(1 for t in tasks if t.get("node_id") == node_id and t.get("status") == "failed"),
                    },
                }
            )
        items.sort(key=lambda row: (row["role"] != "router", row["node_id"]))
        queue = uisummary.queue_summary(tasks)
        workspaces = [uisummary.workspace_summary(self.sync.workspaces[name], self.sync.runs)
                      for name in self.sync.workspaces]
        workspaces.sort(key=lambda row: (row.get("created") or 0), reverse=True)
        return {
            "upstream": {"control": self.control, "ok": True, "rtt_ms": rtt, "ts": time.time()},
            "router": {
                "node_id": router.get("node_id"),
                "url": router.get("url"),
                "peers": router.get("peers") or [],
                "quorum": router.get("quorum"),
                "uptime_s": router.get("uptime_s"),
                "policy": router.get("policy") or {},
            },
            "summary": {
                "nodes": len(items),
                "alive": sum(1 for row in items if row["alive"]),
                "agents": sum(row["agent_count"] for row in items),
                "tasks_running": queue["counts"]["running"],
                "tasks_total": queue["total"],
            },
            # 首屏顶栏直接读这两个：quorum 是控制面的，queue 是任务队列的。
            "quorum": router.get("quorum"),
            "peers": router.get("peers") or [],
            "queue": queue,
            "workspaces": workspaces,
            "items": items,
        }

    def agents_view(self) -> dict:
        state = self.control_state()
        by_node = self.agents_by_node(state)
        os_by_node = {str(n.get("node_id")): n.get("os") for n in state.get("nodes", [])}
        items = []
        for node_id, rows in by_node.items():
            for row in rows:
                items.append({**row, "node_os": os_by_node.get(node_id)})
        items.sort(key=lambda row: (row["node_id"], row["cap_id"]))
        return {"items": items, "count": len(items)}

    # ------------------------------------------------------------ Router
    def _load_transcript(self) -> list[dict]:
        if not self.transcript_path.exists():
            return []
        try:
            data = json.loads(self.transcript_path.read_text(encoding="utf-8"))
            return data.get("items") or []
        except (OSError, ValueError):
            return []

    def _save_transcript(self) -> None:
        self.transcript_path.parent.mkdir(parents=True, exist_ok=True)
        self.transcript = self.transcript[-200:]
        tmp = self.transcript_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"items": self.transcript}, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        tmp.replace(self.transcript_path)

    def router_send(self, text: str) -> dict:
        text = (text or "").strip()
        if not text:
            raise UiError(400, "消息不能为空")
        started = time.time()
        reply, actions = self._route(text)
        entry = {"role": "user", "text": text, "ts": started}
        answer = {"role": "router", "text": reply, "ts": time.time(), "actions": actions,
                  "elapsed_ms": round((time.time() - started) * 1000, 1)}
        with self._state_lock:
            self.transcript.extend([entry, answer])
            self._save_transcript()
        return answer

    def _route(self, text: str) -> tuple[str, list[dict]]:
        parts = text.split()
        verb = parts[0].lower() if parts else ""
        rest = parts[1:]
        state = self.control_state(fresh=True)
        if verb in ("help", "帮助", "?"):
            return self._help(), []
        if verb in ("status", "状态", "概况"):
            return self._status_text(state), []
        if verb in ("hosts", "主机"):
            hosts = self.hosts_view()
            lines = [f"{row['node_id']} ({row['os']}, {row['role']}) cpu={row['metrics']['cpu_percent']}% "
                     f"mem={row['metrics']['mem_percent']}% workers={row['metrics']['workers']}/{row['metrics']['max_workers']} "
                     f"agents={row['agent_count']}" for row in hosts["items"]]
            return "\n".join(lines), []
        if verb in ("caps", "能力", "agents"):
            rows = self.agents_view()["items"]
            return "\n".join(f"{r['cap_id']} @ {r['node_id']} [{r['status']}]" for r in rows), []
        if verb in ("tasks", "任务"):
            limit = int(rest[0]) if rest and rest[0].isdigit() else 10
            rows = (state.get("tasks") or [])[-limit:]
            return "\n".join(f"{t['id']} {t['status']} node={t.get('node_id')} cap={t.get('cap_id')}" for t in rows) or "暂无任务", []
        if verb in ("sync", "同步"):
            name = rest[0] if rest else (next(iter(self.sync.workspaces), None))
            if not name:
                return "还没有工作区。先在 设置 → Cluster 里新建一个。", []
            run = self.sync.start_sync(name)
            return f"已触发工作区 {name} 的同步：{run['id']}（用 sync 状态页或 sync status 看结果）", [
                {"kind": "sync", "run_id": run["id"], "workspace": name}]
        if verb in ("all", "全部", "fanout") and rest:
            return self._fanout(rest[0], rest[1:], state)
        if verb in ("on", "指定") and len(rest) >= 2:
            return self._invoke_one(rest[0], rest[1], rest[2:])
        if verb in ("run", "执行") and rest:
            return self._run_routed(rest[0], rest[1:])
        cap_hit = next((r for r in self.agents_view()["items"] if r["cap_id"] in text), None)
        if cap_hit:
            return self._run_routed(cap_hit["cap_id"], [])
        return ("没看懂这条指令。可用命令：\n" + self._help()), []

    def _help(self) -> str:
        return (
            "status｜状态            集群概况\n"
            "hosts｜主机             主机 + 指标 + agents\n"
            "caps｜能力            全部能力（= 可调度的 worker）\n"
            "tasks [n]｜任务        最近任务\n"
            "run <cap_id> [json]   交给 L2 路由（节点由准入/负载决定）\n"
            "all <cap_id> [json]   每个持有该能力的节点各跑一次（真并发，逐节点结果）\n"
            "on <node> <cap_id> [json]  指定节点执行\n"
            "sync [工作区]｜同步    触发工作区同步\n"
            "帮助｜help"
        )

    def _status_text(self, state: dict) -> str:
        router = state.get("router") or {}
        nodes = state.get("nodes") or []
        caps = state.get("capabilities") or []
        tasks = state.get("tasks") or []
        running = sum(1 for t in tasks if t.get("status") == "running")
        return (
            f"路由副本 {router.get('node_id')} peers={len(router.get('peers') or [])} quorum={router.get('quorum')}\n"
            f"节点 {len(nodes)}（在线 {sum(1 for n in nodes if n.get('alive'))}）｜能力 {len(caps)}｜任务 {len(tasks)}（运行中 {running}）"
        )

    def _parse_payload(self, tokens: list[str]) -> dict:
        raw = " ".join(tokens).strip()
        if not raw:
            return {}
        try:
            value = json.loads(raw)
        except ValueError:
            return {"text": raw}
        return value if isinstance(value, dict) else {"value": value}

    def _run_routed(self, cap_id: str, tokens: list[str]) -> tuple[str, list[dict]]:
        payload = self._parse_payload(tokens)
        submitted = self.orch.submit({"cap_ids": [cap_id]}, payload, timeout=30)
        task = self.orch.wait(submitted["task_id"], timeout=self.wait_seconds)
        status = task.get("status")
        node = task.get("node_id")
        if status == "done":
            reply = f"任务 {task['id']} 完成 @{node}（{task.get('elapsed_ms')}ms）：{json.dumps(task.get('output'), ensure_ascii=False)[:400]}"
        elif status == "failed":
            reply = f"任务 {task['id']} 失败 @{node}：{task.get('error')}"
        else:
            reply = f"任务已提交 {task['id']}（{status}），{self.wait_seconds}s 内未结束；用 tasks 查看后续状态"
        return reply, [{"kind": "task", "task_id": task.get("id"), "cap_id": cap_id, "node_id": node,
                        "status": status, "output": task.get("output"), "error": task.get("error"),
                        "elapsed_ms": task.get("elapsed_ms")}]

    def _invoke_one(self, node_id: str, cap_id: str, tokens: list[str]) -> tuple[str, list[dict]]:
        payload = self._parse_payload(tokens)
        result = self.call_node(node_id, payload, timeout=30.0, cap_id=cap_id)
        if result.get("ok"):
            reply = f"{node_id} 上 {cap_id} 返回：{json.dumps(result.get('output'), ensure_ascii=False)[:400]}"
        else:
            reply = f"{node_id} 上 {cap_id} 失败：{result.get('error')}"
        return reply, [{"kind": "invoke", "cap_id": cap_id, "node_id": node_id, "status": "done" if result.get("ok") else "failed",
                        "output": result.get("output"), "error": result.get("error"), "elapsed_ms": result.get("elapsed_ms")}]

    def _fanout(self, cap_id: str, tokens: list[str], state: dict) -> tuple[str, list[dict]]:
        payload = self._parse_payload(tokens)
        targets = sorted({str(cap.get("node_id")) for cap in state.get("capabilities", []) if cap.get("cap_id") == cap_id})
        if not targets:
            return f"没有节点持有 {cap_id}", []
        slots: dict[str, dict] = {}

        def run(node_id: str) -> None:
            slots[node_id] = self.call_node(node_id, payload, timeout=30.0, cap_id=cap_id)

        threads = [threading.Thread(target=run, args=(node_id,), daemon=True) for node_id in targets]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=40)

        lines, actions = [], []
        for node_id in targets:
            result = slots.get(node_id) or {"ok": False, "error": "超时"}
            ok = bool(result.get("ok"))
            head = "✓" if ok else "✗"
            detail = json.dumps(result.get("output"), ensure_ascii=False)[:200] if ok else str(result.get("error"))[:200]
            lines.append(f"{head} {node_id}: {detail}")
            actions.append({"kind": "invoke", "cap_id": cap_id, "node_id": node_id, "status": "done" if ok else "failed",
                            "output": result.get("output"), "error": result.get("error"), "elapsed_ms": result.get("elapsed_ms")})
        return "已向 %d 个节点下发 %s：\n%s" % (len(targets), cap_id, "\n".join(lines)), actions

    # ------------------------------------------------ Router：LLM 会话支撑
    # 这一层不跑模型：它只把「模型要的事实」压成很少的 token 交给 DSH 里的
    # cluster-router 会话，并把结构化调用落回同一套 L2/L4 执行路径。

    def _caps_by_id(self, state: dict) -> dict[str, list[str]]:
        table: dict[str, list[str]] = {}
        for cap in state.get("capabilities") or []:
            table.setdefault(str(cap.get("cap_id")), []).append(str(cap.get("node_id")))
        for holders in table.values():
            holders.sort()
        return table

    def router_snapshot(self) -> dict:
        """精简集群快照：几行文本，给系统提示用；只带模型决策需要的数字。"""
        state = self.control_state(fresh=True)
        router = state.get("router") or {}
        nodes = state.get("nodes") or []
        tasks = state.get("tasks") or []
        caps = self._caps_by_id(state)
        node_rows = []
        for node in nodes:
            metrics = node.get("metrics") or {}
            node_rows.append({
                "node_id": node.get("node_id"),
                "os": node.get("os"),
                "alive": bool(node.get("alive")),
                "cpu_pct": metrics.get("cpu_percent"),
                "mem_pct": metrics.get("mem_percent"),
                "workers": f"{metrics.get('workers')}/{metrics.get('max_workers')}",
            })
        counts = {
            "tasks": len(tasks),
            "running": sum(1 for t in tasks if t.get("status") == "running"),
            "failed": sum(1 for t in tasks if t.get("status") == "failed"),
            "caps": len(caps),
            "nodes": len(node_rows),
            "nodes_alive": sum(1 for n in node_rows if n["alive"]),
        }
        workspaces = []
        for name, workspace in list(self.sync.workspaces.items())[:6]:
            last = None
            for run in self.sync.runs.values():
                if run.get("workspace") == name and (last is None or run.get("started", 0) > last.get("started", 0)):
                    last = run
            workspaces.append({"name": name, "policy": workspace.get("policy"),
                               "last_run": (last or {}).get("status"), "last_run_id": (last or {}).get("id")})
        lines = [
            f"路由副本 {router.get('node_id')}（quorum {router.get('quorum')}，peers {len(router.get('peers') or [])}）",
            "节点：" + "；".join(
                f"{n['node_id']}={n['os']}{'/在线' if n['alive'] else '/离线'} cpu {n['cpu_pct']}% mem {n['mem_pct']}% workers {n['workers']}"
                for n in node_rows),
            "能力：" + "；".join(f"{cap_id}@[{','.join(holders)}]" for cap_id, holders in sorted(caps.items())),
            f"任务：共 {counts['tasks']}，运行中 {counts['running']}，失败 {counts['failed']}",
            "工作区：" + ("；".join(f"{w['name']}(policy={w['policy']}, last={w['last_run']})" for w in workspaces) or "无"),
        ]
        return {"text": "\n".join(lines), "nodes": node_rows, "caps": caps, "counts": counts, "workspaces": workspaces}

    def router_status(self, limit: int = 8) -> dict:
        """cluster_status 工具的返回：任务尾巴 + 能力表 + 同步状态，保持小。"""
        state = self.control_state(fresh=True)
        tasks = (state.get("tasks") or [])[-max(1, min(limit, 20)):]
        caps = self._caps_by_id(state)
        runs = sorted(self.sync.runs.values(), key=lambda run: run.get("started", 0))[-3:]
        return {
            "tasks": [{"id": t.get("id"), "status": t.get("status"), "cap_id": t.get("cap_id"),
                       "node_id": t.get("node_id"), "error": t.get("error")} for t in tasks],
            "caps": [{"cap_id": cap_id, "nodes": holders} for cap_id, holders in sorted(caps.items())],
            "workspaces": [{"name": name, "policy": workspace.get("policy")}
                           for name, workspace in self.sync.workspaces.items()],
            "sync_runs": [{"id": run.get("id"), "workspace": run.get("workspace"), "status": run.get("status"),
                           "policy": run.get("policy"), "error": run.get("error")} for run in runs],
            "counts": {"nodes": len(state.get("nodes") or []), "caps": len(caps), "tasks": len(state.get("tasks") or [])},
        }

    def router_dispatch(self, body: dict) -> dict:
        """结构化下发：能力/节点必须真实存在，然后走与快路径完全相同的执行路径。"""
        cap_id = str(body.get("cap_id") or "").strip()
        if not cap_id:
            raise UiError(400, "缺 cap_id")
        payload = body.get("payload")
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise UiError(400, "payload 必须是 JSON 对象")
        node = str(body.get("node") or "").strip()
        fanout = bool(body.get("fanout"))
        state = self.control_state(fresh=True)
        caps = self._caps_by_id(state)
        if cap_id not in caps:
            raise UiError(400, f"没有这个能力: {cap_id}；可用: {', '.join(sorted(caps))}")
        nodes = {str(n.get("node_id")) for n in state.get("nodes") or []}
        tokens = [json.dumps(payload, ensure_ascii=False)]
        if node:
            if node not in nodes:
                raise UiError(400, f"没有这个节点: {node}；现有: {', '.join(sorted(nodes))}")
            if node not in caps[cap_id]:
                raise UiError(400, f"{node} 上没有 {cap_id}；该能力在: {', '.join(caps[cap_id])}")
            text, actions = self._invoke_one(node, cap_id, tokens)
        elif fanout:
            text, actions = self._fanout(cap_id, tokens, state)
        else:
            text, actions = self._run_routed(cap_id, tokens)
        return {"ok": True, "cap_id": cap_id, "node": node or None, "text": text, "actions": actions}

    def router_sync(self, body: dict) -> dict:
        """工作区同步（写）。覆盖是危险动作，调用方必须显式带 confirm=true。"""
        workspace = str(body.get("workspace") or "").strip()
        policy = body.get("policy")
        if body.get("confirm") is not True:
            raise UiError(400, "拒绝执行：工作区同步会在节点间互相覆盖文件；需要先向用户确认，再带 confirm=true 调用")
        if not workspace:
            raise UiError(400, "缺 workspace")
        if workspace not in self.sync.workspaces:
            raise UiError(400, f"没有这个工作区: {workspace}；现有: {', '.join(self.sync.workspaces) or '无'}")
        run = self.sync.start_sync(workspace, policy=policy if isinstance(policy, str) else None)
        return {"ok": True, "run": run, "workspace": self.sync.workspace_view(workspace),
                "text": f"已触发工作区 {workspace} 的同步：{run['id']}（policy={run.get('policy')}）"}

    def router_log(self, body: dict) -> dict:
        """把 LLM 会话的一次往返写进面板 transcript（面板只轮询这一个文件）。"""
        items = body.get("items")
        if not isinstance(items, list) or not items:
            raise UiError(400, "items 必须是非空数组")
        keep = {"role", "text", "ts", "actions", "elapsed_ms", "source", "model", "usage", "trace"}
        clean = []
        for row in items[:8]:
            if not isinstance(row, dict):
                continue
            entry = {k: v for k, v in row.items() if k in keep}
            if not entry.get("role") or not str(entry.get("text") or "").strip():
                continue
            entry.setdefault("ts", time.time())
            clean.append(entry)
        if not clean:
            raise UiError(400, "items 里没有可写入的回合")
        with self._state_lock:
            self.transcript.extend(clean)
            self._save_transcript()
        return {"items": clean}

    # ------------------------------------------------------------ HTTP
    def _auth(self, raw: str) -> bool:
        return secrets.compare_digest((raw or "").strip(), self.ui_token)

    def dispatch(self, method: str, path: str, body: Any, headers: dict | None = None) -> tuple[int, Any]:
        parsed = urlparse(path)
        route = parsed.path.rstrip("/") or "/"
        query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        if method == "GET" and route == "/api/health":
            return 200, {"ok": True, "gateway": "cluster-ui", "control": self.control, "ts": time.time(),
                         # 设置页要把"这个面板连的是哪套控制面/证书"如实显示出来，
                         # 所以把网关自己的启动参数一并回给页面（都是回环可见的本地事实，不含密钥）。
                         "tls": {"dir": str(self._tls_dir) if self._tls_dir else None,
                                 "cert_name": self._cert_name,
                                 "enabled": bool(self.tls is not None)},
                         "token_file": str(self.state_dir / "token"),
                         "state_dir": str(self.state_dir),
                         "host": self.host, "port": self.port,
                         "workspace_count": len(self.sync.workspaces), "run_count": len(self.sync.runs)}
        raw_token = query.get("token") or ""
        if not raw_token and isinstance(body, dict):
            raw_token = str(body.get("token") or "")
        if not raw_token and headers:
            raw_token = headers.get("authorization") or headers.get("x-cluster-token") or ""
            if raw_token.lower().startswith("bearer "):
                raw_token = raw_token[7:]
        if not self._auth(raw_token):
            return 401, {"error": "unauthorized", "hint": "需要 token：Authorization: Bearer <state_dir>/ui/token"}
        if isinstance(body, dict):
            body = {k: v for k, v in body.items() if k != "token"}
        try:
            return 200, self._handle(method, route, query, body or {})
        except UiError as exc:
            return exc.status, {"error": str(exc)}
        except WorkspaceError as exc:
            return 400, {"error": str(exc)}
        except httpjson.HttpError as exc:
            return 503, {"error": f"上游不可达: {exc}"}
        except Exception as exc:  # noqa: BLE001 - 一个请求失败不能带崩网关
            return 500, {"error": f"{type(exc).__name__}: {exc}"}

    def _handle(self, method: str, route: str, query: dict, body: dict) -> Any:
        if route == "/api/cluster":
            state = self.control_state(fresh=True)
            return {"router": state.get("router"), "nodes": state.get("nodes"), "capabilities": state.get("capabilities"),
                    "summary": {"nodes": len(state.get("nodes") or []), "caps": len(state.get("capabilities") or [])}}
        if route == "/api/hosts":
            return self.hosts_view()
        if route == "/api/agents":
            return self.agents_view()
        if route == "/api/tasks":
            limit = int(query.get("limit") or 20)
            tasks = self.control_state().get("tasks") or []
            return {"items": tasks[-limit:], "count": len(tasks[-limit:]), "queue": uisummary.queue_summary(tasks)}
        if route == "/api/router/transcript":
            limit = int(query.get("limit") or 50)
            return {"items": self.transcript[-limit:]}
        if route == "/api/router/message" and method == "POST":
            return self.router_send(str(body.get("text") or ""))
        if route == "/api/router/snapshot":
            return self.router_snapshot()
        if route == "/api/router/status":
            return self.router_status(int(query.get("limit") or 8))
        if route == "/api/router/dispatch" and method == "POST":
            return self.router_dispatch(body)
        if route == "/api/router/sync" and method == "POST":
            return self.router_sync(body)
        if route == "/api/router/log" and method == "POST":
            return self.router_log(body)
        if route == "/api/workspaces" and method == "GET":
            return {"items": [self.sync.workspace_view(name) for name in self.sync.workspaces],
                    "summaries": [uisummary.workspace_summary(self.sync.workspaces[name], self.sync.runs)
                                  for name in self.sync.workspaces],
                    "nodes": [{"node_id": n.get("node_id"), "os": n.get("os")} for n in self.live_nodes()]}
        if route == "/api/workspaces" and method == "POST":
            record = self.sync.create_workspace(str(body.get("name") or ""),
                                                policy=str(body.get("policy") or "newest"),
                                                seed=bool(body.get("seed", True)),
                                                roots=body.get("roots") or None)
            run = self.sync.start_sync(record["name"])
            return {"workspace": self.sync.workspace_view(record["name"]), "run": run}
        if route.startswith("/api/workspaces/") and route.endswith("/tree"):
            name = route[len("/api/workspaces/"):-len("/tree")].strip("/")
            if name not in self.sync.workspaces:
                raise UiError(404, f"没有这个工作区: {name}")
            return self.workspace_tree(name)
        if route == "/api/workspace/sync" and method == "POST":
            name = str(body.get("workspace") or "")
            if not name:
                raise UiError(400, "缺 workspace")
            return {"run": self.sync.start_sync(name, policy=body.get("policy"))}
        if route == "/api/workspace/sync/status":
            return self.sync.status(query.get("run_id"))
        if route == "/api/workspace/sync/retry" and method == "POST":
            return {"run": self.sync.retry(str(body.get("run_id") or ""))}
        raise UiError(404, f"no route {method} {route}")

    def workspace_tree(self, name: str) -> dict:
        workspace = self.sync.workspaces[name]
        roots = self.sync.roots_for(workspace)
        nodes = {}
        for node in self.live_nodes():
            node_id = str(node.get("node_id"))
            result = self.call_node(node_id, {"op": "manifest", "root": roots.get(node_id)}, 45.0)
            nodes[node_id] = {
                "root": roots.get(node_id),
                "ok": result.get("ok"),
                "error": result.get("error"),
                "files": (result.get("output") or {}).get("files") or [],
            }
        return {"workspace": name, "nodes": nodes}
