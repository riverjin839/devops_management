"""
Coroot Service — Fail-safe proxy to a separately-deployed coroot APM server.

Mirrors PrometheusService / AIAgentService: **never raises to the caller**.
All exceptions are caught and returned as structured offline/error dicts, so the
dashboard keeps working even when coroot is not deployed or unreachable.

coroot 은 PEP repo 에 포함되지 않는 외부 서비스다. base URL 은 전역 설정
(settings.coroot_url)로 두고, 클러스터별 project 매핑은 clusters 테이블의
coroot_project 컬럼에 저장한다. 미설정/미배포 환경에서는 status="offline" 을 돌려준다.

coroot 의 read API 경로/응답 스키마는 버전마다 다를 수 있으므로 overview 파싱은
방어적으로 작성한다 (스키마가 달라도 죽지 않고 raw 를 패스스루).
"""

import logging
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class CorootService:
    """Resilient proxy to a coroot server (deployed separately)."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: Optional[int] = None,
    ):
        self.base_url = (base_url if base_url is not None else settings.coroot_url).rstrip("/")
        self.api_key = api_key if api_key is not None else settings.coroot_api_key
        self.timeout = timeout if timeout is not None else settings.coroot_timeout

    @property
    def configured(self) -> bool:
        """coroot base URL 이 설정되어 있는지."""
        return bool(self.base_url)

    def _headers(self) -> dict:
        if self.api_key:
            return {"X-API-Key": self.api_key}
        return {}

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def health_check(self) -> dict:
        """Quick probe — returns online/offline status without raising."""
        if not self.configured:
            return {"status": "offline", "detail": "coroot_url 이 설정되지 않았습니다."}
        try:
            async with httpx.AsyncClient(timeout=5, headers=self._headers()) as client:
                resp = await client.get(f"{self.base_url}/health")
                # coroot 버전에 따라 /health 가 없을 수 있어 2xx/3xx 모두 online 으로 간주.
                if resp.status_code < 400:
                    return {"status": "online"}
                # /health 가 404 면 루트로 한 번 더 시도.
                root = await client.get(self.base_url)
                if root.status_code < 400:
                    return {"status": "online"}
                return {"status": "offline", "detail": f"HTTP {resp.status_code}"}
        except Exception as exc:  # noqa: BLE001 — fail-safe by design
            logger.warning("coroot health probe failed: %s", exc)
            return {"status": "offline", "detail": str(exc)[:200]}

    async def get_overview(self, project: str) -> dict:
        """
        Fetch an application-level overview for the given coroot project.

        Returns a normalized summary dict (always status-tagged, never raises):
            status          : "ok" | "error" | "offline"
            service_count   : int | None
            healthy         : int | None
            alerting        : int | None
            error           : str | None
            raw             : original payload (truncated-safe) | None
        """
        if not self.configured:
            return self._offline("coroot_url 이 설정되지 않았습니다.")
        if not project:
            return self._offline("이 클러스터에 coroot project 가 매핑되지 않았습니다.")
        try:
            async with httpx.AsyncClient(timeout=self.timeout, headers=self._headers()) as client:
                resp = await client.get(
                    f"{self.base_url}/api/project/{project}/overview/applications",
                )
                resp.raise_for_status()
                return self._parse_overview(resp.json())
        except httpx.ConnectError:
            logger.warning("coroot connect error — unreachable at %s", self.base_url)
            return self._offline("coroot 에 접속할 수 없습니다.")
        except httpx.TimeoutException:
            logger.warning("coroot overview timed out after %ss", self.timeout)
            return self._offline("coroot 요청이 시간 초과되었습니다.")
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            logger.warning("coroot returned HTTP %s for project %s", code, project)
            return {
                "status": "error",
                "service_count": None,
                "healthy": None,
                "alerting": None,
                "error": f"HTTP {code}",
                "raw": None,
            }
        except Exception as exc:  # noqa: BLE001 — fail-safe by design
            logger.exception("Unexpected coroot error: %s", exc)
            return self._offline(str(exc)[:200])

    async def get_applications(self, project: str) -> dict:
        """
        Fetch the per-service application list for drill-down.

        Returns (always status-tagged, never raises):
            status         : "ok" | "error" | "offline"
            applications   : list[{id, name, namespace, kind, status}]
            error          : str | None
        """
        if not self.configured:
            return self._apps_offline("coroot_url 이 설정되지 않았습니다.")
        if not project:
            return self._apps_offline("이 클러스터에 coroot project 가 매핑되지 않았습니다.")
        try:
            async with httpx.AsyncClient(timeout=self.timeout, headers=self._headers()) as client:
                resp = await client.get(
                    f"{self.base_url}/api/project/{project}/overview/applications",
                )
                resp.raise_for_status()
                return {"status": "ok", "applications": self._parse_applications(resp.json()), "error": None}
        except httpx.ConnectError:
            logger.warning("coroot connect error — unreachable at %s", self.base_url)
            return self._apps_offline("coroot 에 접속할 수 없습니다.")
        except httpx.TimeoutException:
            logger.warning("coroot applications timed out after %ss", self.timeout)
            return self._apps_offline("coroot 요청이 시간 초과되었습니다.")
        except httpx.HTTPStatusError as exc:
            code = exc.response.status_code
            logger.warning("coroot returned HTTP %s for project %s applications", code, project)
            return {"status": "error", "applications": [], "error": f"HTTP {code}"}
        except Exception as exc:  # noqa: BLE001 — fail-safe by design
            logger.exception("Unexpected coroot applications error: %s", exc)
            return self._apps_offline(str(exc)[:200])

    def deeplink(self, project: str, path: str = "") -> Optional[str]:
        """
        Build a browser deep-link into the coroot UI for a project.

        Returns None when coroot is not configured / project missing — caller
        renders an offline state instead of a broken link.
        """
        if not self.configured or not project:
            return None
        suffix = path if path.startswith("/") or not path else f"/{path}"
        return f"{self.base_url}/p/{project}{suffix}"

    def app_deeplink(self, project: str, app_id: str, view: str = "Tracing") -> Optional[str]:
        """
        Build a deep-link into a specific application's report in the coroot UI.

        view 예: "Tracing"(분산 trace), "Logs", "Profiling", "Instances".
        app_id 는 coroot 의 'namespace:Kind:name' 형식(콜론 포함)을 그대로 둔다.
        """
        if not self.configured or not project or not app_id:
            return None
        return f"{self.base_url}/p/{project}/app/{app_id}/{view}"

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _apps_offline(message: str) -> dict:
        return {"status": "offline", "applications": [], "error": message}

    @staticmethod
    def _parse_applications(data) -> list:
        """
        Defensive parse of coroot overview/applications into a flat service list.

        coroot 버전에 따라 최상위가 list 이거나 {"applications": [...]} 형태,
        항목 id 는 'ns:Kind:name' 문자열이거나 분리 필드일 수 있다. 모든 경우를 보수적으로 처리.
        """
        apps = None
        if isinstance(data, dict):
            for key in ("applications", "apps", "rows", "data"):
                if isinstance(data.get(key), list):
                    apps = data[key]
                    break
        elif isinstance(data, list):
            apps = data
        if not apps:
            return []

        out = []
        for app in apps:
            if not isinstance(app, dict):
                continue
            app_id = str(app.get("id") or app.get("application_id") or "").strip()
            namespace = app.get("namespace")
            kind = app.get("kind")
            name = app.get("name")
            # id 가 'ns:Kind:name' 형식이면 분해해 빈 필드를 보강
            if app_id and ":" in app_id:
                parts = app_id.split(":")
                if len(parts) == 3:
                    namespace = namespace or parts[0]
                    kind = kind or parts[1]
                    name = name or parts[2]
            if not name:
                name = app_id or "(unknown)"
            if not app_id:
                # id 가 없으면 표시용으로 합성 (딥링크엔 부적합할 수 있음)
                app_id = ":".join([str(namespace or ""), str(kind or ""), str(name or "")]).strip(":")
            status = str(app.get("status") or app.get("health") or app.get("severity") or "").lower() or None
            out.append({
                "id": app_id,
                "name": name,
                "namespace": namespace,
                "kind": kind,
                "status": status,
            })
        return out

    @staticmethod
    def _offline(message: str) -> dict:
        return {
            "status": "offline",
            "service_count": None,
            "healthy": None,
            "alerting": None,
            "error": message,
            "raw": None,
        }

    @staticmethod
    def _parse_overview(data) -> dict:
        """
        Defensive parse of coroot's overview payload.

        coroot 버전에 따라 최상위가 list 이거나 {"applications": [...]} 형태일 수 있다.
        application 항목의 status/health 필드명도 다를 수 있어 보수적으로 집계한다.
        파싱 실패해도 status="ok" + raw 패스스루로 죽지 않게 한다.
        """
        apps = None
        if isinstance(data, dict):
            for key in ("applications", "apps", "rows", "data"):
                if isinstance(data.get(key), list):
                    apps = data[key]
                    break
        elif isinstance(data, list):
            apps = data

        if apps is None:
            return {
                "status": "ok",
                "service_count": None,
                "healthy": None,
                "alerting": None,
                "error": None,
                "raw": None,
            }

        alerting = 0
        healthy = 0
        for app in apps:
            if not isinstance(app, dict):
                continue
            status = str(
                app.get("status")
                or app.get("health")
                or app.get("severity")
                or ""
            ).lower()
            if status in ("critical", "warning", "alerting", "error", "unhealthy"):
                alerting += 1
            elif status in ("ok", "healthy", "info", "ok ", "up"):
                healthy += 1

        return {
            "status": "ok",
            "service_count": len(apps),
            "healthy": healthy or None,
            "alerting": alerting,
            "error": None,
            "raw": None,
        }


# Module-level singleton
coroot_service = CorootService()
