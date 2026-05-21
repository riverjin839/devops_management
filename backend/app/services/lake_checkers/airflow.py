"""AirflowChecker — deep check (components 상태까지 파싱).

Airflow `/health` 응답 형식:
    {
      "metadatabase": {"status": "healthy"},
      "scheduler": {"status": "healthy", "latest_scheduler_heartbeat": "..."},
      "triggerer": {"status": "healthy", ...},
      "dag_processor": {"status": "healthy"} (optional)
    }
컴포넌트 중 1개라도 unhealthy 면 warning.
"""
from __future__ import annotations

import json

from app.models import StatusEnum
from app.services.lake_checkers.base import LakeBaseChecker, LakeCheckResult


class AirflowChecker(LakeBaseChecker):
    def healthz_path(self) -> str:
        return "/health"

    def check(self) -> LakeCheckResult:
        result = super().check()
        # 연결 실패 / 5xx — 기본 결과 그대로 반환
        if result.status not in (StatusEnum.healthy, StatusEnum.warning):
            return result
        body = (result.details or {}).get("body") or ""
        if not body:
            return result
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return result

        components: dict[str, str] = {}
        for k, v in data.items():
            if isinstance(v, dict) and "status" in v:
                components[k] = v["status"]
        unhealthy = [k for k, v in components.items() if v != "healthy"]

        enriched = {**(result.details or {}), "components": components}
        if not components:
            return result
        if unhealthy:
            return LakeCheckResult(
                status=StatusEnum.warning,
                message=f"unhealthy components: {', '.join(unhealthy)}",
                response_time_ms=result.response_time_ms,
                details=enriched,
            )
        return LakeCheckResult(
            status=StatusEnum.healthy,
            message=f"all components healthy ({len(components)})",
            response_time_ms=result.response_time_ms,
            details=enriched,
        )
