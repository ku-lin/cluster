"""工作区文件代理（cluster 工作区同步的节点侧执行器）。

约定（Skill 适配器）：stdin 收一个 JSON 对象，stdout 最后一行回一个 JSON 对象。
    {"op": "manifest", "root": "<绝对路径>", "skip": ["子目录名"...]}
        -> {"ok": true, "root": ..., "files": [{"path","size","sha256","mtime_ns"}], "skipped": [...], "files_scanned": N}
    {"op": "read", "path": "<绝对路径>", "max_bytes": N}
        -> {"ok": true, "path", "size", "sha256", "data_b64"}
    {"op": "write", "path": "<绝对路径>", "data_b64": "...", "sha256": "..."}
        -> {"ok": true, "path", "action": "written|unchanged", "size", "sha256"}
    {"op": "stat", "path": "<绝对路径>"}
        -> {"ok": true, "exists", "is_dir", "size", "mtime_ns"}

安全边界：只允许在 CLUSTER_WS_ROOTS（os.pathsep 分隔）里操作；没设该变量时默认放行
home、临时目录，以及本脚本向上 5 层祖先（= 仓库根，覆盖 <repo> 与 ~/cluster-test/cluster-app 这类部署副本）。
所有路径先做 realpath 归一，再按最长前缀比对，防止 ../ 穿越与符号链接逃逸。

这里不写盘任何额外状态：同步的合并策略与冲突判定全在网关侧（cluster/wssync.py），
节点侧保持无状态，重试就是重发同一条任务。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path

SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".mypy_cache", ".pytest_cache"}
DEFAULT_MAX_BYTES = 2 * 1024 * 1024
MAX_MANIFEST_FILES = 5000


def _allowed_roots() -> list[str]:
    raw = os.environ.get("CLUSTER_WS_ROOTS", "")
    roots: list[str] = []
    for part in raw.split(os.pathsep):
        if part.strip():
            roots.append(part.strip())
    if not roots:
        roots.append(str(Path.home()))
        roots.append(tempfile.gettempdir())
        # 本插件在 <repo>/examples/plugins/skills/ws/，向上 5 层就是仓库根（也覆盖仓库的部署副本）。
        here = Path(__file__).resolve()
        for _ in range(5):
            here = here.parent
            roots.append(str(here))
    out: list[str] = []
    for root in roots:
        try:
            out.append(os.path.realpath(root))
        except OSError:
            continue
    return out


def _inside(path: str, roots: list[str]) -> str:
    """realpath 归一后必须是某个允许根的子孙（或根本身）。

    `~` 在这里展开：网关可能只知道对端声明的 `~/cluster-test/workspaces/<name>` 这类路径，
    而 realpath 不会把 `~` 当主目录，展开必须在节点本地做，否则会写进 cwd 下的一个字面 `~` 目录。
    """
    real = os.path.realpath(os.path.expanduser(path))
    for root in roots:
        if real == root or real.startswith(root.rstrip(os.sep) + os.sep):
            return real
    raise PermissionError(f"路径不在允许的工作区根目录内: {path}")


def _sha256_file(path: str, chunk: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def op_manifest(args: dict, roots: list[str]) -> dict:
    root = _inside(str(args.get("root") or ""), roots)
    if not os.path.isdir(root):
        return {"ok": True, "root": root, "exists": False, "files": [], "skipped": [], "files_scanned": 0}
    skip = set(args.get("skip") or []) | SKIP_DIRS
    files: list[dict] = []
    skipped: list[dict] = []
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in skip)
        for name in sorted(filenames):
            if ".clustersync-" in name or name.endswith(".tmp"):
                continue  # 同步自己的半成品不算工作区内容
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            try:
                st = os.stat(full)
            except OSError as exc:
                skipped.append({"path": rel, "reason": f"stat: {exc}"})
                continue
            scanned += 1
            if scanned > MAX_MANIFEST_FILES:
                skipped.append({"path": rel, "reason": "manifest_file_cap"})
                continue
            try:
                files.append(
                    {"path": rel, "size": st.st_size, "sha256": _sha256_file(full), "mtime_ns": st.st_mtime_ns}
                )
            except OSError as exc:
                skipped.append({"path": rel, "reason": f"read: {exc}"})
    return {"ok": True, "root": root, "exists": True, "files": files, "skipped": skipped, "files_scanned": scanned}


def op_read(args: dict, roots: list[str]) -> dict:
    path = _inside(str(args.get("path") or ""), roots)
    max_bytes = int(args.get("max_bytes") or DEFAULT_MAX_BYTES)
    size = os.path.getsize(path)
    if size > max_bytes:
        return {"ok": False, "error": f"file too large for read: {size} > {max_bytes}", "size": size, "path": path}
    with open(path, "rb") as fh:
        data = fh.read()
    return {
        "ok": True,
        "path": path,
        "size": size,
        "sha256": hashlib.sha256(data).hexdigest(),
        "data_b64": base64.b64encode(data).decode("ascii"),
    }


def op_write(args: dict, roots: list[str]) -> dict:
    path = _inside(str(args.get("path") or ""), roots)
    data = base64.b64decode(str(args.get("data_b64") or ""))
    want = str(args.get("sha256") or "")
    got = hashlib.sha256(data).hexdigest()
    if want and want != got:
        return {"ok": False, "error": f"sha256 mismatch: want {want} got {got}", "path": path}
    if os.path.isfile(path):
        try:
            if _sha256_file(path) == got:
                return {"ok": True, "path": path, "action": "unchanged", "size": len(data), "sha256": got}
        except OSError:
            pass
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = f"{path}.clustersync-{os.getpid()}-{int(time.time() * 1000)}.tmp"
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        # 失败必须清掉半成品：临时文件会被 manifest 看见，然后被当成"新文件"同步到对端。
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return {"ok": True, "path": path, "action": "written", "size": len(data), "sha256": got}


def op_stat(args: dict, roots: list[str]) -> dict:
    path = _inside(str(args.get("path") or ""), roots)
    if not os.path.exists(path):
        return {"ok": True, "path": path, "exists": False, "is_dir": False, "size": 0, "mtime_ns": 0}
    st = os.stat(path)
    return {
        "ok": True,
        "path": path,
        "exists": True,
        "is_dir": os.path.isdir(path),
        "size": st.st_size if os.path.isfile(path) else 0,
        "mtime_ns": st.st_mtime_ns,
    }


OPS = {"manifest": op_manifest, "read": op_read, "write": op_write, "stat": op_stat}


def main() -> int:
    try:
        args = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        print(json.dumps({"ok": False, "error": "stdin 不是 JSON"}))
        return 2
    op = str(args.get("op") or "")
    handler = OPS.get(op)
    if handler is None:
        print(json.dumps({"ok": False, "error": f"未知 op: {op!r}，支持 {sorted(OPS)}"}))
        return 2
    try:
        result = handler(args, _allowed_roots())
    except (PermissionError, OSError) as exc:
        # 业务性失败（越权路径、目标被占用、sha 不符……）按数据回传，退出码保持 0：
        # Skill 适配器把非 0 退出当成"崩了"、只留 stderr 的 "exit 1"，真正的原因就丢了。
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}", "op": op}, ensure_ascii=False))
        return 0
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
