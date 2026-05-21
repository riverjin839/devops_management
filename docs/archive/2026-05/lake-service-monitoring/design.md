# Design — LAKE Service Monitoring (As-To-Be)

> 작성일: 2026-05-21
> Plan: `docs/01-plan/features/lake-service-monitoring.plan.md`
> 다음: `docs/03-analysis/lake-service-monitoring.analysis.md` (Do 후)

## Context Anchor (Plan 복사본)

| Key | Value |
|---|---|
| **WHY** | 폐쇄망 + 8 OSS + 커스텀 빌드 — 표준 SaaS monitoring 도구 불가, 노하우 흩어짐 |
| **WHO** | DevOps/SRE 평일 점검 루틴 |
| **RISK** | 8 서비스 다 깊으면 한 사이클로 못 끝남 → MVP framework + airflow deep + 7 shallow |
| **SUCCESS** | 메인보드 < 3s, airflow 실측, ServiceEntry 통합, 신규 서비스 1 클래스 + 1 row |
| **SCOPE** | LakeService + LakeChecker + 8 stub + 메인보드 + 상세 + ServiceEntry 통합 |

## 1. Architecture 3 Options 비교

| 항목 | A. Minimal (Addon 재활용) | B. Clean (신규 도메인 + 분리) | **C. Pragmatic (신규 모델 + 기존 패턴 차용)** |
|---|---|---|---|
| 데이터 모델 | `Addon` 모델에 `category='lake'` 추가만 | `LakeService` + `LakeServiceCheck` + `LakeServiceType` 3 모델 | `LakeService` 1 신규 모델 + `Addon` 미사용 |
| Checker 위치 | `services/checkers/airflow_checker.py` 추가 (기존 family 안) | `services/lake/checkers/` 별도 디렉토리 + 별도 base | `services/lake_checkers/` 별도 + `BaseChecker` import (코드 재사용) |
| Router | 기존 `health.py` 에 endpoint 추가 | 신규 `routers/lake/` 디렉토리 + sub-modules | 신규 `routers/lake_services.py` 1 파일 |
| Frontend 페이지 | 기존 Dashboard 에 LAKE 탭 추가 | 신규 `/lake-services/*` 디렉토리 + 컴포넌트 라이브러리 | 신규 `/lake-services` + 상세 = 2 페이지 |
| 마이그레이션 | `addons.type` 에 8 값 추가 | 3 신규 테이블 + FK | 1 신규 테이블 + 기존 테이블 unchanged |
| 신규 서비스 추가 비용 | Addon DB row + checker | LakeServiceType row + checker + 별도 plugin 등록 | LakeService DB row + checker 클래스 + registry 1줄 |
| **장점** | 변경 최소 (~300줄) | 도메인 격리 강함 | 균형 — 격리 + 기존 패턴 재사용 |
| **단점** | Addon 본래 의도(클러스터 addon=etcd/keycloak) 흐려짐, LAKE-specific 메타 추가 어려움 | 코드 ~2000줄, 사이클 초과 가능 | 신규 모델 1개라 1-2 마이그레이션 필요 |
| 예상 라인 | ~300 | ~2000 | **~1200** |
| Plan 한도 (1200-1500) 적합? | ⚠️ 너무 작음 (모델 변경 risk) | ❌ 초과 | ✅ 적합 |

**선택 — Option C (Pragmatic)**. Plan v1 의 Scope/한도와 정확히 일치. Addon 의 의미를 LAKE 로 흐리지 않으면서, 별도 plugin/module 시스템 도입 비용도 회피.

## 2. As-To-Be 구조

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Frontend                                    │
│  /lake-services         ── LakeServicesPage (메인보드 카드 그리드)    │
│  /lake-services/:id     ── LakeServiceDetailPage                     │
│                            ├─ HealthSummary (현재 상태 + 메트릭)      │
│                            ├─ TroubleshootGuides (ServiceEntry kind=guide) │
│                            └─ HistoryTimeline (LakeServiceCheck + ServiceEntry kind=history) │
│                                                                      │
│  Sidebar 메뉴: "운영" 그룹 (monitoring) 에 "LAKE 서비스" 추가         │
└──────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ (TanStack Query via lakeServicesApi)
┌──────────────────────────────────────────────────────────────────────┐
│   Backend — routers/lake_services.py                                 │
│                                                                      │
│   GET    /lake-services                  ← list (filter+pagination)  │
│   POST   /lake-services                  ← register instance          │
│   GET    /lake-services/{id}             ← detail                    │
│   PUT    /lake-services/{id}             ← update                    │
│   DELETE /lake-services/{id}             ← unregister                │
│   POST   /lake-services/{id}/check       ← run health check now       │
│   GET    /lake-services/{id}/checks      ← check history (LakeServiceCheck) │
│   GET    /lake-services/types            ← available service_types + meta │
└──────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│   services/lake_checkers/                                            │
│   ├─ __init__.py     ── LAKE_CHECKER_REGISTRY (dict)                 │
│   ├─ base.py         ── LakeBaseChecker (httpx + multi-cluster)      │
│   ├─ airflow.py      ── AirflowChecker (deep — /health JSON)         │
│   ├─ spark.py        ── SparkChecker (shallow — /api/v1/applications)│
│   ├─ iceberg.py      ── IcebergChecker (shallow — /v1/config)        │
│   ├─ trino.py        ── TrinoChecker (shallow — /v1/info)            │
│   ├─ starrocks.py    ── StarRocksChecker (shallow — /api/health)     │
│   ├─ jupyterlab.py   ── JupyterHubChecker (shallow — /hub/health)    │
│   ├─ superset.py     ── SupersetChecker (shallow — /health)          │
│   └─ polaris.py      ── PolarisChecker (shallow — /api/management/v1/health) │
└──────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│   models/lake_service.py                                             │
│                                                                      │
│   LakeService                          LakeServiceCheck              │
│   ├─ id (UUID PK)                      ├─ id (UUID PK)               │
│   ├─ cluster_id (FK Cluster)           ├─ service_id (FK LakeService) │
│   ├─ service_type (str, idx)           ├─ status (StatusEnum)        │
│   ├─ name (str, unique per cluster)    ├─ response_time_ms (int)     │
│   ├─ category (catalog/runtime/analytics) ├─ message (str)            │
│   ├─ endpoint_url (str)                ├─ details (JSONB)            │
│   ├─ namespace (str, optional)         ├─ checked_at (DateTime)      │
│   ├─ enabled (bool)                                                  │
│   ├─ tls_verify (bool, default false)                                │
│   ├─ status (StatusEnum, latest summary)                             │
│   ├─ last_checked_at (DateTime)                                      │
│   ├─ meta (JSONB — custom labels/notes)                              │
│   └─ created_at, updated_at (server_default)                         │
└──────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ (read-only join)
┌──────────────────────────────────────────────────────────────────────┐
│   models/service_entry.py (기존, 변경 X)                              │
│   detail 페이지에서 service 슬러그 매칭으로 inline 표시               │
│   - kind='guide'    → TroubleshootGuides 섹션                        │
│   - kind='history'  → HistoryTimeline (LakeServiceCheck 와 merge)    │
└──────────────────────────────────────────────────────────────────────┘
```

## 3. Data Model 상세

### LakeService

```python
class LakeService(Base):
    __tablename__ = "lake_services"
    __table_args__ = (
        UniqueConstraint("cluster_id", "service_type", "name", name="uq_lake_cluster_type_name"),
        Index("ix_lake_services_cluster_status", "cluster_id", "status"),
        Index("ix_lake_services_type", "service_type"),
    )

    id            = Column(UUID, primary_key=True, default=uuid.uuid4)
    cluster_id    = Column(UUID, ForeignKey("clusters.id", ondelete="CASCADE"), nullable=False)
    service_type  = Column(String(32), nullable=False)   # airflow|spark|iceberg|trino|starrocks|jupyterlab|superset|polaris
    name          = Column(String(100), nullable=False)  # 사용자 정의 — "Prod Airflow", "Lake A"
    category      = Column(String(20), nullable=False)   # catalog|runtime|analytics (service_type 으로 자동 결정 권장)
    endpoint_url  = Column(String(512), nullable=False)
    namespace     = Column(String(100), nullable=True)
    enabled       = Column(Boolean, default=True, server_default="true")
    tls_verify    = Column(Boolean, default=False, server_default="false")  # 폐쇄망 자체 인증서 패턴 (cluster 와 동일)
    status        = Column(Enum(StatusEnum), default=StatusEnum.pending)
    last_checked_at = Column(DateTime, nullable=True)
    last_message  = Column(Text, nullable=True)
    meta          = Column(JSONB, nullable=True)
    created_at    = Column(DateTime, default=datetime.utcnow, server_default=func.now())
    updated_at    = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, server_default=func.now())

    cluster = relationship("Cluster")
    checks  = relationship("LakeServiceCheck", back_populates="service", cascade="all, delete-orphan")
```

### LakeServiceCheck

```python
class LakeServiceCheck(Base):
    __tablename__ = "lake_service_checks"
    __table_args__ = (Index("ix_lake_checks_service_checked", "service_id", "checked_at"),)

    id              = Column(UUID, primary_key=True, default=uuid.uuid4)
    service_id      = Column(UUID, ForeignKey("lake_services.id", ondelete="CASCADE"), nullable=False)
    status          = Column(Enum(StatusEnum), nullable=False)
    response_time_ms= Column(Integer, nullable=True)
    message         = Column(Text, nullable=True)
    details         = Column(JSONB, nullable=True)
    checked_at      = Column(DateTime, default=datetime.utcnow, server_default=func.now())
    triggered_by    = Column(String(20), default="manual")   # manual | scheduled (스케줄러 도입 carry)

    service = relationship("LakeService", back_populates="checks")
```

## 4. API Contracts

| Endpoint | Verb | Auth | Pagination | Audit |
|---|---|---|:---:|:---:|
| `/lake-services` | GET | `get_current_user` | offset/limit/has_more | - |
| `/lake-services/types` | GET | `get_current_user` | - | - |
| `/lake-services/{id}` | GET | `get_current_user` | - | - |
| `/lake-services/{id}/checks` | GET | `get_current_user` | offset/limit | - |
| `/lake-services` | POST | `require_operator` | - | `lake_service.create` |
| `/lake-services/{id}` | PUT | `require_operator` | - | `lake_service.update` |
| `/lake-services/{id}` | DELETE | `require_operator` | - | `lake_service.delete` |
| `/lake-services/{id}/check` | POST | `require_operator` | - | `lake_service.check_run` |

→ 직전 사이클 baseline 그대로 반영 (인증/페이지네이션/audit/error code dict).

## 5. LakeChecker 패턴

```python
# services/lake_checkers/base.py
@dataclass
class LakeCheckResult:
    status: StatusEnum
    message: str
    response_time_ms: int = 0
    details: Optional[dict] = None

class LakeBaseChecker(ABC):
    """LAKE 서비스 헬스체크 — httpx 기반.
    cluster-level K8s SDK 가 아니라 service endpoint 직접 호출 (in-cluster Service URL).
    """

    def __init__(self, service: LakeService):
        self.service = service

    @abstractmethod
    def healthz_path(self) -> str:
        """e.g. '/health' for airflow, '/v1/info' for trino"""
        ...

    def check(self) -> LakeCheckResult:
        """기본 구현: GET healthz + 200 = healthy, 4xx/5xx = warning/critical.
        서브클래스가 override 가능 (deep check)."""
        url = self.service.endpoint_url.rstrip("/") + self.healthz_path()
        verify = bool(getattr(self.service, "tls_verify", False))
        t0 = time.time()
        try:
            with httpx.Client(verify=verify, timeout=10.0) as c:
                r = c.get(url)
            elapsed = int((time.time() - t0) * 1000)
            if r.status_code == 200:
                return LakeCheckResult(StatusEnum.healthy, f"OK ({elapsed}ms)", elapsed,
                                       {"status_code": 200, "body": r.text[:500]})
            if r.status_code < 500:
                return LakeCheckResult(StatusEnum.warning, f"HTTP {r.status_code}", elapsed,
                                       {"status_code": r.status_code, "body": r.text[:500]})
            return LakeCheckResult(StatusEnum.critical, f"HTTP {r.status_code}", elapsed,
                                   {"status_code": r.status_code, "body": r.text[:500]})
        except Exception as e:
            elapsed = int((time.time() - t0) * 1000)
            return LakeCheckResult(StatusEnum.pending, f"연결 실패: {str(e)[:200]}", elapsed,
                                   {"error": str(e)[:500]})

    def safe_run(self) -> LakeCheckResult:
        try:
            return self.check()
        except Exception as e:
            return LakeCheckResult(StatusEnum.critical, f"checker 내부 오류: {str(e)[:200]}",
                                   0, {"exception": str(e)[:500]})


# services/lake_checkers/airflow.py (deep)
class AirflowChecker(LakeBaseChecker):
    def healthz_path(self) -> str:
        return "/health"

    def check(self) -> LakeCheckResult:
        result = super().check()
        if result.status != StatusEnum.healthy or not result.details:
            return result
        # airflow /health 응답: {metadatabase: {status:healthy}, scheduler: {...}, triggerer: {...}}
        body = result.details.get("body", "")
        try:
            data = json.loads(body)
            components = {k: v.get("status") for k, v in data.items() if isinstance(v, dict)}
            unhealthy = [k for k, v in components.items() if v != "healthy"]
            if unhealthy:
                return LakeCheckResult(StatusEnum.warning,
                                       f"unhealthy components: {', '.join(unhealthy)}",
                                       result.response_time_ms,
                                       {**result.details, "components": components})
        except (json.JSONDecodeError, AttributeError):
            pass
        return result


# 7 shallow stub: 같은 패턴, healthz_path 만 override
class SparkChecker(LakeBaseChecker):
    def healthz_path(self): return "/api/v1/applications"
# ... 동일 패턴

LAKE_CHECKER_REGISTRY: dict[str, type[LakeBaseChecker]] = {
    "airflow":    AirflowChecker,
    "spark":      SparkChecker,
    "iceberg":    IcebergChecker,
    "trino":      TrinoChecker,
    "starrocks":  StarRocksChecker,
    "jupyterlab": JupyterHubChecker,
    "superset":   SupersetChecker,
    "polaris":    PolarisChecker,
}
```

## 6. Service Type Catalog

```python
# 8 서비스 메타. 신규 서비스 추가 시 이 dict + Checker 클래스만 추가.
SERVICE_TYPE_CATALOG = {
    "airflow":    {"label": "Apache Airflow",   "category": "runtime",   "default_path": "/health"},
    "spark":      {"label": "Apache Spark",     "category": "runtime",   "default_path": "/api/v1/applications"},
    "iceberg":    {"label": "Apache Iceberg",   "category": "catalog",   "default_path": "/v1/config"},
    "trino":      {"label": "Trino",            "category": "analytics", "default_path": "/v1/info"},
    "starrocks":  {"label": "StarRocks",        "category": "analytics", "default_path": "/api/health"},
    "jupyterlab": {"label": "JupyterHub",       "category": "analytics", "default_path": "/hub/health"},
    "superset":   {"label": "Apache Superset",  "category": "analytics", "default_path": "/health"},
    "polaris":    {"label": "Apache Polaris",   "category": "catalog",   "default_path": "/api/management/v1/health"},
}
```

## 7. Frontend Component 위계

```
pages/LakeServicesPage.tsx        ← 메인보드
  ├─ ClusterSidebar (iconOnly, allowAll)        — 클러스터 필터
  ├─ Category filter chips (catalog/runtime/analytics)
  ├─ "+ 서비스 등록" 버튼
  └─ 카드 그리드
        └─ LakeServiceCard           — 서비스당 1 카드
              ├─ status badge + dot
              ├─ service_type label + name
              ├─ endpoint_url
              ├─ last_checked_at
              ├─ "지금 점검" 버튼
              └─ 클릭 → /lake-services/:id

pages/LakeServiceDetailPage.tsx    ← 상세
  ├─ Header (back / name / "수정" / "삭제" / "지금 점검")
  ├─ HealthSummary (MacCard)        — 현재 status + last details JSONB pretty
  ├─ TroubleshootGuides (MacCard)   — ServiceEntry kind=guide where service=service_type
  ├─ HistoryTimeline (MacCard)      — LakeServiceCheck + ServiceEntry kind=history merge
  └─ "+ 가이드 작성" / "+ 히스토리 기록" 버튼 (ServiceEntry POST)

components/lake-services/
  ├─ LakeServiceCard.tsx
  ├─ HealthBadge.tsx
  ├─ ServiceTypeIcon.tsx
  ├─ AddLakeServiceModal.tsx
  └─ index.ts (barrel)

hooks/useLakeServices.ts
  ├─ useLakeServices (list, filter)
  ├─ useLakeService (detail)
  ├─ useLakeServiceChecks (history)
  ├─ useLakeServiceTypes (8 types meta)
  ├─ useCreateLakeService
  ├─ useUpdateLakeService
  ├─ useDeleteLakeService
  └─ useRunLakeServiceCheck

types/index.ts (추가)
  ├─ LakeService, LakeServiceInput
  ├─ LakeServiceCheck
  └─ LakeServiceType
```

## 8. Test Plan (간략, QA 단계용)

| Layer | 시나리오 |
|---|---|
| L1 API | 8 endpoint 인증/페이지네이션/audit (이전 사이클 패턴) |
| L2 UI | 메인보드 진입 → 카드 N개 표시, "지금 점검" 클릭 → status 갱신, 상세 진입 → 가이드/히스토리 표시 |
| L3 E2E | 서비스 등록 → 점검 → 가이드 작성 → 다른 사용자 가 같은 가이드 read |

## 9. Module Map (Do phase scope split)

| Module | 파일 | 라인 | Do session |
|---|---|---:|---|
| **M1. Models** | models/lake_service.py | ~80 | session 1 |
| **M2. Schemas** | schemas/lake_service.py | ~80 | session 1 |
| **M3. Migration** | main.py 추가 (테이블+인덱스+seed registry 등록 없음 — type catalog 는 코드 enum) | ~20 | session 1 |
| **M4. Checkers** | services/lake_checkers/ 9 파일 (base+8) | ~400 | session 2 |
| **M5. Router** | routers/lake_services.py | ~280 | session 2 |
| **M6. Router 등록** | routers/__init__.py + main.py | ~10 | session 2 |
| **M7. Frontend types/api/hooks** | types/index.ts + services/api.ts + hooks/useLakeServices.ts | ~150 | session 3 |
| **M8. Frontend pages** | pages/LakeServicesPage.tsx + LakeServiceDetailPage.tsx | ~400 | session 3 |
| **M9. Frontend components** | components/lake-services/* | ~150 | session 3 |
| **M10. App + Sidebar** | App.tsx + Sidebar.tsx | ~15 | session 3 |

총: ~1585 라인 (Plan 한도 1200-1500 살짝 초과 — 합리적 범위)

Recommended Session Plan:
- **Session 1**: Backend foundation (M1+M2+M3) — 모델 + 스키마 + 마이그레이션
- **Session 2**: Backend logic (M4+M5+M6) — checkers + router
- **Session 3**: Frontend (M7+M8+M9+M10)

이번 Do 는 단일 세션으로 모두 진행 (사용자가 "자동 진행" 선택). 메시지 길이 제약 시 backend 먼저 / frontend 나중.
