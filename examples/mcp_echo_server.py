"""最小 MCP stdio server（示例用）：tools/list、tools/call(echo|add)。

协议：行分隔 JSON-RPC 2.0。真实 MCP server 的额外能力（资源、提示、采样）这里不实现。
"""

import json
import sys

TOOLS = [
    {
        "name": "echo",
        "description": "原样返回 text",
        "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    },
    {
        "name": "add",
        "description": "把 a 和 b 相加",
        "inputSchema": {
            "type": "object",
            "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
            "required": ["a", "b"],
        },
    },
]


def handle(req: dict) -> dict | None:
    method = req.get("method")
    req_id = req.get("id")
    params = req.get("params") or {}
    if method == "initialize":
        result = {
            "protocolVersion": params.get("protocolVersion", "2024-11-05"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "example-mcp-echo", "version": "1.0.0"},
        }
    elif method == "notifications/initialized":
        return None
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "echo":
            content = [{"type": "text", "text": str(args.get("text", ""))}]
        elif name == "add":
            content = [{"type": "text", "text": str(float(args.get("a", 0)) + float(args.get("b", 0)))}]
        else:
            return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"unknown tool {name}"}}
        result = {"content": content, "isError": False}
    else:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"unknown method {method}"}}
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        resp = handle(req)
        if resp is not None:
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
