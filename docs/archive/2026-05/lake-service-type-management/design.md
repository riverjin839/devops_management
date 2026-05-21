# Design — LAKE Service Type Management (As-To-Be)

> Plan: `docs/01-plan/features/lake-service-type-management.plan.md`
> 선택: **Option C (Pragmatic)** — 신규 1 모델 + 기존 REGISTRY 차용 + Generic fallback

## Context Anchor (Plan 복사본)

| Key | Value |
|---|---|
| WHY | LAKE 카탈로그 운영자 자율 관리 + 신규 OSS 도입 시 dev 의존성 ↓ |
| WHO | DevOps lead (operator role 이상) |
| RISK | Builtin DB seed vs REGISTRY 불일치, custom generic checker 한계 |
| SUCCESS | Settings 탭 + 8 builtin seed + custom CRUD + Generic checker + Enterprise baseline |
| SCOPE | LakeServiceType 모델 + 5 endpoint + Settings 탭 + GenericHealthzChecker |

## 1. Architecture 3-Option

| 항목 | A. Minimal (Literal+enabled 토글만) | B. Clean (LakeServiceType + LakeProbeRegistry 2 모델) | **C. Pragmatic** |
|---|---|---|---|
| 모델 | LakeService 에 `disabled_types` JSONB 컬럼 | 2 모델 (Type + ProbeBinding) | LakeServiceType 1 모델 |
| Custom 지원 | ❌ | ✅ + binding | ✅ generic checker |
| Probe 매핑 | REGISTRY 그대로 | DB binding | REGISTRY (builtin) + GenericHealthzChecker (custom fallback) |
| Frontend | 토글만 | 큰 UI | 토글 + CRUD modal |
| 예상 라인 | ~200 | ~1200 | **~750** |
| Plan 한도 | ❌ 너무 작음 | ❌ 초과 | ✅ |

→ **Option C** — PRD 4 결정 정합.

## 2. As-To-Be 구조

```
┌─────────────────────────────────────────────────────────────┐
│   Frontend                                                  │
│   /settings (기존) ─ 신규 탭 "LAKE 타입"                     │
│   └─ components/settings/LakeServiceTypeManager.tsx         │
│       ├─ list (8 builtin + N custom) — builtin badge        │
│       ├─ enabled toggle (builtin/custom 동일)               │
│       ├─ edit (builtin: enabled/sort_order 만 / custom: all)│
│       ├─ delete (builtin 차단 / custom: 사용 instance 체크) │
│       └─ "+ 커스텀 추가" modal                              │
│                                                             │
│   /lake-services (기존) ── AddLakeServiceModal              │
│   └─ useLakeServiceTypes() — enabled=true 자동 필터         │
└─────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────┐
│   Backend                                                   │
│                                                             │
│   routers/lake_service_types.py (신규)                      │
│   - GET    /lake-service-types?enabled=...                  │
│   - POST   /lake-service-types          (custom 만)         │
│   - PUT    /lake-service-types/{id}                         │
│   - DELETE /lake-service-types/{id}     (builtin/사용중 차단)│
│   - PATCH  /lake-service-types/{id}/enabled                 │
│                                                             │
│   routers/lake_services.py (수정)                           │
│   - GET /lake-services/types → DB enabled=true 조회         │
│                                                             │
│   services/lake_checkers/__init__.py (수정)                 │
│   - get_checker_class(svc_type, default_path) →             │
│     builtin REGISTRY hit ? 기존 : GenericHealthzChecker     │
│                                                             │
│   services/lake_checkers/generic.py (신규)                  │
│   - GenericHealthzChecker(healthz_path 동적)                │
│                                                             │
│   models/lake_service_type.py (신규)                        │
│   main.py - _seed_default_lake_service_types() 추가         │
└─────────────────────────────────────────────────────────────┘
```

## 3. Data Model

```python
class LakeServiceType(Base):
    __tablename__ = "lake_service_types"
    __table_args__ = (
        Index("ix_lake_types_enabled", "enabled"),
        Index("ix_lake_types_sort", "sort_order"),
    )
    id            = Column(UUID, primary_key=True, default=uuid.uuid4)
    service_type  = Column(String(32), nullable=False, unique=True)  # slug
    label         = Column(String(100), nullable=False)
    category      = Column(String(20), nullable=False)  # catalog|runtime|analytics|other
    default_path  = Column(String(255), nullable=False)
    description   = Column(Text, nullable=True)
    icon          = Column(String(64), nullable=True)   # lucide-react component name
    is_builtin    = Column(Boolean, nullable=False, default=False, server_default="false")
    enabled       = Column(Boolean, nullable=False, default=True,  server_default="true")
    sort_order    = Column(Integer, nullable=False, default=100,    server_default="100")
    created_at    = Column(DateTime, default=datetime.utcnow, server_default=func.now())
    updated_at    = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, server_default=func.now())
```

## 4. API Matrix

| Endpoint | Verb | Auth | Audit |
|---|---|---|:---:|
| `/lake-service-types` | GET | get_current_user | — |
| `/lake-service-types/{id}` | GET | get_current_user | — |
| `/lake-service-types` | POST | require_operator | `lake_type.create` |
| `/lake-service-types/{id}` | PUT | require_operator | `lake_type.update` |
| `/lake-service-types/{id}/enabled` | PATCH | require_operator | `lake_type.toggle` |
| `/lake-service-types/{id}` | DELETE | require_operator | `lake_type.delete` |
| `/lake-services/types` (기존) | GET | get_current_user | — | (DB 조회로 수정) |

## 5. GenericHealthzChecker

```python
class GenericHealthzChecker(LakeBaseChecker):
    """Custom service_type 의 fallback — DB type 의 default_path 동적 사용."""
    def __init__(self, service: LakeService, healthz_path: str):
        super().__init__(service)
        self._path = healthz_path
    def healthz_path(self) -> str:
        return self._path
```

`get_checker_class` 가 builtin REGISTRY hit 면 기존 클래스, miss 면 GenericHealthzChecker 인스턴스 (healthz_path 주입) 반환. router 가 type DB row 조회 → default_path 추출 → checker instantiate.

## 6. Frontend Component

```
components/settings/LakeServiceTypeManager.tsx (~250)
  ├─ Header + "+ 커스텀 추가" 버튼
  ├─ Table
  │   ├─ icon + service_type slug + builtin badge
  │   ├─ label (편집)
  │   ├─ category (편집 — select)
  │   ├─ default_path (편집 — input)
  │   ├─ enabled toggle
  │   ├─ sort_order (편집 — number)
  │   └─ edit / delete (builtin: edit limited, delete disabled)
  ├─ AddCustomLakeTypeModal (신규 추가)
  └─ ConfirmDialog (삭제)

hooks/useLakeServiceTypes.ts (mutation 추가)
  ├─ useCreateLakeServiceType
  ├─ useUpdateLakeServiceType
  ├─ useDeleteLakeServiceType
  └─ useToggleLakeServiceType
```

## 7. Module Map (Do split)

| Module | 파일 | 라인 |
|---|---|---:|
| M1. Model + Schema | `models/lake_service_type.py` + `schemas/lake_service_type.py` + `models/__init__.py` | ~150 |
| M2. Seed | `main.py` `_seed_default_lake_service_types()` + 리스트 등록 | ~80 |
| M3. Generic Checker | `services/lake_checkers/generic.py` + `__init__.py` 변경 | ~80 |
| M4. Router | `routers/lake_service_types.py` + `routers/__init__.py` + `main.py` 등록 | ~250 |
| M5. lake_services.py 수정 | `list_service_types` DB 조회로 | ~30 |
| M6. Frontend types + api + hooks | types/api/useLakeServiceTypes mutation | ~120 |
| M7. SettingsPage 탭 | SettingsPage.tsx 신규 탭 + LakeServiceTypeManager import | ~30 |
| M8. LakeServiceTypeManager | `components/settings/LakeServiceTypeManager.tsx` + 모달 | ~250 |

총: ~990 라인. Plan 한도 750 ± 30% 정합 (custom modal 포함하면 약간 상회 가능).

## 8. 다음 — Do
Backend (M1-M5) 먼저, Frontend (M6-M8) 그 다음.
