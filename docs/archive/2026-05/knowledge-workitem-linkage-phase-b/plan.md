# knowledge-workitem-linkage-phase-b Planning Document

> **Summary**: WorkItem.component 컬럼 + service별 enum + 마이그레이션 — Phase A(cross-view) 위에 component 차원 추가
>
> **Project**: devops_management
> **Branch**: feature/home-v2
> **Date**: 2026-05-20
> **Status**: Confirmed (Phase A archive plan §2.1 Phase B 항목 + Q4 확정 후)
> **Upstream**: [`docs/archive/2026-05/knowledge-workitem-linkage/plan.md`](../../archive/2026-05/knowledge-workitem-linkage/plan.md)

---

## Executive Summary

| Perspective | Content |
|---|---|
| **Problem** | Phase A 가 service 단위 cross-view 만 구현. component(api-server/scheduler 등) 정밀 분류 부재 → "k8s 의 api-server 문제만 모아 보기" 같은 운영 동선 불가 |
| **Solution** | (1) WorkItem.component nullable 컬럼 + index, (2) COMPONENT_BY_SERVICE constant (service별 component enum), (3) WorkItemForm service↔component cascade dropdown, (4) module → service 자동 backfill (idempotent) |
| **Function/UX Effect** | 신규 업무 등록 시 service 선택 후 그 서비스의 component dropdown 자동 활성화. 기존 work_items 의 module 값이 service 로 자동 복사되어 Phase C 의 chip 필터링 준비 |
| **Core Value** | "Phase A 가 통합한 view 안에서 정밀 좌표로 좁히기" — Phase C drill-down 의 데이터 기반 마련 |

---

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | service 단위는 너무 광범위 — k8s 만 해도 6+ core component 가 있어 운영자가 "어디서 발생/작업했는지" 즉시 알 수 없음 |
| **WHO** | DevOps 파트원 — 특히 k8s/cilium 같은 대형 service 의 component 별 운영자 |
| **RISK** | (1) module → service 자동 매핑이 안 맞는 케이스 (backend/frontend module 은 service 가 아님). (2) component dropdown 의 enum 이 운영 현실과 안 맞으면 자주 수정. (3) backfill 이 idempotent 하지 않으면 재시작 시 중복 적용 |
| **SUCCESS** | (A) `work_items.component` 컬럼이 DB 에 존재 + index 적용. (B) 신규 work_item 등록 시 service 의 component 선택 가능. (C) 기존 work_items 의 module 값이 service 로 자동 backfill 됨 (backend/frontend 제외). (D) 회귀 없음 — MemberBoardPage/WorkflowBoardPage 의 module 사용 보존. (E) backfill 재시작 idempotent — 두 번 돌아도 결과 동일 |
| **SCOPE** | B1: model 컬럼 / B2: migration / B3: schema+router / B4: COMPONENT_BY_SERVICE / B5: type 정의 / B6: Form cascade / B7: backfill |

---

## 1. Overview

### 1.1 Purpose

Phase A 의 cross-view 위에 **component 정밀 좌표** 를 추가한다. 사용자가 새 업무를 등록할 때 service 만 고르면 그 서비스의 component 후보가 자동 노출되고, 기존 데이터도 backfill 로 component 차원에 합류한다. Phase C(필터 chip)은 이 컬럼이 채워져 있어야 의미가 있다.

### 1.2 Background

- Phase A archive (`docs/archive/2026-05/knowledge-workitem-linkage/`) 에서 component 도입은 의도된 이월.
- Q4 합의 (2026-05-20): (1) module 보존 + legacy 표기, (2) backfill 자동 매핑 (monitoring→prometheus, infra→etcd, 나머지 1:1, backend/frontend 제외), (3) Form cascade 시 service 변경 → component 자동 reset.
- 기존 model `WorkItem` (backend/app/models/work_item.py) 에 service(String 64) + module(String 50) 둘 다 있음 — Q1 에서 합의된 동시 보존 정책.

### 1.3 Related Documents

- Phase A archive: `docs/archive/2026-05/knowledge-workitem-linkage/plan.md` §2.1 Phase B
- 데이터 모델: `backend/app/models/work_item.py` L47 (service) + L56 (module)
- 서비스 카탈로그: `frontend/src/components/services/serviceCatalog.ts` L24-38

---

## 2. Scope

### 2.1 In Scope

- **B1**: `backend/app/models/work_item.py` 에 `component = Column(String(64), nullable=True, index=True)` 추가.
- **B2**: `backend/app/main.py:_run_migrations()` 에 `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS component VARCHAR(64)` + `CREATE INDEX IF NOT EXISTS ix_work_items_component`.
- **B3**: `backend/app/schemas/work_item.py` (또는 work_items.py 안의 스키마) + 라우터의 create/update 에 component 필드 노출. CSV export 에도 추가.
- **B4**: `frontend/src/components/services/serviceCatalog.ts` 에 `COMPONENT_BY_SERVICE: Record<string, readonly string[]>` 추가. service 별 초기 enum (k8s/keycloak/nexus/jenkins/argocd/cilium/prometheus/grafana/etcd/hubble/ingress/storage/other).
- **B5**: `frontend/src/types/index.ts` 의 `WorkItem` + `WorkItemCreate` + `WorkItemUpdate` 에 `component?: string` 추가.
- **B6**: `frontend/src/components/work-items/WorkItemForm.tsx` 에 component dropdown — service select 옆 또는 아래. service 변경 시 component state reset.
- **B7**: `backend/app/main.py` 에 `_backfill_work_items_service_from_module()` 함수. startup 시 1회성 호출. idempotent: `WHERE service IS NULL AND module IS NOT NULL` 조건. 매핑 규칙:
  - `module = 'monitoring'` → `service = 'prometheus'`
  - `module = 'infra'` → `service = 'etcd'`
  - `module IN ('backend', 'frontend')` → 건너뜀 (service 가 아님)
  - 그 외 → `service = module` (k8s↔k8s 등 1:1 복사)
- **B8** (추가): WorkItemForm 의 module 라벨에 `(legacy)` 표기 — 사용자에게 점진적 deprecation 신호.

### 2.2 Out of Scope

- module 컬럼 제거 — 별도 후속 PR(`refactor: deprecate WorkItem.module`).
- backfill 실패 케이스의 수동 정정 UI(`/settings/work-item-migration`) — Phase C 이후 결정.
- COMPONENT_BY_SERVICE 의 ui_settings 화 — 안정화 후.
- Phase C 의 KnowledgeHub/WorkItemBoard chip 필터 — 다음 사이클.

---

## 3. Requirements

### 3.1 Functional Requirements

- **FR-1**: `WorkItem.component` 는 nullable + index. `Column(String(64), nullable=True, index=True)`.
- **FR-2**: 신규 work_item 등록 시 service 가 있으면 component 선택 가능, 없으면 component 입력 차단. service=null 일 때 component 도 null 강제.
- **FR-3**: WorkItemForm 의 service select 변경 시 component state 가 자동 reset (이전 값 잔존 방지).
- **FR-4**: component dropdown 은 COMPONENT_BY_SERVICE[service] 의 옵션만 보여주되 "직접 입력" 옵션 1개도 허용 (운영 중 누락된 component 입력 대비).
- **FR-5**: backfill 은 idempotent. 동일 명령 N회 실행 시 결과 동일. `WHERE service IS NULL AND module IS NOT NULL` 조건이 핵심.
- **FR-6**: backfill 결과 로깅 — startup log 에 "N rows backfilled (module→service)" 출력.

### 3.2 Non-Functional Requirements

- **NFR-1**: ALTER TABLE + 인덱스 생성이 production DB 에서 < 5초.
- **NFR-2**: backfill SQL 은 단일 트랜잭션 내 UPDATE — 부분 적용 방지.
- **NFR-3**: lint + tsc + python syntax 통과 (회귀 0).
- **NFR-4**: WorkItemForm cascade 동작이 즉시 (input lag 없음) — useEffect chain 으로 깔끔하게.

### 3.3 Compatibility

- `module` 컬럼 유지 — MemberBoardPage 의 `bucket.tasks = filter(w => w.type === 'task' …)` 가 module 을 직접 안 쓰지만 다른 곳에서 사용 가능성.
- 기존 work_items 의 module 값은 그대로 보존, 추가로 service 가 자동 채워짐.
- WorkItemForm 의 module 입력은 유지하되 라벨에 "(legacy)" 표기 — 사용자 입력 흐름은 안 깨짐.

---

## 4. Success Criteria

| ID | 기준 | 측정 |
|---|---|---|
| SC-1 | `work_items.component` 컬럼이 DB 에 존재 + index 적용 | `\d work_items` 또는 information_schema 쿼리 |
| SC-2 | 신규 work_item POST 시 component 필드 전송 → DB 에 저장 | curl POST + GET 확인 |
| SC-3 | WorkItemForm 에서 service 변경 → component dropdown 옵션이 즉시 갱신 | 수동 |
| SC-4 | backfill: 기존 module='k8s' 인 work_items 의 service 가 'k8s' 로 채워짐 | DB 쿼리 |
| SC-5 | backfill: module='backend' 또는 'frontend' 인 행은 service 변경 없음 (자동 매핑 skip) | DB 쿼리 |
| SC-6 | backfill idempotent: 백엔드 재시작 후에도 결과 동일 | restart × 2 후 카운트 비교 |
| SC-7 | lint + tsc + python syntax | CI |
| SC-8 | MemberBoardPage/WorkflowBoardPage 회귀 없음 | 수동 |

---

## 5. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | ALTER TABLE 이 production 의 큰 work_items 테이블에서 lock | 현재 데이터 크기 < 1000 행이라 < 1초. `ADD COLUMN IF NOT EXISTS` 는 metadata-only — non-blocking |
| R-2 | backfill 이 중복 적용되어 service 가 잘못 덮어쓰임 | `WHERE service IS NULL` 조건 — 이미 채워진 행은 건드리지 않음 |
| R-3 | COMPONENT_BY_SERVICE 초기 enum 이 부족 | "직접 입력" 옵션으로 escape hatch |
| R-4 | WorkItemForm cascade 의 useEffect 가 무한 루프 | component reset 은 service prevState 비교 후만 실행 |

---

## 6. Timeline

| 단계 | 작업 | 소요 |
|---|---|---|
| Design | 3 architecture option + Component Specs | 30분 |
| Do | B1-B8 구현 | 1-2시간 (한 세션) |
| Analyze | self gap-check | 15분 |
| Report+Archive | 문서 종료 + 이동 | 15분 |

**총 ~3시간** — Phase A 와 동일한 1-session 자율 진행 패턴.

---

## 7. PDCA Next Steps

`/pdca design knowledge-workitem-linkage-phase-b` → Pragmatic option 자율 채택 → `/pdca do` (자율) → analyze → report → archive.
