"""L4：三种插件适配器（mcp / skill / api）→ 统一 Capability + 统一 Invoke。

统一调用协议（对应设计里的 protobuf Capability 服务）：
    describe() -> [Capability]
    health()   -> {"status": "ready|degraded|down", ...}
    invoke(tool, args) -> {"ok": bool, "output": Any, "error": str|None, "elapsed_ms": float}

适配器只跑在 L1 Node Agent 内，L2/L5 永远通过 cap_id 寻址，不直接碰插件进程。
"""

from __future__ import annotations

import json
import os
import queue
import shlex
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import httpjson, winproc
from .l3_capability import Capability

TEXT_SUFFIXES = {".yaml", ".yml", ".json"}


def resolve_command(parts: list[str]) -> list[str]:
    """把插件声明里的 "python"/"python3" 换成当前解释器。

    跨平台坑：Ubuntu 上通常只有 python3，Windows 上通常只有 python，
    写死任何一种都会在另一端起不来（CI 上就是这么暴露的）。
    """
    if parts and parts[0] in ("python", "python3", "py"):
        return [sys.executable, *parts[1:]]
    return parts


# ---------------------------------------------------------------- YAML 子集
def _scalar(text: str) -> Any:
    text = text.strip()
    if not text:
        return ""
    if text[0] in "[{":
        try:
            return json.loads(text.replace("'", '"'))
        except ValueError:
            inner = text[1:-1].strip()
            if not inner:
                return [] if text[0] == "[" else {}
            if text[0] == "[":
                return [_scalar(s) for s in inner.split(",") if s.strip()]
            pairs: dict[str, Any] = {}
            for chunk in inner.split(","):
                if ":" not in chunk:
                    raise ValueError(f"不支持的 inline 记法: {text}")
                key, _, value = chunk.partition(":")
                pairs[key.strip().strip("\"'")] = _scalar(value)
            return pairs
    if text[0] in "\"'" and text[-1] == text[0]:
        return text[1:-1]
    low = text.lower()
    if low in ("true", "yes", "on"):
        return True
    if low in ("false", "no", "off"):
        return False
    if low in ("null", "~"):
        return None
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        pass
    return text


def parse_yaml(text: str) -> Any:
    """够用就好的 YAML 子集：嵌套映射、`- ` 列表、inline []/{}、注释。"""

    def tokenize(raw: str) -> list[tuple[int, str]]:
        rows: list[tuple[int, str]] = []
        for line in raw.splitlines():
            stripped = line.split(" #")[0].rstrip()
            if not stripped.strip() or stripped.lstrip().startswith("#"):
                continue
            indent = len(stripped) - len(stripped.lstrip())
            rows.append((indent, stripped.strip()))
        return rows

    def build(rows: list[tuple[int, str]], start: int, indent: int) -> tuple[Any, int]:
        if start >= len(rows):
            return {}, start
        is_list = rows[start][1].startswith("- ")
        container: Any = [] if is_list else {}
        i = start
        while i < len(rows):
            cur_indent, content = rows[i]
            if cur_indent < indent:
                break
            if cur_indent > indent:  # 交给上层递归，避免越界
                break
            if is_list:
                if not content.startswith("- "):
                    break
                item = content[2:].strip()
                if ":" in item and not item.startswith(("[", "{")):
                    # 列表里的映射项："- name: echo" + 后续缩进更深的行
                    first_indent = cur_indent + 2
                    sub: list[tuple[int, str]] = [(first_indent, item)]
                    j = i + 1
                    while j < len(rows) and rows[j][0] > cur_indent:
                        sub.append(rows[j])
                        j += 1
                    value, _ = build(sub, 0, first_indent)
                    container.append(value)
                    i = j
                    continue
                container.append(_scalar(item))
                i += 1
                continue
            if ":" not in content:
                i += 1
                continue
            key, _, rest = content.partition(":")
            key = key.strip()
            rest = rest.strip()
            if rest:
                container[key] = _scalar(rest)
                i += 1
            else:
                child_indent = rows[i + 1][0] if i + 1 < len(rows) else indent
                if i + 1 < len(rows) and child_indent > indent:
                    container[key], i = build(rows, i + 1, child_indent)
                elif i + 1 < len(rows) and rows[i + 1][1].startswith("- "):
                    container[key], i = build(rows, i + 1, child_indent)
                else:
                    container[key] = {}
                    i += 1
        return container, i

    return build(tokenize(text), 0, 0)[0]


def load_spec(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    if path.suffix == ".json":
        return json.loads(raw)
    try:
        return json.loads(raw)
    except ValueError:
        return parse_yaml(raw)


# ---------------------------------------------------------------- 基类
class Adapter:
    kind = "base"

    def __init__(self, spec: dict, source: str = "") -> None:
        self.spec = spec
        self.source = source
        self.name = str(spec.get("name") or Path(source).stem or "unnamed")
        self.version = str(spec.get("version") or "0.1.0")
        self.description = str(spec.get("description") or "")

    def _base_cap(self, tool: str, description: str = "") -> Capability:
        spec = self.spec
        return Capability(
            cap_id=f"{self.kind}:{self.name}" + (f"/{tool}" if tool and tool != self.name else "") + f"@{self.version}",
            kind=self.kind,
            name=self.name if not tool or tool == self.name else f"{self.name}/{tool}",
            version=self.version,
            description=description or self.description,
            tool=tool,
            input_schema=spec.get("input_schema", {}) if tool == self.name else {},
            output_schema=spec.get("output_schema", {}),
            requirements=spec.get("requirements", {}),
            cost_model=spec.get("cost_model", {}),
            tags=list(spec.get("tags", [])),
        )

    def describe(self) -> list[Capability]:  # pragma: no cover - 抽象
        raise NotImplementedError

    def health(self) -> dict:
        return {"status": "ready", "last_check": time.time()}

    def invoke(self, tool: str, args: dict, timeout: float = 30.0) -> dict:  # pragma: no cover
        raise NotImplementedError

    def close(self) -> None:
        return


# ---------------------------------------------------------------- Skill
class SkillAdapter(Adapter):
    kind = "skill"

    def describe(self) -> list[Capability]:
        return [self._base_cap(self.name)]

    def _command(self) -> list[str]:
        cmd = self.spec.get("command") or self.spec.get("entry")
        if isinstance(cmd, str):
            return resolve_command(shlex.split(cmd, posix=(os.name != "nt")))
        if isinstance(cmd, list):
            return resolve_command([str(part) for part in cmd])
        entry = self.spec.get("entry_file")
        if entry:
            return [sys.executable, str(Path(self.source).parent / entry)]
        raise ValueError(f"skill {self.name}: 缺少 command/entry")

    def invoke(self, tool: str, args: dict, timeout: float = 30.0) -> dict:
        started = time.time()
        try:
            proc = subprocess.run(
                self._command(),
                input=json.dumps(args, ensure_ascii=False),
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=str(Path(self.source).parent) if self.source else None,
                encoding="utf-8",
                errors="replace",
                **winproc.hidden_kwargs(),
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "output": None, "error": f"timeout after {timeout}s", "elapsed_ms": (time.time() - started) * 1000}
        except (OSError, ValueError) as exc:
            return {"ok": False, "output": None, "error": str(exc), "elapsed_ms": (time.time() - started) * 1000}
        elapsed = (time.time() - started) * 1000
        if proc.returncode != 0:
            return {
                "ok": False,
                "output": proc.stdout[-2000:],
                "error": (proc.stderr or f"exit {proc.returncode}")[-2000:],
                "elapsed_ms": elapsed,
            }
        out = proc.stdout.strip()
        try:
            payload = json.loads(out.splitlines()[-1]) if out else {}
        except ValueError:
            payload = {"output": out}
        return {"ok": True, "output": payload, "error": None, "elapsed_ms": elapsed}


# ---------------------------------------------------------------- API
class ApiAdapter(Adapter):
    kind = "api"

    def describe(self) -> list[Capability]:
        return [self._base_cap(self.name)]

    def invoke(self, tool: str, args: dict, timeout: float = 30.0) -> dict:
        started = time.time()
        url = str(self.spec.get("base_url", "")).rstrip("/") + str(self.spec.get("path", ""))
        method = str(self.spec.get("method", "POST")).upper()
        try:
            if method == "GET":
                if args:
                    from urllib.parse import urlencode

                    url = f"{url}?{urlencode(args)}"
                out = httpjson.request_json(url, None, "GET", timeout)
            else:
                out = httpjson.request_json(url, args, method, timeout)
        except httpjson.HttpError as exc:
            return {"ok": False, "output": None, "error": str(exc), "elapsed_ms": (time.time() - started) * 1000}
        return {"ok": True, "output": out, "error": None, "elapsed_ms": (time.time() - started) * 1000}


# ---------------------------------------------------------------- MCP
class McpAdapter(Adapter):
    """最小 MCP 客户端：stdio + 行分隔 JSON-RPC 2.0。"""

    kind = "mcp"

    def __init__(self, spec: dict, source: str = "") -> None:
        super().__init__(spec, source)
        self._proc: subprocess.Popen | None = None
        self._queue: "queue.Queue[dict]" = queue.Queue()
        self._next_id = 0
        self._lock = threading.Lock()
        self._tools: list[dict] = []
        self.startup_timeout = float(spec.get("startup_timeout", 30))
        self._stderr: list[str] = []
        self._stderr_lock = threading.Lock()

    def _command(self) -> list[str]:
        cmd = self.spec.get("command")
        if isinstance(cmd, str):
            return resolve_command(shlex.split(cmd, posix=(os.name != "nt")))
        if isinstance(cmd, list):
            return resolve_command([str(x) for x in cmd])
        raise ValueError(f"mcp {self.name}: 缺少 command")

    def _ensure(self) -> None:
        if self._proc is not None and self._proc.poll() is None:
            return
        self._proc = subprocess.Popen(
            self._command(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            **winproc.hidden_kwargs(),
        )

        def reader() -> None:
            assert self._proc is not None
            for line in self._proc.stdout:  # type: ignore[union-attr]
                line = line.strip()
                if not line:
                    continue
                try:
                    self._queue.put(json.loads(line))
                except ValueError:
                    continue

        threading.Thread(target=reader, daemon=True).start()
        threading.Thread(target=self._stderr_reader, daemon=True).start()
        try:
            self._request(
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "cluster-l1", "version": "0.1.0"},
                },
                timeout=self.startup_timeout,
            )
        except (TimeoutError, RuntimeError) as exc:
            raise RuntimeError(f"MCP server 启动失败（{self.name}）: {exc}; stderr={self.stderr_tail()}") from None
        self._notify("notifications/initialized", {})
        tools = self._request("tools/list", {}).get("tools", [])
        self._tools = tools

    def _stderr_reader(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        for line in self._proc.stderr:
            line = line.rstrip()
            if not line:
                continue
            with self._stderr_lock:
                self._stderr.append(line)
                self._stderr = self._stderr[-40:]

    def stderr_tail(self) -> str:
        with self._stderr_lock:
            return " | ".join(self._stderr[-6:])

    def _send(self, payload: dict) -> None:
        assert self._proc is not None and self._proc.stdin is not None
        self._proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._proc.stdin.flush()

    def _notify(self, method: str, params: dict) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _request(self, method: str, params: dict, timeout: float = 20.0) -> dict:
        with self._lock:
            self._next_id += 1
            req_id = self._next_id
            self._send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
            deadline = time.time() + timeout
            while True:
                remaining = deadline - time.time()
                if remaining <= 0:
                    raise TimeoutError(f"MCP {self.name}.{method} 超时")
                try:
                    msg = self._queue.get(timeout=remaining)
                except queue.Empty:
                    raise TimeoutError(f"MCP {self.name}.{method} 超时") from None
                if msg.get("id") != req_id:
                    continue
                if "error" in msg:
                    raise RuntimeError(f"MCP {self.name}.{method} 错误: {msg['error']}")
                return msg.get("result", {})

    def describe(self) -> list[Capability]:
        """能力清单优先从 plugin 清单（tools:）读，不启动子进程。

        说明：Windows CI 上实测 `describe()` 里现拉 MCP 子进程会偶发 tools/list 超时
        （stdio 管道时序问题），而注册阶段本来也不需要真连 server——清单在 yaml 里
        声明即可；没声明时才回退去问 server。
        """
        tools = self.spec.get("tools")
        if not tools:
            self._ensure()
            tools = self._tools
        caps: list[Capability] = []
        for tool in tools:
            name = str(tool.get("name", "tool"))
            cap = self._base_cap(name, str(tool.get("description") or ""))
            cap.input_schema = tool.get("inputSchema", {}) or {}
            caps.append(cap)
        return caps

    def invoke(self, tool: str, args: dict, timeout: float = 30.0) -> dict:
        started = time.time()
        try:
            self._ensure()
            result = self._request("tools/call", {"name": tool, "arguments": args}, timeout)
        except (TimeoutError, RuntimeError, ValueError, OSError) as exc:
            return {"ok": False, "output": None, "error": str(exc), "elapsed_ms": (time.time() - started) * 1000}
        is_error = bool(result.get("isError"))
        return {
            "ok": not is_error,
            "output": result.get("content", result),
            "error": "tool reported isError" if is_error else None,
            "elapsed_ms": (time.time() - started) * 1000,
        }

    def close(self) -> None:
        proc = self._proc
        if proc is None:
            return
        if proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):  # pragma: no cover
                proc.kill()
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:  # pragma: no cover
                pass
        self._proc = None


# ---------------------------------------------------------------- 扫描
def load_plugins(root: str | Path) -> tuple[list[Adapter], list[str]]:
    """扫描 plugins 根目录：mcp/*.yaml、skills/<name>/skill.yaml、apis/*.yaml。"""
    base = Path(root)
    adapters: list[Adapter] = []
    errors: list[str] = []
    if not base.exists():
        return adapters, [f"plugins 目录不存在: {base}"]

    for path in sorted((base / "mcp").glob("*")):
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            adapters.append(McpAdapter(load_spec(path), str(path)))
        except Exception as exc:
            errors.append(f"{path}: {exc}")

    for path in sorted((base / "skills").glob("*/")):
        spec_path = next((p for p in path.iterdir() if p.name in ("skill.yaml", "skill.yml", "skill.json")), None)
        if spec_path is None:
            continue
        try:
            adapters.append(SkillAdapter(load_spec(spec_path), str(spec_path)))
        except Exception as exc:
            errors.append(f"{spec_path}: {exc}")

    for path in sorted((base / "apis").glob("*")):
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            adapters.append(ApiAdapter(load_spec(path), str(path)))
        except Exception as exc:
            errors.append(f"{path}: {exc}")

    return adapters, errors
