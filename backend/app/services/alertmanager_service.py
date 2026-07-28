"""Alertmanager Service — fail-safe 조회 프록시.

`PrometheusService` 와 동일한 계약을 따른다: **절대 예외를 밖으로 던지지 않고**
`{"status": "ok"|"error"|"offline", "data": ..., "error": ...}` 를 돌려준다.
Alertmanager 가 없거나 못 닿는 배포에서도 /observability 화면이 그대로 뜬다.

Alertmanager 는 v2 (OpenAPI) 를 쓰며 Prometheus 와 달리 `status: success` 봉투가 없고
JSON 본문을 그대로 준다.
"""
import logging
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class AlertmanagerService:
    """Resilient proxy to an Alertmanager instance."""

    def __init__(self, base_url: Optional[str] = None, timeout: int = 10):
        self.base_url = (base_url or settings.alertmanager_url).rstrip("/")
        self.timeout = timeout
        self._client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def _get(self, path: str, params: Optional[dict] = None) -> dict:
        try:
            client = self._get_client()
            resp = await client.get(f"{self.base_url}{path}", params=params or {})
            resp.raise_for_status()
            return {"status": "ok", "data": resp.json(), "error": None}

        except httpx.ConnectError:
            logger.warning("Alertmanager connect error — unreachable at %s", self.base_url)
            return self._offline("Alertmanager is not reachable.")
        except httpx.TimeoutException:
            logger.warning("Alertmanager %s timed out after %ss", path, self.timeout)
            return self._offline("Alertmanager request timed out.")
        except httpx.HTTPStatusError as exc:
            return {"status": "error", "data": None, "error": f"HTTP {exc.response.status_code}"}
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected Alertmanager %s error: %s", path, exc)
            return self._offline(str(exc))

    async def status(self) -> dict:
        """`/api/v2/status` — 버전, 클러스터 peer, 현재 설정."""
        return await self._get("/api/v2/status")

    async def alerts(self, *, active: bool = True, silenced: bool = False,
                     inhibited: bool = False) -> dict:
        """`/api/v2/alerts` — Alertmanager 가 보유 중인 알람."""
        return await self._get("/api/v2/alerts", {
            "active": str(active).lower(),
            "silenced": str(silenced).lower(),
            "inhibited": str(inhibited).lower(),
        })

    async def silences(self) -> dict:
        """`/api/v2/silences` — 등록된 silence."""
        return await self._get("/api/v2/silences")

    async def receivers(self) -> dict:
        """`/api/v2/receivers` — 설정된 receiver 목록(cube / PEP 수신 확인용)."""
        return await self._get("/api/v2/receivers")

    async def health_check(self) -> dict:
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.base_url}/-/healthy")
                if resp.status_code == 200:
                    return {"status": "online"}
                return {"status": "offline", "detail": f"HTTP {resp.status_code}"}
        except Exception as exc:  # noqa: BLE001
            return {"status": "offline", "detail": str(exc)}

    @staticmethod
    def _offline(message: str) -> dict:
        return {"status": "offline", "data": None, "error": message}


# 전역 싱글턴 — settings.alertmanager_url 에 바인딩. 클러스터별 오버라이드는
# AlertmanagerService(base_url=...) 로 새 인스턴스를 만든다(cluster_trends 패턴과 동일).
alertmanager_service = AlertmanagerService()
