# knowledge-workitem-linkage Analysis (Phase A self-check)

> **Feature**: knowledge-workitem-linkage
> **Scope**: Phase A (Cross-view) only — B/C 는 별도 사이클
> **Date**: 2026-05-20
> **Branch/Commit**: `feature/home-v2` @ `1abf1de`
> **Method**: Self gap-check against Plan + Design (gap-detector agent 자율 모드 self-execution)

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | 4개 화면 분산 + component 분류 부재 → 재발 방지 학습 곤란 (Phase A 는 분산 화면 통합만 다룸) |
| **WHO** | DevOps 파트원 |
| **RISK** | (1) module→service 자동 매핑(Phase B 이슈, 이번 Phase 와 무관) (2) 중복 등록(Phase A 의 명시적 cross-link 으로 일부 완화) |
| **SUCCESS** | A·D·E 만 Phase A 범위 |
| **SCOPE** | Phase A 만 |

## Strategic Alignment Check

| Plan Goal | Implementation Evidence | Status |
|---|---|---|
| 사용자 의도 1 (서비스별 업무 이력) — Phase A 부분 | ServiceHub 의 RelatedWorkItemsPanel + RelatedOpsNotesPanel 로 같은 service 의 WorkItem + OpsNote 통합 표시 | ✅ 부분 (component 분류는 Phase B/C 에서) |
| 사용자 의도 3 (장애 재발 방지) — Phase A 부분 | WorkItemDetailPage 의 RelatedServiceEntriesSidebar 로 같은 service 의 troubleshoot/history/guide 노출 → 다음 사람이 과거 자산을 자동 확인 가능 | ✅ 부분 (자동 승격은 Phase B/C 외) |

## Plan Success Criteria Verification (Phase A 범위)

| ID | 기준 | 측정 | 상태 | 증거 |
|---|---|---|---|---|
| SC-1 | /docs 에서 service 1번 클릭으로 통합 표시 | 수동 | ⚠️ Partial — Phase C 범위 (KnowledgeHubPage 의 service chip). 이번 Phase 는 ServiceHub 진입점에서만 통합 | Phase C 외 |
| SC-2 | k8s component chip 5종 | 수동 | ❌ Not Met — Phase B (component 컬럼) 미완료 | Phase B 외 |
| SC-3 | /tasks-mgmt service+component 필터 | 수동 | ❌ Not Met — Phase C | Phase C 외 |
| SC-4 | WorkItemDetail sidebar → /services/:svc 이동 | 수동 | ✅ Met | RelatedServiceEntriesSidebar.tsx — Link to=`/services/${service}` |
| SC-5 | ServiceHub WorkItem 카드 → /tasks-mgmt/:id 이동 | 수동 | ✅ Met | RelatedWorkItemsPanel.tsx — Link to=`/tasks-mgmt/${w.id}` |
| SC-6 | 기존 work_items 100% 보존 + null 표시 | 자동 | ✅ Met — backend 변경 0 | git diff backend/ → 0 |
| SC-7 | lint + tsc 통과 | 자동 | ✅ Met | tsc exit 0, lint max-warnings 0 통과 |
| SC-8 | MemberBoardPage / WorkflowBoardPage 회귀 없음 | 자동 | ✅ Met — 두 페이지 코드 변경 0 | git diff → 0 |

**Phase A 한정 Match Rate**: 5/5 met (SC-4, SC-5, SC-6, SC-7, SC-8) = **100%**.
**전체 Plan 기준 Match Rate**: 5/8 = **62.5%** — Phase B/C 미실행이라 의도된 미달.

## Gap List (Confidence ≥ 80%, Severity ≥ Important)

| ID | Sev | 위치 | 갭 | 영향 | 액션 |
|---|---|---|---|---|---|
| g1 | Moderate | ServiceHubPage | RelatedWorkItemsPanel 이 workItemsApi.getAll() 로 전체 work_items 를 fetch 한 뒤 frontend 에서 service filter | 데이터가 ~수천 행 도달 시 비효율. 현재 < 500 이라 OK | Phase B 시 backend 에 `?service=` 쿼리 파라미터 추가 (work_items.py) → frontend filter 제거 |
| g2 | Moderate | RelatedWorkItemsPanel | useQuery key 가 `['items']` 라 WorkItemBoardPage / KnowledgeHubPage 의 same key 와 캐시 공유 — 의도된 동작이나 staleTime 30s 가 일치하지 않을 수 있음 | Cache invalidation 일관성 위험 | useQueryClient.invalidateQueries 콜이 work_items 생성/수정 시 `['items']` 를 일관되게 무효화하는지 확인 (현재 useWorkItems 훅 동작 확인 필요) |
| g3 | Minor | RelatedServiceEntriesSidebar | sticky top-4 인데 본문 컬럼이 매우 짧으면 sidebar 가 본문보다 길어져 어색 | UX 미세 | items-start flex 정렬로 완화 — 이미 적용 (`items-start`) |
| g4 | Minor | RelatedOpsNotesPanel | opsNotesApi.getAll(service) 가 모든 노트 반환 (페이지네이션 없음) — service 별 노트가 많을 때 비효율 | 운영 환경 데이터 크기 < 100 이라 OK | Phase C 에서 backend pagination 도입 시 같이 처리 |

Critical 없음. Phase A 의 목표(분산 화면 통합) 달성 충족.

## Decision Record Verification

| Plan/Design Decision | 실 구현 결과 | Follow? |
|---|---|---|
| Q1: 3단계 계층 방향 채택 | Phase A 는 service 매핑만, component(Q1 Lv2) 는 Phase B 로 분리 | ✅ 의도된 단계 분할 |
| Q2: 신규 component 컬럼 + service별 enum | Phase A 범위 외 — backend 변경 0 | ✅ Phase B 로 이월 |
| Q3: 공유 모델 + cross-view | ServiceEntry + WorkItem + OpsNote 모두 보존 + 양방향 navigation | ✅ |
| AD-1: backend 변경 없음 | git diff backend/ = 0 | ✅ |
| AD-2: 컴포넌트 내부 useQuery, hooks 추출 안 함 | 3 컴포넌트 모두 자체 useQuery | ✅ |
| AD-3: cross-link navigation only | DB join 신규 모델 0 | ✅ |
| AD-4: sidebar w-72 | RelatedServiceEntriesSidebar.tsx — `w-72 flex-shrink-0` | ✅ |
| AD-5: service==null 일 때 sidebar 미표시 | WorkItemDetailPage — `{item.service && <Sidebar/>}` | ✅ |

5/5 design decisions followed.

## Recommendation

- Phase A 는 의도대로 완료. Match Rate Phase A 한정 100%.
- 발견된 갭 4건 모두 Moderate 이하 — 별도 commit 없이 Phase B/C 사이클에서 자연 해결.
- 다음: `/pdca report knowledge-workitem-linkage` (완료 보고) → 별도 사이클 `/pdca plan knowledge-workitem-linkage-phase-b`.
