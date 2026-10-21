"""외부 서비스 엔드포인트 수집 — 클러스터가 밖으로 노출한 도메인·IP:Port 목록 + IP→도메인 역조회.

수집 대상(K8s API):
- Service `LoadBalancer` — status.loadBalancer.ingress 의 ip/hostname × spec.ports
- Service `spec.externalIPs` — × spec.ports
- Service `NodePort` — 노드 주소 × nodePort (설정 `include_nodeport`)
- Ingress — rules[].host(선언 도메인) × status.loadBalancer.ingress × 80/443(tls 호스트면 443 추가)

IP → 도메인 역조회(PTR):
- `ssh`: 마스터/워커 노드에 SSH 로 접속해 `nslookup <ip>` 를 돌린다. 노드는 사내 DNS 를 보고 있어
  backend 파드보다 정확한 이름이 나온다. 자격증명은 요청 시에만 쓰고 저장하지 않는다(UI-First 규칙 3).
  명령은 설정 `ptr_command`(`{ip}` 자리표시)로 바꿀 수 있다 — dig/host 만 있는 노드 대응.
- `backend`: backend 프로세스에서 `socket.gethostbyaddr`. 정기 수집(자격증명 없음)이 쓴다.
- 결과는 스냅샷의 `ptr_cache` 에 병합 — SSH 로 찾은 이름이 다음 정기 수집에서도 유지된다.

외부 호출은 전부 fail-safe — 실패는 로그 줄/`error` 로 남기고 예외를 올리지 않는다.
"""
from __future__ import annotations

import ipaddress
import logging
import re
import socket
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timedelta
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.models.external_service import ExternalServiceChange, ExternalServiceSnapshot
from app.services import external_checks as chk
from app.services import external_tls as tls
from app.services.external_checks import (
    DEFAULT_FWD_COMMAND, DEFAULT_PROBE_HTTP_COMMAND, DEFAULT_PROBE_TCP_COMMAND,
)

log = logging.getLogger(__name__)

SETTINGS_KEY = "external_services.settings"
DEFAULT_PTR_COMMAND = "nslookup {ip} 2>/dev/null || host {ip} 2>/dev/null || getent hosts {ip}"

DEFAULTS: dict[str, Any] = {
    # 비인증 공개 페이지 노출 여부 — false 면 공개 API 404.
    "public_enabled": True,
    # 공개 대상 클러스터 id. 비어 있으면 테넌트 바인딩이 없는 클러스터 전체.
    "public_cluster_ids": [],
    # 정기 수집(자격증명 없음 — 역조회는 backend 방식 + 기존 캐시) 사용 여부와 cron.
    "schedule_enabled": True,
    "schedule_cron": "0 * * * *",
    # NodePort 서비스를 목록에 넣을지(노드 주소 × nodePort).
    "include_nodeport": True,
    # 제외할 네임스페이스(정확히 일치).
    "exclude_namespaces": [],
    # backend PTR 역조회 사용 여부와 IP 당 타임아웃(초).
    "backend_ptr": True,
    "dns_timeout_sec": 2,
    # SSH 역조회 명령 — `{ip}` 가 대상 IP 로 바뀐다. 이름 파싱은 nslookup/host/getent 출력을 모두 인식한다.
    "ptr_command": DEFAULT_PTR_COMMAND,
    # 점검 실행 위치: auto(SSH 자격증명을 준 수동 수집이면 그 노드, 아니면 backend) | node | backend.
    # node 는 SSH 자격증명이 있는 수동 수집에서만 가능 — 없으면 backend 로 폴백한다.
    "check_source": "auto",
    # 도메인 정방향 검증 — Ingress host·역조회 이름을 다시 A 레코드로 조회해 엔드포인트 IP 와 비교.
    "forward_check": True,
    "fwd_command": DEFAULT_FWD_COMMAND,
    # 엔드포인트 응답 확인 — TCP 연결, Ingress(host 선언)는 Host 헤더를 실은 HTTP 요청.
    "probe_enabled": True,
    "probe_http": True,
    "probe_timeout_sec": 3,
    "probe_max": 300,
    "probe_tcp_command": DEFAULT_PROBE_TCP_COMMAND,
    "probe_http_command": DEFAULT_PROBE_HTTP_COMMAND,
    # TLS 인증서 점검 — https Ingress + 아래 포트의 LB/ExternalIP/NodePort 인증서 만료일·호스트 일치.
    "tls_check": True,
    "tls_ports": [443, 8443],
    "tls_warn_days": 30,        # 남은 일수가 이 이하면 경고
    "tls_critical_days": 7,     # 이 이하면 위험
    "tls_command": tls.DEFAULT_TLS_COMMAND,
    # 공개 방식 — open(누구나) | link(만료 기한이 있는 공유 링크로만). 판정은 services/public_pages.py.
    "access_mode": "open",
    # 외부 노출 변경 이력 보관 일수와 "신규" 배지를 붙이는 기간(일).
    "change_retention_days": 90,
    "new_badge_days": 7,
}

Emit = Callable[[str, str], None]          # (level, message)
StepEmit = Callable[[str, str, str], None]  # (name, label, status)


# ── 설정 ───────────────────────────────────────────────────────────────────────
def _row(db: Session):
    from app.models.app_setting import AppSetting
    return db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()


def normalize(values: dict[str, Any]) -> dict[str, Any]:
    out = dict(DEFAULTS)
    for k, v in (values or {}).items():
        if k in DEFAULTS and v is not None:
            out[k] = v
    for k in ("public_enabled", "schedule_enabled", "include_nodeport", "backend_ptr", "forward_check",
              "probe_enabled", "probe_http", "tls_check"):
        out[k] = bool(out[k])
    for k, lo, hi in (("dns_timeout_sec", 1, 10), ("probe_timeout_sec", 1, 15), ("probe_max", 1, 2000),
                      ("tls_warn_days", 1, 365), ("tls_critical_days", 0, 365),
                      ("change_retention_days", 1, 400), ("new_badge_days", 0, 90)):
        try:
            out[k] = max(lo, min(hi, int(out[k])))
        except (TypeError, ValueError):
            out[k] = DEFAULTS[k]
    if out["access_mode"] not in ("open", "link"):
        out["access_mode"] = "open"
    if out["check_source"] not in ("auto", "node", "backend"):
        out["check_source"] = "auto"
    out["tls_critical_days"] = min(out["tls_critical_days"], out["tls_warn_days"])
    ports = out.get("tls_ports")
    out["tls_ports"] = sorted({int(p) for p in ports if str(p).strip().isdigit() and 0 < int(p) < 65536}) \
        if isinstance(ports, list) else list(DEFAULTS["tls_ports"])
    for k, ph in (("fwd_command", "{domain}"), ("probe_tcp_command", "{ip}"), ("probe_http_command", "{host}"),
                  ("tls_command", "{ip}")):
        v = str(out[k] or "").strip()
        out[k] = v if ph in v and template_ok(v) else DEFAULTS[k]
    for k in ("public_cluster_ids", "exclude_namespaces"):
        v = out.get(k)
        out[k] = [str(i).strip() for i in v if str(i).strip()] if isinstance(v, list) else []
    out["schedule_cron"] = str(out["schedule_cron"] or DEFAULTS["schedule_cron"]).strip()
    cmd = str(out["ptr_command"] or "").strip()
    out["ptr_command"] = cmd if "{ip}" in cmd else DEFAULT_PTR_COMMAND
    return out


def template_ok(t: str) -> bool:
    """명령 템플릿이 허용된 자리표시만 쓰는지(`{{`/`}}` 은 리터럴 중괄호)."""
    try:
        t.format(domain="d", ip="1.1.1.1", port=1, host="h", scheme="http", timeout=1, sni="")
        return True
    except (KeyError, IndexError, ValueError):
        return False


def get_settings(db: Session) -> dict[str, Any]:
    row = _row(db)
    return normalize(row.value if row and isinstance(row.value, dict) else {})


def set_settings(db: Session, values: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting
    merged = normalize({**get_settings(db), **{k: v for k, v in (values or {}).items() if k in DEFAULTS}})
    row = _row(db)
    if row:
        row.value = merged
    else:
        db.add(AppSetting(key=SETTINGS_KEY, value=merged))
    db.commit()
    return merged


def public_clusters(db: Session) -> list:
    from app.services.public_pages import public_clusters as _pc
    return _pc(db, get_settings(db)["public_cluster_ids"])


# ── 엔드포인트 추출(순수 함수 — K8s 객체만 받는다) ─────────────────────────────────
def _port_target(p) -> Optional[str]:
    tp = getattr(p, "target_port", None)
    return None if tp is None else str(tp)


def service_entries(svc, include_nodeport: bool = True) -> list[dict[str, Any]]:
    md, spec = svc.metadata, svc.spec
    if spec is None:
        return []
    ns, name = md.namespace, md.name
    stype = spec.type or "ClusterIP"
    ports = spec.ports or []
    out: list[dict[str, Any]] = []

    def add(kind, ip, hostname, port, p):
        out.append({
            "kind": kind, "namespace": ns, "name": name, "ip": ip, "hostname": hostname, "host": None,
            "port": port, "protocol": (getattr(p, "protocol", None) or "TCP"), "scheme": None,
            "port_name": getattr(p, "name", None), "target": _port_target(p), "paths": [],
            "service_type": stype,
        })

    if stype == "LoadBalancer":
        lb = svc.status.load_balancer if svc.status else None
        for ing in (lb.ingress if lb and lb.ingress else []):
            for p in ports:
                add("LoadBalancer", getattr(ing, "ip", None), getattr(ing, "hostname", None), p.port, p)
    for ip in (getattr(spec, "external_i_ps", None) or []):
        for p in ports:
            add("ExternalIP", ip, None, p.port, p)
    if include_nodeport and stype == "NodePort":
        for p in ports:
            if getattr(p, "node_port", None):
                add("NodePort", None, None, p.node_port, p)
    return out


def ingress_entries(ing) -> list[dict[str, Any]]:
    md, spec = ing.metadata, ing.spec
    if spec is None:
        return []
    lb = ing.status.load_balancer if ing.status else None
    addrs = [(getattr(a, "ip", None), getattr(a, "hostname", None)) for a in (lb.ingress if lb and lb.ingress else [])]
    if not addrs:
        addrs = [(None, None)]
    tls = spec.tls or []
    tls_all = any(not (t.hosts or []) for t in tls)
    tls_hosts = {h for t in tls for h in (t.hosts or [])}
    cls = getattr(spec, "ingress_class_name", None)
    out: list[dict[str, Any]] = []
    for rule in (spec.rules or []):
        host = rule.host
        paths = []
        for hp in ((rule.http.paths if rule.http else None) or []):
            be = hp.backend
            svc = be.service if be else None
            if svc is not None:
                port = svc.port.number if svc.port and svc.port.number else (svc.port.name if svc.port else None)
                paths.append(f"{hp.path or '/'} → {svc.name}:{port}")
            else:
                paths.append(hp.path or "/")
        schemes = [("http", 80)]
        if tls and (tls_all or (host and host in tls_hosts)):
            schemes.append(("https", 443))
        for ip, hostname in addrs:
            for scheme, port in schemes:
                out.append({
                    "kind": "Ingress", "namespace": md.namespace, "name": md.name, "ip": ip, "hostname": hostname,
                    "host": host, "port": port, "protocol": "TCP", "scheme": scheme, "port_name": None,
                    "target": None, "paths": paths, "service_type": cls,
                })
    return out


def node_addresses(nodes) -> list[dict[str, Any]]:
    out = []
    for n in nodes:
        internal = external = None
        for a in (n.status.addresses if n.status and n.status.addresses else []):
            if a.type == "InternalIP" and not internal:
                internal = a.address
            elif a.type == "ExternalIP" and not external:
                external = a.address
        out.append({"name": n.metadata.name, "internal_ip": internal, "external_ip": external})
    return sorted(out, key=lambda x: x["name"])


def lookup_ips(entries: list[dict[str, Any]]) -> list[str]:
    """역조회 대상 — 유효한 IP 리터럴만(LB hostname 은 이미 이름이라 제외)."""
    ips = set()
    for e in entries:
        ip = e.get("ip")
        if not ip:
            continue
        try:
            ipaddress.ip_address(ip)
        except ValueError:
            continue
        ips.add(ip)
    return sorted(ips)


# ── 역조회 ─────────────────────────────────────────────────────────────────────
_NAME_PATTERNS = (
    re.compile(r"name\s*=\s*(\S+)"),                 # nslookup
    re.compile(r"domain name pointer\s+(\S+)"),       # host
)


def parse_ptr_output(ip: str, text: str) -> list[str]:
    names: list[str] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        found = None
        for pat in _NAME_PATTERNS:
            m = pat.search(line)
            if m:
                found = [m.group(1)]
                break
        if found is None:
            parts = line.split()
            if len(parts) >= 2 and parts[0] == ip:      # getent hosts: "<ip> name alias..."
                found = parts[1:]
            elif len(parts) == 1 and parts[0].endswith(".") and not parts[0].startswith(";"):
                found = parts                            # dig +short -x: "name."
        for n in found or []:
            n = n.rstrip(".")
            if n and n != ip and n not in names:
                names.append(n)
    return names


def build_ssh_script(ips: list[str], command: str) -> str:
    """IP 마다 구분선 + 역조회 명령. IP 는 ipaddress 로 검증된 리터럴만 들어온다(셸 주입 차단)."""
    lines = []
    for ip in ips:
        ipaddress.ip_address(ip)
        lines.append(f"echo '@@PTR {ip}'; {command.replace('{ip}', ip)}; echo")
    return "\n".join(lines)


def split_ssh_output(text: str) -> dict[str, str]:
    out: dict[str, list[str]] = {}
    cur = None
    for line in (text or "").splitlines():
        if line.startswith("@@PTR "):
            cur = line[6:].strip()
            out[cur] = []
        elif cur:
            out[cur].append(line)
    return {k: "\n".join(v) for k, v in out.items()}


def resolve_ssh(ips: list[str], target, command: str, emit: Emit) -> dict[str, list[str]]:
    from app.services.ssh_runner import _exec_ssh
    if not ips:
        return {}
    script = build_ssh_script(ips, command)
    emit("info", f"SSH {target.username}@{target.host}:{target.port} 에서 역조회 {len(ips)}건 실행")
    emit("info", f"명령: {command}")
    res = _exec_ssh(target, script, connect_timeout=10, exec_timeout=min(600, 10 + 3 * len(ips)),
                    max_stdout_chars=400_000)
    if res.status != "ok" and not res.stdout:
        emit("error", f"SSH 실행 실패({res.status}): {res.error or res.stderr[:300]}")
        return {}
    blocks = split_ssh_output(res.stdout)
    out = {}
    for ip in ips:
        names = parse_ptr_output(ip, blocks.get(ip, ""))
        out[ip] = names
        emit("info" if names else "warn", f"  {ip} → {', '.join(names) if names else '이름 없음'}")
    return out


def resolve_backend(ips: list[str], timeout: float, emit: Emit) -> dict[str, list[str]]:
    if not ips:
        return {}

    def one(ip: str) -> list[str]:
        try:
            name, aliases, _ = socket.gethostbyaddr(ip)
            return [n for n in [name, *aliases] if n and n != ip]
        except Exception:  # noqa: BLE001
            return []

    out: dict[str, list[str]] = {}
    pool = ThreadPoolExecutor(max_workers=min(16, len(ips)))
    futs = {pool.submit(one, ip): ip for ip in ips}
    done, pending = wait(futs, timeout=timeout + 1 + len(ips) * timeout / 16)
    for f in done:
        out[futs[f]] = f.result()
    for f in pending:
        out[futs[f]] = []
    pool.shutdown(wait=False, cancel_futures=True)
    hit = sum(1 for v in out.values() if v)
    emit("info", f"backend 역조회 {len(ips)}건 — 이름 확인 {hit}건, 없음/시간초과 {len(ips) - hit}건")
    return out


# ── 수집 ───────────────────────────────────────────────────────────────────────
def _snapshot(db: Session, cluster_id) -> Optional[ExternalServiceSnapshot]:
    return db.query(ExternalServiceSnapshot).filter(ExternalServiceSnapshot.cluster_id == cluster_id).first()


def collect(db: Session, cluster, *, resolver: str = "backend", ssh_target=None, actor: str = "schedule",
            emit: Optional[Emit] = None, step: Optional[StepEmit] = None,
            forward_check: Optional[bool] = None, probe: Optional[bool] = None,
            tls_check: Optional[bool] = None) -> dict[str, Any]:
    """동기 수집(Celery·SSE 실행기에서 부른다). 결과 요약을 돌려주고 스냅샷을 저장한다."""
    from kubernetes import client as k8s_client
    from app.services.k8s_client_pool import get_api_client

    emit = emit or (lambda lvl, msg: log.info("[external-services %s] %s", lvl, msg))
    step = step or (lambda *_: None)
    cfg = get_settings(db)
    snap = _snapshot(db, cluster.id)
    if snap is None:
        snap = ExternalServiceSnapshot(cluster_id=cluster.id, entries=[], ptr_cache={})
        db.add(snap)

    step("k8s", "K8s 조회", "running")
    try:
        api = get_api_client(cluster)
        core, net = k8s_client.CoreV1Api(api), k8s_client.NetworkingV1Api(api)
        svcs = core.list_service_for_all_namespaces(_request_timeout=30).items
        emit("info", f"Service {len(svcs)}개 조회")
        try:
            ings = net.list_ingress_for_all_namespaces(_request_timeout=30).items
        except Exception as e:  # noqa: BLE001
            ings = []
            emit("warn", f"Ingress 조회 실패(건너뜀): {str(e)[:200]}")
        emit("info", f"Ingress {len(ings)}개 조회")
        nodes = []
        if cfg["include_nodeport"]:
            try:
                nodes = node_addresses(core.list_node(_request_timeout=30).items)
                emit("info", f"노드 {len(nodes)}개 주소 조회(NodePort 접근용)")
            except Exception as e:  # noqa: BLE001
                emit("warn", f"노드 조회 실패(NodePort 주소 생략): {str(e)[:200]}")
    except Exception as e:  # noqa: BLE001
        step("k8s", "K8s 조회", "failed")
        msg = f"K8s 조회 실패: {str(e)[:300]}"
        emit("error", msg)
        snap.error = msg[:1000]
        db.commit()
        return {"ok": False, "error": msg}
    step("k8s", "K8s 조회", "done")

    step("extract", "엔드포인트 추출", "running")
    excluded = set(cfg["exclude_namespaces"])
    entries: list[dict[str, Any]] = []
    for s in svcs:
        if s.metadata.namespace not in excluded:
            entries.extend(service_entries(s, cfg["include_nodeport"]))
    for i in ings:
        if i.metadata.namespace not in excluded:
            entries.extend(ingress_entries(i))
    by_kind: dict[str, int] = {}
    for e in entries:
        by_kind[e["kind"]] = by_kind.get(e["kind"], 0) + 1
    emit("info", "엔드포인트 " + (", ".join(f"{k} {v}" for k, v in sorted(by_kind.items())) or "0건"))
    if excluded:
        emit("info", f"제외 네임스페이스: {', '.join(sorted(excluded))}")
    step("extract", "엔드포인트 추출", "done")

    ips = lookup_ips(entries)
    cache: dict[str, Any] = dict(snap.ptr_cache or {})
    used = "none"
    if resolver != "none" and ips:
        step("ptr", "IP → 도메인 역조회", "running")
        now = datetime.utcnow().isoformat()
        results: dict[str, list[str]] = {}
        if resolver == "ssh" and ssh_target is not None:
            try:
                results = resolve_ssh(ips, ssh_target, cfg["ptr_command"], emit)
                used = "ssh"
            except Exception as e:  # noqa: BLE001
                emit("error", f"SSH 역조회 실패: {str(e)[:300]}")
            for ip, names in results.items():
                if names:
                    cache[ip] = {"names": names, "source": "ssh", "host": ssh_target.host, "resolved_at": now}
        rest = [ip for ip in ips if not results.get(ip)]
        if cfg["backend_ptr"] and rest:
            back = resolve_backend(rest, cfg["dns_timeout_sec"], emit)
            used = used if used == "ssh" else "backend"
            for ip, names in back.items():
                # SSH 로 찾은 이름은 backend 결과(없음 포함)로 덮지 않는다.
                prev = cache.get(ip) or {}
                if names and prev.get("source") != "ssh":
                    cache[ip] = {"names": names, "source": "backend", "host": None, "resolved_at": now}
        resolved = sum(1 for ip in ips if (cache.get(ip) or {}).get("names"))
        emit("info", f"도메인 확인 {resolved}/{len(ips)} IP (캐시 포함)")
        step("ptr", "IP → 도메인 역조회", "done")
    elif not ips:
        emit("info", "역조회할 외부 IP 없음")

    ptr_cache = {ip: v for ip, v in cache.items() if ip in set(ips)}
    use_node = ssh_target is not None and cfg["check_source"] in ("auto", "node")
    if cfg["check_source"] == "node" and ssh_target is None:
        emit("warn", "점검 위치가 node 지만 SSH 자격증명이 없어 backend 에서 점검한다")
    where = f"노드 {ssh_target.host}" if use_node else "backend"
    now = datetime.utcnow().isoformat()

    fwd_cache = dict(snap.fwd_cache or {})
    do_fwd = cfg["forward_check"] if forward_check is None else forward_check
    domains = chk.forward_domains(entries, ptr_cache)
    if do_fwd and domains:
        step("fwd", "도메인 정방향 검증", "running")
        try:
            res = (chk.resolve_forward_ssh(domains, ssh_target, cfg["fwd_command"], emit) if use_node
                   else chk.resolve_forward_backend(domains, cfg["dns_timeout_sec"], emit))
        except Exception as e:  # noqa: BLE001
            res = {}
            emit("error", f"정방향 검증 실패: {str(e)[:300]}")
        for d, r in res.items():
            fwd_cache[d] = {**r, "source": "node" if use_node else "backend", "checked_at": now}
        ip_domains = [(e.get("ip"), e.get("host") or next(iter((ptr_cache.get(e.get("ip") or "") or {}).get("names") or []), None))
                      for e in entries if e.get("ip")]
        stat = {"match": 0, "mismatch": 0, "nxdomain": 0}
        for ip, d in {(ip, (d or "").rstrip(".")) for ip, d in ip_domains if d}:
            st = chk.forward_status(ip, fwd_cache.get(d))
            if st in stat:
                stat[st] += 1
                if st != "match":
                    got = ", ".join((fwd_cache.get(d) or {}).get("ips") or []) or "없음"
                    emit("warn", f"  {d} → {got} (엔드포인트 {ip}) — {'불일치' if st == 'mismatch' else '조회 안 됨'}")
        emit("info" if not (stat["mismatch"] or stat["nxdomain"]) else "warn",
             f"정방향 검증({where}) 도메인 {len(res)}개 — 일치 {stat['match']} · 불일치 {stat['mismatch']} · 조회 안 됨 {stat['nxdomain']}")
        step("fwd", "도메인 정방향 검증", "done")
    fwd_cache = {d: v for d, v in fwd_cache.items() if d in set(domains)}

    probe_results = dict(snap.probe_results or {})
    do_probe = cfg["probe_enabled"] if probe is None else probe
    targets = chk.probe_targets(entries, nodes, cfg["probe_http"], cfg["probe_max"]) if do_probe else []
    if targets:
        step("probe", "응답 확인", "running")
        t_out = cfg["probe_timeout_sec"]
        try:
            res = (chk.probe_ssh(targets, ssh_target, cfg["probe_tcp_command"], cfg["probe_http_command"], t_out, emit)
                   if use_node else chk.probe_backend(targets, t_out, emit))
        except Exception as e:  # noqa: BLE001
            res = {}
            emit("error", f"응답 확인 실패: {str(e)[:300]}")
        for k, r in res.items():
            probe_results[k] = {**r, "source": "node" if use_node else "backend", "checked_at": now}
        bad = [(k, r) for k, r in res.items() if not r.get("reachable")]
        for k, r in bad[:30]:
            _, host, ip, port = k.split("|", 3)
            emit("warn", f"  {host or ip}:{port} ({ip}) — {chk.probe_label(r)}")
        if len(bad) > 30:
            emit("warn", f"  … 응답 없음 {len(bad) - 30}건 더")
        emit("info" if not bad else "warn", f"응답 확인({where}) {len(res)}건 — 응답 {len(res) - len(bad)} · 응답 없음 {len(bad)}")
        step("probe", "응답 확인", "done")
    keep = {chk.probe_key(t) for t in chk.probe_targets(entries, nodes, cfg["probe_http"], 10 ** 6)}
    probe_results = {k: v for k, v in probe_results.items() if k in keep}

    tls_results = dict(snap.tls_results or {})
    do_tls = cfg["tls_check"] if tls_check is None else tls_check
    tls_all = tls.tls_targets(entries, nodes, ptr_cache, cfg["tls_ports"], 10 ** 6)
    tls_tg = tls_all[: cfg["probe_max"]] if do_tls else []
    if tls_tg:
        step("tls", "TLS 인증서 확인", "running")
        t_out = cfg["probe_timeout_sec"]
        try:
            res = (tls.fetch_ssh(tls_tg, ssh_target, cfg["tls_command"], t_out, emit) if use_node
                   else tls.fetch_backend(tls_tg, t_out, emit))
        except Exception as e:  # noqa: BLE001
            res = {}
            emit("error", f"인증서 확인 실패: {str(e)[:300]}")
        counts = {"ok": 0, "warning": 0, "critical": 0, "expired": 0, "error": 0, "mismatch": 0}
        for k, r in res.items():
            tls_results[k] = {**r, "source": "node" if use_node else "backend", "checked_at": now}
            host, ip, port = k.split("|", 2)
            v = tls.tls_view(tls_results[k], host or None, cfg["tls_warn_days"], cfg["tls_critical_days"])
            counts[v["level"]] += 1
            if v.get("host_match") is False:
                counts["mismatch"] += 1
            if tls.is_issue(v) or v["level"] == "error":
                what = (v["error"] if v["level"] == "error" else
                        "만료됨" if v["level"] == "expired" else f"D-{v['days_left']} ({v['not_after'][:10]})")
                if v.get("host_match") is False:
                    what += f" · 호스트 불일치(인증서: {', '.join((v['san'] or [v['subject_cn'] or '?'])[:3])})"
                emit("warn", f"  {host or ip}:{port} ({ip}) — {what}")
        emit("warn" if counts["expired"] or counts["critical"] or counts["warning"] or counts["mismatch"] else "info",
             f"인증서 확인({where}) {len(res)}건 — 정상 {counts['ok']} · 임박 {counts['warning'] + counts['critical']}"
             f" · 만료 {counts['expired']} · 호스트 불일치 {counts['mismatch']} · 확인 실패 {counts['error']}"
             f" (경고 {cfg['tls_warn_days']}일·위험 {cfg['tls_critical_days']}일)")
        step("tls", "TLS 인증서 확인", "done")
    tls_keep = {tls.tls_key(t) for t in tls_all}
    tls_results = {k: v for k, v in tls_results.items() if k in tls_keep}

    # 외부 노출 변경 이력 — 직전 수집과 비교(첫 수집은 기준선이라 기록하지 않는다).
    if snap.collected_at is not None:
        try:
            added, removed = diff_entries(snap.entries or [], entries)
            for change, items in (("added", added), ("removed", removed)):
                for e in items:
                    db.add(ExternalServiceChange(
                        cluster_id=cluster.id, change=change, entry_key=entry_key(e), kind=e.get("kind") or "",
                        namespace=e.get("namespace") or "", name=e.get("name") or "",
                        address=e.get("ip") or e.get("hostname"), host=e.get("host"), port=e.get("port"),
                        scheme=e.get("scheme"), collected_by=actor))
            if added or removed:
                emit("warn" if added else "info", f"노출 변경 — 새로 열림 {len(added)} · 사라짐 {len(removed)}")
                for change, items in (("+", added), ("-", removed)):
                    for e in items[:20]:
                        emit("info", f"  {change} {e.get('kind')} {e.get('namespace')}/{e.get('name')} "
                                     f"{e.get('host') or e.get('ip') or e.get('hostname') or '<노드 IP>'}:{e.get('port')}")
            else:
                emit("info", "노출 변경 없음(직전 수집과 동일)")
            cutoff = datetime.utcnow() - timedelta(days=cfg["change_retention_days"])
            db.query(ExternalServiceChange).filter(ExternalServiceChange.cluster_id == cluster.id,
                                                   ExternalServiceChange.detected_at < cutoff).delete(
                synchronize_session=False)
        except Exception as e:  # noqa: BLE001
            emit("warn", f"변경 이력 기록 실패(목록 저장은 계속): {str(e)[:200]}")
    else:
        emit("info", "첫 수집 — 변경 이력 기준선으로 저장")

    snap.entries = entries
    snap.node_ips = nodes
    snap.ptr_cache = ptr_cache
    snap.fwd_cache = fwd_cache
    snap.probe_results = probe_results
    snap.tls_results = tls_results
    snap.summary = {"by_kind": by_kind, "total": len(entries), "ips": len(ips),
                    "resolved": sum(1 for ip in ips if (cache.get(ip) or {}).get("names"))}
    snap.resolver = used
    snap.collected_by = actor
    snap.collected_at = datetime.utcnow()
    snap.error = None
    db.commit()
    emit("info", f"스냅샷 저장 — 엔드포인트 {len(entries)}건")
    # NS 담당자 라벨 캐시도 같이 갱신(fail-safe).
    try:
        from app.services import ns_owners
        ns_owners.refresh_labels(db, cluster, emit=emit)
    except Exception as e:  # noqa: BLE001
        db.rollback()
        emit("warn", f"NS 담당자 라벨 갱신 실패: {str(e)[:200]}")
    return {"ok": True, **snap.summary, "resolver": used}


# ── 변경 이력 ──────────────────────────────────────────────────────────────────
def entry_key(e: dict[str, Any]) -> str:
    return "|".join(str(x) for x in (e.get("kind") or "", e.get("namespace") or "", e.get("name") or "",
                                     e.get("ip") or e.get("hostname") or "", e.get("host") or "", e.get("port") or ""))[:800]


def diff_entries(prev: list[dict[str, Any]], cur: list[dict[str, Any]]) -> tuple[list[dict], list[dict]]:
    p = {entry_key(e): e for e in prev}
    c = {entry_key(e): e for e in cur}
    added = [c[k] for k in sorted(c.keys() - p.keys())]
    removed = [p[k] for k in sorted(p.keys() - c.keys())]
    return added, removed


def changes_view(db: Session, cluster, days: int = 30, limit: int = 500) -> dict[str, Any]:
    since = datetime.utcnow() - timedelta(days=days)
    q = (db.query(ExternalServiceChange)
         .filter(ExternalServiceChange.cluster_id == cluster.id, ExternalServiceChange.detected_at >= since)
         .order_by(ExternalServiceChange.detected_at.desc()))
    rows = q.limit(limit).all()
    return {
        "cluster": {"id": str(cluster.id), "name": cluster.name},
        "days": days,
        "total": q.count(),
        "added": sum(1 for r in rows if r.change == "added"),
        "removed": sum(1 for r in rows if r.change == "removed"),
        "items": [{
            "detected_at": r.detected_at.isoformat(), "change": r.change, "kind": r.kind,
            "namespace": r.namespace, "name": r.name, "address": r.address, "host": r.host,
            "port": r.port, "scheme": r.scheme,
            "by": "정기 수집" if r.collected_by == "schedule" else "수동 수집",
        } for r in rows],
    }


# ── 공개 응답 ───────────────────────────────────────────────────────────────────
def public_view(db: Session, cluster) -> dict[str, Any]:
    snap = _snapshot(db, cluster.id)
    if snap is None:
        return {"cluster": {"id": str(cluster.id), "name": cluster.name}, "collected_at": None, "entries": [],
                "node_ips": [], "summary": None, "error": None}
    cache = snap.ptr_cache or {}
    fwd = snap.fwd_cache or {}
    probes = snap.probe_results or {}
    tls_res = snap.tls_results or {}
    cfg = get_settings(db)
    nodes = snap.node_ips or []
    entries = []
    tls_expiring = 0
    try:
        from app.services import ns_owners
        owner_of = ns_owners.resolver(db, cluster.id)
    except Exception:  # noqa: BLE001
        log.exception("ns owner resolver failed cluster=%s", cluster.id)
        owner_of = lambda _ns: None  # noqa: E731
    new_keys: set[str] = set()
    if cfg["new_badge_days"] > 0:
        since = datetime.utcnow() - timedelta(days=cfg["new_badge_days"])
        new_keys = {k for (k,) in db.query(ExternalServiceChange.entry_key).filter(
            ExternalServiceChange.cluster_id == cluster.id, ExternalServiceChange.change == "added",
            ExternalServiceChange.detected_at >= since).all()}
    issues = 0
    for e in snap.entries or []:
        ptr = cache.get(e.get("ip") or "") or {}
        names = ptr.get("names") or []
        dom = (e.get("host") or (names[0] if names else None) or "").rstrip(".") or None
        rec = fwd.get(dom) if dom else None
        fst = chk.forward_status(e.get("ip"), rec)
        pr = None
        tgt = chk.probe_targets([e], nodes, True, 1) + chk.probe_targets([e], nodes, False, 1)
        for t in tgt:
            if chk.probe_key(t) in probes:
                pr = probes[chk.probe_key(t)]
                break
        tkey = tls.entry_tls_key(e, nodes, cache, cfg["tls_ports"])
        tv = tls.tls_view(tls_res.get(tkey) if tkey else None, tkey.split("|", 1)[0] or None if tkey else None,
                          cfg["tls_warn_days"], cfg["tls_critical_days"])
        if tv and tv["level"] in ("warning", "critical", "expired"):
            tls_expiring += 1
        if fst in ("mismatch", "nxdomain") or (pr is not None and not pr.get("reachable")) or tls.is_issue(tv):
            issues += 1
        entries.append({
            **e, "ptr_names": names, "ptr_source": ptr.get("source"),
            "fwd": None if fst is None else {"domain": dom, "status": fst, "ips": rec.get("ips") or [],
                                             "source": rec.get("source"), "checked_at": rec.get("checked_at")},
            "probe": None if pr is None else {k: pr.get(k) for k in (
                "reachable", "method", "http_status", "latency_ms", "error", "source", "checked_at")},
            "tls": tv,
            "owner": owner_of(e.get("namespace") or ""),
            "is_new": entry_key(e) in new_keys,
        })
    return {
        "cluster": {"id": str(cluster.id), "name": cluster.name},
        "collected_at": snap.collected_at.isoformat() if snap.collected_at else None,
        "collected_by": "정기 수집" if snap.collected_by == "schedule" else "수동 수집",
        "resolver": snap.resolver,
        "summary": {**(snap.summary or {}), "issues": issues, "tls_expiring": tls_expiring},
        "tls_thresholds": {"warn_days": cfg["tls_warn_days"], "critical_days": cfg["tls_critical_days"]},
        "new_badge_days": cfg["new_badge_days"],
        "error": snap.error,
        "entries": entries,
        "node_ips": snap.node_ips or [],
    }
