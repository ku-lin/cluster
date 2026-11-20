"""极小的 JSON-over-HTTP 服务端与客户端（仅标准库，支持 TLS / mTLS）。

控制面与 Node Agent 之间、以及本地 cap_router 都用这一套：
  - 服务端：dispatch(method, path, body) -> (status, obj)，可选 mTLS
  - 客户端：request_json(url, payload, tls=TLSOptions(...))
"""

from __future__ import annotations

import json
import ssl
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

Dispatch = Callable[[str, str, Any], "tuple[int, Any]"]


class Raw:
    """dispatch 返回它表示原样输出（用于 dashboard 的 HTML）。"""

    def __init__(self, body: bytes, content_type: str = "text/html; charset=utf-8") -> None:
        self.body = body
        self.content_type = content_type


class HttpError(RuntimeError):
    pass


class TLSOptions:
    """一端（或两端）的 TLS 配置。cafile 为空表示不校验（仅限本地回环调试）。"""

    def __init__(
        self,
        cafile: str | None = None,
        certfile: str | None = None,
        keyfile: str | None = None,
        require_client_cert: bool = True,
        server_hostname: str | None = None,
    ) -> None:
        self.cafile = cafile
        self.certfile = certfile
        self.keyfile = keyfile
        self.require_client_cert = require_client_cert
        self.server_hostname = server_hostname

    def server_context(self) -> ssl.SSLContext:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        if self.certfile:
            ctx.load_cert_chain(self.certfile, self.keyfile)
        if self.cafile:
            ctx.load_verify_locations(self.cafile)
            ctx.verify_mode = ssl.CERT_REQUIRED if self.require_client_cert else ssl.CERT_OPTIONAL
        return ctx

    def client_context(self) -> ssl.SSLContext:
        ctx = ssl.create_default_context(cafile=self.cafile)
        if self.cafile is None:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        if self.certfile:
            ctx.load_cert_chain(self.certfile, self.keyfile)
        return ctx


def _scheme(tls: TLSOptions | None) -> str:
    return "https" if tls else "http"


def _opener(tls: TLSOptions | None):
    if tls is None:
        return urllib.request.build_opener()
    handlers: list[Any] = [urllib.request.HTTPSHandler(context=tls.client_context())]
    return urllib.request.build_opener(*handlers)


def request_json(
    url: str,
    payload: Any = None,
    method: str | None = None,
    timeout: float = 5.0,
    token: str | None = None,
    tls: TLSOptions | None = None,
) -> Any:
    data = None
    headers = {"accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json"
    if token:
        headers["authorization"] = f"Bearer {token}"
    if method is None:
        method = "POST" if data is not None else "GET"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with _opener(tls).open(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw.decode("utf-8") or "null")
    except urllib.error.HTTPError as exc:  # 4xx/5xx 也要把 body 带出来
        body = exc.read().decode("utf-8", "replace")
        raise HttpError(f"HTTP {exc.code} {url}: {body[:400]}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise HttpError(f"unreachable {url}: {reason}") from None


def get_json(url: str, timeout: float = 5.0, tls: TLSOptions | None = None) -> Any:
    return request_json(url, None, "GET", timeout, None, tls)


class Server:
    """后台线程里跑的 HTTP(S) 服务；start()/stop() 幂等。"""

    def __init__(
        self,
        host: str,
        port: int,
        dispatch: Dispatch,
        name: str = "cluster",
        tls: TLSOptions | None = None,
    ) -> None:
        self.host = host
        self.requested_port = port
        self._dispatch = dispatch
        self._name = name
        self._tls = tls
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        if self._httpd is None:
            return self.requested_port
        return int(self._httpd.server_address[1])

    def scheme(self) -> str:
        return _scheme(self._tls)

    @property
    def url(self) -> str:
        return f"{self.scheme()}://{self.host}:{self.port}"

    def start(self) -> "Server":
        dispatch = self._dispatch
        tls = self._tls

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "cluster/0.1"

            def _handle(self) -> None:
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                body: Any = None
                if raw:
                    try:
                        body = json.loads(raw.decode("utf-8"))
                    except ValueError:
                        self._write(400, {"error": "invalid json body"})
                        return
                try:
                    status, obj = dispatch(self.command, self.path, body)
                except Exception as exc:  # 服务端不允许因为一个请求挂掉
                    status, obj = 500, {"error": f"{type(exc).__name__}: {exc}"}
                self._write(status, obj)

            do_GET = _handle
            do_POST = _handle
            do_PUT = _handle
            do_DELETE = _handle

            def _write(self, status: int, obj: Any) -> None:
                if isinstance(obj, Raw):
                    payload, ctype = obj.body, obj.content_type
                else:
                    payload = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
                    ctype = "application/json; charset=utf-8"
                self.send_response(status)
                self.send_header("content-type", ctype)
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args: Any) -> None:  # 静默：日志由业务自己打
                return

        httpd = ThreadingHTTPServer((self.host, self.requested_port), Handler)
        httpd.daemon_threads = True
        if tls is not None and tls.certfile:
            ctx = tls.server_context()
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        self._httpd = httpd
        self._thread = threading.Thread(target=httpd.serve_forever, name=f"{self._name}-http", daemon=True)
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

    def __enter__(self) -> "Server":
        return self.start()

    def __exit__(self, *exc: Any) -> None:
        self.stop()
