"""Strategy Pattern base class for health checkers."""
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional

from kubernetes import client
from sqlalchemy.orm import Session

from app.models import Cluster, Addon, StatusEnum
from app.services.kubeconfig import ensure_kubeconfig_file
from app.services.k8s_client_pool import get_api_client_for_path, get_incluster_api_client


# exception message 에 들어있으면 "연결 문제"로 분류해 pending 처리
_CONNECTION_ERROR_HINTS = (
    "connection refused",
    "no route to host",
    "timed out",
    "timeout",
    "network is unreachable",
    "nodename nor servname",
    "temporary failure in name resolution",
    "ssl:",
    "max retries exceeded",
    "connection error",
    "failed to establish",
    "certificate verify failed",
)


@dataclass
class CheckResult:
    status: StatusEnum
    message: str
    response_time: int = 0  # ms
    details: Optional[dict[str, Any]] = None


class BaseChecker(ABC):
    """모든 Checker의 추상 기반 클래스"""

    def __init__(self, cluster: Cluster, addon: Addon, db: Optional[Session] = None):
        self.cluster = cluster
        self.addon = addon
        self.db = db   # 스냅샷(etcd_systemd / etcdctl_config) 조회용 — 없어도 동작
        self._v1: Optional[client.CoreV1Api] = None

    # ── K8s client (lazy init, 재사용) ──────────────────────
    def _get_k8s_client(self) -> client.CoreV1Api:
        if self._v1 is not None:
            return self._v1

        # kubeconfig 파일이 없으면 DB content 로 재생성 시도
        # 전역 config.load_kube_config() 는 동시 점검 시 다른 클러스터로 요청이 새는 race 를
        # 만든다 — 격리된 풀 클라이언트(기본 타임아웃·read 재시도 0)를 쓴다.
        kc_path = ensure_kubeconfig_file(self.cluster)
        if kc_path and os.path.exists(kc_path):
            api_client = get_api_client_for_path(kc_path)
        else:
            api_client = get_incluster_api_client()

        self._v1 = client.CoreV1Api(api_client)
        return self._v1

    # ── 시간 측정 헬퍼 ──────────────────────────────────────
    @staticmethod
    def _elapsed_ms(start: datetime) -> int:
        return int((datetime.utcnow() - start).total_seconds() * 1000)

    # ── 서브클래스 구현 필수 ────────────────────────────────
    @abstractmethod
    def check(self) -> CheckResult:
        """실제 헬스 체크 로직. 서브클래스에서 구현."""
        ...

    # ── 안전 실행 래퍼 ──────────────────────────────────────
    def safe_check(self) -> CheckResult:
        """예외를 잡아서 CheckResult 로 변환.

        연결 관련 예외는 pending(미연결)로 분류해서 cluster.status 가
        critical(빨강)로 오해되지 않도록 한다.
        """
        try:
            return self.check()
        except FileNotFoundError as e:
            # kubectl binary 또는 kubeconfig 파일 부재
            return CheckResult(
                status=StatusEnum.pending,
                message=f"{self.addon.name}: 필수 파일 없음 — {str(e)[:120]}",
                details={"error": str(e)[:500]},
            )
        except Exception as e:
            msg = str(e).lower()
            if any(h in msg for h in _CONNECTION_ERROR_HINTS):
                return CheckResult(
                    status=StatusEnum.pending,
                    message=f"{self.addon.name}: 연결 실패 — {str(e)[:120]}",
                    details={"error": str(e)[:500]},
                )
            return CheckResult(
                status=StatusEnum.critical,
                message=f"{self.addon.name} check failed: {str(e)[:200]}",
                details={"error": str(e)[:500]},
            )
