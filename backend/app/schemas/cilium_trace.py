"""Cilium BPF / Hubble trace schemas."""
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field


# ── Status / discovery ──────────────────────────────────────────────────────

class CiliumStatusResponse(BaseModel):
    cluster_id: UUID
    cilium_installed: bool
    hubble_relay_installed: bool
    agent_count: int
    cilium_version: Optional[str] = None
    namespace: str = "kube-system"
    error: Optional[str] = None


class CiliumAgent(BaseModel):
    pod_name: str
    namespace: str
    node_name: Optional[str] = None
    node_ip: Optional[str] = None
    ready: bool = False


class CiliumAgentsResponse(BaseModel):
    cluster_id: UUID
    agents: list[CiliumAgent]
    error: Optional[str] = None


# ── BPF map inspector (one-shot snapshots) ─────────────────────────────────

# 지원하는 BPF map 종류. cilium-dbg bpf <kind> list 로 매핑.
BpfKind = Literal[
    "endpoint",   # bpf endpoint list
    "lb",         # bpf lb list
    "nat",        # bpf nat list
    "ct",         # bpf ct list global
    "tunnel",     # bpf tunnel list
    "policy",     # bpf policy get <endpoint-id>
    "fs",         # bpf fs show
    "metrics",    # bpf metrics list
    "ipcache",    # bpf ipcache list
    "node",       # bpf node list (node ip → identity)
]


class BpfInspectRequest(BaseModel):
    cluster_id: UUID
    kind: BpfKind
    pod_name: Optional[str] = Field(
        default=None,
        description="대상 cilium agent pod. 비우면 첫 번째 ready agent.",
    )
    namespace: str = Field(default="kube-system")
    # policy kind 일 때만 의미 있음
    endpoint_id: Optional[str] = Field(
        default=None, description="policy 조회 시 endpoint ID 필수.",
    )


class BpfInspectResponse(BaseModel):
    cluster_id: UUID
    kind: str
    pod_name: str
    raw: str = ""
    parsed: list[dict[str, Any]] | dict[str, Any] | None = None
    is_json: bool = False
    error: Optional[str] = None
    executed: Optional[str] = None


class CiliumExecRequest(BaseModel):
    pod_name: Optional[str] = Field(default=None, description="대상 cilium agent pod. 비우면 첫 ready agent.")
    namespace: str = Field(default="kube-system")
    command_args: str = Field(..., description="cilium-dbg 뒤 인자 (예: 'ipam status', 'bpf endpoint list').")
    timeout: int = Field(default=30, ge=5, le=120)


class CiliumExecResponse(BaseModel):
    cluster_id: UUID
    pod_name: str = ""
    command_args: str = ""
    raw: str = ""
    exit_code: Optional[int] = None
    error: Optional[str] = None
    executed: Optional[str] = None
    duration_ms: int = 0


# ── Cilium monitor stream (SSE) ─────────────────────────────────────────────

class MonitorStreamParams(BaseModel):
    """Query 파라미터로 받기 위해 사용 — 라우터에서 직접 unpack."""
    pod_name: str
    namespace: str = "kube-system"
    type: Optional[str] = Field(
        default=None,
        description='쉼표로 구분: drop, trace, capture, debug, recorder, agent, l7. 비우면 모두.',
    )
    related_to: Optional[str] = Field(
        default=None,
        description="특정 endpoint ID 만 — --related-to 와 매핑.",
    )
    hex: bool = False


# ── Hubble flow stream (SSE) ────────────────────────────────────────────────

class HubbleStreamParams(BaseModel):
    namespace: str = "kube-system"
    relay_service: str = "hubble-relay"
    relay_port: int = 80
    from_pod: Optional[str] = None      # "ns/name"
    to_pod: Optional[str] = None
    from_namespace: Optional[str] = None
    to_namespace: Optional[str] = None
    protocol: Optional[str] = None      # tcp | udp | http | dns
    verdict: Optional[str] = None       # FORWARDED | DROPPED
