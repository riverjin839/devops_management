"""커스텀 PromQL 점검 — admin 이 UI 에서 PromQL 쿼리로 만드는 범용 점검.

``params.query`` 의 instant 쿼리를 Prometheus 에 던져 벡터 결과를
``aggregate``(max/min/sum/avg/count) 로 하나의 수치로 접고 임계값과 비교한다.
Prometheus 도달 불가는 pending (metric_cards 의 fail-safe 컨벤션과 동일).
"""
from __future__ import annotations

from typing import Any

import httpx

from app.config import settings
from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)


class CustomPromqlChecker(DeepCheckerBase):
    check_type = "custom_promql"
    display_name = "커스텀 PromQL 점검"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_value = float(ctx.thresholds.get("warning_value", 1))
        critical_value = float(ctx.thresholds.get("critical_value", 5))
        compare = str(ctx.thresholds.get("compare", "gte")).lower()

        query = str(ctx.params.get("query", "") or "").strip()
        aggregate = str(ctx.params.get("aggregate", "max")).lower()
        base_url = (str(ctx.params.get("prometheus_url", "") or "").strip()
                    or settings.prometheus_url).rstrip("/")
        timeout = int(ctx.params.get("timeout_seconds", 10))

        if not query:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="params.query 에 PromQL 쿼리를 등록하세요.",
                details={},
            )

        with self._step("query", "PromQL instant 쿼리") as st:
            try:
                with httpx.Client(timeout=timeout) as cli:
                    resp = cli.get(f"{base_url}/api/v1/query", params={"query": query})
                    resp.raise_for_status()
                    body = resp.json()
            except Exception as e:  # noqa: BLE001
                st.detail = str(e)[:150]
                st.status = "failed"
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message=f"Prometheus 도달 실패: {str(e)[:200]}",
                    details={"prometheus_url": base_url, "query": query, "error": str(e)[:500]},
                    steps=self._collected_steps(),
                )
            if body.get("status") != "success":
                st.detail = str(body.get("error", ""))[:150]
                raise ValueError(f"Prometheus 오류: {body.get('error', 'unknown')}")
            st.detail = "success"

        with self._step("parse", "결과 집계") as st:
            samples = self._extract_samples(body.get("data") or {})
            value = self._aggregate(samples, aggregate)
            st.detail = f"{len(samples)}개 시리즈 → {aggregate}={value}"
            st.metrics = {"series": len(samples), "value": value}
        if value is None:
            return DeepCheckOutcome(
                status=StatusEnum.warning,
                message="쿼리 결과가 비어 있습니다 (0개 시리즈).",
                details={"prometheus_url": base_url, "query": query, "series": 0},
            )

        with self._step("verdict", "임계 비교") as st:
            if compare == "lte":
                is_critical = value <= critical_value
                is_warning = value <= warning_value
                op = "≤"
            else:
                is_critical = value >= critical_value
                is_warning = value >= warning_value
                op = "≥"
            status = (
                StatusEnum.critical if is_critical
                else StatusEnum.warning if is_warning
                else StatusEnum.healthy
            )
            st.detail = f"value={value} ({op} warn {warning_value} / crit {critical_value}) → {status.value}"

        return DeepCheckOutcome(
            status=status,
            message=f"PromQL {aggregate}={round(value, 4)} (경고 {op}{warning_value}, 심각 {op}{critical_value})",
            details={
                "prometheus_url": base_url,
                "query": query,
                "aggregate": aggregate,
                "value": value,
                "series": len(samples),
                "samples": samples[:20],
                "compare": compare,
            },
        )

    @staticmethod
    def _extract_samples(data: dict[str, Any]) -> list[dict[str, Any]]:
        result_type = data.get("resultType")
        out: list[dict[str, Any]] = []
        if result_type == "scalar":
            raw = data.get("result") or []
            if len(raw) == 2:
                try:
                    out.append({"labels": {}, "value": float(raw[1])})
                except (TypeError, ValueError):
                    pass
            return out
        for item in data.get("result") or []:
            raw = item.get("value") or []
            if len(raw) != 2:
                continue
            try:
                out.append({"labels": item.get("metric") or {}, "value": float(raw[1])})
            except (TypeError, ValueError):
                continue
        return out

    @staticmethod
    def _aggregate(samples: list[dict[str, Any]], mode: str) -> float | None:
        if mode == "count":
            return float(len(samples))
        values = [s["value"] for s in samples]
        if not values:
            return None
        if mode == "min":
            return min(values)
        if mode == "sum":
            return sum(values)
        if mode == "avg":
            return sum(values) / len(values)
        return max(values)
