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
    "softtimelimitexceeded",
)

# TLS/인증서 문제는 "연결 안 됨"과 증상(HTTPSConnectionPool ... Max retries exceeded)이
# 겹쳐 보이지만 원인·조치가 다르다 — 연결 자체는 되는데 kubeconfig 의 CA 데이터가 서버
# 인증서와 안 맞거나(클러스터 CA 로테이션 후 kubeconfig 미갱신 등) 만료된 경우라, 재시도로
# 저절로 낫지 않는 지속적 설정 문제다. 예전엔 `_CONNECTION_ERROR_HINTS` 에 "ssl:" 하나로
# 뭉뚱그려 pending(=곧 나아질 것) 으로 분류했는데, 그러면 운영자가 진짜 원인(kubeconfig
# 갱신 필요)을 놓친다. kubectl 기반 배치잡의 `k8s_diagnose.classify_kubectl_failure` 와
# 같은 패턴 매칭을 써서 critical + 구체적 안내 문구로 분리한다.
_TLS_ERROR_HINTS = (
    "certificate verify failed",
    "certificate_verify_failed",
    "certificate signed by unknown authority",
    "certificate has expired",
    "hostname mismatch",
    "unable to get local issuer certificate",
    "ssl:",
    "x509",
)
_TLS_ERROR_HINT_MESSAGE = (
    "TLS/인증서 확인 실패로 보입니다 — kubeconfig 의 certificate-authority-data 가 "
    "실제 API 서버 인증서와 맞지 않거나(클러스터 CA 로테이션 후 미갱신 등) 만료됐을 수 "
    "있습니다. /cluster-manage 에서 kubeconfig 를 최신 상태로 다시 등록하세요."
)

# K8s API 서버가 응답하지 않을 때(다운/네트워크 단절) 호출이 무한정 대기하다 Celery 의
# soft time limit(240s, celery_app.py)에 걸려서야 SoftTimeLimitExceeded 로 죽는 문제가
# 있었다 — kubernetes 파이썬 클라이언트는 Configuration 레벨 전역 기본 타임아웃을 지원하지
# 않고 호출마다 `_request_timeout=` 을 넘겨야 하는데(까먹기 쉬운 패턴, 실제로 여러 체커가
# 누락하고 있었다), `_v1()`/`_wrap_api()` 가 반환하는 프록시가 모든 호출에 자동으로
# 주입해 이 클래스의 실수를 구조적으로 막는다.
_K8S_API_TIMEOUT_SECONDS = 15


class _TimeoutGuardedApi:
    """K8s Api(``CoreV1Api`` 등) 얇은 프록시 — 호출자가 ``_request_timeout`` 을 명시하지
    않으면 ``_K8S_API_TIMEOUT_SECONDS`` 를 기본으로 주입한다. 호출자가 직접 넘긴 값은
    그대로 존중한다."""

    def __init__(self, api: Any) -> None:
        self._api = api

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._api, name)
        if not callable(attr):
            return attr

        def _call(*args: Any, **kwargs: Any) -> Any:
            kwargs.setdefault("_request_timeout", _K8S_API_TIMEOUT_SECONDS)
            return attr(*args, **kwargs)

        return _call


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

        반환값은 실제로는 ``_TimeoutGuardedApi`` 로 감싼 ``CoreV1Api`` — 호출자는
        신경 쓸 필요 없이 그냥 ``CoreV1Api`` 처럼 쓰면 된다(모든 메서드가 그대로 위임됨).
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
        return self._wrap_api(client.CoreV1Api(api_client))

    @staticmethod
    def _wrap_api(api: Any) -> Any:
        """다른 Api 클래스(``RbacAuthorizationV1Api`` 등)를 ``_v1()`` 이 만든 것과
        같은 ``api_client`` 로 추가 생성할 때도 동일한 타임아웃 보호를 적용하는 헬퍼."""
        return _TimeoutGuardedApi(api)

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
            # 체커가 예외를 던지지 않고 st.status="failed" 만 세팅한 뒤 그대로
            # DeepCheckOutcome 을 반환하는 경우(흔한 "정상적인 실패" 경로 — 권한 부족,
            # 바이너리 없음, 스냅샷 없음 등) 는 safe_run() 의 일반 예외 로깅을 타지 않아
            # 예전엔 서버 로그에 아무 흔적도 안 남았다(실사례: cert_expiry 의 kubectl
            # exec 실패가 DB/steps 에만 기록되고 journalctl 등에는 안 보임). 여기서
            # 한 곳에 모아 로깅해 모든 체커가 별도 logger 호출 없이도 추적 가능하게 한다.
            if rec.status == "failed":
                logger.warning(
                    "deep check %s[%s] step '%s' (%s) failed: %s",
                    self.check_type, getattr(self, "_log_cluster_label", "?"),
                    step_id, label, (rec.detail or "")[:300],
                )

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
        # _step() 의 실패 로깅이 클러스터를 식별할 수 있도록 — ctx.cluster 가 실제 ORM
        # 객체가 아닐 수도 있어(테스트, in-cluster 단독 모드) getattr 로 방어한다.
        self._log_cluster_label = getattr(ctx.cluster, "name", None) or "(no cluster)"
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
            # TLS/인증서 문제는 "연결 실패" 힌트와 문자열이 겹치는 경우가 많아(예:
            # "Max retries exceeded ... Caused by SSLError(...)") 더 구체적인 TLS 패턴을
            # 먼저 확인한다 — pending(곧 나아질 것)이 아니라 critical + 조치 안내로.
            if any(h in msg for h in _TLS_ERROR_HINTS):
                status = StatusEnum.critical
                message = f"{self.display_name} 실패 — {_TLS_ERROR_HINT_MESSAGE} (원문: {str(e)[:200]})"
            else:
                status = (
                    StatusEnum.pending
                    if any(h in msg for h in _CONNECTION_ERROR_HINTS)
                    else StatusEnum.critical
                )
                message = f"{self.display_name} 실패: {str(e)[:200]}"
            logger.warning("Deep check %s failed: %s", self.check_type, e)
            return DeepCheckOutcome(
                status=status,
                message=message,
                details={"error": str(e)[:1000]},
                duration_ms=int((time.time() - start) * 1000),
                steps=self._collected_steps(),
                commands=self._collected_commands(),
            )
