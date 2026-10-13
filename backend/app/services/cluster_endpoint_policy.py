"""클러스터 API 엔드포인트 허용 대역 정책.

클러스터 등록·수정·연결 검증은 서버가 ``api_endpoint`` 로 직접 HTTP(``/healthz``)·kubectl 요청을
보낸다. operator 가 임의 주소를 넣으면 PEP 서버가 그 주소로 요청을 보내는 셈이라(내부망 스캔
경로), 폐쇄망 운영 정책상 도달 가능한 대역을 관리자가 제한할 수 있게 한다.

- 설정: ``AppSetting`` key ``cluster_endpoint_allowlist`` = ``{"entries": [str, ...]}``.
  항목은 CIDR(``10.0.0.0/8``, 단일 IP 도 가능) 또는 호스트명(``api.k8s.local``, 하위 도메인 전체는
  ``*.k8s.local``). **비어 있으면 제한 없음(기본값)** — 기존 설치 동작 그대로.
- 판정: 엔드포인트 호스트가 IP 면 CIDR 포함 여부, 호스트명이면 호스트명 항목 일치 → 아니면
  DNS 로 풀어 **모든** 주소가 CIDR 안에 있어야 허용(일부만 맞으면 DNS 응답에 따라 우회될 수 있음).
- 적용 지점: 클러스터 생성, ``api_endpoint`` 변경, 연결 검증(``/verify``·``/verify/stream``).
  정책을 켜기 전에 등록된 클러스터는 검증 시 "허용 대역 밖" 으로 드러난다.
"""
from __future__ import annotations

import ipaddress
import re
import socket
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy.orm import Session

from app.models.app_setting import AppSetting

CLUSTER_ENDPOINT_ALLOWLIST_KEY = "cluster_endpoint_allowlist"
DEFAULT_CLUSTER_ENDPOINT_ALLOWLIST: dict[str, Any] = {"entries": []}
MAX_ENTRIES = 200

_HOSTNAME_RE = re.compile(r"^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")

Network = ipaddress.IPv4Network | ipaddress.IPv6Network


class InvalidAllowlistEntry(ValueError):
    pass


def _parse_entry(raw: str) -> Network | str:
    entry = raw.strip().lower()
    try:
        return ipaddress.ip_network(entry, strict=False)
    except ValueError:
        pass
    if _HOSTNAME_RE.match(entry):
        return entry
    raise InvalidAllowlistEntry(f"'{raw}' 는 CIDR(예: 10.0.0.0/8) 이나 호스트명(예: *.k8s.local) 이 아닙니다.")


def normalize_allowlist(raw: Any, *, strict: bool = False) -> dict[str, list[str]]:
    """저장값 정규화. ``strict`` 면 잘못된 항목에서 ``InvalidAllowlistEntry`` (저장 시),
    아니면 잘못된 항목을 건너뛴다(조회 시 — 손상된 행이 정책 전체를 깨지 않게)."""
    items = raw.get("entries") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        items = []
    out: list[str] = []
    for item in items:
        if not isinstance(item, str) or not item.strip():
            continue
        try:
            parsed = _parse_entry(item)
        except InvalidAllowlistEntry:
            if strict:
                raise
            continue
        text = str(parsed)
        if text not in out:
            out.append(text)
    if strict and len(out) > MAX_ENTRIES:
        raise InvalidAllowlistEntry(f"항목은 최대 {MAX_ENTRIES}개까지입니다.")
    return {"entries": out[:MAX_ENTRIES]}


def get_allowlist(db: Session) -> list[str]:
    try:
        row = db.query(AppSetting).filter(AppSetting.key == CLUSTER_ENDPOINT_ALLOWLIST_KEY).first()
    except Exception:  # noqa: BLE001 — 설정 조회 실패가 등록 자체를 막지 않게
        db.rollback()
        return []
    return normalize_allowlist(getattr(row, "value", None) if isinstance(row, AppSetting) else None)["entries"]


def _endpoint_host(api_endpoint: str) -> str | None:
    text = (api_endpoint or "").strip()
    if not text:
        return None
    if "://" not in text:
        text = "https://" + text
    try:
        return urlsplit(text).hostname
    except ValueError:
        return None


def _resolve(host: str) -> list[str]:
    return sorted({info[4][0] for info in socket.getaddrinfo(host, None)})


def endpoint_denied_reason(entries: list[str], api_endpoint: str, resolver=_resolve) -> str | None:
    """허용되면 None, 아니면 운영자에게 보여줄 사유."""
    if not entries or not (api_endpoint or "").strip():
        return None
    host = _endpoint_host(api_endpoint)
    if not host:
        return f"API 엔드포인트 '{api_endpoint}' 에서 호스트를 읽을 수 없습니다."
    host = host.lower()
    networks = [ipaddress.ip_network(e) for e in entries if "/" in e]
    hostnames = [e for e in entries if "/" not in e]
    allowed_text = ", ".join(entries[:5]) + (" …" if len(entries) > 5 else "")
    deny = (
        f"API 엔드포인트 '{api_endpoint}' 가 허용 대역 밖입니다 (허용: {allowed_text}). "
        "Settings → 접근 제어 → 클러스터 API 엔드포인트 허용 대역을 확인하세요."
    )

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        return None if any(ip in n for n in networks) else deny

    for h in hostnames:
        if host == h or (h.startswith("*.") and host.endswith(h[1:])):
            return None
    if not networks:
        return deny
    try:
        addrs = resolver(host)
    except OSError as e:
        return f"API 엔드포인트 호스트 '{host}' 를 해석할 수 없어 허용 대역을 확인하지 못했습니다: {str(e)[:80]}"
    if addrs and all(any(ipaddress.ip_address(a) in n for n in networks) for a in addrs):
        return None
    return deny


def check_endpoint(db: Session, api_endpoint: str) -> str | None:
    return endpoint_denied_reason(get_allowlist(db), api_endpoint)
