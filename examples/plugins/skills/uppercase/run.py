"""示例 Skill 入口：stdin 收 JSON，stdout 回一行 JSON（Skill Adapter 的约定）。"""

import json
import sys


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        payload = {}
    text = str(payload.get("text", ""))
    out = {"upper": text.upper(), "length": len(text)}
    if payload.get("reverse"):
        out["reversed"] = text[::-1]
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
