"""mTLS：自签 CA + 每节点证书（openssl CLI，双端都自带）。

用法：
    python -m cluster certs init  --dir .state/tls
    python -m cluster certs issue --dir .state/tls --name kali  --san DNS:kali --san IP:10.14.14.2 --san IP:192.168.70.145
    python -m cluster certs issue --dir .state/tls --name win01 --san DNS:DESKTOP-PD3AE9A --san IP:10.14.14.1 --san IP:192.168.70.1

证书同时带 serverAuth + clientAuth，用于双向认证（mTLS）。
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from . import winproc

_WIN_OPENSSL = [
    r"C:\Program Files\OpenSSL-Win64\bin\openssl.exe",
    r"C:\Program Files\Git\usr\bin\openssl.exe",
    r"C:\Program Files\Git\mingw64\bin\openssl.exe",
]


def openssl_path() -> str:
    found = shutil.which("openssl")
    if found:
        return found
    for candidate in _WIN_OPENSSL:
        if Path(candidate).exists():
            return candidate
    raise FileNotFoundError("没找到 openssl；Windows 上可用 Git for Windows 自带的 openssl，或把 openssl.exe 加进 PATH")


def _run(args: list[str], cwd: Path) -> str:
    proc = subprocess.run(
        [openssl_path(), *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        **winproc.hidden_kwargs(),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"openssl {' '.join(args)} 失败: {(proc.stderr or proc.stdout).strip()[:500]}")
    return proc.stdout


def init_ca(directory: str | Path, cn: str = "cluster-ca", days: int = 3650) -> dict[str, str]:
    base = Path(directory)
    base.mkdir(parents=True, exist_ok=True)
    ca_key, ca_crt = base / "ca.key", base / "ca.crt"
    if ca_crt.exists() and ca_key.exists():
        return {"ca_crt": str(ca_crt), "ca_key": str(ca_key), "reused": "true"}
    _run(
        [
            "req", "-x509", "-newkey", "rsa:4096", "-nodes", "-days", str(days),
            "-keyout", "ca.key", "-out", "ca.crt", "-subj", f"/CN={cn}",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        ],
        base,
    )
    return {"ca_crt": str(ca_crt), "ca_key": str(ca_key), "reused": "false"}


def issue(
    directory: str | Path,
    name: str,
    sans: list[str] | None = None,
    days: int = 825,
) -> dict[str, str]:
    base = Path(directory)
    ca_crt, ca_key = base / "ca.crt", base / "ca.key"
    if not ca_crt.exists():
        init_ca(base)
    sans = sans or [f"DNS:{name}"]
    key, csr, crt = base / f"{name}.key", base / f"{name}.csr", base / f"{name}.crt"
    ext = base / f"{name}.ext"
    ext.write_text(
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth,clientAuth\n"
        f"subjectAltName={','.join(sans)}\n",
        encoding="utf-8",
    )
    _run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key.name), "-out", str(csr.name), "-subj", f"/CN={name}"], base)
    _run(
        [
            "x509", "-req", "-in", csr.name, "-CA", ca_crt.name, "-CAkey", ca_key.name,
            "-CAcreateserial", "-out", crt.name, "-days", str(days), "-sha256", "-extfile", ext.name,
        ],
        base,
    )
    try:
        os.chmod(key, 0o600)
    except OSError:  # pragma: no cover - Windows
        pass
    return {"name": name, "cert": str(crt), "key": str(key), "ca": str(ca_crt), "sans": ",".join(sans)}


def verify(directory: str | Path, name: str) -> dict[str, str]:
    base = Path(directory)
    out = _run(["verify", "-CAfile", "ca.crt", f"{name}.crt"], base)
    text = _run(["x509", "-in", f"{name}.crt", "-noout", "-text"], base)
    sans = [line.strip() for line in text.splitlines() if "DNS:" in line]
    return {"verify": out.strip(), "san": " / ".join(sans)}
