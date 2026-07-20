"""커스텀 HTTP/TCP 프로브 — admin 이 UI 에서 코드 없이 만드는 범용 점검.

registry 의 다른 체커와 달리 "무엇을 점검할지"가 전부 params 로 정의된다:
``endpoints`` 에 URL(http/https) 또는 ``host:port`` 를 등록하면
URL 은 HTTP GET(기대 status 범위 + 본문 정규식 검사), host:port 는 TCP connect 로
프로브한다. 실패율/지연 임계값으로 상태를 판정한다.

같은 check_type 으로 여러 정의(인스턴스)를 만들어 서로 다른 대상을 점검하는
용도이므로 기본 시드(seed_default)에서 제외된다.
"""
from __future__ import annotations

import re
import socket
import time
from typing import Any

import httpx

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)


def _parse_status_range(spec: str) -> tuple[int, int]:
    """"200-399" / "200" 형식을 (lo, hi) 로. 파싱 실패 시 (200, 399)."""
    raw = (spec or "").strip()
    m = re.fullmatch(r"(\d{3})\s*-\s*(\d{3})", raw)
    if m:
        return int(m.group(1)), int(m.group(2))
    if re.fullmatch(r"\d{3}", raw):
        return int(raw), int(raw)
    return 200, 399


class CustomHttpChecker(DeepCheckerBase):
    check_type = "custom_http"
    display_name = "커스텀 HTTP/TCP 프로브"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_pct = float(ctx.thresholds.get("warning_failure_pct", 1))
        critical_pct = float(ctx.thresholds.get("critical_failure_pct", 50))
        warning_latency = int(ctx.thresholds.get("warning_latency_ms", 0) or 0)
        critical_latency = int(ctx.thresholds.get("critical_latency_ms", 0) or 0)

        endpoints = [str(e).strip() for e in (ctx.params.get("endpoints") or []) if str(e).strip()]
        timeout = float(ctx.params.get("http_timeout_seconds", 5))
        verify_tls = bool(ctx.params.get("verify_tls", False))
        status_lo, status_hi = _parse_status_range(str(ctx.params.get("expected_status", "200-399")))
        body_regex = str(ctx.params.get("body_regex", "") or "")

        with self._step("resolve", "대상 endpoint 해석") as st:
            st.detail = f"{len(endpoints)}개 endpoint"
            st.metrics = {"endpoints": len(endpoints)}
        if not endpoints:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="params.endpoints 에 URL 또는 host:port 를 1개 이상 등록하세요.",
                details={"endpoints": []},
            )

        results: list[dict[str, Any]] = []
        with self._step("probe", "endpoint 프로브") as st:
            for target in endpoints:
                if target.startswith(("http://", "https://")):
                    r = self._probe_http(
                        target, timeout=timeout, verify_tls=verify_tls,
                        status_lo=status_lo, status_hi=status_hi, body_regex=body_regex,
                    )
                else:
                    r = self._probe_tcp(target, timeout=timeout)
                r["target"] = target
                results.append(r)
            ok_n = sum(1 for r in results if r["ok"])
            st.detail = f"성공 {ok_n} / 실패 {len(results) - ok_n}"
            st.metrics = {"success": ok_n, "failure": len(results) - ok_n}

        with self._step("verdict", "실패율 · 지연 임계 비교") as st:
            total = len(results)
            fail = sum(1 for r in results if not r["ok"])
            fail_pct = round((fail / total) * 100, 2)
            latencies = [r.get("latency_ms") for r in results if r.get("latency_ms") is not None]
            max_latency = max(latencies) if latencies else None

            status = StatusEnum.healthy
            reasons: list[str] = []
            if fail_pct >= critical_pct:
                status = StatusEnum.critical
                reasons.append(f"실패율 {fail_pct}% ≥ {critical_pct}%")
            elif fail_pct >= warning_pct and fail > 0:
                status = StatusEnum.warning
                reasons.append(f"실패율 {fail_pct}% ≥ {warning_pct}%")
            if max_latency is not None:
                if critical_latency and max_latency >= critical_latency:
                    status = StatusEnum.critical
                    reasons.append(f"최대 지연 {max_latency}ms ≥ {critical_latency}ms")
                elif warning_latency and max_latency >= warning_latency and status == StatusEnum.healthy:
                    status = StatusEnum.warning
                    reasons.append(f"최대 지연 {max_latency}ms ≥ {warning_latency}ms")
            st.detail = "; ".join(reasons) or "임계 이내"
            st.metrics = {"failure_pct": fail_pct, "max_latency_ms": max_latency}

        message = f"{total}개 endpoint 프로브 — 성공 {total - fail} / 실패 {fail} (실패율 {fail_pct}%)"
        if max_latency is not None:
            message += f", 최대 지연 {max_latency}ms"
        return DeepCheckOutcome(
            status=status,
            message=message,
            details={
                "total": total,
                "failure": fail,
                "failure_pct": fail_pct,
                "max_latency_ms": max_latency,
                "expected_status": f"{status_lo}-{status_hi}",
                "body_regex": body_regex or None,
                "results": results,
            },
        )

    @staticmethod
    def _probe_http(
        url: str, *, timeout: float, verify_tls: bool,
        status_lo: int, status_hi: int, body_regex: str,
    ) -> dict[str, Any]:
        start = time.time()
        try:
            with httpx.Client(timeout=timeout, verify=verify_tls) as cli:
                resp = cli.get(url)
            elapsed = int((time.time() - start) * 1000)
            ok = status_lo <= resp.status_code <= status_hi
            body_matched: bool | None = None
            if ok and body_regex:
                body_matched = re.search(body_regex, resp.text or "") is not None
                ok = body_matched
            return {
                "kind": "http",
                "ok": ok,
                "status_code": resp.status_code,
                "latency_ms": elapsed,
                "body_matched": body_matched,
                "body_preview": (resp.text or "")[:200],
            }
        except Exception as e:  # noqa: BLE001
            return {"kind": "http", "ok": False, "error": str(e)[:300]}

    @staticmethod
    def _probe_tcp(target: str, *, timeout: float) -> dict[str, Any]:
        host, _, port_str = target.rpartition(":")
        if not host or not port_str.isdigit():
            return {"kind": "tcp", "ok": False, "error": f"invalid host:port format ({target})"}
        start = time.time()
        try:
            sock = socket.create_connection((host, int(port_str)), timeout=timeout)
            sock.close()
            return {"kind": "tcp", "ok": True, "latency_ms": int((time.time() - start) * 1000)}
        except Exception as e:  # noqa: BLE001
            return {"kind": "tcp", "ok": False, "error": str(e)[:300]}
