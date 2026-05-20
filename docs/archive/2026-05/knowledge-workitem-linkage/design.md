# knowledge-workitem-linkage Design Document

> **Summary**: Phase A(Cross-view) 깊이 설계 + B/C 는 outline. 자율 모드 Pragmatic option(C) 채택.
>
> **Project**: devops_management
> **Branch**: feature/home-v2
> **Author**: riverjin839 + Claude (자율)
> **Date**: 2026-05-20
> **Status**: Draft
> **Planning Doc**: [knowledge-workitem-linkage.plan.md](../../01-plan/features/knowledge-workitem-linkage.plan.md)

---

## Context Anchor

| Key | Value |
|---|---|
| **WHY** | 4개 화면 분산 + component 분류 부재 → 재발 방지 학습 곤란 |
| **WHO** | DevOps 파트원 (1차: k8s 운영자) |
| **RISK** | (1) module/category → service+component 자동 매핑 실패 (2) 두 모델 유지로 중복 등록 (3) component enum 의 dynamic schema |
| **SUCCESS** | A: `/docs` service 1-클릭 통합 / B: k8s component chip 5종 / C: `/tasks-mgmt` service+component 필터 / D: WorkItem↔ServiceEntry 1-클릭 / E: 기존 데이터 100% 보존 |
| **SCOPE** | A: Cross-view (1주) → B: Component 모델 + 마이그레이션 (1-2주) → C: Drill-down + 필터 (1-2주) |

---

## 1. Overview

본 design 은 **Plan 의 Phase A 만 깊이 정의**하고 B/C 는 high-level outline 만 둔다 (Plan §7 권장 사항).

Phase A 의 4개 작업 (A1-A4) 는 **DB 변경 없이** 기존 모델 + 기존 API + frontend 컴포넌트 신설만으로 달성 가능 — Cross-view 가시성을 빠르게 확보한 뒤 Phase B 에서 안전하게 component 컬럼 도입.

---

## 2. Architecture Options

### Option A — Minimal Changes (Quick & Dirty)

**접근**: 기존 페이지에 useQuery 호출 1~2개 추가 + JSX 인라인 섹션. 새 파일 없음.

| 항목 | 평가 |
|---|---|
| 변경 파일 수 | 2 (`ServiceHubPage.tsx`, `WorkItemDetailPage.tsx`) |
| 새 컴포넌트 | 0 — JSX 인라인 |
| 새 hooks | 0 — 페이지 안에서 inline useQuery |
| 재사용성 | ❌ 낮음 — 다른 페이지에서 같은 목록을 쓰려면 복사 |
| 단순성 | ✅ 매우 단순 |
| 유지보수 | ⚠️ 페이지 파일이 커지면 가독성 떨어짐 |

### Option B — Clean Architecture (Over-engineered)

**접근**: 새 hooks `useWorkItemsByService` + `useOpsNotesByService` + `useRelatedServiceEntries` 신설. 새 컴포넌트 `RelatedWorkItemsPanel` / `RelatedOpsNotesPanel` / `RelatedServiceEntriesSidebar` 신설. 각 컴포넌트는 props 의존성 명확.

| 항목 | 평가 |
|---|---|
| 변경 파일 수 | 7 (페이지 2 + hooks 3 + 컴포넌트 3) |
| 새 hooks | 3 — `useWorkItemsByService`, `useOpsNotesByService`, `useRelatedServiceEntries` |
| 새 컴포넌트 | 3 — 패널 컴포넌트들 |
| 재사용성 | ✅ 높음 — 다른 페이지에서 1줄 import 로 사용 |
| 단순성 | ❌ 의존성 분리가 과함 |
| 유지보수 | ✅ 깔끔 — 단 Phase A 수준에선 과투자 |

### Option C — Pragmatic Balance (Recommended ✅)

**접근**: 새 컴포넌트 **2개만** 신설 — `RelatedWorkItemsPanel` (ServiceHub 에서 사용), `RelatedServiceEntriesSidebar` (WorkItemDetail 에서 사용). hooks 는 **신설하지 않고** 기존 `workItemsApi.getAll()` / `opsNotesApi.getAll(service)` / `serviceEntriesApi.list(service)` 를 컴포넌트 안 useQuery 로 직접 호출. WorkItem 의 service 필터는 backend 미지원이므로 frontend filter (`items.filter(w => w.service === service)`).

| 항목 | 평가 |
|---|---|
| 변경 파일 수 | 4 (페이지 2 + 컴포넌트 2) |
| 새 hooks | 0 — 컴포넌트 내부 useQuery |
| 새 컴포넌트 | 2 — `RelatedWorkItemsPanel`, `RelatedServiceEntriesSidebar` |
| 재사용성 | ⚠️ 중간 — 두 곳에서 쓰고 더 필요하면 추출 |
| 단순성 | ✅ Phase A 수준에 딱 맞음 |
| 유지보수 | ✅ 깔끔 + 미래 hook 추출 여지 |

### Decision (자율 모드)

**Selected: Option C — Pragmatic Balance.** 

이유:
- Phase A 의 목적이 "빠른 cross-view 가시성" 이라 Clean 의 hook 추출 비용은 과투자.
- Phase B/C 에서 component 컬럼 도입 시 자연스럽게 hook 으로 추출 (그때 호출처 3+ 곳 발생).
- Minimal 은 JSX 인라인이라 Plan §3.NFR-1 (1초 응답) 보장이 어렵고 코드 가독성도 떨어짐.

---

## 3. Data Flow

### 3.1 ServiceHubPage (`/services/:service`)

```
┌─ ServiceHubPage ────────────────────────────────────────┐
│  헤더 + 탭 + 항목 그리드 (기존)                          │
│                                                          │
│  ── 관련 업무 (RelatedWorkItemsPanel) ──────────────     │
│   useQuery(['items'])                                    │
│   .filter(w => w.service === service)                    │
│   .slice(0, 5) + 더보기 → /tasks-mgmt?service=X          │
│                                                          │
│  ── 관련 운영 노트 (RelatedOpsNotesPanel) ──────────     │
│   useQuery(['ops-notes', service])                       │
│   = opsNotesApi.getAll(service)                          │
│   .slice(0, 5) + 더보기 → /ops-notes?service=X           │
└──────────────────────────────────────────────────────────┘
```

### 3.2 WorkItemDetailPage (`/tasks-mgmt/:id`)

```
┌─ WorkItemDetailPage ─────────────────────────────────────┐
│  flex layout                                              │
│  ┌─────────────────────────┐  ┌──────────────────────┐  │
│  │ 본문 (기존 read view)    │  │ Sidebar (sticky)     │  │
│  │ flex-1                   │  │ w-72                 │  │
│  │                          │  │                      │  │
│  │                          │  │ RelatedServiceEntries│  │
│  │                          │  │ Sidebar              │  │
│  │                          │  │  - service: item.svc │  │
│  │                          │  │  - 5 entries         │  │
│  │                          │  │  - 클릭 → /services/X│  │
│  └─────────────────────────┘  └──────────────────────┘  │
│                                                          │
│  (item.service === null 일 때 sidebar 미표시)            │
└──────────────────────────────────────────────────────────┘
```

### 3.3 cross-link (A4 — navigation only)

| From | To | 방식 |
|---|---|---|
| ServiceHub 의 WorkItem 카드 | `/tasks-mgmt/:id` | Link |
| ServiceHub 의 WorkItem 영역 헤더 "전체 보기" | `/tasks-mgmt?service=X` (URL param, Phase C 에서 처리 가능. 지금은 그냥 `/tasks-mgmt`) | Link |
| ServiceHub 의 OpsNote 카드 | `/ops-notes/:id` | Link |
| WorkItemDetail 의 ServiceEntry 카드 | `/services/:service` | Link (entry 직접 anchor 는 ServiceHub UX 가 entry-level deep link 없음 — 향후) |

---

## 4. Component Specs

### 4.1 `RelatedWorkItemsPanel`

**File**: `frontend/src/components/services/RelatedWorkItemsPanel.tsx` (신규)

```tsx
interface RelatedWorkItemsPanelProps {
  service: string;
}

export function RelatedWorkItemsPanel({ service }: RelatedWorkItemsPanelProps) {
  const q = useQuery({
    queryKey: ['items', 'by-service', service],
    queryFn: () => workItemsApi.getAll().then(r => r.data),
    staleTime: 30_000,
  });
  const items = (q.data?.data ?? []).filter(w => w.service === service).slice(0, 5);
  // ... 헤더 + 5건 리스트 + 더보기 링크
}
```

**Output**:
- 헤더: "관련 업무" + 총 개수 + 더보기 링크 (`/tasks-mgmt`)
- 카드 행 5건: type chip + title + assignee + relative time
- 0건 시 empty state
- 로딩 시 skeleton 3개

### 4.2 `RelatedOpsNotesPanel`

**File**: `frontend/src/components/services/RelatedOpsNotesPanel.tsx` (신규)

```tsx
interface RelatedOpsNotesPanelProps {
  service: string;
}

export function RelatedOpsNotesPanel({ service }: RelatedOpsNotesPanelProps) {
  const q = useQuery({
    queryKey: ['ops-notes', service],
    queryFn: () => opsNotesApi.getAll(service).then(r => r.data),
    staleTime: 30_000,
  });
  const notes = (q.data?.data ?? []).slice(0, 5);
  // ... 헤더 + 5건 리스트 + 더보기 링크
}
```

### 4.3 `RelatedServiceEntriesSidebar`

**File**: `frontend/src/components/work-items/RelatedServiceEntriesSidebar.tsx` (신규)

```tsx
interface RelatedServiceEntriesSidebarProps {
  service: string;
}

export function RelatedServiceEntriesSidebar({ service }: RelatedServiceEntriesSidebarProps) {
  const q = useQuery({
    queryKey: ['service-entries', service, 'sidebar'],
    queryFn: () => serviceEntriesApi.list(service).then(r => r.data.data),
    staleTime: 30_000,
  });
  const entries = (q.data ?? []).slice(0, 5);
  // sticky top-4 + 5 entries + 더보기 → /services/{service}
}
```

---

## 5. Implementation Order (Session Guide)

### 5.1 Module Map

| Module | Files | Estimated LoC |
|---|---|---|
| **M1: RelatedWorkItemsPanel** | `frontend/src/components/services/RelatedWorkItemsPanel.tsx` | ~70 |
| **M2: RelatedOpsNotesPanel** | `frontend/src/components/services/RelatedOpsNotesPanel.tsx` | ~70 |
| **M3: RelatedServiceEntriesSidebar** | `frontend/src/components/work-items/RelatedServiceEntriesSidebar.tsx` | ~80 |
| **M4: ServiceHubPage integration** | `frontend/src/pages/ServiceHubPage.tsx` (수정) | +15 lines |
| **M5: WorkItemDetailPage integration** | `frontend/src/pages/WorkItemDetailPage.tsx` (수정) | +20 lines |

### 5.2 Recommended Session Plan

자율 모드 1-session — 5개 모듈 cohesive 변경 + 단일 commit. M1~M5 순서.

---

## 6. Edge Cases

- **WorkItem.service == null**: ServiceHub 의 RelatedWorkItemsPanel 은 같은 service 매칭만 표시 → 자동으로 제외. WorkItemDetail 의 sidebar 는 item.service == null 이면 통째로 미표시.
- **빈 결과**: 각 패널은 EmptyState ("관련 항목 없음") 표시. 사이드바는 빈 결과 시 통째 미표시 (공간 낭비 방지).
- **로딩 중**: skeleton. error 시 빨강 경고 1줄.
- **5건 초과**: 더보기 링크로 전체 페이지 이동. URL param `?service=X` 는 Phase C 에서 처리 가능 (이번 단계는 unfiltered 페이지로 가서 사용자가 직접 필터).

---

## 7. Phase B / C Outline (이번 사이클 범위 외)

### Phase B (별도 PDCA 사이클)
- `WorkItem.component` 컬럼 + `COMPONENT_BY_SERVICE` constant
- backend migration (`_run_migrations` 의 `ALTER TABLE ADD COLUMN IF NOT EXISTS`)
- WorkItemForm 의 service↔component cascade

### Phase C (별도 PDCA 사이클)
- KnowledgeHubPage 의 service / component / typeLabel chip
- WorkItemBoardPage 의 service+component 필터
- `if (i.type !== 'issue') continue` 제거 + ServiceEntry 6번째 종

---

## 8. Test Plan (Phase A 한정)

| Level | Scenario | 통과 기준 |
|---|---|---|
| L1 API | `GET /work-items` 응답에 service 컬럼 포함 (이미 존재) | shape 확인 |
| L1 API | `GET /ops-notes?service=k8s` filter 동작 | 결과의 모든 행이 service=k8s |
| L1 API | `GET /services/k8s/entries` 응답 정상 | (기존 동작 유지 — 회귀 없음) |
| L2 UI | `/services/k8s` 진입 → "관련 업무" 섹션이 service=k8s 인 WorkItem 만 표시 | 수동 |
| L2 UI | `/services/k8s` 의 "관련 업무" 카드 클릭 → `/tasks-mgmt/:id` 이동 | 수동 |
| L2 UI | `/tasks-mgmt/:id` (service=k8s 인 WorkItem) → 우측 sidebar 에 ServiceEntry 표시 | 수동 |
| L2 UI | `/tasks-mgmt/:id` (service=null 인 WorkItem) → sidebar 미표시 | 수동 |

---

## 9. Architecture Decisions Recorded

- **AD-1**: Backend 변경 없음. WorkItem 의 service 필터는 frontend 필터로 (Plan NFR-1 ≤ 1초 충족 가능 — 데이터 < 1000 행 가정).
- **AD-2**: 컴포넌트 내부 useQuery (hooks 추출 안 함) — Phase B 에서 호출처 증가 시 추출.
- **AD-3**: cross-link 은 navigation only, DB join 신규 모델 도입 안 함 — Plan OQ-1 의 첫 옵션.
- **AD-4**: sidebar 폭 `w-72` (288px) — `ClusterSidebar` (56px) 와 통일된 right-side 폭은 없으나, WorkItemDetailPage 의 본문 가로 폭(1400px) 의 ~20% 로 가독성 확보.
- **AD-5**: WorkItem.service == null 인 경우 sidebar 미표시 — empty state 보다 공간 절약 우선.

---

## 10. PDCA Next Steps

- `/pdca do knowledge-workitem-linkage` 또는 자율 모드 즉시 구현 진행 (이번 사이클 자율).
- Phase A 완료 후 `/pdca analyze` → `/pdca report` → 다음 PDCA 사이클(`/pdca plan knowledge-workitem-linkage-phase-b`) 로 이어짐.
