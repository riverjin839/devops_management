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


# 실행 로그(JSONB)가 무한정 커지지 않도록 명령 출력·건수를 제한한다.
_OUTPUT_EXCERPT_CHARS = 2000
_MAX_RECORDED_COMMANDS = 30

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
    # 실제로 대상 클러스터에 나간 명령(kubectl) 기록 — 런북(설계)과 대조하는 실측값.
    commands: list[dict[str, Any]] = field(default_factory=list)


class DeepCheckerBase(ABC):
    """Deep check 추상 베이스.

    구현체는 ``check_type`` 클래스 속성을 ``registry`` key 와 맞추고,
    ``run(ctx) -> DeepCheckOutcome`` 를 구현한다.
    """

    check_type: str = "abstract"
    display_name: str = "abstract"

    # ── K8s client (lazy) ──────────────────────────────────────
    def _v1(self, ctx: DeepCheckContext) -> client.CoreV1Api:
        """클러스터별로 격리된 ``ApiClient`` 를 만들어 반환한다.

        ``config.load_kube_config()``/``load_incluster_config()`` 는 kubernetes-client
        의 프로세스 전역 default Configuration 을 변경한다 — 수동 실행("지금 점검")과
        디스패처 fan-out 이 같은 워커 프로세스에서 동시에 서로 다른 클러스터를 점검하면,
        한 클러스터의 kubeconfig 로 다른 클러스터에 exec/조회가 나가는 race 가 생길 수
        있다. ``config.new_client_from_config()`` 는 전역 상태를 건드리지 않는 별도
        ``ApiClient`` 를 반환해 이 문제를 피한다(``daily_checker.py`` 의
        ``_get_k8s_client`` 와 동일 패턴).
        """
        if ctx.in_cluster:
            try:
                config.load_incluster_config()
                api_client = client.ApiClient()
            except config.ConfigException:
                api_client = config.new_client_from_config()
        else:
            kc = ensure_kubeconfig_file(ctx.cluster) if ctx.cluster else None
            if kc and os.path.exists(kc):
                api_client = config.new_client_from_config(config_file=kc)
            else:
                try:
                    config.load_incluster_config()
                    api_client = client.ApiClient()
                except config.ConfigException:
                    api_client = config.new_client_from_config()
        return client.CoreV1Api(api_client)

    def _kubectl(self, ctx: DeepCheckContext, *args: str, timeout: int = 30) -> subprocess.CompletedProcess:
        cmd = ["kubectl"]
        if not ctx.in_cluster and ctx.cluster is not None:
            kc = ensure_kubeconfig_file(ctx.cluster)
            if kc and os.path.exists(kc):
                cmd.extend(["--kubeconfig", kc])
            if ctx.cluster.api_endpoint:
                cmd.extend(["--server", ctx.cluster.api_endpoint])
        cmd.extend(args)
        t0 = time.time()
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        except Exception as e:  # noqa: BLE001
            self._record_command(cmd, t0, exit_code=None, stdout="", stderr=str(e)[:_OUTPUT_EXCERPT_CHARS])
            raise
        self._record_command(
            cmd, t0, exit_code=proc.returncode, stdout=proc.stdout or "", stderr=proc.stderr or "",
        )
        return proc

    # ── 실제 실행된 명령 수집 (런북 "설계" 대비 "실측") ─────────────
    def _record_command(
        self,
        cmd: list[str],
        started: float,
        *,
        exit_code: Optional[int],
        stdout: str,
        stderr: str,
    ) -> None:
        """대상 클러스터에 실제로 나간 명령 1건을 기록한다.

        kubeconfig 경로는 서버 내부 경로라 마스킹하고, 출력은 발췌만 남긴다
        (전체를 담으면 JSONB 가 무한정 커진다).
        """
        if not hasattr(self, "_commands"):
            self._commands = []
        if len(self._commands) >= _MAX_RECORDED_COMMANDS:
            return
        display: list[str] = []
        skip_next = False
        for tok in cmd:
            if skip_next:
                display.append("<kubeconfig>")
                skip_next = False
                continue
            if tok == "--kubeconfig":
                display.append(tok)
                skip_next = True
                continue
            display.append(tok)
        self._commands.append({
            "kind": "kubectl",
            "command": " ".join(display),
            "exit_code": exit_code,
            "duration_ms": int((time.time() - started) * 1000),
            "stdout": (stdout or "")[:_OUTPUT_EXCERPT_CHARS],
            "stderr": (stderr or "")[:_OUTPUT_EXCERPT_CHARS],
            "truncated": len(stdout or "") > _OUTPUT_EXCERPT_CHARS,
        })

    def _collected_commands(self) -> list[dict[str, Any]]:
        return list(getattr(self, "_commands", []))

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
        self._commands = []
        self._run_start = start
        try:
            outcome = self.run(ctx)
            outcome.duration_ms = int((time.time() - start) * 1000)
            if not outcome.steps:
                outcome.steps = self._collected_steps()
            if not outcome.commands:
                outcome.commands = self._collected_commands()
            return outcome
        except FileNotFoundError as e:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message=f"{self.display_name}: 필수 파일 없음 — {str(e)[:120]}",
                details={"error": str(e)[:500]},
                duration_ms=int((time.time() - start) * 1000),
                steps=self._collected_steps(),
                commands=self._collected_commands(),
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
                commands=self._collected_commands(),
            )
