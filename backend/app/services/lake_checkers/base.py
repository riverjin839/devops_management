"""LakeBaseChecker — LAKE 서비스 헬스체크 베이스.

cluster-level K8s SDK 가 아니라 service endpoint 를 httpx 로 직접 호출.
(in-cluster Service URL 또는 외부 노출 URL 둘 다 지원)
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Optional, TYPE_CHECKING

import httpx

from app.models import StatusEnum

if TYPE_CHECKING:
    from app.models import LakeService


# 연결 실패 vs 서버 응답은 됐지만 불건강 — pending vs warning/critical 구분.
_CONNECTION_ERROR_HINTS = (
    "connection refused", "no route to host", "timed out", "timeout",
    "network is unreachable", "ssl:", "max retries exceeded",
    "connection error", "failed to establish", "certificate verify failed",
    "name or service not known", "temporary failure",
)


@dataclass
class LakeCheckResult:
    status: StatusEnum
    message: str
    response_time_ms: int = 0
    details: dict[str, Any] = field(default_factory=dict)


class LakeBaseChecker(ABC):
    """LAKE 서비스 헬스체커 기반.

    서브클래스가 구현/override 해야 할 것:
     - healthz_path() — 필수
     - check() — 기본 구현 사용 가능. deep check 가 필요한 경우 override.
    """

    DEFAULT_TIMEOUT_SEC = 10.0

    def __init__(self, service: "LakeService"):
        self.service = service

    @abstractmethod
    def healthz_path(self) -> str:
        """e.g. '/health' for airflow, '/v1/info' for trino"""
        ...

    def check(self) -> LakeCheckResult:
        """기본 GET 헬스체크. 200 = healthy, 4xx = warning, 5xx = critical,
        연결 실패 = pending. 서브클래스는 deep check 시 super().check() 결과
        를 가공해 반환."""
        url = self.service.endpoint_url.rstrip("/") + self.healthz_path()
        verify_tls = bool(getattr(self.service, "tls_verify", False))
        t0 = time.time()
        try:
            with httpx.Client(verify=verify_tls, timeout=self.DEFAULT_TIMEOUT_SEC) as c:
                r = c.get(url)
            elapsed = int((time.time() - t0) * 1000)
            body_preview = r.text[:500] if r.text else None
            base_details = {
                "url": url,
                "status_code": r.status_code,
                "body": body_preview,
            }
            if r.status_code == 200:
                return LakeCheckResult(
                    status=StatusEnum.healthy,
                    message=f"OK ({elapsed}ms)",
                    response_time_ms=elapsed,
                    details=base_details,
                )
            if r.status_code < 500:
                # 4xx — 인증/권한/잘못된 endpoint. server 는 살아있음.
                return LakeCheckResult(
                    status=StatusEnum.warning,
                    message=f"HTTP {r.status_code}",
                    response_time_ms=elapsed,
                    details=base_details,
                )
            return LakeCheckResult(
                status=StatusEnum.critical,
                message=f"HTTP {r.status_code}",
                response_time_ms=elapsed,
                details=base_details,
            )
        except Exception as e:  # noqa: BLE001
            elapsed = int((time.time() - t0) * 1000)
            msg = str(e).lower()
            if any(h in msg for h in _CONNECTION_ERROR_HINTS):
                return LakeCheckResult(
                    status=StatusEnum.pending,
                    message=f"연결 실패: {str(e)[:200]}",
                    response_time_ms=elapsed,
                    details={"url": url, "error": str(e)[:500]},
                )
            return LakeCheckResult(
                status=StatusEnum.critical,
                message=f"체크 실패: {str(e)[:200]}",
                response_time_ms=elapsed,
                details={"url": url, "error": str(e)[:500]},
            )

    def safe_run(self) -> LakeCheckResult:
        """check() 가 raise 해도 LakeCheckResult 로 변환 — 호출부 깨뜨리지 않음."""
        try:
            return self.check()
        except Exception as e:  # noqa: BLE001
            return LakeCheckResult(
                status=StatusEnum.critical,
                message=f"checker 내부 오류: {str(e)[:200]}",
                details={"exception": str(e)[:500]},
            )
