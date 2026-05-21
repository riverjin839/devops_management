# Design — Pod-to-Pod Bottleneck Analyzer (As-To-Be)

> 작성일: 2026-05-21
> Plan: `docs/01-plan/features/pod-bottleneck-analyzer.plan.md`
> 선택 architecture: **Option C (Pragmatic)** — PRD 4 결정에 정합

## Context Anchor (Plan 복사본)

| Key | Value |
|---|---|
| **WHY** | 정성 verdict 만으론 못 푸는 "허용은 되는데 느림" 시나리오의 정량 증거 + 비전문가 진입 장벽 ↓ |
| **WHO** | DevOps SRE (junior-mid) — 30분 안에 1차 진단 후 escalate/fix |
| **RISK** | 4 Probe 다 깊으면 1500줄+, exec 실패 (distroless/PSA) 대응 필요 |
| **SUCCESS** | 4축 < 10초 + history + cross-link + manual fallback |
| **SCOPE** | BottleneckRun + 4 Probe Registry + `/pod-bottleneck` 메인+상세 + PacketFlow CTA |

## 1. Architecture 3-Option 비교

| 항목 | A. Minimal | B. Clean (분리) | **C. Pragmatic** |
|---|---|---|---|
| 모델 | `lake_service_checks` 컬럼 확장 (kind=bottleneck) | `BottleneckRun` + `BottleneckProbeResult` + `BottleneckProbeType` 3 모델 | `BottleneckRun` 1 모델 (probes JSONB array) |
| Probe 위치 | `services/lake_checkers/` 안 | `services/bottleneck/` 별도 디렉토리 + 별도 base | `services/bottleneck_probes/` (lake_checkers 패턴 차용) |
| Router | 기존 `lake_services.py` 에 endpoint 추가 | `routers/bottleneck/` 디렉토리 + sub-module | 신규 `routers/bottleneck.py` 1 파일 |
| Frontend | LakeServiceDetailPage 안 탭 | `/bottleneck/*` 디렉토리 + 컴포넌트 라이브러리 | 신규 `/pod-bottleneck` + 컴포넌트 |
| 예상 라인 | ~400 | ~2200 | **~1400** |
| Plan 한도 1300-1600 | ❌ 너무 작음 (lake 의미 흐림) | ❌ 초과 | ✅ 적합 |

**선택 — Option C (Pragmatic)**. lake-service-monitoring 과 같은 디자인 정책. PRD 4 결정 (D4 신규 BottleneckRun 모델) 정합.

## 2. As-To-Be 구조

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Frontend                                    │
│  /pod-bottleneck              ── PodBottleneckPage (메인 + 진단 폼)  │
│  /pod-bottleneck/:runId       ── PodBottleneckDetailPage (단일 결과) │
│                                                                      │
│  PacketFlowPage 우상단 ── "이 pod-pair 의 병목 진단 →" CTA          │
│  Sidebar "모니터링" 그룹 ── "Pod 병목 진단" 추가                     │
└──────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ (TanStack Query via podBottleneckApi)
┌──────────────────────────────────────────────────────────────────────┐
│   Backend — routers/bottleneck.py                                    │
│                                                                      │
│   POST   /pod-bottleneck/run        ← 4 Probe 병렬 실행 + Run 저장   │
│   GET    /pod-bottleneck/runs       ← list (filter: cluster/ns/pair) │
│   GET    /pod-bottleneck/runs/{id}  ← detail                         │
│   DELETE /pod-bottleneck/runs/{id}  ← delete                         │
│   GET    /pod-bottleneck/probes     ← 등록된 Probe 메타              │
└──────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│   services/bottleneck_probes/                                        │
│   ├─ __init__.py     ── BOTTLENECK_PROBE_REGISTRY + PROBE_CATALOG    │
│   ├─ base.py         ── BottleneckProbeBase (asyncio + safe_run)     │
│   ├─ tcp_state.py    ── TcpStateProbe (kubectl exec ss -tinJ)        │
│   ├─ tcp_perf.py     ── TcpPerfProbe (/proc/net/snmp diff)           │
│   ├─ dns_latency.py  ── DnsLatencyProbe (CoreDNS metrics + fallback) │
│   └─ endpoints.py    ── EndpointsProbe (K8s SDK EndpointSlice)       │
│                                                                      │
│   services/kubectl_exec.py  ── helper (exec + manual_command suggest)│
└──────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│   models/bottleneck_run.py — BottleneckRun (단일 모델)               │
│   ├─ id, cluster_id (FK), namespace, source_pod, dest_pod            │
│   ├─ dest_service (optional — endpoints probe 용)                    │
│   ├─ overall_status (StatusEnum — 4 probe 최악값)                    │
│   ├─ probes (JSONB) — { "tcp_state": {status, message, raw, ...}, ... } │
│   ├─ triggered_by_user, duration_ms                                  │
│   └─ created_at                                                      │
└──────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ (read-only)
┌──────────────────────────────────────────────────────────────────────┐
│   기존 자산                                                          │
│   - app.services.kubeconfig (ensure_kubeconfig_file)                 │
│   - app.services.audit_logger                                        │
│   - app.auth.deps (get_current_user / require_operator)              │
└──────────────────────────────────────────────────────────────────────┘
```

## 3. Data Model — BottleneckRun (1 모델, probes JSONB)

```python
class BottleneckRun(Base):
    __tablename__ = "bottleneck_runs"
    __table_args__ = (
        Index("ix_bottleneck_runs_pair", "cluster_id", "namespace", "source_pod", "dest_pod"),
        Index("ix_bottleneck_runs_created", "created_at"),
    )

    id = Column(UUID, primary_key=True, default=uuid.uuid4)
    cluster_id = Column(UUID, ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)
    namespace = Column(String(100), nullable=False)
    source_pod = Column(String(253), nullable=False)
    dest_pod = Column(String(253), nullable=False)
    dest_service = Column(String(253), nullable=True)  # optional — endpoints probe 용

    overall_status = Column(Enum(StatusEnum), nullable=False, default=StatusEnum.pending)
    # 4 Probe 결과 통합 JSONB:
    # {
    #   "tcp_state":   {"status": "warning", "message": "Recv-Q 8192", "details": {...}, "manual_fallback": null},
    #   "tcp_perf":    {"status": "healthy", ...},
    #   "dns_latency": {"status": "critical", "message": "p95 580ms", ...},
    #   "endpoints":   {"status": "warning", "message": "2/5 ready", ...},
    # }
    probes = Column(JSONB, nullable=False, default=dict)

    triggered_by_user = Column(String(100), nullable=True)
    duration_ms = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())

    cluster = relationship("Cluster")
```

**왜 JSONB 1 컬럼** (Probe Result 별도 테이블 X):
- 4 Probe 결과가 항상 같이 조회됨 (per-run atomic)
- Probe 추가는 JSONB 키 추가만 — 스키마 변경 없음
- history 조회는 run 단위라 row count 적당 (시간 cap 으로 retention 가능)

## 4. API Matrix

| Endpoint | Verb | Auth | Pagination | Audit |
|---|---|---|:---:|:---:|
| `/pod-bottleneck/probes` | GET | get_current_user | — | — |
| `/pod-bottleneck/runs` | GET | get_current_user | offset/limit | — |
| `/pod-bottleneck/runs/{id}` | GET | get_current_user | — | — |
| `/pod-bottleneck/run` | POST | require_operator | — | `bottleneck.run` |
| `/pod-bottleneck/runs/{id}` | DELETE | require_operator | — | `bottleneck.delete` |

→ 직전 사이클 baseline 그대로.

## 5. Probe 패턴

### 5.1 Base

```python
@dataclass
class ProbeResult:
    status: StatusEnum
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    manual_fallback: Optional[dict] = None  # {"command": "...", "reason": "..."}
    recommendation: Optional[str] = None    # "Recv-Q 8192 — 앱 CPU 확인..."

@dataclass
class ProbeContext:
    cluster: Cluster
    namespace: str
    source_pod: str
    dest_pod: str
    dest_service: Optional[str]
    kubeconfig_path: str

class BottleneckProbeBase(ABC):
    PROBE_KEY: str           # 'tcp_state', 'tcp_perf', ...
    PROBE_LABEL: str         # 'TCP Socket State'
    TIMEOUT_SEC: int = 5

    @abstractmethod
    async def run(self, ctx: ProbeContext) -> ProbeResult: ...

    async def safe_run(self, ctx: ProbeContext) -> ProbeResult:
        try:
            return await asyncio.wait_for(self.run(ctx), timeout=self.TIMEOUT_SEC)
        except asyncio.TimeoutError:
            return ProbeResult(StatusEnum.pending,
                               f"{self.PROBE_LABEL}: {self.TIMEOUT_SEC}s timeout",
                               details={"timeout": True})
        except Exception as e:  # noqa: BLE001
            return ProbeResult(StatusEnum.critical,
                               f"{self.PROBE_LABEL}: 내부 오류 — {str(e)[:200]}",
                               details={"exception": str(e)[:500]})
```

### 5.2 4 Probe 구현 요지

| Probe | 핵심 로직 | exec 실패 시 fallback |
|---|---|---|
| TcpStateProbe | `kubectl exec` → `ss -tinJ` → JSON parse → Recv-Q/Send-Q/RTT/cwnd/retrans | manual_fallback={"command": "kubectl exec -n {ns} {pod} -- ss -tin", "reason": "..."} |
| TcpPerfProbe | `cat /proc/net/snmp /proc/net/netstat` 1차 → 2초 sleep → 2차 → diff | manual_fallback 동일 패턴 |
| DnsLatencyProbe | 1차: CoreDNS `:9153/metrics` Prometheus parse / 2차 fallback: source pod 에서 `getent hosts {svc}` 3회 | metrics endpoint 권한 없으면 nslookup 시도, 둘 다 실패면 manual |
| EndpointsProbe | K8s SDK `discovery_v1.list_namespaced_endpoint_slice(label="kubernetes.io/service-name={svc}")` | exec 불필요 — fail 시 message + status=pending |

### 5.3 PROBE_CATALOG + REGISTRY

```python
PROBE_CATALOG = {
    "tcp_state":   {"label": "TCP Socket State",  "axis": "L4 state",    "needs_exec": True,  "fallback_cmd": "ss -tin"},
    "tcp_perf":    {"label": "TCP Perf Counters", "axis": "L4 counters", "needs_exec": True,  "fallback_cmd": "cat /proc/net/snmp"},
    "dns_latency": {"label": "DNS Latency",       "axis": "L7 DNS",      "needs_exec": False, "fallback_cmd": "nslookup ..."},
    "endpoints":   {"label": "Service Endpoints", "axis": "K8s control", "needs_exec": False, "fallback_cmd": None},
}

BOTTLENECK_PROBE_REGISTRY: dict[str, type[BottleneckProbeBase]] = {
    "tcp_state":   TcpStateProbe,
    "tcp_perf":    TcpPerfProbe,
    "dns_latency": DnsLatencyProbe,
    "endpoints":   EndpointsProbe,
}
```

신규 Probe 추가 = 1 클래스 + REGISTRY 1줄 + CATALOG 1 entry (lake 패턴).

## 6. Service Layer

```python
# services/kubectl_exec.py
def safe_pod_exec(api_client: ApiClient, ns: str, pod: str, command: list[str], timeout: int = 5
                  ) -> tuple[Optional[str], Optional[dict]]:
    """returns (stdout, manual_fallback_dict). 한쪽이 None.

    fallback_dict = {
        "command": "kubectl exec -n ns pod -- <cmd>",
        "reason": "Forbidden / no binary / PSA restricted / timeout"
    }
    """
    ...
```

## 7. Run Orchestration

```python
# routers/bottleneck.py 안 또는 별도 service
async def execute_bottleneck_run(ctx: ProbeContext) -> BottleneckRun:
    start = time.time()
    probes_to_run = list(BOTTLENECK_PROBE_REGISTRY.values())
    results = await asyncio.gather(*[p().safe_run(ctx) for p in probes_to_run])
    probes_dict = {p.PROBE_KEY: asdict(r) for p, r in zip(probes_to_run, results)}
    overall = _worst_status([r.status for r in results])
    run = BottleneckRun(
        cluster_id=ctx.cluster.id, namespace=ctx.namespace,
        source_pod=ctx.source_pod, dest_pod=ctx.dest_pod, dest_service=ctx.dest_service,
        overall_status=overall, probes=probes_dict,
        triggered_by_user=ctx.actor_username, duration_ms=int((time.time()-start)*1000),
    )
    db.add(run); db.commit()
    return run
```

## 8. Frontend Component 위계

```
pages/PodBottleneckPage.tsx          ← 메인 (run 폼 + recent runs)
  ├─ ClusterSidebar (iconOnly, allowAll)
  ├─ Form: ns + source_pod (autocomplete) + dest_pod + dest_service (optional)
  ├─ "지금 진단" 버튼 → POST /pod-bottleneck/run
  ├─ Recent Runs list (LakeServiceCard 와 유사 카드)
  └─ Empty/loading/error 분기

pages/PodBottleneckDetailPage.tsx    ← 단일 run 상세
  ├─ Header (back + pair info + overall status badge + 삭제)
  ├─ 4 ProbeResultCard (MacCard 4개) — status + 핵심 수치 + 권고 + raw JSON expand
  └─ ConfirmDialog (삭제)

components/pod-bottleneck/
  ├─ ProbeResultCard.tsx   ── 단일 probe 결과 — status badge + manual_fallback 안내
  ├─ ProbeAxisBadge.tsx    ── 4 axis (L4 state/L4 counters/L7 DNS/K8s control) 색상
  ├─ PodPicker.tsx         ── K8s pod 자동완성 (cluster + ns 입력 → pod 후보 fetch)
  └─ index.ts

hooks/usePodBottleneck.ts
  ├─ useBottleneckRuns(filter)
  ├─ useBottleneckRun(id)
  ├─ useBottleneckProbes (PROBE_CATALOG)
  ├─ useRunBottleneck    (POST /run)
  └─ useDeleteBottleneckRun

PacketFlowPage.tsx 우상단:
  ├─ source/dest pod 가 선택된 상태일 때 "이 pod-pair 의 병목 진단" 버튼
  └─ navigate(`/pod-bottleneck?cluster=...&ns=...&src=...&dst=...`)
```

## 9. Module Map (Do phase split)

| Module | 파일 | 라인 |
|---|---|---:|
| **M1. Model** | `models/bottleneck_run.py` + models/__init__.py | ~80 |
| **M2. Schemas** | `schemas/bottleneck.py` | ~80 |
| **M3. Probes** | `services/bottleneck_probes/{base,tcp_state,tcp_perf,dns_latency,endpoints,__init__}.py` + `services/kubectl_exec.py` | ~450 |
| **M4. Router** | `routers/bottleneck.py` + routers/__init__.py | ~200 |
| **M5. main.py** | router 등록 (Base.metadata.create_all 자동) | ~5 |
| **M6. Frontend types/api/hooks** | types + api + usePodBottleneck | ~150 |
| **M7. Frontend pages** | PodBottleneckPage + PodBottleneckDetailPage | ~350 |
| **M8. Frontend components** | ProbeResultCard + ProbeAxisBadge + PodPicker | ~180 |
| **M9. App + Sidebar + PacketFlow CTA** | App.tsx + Sidebar.tsx + PacketFlowPage.tsx | ~30 |

총: ~1525 라인 — Plan 한도 1300-1600 정합.

## 10. 다음 Phase — Do

Backend (M1-M5) 먼저, frontend (M6-M9) 그 다음. 직전 lake 사이클 처럼 메시지 분할 가능.
