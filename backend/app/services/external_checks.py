"""외부 서비스 점검 — 도메인 정방향 검증(A 레코드 ↔ 엔드포인트 IP) + 엔드포인트 응답 확인(TCP/HTTP).

수집(`services/external_services.collect`)의 뒤 단계로 돈다. 두 점검 모두 실행 위치를 고른다:
- `node`: 수집에 쓴 SSH 노드에서 실행 — 사내 DNS·내부망 경로 기준이라 사용자가 보는 결과에 가깝다.
  명령은 설정 템플릿(`fwd_command`, `probe_tcp_command`, `probe_http_command`)으로 바꿀 수 있다.
- `backend`: PEP backend 프로세스에서 `getaddrinfo` / 소켓 / HTTP 요청. 정기 수집(자격증명 없음)이 쓴다.

셸로 넘기는 값(도메인·IP·포트·스킴)은 전부 형식 검증을 통과한 것만 쓴다(셸 주입 차단).
외부 호출은 fail-safe — 실패는 결과의 error 필드와 로그 줄로 남기고 예외를 올리지 않는다.
"""
from __future__ import annotations

import http.client
import ipaddress
import re
import socket
import ssl
import time
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Any, Callable, Optional

Emit = Callable[[str, str], None]

DEFAULT_FWD_COMMAND = "getent ahosts {domain} || nslookup {domain}"
DEFAULT_PROBE_TCP_COMMAND = "timeout {timeout} bash -c '</dev/tcp/{ip}/{port}'"
DEFAULT_PROBE_HTTP_COMMAND = (
    "curl -sk -o /dev/null -w '%{{http_code}}' -m {timeout} --resolve {host}:{port}:{ip} {scheme}://{host}:{port}/"
)

_DOMAIN_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$")


def valid_domain(d: Optional[str]) -> bool:
    return bool(d) and not d.startswith("*") and bool(_DOMAIN_RE.match(d))  # type: ignore[arg-type]


def valid_ip(v: Optional[str]) -> bool:
    try:
        ipaddress.ip_address(v or "")
        return True
    except ValueError:
        return False


# ── 정방향 검증 ────────────────────────────────────────────────────────────────
def forward_domains(entries: list[dict[str, Any]], ptr_cache: dict[str, Any]) -> list[str]:
    """검증 대상 — Ingress 선언 host 와 IP 역조회 이름(정방향이 다시 같은 IP 로 오는지)."""
    out: set[str] = set()
    for e in entries:
        if valid_domain(e.get("host")):
            out.add(e["host"].rstrip("."))
        for n in ((ptr_cache.get(e.get("ip") or "") or {}).get("names") or []):
            if valid_domain(n):
                out.add(n.rstrip("."))
    return sorted(out)


def parse_forward_output(text: str) -> list[str]:
    """getent ahosts("<ip> STREAM name") 와 nslookup("Name: x / Address: ip") 출력에서 IP 를 모은다.
    nslookup 의 DNS 서버 줄("Address: 10.96.0.10#53", Name: 이전 Address)은 뺀다."""
    ips: list[str] = []
    after_name = False
    for line in (text or "").splitlines():
        s = line.strip()
        if not s:
            continue
        parts = s.split()
        cand = None
        if valid_ip(parts[0]):
            cand = parts[0]
        elif s.lower().startswith("name:"):
            after_name = True
        elif s.lower().startswith("address") and after_name:
            v = s.split(":", 1)[1].strip() if ":" in s else ""
            if "#" not in v and valid_ip(v):
                cand = v
        if cand and cand not in ips:
            ips.append(cand)
    return ips


def resolve_forward_backend(domains: list[str], timeout: float, emit: Emit) -> dict[str, dict[str, Any]]:
    if not domains:
        return {}

    def one(d: str) -> dict[str, Any]:
        try:
            infos = socket.getaddrinfo(d, None, proto=socket.IPPROTO_TCP)
            ips = []
            for info in infos:
                ip = info[4][0]
                if ip not in ips:
                    ips.append(ip)
            return {"ips": ips, "error": None}
        except socket.gaierror as e:
            return {"ips": [], "error": f"조회 실패({e.strerror or e})"}
        except Exception as e:  # noqa: BLE001
            return {"ips": [], "error": str(e)[:200]}

    out: dict[str, dict[str, Any]] = {}
    pool = ThreadPoolExecutor(max_workers=min(16, len(domains)))
    futs = {pool.submit(one, d): d for d in domains}
    done, pending = wait(futs, timeout=timeout + 1 + len(domains) * timeout / 16)
    for f in done:
        out[futs[f]] = f.result()
    for f in pending:
        out[futs[f]] = {"ips": [], "error": "시간 초과"}
    pool.shutdown(wait=False, cancel_futures=True)
    return out


def resolve_forward_ssh(domains: list[str], target, command: str, emit: Emit) -> dict[str, dict[str, Any]]:
    from app.services.external_services import split_ssh_output
    from app.services.ssh_runner import _exec_ssh
    doms = [d for d in domains if valid_domain(d)]
    if not doms:
        return {}
    script = "\n".join(f"echo '@@PTR {d}'; {command.replace('{domain}', d)}; echo" for d in doms)
    emit("info", f"노드 {target.host} 에서 정방향 조회 {len(doms)}건 — 명령: {command}")
    res = _exec_ssh(target, script, connect_timeout=10, exec_timeout=min(600, 10 + 3 * len(doms)),
                    max_stdout_chars=400_000)
    if res.status != "ok" and not res.stdout:
        emit("error", f"SSH 정방향 조회 실패({res.status}): {res.error or res.stderr[:300]}")
        return {}
    blocks = split_ssh_output(res.stdout)
    return {d: {"ips": parse_forward_output(blocks.get(d, "")), "error": None} for d in doms}


def forward_status(entry_ip: Optional[str], rec: Optional[dict[str, Any]]) -> Optional[str]:
    """match | mismatch | nxdomain | None(검증 안 함)."""
    if not rec or not entry_ip:
        return None
    ips = rec.get("ips") or []
    if not ips:
        return "nxdomain"
    return "match" if entry_ip in ips else "mismatch"


# ── 응답 확인 ──────────────────────────────────────────────────────────────────
def probe_key(t: dict[str, Any]) -> str:
    return f"{t.get('scheme') or 'tcp'}|{t.get('host') or ''}|{t['ip']}|{t['port']}"


def probe_targets(entries: list[dict[str, Any]], node_ips: list[dict[str, Any]], http: bool,
                  limit: int) -> list[dict[str, Any]]:
    """응답 확인 대상(중복 제거). NodePort 는 첫 노드 주소로, LB 호스트명은 그 이름으로 접속한다.
    Ingress(host 선언 + http/https)는 `http` 가 켜져 있으면 Host 헤더를 실은 HTTP 요청, 그 밖은 TCP 연결."""
    first_node = next((n.get("external_ip") or n.get("internal_ip") for n in node_ips
                       if n.get("external_ip") or n.get("internal_ip")), None)
    seen: dict[str, dict[str, Any]] = {}
    for e in entries:
        addr = e.get("ip") or e.get("hostname") or (first_node if e.get("kind") == "NodePort" else None)
        port = e.get("port")
        if not addr or not isinstance(port, int) or not (valid_ip(addr) or valid_domain(addr)):
            continue
        use_http = bool(http and e.get("kind") == "Ingress" and e.get("scheme") in ("http", "https")
                        and valid_domain(e.get("host")))
        t = {"ip": addr, "port": port, "scheme": e["scheme"] if use_http else None,
             "host": e["host"] if use_http else None}
        seen.setdefault(probe_key(t), t)
    return list(seen.values())[: max(0, limit)]


def probe_one_backend(t: dict[str, Any], timeout: float) -> dict[str, Any]:
    start = time.monotonic()

    def ms() -> int:
        return int((time.monotonic() - start) * 1000)

    try:
        if t.get("scheme"):
            if t["scheme"] == "https":
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                raw = socket.create_connection((t["ip"], t["port"]), timeout=timeout)
                sock = ctx.wrap_socket(raw, server_hostname=t["host"])
                conn = http.client.HTTPSConnection(t["host"], t["port"], timeout=timeout, context=ctx)
                conn.sock = sock
            else:
                conn = http.client.HTTPConnection(t["ip"], t["port"], timeout=timeout)
            try:
                conn.request("GET", "/", headers={"Host": t["host"], "User-Agent": "pep-external-check"})
                code = conn.getresponse().status
            finally:
                conn.close()
            return {"reachable": True, "method": "http", "http_status": code, "latency_ms": ms(), "error": None}
        with socket.create_connection((t["ip"], t["port"]), timeout=timeout):
            pass
        return {"reachable": True, "method": "tcp", "http_status": None, "latency_ms": ms(), "error": None}
    except socket.timeout:
        return {"reachable": False, "method": "http" if t.get("scheme") else "tcp", "http_status": None,
                "latency_ms": ms(), "error": "시간 초과"}
    except ConnectionRefusedError:
        return {"reachable": False, "method": "http" if t.get("scheme") else "tcp", "http_status": None,
                "latency_ms": ms(), "error": "연결 거부"}
    except Exception as e:  # noqa: BLE001
        return {"reachable": False, "method": "http" if t.get("scheme") else "tcp", "http_status": None,
                "latency_ms": ms(), "error": str(e)[:200]}


def probe_backend(targets: list[dict[str, Any]], timeout: float, emit: Emit) -> dict[str, dict[str, Any]]:
    if not targets:
        return {}
    out: dict[str, dict[str, Any]] = {}
    pool = ThreadPoolExecutor(max_workers=min(32, len(targets)))
    futs = {pool.submit(probe_one_backend, t, timeout): t for t in targets}
    done, pending = wait(futs, timeout=timeout * 2 + 2 + len(targets) * timeout / 32)
    for f in done:
        out[probe_key(futs[f])] = f.result()
    for f in pending:
        t = futs[f]
        out[probe_key(t)] = {"reachable": False, "method": "http" if t.get("scheme") else "tcp",
                             "http_status": None, "latency_ms": None, "error": "시간 초과"}
    pool.shutdown(wait=False, cancel_futures=True)
    return out


def build_probe_script(targets: list[dict[str, Any]], tcp_cmd: str, http_cmd: str, timeout: int) -> str:
    """대상마다 구분선 + 명령 + 종료코드/소요시간. 값은 전부 검증된 것만 넣는다."""
    lines = []
    for t in targets:
        if not (valid_ip(t["ip"]) or valid_domain(t["ip"])) or not isinstance(t["port"], int):
            continue
        if t.get("scheme"):
            if t["scheme"] not in ("http", "https") or not valid_domain(t.get("host")):
                continue
            cmd = http_cmd.format(timeout=timeout, ip=t["ip"], port=t["port"], host=t["host"], scheme=t["scheme"])
        else:
            cmd = tcp_cmd.format(timeout=timeout, ip=t["ip"], port=t["port"], host="", scheme="")
        lines.append(f"echo '@@PTR {probe_key(t)}'; s=$(date +%s%N); out=$({cmd} 2>&1); rc=$?; "
                     f"e=$(date +%s%N); echo \"$out\"; echo \"@@RC $rc $(( (e-s)/1000000 ))\"")
    return "\n".join(lines)


def parse_probe_block(t: dict[str, Any], text: str) -> dict[str, Any]:
    rc, latency, body = None, None, []
    for line in (text or "").splitlines():
        if line.startswith("@@RC "):
            parts = line.split()
            try:
                rc, latency = int(parts[1]), int(parts[2])
            except (IndexError, ValueError):
                pass
        elif line.strip():
            body.append(line.strip())
    method = "http" if t.get("scheme") else "tcp"
    if rc is None:
        return {"reachable": False, "method": method, "http_status": None, "latency_ms": None, "error": "결과 없음"}
    if method == "http":
        code = next((int(b) for b in reversed(body) if b.isdigit() and len(b) == 3), None)
        if rc == 0 and code and code != 0:
            return {"reachable": True, "method": method, "http_status": code, "latency_ms": latency, "error": None}
        err = "시간 초과" if rc == 28 else ("연결 거부" if rc == 7 else (body[-1][:200] if body else f"curl rc={rc}"))
        return {"reachable": False, "method": method, "http_status": None, "latency_ms": latency, "error": err}
    if rc == 0:
        return {"reachable": True, "method": method, "http_status": None, "latency_ms": latency, "error": None}
    err = "시간 초과" if rc == 124 else (body[-1][:200] if body else f"rc={rc}")
    return {"reachable": False, "method": method, "http_status": None, "latency_ms": latency, "error": err}


def probe_ssh(targets: list[dict[str, Any]], target, tcp_cmd: str, http_cmd: str, timeout: int,
              emit: Emit) -> dict[str, dict[str, Any]]:
    from app.services.external_services import split_ssh_output
    from app.services.ssh_runner import _exec_ssh
    if not targets:
        return {}
    script = build_probe_script(targets, tcp_cmd, http_cmd, timeout)
    emit("info", f"노드 {target.host} 에서 응답 확인 {len(targets)}건(타임아웃 {timeout}s)")
    res = _exec_ssh(target, script, connect_timeout=10, exec_timeout=min(900, 10 + (timeout + 1) * len(targets)),
                    max_stdout_chars=400_000)
    if res.status != "ok" and not res.stdout:
        emit("error", f"SSH 응답 확인 실패({res.status}): {res.error or res.stderr[:300]}")
        return {}
    blocks = split_ssh_output(res.stdout)
    return {probe_key(t): parse_probe_block(t, blocks.get(probe_key(t), "")) for t in targets}


def probe_label(r: dict[str, Any]) -> str:
    if r.get("reachable"):
        head = f"HTTP {r['http_status']}" if r.get("http_status") else "열림"
        return f"{head} · {r['latency_ms']}ms" if r.get("latency_ms") is not None else head
    return r.get("error") or "응답 없음"
