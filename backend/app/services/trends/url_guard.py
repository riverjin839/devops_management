"""기술 동향 아웃바운드 URL 가드 — 블라인드 SSRF 방지(A-7, 정책 ⑤).

규칙:
  - http(s) 만 받는다.
  - DNS 해석 뒤 사설·루프백·링크로컬(메타데이터 169.254.169.254 포함)·CGNAT·멀티캐스트·예약 대역이면
    차단한다(= 공인 주소만 허용). 예외는 AppSetting ``trends.settings.allowed_hosts``
    (호스트명·``*.도메인``·IP·CIDR).
  - redirect 는 직접 따라가며 **매 hop**(=최종 주소 포함)을 다시 검사한다.
  - 매 hop 은 검사한 IP 로 직접 연결한다(URL 호스트 → IP 리터럴, ``Host`` 헤더 = 원래 host, https 는
    ``sni_hostname`` 확장으로 SNI·인증서 검증을 원래 호스트명으로) — DNS rebinding 방지. 허용 호스트도 고정한다.
  - 본문은 스트리밍으로 읽어 ``MAX_BODY_BYTES``(압축 해제 후) 를 넘는 즉시 중단한다.
  - GitHub slug 는 ``^[\\w.-]+/[\\w.-]+$`` (+ ``.``/``..`` 세그먼트 금지).

HTTP 프록시 환경(폐쇄망 egress 프록시)에서 backend 가 외부 DNS 를 못 푸는 경우가 있다 — 그때는
프록시가 대신 해석하므로 DNS 실패를 차단 사유로 보지 않는다(IP 리터럴·localhost 는 여전히 차단).
프록시 경유 hop 은 주소 고정이 불가능하므로 rebinding 방어(내부 대역 차단)는 egress 프록시가 맡는다.
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import urllib.request
from typing import Iterable
from urllib.parse import urljoin, urlparse

import httpx

from app.services.trends.base import TrendCollectError

GITHUB_SLUG_RE = re.compile(r"^[\w.-]+/[\w.-]+$")
MAX_REDIRECTS = 5
MAX_BODY_BYTES = 10 * 1024 * 1024
_BLOCKED_NAMES = {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"}

# 테스트에서 httpx.MockTransport 로 바꿔 끼운다. None = httpx 기본 전송.
_TRANSPORT: httpx.AsyncBaseTransport | None = None


class UrlBlocked(TrendCollectError):
    """정책상 가져올 수 없는 주소."""


def make_client(**kw) -> httpx.AsyncClient:
    if _TRANSPORT is not None:
        kw["transport"] = _TRANSPORT
    return httpx.AsyncClient(**kw)


# ── 형식 검증(등록·수정 시 422) ────────────────────────────────────────────

def validate_github_slug(slug: str) -> str:
    s = (slug or "").strip()
    if not GITHUB_SLUG_RE.match(s) or any(part in (".", "..") for part in s.split("/")):
        raise ValueError("GitHub 저장소는 'owner/repo' 형식이어야 합니다(영문·숫자·_ . - 만)")
    return s


def validate_feed_url(url: str, allowed_hosts: Iterable[str] = ()) -> str:
    """스킴·호스트 형식 + IP 리터럴/localhost 차단. DNS 는 보지 않는다(수집 시 검사)."""
    u = (url or "").strip()
    p = urlparse(u)
    if p.scheme not in ("http", "https"):
        raise ValueError("피드 주소는 http:// 또는 https:// 로 시작해야 합니다")
    host = (p.hostname or "").lower()
    if not host:
        raise ValueError("피드 주소에 호스트가 없습니다")
    if _host_allowed(host, None, allowed_hosts):
        return u
    if host in _BLOCKED_NAMES or host.endswith(".localhost"):
        raise ValueError(f"내부 주소({host})는 허용되지 않습니다 — 필요하면 설정의 허용 호스트에 추가하세요")
    ip = _as_ip(host)
    if ip is not None and _blocked_ip(ip):
        raise ValueError(f"사설·내부 대역 주소({host})는 허용되지 않습니다 — 필요하면 설정의 허용 호스트에 추가하세요")
    return u


# ── 판정 헬퍼 ────────────────────────────────────────────────────────────

def _as_ip(host: str) -> ipaddress._BaseAddress | None:
    try:
        return ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None


def _blocked_ip(ip: ipaddress._BaseAddress) -> bool:
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    # is_global=False 는 사설(10/8·172.16/12·192.168/16·fc00::/7)·루프백·링크로컬(169.254/16, 메타데이터)·
    # CGNAT(100.64/10)·문서용·예약 대역을 모두 포함한다.
    return (not ip.is_global) or ip.is_multicast or ip.is_unspecified or ip.is_reserved


def _host_allowed(host: str, ip: ipaddress._BaseAddress | None, allowed_hosts: Iterable[str]) -> bool:
    host = host.lower().rstrip(".")
    for entry in allowed_hosts or ():
        e = str(entry).strip().lower()
        if not e:
            continue
        if e.startswith("*."):
            if host == e[2:] or host.endswith(e[1:]):
                return True
            continue
        if host == e:
            return True
        try:
            net = ipaddress.ip_network(e, strict=False)
        except ValueError:
            continue
        for cand in (ip, _as_ip(host)):
            if cand is not None and cand.version == net.version and cand in net:
                return True
    return False


def _proxy_for(url: str) -> bool:
    """이 URL 이 env 프록시(HTTP(S)_PROXY/ALL_PROXY, NO_PROXY 제외)를 타는가.

    ``make_client`` 가 transport 를 명시하면(테스트의 MockTransport) httpx 는 env 프록시를 쓰지 않는다.
    """
    if _TRANSPORT is not None:
        return False
    try:
        host = urlparse(url).hostname or ""
        if urllib.request.proxy_bypass(host):
            return False
        proxies = urllib.request.getproxies()
        return urlparse(url).scheme in proxies or "all" in proxies
    except Exception:  # noqa: BLE001
        return False


async def _resolve(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(i[4][0]) for i in infos]


def _check_addresses(host: str, addrs: Iterable[str], allowed_hosts: Iterable[str]) -> list[str]:
    """해석 결과 중 하나라도 차단 대역이면(허용 호스트 제외) ``UrlBlocked``. 연결 가능한 IP 목록을 돌려준다."""
    host_ok = _host_allowed(host, None, allowed_hosts)
    out: list[str] = []
    for a in addrs:
        ip = _as_ip(a)
        if ip is None:
            continue
        if _blocked_ip(ip) and not host_ok and not _host_allowed(host, ip, allowed_hosts):
            raise UrlBlocked(
                f"{host} 이(가) 내부 대역 {a} 로 해석되어 차단했습니다 — 사내 미러라면 설정의 허용 호스트에 추가하세요"
            )
        if str(ip) not in out:
            out.append(str(ip))
    return out


async def check_url(url: str, allowed_hosts: Iterable[str] = ()) -> None:
    """가져오기 직전 검사 — 형식 + DNS 해석 결과 전부가 공인 주소여야 한다(연결 주소 고정 없음).

    프록시 경유 hop 에서만 단독으로 쓰인다. 직접 연결은 ``_pinned_ip`` 가 같은 검사 + 주소 고정을 한다.
    """
    try:
        validate_feed_url(url, allowed_hosts)
    except ValueError as e:
        raise UrlBlocked(str(e)) from None
    p = urlparse(url)
    host = (p.hostname or "").lower()
    if _host_allowed(host, None, allowed_hosts):
        return
    if _as_ip(host) is not None:
        return  # IP 리터럴은 validate_feed_url 에서 이미 판정
    port = p.port or (443 if p.scheme == "https" else 80)
    try:
        addrs = await _resolve(host, port)
    except (socket.gaierror, OSError) as e:
        if _proxy_for(url):
            return  # 프록시가 해석한다
        raise TrendCollectError(f"DNS 조회 실패({host}) — {e}") from None
    _check_addresses(host, addrs, allowed_hosts)


async def _pinned_ip(url: str, allowed_hosts: Iterable[str]) -> str | None:
    """직접 연결 hop — 형식 검사 + DNS 해석 + 전 주소 검사 후 **연결할 IP** 를 고른다(DNS rebinding 방지).

    허용 호스트도 차단 예외일 뿐 주소 고정은 똑같이 한다. IP 리터럴이면 None(그대로 연결).
    """
    try:
        validate_feed_url(url, allowed_hosts)
    except ValueError as e:
        raise UrlBlocked(str(e)) from None
    p = urlparse(url)
    host = (p.hostname or "").lower()
    if _as_ip(host) is not None:
        return None
    port = p.port or (443 if p.scheme == "https" else 80)
    try:
        addrs = await _resolve(host, port)
    except (socket.gaierror, OSError) as e:
        raise TrendCollectError(f"DNS 조회 실패({host}) — {e}") from None
    ips = _check_addresses(host, addrs, allowed_hosts)
    if not ips:
        raise TrendCollectError(f"DNS 조회 실패({host}) — 주소 없음")
    return ips[0]


def _build_request(client: httpx.AsyncClient, url: str, ip: str | None, headers: dict | None) -> httpx.Request:
    """검사한 IP 로 연결하도록 URL 호스트를 IP 리터럴로 바꾸고(IPv6 는 httpx 가 [] 로 감싼다),
    ``Host`` 헤더는 원래 host[:port], https 는 SNI·인증서 검증이 원래 호스트명을 쓰도록 ``sni_hostname`` 확장을 준다."""
    if ip is None:
        return client.build_request("GET", url, headers=headers)
    u = httpx.URL(url)
    hdrs = {k: v for k, v in (headers or {}).items() if k.lower() != "host"}
    hdrs["Host"] = u.netloc.decode("ascii")
    ext = {"sni_hostname": u.raw_host.decode("ascii")} if u.scheme == "https" else {}
    return client.build_request("GET", u.copy_with(host=ip), headers=hdrs, extensions=ext)


def _too_big() -> TrendCollectError:
    return TrendCollectError(f"응답이 너무 큽니다({MAX_BODY_BYTES // 1024 // 1024}MB 초과)")


async def guarded_get(
    url: str,
    *,
    allowed_hosts: Iterable[str] = (),
    headers: dict | None = None,
    timeout: float = 20,
) -> httpx.Response:
    """SSRF 가드를 거친 GET — redirect 를 직접 따라가며 매 hop 을 다시 검사한다.

    매 hop 마다 해석·검사한 IP 로 직접 연결한다(검사 뒤 httpx 가 다시 해석하면 rebinding 으로 내부 주소에
    닿을 수 있다). 본문은 스트리밍으로 읽으며 ``MAX_BODY_BYTES``(압축 해제 후 기준)를 넘는 즉시 중단한다.
    실패는 ``TrendCollectError``(사유 포함)로 올린다.
    """
    allowed = list(allowed_hosts or ())
    current = url
    async with make_client(timeout=timeout, follow_redirects=False) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            if _proxy_for(current):
                # env 프록시 경유: 접속 대상은 프록시가 해석하므로 주소 고정이 불가능하다(IP 로 바꾸면 https
                # 터널의 SNI·인증서 검증이 깨진다). 사전 검사만 하고 원래 URL 로 보낸다 — 이 경우 내부 대역
                # 차단(rebinding 방어)은 egress 프록시가 맡아야 한다(docs/ENVIRONMENT.md TRENDS 항목).
                await check_url(current, allowed)
                req = _build_request(client, current, None, headers)
            else:
                req = _build_request(client, current, await _pinned_ip(current, allowed), headers)
            try:
                r = await client.send(req, stream=True)
            except httpx.TimeoutException:
                raise TrendCollectError(f"응답 시간 초과({int(timeout)}초) — {urlparse(current).hostname}") from None
            except httpx.HTTPError as e:
                raise TrendCollectError(f"연결 실패 — {type(e).__name__}: {str(e)[:200]}") from None
            try:
                if r.is_redirect:
                    loc = r.headers.get("location")
                    if not loc:
                        raise TrendCollectError(f"HTTP {r.status_code} redirect 에 Location 이 없습니다")
                    current = urljoin(current, loc)
                    continue
                if r.status_code >= 400:
                    raise TrendCollectError(f"HTTP {r.status_code} {r.reason_phrase or ''}".strip() + f" — {current}")
                cl = (r.headers.get("content-length") or "").strip()
                if cl.isdigit() and int(cl) > MAX_BODY_BYTES:
                    raise _too_big()
                buf = bytearray()
                try:
                    async for chunk in r.aiter_bytes():  # 압축 해제된 바이트 — 해제 후 크기로 센다
                        buf += chunk
                        if len(buf) > MAX_BODY_BYTES:
                            raise _too_big()
                except httpx.TimeoutException:
                    raise TrendCollectError(f"응답 시간 초과({int(timeout)}초) — {urlparse(current).hostname}") from None
                except httpx.HTTPError as e:
                    raise TrendCollectError(f"연결 실패 — {type(e).__name__}: {str(e)[:200]}") from None
                # 이미 해제한 본문이므로 인코딩·길이 헤더는 빼고 새 응답으로 돌려준다.
                drop = {"content-encoding", "content-length", "transfer-encoding"}
                return httpx.Response(
                    r.status_code,
                    headers=[(k, v) for k, v in r.headers.multi_items() if k.lower() not in drop],
                    content=bytes(buf),
                    request=r.request,
                )
            finally:
                await r.aclose()
    raise TrendCollectError(f"redirect 가 {MAX_REDIRECTS}회를 넘었습니다")
