"""외부 서비스 TLS 인증서 점검 — 엔드포인트가 내놓는 인증서의 만료일·주체·발급자·SAN·호스트 일치.

수집(`services/external_services.collect`)의 뒤 단계로 돈다. 대상은
- Ingress 의 https 엔드포인트(SNI = 선언 도메인)
- 설정 `tls_ports`(기본 443·8443)에 걸리는 LoadBalancer·ExternalIP·NodePort(SNI = 역조회 이름이 있으면 그 이름)

실행 위치는 정방향 검증·응답 확인과 같다(`check_source`):
- `node`: SSH 노드에서 `tls_command`(기본 `openssl s_client … | openssl x509 -noout -enddate -subject -issuer -text`)
- `backend`: backend 에서 TLS 핸드셰이크로 인증서(DER)를 받아 `cryptography` 로 해석

인증서 체인 신뢰 여부는 보지 않는다(자체 서명·사내 CA 도 만료일은 봐야 하므로 검증 없이 받는다).
남은 일수는 저장하지 않고 조회 시점에 `not_after` 로 다시 계산한다 — 스냅샷이 오래돼도 D-day 가 맞게.
셸로 넘기는 값은 형식 검증을 통과한 것만 쓴다. 실패는 결과의 error 로 남기고 예외를 올리지 않는다.
"""
from __future__ import annotations

import re
import socket
import ssl
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from app.services.external_checks import valid_domain, valid_ip

Emit = Callable[[str, str], None]

DEFAULT_TLS_COMMAND = (
    "echo | timeout {timeout} openssl s_client -connect {ip}:{port} {sni} 2>/dev/null"
    " | openssl x509 -noout -enddate -subject -issuer -text"
)


def tls_key(t: dict[str, Any]) -> str:
    return f"{t.get('host') or ''}|{t['ip']}|{t['port']}"


def tls_targets(entries: list[dict[str, Any]], node_ips: list[dict[str, Any]], ptr_cache: dict[str, Any],
                ports: list[int], limit: int) -> list[dict[str, Any]]:
    first_node = next((n.get("external_ip") or n.get("internal_ip") for n in node_ips
                       if n.get("external_ip") or n.get("internal_ip")), None)
    seen: dict[str, dict[str, Any]] = {}
    for e in entries:
        port = e.get("port")
        addr = e.get("ip") or e.get("hostname") or (first_node if e.get("kind") == "NodePort" else None)
        if not addr or not isinstance(port, int) or not (valid_ip(addr) or valid_domain(addr)):
            continue
        if e.get("kind") == "Ingress":
            if e.get("scheme") != "https" or not valid_domain(e.get("host")):
                continue
            host = e["host"].rstrip(".")
        elif port in ports:
            names = (ptr_cache.get(e.get("ip") or "") or {}).get("names") or []
            host = next((n.rstrip(".") for n in names if valid_domain(n)), None)
            if host is None and e.get("hostname") and valid_domain(e["hostname"]):
                host = e["hostname"]
        else:
            continue
        t = {"ip": addr, "port": port, "host": host}
        seen.setdefault(tls_key(t), t)
    return list(seen.values())[: max(0, limit)]


def entry_tls_key(e: dict[str, Any], node_ips: list[dict[str, Any]], ptr_cache: dict[str, Any],
                  ports: list[int]) -> Optional[str]:
    ts = tls_targets([e], node_ips, ptr_cache, ports, 1)
    return tls_key(ts[0]) if ts else None


# ── 이름 일치 ──────────────────────────────────────────────────────────────────
def host_matches(host: str, names: list[str]) -> bool:
    """RFC 6125 수준의 단순 매칭 — 정확히 일치, 또는 `*.example.com` 이 한 레이블만 대신한다."""
    h = host.lower().rstrip(".")
    for n in names:
        n = (n or "").lower().rstrip(".")
        if not n:
            continue
        if n == h:
            return True
        if n.startswith("*.") and "." in h and h.split(".", 1)[1] == n[2:]:
            return True
    return False


# ── backend 수집 ──────────────────────────────────────────────────────────────
def _cn(name) -> Optional[str]:
    from cryptography.x509.oid import NameOID
    attrs = name.get_attributes_for_oid(NameOID.COMMON_NAME)
    return str(attrs[0].value) if attrs else None


def parse_der(der: bytes) -> dict[str, Any]:
    from cryptography import x509
    cert = x509.load_der_x509_certificate(der)
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
    except x509.ExtensionNotFound:
        san = []
    not_after = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after.replace(tzinfo=timezone.utc)
    return {"not_after": not_after.astimezone(timezone.utc).replace(tzinfo=None).isoformat(),
            "subject_cn": _cn(cert.subject), "issuer_cn": _cn(cert.issuer), "san": list(san)}


def fetch_one_backend(t: dict[str, Any], timeout: float) -> dict[str, Any]:
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        with socket.create_connection((t["ip"], t["port"]), timeout=timeout) as raw:
            with ctx.wrap_socket(raw, server_hostname=t.get("host") or None) as s:
                der = s.getpeercert(binary_form=True)
        if not der:
            return {"error": "인증서 없음"}
        return {**parse_der(der), "error": None}
    except socket.timeout:
        return {"error": "시간 초과"}
    except ConnectionRefusedError:
        return {"error": "연결 거부"}
    except ssl.SSLError as e:
        return {"error": f"TLS 핸드셰이크 실패({e.reason or e})"[:200]}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:200]}


def fetch_backend(targets: list[dict[str, Any]], timeout: float, emit: Emit) -> dict[str, dict[str, Any]]:
    if not targets:
        return {}
    out: dict[str, dict[str, Any]] = {}
    pool = ThreadPoolExecutor(max_workers=min(16, len(targets)))
    futs = {pool.submit(fetch_one_backend, t, timeout): t for t in targets}
    done, pending = wait(futs, timeout=timeout * 2 + 2 + len(targets) * timeout / 16)
    for f in done:
        out[tls_key(futs[f])] = f.result()
    for f in pending:
        out[tls_key(futs[f])] = {"error": "시간 초과"}
    pool.shutdown(wait=False, cancel_futures=True)
    return out


# ── 노드(SSH) 수집 ────────────────────────────────────────────────────────────
_CN_RE = re.compile(r"CN\s*=\s*([^,/\n]+)")


def parse_openssl_output(text: str) -> dict[str, Any]:
    """`openssl x509 -noout -enddate -subject -issuer -text` 출력 해석."""
    not_after = subject_cn = issuer_cn = None
    san: list[str] = []
    lines = (text or "").splitlines()
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith("notAfter=") and not_after is None:
            raw = " ".join(s.split("=", 1)[1].split())
            try:
                not_after = datetime.strptime(raw.replace(" GMT", ""), "%b %d %H:%M:%S %Y").isoformat()
            except ValueError:
                pass
        elif s.startswith("subject=") and subject_cn is None:
            m = _CN_RE.search(s)
            subject_cn = m.group(1).strip() if m else None
        elif s.startswith("issuer=") and issuer_cn is None:
            m = _CN_RE.search(s)
            issuer_cn = m.group(1).strip() if m else None
        elif "Subject Alternative Name" in s and i + 1 < len(lines):
            for part in lines[i + 1].split(","):
                part = part.strip()
                if part.startswith("DNS:"):
                    san.append(part[4:])
    if not_after is None:
        return {"error": "인증서를 받지 못함(연결 실패 또는 TLS 아님)"}
    return {"not_after": not_after, "subject_cn": subject_cn, "issuer_cn": issuer_cn, "san": san, "error": None}


def build_tls_script(targets: list[dict[str, Any]], command: str, timeout: int) -> str:
    lines = []
    for t in targets:
        if not (valid_ip(t["ip"]) or valid_domain(t["ip"])) or not isinstance(t["port"], int):
            continue
        if t.get("host") and not valid_domain(t["host"]):
            continue
        sni = f"-servername {t['host']}" if t.get("host") else ""
        cmd = command.format(timeout=timeout, ip=t["ip"], port=t["port"], host=t.get("host") or "", sni=sni)
        lines.append(f"echo '@@PTR {tls_key(t)}'; {cmd}; echo")
    return "\n".join(lines)


def fetch_ssh(targets: list[dict[str, Any]], target, command: str, timeout: int, emit: Emit) -> dict[str, dict[str, Any]]:
    from app.services.external_services import split_ssh_output
    from app.services.ssh_runner import _exec_ssh
    if not targets:
        return {}
    emit("info", f"노드 {target.host} 에서 인증서 확인 {len(targets)}건(타임아웃 {timeout}s)")
    res = _exec_ssh(target, build_tls_script(targets, command, timeout), connect_timeout=10,
                    exec_timeout=min(900, 10 + (timeout + 2) * len(targets)), max_stdout_chars=2_000_000)
    if res.status != "ok" and not res.stdout:
        emit("error", f"SSH 인증서 확인 실패({res.status}): {res.error or res.stderr[:300]}")
        return {}
    blocks = split_ssh_output(res.stdout)
    return {tls_key(t): parse_openssl_output(blocks.get(tls_key(t), "")) for t in targets}


# ── 판정 ───────────────────────────────────────────────────────────────────────
def tls_view(rec: Optional[dict[str, Any]], host: Optional[str], warn_days: int, critical_days: int,
             now: Optional[datetime] = None) -> Optional[dict[str, Any]]:
    """저장된 결과 → 화면 표시용. level: ok | warning | critical | expired | error."""
    if not rec:
        return None
    base = {"source": rec.get("source"), "checked_at": rec.get("checked_at"), "error": rec.get("error"),
            "subject_cn": rec.get("subject_cn"), "issuer_cn": rec.get("issuer_cn"),
            "san": (rec.get("san") or [])[:10], "not_after": rec.get("not_after"), "days_left": None,
            "host_match": None, "level": "error"}
    if rec.get("error") or not rec.get("not_after"):
        return base
    try:
        na = datetime.fromisoformat(rec["not_after"])
    except ValueError:
        return {**base, "error": "만료일 해석 실패"}
    now = now or datetime.utcnow()
    days = int((na - now).total_seconds() // 86400)
    level = "expired" if na <= now else "critical" if days <= critical_days else "warning" if days <= warn_days else "ok"
    names = rec.get("san") or ([rec["subject_cn"]] if rec.get("subject_cn") else [])
    match = host_matches(host, names) if host else None
    return {**base, "days_left": days, "level": level, "host_match": match}


def is_issue(v: Optional[dict[str, Any]]) -> bool:
    return bool(v) and (v["level"] in ("warning", "critical", "expired") or v.get("host_match") is False)
