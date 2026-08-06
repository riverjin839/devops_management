"""
Review Service — daily check 직후 Ollama 가 결과를 요약하고,
어제 / 최근 7일 대비 diff·trend 를 계산해 DailyCheckLog 에 기록한다.

Fail-safe: Ollama 가 offline 이거나 오류여도 status="offline" 으로 저장만 하고
예외를 전파하지 않는다.
"""
from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.models import (
    Cluster,
    DailyCheckLog,
    StatusEnum,
)
from app.services.agent_service import agent_service

logger = logging.getLogger(__name__)


REVIEW_PROMPT = (
    "You are reviewing the results of a Kubernetes daily health check. "
    "Summarise the cluster's current state in 2–4 sentences (Korean) focusing on what changed "
    "since yesterday and what concretely needs operator attention. "
    "Then provide a short bulleted '조치 권고' list (1–4 items) of remediation steps "
    "the operator should run. Be specific (kubectl/helm/etc. commands when relevant). "
    "Format your reply as JSON exactly: "
    '{"summary": "...", "remediation": "- step\\n- step"}'
)


class ReviewService:
    """오케스트레이션: diff / trend 계산 → Ollama 호출 → DailyCheckLog 업데이트."""

    def __init__(self, db: Session):
        self.db = db

    # ──────────────────────────────────────────────────────────────
    # Public
    # ──────────────────────────────────────────────────────────────

    async def review_and_persist(self, daily_check_log_id: str | UUID) -> dict[str, Any]:
        """주어진 daily_check_log 에 대해 AI 리뷰를 생성하고 저장한다.

        반환값은 UI 가 즉시 보여줄 수 있는 dict.
        """
        log = self.db.query(DailyCheckLog).filter(
            DailyCheckLog.id == daily_check_log_id
        ).first()
        if log is None:
            raise ValueError(f"DailyCheckLog not found: {daily_check_log_id}")

        cluster = self.db.query(Cluster).filter(Cluster.id == log.cluster_id).first()

        diff = self._compute_diff(cluster, log)
        trend = self._compute_trend(cluster, days=7)

        context = self._build_context(cluster, log, diff, trend)

        ai_resp = await agent_service.ask_agent(REVIEW_PROMPT, context=context, purpose="review_summary")
        summary, remediation = self._parse_response(ai_resp)

        log.ai_summary = summary
        log.ai_remediation = remediation
        log.ai_diff = diff
        log.ai_trend = trend
        log.ai_status = ai_resp.get("status", "offline")
        log.ai_generated_at = datetime.utcnow()

        try:
            self.db.commit()
            self.db.refresh(log)
        except Exception:
            self.db.rollback()
            logger.exception("Failed to persist AI review")
            raise

        return {
            "daily_check_log_id": str(log.id),
            "ai_summary": log.ai_summary,
            "ai_remediation": log.ai_remediation,
            "ai_diff": log.ai_diff,
            "ai_trend": log.ai_trend,
            "ai_status": log.ai_status,
            "ai_generated_at": log.ai_generated_at.isoformat() if log.ai_generated_at else None,
        }

    # ──────────────────────────────────────────────────────────────
    # Diff
    # ──────────────────────────────────────────────────────────────

    def _compute_diff(
        self, cluster: Cluster | None, log: DailyCheckLog
    ) -> dict[str, Any]:
        """어제 마지막 check 와의 차이를 계산."""
        if cluster is None:
            return {"available": False}

        prev = (
            self.db.query(DailyCheckLog)
            .filter(DailyCheckLog.cluster_id == cluster.id)
            .filter(DailyCheckLog.id != log.id)
            .order_by(desc(DailyCheckLog.checked_at))
            .first()
        )
        if prev is None:
            return {"available": False}

        cur_errs = set(_msg_list(log.error_messages))
        prev_errs = set(_msg_list(prev.error_messages))
        cur_warns = set(_msg_list(log.warning_messages))
        prev_warns = set(_msg_list(prev.warning_messages))

        return {
            "available": True,
            "previous_log_id": str(prev.id),
            "previous_checked_at": prev.checked_at.isoformat() if prev.checked_at else None,
            "errors_added": sorted(cur_errs - prev_errs),
            "errors_removed": sorted(prev_errs - cur_errs),
            "warnings_added": sorted(cur_warns - prev_warns),
            "warnings_removed": sorted(prev_warns - cur_warns),
            "status_changed": (log.overall_status != prev.overall_status),
            "previous_status": prev.overall_status.value if prev.overall_status else None,
            "current_status": log.overall_status.value if log.overall_status else None,
            "ready_nodes_delta": (log.ready_nodes or 0) - (prev.ready_nodes or 0),
        }

    # ──────────────────────────────────────────────────────────────
    # Trend
    # ──────────────────────────────────────────────────────────────

    def _compute_trend(self, cluster: Cluster | None, days: int = 7) -> dict[str, Any]:
        """최근 N일간 상태 분포 + 일자별 시계열."""
        if cluster is None:
            return {"days": days, "available": False, "points": []}

        cutoff = datetime.utcnow() - timedelta(days=days)
        rows = (
            self.db.query(DailyCheckLog)
            .filter(DailyCheckLog.cluster_id == cluster.id)
            .filter(DailyCheckLog.checked_at >= cutoff)
            .order_by(DailyCheckLog.checked_at.asc())
            .all()
        )

        counts: Counter[str] = Counter()
        points: list[dict[str, Any]] = []
        for r in rows:
            status = r.overall_status.value if r.overall_status else "unknown"
            counts[status] += 1
            points.append({
                "checked_at": r.checked_at.isoformat() if r.checked_at else None,
                "status": status,
                "errors": len(_msg_list(r.error_messages)),
                "warnings": len(_msg_list(r.warning_messages)),
                "ready_nodes": r.ready_nodes or 0,
                "total_nodes": r.total_nodes or 0,
            })

        return {
            "days": days,
            "available": True,
            "totals": dict(counts),
            "points": points,
        }

    # ──────────────────────────────────────────────────────────────
    # Ollama context
    # ──────────────────────────────────────────────────────────────

    def _build_context(
        self,
        cluster: Cluster | None,
        log: DailyCheckLog,
        diff: dict[str, Any],
        trend: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "cluster_name": cluster.name if cluster else "unknown",
            "cluster_status": log.overall_status.value if log.overall_status else "unknown",
            "error_messages": _msg_list(log.error_messages),
            "node_status": (
                f"{log.ready_nodes or 0}/{log.total_nodes or 0} ready"
            ),
            "extra": json.dumps(
                {
                    "components_status": log.components_status,
                    "api_server": {
                        "status": (
                            log.api_server_status.value if log.api_server_status else None
                        ),
                        "response_time_ms": log.api_server_response_time_ms,
                    },
                    "warning_messages": _msg_list(log.warning_messages),
                    "diff": diff,
                    "trend_totals": trend.get("totals"),
                },
                default=str,
                ensure_ascii=False,
            )[:6000],
        }

    @staticmethod
    def _parse_response(ai_resp: dict[str, Any]) -> tuple[str | None, str | None]:
        """Ollama 응답을 (summary, remediation) 로 파싱.

        모델이 JSON 을 제대로 못 만들면 raw answer 를 summary 에 그대로 넣는다.
        """
        if ai_resp.get("status") != "ok":
            return ai_resp.get("answer"), None

        answer = (ai_resp.get("answer") or "").strip()
        if not answer:
            return None, None

        # 시도 1: 응답 전체를 JSON 으로 파싱
        try:
            parsed = json.loads(answer)
            if isinstance(parsed, dict):
                return parsed.get("summary"), parsed.get("remediation")
        except Exception:
            pass

        # 시도 2: 처음 { ... } 블록 추출
        start = answer.find("{")
        end = answer.rfind("}")
        if 0 <= start < end:
            try:
                parsed = json.loads(answer[start:end + 1])
                if isinstance(parsed, dict):
                    return parsed.get("summary"), parsed.get("remediation")
            except Exception:
                pass

        # fallback: summary 만 raw 로 저장
        return answer[:4000], None


def _msg_list(value: Any) -> list[str]:
    """JSONB 에서 읽어온 message 컬럼을 list[str] 로 정규화."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        return [value]
    return [str(value)]
