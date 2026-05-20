# BatchJobsPage UX/UI 재설계

- **일자:** 2026-05-15
- **대상:** `frontend/src/pages/BatchJobsPage.tsx` 및 관련 컴포넌트
- **상태:** 디자인 확정, 구현 대기
- **Phase:** 1 (레이아웃 + 슬라이드오버 + wizard). bulk action·cron 다음 실행 시각·CSV 내보내기는 Phase 2.

---

## 1. 배경과 문제

현재 BatchJobsPage 는 클러스터(행) × 잡 타입(열) 매트릭스 뷰로 구성되어 있다. 클러스터 N개와 잡 타입 M개의 격자 한 셀에 0~N개의 잡이 들어가고, 한 셀 안에 status pill + 이름 + 마지막 실행 + cron + 자격증명 경고 + 액션 버튼 3개가 모두 표시된다. 잡 클릭 시 RunModal·JobRunsModal·RunDetailModal 3종의 모달이 중첩 사용된다.

코드 베이스를 점검하면서 관찰된 거슬리는 지점은 다음과 같다.

| ID | 문제 |
|---|---|
| P1 | 한 셀의 정보 밀도가 과도해 잘림·줄바꿈이 빈번하다 |
| P2 | 화면 면적의 ~70% 가 빈 셀(+ 등록 placeholder) 이다 |
| P3 | 모달 4개의 중첩 호출(JobRunsModal → RunDetailModal)로 ESC 동선이 어색하다 |
| P4 | CLAUDE.md 의 `ClusterSidebar(iconOnly)` 표준을 따르지 않아 다른 페이지와 일관성이 깨진다 |
| P5 | 상태별·검색 필터가 없다 |
| P6 | 자주 쓰는 운영 액션(실패한 잡만 보기, 미등록 타입 발견)을 위한 진입점이 없다 |
| P7 | CreateJobModal 의 11개 필드가 한 화면에 펼쳐져 등록 부담이 크다 |

목표는 정보 밀도를 낮추면서 매트릭스가 강점이었던 "누락된 잡 발견" 동선까지 보존하는 것이다.

## 2. 핵심 방향

**잡 중심 단일 리스트 + ClusterSidebar(iconOnly).** 매트릭스를 폐기하고 모든 잡을 한 테이블에 나열한다. 좌측 사이드바로 클러스터를 격리(전체 ↔ 단일)하고, 상단 칩으로 상태 필터를 건다. 행 클릭 시 우측 슬라이드오버에 잡 정보·이력·실행 폼이 한 패널로 모인다. 새 잡 등록은 3단계 wizard 로 단순화한다. 매트릭스의 "누락된 잡 발견" 기능은 단일 클러스터 모드 하단의 **"미등록 잡 타입" 칩**으로 대체한다.

이 방향은 P1~P7 을 한 번에 풀고, CLAUDE.md 사이드바 표준에 정렬되며, 백엔드 API 변경 없이 가능하다.

## 3. 아키텍처 / 컴포넌트 분해

`BatchJobsPage.tsx` 한 파일에 5개 컴포넌트(StatusPill·CreateJobModal·RunModal·JobRunsModal·RunDetailModal·JobCell·JobEntry·BatchJobsPage)가 모여 있다. 이를 다음 구조로 재편한다.

```
frontend/src/pages/BatchJobsPage.tsx          (orchestrator — 50 LOC 내외)
frontend/src/components/batch-jobs/
  index.ts                                    (barrel export)
  BatchJobFilters.tsx                         (상태 칩 + 검색 input)
  BatchJobTable.tsx                           (테이블 + 행 선택 + 정렬)
  BatchJobRow.tsx                             (테이블 행 1개)
  BatchJobSlideOver.tsx                       (우측 슬라이드오버 — 잡 정보 + 이력 + 실행 폼)
  BatchJobSlideOver.RunForm.tsx               (실행 폼 — 슬라이드오버 내부)
  BatchJobSlideOver.RunHistory.tsx            (최근 5건 + 전체 보기)
  CreateBatchJobWizard.tsx                    (모달 — 3단계 wizard 컨테이너)
  CreateBatchJobWizard.StepType.tsx           (Step 1: 타입 + 이름/설명)
  CreateBatchJobWizard.StepHost.tsx           (Step 2: 호스트 + params)
  CreateBatchJobWizard.StepSchedule.tsx       (Step 3: cron + 저장 자격증명)
  UnregisteredTypeChips.tsx                   (단일 클러스터 모드 하단 칩 영역)
  StatusPill.tsx                              (별도 분리 — 다른 페이지에서도 재사용 가능)
  types.ts                                    (BatchJobStatus union, FilterKey 등 로컬 타입)
```

**경계 원칙**: 각 컴포넌트는 자체 prop interface 로 통신하고 내부 상태를 캡슐화한다. 페이지 컴포넌트는 cluster 선택 / 필터 / 선택된 잡 ID / wizard 열림 상태만 보유한다. 슬라이드오버·wizard 는 page 의 controlled state 를 받는다.

데이터 흐름은 그대로 TanStack Query (`useBatchJobs`, `useBatchJobTypes`, `useBatchJobRuns`, `useRunBatchJob`, `useCreateBatchJob`, `useDeleteBatchJob`) 를 쓴다. 신규 mutation/query 없음.

## 4. UI 상세

### 4.1 페이지 레이아웃

`PlaybooksPage` / `CiliumTracePage` 와 동일한 wrapper 패턴을 따른다 — 페이지 간 시각 일관성 유지가 최우선.

```tsx
<div className="min-h-screen bg-background flex">
  <ClusterSidebar
    clusters={clusters}
    selectedId={selectedClusterId}            // null = 전체
    onSelect={setSelectedClusterId}
    allowAll
    allLabel="전체"
    iconOnly
  />
  <main className="flex-1 min-w-0 px-4 lg:px-6 py-5 space-y-4 max-w-[1700px]">
    {/* Page Header — CiliumTracePage 패턴 */}
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
          <ListTree className="w-5 h-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight">Batch Jobs</h1>
          <p className="text-xs text-muted-foreground">
            {selectedClusterId ? `${selectedCluster.name} · 잡 N · 실패 X` : `전체 클러스터 · N개 잡`}
          </p>
        </div>
      </div>
      <button className="px-3.5 py-1.5 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl mac-shadow flex items-center gap-1.5">
        <Plus className="w-3.5 h-3.5" /> 새 잡
      </button>
    </div>

    {/* 본문은 두 영역을 가로로: 좌측 = 잡 리스트 MacCard, 우측 = 슬라이드오버 MacCard */}
    <div className="flex gap-4">
      <div className="flex-1 min-w-0 space-y-4">
        <MacCard title="배치 잡" bodyPadding="p-4">
          {/* BatchJobFilters + BatchJobTable */}
        </MacCard>
        {selectedClusterId && <UnregisteredTypeChips ... />}
      </div>
      {selectedJob && (
        <div className="w-[380px] flex-shrink-0">
          <MacCard title={selectedJob.name} bodyPadding="p-4" rootClassName="sticky top-4">
            {/* BatchJobSlideOver 내용 */}
          </MacCard>
        </div>
      )}
    </div>
  </main>
</div>
```

핵심:
- wrapper / main / 헤더 / 아이콘박스 패턴은 CiliumTracePage 와 같은 토큰 사용 (`rounded-2xl bg-primary/10`, `text-xl font-bold`, `rounded-xl mac-shadow`).
- 본문과 슬라이드오버 둘 다 `MacCard` 로 감싼다 — Dashboard·CiliumTracePage 와 일관. 슬라이드오버는 별도 `MacCard` 가 같은 row 에 dock 형태로 위치하며, `rootClassName="sticky top-4"` 로 스크롤해도 따라온다.
- 1280px 이하에서는 슬라이드오버를 overlay drawer 로 fallback (`fixed inset-y-0 right-0` + scrim).
- max width 는 다른 페이지와 동일하게 `max-w-[1700px]`.

### 4.2 ClusterScopeHeader

- 전체 모드: `"전체 배치 잡 · N개"` + sub `"K개 클러스터의 잡을 한 리스트로 표시"`
- 단일 모드: `"prod-seoul · ap-northeast-2 · 운영등급 P0"` + sub `"잡 N · 실패 X · 실행 중 Y · cron Z"`

### 4.3 BatchJobFilters

상태 필터 칩 + 검색 input. 칩은 single-select(전체는 reset 토글):

| 칩 | 매칭 | 비고 |
|---|---|---|
| 전체 | 모든 잡 | 기본 |
| ⚠ 실패 | `lastStatus in {error, timeout, auth_error, connect_error}` | danger 칩 |
| ▶ 실행 중 | `lastStatus === "running"` | |
| ✓ 정상 | `lastStatus === "ok"` | |
| ⚠ 자격증명 누락 | `cron && !hasSavedPassword && !hasSavedPrivateKey` | warn 칩 |

검색은 `name`·`cron`·`defaultHost`·`jobType` 에 대해 부분일치(대소문자 무시).

### 4.4 BatchJobTable

| 컬럼 | 너비 | 내용 | 전체 모드 | 단일 모드 |
|---|---|---|---|---|
| 상태 | 64px | StatusPill | ● | ● |
| 잡 | flex | 이름 + 1줄 secondary(예: 자격증명 경고·exit 코드) | ● | ● |
| 클러스터 | 90px | 클러스터 이름 badge | ● | ✕ (헤더로 흡수) |
| 타입 | 90px | `<code>` | ● | ● |
| cron / 다음실행 | 100px | cron 식 + 짧은 사람 표현(Phase 2 에서 다음 시각 추가) | ● | ● |
| 최근 실행 | 90px | `MM-DD HH:mm` | ● | ● |
| ⋯ | 50px | 케밥 메뉴 | ● | ● |

- 정렬: 상태(실패 우선)·이름·최근 실행. 컬럼 헤더 클릭으로 토글. 기본 정렬은 "실패 우선, 그 다음 최근 실행 내림차순". 정렬 상태는 컴포넌트 로컬(useState) — URL/localStorage 동기화는 하지 않는다.
- 행 hover 배경, 선택 시 좌측 4px primary border + 옅은 background tint.
- 빈 상태 메시지:
  - 클러스터 0개 → "등록된 클러스터가 없습니다. /cluster-manage 에서 추가하세요."
  - 잡 0개(전체) → "아직 등록된 배치 잡이 없습니다. ＋ 새 잡 으로 시작하세요."
  - 잡 0개(필터 결과) → "필터에 일치하는 잡이 없습니다. 필터를 해제해 보세요."

### 4.5 BatchJobSlideOver

- 너비 380px, sticky top, 페이지 본문 옆에 dock 형태(modal 아님 — 본문 클릭 가능). `Esc` 또는 헤더 ✕ 클릭으로 닫힘. 1280px 이하 뷰포트에서는 overlay drawer 로 fallback (본문 위에 띄움 + scrim).
- 구성:
  - 헤더: 잡 이름 · 타입(monospace) · 클러스터 badge · 닫기 ✕
  - 액션 바: `▶ 지금 실행 (펼치기)` · `스케줄 편집` · `삭제`(케밥 안으로)
  - **RunForm (expandable)** — "▶ 지금 실행" 클릭 시 펼침. 호스트(MasterHostPicker), 포트, 사용자, 비밀번호 or 개인키, paramOverride JSON, 타임아웃(기본 120s, 현재 동작 유지), "실행" 버튼. 실행 결과는 폼 아래에 인라인으로 표시(StatusPill + executedCommand pre + stdout/stderr `LogViewer`). 모달이 아님.
  - **RunHistory** — 최근 5건. 각 행은 status pill + 시각 + 트리거 + duration. 클릭 시 같은 슬라이드오버 안에서 "상세" 영역이 추가로 펼쳐짐(현재 RunDetailModal 의 내용 그대로). "전체 이력 →" 링크는 향후 별도 페이지(Phase 2).
- 슬라이드오버를 닫으면 RunForm 펼침 상태도 reset.

### 4.6 CreateBatchJobWizard (3단계)

모달은 유지하되 3단계 wizard 로 분리. 각 단계는 검증 통과 시 "다음" 활성화. 상단에 진행 indicator(1 · 2 · 3).

- **Step 1 — 잡 종류 (필수)**
  - 클러스터 select (props 로 prefilled 가능 — 단일 클러스터 모드, 미등록 타입 칩에서 진입 시)
  - Job Type select (`useBatchJobTypes`)
  - 이름 · 설명 (선택 시 자동 prefill)
- **Step 2 — 호스트 / 파라미터**
  - MasterHostPicker (클러스터 노드 후보)
  - 포트 · 사용자
  - params JSON textarea + 사용 가능한 파라미터 details
- **Step 3 — 스케줄 / 자격증명 (모두 선택)**
  - cron 식 입력
  - 저장 비밀번호 · 저장 개인키(PEM)
  - cron 입력했는데 자격증명이 없으면 step3 에서 warning + "그래도 저장" 옵션
- 마지막 단계의 "등록" 클릭 → `useCreateBatchJob` 호출 → 성공 시 모달 닫고, 응답으로 받은 새 잡 id 를 `selectedJobId` 로 set 해 슬라이드오버를 자동으로 펼친다.

### 4.7 UnregisteredTypeChips

단일 클러스터 모드에서만 보임. 표 아래에 1줄로 노출:

> 미등록 잡 타입: `+ log_rotate`  `+ apt_security_update`  `+ k8s_resource_audit`

칩 클릭 시 wizard 가 step 1 prefilled(`clusterId`, `jobType`) 로 열림. 전체 모드에서는 노출되지 않는다(클러스터별로 다르기 때문).

### 4.8 시각 컨벤션 (CLAUDE.md 디자인 시스템 + 페이지 간 일관성)

- **컴포넌트 wrapper**: 본문 영역과 슬라이드오버 모두 `MacCard` 로 감싼다 (Dashboard·CiliumTracePage 와 일관). 직접 `<div className="bg-card ...">` 으로 짓지 않는다.
- **페이지 헤더**: CiliumTracePage 와 동일한 "아이콘 박스(`w-10 h-10 rounded-2xl bg-primary/10`) + 텍스트(`h1.text-xl.font-bold` + `p.text-xs.text-muted-foreground`) + 우측 primary 버튼(`rounded-xl mac-shadow`)" 패턴.
- **버튼 토큰**:
  - 강조 CTA: `bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl mac-shadow`
  - 보조 버튼: `bg-secondary hover:bg-secondary/80 border border-border rounded-xl`
  - 위험 버튼: `bg-red-500 hover:bg-red-600 text-white rounded-xl`
- **StatusPill**: 기존 코드의 `STATUS_META` 매핑을 그대로 재사용 (icon + 한국어 라벨 + emerald/red/amber/blue/slate/muted 클래스). 별도 컴포넌트로 분리해 `frontend/src/components/batch-jobs/StatusPill.tsx` 에 두고 다른 페이지에서도 import 가능하게 한다.
- **필터 칩**: `inline-flex items-center gap-1 px-3 py-1 rounded-full border text-xs font-medium`. 활성 칩은 `bg-foreground text-background border-foreground`, 위험 칩은 `bg-red-500/10 text-red-600 border-red-500/30`, 경고 칩은 `bg-amber-500/10 text-amber-600 border-amber-500/30`. (CiliumTracePage 의 상태 strip 색상 키와 동일.)
- **검색 input**: `px-3 py-1.5 text-sm bg-background border border-border rounded-xl`. `<Search className="w-3.5 h-3.5" />` 아이콘은 좌측 absolute.
- **모달 (wizard)**: 기존 CreateJobModal 의 wrapper 패턴(`fixed inset-0 z-50 ... bg-black/40`, 본문 `bg-card border border-border rounded-2xl shadow-xl`) 그대로 유지. 단계 indicator 만 헤더 아래에 추가.
- **삭제 확인**: 기존 `ConfirmDialog` 재사용 (현재 코드도 동일).
- **로그 표시**: 기존 `LogViewer` 컴포넌트 재사용 (stdout/stderr 모두).
- **라운드**: 카드 `rounded-2xl`, 버튼/input `rounded-xl`, 칩/pill `rounded-full`.
- **색상**: raw hex 금지. `text-foreground`, `bg-card`, `border-border`, `text-primary`, `text-muted-foreground`, status 색은 STATUS_META 의 토큰만.
- **다크 모드**: 별도 분기 없음 — 기존 토큰이 light/dark 모두 처리.
- **반응형**: `< 1280px` → 슬라이드오버는 fixed right drawer + scrim(overlay). `< 768px` → drawer 가 전체 화면을 거의 덮음 + 닫기 ✕ 가 좌상단. 별도 bottom sheet 는 사용하지 않음.
- **터치 타겟**: 모든 행 / 액션 버튼 ≥ 36px 높이. 액션 아이콘 버튼은 `w-7 h-7` 이상.
- **focus / a11y**: 모든 interactive 요소에 기본 focus-visible ring 유지. 사이드바·칩·정렬 헤더는 `<button>` 으로 구현.

## 5. 상태 관리

페이지 컴포넌트의 로컬 상태:

```ts
const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null); // null = 전체
const [statusFilter, setStatusFilter] = useState<FilterKey>('all');
const [search, setSearch] = useState('');
const [selectedJobId, setSelectedJobId] = useState<string | null>(null); // 슬라이드오버 대상
const [wizardCtx, setWizardCtx] = useState<{ clusterId?: string; jobType?: string } | null>(null);
```

`useBatchJobs()` 는 인자 없이 호출해 전체를 받고, 클라이언트에서 `selectedClusterId` 로 필터링. (백엔드 list API 가 `cluster_id` 쿼리를 지원하지만, "전체 ↔ 단일" 토글 시 캐시 invalidation 비용을 피하기 위해 한 번에 받는다.) 30s 폴링은 유지.

`selectedJob = jobs.find(j => j.id === selectedJobId) ?? null`. 잡이 삭제되거나 새로고침 후 사라지면 `selectedJobId` 도 자동 정리.

## 6. 에러 / 빈 상태

- 백엔드 `/types` 가 빈 배열 → "사용 가능한 잡 타입이 없습니다 — 백엔드 batch-jobs/types 응답을 확인해 주세요." (현재 동작 보존)
- 잡 생성 실패 → wizard 마지막 step 하단에 `formatApiError` 결과 표시.
- 실행 실패 → 슬라이드오버 RunForm 결과 영역에 stderr / error 표시.
- 클러스터 목록 fetch 실패 → 사이드바 자체가 비어 표시. 다른 페이지 동일 패턴.

## 7. 접근성

- 모든 input 에 `<label htmlFor>` (현재 코드도 준수).
- 슬라이드오버 열림 시 `role="dialog" aria-modal="false" aria-labelledby={jobNameId}`. focus 는 슬라이드오버 헤더로 이동.
- `Esc` 키로 슬라이드오버 닫힘. focus 는 직전에 선택했던 행으로 복귀.
- 상태 칩 / 정렬 헤더는 button 으로 구현, `aria-pressed` 활용.
- 색상만으로 상태 구분 금지 — StatusPill 은 icon + 텍스트를 모두 포함(현재 패턴 유지).

## 8. 테스트 계획

이 프로젝트는 프론트엔드에 jest/vitest 가 없다. CI 의 lint + tsc + build 로 정적 검증 후, 다음 수동 시나리오를 실행한다:

1. 사이드바 "전체" 선택 → 모든 클러스터의 잡이 한 리스트로 보임.
2. 사이드바에서 특정 클러스터 선택 → 그 클러스터의 잡만 보이고, 클러스터 컬럼이 사라지며, 헤더에 클러스터 정보가 표시됨, 하단에 "미등록 잡 타입" 칩이 노출.
3. 상태 칩 "⚠ 실패" 클릭 → error/timeout/auth_error/connect_error 만 노출. "전체" 클릭 시 reset.
4. 검색 input 에 잡 이름 일부 입력 → 실시간 필터링.
5. 행 클릭 → 우측에 슬라이드오버 펼침. ESC / 외부 클릭 / 헤더 ✕ 로 닫힘.
6. 슬라이드오버에서 "▶ 지금 실행" 클릭 → RunForm 펼침. 비밀번호 미입력 시 검증 에러. 성공/실패 모두 결과 영역에 표시.
7. 슬라이드오버의 최근 이력 행 클릭 → 같은 슬라이드오버 안에서 상세 영역 펼침.
8. "+ 새 잡" → wizard step 1 → 2 → 3. 클러스터 / 타입 prefilled 시(미등록 타입 칩에서 진입) 잘 들어가는지.
9. 등록 성공 → 모달 닫히고 새로 만든 잡이 자동 선택(슬라이드오버 펼침).
10. 잡 삭제(케밥 메뉴 → 삭제) → 확인 후 사라지고 슬라이드오버 자동 닫힘.
11. 다크 모드 전환 → 모든 칩 / 행 / 슬라이드오버 색상 정상.
12. 1024 / 1440 / 1600px 폭에서 레이아웃 정상.

## 9. 백엔드 변경

**없음.** `useBatchJobs`, `useBatchJobTypes`, `useBatchJobRuns`, `useRunBatchJob`, `useCreateBatchJob`, `useDeleteBatchJob` 모두 그대로 사용. cron 다음 실행 시각 계산은 Phase 2 에서 클라이언트 cron parser (`cronstrue` + `cron-parser`) 도입 시 추가.

## 10. 마이그레이션 / 호환성

- 라우트 `/batch-jobs` 그대로 유지.
- 페이지 컴포넌트는 동일 export(`BatchJobsPage`), App.tsx 변경 없음.
- 기존 사이드바 메뉴 항목 변경 없음.
- 같은 잡 데이터 모델, 같은 API → 데이터 호환성 100%.

## 11. Phase 2 후보 (이번 PR 에 포함하지 않음)

- 일괄 선택 / 일괄 실행 / 일괄 비활성화 (백엔드 bulk endpoint 필요)
- cron 다음 실행 시각 계산 + 사람이 읽는 cron 설명
- 잡 상세 페이지(별도 라우트) + 전체 이력 페이지
- CSV / JSON 내보내기
- 잡 활성/비활성 토글 inline (현재 `enabled` 필드 변경은 별도 update API 호출 필요)

## 12. 위험 / 트레이드오프

- **PR 사이즈 큼** — 페이지 거의 재작성. 단일 PR 이지만 컴포넌트 분리로 리뷰가 가능한 단위로 쪼개진다.
- **"누락된 잡 발견" UX 변경** — 매트릭스의 빈 셀이 사라지면서 직관성이 일부 손실되지만, UnregisteredTypeChips 로 대체. 전체 모드에서는 누락 발견이 어렵다는 점은 한계로 남는다(Phase 2 의 "클러스터 × 타입 미니맵 카드" 로 보완 가능).
- **슬라이드오버 폭 380px** — 작은 모니터에서 본문이 좁아진다. 처음 구현은 fixed positioning + overlay 대신 dock 으로 가되, 1280px 이하에서는 overlay 로 fallback 한다.
- **JSON params 입력** — 여전히 textarea. 향후 schema-driven form 으로 개선 여지(Phase 2).

---

## 13. 의사결정 기록

| # | 결정 | 대안 | 선택 이유 |
|---|---|---|---|
| 1 | 잡 중심 리스트 + ClusterSidebar | 매트릭스 유지 / 매트릭스 폐기 단순 리스트 | 사용자가 사이드바 격리 동선을 명시 선택 |
| 2 | 슬라이드오버 안에 실행 폼 펼침 | 별도 RunModal 유지 / 스마트 기본값 | 컨텍스트 유지, 다층 모달 회피 |
| 3 | 3단계 wizard | 단일 폼 그룹화 / 타입별 프리셋 | 11개 필드를 한 화면에 펼치지 않음, 진행 indicator 제공 |
| 4 | Phase 1 = 레이아웃 + 슬라이드오버 + wizard | 일괄 액션까지 포함 / 전부 한 번에 | 리뷰 가능 사이즈, 백엔드 변경 0 |
| 5 | 미등록 잡 타입 칩(단일 모드만) | 전체 모드에서도 노출 / 미노출 | 클러스터별로 다른 누락 정보 — 전체 모드에 노출하면 노이즈 |
| 6 | 본문 + 슬라이드오버 모두 MacCard | 직접 div wrapper | 다른 페이지(Dashboard·CiliumTracePage) 와 시각 일관성. CLAUDE.md 의 "Every major UI section is wrapped in a MacCard" 준수 |
| 7 | 페이지 헤더 = 아이콘박스 + h1 + subtitle + CTA | 단순 h1 + 우측 CTA | CiliumTracePage / 그 외 단일-클러스터 페이지와 동일 패턴 |
| 8 | StatusPill 을 `components/batch-jobs/` 가 아닌 별도 location | 페이지 내부 inline | 다른 페이지(Daily check, Playbooks 등) 의 향후 status 표시에 재사용 여지 |
