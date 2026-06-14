"""Deep checker 베이스 — 인증서/etcd/CNI/PVC/이미지/audit 공용 추상.

기존 ``app.services.checkers.base.BaseChecker`` 는 Addon + Cluster 를 묶어 동작하지만,
deep check 는 Addon 과 무관하고 ``DeepCheckDefinition`` 의 thresholds/params 를 받아서
실행되므로 별도 베이스를 둔다. 같은 fail-safe 컨벤션은 그대로 적용한다.
"""
from __future__ import annotations

import logging
import os
import subprocess
import time
from abc import ABC, abstractmethod
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from typing import Any, Iterator, Optional

from kubernetes import client, config

from app.models import Cluster, StatusEnum
from app.services.kubeconfig import ensure_kubeconfig_file

logger = logging.getLogger(__name__)


_CONNECTION_ERROR_HINTS = (
    "connection refused",
    "no route to host",
    "timed out",
    "timeout",
    "network is unreachable",
    "max retries exceeded",
    "connection error",
    "ssl:",
)


@dataclass
class DeepCheckContext:
    """체커가 실행될 때 받는 컨텍스트.

    Super Pod runner 가 채워서 넘긴다. Cluster row 가 없는 in-cluster 모드에서도
    동작해야 하므로 cluster 는 Optional.
    """

    cluster: Optional[Cluster] = None
    thresholds: dict[str, Any] = field(default_factory=dict)
    params: dict[str, Any] = field(default_factory=dict)
    # in_cluster=True 면 load_incluster_config() 사용, False 면 kubeconfig 사용.
    in_cluster: bool = False


@dataclass
class ExecutionStep:
    """단일 실행 단계 — 로그 + 2D 애니메이션용."""
    id: str
    label: str
    status: str = "running"  # running | success | failed | skipped
    detail: str = ""
    metrics: dict[str, Any] = field(default_factory=dict)
    started_ms: int = 0      # 체크 시작 기준 상대 시각
    duration_ms: int = 0


@dataclass
class DeepCheckOutcome:
    status: StatusEnum
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    duration_ms: int = 0
    steps: list[dict[str, Any]] = field(default_factory=list)  # 실시간 실행 단계(직렬화 dict)


class DeepCheckerBase(ABC):
    """Deep check 추상 베이스.

    구현체는 ``check_type`` 클래스 속성을 ``registry`` key 와 맞추고,
    ``run(ctx) -> DeepCheckOutcome`` 를 구현한다.
    """

    check_type: str = "abstract"
    display_name: str = "abstract"

    # ── K8s client (lazy) ──────────────────────────────────────
    def _v1(self, ctx: DeepCheckContext) -> client.CoreV1Api:
        if ctx.in_cluster:
            try:
                config.load_incluster_config()
            except config.ConfigException:
                config.load_kube_config()
        else:
            kc = ensure_kubeconfig_file(ctx.cluster) if ctx.cluster else None
            if kc and os.path.exists(kc):
                config.load_kube_config(config_file=kc)
            else:
                try:
                    config.load_incluster_config()
                except config.ConfigException:
                    config.load_kube_config()
        return client.CoreV1Api()

    def _kubectl(self, ctx: DeepCheckContext, *args: str, timeout: int = 30) -> subprocess.CompletedProcess:
        cmd = ["kubectl"]
        if not ctx.in_cluster and ctx.cluster is not None:
            kc = ensure_kubeconfig_file(ctx.cluster)
            if kc and os.path.exists(kc):
                cmd.extend(["--kubeconfig", kc])
            if ctx.cluster.api_endpoint:
                cmd.extend(["--server", ctx.cluster.api_endpoint])
        cmd.extend(args)
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

    # ── 단계 트레이스 (로그 + 애니메이션) ──────────────────────────
    @contextmanager
    def _step(self, step_id: str, label: str) -> Iterator["ExecutionStep"]:
        """체커가 핵심 동작을 감싸는 컨텍스트매니저. 진입 시 running 기록,
        정상 종료 success, 예외 시 failed 로 표시 후 re-raise. detail/metrics 는 안에서 채운다.
        """
        if not hasattr(self, "_steps"):
            self._steps = []
            self._run_start = time.time()
        rec = ExecutionStep(id=step_id, label=label, status="running",
                            started_ms=int((time.time() - self._run_start) * 1000))
        self._steps.append(rec)
        t0 = time.time()
        try:
            yield rec
            if rec.status == "running":
                rec.status = "success"
        except Exception as e:  # noqa: BLE001
            rec.status = "failed"
            if not rec.detail:
                rec.detail = str(e)[:200]
            raise
        finally:
            rec.duration_ms = int((time.time() - t0) * 1000)

    def _collected_steps(self) -> list[dict[str, Any]]:
        return [asdict(s) for s in getattr(self, "_steps", [])]

    # ── 실행 ────────────────────────────────────────────────────
    @abstractmethod
    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        ...

    def safe_run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        start = time.time()
        self._steps = []
        self._run_start = start
        try:
            outcome = self.run(ctx)
            outcome.duration_ms = int((time.time() - start) * 1000)
            if not outcome.steps:
                outcome.steps = self._collected_steps()
            return outcome
        except FileNotFoundError as e:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message=f"{self.display_name}: 필수 파일 없음 — {str(e)[:120]}",
                details={"error": str(e)[:500]},
                duration_ms=int((time.time() - start) * 1000),
                steps=self._collected_steps(),
            )
        except Exception as e:
            msg = str(e).lower()
            status = (
                StatusEnum.pending
                if any(h in msg for h in _CONNECTION_ERROR_HINTS)
                else StatusEnum.critical
            )
            logger.warning("Deep check %s failed: %s", self.check_type, e)
            return DeepCheckOutcome(
                status=status,
                message=f"{self.display_name} 실패: {str(e)[:200]}",
                details={"error": str(e)[:1000]},
                duration_ms=int((time.time() - start) * 1000),
                steps=self._collected_steps(),
            )
