"""클러스터 단위 접근 판정 — 테넌트 바인딩 기반 (멀티테넌시 1단계).

규칙은 ``models/tenant.py`` docstring 참고. 요약:
- admin → 항상 허용.
- 바인딩 없는 클러스터 → 허용(opt-in 격리, 기존 설치 호환).
- 바인딩 있는 클러스터 → 사용자가 속한 테넌트의 바인딩 중 가장 높은 access 가 요구 수준 이상일 때만.

전역 role 게이트(``require_operator``)는 각 라우터가 그대로 건다 — 여기선 클러스터 범위만 본다.

SSH 콘솔(host 로 접속하는 경로)은 :func:`require_hosts_scope` / :func:`arequire_hosts_scope` 로 host 가
속한 클러스터를 판정하고, 돌려받은 :class:`HostScope` 의 ``connect_ip`` 로 판정한 IP 에 접속한다
(DNS rebinding 차단). 격리 사용 중 해석되지 않는 host 는 403(fail-closed) — 아래 "host → cluster" 절.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import re
import socket
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import wait as futures_wait
from typing import Iterable, NamedTuple
from uuid import UUID

from fastapi import HTTPException, Request, status
from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.infra_node import InfraNode
from app.models.tenant import ClusterBinding, TenantMember
from app.models.user import User

_RANK = {"read": 1, "operate": 2}

# 이 HTTP 메서드는 조회로 본다. 나머지(POST/PUT/PATCH/DELETE)는 실행·변경 = operate.
_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def _is_admin(user: User) -> bool:
    return user.role == "admin"


def cluster_access_level(db: Session, user: User, cluster_id: UUID) -> str | None:
    """사용자가 이 클러스터에 가진 access. 'operate' | 'read' | None(접근 불가).

    바인딩이 없는 클러스터는 'operate'(= 제한 없음, 전역 role 게이트에 맡김).
    """
    if _is_admin(user):
        return "operate"
    bindings = db.query(ClusterBinding).filter(ClusterBinding.cluster_id == cluster_id).all()
    if not bindings:
        return "operate"
    tenant_ids = {
        row.tenant_id
        for row in db.query(TenantMember.tenant_id).filter(TenantMember.user_id == user.id).all()
    }
    best: str | None = None
    for b in bindings:
        if b.tenant_id in tenant_ids and _RANK.get(b.access, 0) > _RANK.get(best or "", 0):
            best = b.access
    return best


def has_cluster_access(db: Session, user: User, cluster_id: UUID, level: str = "operate") -> bool:
    got = cluster_access_level(db, user, cluster_id)
    return got is not None and _RANK.get(got, 0) >= _RANK[level]


def _deny(cluster_id: UUID, level: str) -> HTTPException:
    what = "실행·변경" if level == "operate" else "조회"
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail=(f"이 클러스터({cluster_id})에 대한 {what} 권한이 없습니다. "
                "테넌트 바인딩을 확인하세요 (Settings → 테넌트)."),
    )


def require_cluster_access(db: Session, user: User, cluster_id: UUID | None, level: str = "operate") -> None:
    """핸들러 안에서 직접 호출하는 형태 — 본문/쿼리로 클러스터를 받는 엔드포인트용."""
    if cluster_id is None:
        return
    if not has_cluster_access(db, user, cluster_id, level):
        raise _deny(cluster_id, level)


def require_clusters_access(db: Session, user: User, cluster_ids: Iterable[UUID | None], level: str = "operate") -> None:
    for cid in {c for c in cluster_ids if c is not None}:
        require_cluster_access(db, user, cid, level)


# ── host → cluster 매칭 정규화 ───────────────────────────────────────────────
#
# 같은 노드에 닿는 표기가 여러 가지라 문자열 그대로 비교하면 우회된다:
#   ``167772171`` · ``10.11`` · ``012.0.0.11`` · ``0x0a.0.0.11``(전부 getaddrinfo/inet_aton 이 10.0.0.11 로 해석),
#   ``::ffff:10.0.0.11``(IPv4-mapped), ``NODE1`` · ``node1.``(대소문자·FQDN 끝 점).
# 그래서 입력·저장값을 같은 방식으로 정규화하고, IP 가 아닌 이름은 실제 접속과 같은 resolver
# (``socket.getaddrinfo``)로 풀어 나온 IP 까지 비교한다.
#
# 판정과 접속 사이의 틈 두 가지도 여기서 닫는다(격리 사용 중 = ClusterBinding 이 하나라도 있을 때만):
# - **접속 주소 고정(pinning)** — 판정이 DNS 로 푼 이름은 판정에 쓴 IP(resolver 순서의 첫 IP)를
#   ``HostScope.pinned`` 로 돌려준다. 호출부는 이를 ``SSHTarget.connect_ip`` 에 실어 TCP 를 그 IP 로 열고,
#   호스트 키 검증·감사·결과 label 은 원래 이름을 그대로 쓴다(``services/ssh_runner._build_client``).
#   판정 뒤 이름이 다른 노드로 다시 풀리는 DNS rebinding(TOCTOU)으로 다른 테넌트 노드에 닿지 못한다.
#   IP 리터럴은 고정하지 않는다(원문 그대로 접속 — getaddrinfo 가 숫자로만 해석하므로 재해석이 없다).
# - **해석 실패 = 거부(fail-closed)** — IP 리터럴도 아니고, 저장된 노드 IP·호스트명
#   (``clusters.node_ips`` · ``infra_nodes.ip_address``/``hostname``)과 리터럴로도 맞지 않고, DNS 해석도
#   실패(오류·시간 초과·빈 결과)한 이름은 ``HostScope.unresolved`` 에 담기고 :class:`HostUnresolvedError`
#   (403)로 거부된다. 판정 때 못 푼 이름이 접속 때 풀려 판정을 우회하는 경로를 막는다.
#   저장된 리터럴과 맞는 이름은 해석된 것으로 본다(접속 때 DNS 가 실패하면 그 접속이 실패할 뿐).
# 바인딩이 하나도 없으면(격리 미사용) DNS 도 고정도 거부도 없이 예전 동작 그대로다.

_RESOLVE_TIMEOUT_SEC = 2.0  # 한 번의 판정에서 DNS 를 기다리는 전체 상한
_resolver_pool = ThreadPoolExecutor(max_workers=16, thread_name_prefix="host-resolve")


# inet_aton 이 받는 레거시 IPv4 표기 — 10진/8진(0 접두)/16진(0x) 성분 1~4개.
_LEGACY_V4 = re.compile(r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}")


def _norm_literal(value: object) -> str:
    """공백 제거 → 소문자 → 끝 ``.`` 제거, IPv6 대괄호 제거."""
    s = str(value or "").strip().lower().rstrip(".")
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    return s


def _norm_ip(value: object) -> str | None:
    """IP 표기면 정규 문자열(IPv4-mapped 는 IPv4 로 풀고 IPv6 zone 은 버린다), 아니면 None.

    ``ipaddress`` 가 거부하는 레거시 IPv4 표기(정수·축약·8진·16진)는 ``socket.inet_aton`` 으로 해석한다
    — 실제 SSH 접속(getaddrinfo)이 같은 규칙으로 해석하므로 판정도 맞춘다. 네트워크 조회는 없다.
    """
    s = _norm_literal(value)
    if not s:
        return None
    try:
        addr = ipaddress.ip_address(s.split("%", 1)[0])
    except ValueError:
        if not _LEGACY_V4.fullmatch(s):
            return None
        try:
            addr = ipaddress.IPv4Address(socket.inet_aton(s))
        except (OSError, ValueError):
            return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return str(addr)


def _getaddrinfo_ips(host: str) -> list[str]:
    """getaddrinfo 결과 IP(정규화) — resolver 가 준 순서(선호 순서)를 지키고 중복만 뺀다."""
    out: list[str] = []
    for info in socket.getaddrinfo(host, None):
        ip = _norm_ip(info[4][0])
        if ip and ip not in out:
            out.append(ip)
    return out


def _ordered_ips(ips: Iterable[str]) -> list[str]:
    """해석 결과 → 순서 있는 IP 목록. 순서 없는 집합이 오면(테스트 대역 등) 정렬해 결정적으로 만든다."""
    if isinstance(ips, (set, frozenset)):
        return sorted(ips)
    return list(dict.fromkeys(ips))


def _resolve_names(names: Iterable[str], timeout: float | None = None) -> dict[str, list[str]]:
    """이름 → 해석된 IP 목록(resolver 순서). 실패·시간 초과한 이름은 결과에 없다(예외를 올리지 않는다
    — 없는 이름을 거부할지는 호출부 판정(:func:`resolve_hosts_scope` 의 ``unresolved``)이 정한다).

    getaddrinfo 는 취소할 수 없으므로 공용 스레드 풀에 넘기고 전체 ``timeout`` 까지만 기다린다
    (``socket.setdefaulttimeout`` 은 프로세스 전역이라 쓰지 않는다).
    """
    todo = set(names)
    if not todo:
        return {}
    if timeout is None:
        timeout = _RESOLVE_TIMEOUT_SEC
    try:
        futures = {_resolver_pool.submit(_getaddrinfo_ips, n): n for n in todo}
    except RuntimeError:  # 인터프리터 종료 중 등
        return {}
    done, not_done = futures_wait(futures, timeout=timeout)
    for fut in not_done:
        fut.cancel()  # 아직 시작 안 한 조회는 버린다 — 풀 적체 방지(이미 도는 조회는 취소 불가)
    out: dict[str, list[str]] = {}
    for fut in done:
        try:
            ips = _ordered_ips(fut.result())
        except Exception:  # noqa: BLE001 — gaierror·UnicodeError 등 무엇이든 "해석 실패"로 본다
            continue
        if ips:
            out[futures[fut]] = ips
    return out


async def _aresolve_names(names: Iterable[str], timeout: float | None = None) -> dict[str, list[str]]:
    """:func:`_resolve_names` 의 async 판 — 이벤트 루프를 막지 않고 기다린다.

    같은 공용 스레드 풀에서 getaddrinfo 를 돌리고 ``asyncio.wait`` 로 전체 ``timeout`` 까지만 기다린다.
    상한·결과 규칙(실패·시간 초과한 이름은 결과에 없음, 예외를 올리지 않음)은 sync 판과 같다.
    """
    todo = set(names)
    if not todo:
        return {}
    if timeout is None:
        timeout = _RESOLVE_TIMEOUT_SEC
    loop = asyncio.get_running_loop()
    try:
        futures = {loop.run_in_executor(_resolver_pool, _getaddrinfo_ips, n): n for n in todo}
    except RuntimeError:  # 인터프리터 종료 중 등
        return {}
    done, not_done = await asyncio.wait(futures, timeout=timeout)
    for fut in not_done:
        fut.cancel()  # 아직 시작 안 한 조회는 풀에서도 버려진다(이미 도는 조회는 취소 불가)
    out: dict[str, list[str]] = {}
    for fut in done:
        try:
            ips = _ordered_ips(fut.result())
        except Exception:  # noqa: BLE001 — gaierror·UnicodeError 등 무엇이든 "해석 실패"로 본다
            continue
        if ips:
            out[futures[fut]] = ips
    return out


# sync/async 판정 경로는 아래 공용 코어(_split_host_keys → [DNS] → _merge_resolved,
# _scope_precheck → [DNS] → _build_scope → _scope_from_keys)를 함께 쓴다 — 매칭·고정·거부 규칙이
# 갈라지지 않게 DNS 대기만 다르다.

HOST_UNRESOLVED_DETAIL = (
    "접속 호스트를 확인할 수 없습니다(DNS 해석 실패) — "
    "테넌트 격리가 켜진 환경에서는 해석되지 않는 호스트로 접속할 수 없습니다"
)


class HostUnresolvedError(HTTPException):
    """격리 사용 중 해석되지 않는(DNS 실패 + 저장된 노드와 리터럴 불일치) host — 403.

    REST 는 그대로 403 응답이 되고, WebSocket 콘솔은 ``scope.unresolved`` 를 직접 보고 4413 으로 닫는다.
    """

    def __init__(self, hosts: Iterable[str]):
        self.hosts = list(hosts)
        shown = ", ".join(self.hosts[:5]) + (f" 외 {len(self.hosts) - 5}개" if len(self.hosts) > 5 else "")
        super().__init__(status_code=status.HTTP_403_FORBIDDEN,
                         detail=f"{HOST_UNRESOLVED_DETAIL} ({shown})")


class HostScope(NamedTuple):
    """host 판정 결과 — :func:`resolve_hosts_scope` / :func:`aresolve_hosts_scope` 가 돌려준다.

    - ``cluster_ids``: host 들이 속한 클러스터 합집합(테넌트 판정 대상).
    - ``ips_by_host``: host(strip 한 원문) → 판정에 쓴 IP 목록(정렬). 해석 실패한 이름은 빈 목록.
    - ``pinned``: host → 실제로 접속할 IP. 격리 사용 중 DNS 로 푼 이름만 들어 있다(resolver 순서의 첫 IP —
      판정은 그 이름의 IP 전부를 봤다). IP 리터럴·격리 미사용·리터럴로만 맞은 이름은 없다(원문으로 접속).
    - ``unresolved``: 격리 사용 중 해석도 리터럴 매칭도 안 된 이름 — :meth:`raise_if_unresolved` 가 403.
    """

    cluster_ids: set[UUID]
    ips_by_host: dict[str, list[str]]
    pinned: dict[str, str]
    unresolved: list[str]

    def connect_ip(self, host: str | None) -> str | None:
        """``SSHTarget.connect_ip`` 에 넣을 값 — 고정할 IP 가 없으면 None(원문 host 로 접속)."""
        return self.pinned.get((host or "").strip())

    def raise_if_unresolved(self) -> None:
        if self.unresolved:
            raise HostUnresolvedError(self.unresolved)


def _split_host_keys(hosts: Iterable[str | None]) -> tuple[dict[str, set[str]], set[str]]:
    """입력 host(원문, strip 한 값) → (DNS 전 매칭 키 집합, DNS 로 풀어야 할 이름들). 네트워크 조회 없음."""
    keys: dict[str, set[str]] = {}
    names: set[str] = set()
    for h in hosts:
        raw = (h or "").strip()
        if not raw:
            continue
        lit = _norm_literal(raw)
        ks = {lit}
        ip = _norm_ip(raw)
        if ip:
            ks.add(ip)
        else:
            names.add(raw)
        keys[raw] = ks
    return keys, names


def _merge_resolved(keys: dict[str, set[str]], names: set[str],
                    resolved: dict[str, list[str]]) -> dict[str, set[str]]:
    for raw in names:
        keys[raw] |= set(resolved.get(raw, ()))
    return keys


def resolve_host_keys(hosts: Iterable[str | None]) -> dict[str, set[str]]:
    """입력 host(원문, strip 한 값) → 매칭 키 집합(정규화 리터럴 + 정규화 IP + DNS 로 푼 IP)."""
    keys, names = _split_host_keys(hosts)
    # 실제 접속과 같은 이름으로 푼다 — ``node1.``(절대 이름)과 ``node1``(search 도메인 적용)은 다를 수 있다.
    return _merge_resolved(keys, names, _resolve_names(names))


async def aresolve_host_keys(hosts: Iterable[str | None]) -> dict[str, set[str]]:
    """:func:`resolve_host_keys` 의 async 판 — DNS 대기가 이벤트 루프를 막지 않는다."""
    keys, names = _split_host_keys(hosts)
    return _merge_resolved(keys, names, await _aresolve_names(names))


def _isolation_enabled(db: Session) -> bool:
    """테넌트 격리 사용 중 = ClusterBinding 이 하나라도 있다. 없으면 host 판정은 예전 동작(DNS·고정·거부 없음)."""
    return db.query(ClusterBinding.id).first() is not None


def _scope_precheck(db: Session, hosts: Iterable[str | None]) -> tuple[list[str], HostScope | None]:
    """DNS 가 필요 없는 경우의 조기 결과. 반환 ``(host 목록, 조기 결과 또는 None)``.

    바인딩이 하나도 없으면(격리 미사용) DNS·클러스터 조회·고정·거부 없이 IP 리터럴만 돌려준다(예전 동작).
    """
    host_list = [h for h in hosts if h and str(h).strip()]
    if not host_list:
        return host_list, HostScope(set(), {}, {}, [])
    if not _isolation_enabled(db):
        lits = {str(h).strip(): ([ip] if (ip := _norm_ip(h)) else []) for h in host_list}
        return host_list, HostScope(set(), lits, {}, [])
    return host_list, None


def _scope_from_keys(db: Session, keys_by_host: dict[str, set[str]],
                     probe: set[str] | None = None) -> tuple[set[UUID], dict[str, list[str]], set[str]]:
    """매칭 키(DNS 해석 반영 후) → (소속 클러스터 집합, host → 판정에 쓴 IP 목록, ``probe`` 중 저장값과
    리터럴로 맞은 키). DB 조회만 한다.

    ``probe`` 는 DNS 로 못 푼 이름들의 정규화 리터럴 — 저장된 노드 IP·호스트명(클러스터 소속 여부와
    무관하게 ``infra_nodes`` 전체)과 맞으면 "알려진 이름"으로 보고 거부하지 않는다.
    """
    probe = probe or set()
    wanted: set[str] = set().union(*keys_by_host.values()) if keys_by_host else set()
    ips_by_host = {
        raw: sorted(k for k in ks if _norm_ip(k) == k) for raw, ks in keys_by_host.items()
    }
    out: set[UUID] = set()
    known: set[str] = set()
    if not wanted:
        return out, ips_by_host, known

    def _keys(value: object) -> set[str]:
        lit = _norm_literal(value)
        if not lit:
            return set()
        ip = _norm_ip(value)
        return {lit, ip} if ip else {lit}

    for cid, raw in db.query(Cluster.id, Cluster.node_ips).filter(Cluster.node_ips.isnot(None)).all():
        try:
            ips = json.loads(raw) if raw else []
        except (TypeError, ValueError):
            continue
        if not isinstance(ips, list):
            continue
        row_keys: set[str] = set().union(*(_keys(ip) for ip in ips)) if ips else set()
        known |= probe & row_keys
        if wanted & row_keys:
            out.add(cid)
    for cid, ip_addr, hostname in db.query(InfraNode.cluster_id, InfraNode.ip_address, InfraNode.hostname).all():
        row_keys = _keys(ip_addr) | _keys(hostname)
        known |= probe & row_keys
        if cid is None or cid in out:
            continue
        if wanted & row_keys:
            out.add(cid)
    return out, ips_by_host, known


def _build_scope(db: Session, keys: dict[str, set[str]], names: set[str],
                 resolved: dict[str, list[str]]) -> HostScope:
    """DNS 결과 반영 → 클러스터 매칭 + 접속 IP 고정 + 해석 실패 거부 대상 산출(격리 사용 중일 때만 호출)."""
    _merge_resolved(keys, names, resolved)
    failed = {raw for raw in names if not resolved.get(raw)}
    cluster_ids, ips_by_host, known = _scope_from_keys(
        db, keys, probe={_norm_literal(raw) for raw in failed})
    # IPv4 우선 — 컨테이너에 IPv6 경로가 없으면 v6 로 고정한 접속이 실패한다(판정은 전 주소로 이미 끝났다).
    pinned = {
        raw: sorted(resolved[raw], key=lambda ip: ":" in ip)[0]
        for raw in names if resolved.get(raw)
    }
    unresolved = sorted(raw for raw in failed if _norm_literal(raw) not in known)
    return HostScope(cluster_ids, ips_by_host, pinned, unresolved)


def resolve_hosts_scope(db: Session, hosts: Iterable[str | None]) -> HostScope:
    """host 들의 판정 결과(:class:`HostScope`) — 클러스터 집합 · 판정 IP · 접속 고정 IP · 해석 실패 이름.

    - 클러스터 매칭: ``clusters.node_ips``(정규화) · ``infra_nodes.ip_address``(정규화) ·
      ``infra_nodes.hostname``(소문자·끝 점 제거)을, 입력의 정규화 리터럴·IP·DNS 해석 IP 전부와 비교한 합집합.
      한 이름이 여러 IP 로 풀리면 IP 전부를 본다.
    - 접속 고정(``pinned``): DNS 로 푼 이름 → resolver 순서의 첫 IP. 호출부는 이 IP 로 TCP 를 열어야
      판정과 접속 사이의 DNS 재해석(rebinding)을 막는다 — :meth:`HostScope.connect_ip` → ``SSHTarget.connect_ip``.
    - 해석 실패(``unresolved``): IP 리터럴도, 저장된 노드 IP·호스트명 리터럴도 아니고 DNS 해석도 실패·시간
      초과한 이름. 호출부는 :meth:`HostScope.raise_if_unresolved`(403)로 거부한다(fail-closed).
    - 바인딩이 하나도 없으면(격리 미사용) 클러스터 조회·DNS·고정·거부를 건너뛰고
      ``HostScope(빈 집합, IP 리터럴만, {}, [])`` — 예전 동작 그대로.

    DNS 를 최대 ``_RESOLVE_TIMEOUT_SEC`` 동안 **블로킹으로** 기다린다 — sync 핸들러(FastAPI 스레드풀)용.
    ``async def`` 핸들러·WebSocket 에서는 :func:`aresolve_hosts_scope` 를 쓴다.
    """
    host_list, early = _scope_precheck(db, hosts)
    if early is not None:
        return early
    keys, names = _split_host_keys(host_list)
    # 실제 접속과 같은 이름으로 푼다 — ``node1.``(절대 이름)과 ``node1``(search 도메인 적용)은 다를 수 있다.
    return _build_scope(db, keys, names, _resolve_names(names))


async def aresolve_hosts_scope(db: Session, hosts: Iterable[str | None]) -> HostScope:
    """:func:`resolve_hosts_scope` 의 async 판 — 규칙·상한·고정·거부 동일, DNS 대기만 루프 밖에서.

    DB 조회는 호출 스레드에서 한다(Session 은 스레드 간에 넘기지 않는다).
    """
    host_list, early = _scope_precheck(db, hosts)
    if early is not None:
        return early
    keys, names = _split_host_keys(host_list)
    return _build_scope(db, keys, names, await _aresolve_names(names))


def require_hosts_scope(db: Session, user: User, hosts: Iterable[str | None],
                        also: Iterable[UUID | None] = (), level: str = "operate") -> HostScope:
    """SSH 콘솔 REST 경로 공통 — host 소속 클러스터(+``also``: 화면이 넘긴 cluster_id 등)의 ``level`` 판정,
    이어서 해석 실패 host 거부(403). 통과하면 판정 결과를 돌려준다 — 호출부는
    ``SSHTarget(..., connect_ip=scope.connect_ip(host))`` 로 판정한 IP 에 접속한다.

    sync 판(DNS 블로킹) — ``async def`` 안에서는 :func:`arequire_hosts_scope` 를 쓴다.
    """
    scope = resolve_hosts_scope(db, hosts)
    require_clusters_access(db, user, [*also, *scope.cluster_ids], level)
    scope.raise_if_unresolved()
    return scope


async def arequire_hosts_scope(db: Session, user: User, hosts: Iterable[str | None],
                               also: Iterable[UUID | None] = (), level: str = "operate") -> HostScope:
    """:func:`require_hosts_scope` 의 async 판."""
    scope = await aresolve_hosts_scope(db, hosts)
    require_clusters_access(db, user, [*also, *scope.cluster_ids], level)
    scope.raise_if_unresolved()
    return scope


def cluster_ids_for_hosts(db: Session, hosts: Iterable[str]) -> set[UUID]:
    """호스트(IP/호스트명)들이 속한 클러스터 — 노드 SSH·일괄 실행처럼 host 로 접속하는 경로의 범위 판정용.

    ``clusters.node_ips``(수집된 InternalIP JSON 배열)와 ``infra_nodes``(ip_address/hostname)를 본다.
    입력·저장값은 정규화해 비교하고(대소문자·끝 점·IPv4-mapped·레거시 IPv4 표기), 이름은 DNS 로 풀어
    나온 IP 까지 본다 — 상세는 :func:`resolve_hosts_scope`.
    어느 클러스터에도 매칭되지 않는 호스트(관리 서버 등)는 클러스터 범위 밖이라 결과에 없다.
    격리 사용 중 해석되지 않는 이름이 있으면 :class:`HostUnresolvedError`(403)를 올린다(fail-closed).
    접속 IP 고정까지 필요하면 :func:`require_hosts_scope` / :func:`resolve_hosts_scope` 를 쓴다.
    바인딩이 하나도 없으면(격리 미사용) 조회 없이 빈 집합 — 판정 결과가 같으므로 비용만 아낀다.
    sync 판(DNS 블로킹) — ``async def`` 안에서는 :func:`acluster_ids_for_hosts` 를 쓴다.
    """
    scope = resolve_hosts_scope(db, hosts)
    scope.raise_if_unresolved()
    return scope.cluster_ids


def cluster_ids_for_host(db: Session, host: str) -> set[UUID]:
    return cluster_ids_for_hosts(db, [host])


async def acluster_ids_for_hosts(db: Session, hosts: Iterable[str]) -> set[UUID]:
    """:func:`cluster_ids_for_hosts` 의 async 판 — ``async def`` 핸들러·WebSocket 용."""
    scope = await aresolve_hosts_scope(db, hosts)
    scope.raise_if_unresolved()
    return scope.cluster_ids


async def acluster_ids_for_host(db: Session, host: str) -> set[UUID]:
    return await acluster_ids_for_hosts(db, [host])


def hidden_cluster_ids(db: Session, user: User) -> frozenset[UUID]:
    """이 사용자에게 **보이지 않아야** 하는 클러스터 — 바인딩이 있는데 사용자가 어느 바인딩 테넌트의
    멤버도 아닌 클러스터. read/operate 어느 쪽이든 바인딩 멤버면 보인다(2단계 조회 격리).

    admin 이거나 바인딩이 하나도 없으면 빈 집합 — 목록 필터가 no-op 이 된다.
    """
    if _is_admin(user):
        return frozenset()
    rows = db.query(ClusterBinding.cluster_id, ClusterBinding.tenant_id).all()
    if not rows:
        return frozenset()
    mine = {
        tid for (tid,) in db.query(TenantMember.tenant_id).filter(TenantMember.user_id == user.id).all()
    }
    restricted = {cid for cid, _ in rows}
    allowed = {cid for cid, tid in rows if tid in mine}
    return frozenset(restricted - allowed)


class ClusterScope:
    """목록형 조회에 쓰는 사용자별 클러스터 가시 범위. ``auth.deps.get_cluster_scope`` 로 주입한다."""

    def __init__(self, hidden: frozenset[UUID]):
        self.hidden = hidden

    @property
    def unrestricted(self) -> bool:
        return not self.hidden

    def visible(self, cluster_id: UUID | str | None) -> bool:
        """cluster_id 가 없는 행(클러스터 무관 알람 등)은 보인다."""
        if cluster_id is None or not self.hidden:
            return True
        try:
            cid = cluster_id if isinstance(cluster_id, UUID) else UUID(str(cluster_id))
        except ValueError:
            return True
        return cid not in self.hidden

    def apply(self, query, column, *, nullable: bool = False):
        """SQLAlchemy 쿼리에 가시 범위 필터를 건다. ``nullable`` 이면 cluster_id NULL 행은 남긴다."""
        if not self.hidden:
            return query
        cond = column.notin_(list(self.hidden))
        if nullable:
            cond = column.is_(None) | cond
        return query.filter(cond)


def enforce_path_cluster_access(request: Request, db: Session, user: User) -> None:
    """경로 파라미터 ``cluster_id`` 기준 강제 — 클러스터 범위 라우터 공통 의존성에서 호출.

    조회 메서드(GET 등)는 ``read``, 나머지(POST/PUT/PATCH/DELETE)는 ``operate`` 를 요구한다.
    (1단계는 변경만 막았고, 2단계에서 조회도 바인딩 범위로 격리했다.)
    """
    level = "read" if request.method in _READ_METHODS else "operate"
    raw = request.path_params.get("cluster_id")
    if raw is None:
        return
    try:
        cid = raw if isinstance(raw, UUID) else UUID(str(raw))
    except ValueError:
        return  # 형식 오류는 라우트 검증(422)에 맡긴다
    require_cluster_access(db, user, cid, level)
