# Report — LAKE Service Type Management

> 작성일: 2026-05-21
> 최종 Match Rate: **95%** (정적 + lint/tsc PASS)

## Executive Summary

| Perspective | Before | After |
|---|---|---|
| Problem | LAKE service_type 코드 하드코딩 (REGISTRY + CATALOG + Literal) → 신규 OSS 추가 = dev 재배포 | DB-driven LakeServiceType + Settings "LAKE 타입" 탭에서 운영자 self-service add/edit/toggle/delete |
| Solution | 8 builtin static enum | 8 builtin seed (영구 + disable 만) + custom CRUD + GenericHealthzChecker fallback |
| Function UX | LakeServicesPage 등록 모달 = 코드 catalog 만 | DB enabled=true 만 표시 → 실시간 반영. builtin badge + lock icon 으로 readonly 명시 |
| Core Value | **운영자 자율 LAKE 카탈로그 관리** — dev 의존성 ↓ + builtin 안정성 유지 |

### Value Delivered

| 지표 | 값 |
|---|---:|
| Match Rate (정적) | **95%** |
| Lint / TS errors | 0 / 0 |
| Backend 신규 | 4 (model + schema + generic checker + router) |
| Frontend 신규 | 1 (LakeServiceTypeManager) |
| 수정 파일 | 6 (main.py + models/routers __init__ + lake_services.py + lake_checkers/__init__.py + 4 frontend) |
| 신규 endpoint | 6 (GET list/detail + POST + PUT + PATCH toggle + DELETE) |
| 신규 dependency | 0 |
| 총 라인 | ~1000 |

## Plan SC — Final

| # | Criterion | 상태 |
|---|---|:---:|
| SC-1 | builtin 8 seed 자동 + 부팅 로그 | ⚠️ runtime 검증. import OK |
| SC-2 | Settings → "LAKE 타입" 탭 + 8 builtin row + 토글 + "+ 커스텀 추가" | ✅ |
| SC-3 | custom type 추가 → LakeServicesPage 등록 모달 즉시 노출 | ✅ `_invalidateAllLakeTypeQueries` 가 lakeServiceTypeKeys + lakeServiceKeys.types() 둘 다 invalidate |
| SC-4 | custom type → LakeService 등록 → "지금 점검" → GenericHealthzChecker probe | ✅ `build_checker(svc, type.default_path)` |
| SC-5 | builtin 삭제 시도 → 409 + 메시지 | ✅ `_builtin_locked('삭제')` |
| SC-6 | builtin disable → 등록 모달에서 제거, 기존 instance 영향 X | ✅ DB enabled 필터 |
| SC-7 | 사용 중 custom 삭제 시도 → 409 + 사용 수 | ✅ `in_use_count` |
| SC-8 | 6 endpoint 직전 사이클 baseline 충족 | ✅ deps 매핑 OK |

## Key Decisions

| Decision | 선택 | Rationale |
|---|---|---|
| Option C (Pragmatic) | 신규 1 모델 + builtin REGISTRY + Generic fallback | Plan 한도 정합, 백워드 호환 |
| builtin 영구 삭제 X | enable=false 만 | 코드 회귀 방지, 운영자 안전 |
| Generic HTTP probe | 사용자 D2 선택 | dynamic import 보안 위험 회피 |
| Settings 신규 탭 | 사용자 D4 선택 | UI 명확 구분 |
| build_checker() 헬퍼 | 신규 함수 | router 가 builtin/custom 단일 코드 경로 |

## Changes Summary

### Backend (4 신규 + 5 수정)
- `models/lake_service_type.py` NEW (~80)
- `schemas/lake_service_type.py` NEW (~110)
- `services/lake_checkers/generic.py` NEW (~30)
- `services/lake_checkers/__init__.py` MOD (build_checker 추가)
- `routers/lake_service_types.py` NEW (~250)
- `routers/lake_services.py` MOD (list_service_types + create + _run_check DB-driven)
- `routers/__init__.py` / `models/__init__.py` / `main.py` MOD (register + seed 함수 + 리스트 등록)

### Frontend (1 신규 + 3 수정)
- `components/settings/LakeServiceTypeManager.tsx` NEW (~370)
- `types/index.ts` MOD (LakeServiceTypeRow/Input/Update/ListResponseRows)
- `services/api.ts` MOD (lakeServiceTypesApi 6 method)
- `hooks/useLakeServices.ts` MOD (Row 조회 + 4 mutation hooks)
- `pages/SettingsPage.tsx` MOD (TabId 확장 + lake-types 탭 + 본문 분기)

## 사용자 직접 실행

```powershell
cd C:\dev_env\devops_management
docker-compose restart backend
docker-compose logs backend | Select-String "seeded.*builtin lake service|lake_service_types"
# 기대: "seeded 8 builtin lake service types"

# 브라우저
# 1) /settings → "LAKE 타입" 탭 클릭
# 2) 8 builtin row 표시 (badge=builtin, delete 비활성)
# 3) enabled 토글 → LakeServicesPage 등록 모달 select 즉시 반영
# 4) "+ 커스텀 추가" → kafka 같은 신규 type 추가
# 5) /lake-services → 등록 모달에 kafka 표시 → 등록 → 지금 점검 → GenericHealthzChecker probe
```

## Carry-Over
- `lake-type-icon-picker` (lucide 아이콘 시각 선택)
- `lake-custom-probe-plugin` (Python Probe dynamic loading)
- `lake-type-import-export` (JSON 마이그레이션)
