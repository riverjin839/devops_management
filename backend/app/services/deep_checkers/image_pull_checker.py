"""ImagePullBackOff / ErrImagePull 그리고 crash-loop 마지막 로그 점검."""
from __future__ import annotations

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)
from app.services.k8s_paging import iter_all


class ImagePullChecker(DeepCheckerBase):
    check_type = "image_pull"
    display_name = "Image Pull / Crash Loop"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_pull = int(ctx.thresholds.get("warning_pull_failures", 1))
        critical_pull = int(ctx.thresholds.get("critical_pull_failures", 5))
        warning_crash = int(ctx.thresholds.get("warning_crash_loops", 1))
        critical_crash = int(ctx.thresholds.get("critical_crash_loops", 5))
        log_tail = int(ctx.params.get("log_tail_lines", 20))

        v1 = self._v1(ctx)

        pull_failures: list[dict[str, str]] = []
        crash_loops: list[dict[str, object]] = []

        # 페이지 스트리밍 — 5k+ pod 대형 클러스터에서 전량을 한 번에 메모리에
        # 올리지 않는다(단일 list_pod_for_all_namespaces 호출은 수백 MB 응답을
        # 워커가 통째로 버퍼링·역직렬화해 OOMKill 위험).
        for pod in iter_all(v1.list_pod_for_all_namespaces):
            statuses = (pod.status.container_statuses or []) if pod.status else []
            for cs in statuses:
                waiting = (cs.state.waiting if cs.state else None)
                if waiting:
                    reason = (waiting.reason or "")
                    if reason in ("ImagePullBackOff", "ErrImagePull", "InvalidImageName"):
                        pull_failures.append({
                            "namespace": pod.metadata.namespace,
                            "pod": pod.metadata.name,
                            "container": cs.name,
                            "image": cs.image,
                            "reason": reason,
                            "message": (waiting.message or "")[:300],
                        })
                    elif reason == "CrashLoopBackOff":
                        item: dict[str, object] = {
                            "namespace": pod.metadata.namespace,
                            "pod": pod.metadata.name,
                            "container": cs.name,
                            "restarts": cs.restart_count or 0,
                            "last_log": "",
                        }
                        try:
                            log = v1.read_namespaced_pod_log(
                                name=pod.metadata.name,
                                namespace=pod.metadata.namespace,
                                container=cs.name,
                                previous=True,
                                tail_lines=log_tail,
                                _request_timeout=8,
                            )
                            item["last_log"] = (log or "")[-2000:]
                        except Exception:
                            pass
                        crash_loops.append(item)

        pull_n = len(pull_failures)
        crash_n = len(crash_loops)

        status = StatusEnum.healthy
        if pull_n >= critical_pull or crash_n >= critical_crash:
            status = StatusEnum.critical
        elif pull_n >= warning_pull or crash_n >= warning_crash:
            status = StatusEnum.warning

        return DeepCheckOutcome(
            status=status,
            message=f"Image pull 실패 {pull_n}건, CrashLoopBackOff {crash_n}건",
            details={
                "pull_failures": pull_failures[:50],
                "crash_loops": crash_loops[:30],
            },
        )
