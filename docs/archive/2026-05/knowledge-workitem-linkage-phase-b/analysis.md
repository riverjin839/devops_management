# knowledge-workitem-linkage-phase-b Analysis (self-check)

> **Date**: 2026-05-20
> **Method**: Self gap-check against Plan + Design (자율 모드)

## Strategic Alignment

| Plan Goal | Implementation Evidence | Status |
|---|---|---|
| service 단위 → component 정밀 좌표 도입 | model + schema + Form cascade dropdown 모두 적용 | ✅ |
| 기존 데이터 보존 + 자동 backfill | _backfill_work_items_service_from_module() 함수 idempotent | ✅ |
| Phase C 의 chip 필터링 데이터 기반 마련 | component 컬럼 + COMPONENT_BY_SERVICE constant 준비 완료 | ✅ |

## Plan Success Criteria

| ID | 기준 | 상태 | 증거 |
|---|---|---|---|
| SC-1 | work_items.component 컬럼 + index | ✅ Met (코드 레벨) | models/work_item.py:53 + main.py ALTER + CREATE INDEX IF NOT EXISTS |
| SC-2 | 신규 POST 시 component 저장 | ✅ Met | schemas WorkItemBase + serialize() 추가 + payload 매핑 |
| SC-3 | Form service 변경 → component dropdown 즉시 갱신 | ✅ Met | WorkItemForm onChange — setService + setComponent('') + setComponentCustom('') |
| SC-4 | backfill: module='k8s' → service='k8s' | ✅ Met (코드 레벨) | main.py CASE 분기, ELSE module 절 |
| SC-5 | backfill: backend/frontend 행 service 변경 없음 | ✅ Met (코드 레벨) | WHERE module NOT IN ('backend', 'frontend') |
| SC-6 | backfill idempotent | ✅ Met | WHERE service IS NULL 조건 |
| SC-7 | lint + tsc | ✅ Met | tsc exit 0, lint max-warnings 0 통과 |
| SC-8 | MemberBoard/WorkflowBoard 회귀 없음 | ✅ Met | 두 페이지 변경 0, module 컬럼 보존 |

**Match Rate**: **8/8 = 100%** (코드 레벨 — runtime 검증은 docker-compose 환경에서)

## Decision Record Verification

| AD | Decision | Followed? |
|---|---|---|
| AD-1 | String(64) + nullable + index | ✅ models/work_item.py:53 + CREATE INDEX |
| AD-2 | COMPONENT_BY_SERVICE frontend constant | ✅ serviceCatalog.ts |
| AD-3 | 직접 입력 escape hatch | ✅ '__custom__' 옵션 + input |
| AD-4 | main.py startup backfill, idempotent | ✅ _backfill_work_items_service_from_module() + _safe_add_column 직후 호출 |
| AD-5 | module 보존 + Form "(legacy)" | ✅ label 에 (legacy) 추가 |
| AD-6 | component 필터링은 Phase C 외 | ✅ chip 필터 미구현 (의도) |

## Gap List

| ID | Sev | 갭 |
|---|---|---|
| g1 | Minor | "직접 입력" 모드의 componentCustom 이 trim 안 되어 공백 허용. payload 빌드 시 trim 적용은 있음 |
| g2 | Minor | backfill 로깅이 INFO 라 production 부팅 시 1줄. 카운트 추적용 |

Critical/Important 없음. Runtime 검증은 다음 backend 부팅 시 자동 — `_log.info("backfill: %s rows ...")` 라인이 보이면 성공.
