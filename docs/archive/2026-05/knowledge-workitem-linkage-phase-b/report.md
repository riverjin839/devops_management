# knowledge-workitem-linkage-phase-b Report

> **Date**: 2026-05-20
> **Status**: PDCA cycle 자율 완료
> **Match Rate**: 100% (코드 레벨) — runtime 검증은 docker-compose 환경에서 자동

## Executive Summary

| Perspective | Content |
|---|---|
| **Problem** | Phase A 는 service 단위 cross-view 만. component(api-server/scheduler 등) 정밀 좌표 부재 |
| **Solution** | WorkItem.component nullable + index 컬럼 + COMPONENT_BY_SERVICE constant + Form cascade + idempotent backfill |
| **Function/UX Effect** | service 선택 → component dropdown 즉시 활성화. 기존 work_items 의 module 값이 service 로 자동 backfill |
| **Core Value** | Phase C(필터 chip) 의 데이터 기반 완성. service+component 2단계 좌표로 운영 정밀도 ↑ |

### Value Delivered

| Perspective | Before | After |
|---|---|---|
| **분류 정밀도** | service 12개 단위만 | service 12개 × 각 service 4-7 component = 60+ 좌표 |
| **신규 입력 UX** | service 만 자유 입력 | service↔component cascade dropdown + 직접 입력 escape |
| **기존 데이터 활용** | module 만 있고 service 빈 행이 다수 | backfill 자동 — k8s↔k8s, monitoring→prometheus, infra→etcd, backend/frontend 제외 |
| **Phase C 준비도** | chip 필터 만들 데이터 없음 | service+component 양쪽 채워진 행으로 filter 가능 |

## Key Decisions

| Q/AD | Decision | Outcome |
|---|---|---|
| Q4 (Plan) | module 컬럼 보존 + "(legacy)" 표기 | 사용자가 점진적 deprecation 신호 받음 |
| Q4 (Plan) | backfill 자동 매핑 (monitoring→prometheus 등) | 1회 부팅으로 기존 데이터 흡수 |
| Q4 (Plan) | Form cascade service 변경 시 component reset | 이전 값 잔존 방지 |
| Design Option | C (Pragmatic) — model + constant + 인라인 cascade | hooks 분리는 Phase C 까지 미룸 |

## 산출물

### 신규 / 수정
- `backend/app/models/work_item.py` (+3 lines) — component column
- `backend/app/schemas/work_item.py` (+3 lines) — Base + Update
- `backend/app/main.py` (+30 lines) — _backfill_work_items_service_from_module 함수 + migration trigger
- `backend/app/routers/work_items.py` (+5 lines) — serialize() + CSV header/row
- `frontend/src/components/services/serviceCatalog.ts` (+30 lines) — COMPONENT_BY_SERVICE + getComponentsForService
- `frontend/src/types/index.ts` (+5 lines) — WorkItem/Create/Update 에 component
- `frontend/src/components/work-items/WorkItemForm.tsx` (+50 lines) — state + cascade + UI

### 문서
- `docs/01-plan/features/knowledge-workitem-linkage-phase-b.plan.md`
- `docs/02-design/features/knowledge-workitem-linkage-phase-b.design.md`
- `docs/03-analysis/knowledge-workitem-linkage-phase-b.analysis.md`
- `docs/04-report/knowledge-workitem-linkage-phase-b.report.md` (this)

## Lessons Learned

- **Idempotent migration 의 가치**: `_safe_add_column` + `WHERE service IS NULL` 조건으로 backfill 이 재시작 안전. Phase B 의 runtime 검증을 docker-compose 환경에 위임 가능.
- **escape hatch (직접 입력)**: enum 의 초기 부족함을 보완. 운영 중 누락된 component 발견 시 사용자가 직접 입력 → enum 확장 시 자동 흡수.
- **legacy 표기**: 컬럼을 즉시 제거하지 않고 라벨에 "(legacy)" 표기만 해도 사용자에게 충분한 신호. 별도 PR 의 deprecation 부담 감소.

## Carry Items → Phase C

- KnowledgeHubPage 의 service / component / typeLabel chip 행 (FR-3 AND 결합)
- WorkItemBoardPage 에 service+component 필터
- KnowledgeHubPage 의 `if (i.type !== 'issue') continue` 제거 — 모든 WorkItem type 통합
- ServiceEntry 를 KnowledgeHubPage 의 6번째 kind 로 추가
- backend work_items 에 ?service= / ?component= 쿼리 파라미터 추가 (frontend filter → server filter 전환)

다음 명령: `/pdca plan knowledge-workitem-linkage-phase-c`
