"""Grafana Image Renderer 연동 — PromQL 카드 패널 스냅샷 PNG 생성.

grafana-renderer 가 배포되지 않았거나 Grafana 가 오프라인이면 None 을 반환한다.
(Prometheus/Ollama 와 동일한 fail-safe 패턴)
"""
from __future__ import annotations

import logging

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class GrafanaService:
    def __init__(self) -> None:
        self._grafana_url = settings.grafana_url.rstrip("/")
        self._renderer_url = settings.grafana_renderer_url.rstrip("/")
        self._timeout = 15

    async def render_panel(
        self,
        panel_url: str,
        width: int = 800,
        height: int = 400,
    ) -> bytes | None:
        """Grafana 패널 URL 을 PNG 바이트로 렌더링.

        panel_url 예: /d-solo/abc123/my-dashboard?panelId=2&orgId=1
        renderer 가 없거나 실패 시 None 반환.
        """
        if not self._grafana_url or not self._renderer_url:
            return None
        try:
            render_path = f"{self._grafana_url}/render{panel_url}&width={width}&height={height}&tz=Asia%2FSeoul"
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.get(render_path)
                if resp.status_code == 200 and "image" in resp.headers.get("content-type", ""):
                    return resp.content
                logger.warning("grafana render non-200: %s", resp.status_code)
        except Exception as exc:  # noqa: BLE001
            logger.warning("grafana render failed: %s", exc)
        return None

    async def health_check(self) -> dict:
        if not self._grafana_url:
            return {"status": "offline", "reason": "GRAFANA_URL not set"}
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self._grafana_url}/api/health")
                if resp.status_code == 200:
                    return {"status": "online"}
                return {"status": "error", "code": resp.status_code}
        except Exception as exc:  # noqa: BLE001
            return {"status": "offline", "reason": str(exc)}

    async def renderer_health_check(self) -> dict:
        if not self._renderer_url:
            return {"status": "offline", "reason": "GRAFANA_RENDERER_URL not set"}
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self._renderer_url}/")
                return {"status": "online" if resp.status_code < 400 else "error", "code": resp.status_code}
        except Exception as exc:  # noqa: BLE001
            return {"status": "offline", "reason": str(exc)}


grafana_service = GrafanaService()
