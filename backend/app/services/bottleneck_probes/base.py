"""BottleneckProbeBase — pod-to-pod 병목 진단 probe 베이스.

각 Probe 는 ProbeContext (cluster, ns, source_pod, dest_pod, dest_service, kubeconfig)
를 받아 ProbeResult (status + message + details + manual_fallback + recommendation)
반환. safe_run() 이 timeout / 예외를 ProbeResult 로 변환 — gather 가 막히지 않음.
"""
from __future__ import annotations

import asyncio
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Any, Optional, TYPE_CHECKING

from kubernetes import client, config

from app.models import StatusEnum
from app.services.kubeconfig import ensure_kubeconfig_file

if TYPE_CHECKING:
    from app.models import Cluster


@dataclass
class ProbeResult:
    status: StatusEnum
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    manual_fallback: Optional[dict] = None  # {"command": str, "reason": str}
    recommendation: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        """JSONB 저장용 — Enum → str 변환 포함."""
        d = asdict(self)
        d["status"] = self.status.value if hasattr(self.status, "value") else str(self.status)
        return d


@dataclass
class ProbeContext:
    cluster: "Cluster"
    namespace: str
    source_pod: str
    dest_pod: str
    dest_service: Optional[str]
    kubeconfig_path: Optional[str]
    _v1_cache: Optional[client.CoreV1Api] = None
    _api_client_cache: Optional[client.ApiClient] = None

    def get_v1(self) -> client.CoreV1Api:
        """K8s SDK client 캐시 (multi-cluster 격리)."""
        if self._v1_cache is not None:
            return self._v1_cache
        api_client = self.get_api_client()
        self._v1_cache = client.CoreV1Api(api_client)
        return self._v1_cache

    def get_api_client(self) -> client.ApiClient:
        if self._api_client_cache is not None:
            return self._api_client_cache
        if self.kubeconfig_path and os.path.exists(self.kubeconfig_path):
            self._api_client_cache = config.new_client_from_config(config_file=self.kubeconfig_path)
        else:
            try:
                config.load_incluster_config()
                self._api_client_cache = client.ApiClient()
            except config.ConfigException:
                self._api_client_cache = config.new_client_from_config()
        return self._api_client_cache


def make_context(cluster, namespace: str, source_pod: str, dest_pod: str,
                 dest_service: Optional[str]) -> ProbeContext:
    kc = ensure_kubeconfig_file(cluster)
    return ProbeContext(
        cluster=cluster,
        namespace=namespace,
        source_pod=source_pod,
        dest_pod=dest_pod,
        dest_service=dest_service,
        kubeconfig_path=kc,
    )


class BottleneckProbeBase(ABC):
    PROBE_KEY: str = "base"
    PROBE_LABEL: str = "Base Probe"
    TIMEOUT_SEC: int = 5

    @abstractmethod
    async def run(self, ctx: ProbeContext) -> ProbeResult:
        ...

    async def safe_run(self, ctx: ProbeContext) -> ProbeResult:
        """timeout + 예외 → ProbeResult."""
        try:
            return await asyncio.wait_for(self.run(ctx), timeout=self.TIMEOUT_SEC)
        except asyncio.TimeoutError:
            return ProbeResult(
                status=StatusEnum.pending,
                message=f"{self.PROBE_LABEL}: {self.TIMEOUT_SEC}s timeout",
                details={"timeout": True},
            )
        except Exception as e:  # noqa: BLE001
            return ProbeResult(
                status=StatusEnum.critical,
                message=f"{self.PROBE_LABEL}: 내부 오류 — {str(e)[:200]}",
                details={"exception": str(e)[:500]},
            )
