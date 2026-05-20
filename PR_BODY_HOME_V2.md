# feature/home-v2 → main 머지 본문

> **From**: `feature/home-v2` @ `38dbfca`
> **To**: `main` @ `aec59eb`
> **Scope**: 20 commits, 40 files (+5,308 / -1,514)
> **Status**: ahead 20 / behind 0 — fast-forward 가능
> **검증**: ESLint(max-warnings 0) ✅ · tsc --noEmit ✅ · 회귀 없음

---

## 요약

본 PR 은 한 branch(`feature/home-v2`)에서 진행된 **4 개 묶음 작업**을 한 번에 main 으로 머지합니다. 각 묶음은 자체 commit 시퀀스를 가지며 시간 순서대로 정렬되어 있습니다.

| 묶음 | Commits | 핵심 결과물 |
|---|---:|---|
| **1. BatchJobsPage 재설계** | 11 | 매트릭스 뷰 → 잡 중심 리스트 + 슬라이드오버 + 3단계 wizard. 974줄 → 243줄 (-731) |
| **2. work-items 라벨 통일** | 1 | "작업" 옛 용어 잔존 18곳을 "업무" 로 통일. type-specific 한 "작업" 은 유지 |
| **3. KnowledgeHubPage 단순화** | 2 | cards 뷰 제거 → table only (754 → 445줄, -41%). "미해결 이슈" 빠른 필터 chip 추가 |
| **4. knowledge-workitem-linkage Phase A (PDCA)** | 6 (merge 1 포함) | ServiceHub ↔ WorkItem 양방향 cross-view + Plan/Design/Analysis/Report 4 문서 archive |

---

## 묶음 1 — BatchJobsPage 재설계

### 의도
매트릭스 뷰(클러스터 × jobType)는 클러스터/잡 타입이 많아질수록 가로 스크롤이 길어지고, 특정 잡 1건을 조작하려면 셀 안 작은 버튼을 눌러야 했습니다. **잡 중심 단일 리스트 + dock 슬라이드오버 + 3단계 wizard** 로 재설계해 동선을 단순화.

### 새 컴포넌트 16개 (`frontend/src/components/batch-jobs/`)

| 파일 | 책임 |
|---|---|
| `index.ts` | barrel |
| `types.ts` / `filters.ts` | `FilterKey`/`SortKey`/`FAILED_STATUSES` + `applyFilter` |
| `StatusPill.tsx` | 7 상태 (ok/error/timeout/auth_error/connect_error/running/unknown) 표시 |
| `BatchJobFilters.tsx` | 상태 chip 5종 + 검색 input |
| `BatchJobTable.tsx` + `BatchJobRow.tsx` | 정렬 헤더 + 행 클릭 highlight |
| `UnregisteredTypeChips.tsx` | 단일 클러스터 모드의 "미등록 잡 타입" 칩 |
| `BatchJobSlideOver.tsx` + `.RunHistory.tsx` + `.RunForm.tsx` | dock(≥1280px) / overlay(<1280px) 자동 전환 슬라이드오버 — 같은 패널 안에서 이력 펼침으로 JobRunsModal/RunDetailModal 모달 중첩 제거 |
| `CreateBatchJobWizard.tsx` + `.shared.ts` | 3-step wizard 컨테이너 + 검증 헬퍼 |
| `CreateBatchJobWizard.StepType.tsx` | Step 1 — 클러스터/잡 타입/이름/설명 |
| `CreateBatchJobWizard.StepHost.tsx` | Step 2 — 호스트/포트/사용자/params JSON |
| `CreateBatchJobWizard.StepSchedule.tsx` | Step 3 — cron + 자격증명 |

### 수정
- `frontend/src/pages/BatchJobsPage.tsx` — **974줄 → 243줄** orchestrator. 기존 inline 모달 4개 모두 제거하고 `components/batch-jobs/` 의 sub-component 조합. 페이지 상태는 `selectedClusterId / statusFilter / search / sort / selectedJob / wizardCtx` 6개로 한정.

### 후속 fix 4건
- 슬라이드오버 race fix (wizard `onCreated` → `setSelectedJobId(job.id)` 호출 시 TQ refetch 가 끝나기 전 cleanup effect 가 발동해 슬라이드오버가 안 열리던 버그). 해결: `selectedJob` 상태를 string id 대신 `BatchJob` 객체로 보유.
- 리뷰 지적 7건 (wizard 4 + page 3) 반영.
- 미사용 `eslint-disable-next-line react-hooks/exhaustive-deps` 디렉티브 2건 제거.

### 디자인/구현 문서
- `docs/superpowers/specs/2026-05-15-batch-jobs-redesign-design.md` (304줄)
- `docs/superpowers/plans/2026-05-15-batch-jobs-redesign.md` (2088줄, 8-task implementation plan)

---

## 묶음 2 — work-items 라벨 통일

### 의도
백엔드는 `task/issue/meeting/training/etc` 를 `work_items` 단일 모델로 통합 (`type` 컬럼으로 구분) 했고 대분류 한국어도 "업무" 로 통일했지만, UI 일부에 옛 대분류 라벨인 **"작업"** 이 잔존. 사용자가 "업무등록 게시판" 에서 등록 버튼을 누르면 폼 헤더가 "작업 등록" 으로 표시되는 inconsistency 가 발생했음.

### 핵심 통찰
`WorkItemType = 'task' | 'issue' | 'meeting' | 'training' | 'etc'` 에서 `type === 'task'` 의 한국어 명칭은 여전히 "작업" 이지만, **모든 type 을 다루는 통합 페이지/폼** 의 "작업" 라벨은 사용자가 type-specific 의미로 오해할 수 있어 잘못된 것. → 통합 UI 만 "업무" 로 통일하고 type-specific "작업" 은 유지.

### 변경 — 9 파일, 18 위치

- Page 헤더/empty state/삭제 확인: `WorkItemFormPage` · `WorkItemDetailPage` · `WorkItemBoardPage` · `WorkItemTableRow`
- Kanban 컬럼 안내: `workItemKanbanUtils` (4 emptyText)
- Form 안내문/JSDoc: `WorkItemForm` · `WorkItemReadView`
- 다른 페이지 진입 라벨: `TodoTodayPage` (헤더 설명 + "작업 게시판"→"업무 게시판" 2건 + 버튼 + empty state 2건) · `MemberTodayTodos`

### 동결 (type-specific "작업" 유지)
- `MemberBoardPage` — `bucket.tasks` (`filter(w => w.type === 'task')`) 라벨 "작업", "할당된 작업 없음" 유지
- `WorkflowBoardPage` — task/issue 분기 라벨 유지
- `WorkSummaryPage` — "어제 클러스터 작업 변경 사항" 카드 제목은 별개 맥락이라 동결

---

## 묶음 3 — KnowledgeHubPage 단순화

### refactor: cards 뷰 제거 — table only

`cfbb592 fix(playbooks, services-catalog): viewMode 캐시 제거 — 항상 리스트가 기본` 의 정신을 한 단계 더 밀어붙여 토글 자체가 없는 단일 리스트 페이지로 단순화.

**제거**:
- ViewModeBar 토글 (목록/카드)
- `{viewMode === 'cards' && …}` 블록 (4 MacCard 그리드: 운영 기준 / 작업 기준 / 이슈·장애 / 흐름·설계)
- cards 뷰 전용 헬퍼 4개 (PreviewRow / NavTile / EmptyHint / SectionMoreLink)
- cards 뷰 전용 useMemo 6개 (pinnedNotes / recentNotes / criticalCmds / activeGuides / openIssues / recentFlows)
- viewMode state + ViewMode union type + setViewMode
- Footer hint (목록/카드 토글 안내) — 더 이상 의미 없음

**유지**: HubItem 정규화 / 6 컬럼 table / SortTh 정렬 / 필터 chip 행 / 빈 상태 / 총 N건 footer

**통계**: 754 → 445줄 (-309, -41%) / +108 / -417

### feat: "미해결 이슈" 빠른 필터 chip 추가

cards 제거로 손실된 "미해결 이슈" 가시성을 table 페이지 안에 다시 살림. cards 전체를 복원하는 대신 **가장 자주 쓰는 신호 1가지만** 필터 chip 형태로 노출.

- 5종 kind chip 뒤에 빨강 톤 `AlertCircle 미해결 이슈 (N)` chip 추가
- 클릭 시 토글 — `kind === 'item' && statusLabel === '미조치'` 교차 필터
- count == 0 + 비활성 상태면 chip 자체 숨김
- `kind=item` chip 과 동시 활성화 가능 (AND 결합)

---

## 묶음 4 — knowledge-workitem-linkage Phase A (PDCA cycle)

직전 분석(`docs/03-analysis/knowledge-services-coherence.analysis.md`)에서 식별한 **Gap G1** (ServiceHub 가 같은 service 의 WorkItem/OpsNote 표시 안 함) 을 PDCA cycle 로 봉합. Plan 의 3-Phase 분할 (A: cross-view / B: component 모델 / C: drill-down 필터) 중 **Phase A 만** 이번 PDCA 로 처리.

### PDCA 결정 (Q1/Q2/Q3 합의)
- **Q1** 3단계 계층(service → component → typeLabel) 방향 채택
- **Q2** 신규 `WorkItem.component` 컬럼 + service별 enum (Phase B 로 이월)
- **Q3** 공유 모델 + cross-view (ServiceEntry + WorkItem + OpsNote 셋 다 보존)

### Design 결정
- **Option C — Pragmatic Balance** 채택 (Minimal/Clean/Pragmatic 3-안 비교 후)
- 컴포넌트 2 + sidebar 1 신설, hooks 추출은 호출처 3+ 도달 시 Phase B 로 미룸
- backend 변경 0 lines → 마이그레이션 리스크 0

### 신규 컴포넌트 3개
- `frontend/src/components/services/RelatedWorkItemsPanel.tsx` (85 LoC) — `workItemsApi.getAll()` → frontend filter `w.service === service` → 5건 + 더보기
- `frontend/src/components/services/RelatedOpsNotesPanel.tsx` (75 LoC) — `opsNotesApi.getAll(service)` (backend 가 `?service=` 지원) → 5건
- `frontend/src/components/work-items/RelatedServiceEntriesSidebar.tsx` (90 LoC) — `serviceEntriesApi.list(service)` → 5건 sticky w-72 sidebar

### 페이지 통합
- `pages/ServiceHubPage.tsx`: 본문 끝에 RelatedWorkItemsPanel + RelatedOpsNotesPanel 삽입
- `pages/WorkItemDetailPage.tsx`: read 모드를 flex 2-column 으로 변경, `item.service` 있을 때만 sidebar 표시

### Match Rate
- **Phase A 한정 100%** (SC-4 / SC-5 / SC-6 / SC-7 / SC-8 모두 met)
- **전체 Plan 기준 62.5%** — SC-1 / SC-2 / SC-3 는 Phase B/C 의도된 이월

### PDCA 산출물 4개 (archive 보관)
`docs/archive/2026-05/knowledge-workitem-linkage/` 로 이동:
- `plan.md` — Executive Summary + Context Anchor + 3-Phase 분할 + Success Criteria 8건 + Risks 6건
- `design.md` — 3 Architecture Options 비교 + Decision (Option C) + Component Specs + AD-1~5
- `analysis.md` — Self gap-check (Critical 0, Moderate 4, 모두 Phase B/C 로 이월)
- `report.md` — Value Delivered (4 perspectives with metrics) + Carry Items

### Carry Items (별도 사이클로 이어짐)
- **Phase B** (~1-2주): `WorkItem.component` 컬럼 + COMPONENT_BY_SERVICE constant + 마이그레이션
- **Phase C** (~1-2주): KnowledgeHub + WorkItemBoard 의 service/component/typeLabel chip
- Moderate gap 1: backend `work_items` 에 `?service=` 쿼리 파라미터 추가
- Moderate gap 4: opsNotes pagination 도입

---

## Test plan

- [ ] `/batch-jobs` 진입 — 매트릭스 뷰가 잡 중심 단일 리스트로 보이는지, 행 클릭 시 dock 슬라이드오버가 열리는지 (≥1280px), 좁은 창에서 overlay 로 전환되는지
- [ ] `/batch-jobs` 의 `+ 새 잡` 버튼 — 3-step wizard 정상 동작 (Type → Host → Schedule)
- [ ] wizard 의 `onCreated(job)` → 슬라이드오버가 즉시 열리는지 (race fix 검증)
- [ ] `/tasks-mgmt` 의 `+ 업무 등록` 클릭 → form 헤더가 **"업무 등록"** 으로 표시되는지 (옛 "작업 등록" 잔존 없음)
- [ ] `/tasks-mgmt/:id` 의 page title 도 **"업무 상세"** / **"업무 수정"** 인지
- [ ] `/todo-today` 의 "업무 게시판" 링크 / "업무 추가" 버튼 / empty state 안내 모두 "업무" 로 표시되는지
- [ ] `/members` 의 멤버 컬럼 라벨 "작업" 은 그대로 유지 (type='task' 만 필터하는 의도된 동작)
- [ ] `/docs` 진입 — table 형태 단일 리스트, 카드 뷰 토글 없음, 필터 chip 행에 "미해결 이슈 (N)" 빨강 chip 노출
- [ ] `/docs` 의 "미해결 이슈" chip 클릭 → `kind === 'item' && statusLabel === '미조치'` 만 필터링되는지
- [ ] `/services/k8s` 진입 → 기존 entries 그리드 아래 "**관련 업무**" + "**관련 운영 노트**" 섹션이 보이는지, 각 5건 미리보기 + 더보기 링크
- [ ] `/services/k8s` 의 관련 업무 카드 클릭 → `/tasks-mgmt/:id` 로 이동
- [ ] service=k8s 인 WorkItem 상세 (`/tasks-mgmt/:id`) → 우측에 sticky sidebar "관련 지식" 5건 표시
- [ ] service=null 인 WorkItem 상세 → sidebar 자체가 안 보이는지
- [ ] WorkItemDetail 의 sidebar 카드 클릭 → `/services/{service}` 로 이동
- [ ] ESLint: `cd frontend && npm run lint` → 0 errors
- [ ] TypeScript: `cd frontend && npx tsc --noEmit` → exit 0
- [ ] 회귀: `/cluster-overview` · `/playbooks` · `/cluster-manage` 등 main 에 머지된 기능 정상 동작

---

## 후속 작업 (carry items)

본 PR 머지 후 별도 PR/사이클로:

| 우선순위 | 작업 | 추정 |
|---:|---|---|
| H | knowledge-workitem-linkage Phase B — WorkItem.component 컬럼 + 마이그레이션 | 1-2주 |
| M | knowledge-workitem-linkage Phase C — KnowledgeHub/WorkItemBoard service/component/typeLabel chip | 1-2주 |
| M | IncidentAnalysisPage 결과 영구 저장 (knowledge-services-coherence Gap G2 — 단독 single-file fix 후보) | 2-3일 |
| M | Issue resolution → Troubleshoot 자동 승격 (Gap G7) | 3-5일 |
| L | 자동 알림/멘션/구독 시스템 (Gap G6) — 기존 `notifier.py` 채널 패턴 재사용 | 1주 |

---

🤖 본 PR 본문은 PDCA 사이클(plan/design/analyze/report)을 거쳐 정리되었습니다.
관련 archive: [`docs/archive/2026-05/knowledge-workitem-linkage/`](./docs/archive/2026-05/knowledge-workitem-linkage/)

Generated with [Claude Code](https://claude.com/claude-code)
