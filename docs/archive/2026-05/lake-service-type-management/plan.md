# Plan — LAKE Service Type Management (Settings EDIT)

> 작성일: 2026-05-21
> 직전 사이클: lake-service-knowledge-seed (mini, archived)
> 기반: lake-service-monitoring (95%, archived) — 8 builtin service_type 의 코드 카탈로그

## Executive Summary

| Perspective | Statement |
|---|---|
| **Problem** | LAKE 서비스 type 카탈로그 (현재 8개: airflow/spark/iceberg/trino/starrocks/jupyterlab/superset/polaris) 가 코드에 하드코딩 (`SERVICE_TYPE_CATALOG`, `LAKE_CHECKER_REGISTRY`, `ServiceType` Literal). 신규 OSS 추가 = dev 가 코드 변경 + 재배포 — 운영자 자율성 0. 환경별 사용 안 하는 type 비활성화도 불가. |
| **Solution** | DB-driven `LakeServiceType` 모델 신설 + Settings 신규 탭 "LAKE 타입" — 8 builtin 은 자동 seed + disable 만 가능 (영구 삭제 X), custom type 은 add/edit/delete 자유. Custom type 의 health check 는 GenericHealthzChecker (HTTP GET healthz_path) 가 처리 — deep check 필요 시 dev 가 추가 |
| **Function UX Effect** | 운영자가 Settings → "LAKE 타입" 진입 → 8 builtin 토글 + 커스텀 type 추가 (label/category/default_path/description/icon). LakeServicesPage 의 등록 모달은 enabled type 만 표시 — 자연 필터 |
| **Core Value** | **LAKE 카탈로그 운영자 자율 관리** — 신규 OSS 도입 시 dev 의존성 ↓. Builtin 안정성 (영구 삭제 X) + custom 유연성 (generic probe) 균형 |

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | lake-service-monitoring 사이클이 "신규 서비스 추가 = 코드 1 클래스 + REGISTRY 1줄 + CATALOG 1 entry" 패턴 도입 — Plan SC-4. 운영자 self-service 화로 진화. |
| **WHO** | DevOps lead — 신규 OSS 검토 + LAKE 카탈로그 큐레이션. operator role 이상만 mutating. |
| **RISK** | (a) builtin 카탈로그가 DB-driven 으로 바뀌면서 기존 LakeService 인스턴스 (service_type=airflow) 의 무결성 깨질 위험. (b) custom type 의 generic checker 가 deep insight 못 줌 — 사용자 기대 mismatch 가능. (c) UI 카탈로그 list 가 frontend 매번 fetch — staleTime 관리 필요 |
| **SUCCESS** | Settings 탭 1-click 추가, 8 builtin seed idempotent, LakeServicesPage 등록 모달이 enabled 만 표시, custom type 으로 등록한 LakeService 가 GenericHealthzChecker 로 정상 health check, 직전 사이클 baseline (인증/페이지네이션/audit/error code dict) 충족 |
| **SCOPE** | (in) LakeServiceType 모델 + seed + 5 endpoint + Settings 탭 + GenericHealthzChecker + frontend 토글/CRUD. (out) icon picker (lucide 아이콘 string 입력만), validation rule (URL format / category enum 만), import/export, custom Probe class dynamic loading |

## 1. Requirements

### FR (Functional)

- FR-1. **LakeServiceType 모델** — service_type (PK slug, unique), label, category (catalog/runtime/analytics), default_path, description, icon (lucide name string), is_builtin (bool), enabled (bool, default true), sort_order, timestamps
- FR-2. **Builtin seed** — backend 부팅 시 8 builtin (airflow/spark/...) 자동 등록 (is_builtin=true, enabled=true). 이미 존재하면 skip
- FR-3. **list endpoint** — `GET /lake-service-types?enabled=true|false` (필터). 인증 `get_current_user`
- FR-4. **create custom** — `POST /lake-service-types` — operator. `is_builtin=false` 강제 (운영자가 builtin 못 만듦)
- FR-5. **update** — `PUT /lake-service-types/{id}` — label/category/default_path/description/icon/enabled/sort_order. service_type slug 변경 불가
- FR-6. **delete** — `DELETE /lake-service-types/{id}` — builtin 차단 (HTTP 409). 사용 중 instance 있으면 차단 (409 + 사용 instance 수)
- FR-7. **toggle enabled** — `PATCH /lake-service-types/{id}/enabled` (편의 endpoint)
- FR-8. **기존 `GET /lake-services/types`** — DB 의 enabled=true 만 반환 (현재 코드 catalog 반환 → 변경)
- FR-9. **GenericHealthzChecker** — builtin REGISTRY 에 없는 service_type 은 fallback. healthz_path 는 type.default_path 사용
- FR-10. **Settings "LAKE 타입" 탭** — list (builtin badge + enabled toggle + edit/delete) + "+ 커스텀 추가" 모달
- FR-11. **LakeServicesPage 등록 모달** — types API 결과 (enabled only) 만 select 옵션. 변경 없음 (이미 useLakeServiceTypes 사용)

### NFR

- NFR-1. **인증/audit**: 직전 사이클 baseline. mutating require_operator + audit_logger
- NFR-2. **백워드 호환**: 기존 LakeService 인스턴스 영향 0 (service_type 컬럼 그대로, DB type row 만 추가)
- NFR-3. **idempotent seed**: 두 번째 부팅 시 builtin 중복 X
- NFR-4. **builtin 보호**: delete 시 409, edit 시 일부 필드만 (enabled/sort_order 만 운영자 수정 가능, label/category/default_path 는 builtin = readonly)
- NFR-5. **UX 표준**: MacCard / ConfirmDialog / dark mode / error state
- NFR-6. **frontend type 안전**: LakeServiceType Literal → string 확장 (Literal 폐기 또는 builtin-only Literal 유지 + custom string 분기)

## 2. Success Criteria

| # | Criterion |
|---|---|
| SC-1 | backend 재시작 시 8 builtin 자동 seed (is_builtin=true, enabled=true) + 부팅 로그 |
| SC-2 | Settings → "LAKE 타입" 탭 진입 → 8 builtin row + 토글 + "+ 커스텀 추가" 버튼 |
| SC-3 | 커스텀 type 추가 (예: kafka) → LakeServicesPage 등록 모달 select 에 즉시 노출 |
| SC-4 | 커스텀 type 으로 LakeService 인스턴스 등록 → "지금 점검" → GenericHealthzChecker 가 default_path GET probe → status 갱신 |
| SC-5 | builtin type 삭제 시도 → 409 + "builtin 은 삭제할 수 없습니다" |
| SC-6 | enabled=false 토글한 builtin → 등록 모달 select 에서 사라짐. 기존 인스턴스는 영향 X |
| SC-7 | 사용 중인 custom type 삭제 시도 → 409 + 사용 instance 수 표시 |
| SC-8 | 5 endpoint 직전 사이클 baseline (인증/페이지네이션/audit/error code dict) 충족 |

## 3. Constraints

- C-1. 정적 분석 only (이전 사이클 동일)
- C-2. 신규 dependency 0
- C-3. ServiceEntry / LakeService / LakeServiceCheck 모델 변경 X
- C-4. ICON_MAP (ServiceTypeIcon.tsx) — string 매핑은 그대로, 미매칭 시 Database fallback (이미 동작)
- C-5. ServiceType Pydantic Literal → str (느슨하게) — backend 검증은 DB 존재 여부로

## 4. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 기존 8 코드 카탈로그 vs DB seed 불일치 | Med | seed 의 8 entry 와 builtin REGISTRY 매핑 명시 — 코드 import 가 truth source |
| `GET /lake-services/types` 변경으로 frontend 호환성 | Low | 응답 shape 동일 (`LakeServiceTypeInfo`). enabled 필드만 추가 (optional) |
| Custom type 의 generic probe 가 사용자 기대 못 미침 | Med | UI 에 "Generic HTTP probe" 명시 + deep check 는 dev 가 추가 안내 |
| Pydantic Literal 제거로 type 검증 약화 | Low | router 가 DB 조회로 검증 (UNKNOWN_SERVICE_TYPE 동일 패턴) |
| builtin REGISTRY (코드) 와 DB row mismatch (운영자가 DB 직접 조작 시) | Low | seed 가 매번 보완. UI 에서는 직접 조작 불가 |

## 5. Out of Scope (Carry-Over)

- `lake-type-icon-picker` — Settings 에서 lucide 아이콘 시각 선택 UI
- `lake-custom-probe-plugin` — 운영자가 Python Probe 클래스 import path 등록 (dynamic loading)
- `lake-type-import-export` — JSON export/import (마이그레이션용)
- `lake-type-rbac` — viewer 가 type list 읽기 권한

## 6. Phase 계획

| Phase | 산출물 | 예상 |
|---|---|---|
| 1. Plan (현재) | 본 문서 | ✅ |
| 2. Design | 3-arch 비교 + Module Map | ~5분 |
| 3. Do | backend (~400줄) + frontend (~350줄) | ~30분 |
| 4. Check (self) | 4-axis | ~5분 |
| 5. Iterate (필요 시) | lint/tsc 픽스 | — |
| 6. Report + QA + Archive + Commit + Push | 직전 사이클 패턴 | ~15분 |

총: ~1시간. lake-service-monitoring (1700줄) 의 절반 수준.
