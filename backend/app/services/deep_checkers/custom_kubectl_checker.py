"""커스텀 kubectl 점검 — admin 이 UI 에서 kubectl 명령으로 만드는 범용 점검.

``params.args`` 에 kubectl 하위 인자(예: ``get pods -A --field-selector=status.phase=Failed
-o name``)를 등록하면 대상 클러스터의 kubeconfig 로 실행하고, 출력에서 수치를 뽑아
임계값과 비교한다. shell 을 거치지 않고(shlex) kubectl 만 실행하며, 기본은 읽기 전용
verb 화이트리스트로 제한된다.

parse_mode:
* ``lines``       — stdout 의 비어있지 않은 라인 수 (예: ``-o name`` 결과 카운트)
* ``number``      — stdout 에서 첫 번째 숫자 추출
* ``regex_count`` — ``pattern`` 정규식 매치 수

compare: ``gte`` (값이 임계 이상이면 이상), ``lte`` (값이 임계 이하이면 이상 — 최소 개수 보장형).
"""
from __future__ import annotations

import re
import shlex
from typing import Any

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)

# 읽기 전용으로 허용하는 kubectl 첫 번째 verb — allow_mutation=True 로만 우회 가능.
_READONLY_VERBS = {
    "get", "describe", "top", "logs", "api-resources", "api-versions",
    "version", "explain", "auth", "cluster-info", "diff", "events",
}


class CustomKubectlChecker(DeepCheckerBase):
    check_type = "custom_kubectl"
    display_name = "커스텀 kubectl 점검"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_value = float(ctx.thresholds.get("warning_value", 1))
        critical_value = float(ctx.thresholds.get("critical_value", 5))
        compare = str(ctx.thresholds.get("compare", "gte")).lower()

        raw_args = str(ctx.params.get("args", "") or "").strip()
        parse_mode = str(ctx.params.get("parse_mode", "lines")).lower()
        pattern = str(ctx.params.get("pattern", "") or "")
        timeout = int(ctx.params.get("timeout_seconds", 30))
        allow_mutation = bool(ctx.params.get("allow_mutation", False))

        with self._step("validate", "명령 검증") as st:
            if not raw_args:
                st.detail = "params.args 미설정"
                st.status = "skipped"
            args = shlex.split(raw_args)
            if args and args[0] == "kubectl":
                args = args[1:]
            if args and not allow_mutation and args[0] not in _READONLY_VERBS:
                raise ValueError(
                    f"읽기 전용이 아닌 kubectl verb '{args[0]}' 는 차단됩니다 "
                    f"(허용: {', '.join(sorted(_READONLY_VERBS))}). "
                    "의도된 변경 명령이면 params.allow_mutation 을 켜세요."
                )
            st.detail = f"kubectl {' '.join(args[:6])}{' …' if len(args) > 6 else ''}"
        if not raw_args:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="params.args 에 kubectl 인자를 등록하세요. 예: get pods -A --field-selector=status.phase=Failed -o name",
                details={},
            )

        with self._step("exec", "kubectl 실행") as st:
            proc = self._kubectl(ctx, *args, timeout=timeout)
            st.detail = f"exit={proc.returncode}"
            st.metrics = {"exit_code": proc.returncode}
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        if proc.returncode != 0:
            return DeepCheckOutcome(
                status=StatusEnum.critical,
                message=f"kubectl 종료 코드 {proc.returncode}: {stderr.strip()[:200]}",
                details={
                    "exit_code": proc.returncode,
                    "args": args,
                    "stdout_tail": stdout[-2000:],
                    "stderr_tail": stderr[-2000:],
                },
            )

        with self._step("parse", "출력 파싱") as st:
            value = self._extract_value(stdout, parse_mode, pattern)
            st.detail = f"{parse_mode} → {value}"
            st.metrics = {"value": value}
        if value is None:
            return DeepCheckOutcome(
                status=StatusEnum.warning,
                message=f"출력에서 값을 추출하지 못했습니다 (parse_mode={parse_mode}).",
                details={"parse_mode": parse_mode, "pattern": pattern or None, "stdout_tail": stdout[-2000:]},
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
            message=f"kubectl {args[0]} — 측정값 {value} (경고 {op}{warning_value}, 심각 {op}{critical_value})",
            details={
                "args": args,
                "parse_mode": parse_mode,
                "pattern": pattern or None,
                "value": value,
                "compare": compare,
                "stdout_tail": stdout[-2000:],
            },
        )

    @staticmethod
    def _extract_value(stdout: str, parse_mode: str, pattern: str) -> float | None:
        if parse_mode == "number":
            m = re.search(r"-?\d+(?:\.\d+)?", stdout)
            return float(m.group(0)) if m else None
        if parse_mode == "regex_count":
            if not pattern:
                return None
            try:
                return float(len(re.findall(pattern, stdout)))
            except re.error:
                return None
        # 기본: lines
        return float(len([ln for ln in stdout.splitlines() if ln.strip()]))
