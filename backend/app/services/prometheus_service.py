"""
Prometheus Service — Fail-safe PromQL query executor.

Similar to AIAgentService, never raises exceptions to the caller.
Dashboard remains functional even if Prometheus is unreachable.
"""

import logging
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class PrometheusService:
    """Resilient proxy to a Prometheus server inside the cluster."""

    def __init__(self, base_url: Optional[str] = None, timeout: int = 10):
        self.base_url = (base_url or settings.prometheus_url).rstrip("/")
        self.timeout = timeout
        # 요청마다 새 httpx.AsyncClient 를 만들면 매번 TCP/TLS 핸드셰이크가 반복된다
        # (/promql/query/all 은 카드마다 이 메서드를 호출) — 커넥션을 재사용하는 공유
        # 클라이언트를 지연 생성해 재사용한다. asyncio 단일 스레드 특성상 별도 락 없이도
        # 동시 코루틴이 최초 1~2회 중복 생성하는 정도의 미미한 레이스만 존재.
        self._client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def query(self, promql: str) -> dict:
        """
        Execute an instant PromQL query.

        Returns
        -------
        dict with keys:
            status   : "ok" | "error" | "offline"
            value    : float | None          (scalar / single-vector result)
            labels   : dict | None           (label set for single result)
            results  : list[dict] | None     (multiple vector results)
            error    : str | None
        """
        try:
            client = self._get_client()
            resp = await client.get(
                f"{self.base_url}/api/v1/query",
                params={"query": promql},
            )
            resp.raise_for_status()
            body = resp.json()

            if body.get("status") != "success":
                return {
                    "status": "error",
                    "value": None,
                    "labels": None,
                    "results": None,
                    "error": body.get("error", "Unknown Prometheus error"),
                }

            return self._parse_result(body["data"])

        except httpx.ConnectError:
            logger.warning("Prometheus connect error — service unreachable at %s", self.base_url)
            return self._offline("Prometheus is not reachable.")

        except httpx.TimeoutException:
            logger.warning("Prometheus query timed out after %ss", self.timeout)
            return self._offline("Prometheus query timed out.")

        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            logger.warning("Prometheus returned HTTP %s", code)
            return {
                "status": "error",
                "value": None,
                "labels": None,
                "results": None,
                "error": f"HTTP {code}",
            }

        except Exception as exc:
            logger.exception("Unexpected Prometheus error: %s", exc)
            return self._offline(str(exc))

    async def query_range(
        self, promql: str, start: float, end: float, step: str
    ) -> dict:
        """
        Execute a PromQL **range** query (`/api/v1/query_range`).

        Parameters
        ----------
        start, end : float   — UNIX epoch seconds.
        step       : str     — resolution step (e.g. "30s", "5m").

        Returns
        -------
        dict with keys:
            status : "ok" | "error" | "offline"
            series : list[dict] | None   — [{"labels": {...}, "values": [[ts, "val"], ...]}]
            error  : str | None
        """
        try:
            client = self._get_client()
            resp = await client.get(
                f"{self.base_url}/api/v1/query_range",
                params={
                    "query": promql,
                    "start": start,
                    "end": end,
                    "step": step,
                },
            )
            resp.raise_for_status()
            body = resp.json()

            if body.get("status") != "success":
                return {
                    "status": "error",
                    "series": None,
                    "error": body.get("error", "Unknown Prometheus error"),
                }

            data = body.get("data", {})
            series = [
                {"labels": item.get("metric", {}), "values": item.get("values", [])}
                for item in data.get("result", [])
            ]
            return {"status": "ok", "series": series, "error": None}

        except httpx.ConnectError:
            logger.warning("Prometheus connect error — service unreachable at %s", self.base_url)
            return self._offline_range("Prometheus is not reachable.")

        except httpx.TimeoutException:
            logger.warning("Prometheus range query timed out after %ss", self.timeout)
            return self._offline_range("Prometheus query timed out.")

        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            logger.warning("Prometheus returned HTTP %s", code)
            return {"status": "error", "series": None, "error": f"HTTP {code}"}

        except Exception as exc:
            logger.exception("Unexpected Prometheus range error: %s", exc)
            return self._offline_range(str(exc))

    # ------------------------------------------------------------------
    # Observability 대시보드용 조회 — 모두 같은 fail-safe 계약을 따른다.
    # 성공: {"status": "ok", "data": <payload>, "error": None}
    # 실패: {"status": "error"|"offline", "data": None, "error": "<사유>"}
    # ------------------------------------------------------------------

    async def _get_api(self, path: str, params: Optional[dict] = None) -> dict:
        """Prometheus HTTP API GET 공통 래퍼 — 절대 예외를 던지지 않는다."""
        try:
            client = self._get_client()
            resp = await client.get(f"{self.base_url}{path}", params=params or {})
            resp.raise_for_status()
            body = resp.json()
            if body.get("status") != "success":
                return self._api_error(body.get("error") or "Unknown Prometheus error")
            return {"status": "ok", "data": body.get("data"), "error": None}

        except httpx.ConnectError:
            logger.warning("Prometheus connect error — unreachable at %s", self.base_url)
            return self._api_offline("Prometheus is not reachable.")
        except httpx.TimeoutException:
            logger.warning("Prometheus %s timed out after %ss", path, self.timeout)
            return self._api_offline("Prometheus request timed out.")
        except httpx.HTTPStatusError as exc:
            return self._api_error(f"HTTP {exc.response.status_code}")
        except Exception as exc:  # noqa: BLE001
            logger.exception("Unexpected Prometheus %s error: %s", path, exc)
            return self._api_offline(str(exc))

    async def rules(self, rule_type: Optional[str] = None) -> dict:
        """`/api/v1/rules` — 알람/기록 규칙 그룹. rule_type: "alert" | "record"."""
        params = {"type": rule_type} if rule_type in ("alert", "record") else None
        return await self._get_api("/api/v1/rules", params)

    async def active_alerts(self) -> dict:
        """`/api/v1/alerts` — Prometheus 가 보고 있는 현재 발화/대기 알람."""
        return await self._get_api("/api/v1/alerts")

    async def targets(self, state: Optional[str] = None) -> dict:
        """`/api/v1/targets` — 스크레이프 타겟. state: "active" | "dropped"."""
        params = {"state": state} if state in ("active", "dropped") else None
        return await self._get_api("/api/v1/targets", params)

    async def tsdb_status(self) -> dict:
        """`/api/v1/status/tsdb` — 카디널리티 상위 항목 등."""
        return await self._get_api("/api/v1/status/tsdb")

    async def runtime_info(self) -> dict:
        """`/api/v1/status/runtimeinfo` — 기동 시각, 스토리지 보존, goroutine 수 등."""
        return await self._get_api("/api/v1/status/runtimeinfo")

    async def build_info(self) -> dict:
        """`/api/v1/status/buildinfo` — Prometheus 버전."""
        return await self._get_api("/api/v1/status/buildinfo")

    @staticmethod
    def _api_error(message: str) -> dict:
        return {"status": "error", "data": None, "error": message}

    @staticmethod
    def _api_offline(message: str) -> dict:
        return {"status": "offline", "data": None, "error": message}

    async def health_check(self) -> dict:
        """Quick probe — returns online/offline status."""
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{self.base_url}/-/healthy")
                if resp.status_code == 200:
                    return {"status": "online"}
                return {"status": "offline", "detail": f"HTTP {resp.status_code}"}
        except Exception as exc:
            return {"status": "offline", "detail": str(exc)}

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _offline(message: str) -> dict:
        return {
            "status": "offline",
            "value": None,
            "labels": None,
            "results": None,
            "error": message,
        }

    @staticmethod
    def _offline_range(message: str) -> dict:
        return {"status": "offline", "series": None, "error": message}

    @staticmethod
    def _parse_result(data: dict) -> dict:
        """Parse Prometheus /api/v1/query response data."""
        result_type = data.get("resultType", "")
        results_raw = data.get("result", [])

        if not results_raw:
            return {
                "status": "ok",
                "value": None,
                "labels": None,
                "results": [],
                "error": None,
            }

        # Scalar result
        if result_type == "scalar":
            _, val = results_raw
            return {
                "status": "ok",
                "value": _safe_float(val),
                "labels": None,
                "results": None,
                "error": None,
            }

        # Vector result
        if result_type == "vector":
            parsed = []
            for item in results_raw:
                metric = item.get("metric", {})
                _, val = item.get("value", [0, "0"])
                parsed.append({"labels": metric, "value": _safe_float(val)})

            # Single-value shortcut
            if len(parsed) == 1:
                return {
                    "status": "ok",
                    "value": parsed[0]["value"],
                    "labels": parsed[0]["labels"],
                    "results": parsed,
                    "error": None,
                }

            return {
                "status": "ok",
                "value": None,
                "labels": None,
                "results": parsed,
                "error": None,
            }

        # Fallback for matrix or other types
        return {
            "status": "ok",
            "value": None,
            "labels": None,
            "results": [{"raw": results_raw}],
            "error": None,
        }


def _safe_float(val) -> Optional[float]:
    try:
        f = float(val)
        if f != f:  # NaN check
            return None
        return round(f, 4)
    except (ValueError, TypeError):
        return None


# Module-level singleton
prometheus_service = PrometheusService()
