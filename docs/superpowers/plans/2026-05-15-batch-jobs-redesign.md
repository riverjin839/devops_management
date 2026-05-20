# BatchJobsPage UX/UI 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec `docs/superpowers/specs/2026-05-15-batch-jobs-redesign-design.md` 의 Phase 1(레이아웃·슬라이드오버·wizard) 을 8개 task 로 분할 구현해 `frontend/src/pages/BatchJobsPage.tsx` 를 잡 중심 리스트 + ClusterSidebar(iconOnly) + dock 슬라이드오버 + 3단계 wizard 로 재작성한다.

**Architecture:** 매트릭스 폐기, 잡 중심 단일 테이블. 컴포넌트는 `frontend/src/components/batch-jobs/` 로 분리(StatusPill·BatchJobFilters·BatchJobTable·BatchJobRow·UnregisteredTypeChips·BatchJobSlideOver + 부속·CreateBatchJobWizard + 3 step). 페이지 컴포넌트는 cluster 선택·필터·선택된 잡 id·wizard ctx 4개 상태만 보유. 데이터는 기존 TanStack Query hook 그대로 — 신규 백엔드 변경 없음.

**Tech Stack:** React 18 + TypeScript 5.3, Vite 5, Tailwind 3, shadcn/ui, TanStack Query 5, Zustand 4, lucide-react. 프론트엔드에 jest/vitest 없음 — 각 task 의 검증은 `npx tsc --noEmit` + `npm run lint` (max-warnings 0) + 수동 시나리오로 진행.

**Conventions:**
- 모든 명령은 `frontend/` 디렉토리에서 실행한다 (`cd frontend && <cmd>`).
- 모든 컴포넌트는 함수형 + named export. default export 금지 (다른 컴포넌트 패턴과 일치).
- raw hex 금지. CLAUDE.md 디자인 토큰만 사용.
- 한 컴포넌트 안에서 status 색·라운드·shadow·spacing 은 spec §4.8 참조.

---

## File Structure

신규 생성:

| 파일 | 책임 |
|---|---|
| `frontend/src/components/batch-jobs/index.ts` | barrel export |
| `frontend/src/components/batch-jobs/types.ts` | `FilterKey`, `BatchJobStatus` union 등 로컬 타입 |
| `frontend/src/components/batch-jobs/StatusPill.tsx` | 기존 inline `StatusPill` 추출 + 재사용 가능 export |
| `frontend/src/components/batch-jobs/BatchJobFilters.tsx` | 상태 칩 + 검색 input (UI 만) |
| `frontend/src/components/batch-jobs/filters.ts` | 필터 predicates + `applyFilter` 헬퍼 (component file 과 분리 — react-refresh/only-export-components 룰 충족) |
| `frontend/src/components/batch-jobs/BatchJobTable.tsx` | 테이블 컨테이너 + 정렬 헤더 + 빈 상태 |
| `frontend/src/components/batch-jobs/BatchJobRow.tsx` | 행 1개 (status pill·이름·메타·meta cells) |
| `frontend/src/components/batch-jobs/UnregisteredTypeChips.tsx` | 단일 클러스터 모드 하단 미등록 타입 칩 영역 |
| `frontend/src/components/batch-jobs/BatchJobSlideOver.tsx` | 슬라이드오버 컨테이너 (MacCard, sticky) |
| `frontend/src/components/batch-jobs/BatchJobSlideOver.RunHistory.tsx` | 최근 5건 이력 영역 + 상세 펼침 |
| `frontend/src/components/batch-jobs/BatchJobSlideOver.RunForm.tsx` | 실행 폼 (expandable) + 결과 표시 |
| `frontend/src/components/batch-jobs/CreateBatchJobWizard.tsx` | wizard 컨테이너 (3단계 indicator + step routing) |
| `frontend/src/components/batch-jobs/CreateBatchJobWizard.StepType.tsx` | Step 1: 클러스터·타입·이름·설명 |
| `frontend/src/components/batch-jobs/CreateBatchJobWizard.StepHost.tsx` | Step 2: 호스트·포트·사용자·params |
| `frontend/src/components/batch-jobs/CreateBatchJobWizard.StepSchedule.tsx` | Step 3: cron·저장 자격증명 |

기존 수정:

| 파일 | 변경 |
|---|---|
| `frontend/src/pages/BatchJobsPage.tsx` | 거의 완전 재작성 — 위 컴포넌트들의 orchestrator 가 됨. 기존 inline 컴포넌트(CreateJobModal, RunModal, JobRunsModal, RunDetailModal, JobCell, JobEntry, StatusPill) 모두 제거 |

---

## Task 1: 기초 — types, StatusPill 추출, barrel

**Files:**
- Create: `frontend/src/components/batch-jobs/types.ts`
- Create: `frontend/src/components/batch-jobs/StatusPill.tsx`
- Create: `frontend/src/components/batch-jobs/index.ts`

- [ ] **Step 1: types.ts 생성**

```ts
// frontend/src/components/batch-jobs/types.ts
// BatchJobsPage 전용 로컬 타입.

/** 상태 필터 칩에서 사용하는 키. 'all' 은 reset(모두 표시). */
export type FilterKey =
  | 'all'
  | 'failed'      // error / timeout / auth_error / connect_error
  | 'running'
  | 'ok'
  | 'missing_creds';

/** 정렬 키. 정렬 방향은 별도 boolean. */
export type SortKey = 'status' | 'name' | 'lastRunAt';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** 상태 칩 메타 정보 — chip 색·라벨·필터 술어. */
export interface FilterChipMeta {
  key: FilterKey;
  label: string;
  className: string; // tailwind: 활성/비활성에 따라 페이지에서 분기
  match: (job: { lastStatus: string; cron?: string | null; hasSavedPassword: boolean; hasSavedPrivateKey: boolean }) => boolean;
}

export const FAILED_STATUSES = new Set(['error', 'timeout', 'auth_error', 'connect_error']);
```

- [ ] **Step 2: StatusPill.tsx 생성 (기존 inline 컴포넌트 추출)**

```tsx
// frontend/src/components/batch-jobs/StatusPill.tsx
import { CheckCircle, Clock, Play, ShieldAlert, Wifi, XCircle } from 'lucide-react';

interface StatusMeta {
  label: string;
  cls: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const STATUS_META: Record<string, StatusMeta> = {
  ok:            { label: '정상',      cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30', Icon: CheckCircle },
  error:         { label: '에러',      cls: 'bg-red-500/10 text-red-600 border-red-500/30',             Icon: XCircle },
  timeout:       { label: '타임아웃',  cls: 'bg-amber-500/10 text-amber-600 border-amber-500/30',       Icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-orange-500/10 text-orange-600 border-orange-500/30',    Icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-slate-500/10 text-slate-600 border-slate-500/30',       Icon: Wifi },
  running:       { label: '실행 중',   cls: 'bg-blue-500/10 text-blue-600 border-blue-500/30',          Icon: Play },
  unknown:       { label: '미실행',    cls: 'bg-muted text-muted-foreground border-border',             Icon: Clock },
};

interface StatusPillProps {
  status: string;
  /** 기본 사이즈 mini(text-[11px]) — 표 / 슬라이드오버용. */
  size?: 'mini' | 'sm';
  className?: string;
}

export function StatusPill({ status, size = 'mini', className = '' }: StatusPillProps) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  const { Icon } = meta;
  const sizeCls = size === 'mini' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium ${sizeCls} ${meta.cls} ${className}`}>
      <Icon className="w-3 h-3" />
      {meta.label}
    </span>
  );
}
```

- [ ] **Step 3: index.ts barrel 생성**

```ts
// frontend/src/components/batch-jobs/index.ts
export { StatusPill } from './StatusPill';
export * from './types';
```

- [ ] **Step 4: 타입 체크 & lint 실행**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: PASS — 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/batch-jobs/
git commit -m "$(cat <<'EOF'
refactor(batch-jobs): types 와 StatusPill 컴포넌트 분리

- frontend/src/components/batch-jobs/types.ts: FilterKey, SortState, FAILED_STATUSES
- frontend/src/components/batch-jobs/StatusPill.tsx: 기존 inline 정의 추출, 재사용 가능
- barrel export 추가

이후 Task 2~7 에서 본 폴더에 컴포넌트를 점진적으로 추가한다.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: BatchJobFilters

> **Plan Correction (2026-05-19):** 원안은 `BatchJobFilters.tsx` 한 파일에 컴포넌트 + `applyFilter` 헬퍼를 같이 export 했으나 `react-refresh/only-export-components` 룰을 위반해 zero-warning 게이트를 통과하지 못함. 헬퍼와 predicates 를 `filters.ts` 로 분리해 컴포넌트 파일은 UI 만 담당하도록 수정. 외부 소비자는 barrel(`@/components/batch-jobs`) 로 import 하므로 영향 없음.

**Files:**
- Create: `frontend/src/components/batch-jobs/filters.ts` (predicates + applyFilter)
- Create: `frontend/src/components/batch-jobs/BatchJobFilters.tsx` (UI 만)
- Modify: `frontend/src/components/batch-jobs/index.ts`

- [ ] **Step 1: BatchJobFilters.tsx 작성**

```tsx
// frontend/src/components/batch-jobs/BatchJobFilters.tsx
import { Search } from 'lucide-react';
import type { BatchJob } from '@/services/api';
import { FAILED_STATUSES, type FilterKey } from './types';

interface BatchJobFiltersProps {
  jobs: BatchJob[];
  active: FilterKey;
  onChange: (key: FilterKey) => void;
  search: string;
  onSearchChange: (s: string) => void;
}

interface ChipConfig {
  key: FilterKey;
  label: string;
  baseCls: string;       // 비활성 상태 클래스
  activeCls: string;     // 활성 상태 클래스
  match: (job: BatchJob) => boolean;
}

const CHIPS: ChipConfig[] = [
  {
    key: 'all',
    label: '전체',
    baseCls: 'bg-card text-foreground border-border hover:bg-secondary',
    activeCls: 'bg-foreground text-background border-foreground',
    match: () => true,
  },
  {
    key: 'failed',
    label: '⚠ 실패',
    baseCls: 'bg-red-500/10 text-red-600 border-red-500/30 hover:bg-red-500/15',
    activeCls: 'bg-red-500 text-white border-red-500',
    match: (j) => FAILED_STATUSES.has(j.lastStatus),
  },
  {
    key: 'running',
    label: '▶ 실행 중',
    baseCls: 'bg-blue-500/10 text-blue-600 border-blue-500/30 hover:bg-blue-500/15',
    activeCls: 'bg-blue-500 text-white border-blue-500',
    match: (j) => j.lastStatus === 'running',
  },
  {
    key: 'ok',
    label: '✓ 정상',
    baseCls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30 hover:bg-emerald-500/15',
    activeCls: 'bg-emerald-500 text-white border-emerald-500',
    match: (j) => j.lastStatus === 'ok',
  },
  {
    key: 'missing_creds',
    label: '⚠ 자격증명 누락',
    baseCls: 'bg-amber-500/10 text-amber-600 border-amber-500/30 hover:bg-amber-500/15',
    activeCls: 'bg-amber-500 text-white border-amber-500',
    match: (j) => !!j.cron && !j.hasSavedPassword && !j.hasSavedPrivateKey,
  },
];

export function BatchJobFilters({ jobs, active, onChange, search, onSearchChange }: BatchJobFiltersProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {CHIPS.map((chip) => {
        const count = jobs.filter(chip.match).length;
        const isActive = active === chip.key;
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() => onChange(chip.key)}
            aria-pressed={isActive}
            className={`inline-flex items-center gap-1 px-3 py-1 rounded-full border text-xs font-medium transition-colors ${
              isActive ? chip.activeCls : chip.baseCls
            }`}
          >
            <span>{chip.label}</span>
            <span
              className={`px-1.5 rounded-full text-[10px] ${
                isActive ? 'bg-white/25 text-white' : 'bg-foreground/10 text-foreground/70'
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
      <div className="relative ml-auto">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="이름 / cron / 호스트 / 타입 검색"
          className="pl-8 pr-3 py-1.5 text-xs bg-background border border-border rounded-xl w-64 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
    </div>
  );
}

/** 페이지에서 jobs 를 필터링할 때 사용하는 헬퍼. */
export function applyFilter(jobs: BatchJob[], active: FilterKey, search: string): BatchJob[] {
  const chip = CHIPS.find((c) => c.key === active) ?? CHIPS[0];
  const q = search.trim().toLowerCase();
  return jobs.filter((j) => {
    if (!chip.match(j)) return false;
    if (!q) return true;
    return (
      j.name.toLowerCase().includes(q) ||
      j.jobType.toLowerCase().includes(q) ||
      (j.cron ?? '').toLowerCase().includes(q) ||
      (j.defaultHost ?? '').toLowerCase().includes(q)
    );
  });
}
```

- [ ] **Step 2: barrel 갱신**

```ts
// frontend/src/components/batch-jobs/index.ts
export { StatusPill } from './StatusPill';
export { BatchJobFilters } from './BatchJobFilters';
export { applyFilter, FILTER_PREDICATES } from './filters';
export * from './types';
```

- [ ] **Step 3: 타입 체크 & lint 실행**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: PASS — 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/batch-jobs/
git commit -m "$(cat <<'EOF'
feat(batch-jobs): BatchJobFilters 컴포넌트 추가

- 5개 상태 칩 (전체 / 실패 / 실행 중 / 정상 / 자격증명 누락)
- 칩마다 매칭 술어 + 카운트 자동 계산
- 검색 input (이름 / cron / 호스트 / 타입 부분일치)
- applyFilter 헬퍼 export — 페이지에서 jobs 필터링 시 사용

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: BatchJobTable + BatchJobRow

**Files:**
- Create: `frontend/src/components/batch-jobs/BatchJobRow.tsx`
- Create: `frontend/src/components/batch-jobs/BatchJobTable.tsx`
- Modify: `frontend/src/components/batch-jobs/index.ts`

- [ ] **Step 1: BatchJobRow.tsx 작성**

```tsx
// frontend/src/components/batch-jobs/BatchJobRow.tsx
import type { BatchJob } from '@/services/api';
import type { Cluster } from '@/types';
import { StatusPill } from './StatusPill';

interface BatchJobRowProps {
  job: BatchJob;
  cluster?: Cluster; // 전체 모드에서만 전달 — 단일 모드에서는 undefined
  selected: boolean;
  onClick: () => void;
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(5, 16); // MM-DD HH:mm
}

export function BatchJobRow({ job, cluster, selected, onClick }: BatchJobRowProps) {
  const hasMissingCreds = !!job.cron && !job.hasSavedPassword && !job.hasSavedPrivateKey;
  const showCluster = !!cluster;

  return (
    <tr
      onClick={onClick}
      className={`cursor-pointer transition-colors ${
        selected
          ? 'bg-primary/5 border-l-[3px] border-l-primary'
          : 'hover:bg-secondary/50 border-l-[3px] border-l-transparent'
      }`}
    >
      <td className="px-3 py-2 align-top">
        <StatusPill status={job.lastStatus} />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="font-semibold text-sm text-foreground truncate" title={job.name}>
          {job.name}
        </div>
        {!job.enabled && (
          <span className="inline-block mt-0.5 text-[10px] px-1.5 rounded bg-muted text-muted-foreground">
            off
          </span>
        )}
        {hasMissingCreds && (
          <div className="mt-0.5">
            <span className="text-[10px] text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded">
              ⚠ 자격증명 없음
            </span>
          </div>
        )}
      </td>
      {showCluster && (
        <td className="px-3 py-2 align-top">
          <span className="text-xs px-2 py-0.5 rounded bg-secondary text-secondary-foreground">
            {cluster?.name}
          </span>
        </td>
      )}
      <td className="px-3 py-2 align-top">
        <code className="text-[11px] text-muted-foreground font-mono">{job.jobType}</code>
      </td>
      <td className="px-3 py-2 align-top">
        {job.cron ? (
          <code className="text-[11px] text-muted-foreground font-mono">{job.cron}</code>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">—</span>
        )}
      </td>
      <td className="px-3 py-2 align-top text-[11px] text-muted-foreground font-mono whitespace-nowrap">
        {formatShortDate(job.lastRunAt)}
      </td>
    </tr>
  );
}
```

- [ ] **Step 2: BatchJobTable.tsx 작성**

```tsx
// frontend/src/components/batch-jobs/BatchJobTable.tsx
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { BatchJob } from '@/services/api';
import type { Cluster } from '@/types';
import { BatchJobRow } from './BatchJobRow';
import { type SortKey, type SortState } from './types';

interface BatchJobTableProps {
  jobs: BatchJob[];
  /** clusters 가 전달되면 클러스터 컬럼이 렌더된다 ('전체' 모드). */
  clusters?: Cluster[];
  selectedJobId: string | null;
  sort: SortState;
  onSortChange: (s: SortState) => void;
  onSelectJob: (job: BatchJob) => void;
  /** 빈 테이블 메시지. */
  emptyMessage?: string;
}

const STATUS_RANK: Record<string, number> = {
  error: 0,
  timeout: 1,
  auth_error: 2,
  connect_error: 3,
  running: 4,
  ok: 5,
  unknown: 6,
};

function sortJobs(jobs: BatchJob[], { key, dir }: SortState): BatchJob[] {
  const arr = [...jobs];
  arr.sort((a, b) => {
    let cmp = 0;
    if (key === 'status') {
      cmp = (STATUS_RANK[a.lastStatus] ?? 99) - (STATUS_RANK[b.lastStatus] ?? 99);
    } else if (key === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (key === 'lastRunAt') {
      const av = a.lastRunAt ?? '';
      const bv = b.lastRunAt ?? '';
      cmp = av < bv ? -1 : av > bv ? 1 : 0;
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return arr;
}

function SortHeader({
  label, sortKey, current, onChange, width,
}: {
  label: string; sortKey: SortKey; current: SortState; onChange: (s: SortState) => void; width?: string;
}) {
  const active = current.key === sortKey;
  const Icon = !active ? ArrowUpDown : current.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/40"
      style={width ? { width } : undefined}
    >
      <button
        type="button"
        onClick={() => onChange({ key: sortKey, dir: active && current.dir === 'desc' ? 'asc' : 'desc' })}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
        aria-sort={active ? (current.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <Icon className="w-3 h-3" />
      </button>
    </th>
  );
}

export function BatchJobTable({
  jobs, clusters, selectedJobId, sort, onSortChange, onSelectJob, emptyMessage,
}: BatchJobTableProps) {
  const clusterMap = clusters
    ? Object.fromEntries(clusters.map((c) => [c.id, c]))
    : null;

  const sorted = sortJobs(jobs, sort);

  if (sorted.length === 0) {
    return (
      <div className="text-center text-sm text-muted-foreground py-10">
        {emptyMessage ?? '표시할 잡이 없습니다.'}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border">
            <SortHeader label="상태" sortKey="status" current={sort} onChange={onSortChange} width="100px" />
            <SortHeader label="잡" sortKey="name" current={sort} onChange={onSortChange} />
            {clusterMap && (
              <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/40" style={{ width: '110px' }}>
                클러스터
              </th>
            )}
            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/40" style={{ width: '120px' }}>
              타입
            </th>
            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/40" style={{ width: '110px' }}>
              cron
            </th>
            <SortHeader label="최근 실행" sortKey="lastRunAt" current={sort} onChange={onSortChange} width="120px" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((job) => (
            <BatchJobRow
              key={job.id}
              job={job}
              cluster={clusterMap ? clusterMap[job.clusterId] : undefined}
              selected={selectedJobId === job.id}
              onClick={() => onSelectJob(job)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: barrel 갱신**

```ts
// frontend/src/components/batch-jobs/index.ts
export { StatusPill } from './StatusPill';
export { BatchJobFilters } from './BatchJobFilters';
export { applyFilter, FILTER_PREDICATES } from './filters';
export { BatchJobRow } from './BatchJobRow';
export { BatchJobTable } from './BatchJobTable';
export * from './types';
```

- [ ] **Step 4: 타입 체크 & lint 실행**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: PASS — 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/batch-jobs/
git commit -m "$(cat <<'EOF'
feat(batch-jobs): BatchJobTable + BatchJobRow 컴포넌트 추가

- 정렬 가능 헤더 (상태 / 이름 / 최근 실행) - aria-sort 지원
- 행 선택 시 좌측 primary border + tint
- 클러스터 컬럼은 'clusters' prop 전달 시에만 노출 (전체 모드용)
- 자격증명 누락 잡은 행 안에서 amber 배지로 표시
- enabled=false 잡은 'off' 배지

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: UnregisteredTypeChips

**Files:**
- Create: `frontend/src/components/batch-jobs/UnregisteredTypeChips.tsx`
- Modify: `frontend/src/components/batch-jobs/index.ts`

- [ ] **Step 1: UnregisteredTypeChips.tsx 작성**

```tsx
// frontend/src/components/batch-jobs/UnregisteredTypeChips.tsx
import { Plus } from 'lucide-react';
import type { BatchJob, BatchJobTypeDescriptor } from '@/services/api';

interface UnregisteredTypeChipsProps {
  /** 단일 클러스터 모드의 그 클러스터에 등록된 잡들. */
  clusterJobs: BatchJob[];
  /** 전체 잡 타입 정의. */
  allTypes: BatchJobTypeDescriptor[];
  /** 칩 클릭 → wizard 가 jobType prefilled 로 열림. */
  onPick: (jobType: string) => void;
}

export function UnregisteredTypeChips({ clusterJobs, allTypes, onPick }: UnregisteredTypeChipsProps) {
  const registered = new Set(clusterJobs.map((j) => j.jobType));
  const missing = allTypes.filter((t) => !registered.has(t.jobType));

  if (missing.length === 0) return null;

  return (
    <div className="pt-3 border-t border-dashed border-border">
      <div className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wider">
        미등록 잡 타입
      </div>
      <div className="flex flex-wrap gap-2">
        {missing.map((t) => (
          <button
            key={t.jobType}
            type="button"
            onClick={() => onPick(t.jobType)}
            title={t.description}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-full border border-dashed border-border bg-card hover:bg-secondary hover:border-primary/40 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <Plus className="w-3 h-3" />
            {t.label}
            <span className="text-[10px] opacity-60 font-mono">{t.jobType}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: barrel 갱신**

```ts
// frontend/src/components/batch-jobs/index.ts
export { StatusPill } from './StatusPill';
export { BatchJobFilters } from './BatchJobFilters';
export { applyFilter, FILTER_PREDICATES } from './filters';
export { BatchJobRow } from './BatchJobRow';
export { BatchJobTable } from './BatchJobTable';
export { UnregisteredTypeChips } from './UnregisteredTypeChips';
export * from './types';
```

- [ ] **Step 3: 타입 체크 & lint 실행**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: PASS — 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/batch-jobs/
git commit -m "$(cat <<'EOF'
feat(batch-jobs): UnregisteredTypeChips 컴포넌트 추가

단일 클러스터 모드 하단에 노출되는 미등록 잡 타입 칩.
클릭 시 wizard 가 (clusterId + jobType) prefilled 로 열린다.
매트릭스 뷰가 가졌던 '누락된 잡 발견' 동선을 대체.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: BatchJobSlideOver (RunHistory + RunForm + 컨테이너)

**Files:**
- Create: `frontend/src/components/batch-jobs/BatchJobSlideOver.RunHistory.tsx`
- Create: `frontend/src/components/batch-jobs/BatchJobSlideOver.RunForm.tsx`
- Create: `frontend/src/components/batch-jobs/BatchJobSlideOver.tsx`
- Modify: `frontend/src/components/batch-jobs/index.ts`

- [ ] **Step 1: BatchJobSlideOver.RunHistory.tsx 작성**

```tsx
// frontend/src/components/batch-jobs/BatchJobSlideOver.RunHistory.tsx
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { BatchJobRun } from '@/services/api';
import { LogViewer } from '@/components/common';
import { StatusPill } from './StatusPill';

interface RunHistoryProps {
  runs: BatchJobRun[];
  isLoading: boolean;
}

function formatShortDate(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

function RunDetail({ run }: { run: BatchJobRun }) {
  return (
    <div className="mt-2 space-y-2 bg-secondary/30 rounded-lg p-2">
      {run.executedCommand && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">command</p>
          <pre className="text-[10px] font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap">
            {run.executedCommand}
          </pre>
        </div>
      )}
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">stdout</p>
        <LogViewer text={run.stdout} maxHeight="max-h-[200px]" />
      </div>
      {run.stderr && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">stderr</p>
          <LogViewer text={run.stderr} maxHeight="max-h-[160px]" asError />
        </div>
      )}
      {run.error && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">error</p>
          <pre className="text-[10px] font-mono bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-400 rounded p-2 overflow-auto whitespace-pre-wrap">
            {run.error}
          </pre>
        </div>
      )}
    </div>
  );
}

export function RunHistory({ runs, isLoading }: RunHistoryProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading) {
    return <p className="text-xs text-muted-foreground py-2">이력 로딩 중…</p>;
  }
  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground py-2">아직 실행 이력이 없습니다.</p>;
  }

  const shown = runs.slice(0, 5);
  return (
    <div className="space-y-1">
      {shown.map((run) => {
        const open = openId === run.id;
        return (
          <div key={run.id} className="border border-border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setOpenId(open ? null : run.id)}
              className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-secondary/50 transition-colors text-left"
            >
              <StatusPill status={run.status} />
              <span className="flex-1 min-w-0 text-[11px] font-mono text-muted-foreground truncate">
                {formatShortDate(run.startedAt)}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                {run.durationMs}ms
              </span>
              {open ? (
                <ChevronUp className="w-3 h-3 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-3 h-3 text-muted-foreground" />
              )}
            </button>
            {open && (
              <div className="px-2.5 pb-2 border-t border-border">
                <RunDetail run={run} />
              </div>
            )}
          </div>
        );
      })}
      {runs.length > 5 && (
        <p className="text-[10px] text-muted-foreground text-center pt-1">
          최근 5건만 표시 · 총 {runs.length}건
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: BatchJobSlideOver.RunForm.tsx 작성**

```tsx
// frontend/src/components/batch-jobs/BatchJobSlideOver.RunForm.tsx
import { useId, useState } from 'react';
import { Play } from 'lucide-react';
import type { BatchJob, BatchJobRun } from '@/services/api';
import { LogViewer, MasterHostPicker } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useRunBatchJob } from '@/hooks/useBatchJobs';
import { StatusPill } from './StatusPill';

interface RunFormProps {
  job: BatchJob;
}

export function RunForm({ job }: RunFormProps) {
  const run = useRunBatchJob();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [host, setHost] = useState(job.defaultHost ?? '');
  const [hostSelectedName, setHostSelectedName] = useState('');
  const [hostCustom, setHostCustom] = useState(job.defaultHost ?? '');
  const [port, setPort] = useState(job.defaultPort);
  const [username, setUsername] = useState(job.defaultUsername);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [paramOverrideJson, setParamOverrideJson] = useState('');
  const [timeoutSec, setTimeoutSec] = useState(120);
  const [result, setResult] = useState<BatchJobRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setResult(null);
    if (!host.trim()) { setError('호스트를 입력해주세요.'); return; }
    if (!password && !privateKey) { setError('비밀번호 또는 개인키 중 하나는 필수입니다.'); return; }
    let paramOverride: Record<string, unknown> | undefined;
    if (paramOverrideJson.trim()) {
      try {
        paramOverride = JSON.parse(paramOverrideJson);
      } catch {
        setError('paramOverride JSON 파싱 실패.');
        return;
      }
    }
    try {
      const { data } = await run.mutateAsync({
        id: job.id,
        payload: {
          host: host.trim(),
          port,
          username: username.trim() || 'root',
          password: password || undefined,
          privateKey: privateKey || undefined,
          paramOverride,
          timeout: timeoutSec,
        },
      });
      setResult(data);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  return (
    <div className="space-y-3">
      <MasterHostPicker
        clusterId={job.clusterId}
        customHost={hostCustom}
        selectedName={hostSelectedName}
        label="호스트"
        compact
        onChange={({ selectedName, customHost, effectiveHost }) => {
          setHostSelectedName(selectedName);
          setHostCustom(customHost);
          setHost(effectiveHost);
        }}
      />

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={f('port')} className="block text-[10px] text-muted-foreground mb-1">포트</label>
          <input
            id={f('port')}
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value) || 22)}
            className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl"
          />
        </div>
        <div>
          <label htmlFor={f('user')} className="block text-[10px] text-muted-foreground mb-1">사용자</label>
          <input
            id={f('user')}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl font-mono"
          />
        </div>
      </div>

      <div>
        <label htmlFor={f('pw')} className="block text-[10px] text-muted-foreground mb-1">비밀번호</label>
        <input
          id={f('pw')}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl"
        />
      </div>

      <details>
        <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
          개인키 (PEM, 선택) / paramOverride / 타임아웃
        </summary>
        <div className="mt-2 space-y-2">
          <div>
            <label htmlFor={f('pem')} className="block text-[10px] text-muted-foreground mb-1">개인키 (PEM)</label>
            <textarea
              id={f('pem')}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              rows={3}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="w-full px-2 py-1.5 text-[11px] bg-background border border-border rounded-xl font-mono"
            />
          </div>
          <div>
            <label htmlFor={f('override')} className="block text-[10px] text-muted-foreground mb-1">paramOverride (JSON)</label>
            <textarea
              id={f('override')}
              value={paramOverrideJson}
              onChange={(e) => setParamOverrideJson(e.target.value)}
              rows={2}
              placeholder='{"endpoints": "https://10.0.0.1:2379"}'
              className="w-full px-2 py-1.5 text-[11px] bg-background border border-border rounded-xl font-mono"
            />
          </div>
          <div>
            <label htmlFor={f('to')} className="block text-[10px] text-muted-foreground mb-1">타임아웃 (초)</label>
            <input
              id={f('to')}
              type="number"
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(Number(e.target.value) || 60)}
              className="w-full px-2 py-1.5 text-xs bg-background border border-border rounded-xl"
            />
          </div>
        </div>
      </details>

      {error && <div className="text-[11px] text-red-500">{error}</div>}

      <button
        type="button"
        onClick={submit}
        disabled={run.isPending}
        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl mac-shadow disabled:opacity-60"
      >
        <Play className="w-3.5 h-3.5" />
        {run.isPending ? '실행 중…' : '실행'}
      </button>

      {result && (
        <div className="border border-border rounded-xl overflow-hidden">
          <div className="px-2.5 py-1.5 border-b border-border bg-secondary/40 flex items-center gap-2 flex-wrap">
            <StatusPill status={result.status} />
            {result.exitCode !== null && result.exitCode !== undefined && (
              <span className="text-[10px] font-mono text-muted-foreground">exit {result.exitCode}</span>
            )}
            <span className="text-[10px] font-mono text-muted-foreground">{result.durationMs}ms</span>
          </div>
          <div className="p-2 space-y-2">
            {result.executedCommand && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">command</p>
                <pre className="text-[10px] font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap">
                  {result.executedCommand}
                </pre>
              </div>
            )}
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">stdout</p>
              <LogViewer text={result.stdout} maxHeight="max-h-[200px]" />
            </div>
            {result.stderr && (
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">stderr</p>
                <LogViewer text={result.stderr} maxHeight="max-h-[160px]" asError />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: BatchJobSlideOver.tsx (컨테이너) 작성**

```tsx
// frontend/src/components/batch-jobs/BatchJobSlideOver.tsx
import { useEffect, useState } from 'react';
import { Play, History, Trash2, X } from 'lucide-react';
import type { BatchJob } from '@/services/api';
import { MacCard } from '@/components/ui/MacCard';
import { useBatchJobRuns } from '@/hooks/useBatchJobs';
import { RunForm } from './BatchJobSlideOver.RunForm';
import { RunHistory } from './BatchJobSlideOver.RunHistory';

interface BatchJobSlideOverProps {
  job: BatchJob;
  onClose: () => void;
  onDelete: (job: BatchJob) => void;
  /** 좁은 뷰포트 (< 1280px) 에서 overlay drawer 로 표시. */
  overlayMode?: boolean;
}

export function BatchJobSlideOver({ job, onClose, onDelete, overlayMode = false }: BatchJobSlideOverProps) {
  const [runFormOpen, setRunFormOpen] = useState(false);
  const runsQ = useBatchJobRuns(job.id);

  // 잡이 바뀔 때마다 폼/이력 펼침 reset.
  useEffect(() => {
    setRunFormOpen(false);
  }, [job.id]);

  // ESC 키로 닫힘.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const body = (
    <MacCard
      title={job.name}
      bodyPadding="p-4"
      rootClassName={overlayMode ? '' : 'sticky top-4'}
    >
      <div className="text-[11px] text-muted-foreground font-mono mb-3 break-all">
        {job.jobType}
      </div>

      {/* 액션 바 */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap">
        <button
          type="button"
          onClick={() => setRunFormOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl mac-shadow"
          aria-expanded={runFormOpen}
        >
          <Play className="w-3.5 h-3.5" />
          {runFormOpen ? '실행 닫기' : '지금 실행'}
        </button>
        <button
          type="button"
          onClick={() => onDelete(job)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-secondary hover:bg-red-500/10 hover:text-red-500 border border-border rounded-xl"
        >
          <Trash2 className="w-3.5 h-3.5" />
          삭제
        </button>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground"
          aria-label="닫기"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 실행 폼 — expandable */}
      {runFormOpen && (
        <div className="mb-4 pb-4 border-b border-border">
          <RunForm job={job} />
        </div>
      )}

      {/* 최근 이력 */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <History className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">최근 실행</span>
        </div>
        <RunHistory runs={runsQ.data ?? []} isLoading={runsQ.isLoading} />
      </div>
    </MacCard>
  );

  if (overlayMode) {
    return (
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
      >
        <div
          className="absolute inset-y-0 right-0 w-[min(420px,90vw)] overflow-y-auto p-4"
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </div>
      </div>
    );
  }

  return <div className="w-[380px] flex-shrink-0">{body}</div>;
}
```

- [ ] **Step 4: barrel 갱신**

```ts
// frontend/src/components/batch-jobs/index.ts
export { StatusPill } from './StatusPill';
export { BatchJobFilters } from './BatchJobFilters';
export { applyFilter, FILTER_PREDICATES } from './filters';
export { BatchJobRow } from './BatchJobRow';
export { BatchJobTable } from './BatchJobTable';
export { UnregisteredTypeChips } from './UnregisteredTypeChips';
export { BatchJobSlideOver } from './BatchJobSlideOver';
export * from './types';
```

- [ ] **Step 5: 타입 체크 & lint 실행**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: PASS — 0 errors, 0 warnings.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/batch-jobs/
git commit -m "$(cat <<'EOF'
feat(batch-jobs): BatchJobSlideOver + RunHistory + RunForm 추가

- RunHistory: 최근 5건 표시, 각 행 클릭 시 같은 패널 안에서 상세 펼침
  (기존 JobRunsModal + RunDetailModal 의 모달 중첩 제거)
- RunForm: 실행 폼 — 호스트(MasterHostPicker), 포트, 사용자, 비밀번호,
  개인키/paramOverride/타임아웃은 details 로 접힘, 결과는 폼 아래 인라인
- BatchJobSlideOver: 컨테이너 — MacCard sticky dock (≥1280px) 또는
  overlay drawer (<1280px). ESC 닫기, 잡 변경 시 폼 reset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: CreateBatchJobWizard (3 step + 컨테이너)

**Files:**
- Create: `frontend/src/components/batch-jobs/CreateBatchJobWizard.StepType.tsx`
- Create: `frontend/src/components/batch-jobs/CreateBatchJobWizard.StepHost.tsx`
- Create: `frontend/src/components/batch-jobs/CreateBatchJobWizard.StepSchedule.tsx`
- Create: `frontend/src/components/batch-jobs/CreateBatchJobWizard.tsx`
- Modify: `frontend/src/components/batch-jobs/index.ts`

- [ ] **Step 1: 공통 wizard state 타입 + 첫 step (StepType)**

```tsx
// frontend/src/components/batch-jobs/CreateBatchJobWizard.StepType.tsx
import { useEffect } from 'react';
import type { BatchJobTypeDescriptor } from '@/services/api';
import type { Cluster } from '@/types';

export interface WizardState {
  clusterId: string;
  jobType: string;
  name: string;
  description: string;
  defaultHost: string;
  hostSelectedName: string;
  hostCustom: string;
  defaultPort: number;
  defaultUsername: string;
  paramsJson: string;
  cron: string;
  savedPassword: string;
  savedPrivateKey: string;
}

export const EMPTY_WIZARD: WizardState = {
  clusterId: '',
  jobType: '',
  name: '',
  description: '',
  defaultHost: '',
  hostSelectedName: '',
  hostCustom: '',
  defaultPort: 22,
  defaultUsername: 'root',
  paramsJson: '{}',
  cron: '',
  savedPassword: '',
  savedPrivateKey: '',
};

interface StepTypeProps {
  clusters: Cluster[];
  types: BatchJobTypeDescriptor[];
  /** 부모가 clusterId 를 미리 정해 두면 select 가 readonly 로 표시된다. */
  fixedClusterId?: string;
  state: WizardState;
  onChange: (next: Partial<WizardState>) => void;
}

export function StepType({ clusters, types, fixedClusterId, state, onChange }: StepTypeProps) {
  // 선택된 타입의 label / description 을 이름/설명에 자동 채움 (사용자가 비워둔 경우에만).
  useEffect(() => {
    const t = types.find((x) => x.jobType === state.jobType);
    if (!t) return;
    if (!state.name) onChange({ name: t.label });
    if (!state.description) onChange({ description: t.description });
    if (state.paramsJson === '{}' || !state.paramsJson) {
      onChange({ paramsJson: JSON.stringify(t.defaultParams ?? {}, null, 2) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.jobType, types]);

  const selectedType = types.find((t) => t.jobType === state.jobType);

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">클러스터</label>
        <select
          value={state.clusterId}
          onChange={(e) => onChange({ clusterId: e.target.value })}
          disabled={!!fixedClusterId}
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl disabled:bg-secondary/50 disabled:text-muted-foreground"
        >
          <option value="">선택하세요…</option>
          {clusters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.region ? ` (${c.region})` : ''}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">잡 타입</label>
        <select
          value={state.jobType}
          onChange={(e) => onChange({ jobType: e.target.value, name: '', description: '', paramsJson: '{}' })}
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
        >
          <option value="">선택하세요…</option>
          {types.map((t) => (
            <option key={t.jobType} value={t.jobType}>
              {t.label} ({t.jobType})
            </option>
          ))}
        </select>
        {selectedType?.description && (
          <p className="mt-1 text-[11px] text-muted-foreground">{selectedType.description}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">이름</label>
          <input
            value={state.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
            placeholder="잡 이름"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">설명 (선택)</label>
          <input
            value={state.description}
            onChange={(e) => onChange({ description: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
          />
        </div>
      </div>
    </div>
  );
}

export function isStepTypeValid(state: WizardState): boolean {
  return !!state.clusterId && !!state.jobType && state.name.trim().length > 0;
}
```

- [ ] **Step 2: StepHost.tsx 작성**

```tsx
// frontend/src/components/batch-jobs/CreateBatchJobWizard.StepHost.tsx
import type { BatchJobTypeDescriptor } from '@/services/api';
import { MasterHostPicker } from '@/components/common';
import type { WizardState } from './CreateBatchJobWizard.StepType';

interface StepHostProps {
  types: BatchJobTypeDescriptor[];
  state: WizardState;
  onChange: (next: Partial<WizardState>) => void;
}

export function StepHost({ types, state, onChange }: StepHostProps) {
  const selectedType = types.find((t) => t.jobType === state.jobType);
  return (
    <div className="space-y-4">
      <MasterHostPicker
        clusterId={state.clusterId}
        customHost={state.hostCustom}
        selectedName={state.hostSelectedName}
        label="기본 호스트 (master 노드 후보)"
        onChange={({ selectedName, customHost, effectiveHost }) =>
          onChange({
            hostSelectedName: selectedName,
            hostCustom: customHost,
            defaultHost: effectiveHost,
          })
        }
      />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">포트</label>
          <input
            type="number"
            value={state.defaultPort}
            onChange={(e) => onChange({ defaultPort: Number(e.target.value) || 22 })}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">기본 사용자</label>
          <input
            value={state.defaultUsername}
            onChange={(e) => onChange({ defaultUsername: e.target.value })}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl font-mono"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs text-muted-foreground mb-1">params (JSON)</label>
        <textarea
          value={state.paramsJson}
          onChange={(e) => onChange({ paramsJson: e.target.value })}
          rows={6}
          className="w-full px-3 py-2 text-xs bg-background border border-border rounded-xl font-mono"
        />
        {selectedType && Object.keys(selectedType.paramSchema).length > 0 && (
          <details className="mt-2 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">사용 가능한 파라미터</summary>
            <ul className="mt-1 space-y-1 pl-3">
              {Object.entries(selectedType.paramSchema).map(([k, v]) => (
                <li key={k}>
                  <span className="font-mono">{k}</span>
                  <span className="opacity-60"> ({v.type})</span>
                  {v.help && <span> — {v.help}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

export function isStepHostValid(state: WizardState): boolean {
  // params JSON 파싱 가능 여부만 검증. host 는 비워두고 실행 시 입력해도 됨.
  try {
    if (state.paramsJson.trim()) JSON.parse(state.paramsJson);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: StepSchedule.tsx 작성**

```tsx
// frontend/src/components/batch-jobs/CreateBatchJobWizard.StepSchedule.tsx
import type { WizardState } from './CreateBatchJobWizard.StepType';

interface StepScheduleProps {
  state: WizardState;
  onChange: (next: Partial<WizardState>) => void;
}

export function StepSchedule({ state, onChange }: StepScheduleProps) {
  const needsCreds = !!state.cron.trim();
  const hasCreds = !!state.savedPassword || !!state.savedPrivateKey;
  const credsMissing = needsCreds && !hasCreds;

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">cron 식 (선택)</label>
        <input
          value={state.cron}
          onChange={(e) => onChange({ cron: e.target.value })}
          placeholder="0 3 * * *"
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl font-mono"
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          cron 을 비워두면 수동 실행 전용 잡이 됩니다.
        </p>
      </div>

      <div className="border border-border rounded-xl px-3 py-3 bg-secondary/30">
        <div className="text-xs font-medium mb-1">
          저장된 자격증명
          <span className="text-muted-foreground"> (cron 사용 시 필수, 수동 실행에는 불필요)</span>
        </div>
        <p className="text-[11px] text-muted-foreground mb-3">
          서버의 SECRET_KEY 로 암호화되어 저장됩니다.
        </p>

        <div className="space-y-2">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">저장 비밀번호</label>
            <input
              type="password"
              autoComplete="new-password"
              value={state.savedPassword}
              onChange={(e) => onChange({ savedPassword: e.target.value })}
              className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">저장 개인키 (PEM)</label>
            <textarea
              value={state.savedPrivateKey}
              onChange={(e) => onChange({ savedPrivateKey: e.target.value })}
              rows={3}
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              className="w-full px-3 py-2 text-[11px] bg-background border border-border rounded-xl font-mono"
            />
          </div>
        </div>

        {credsMissing && (
          <div className="mt-2 text-[11px] text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2">
            ⚠ cron 이 설정되어 있지만 저장된 자격증명이 없어 스케줄 실행이 동작하지 않습니다.
            지금 입력하지 않으면 등록 후 잡 패널에서 추가할 수 있습니다.
          </div>
        )}
      </div>
    </div>
  );
}

/** Step3 은 항상 통과 가능 — 경고만 표시. */
export function isStepScheduleValid(): boolean {
  return true;
}
```

- [ ] **Step 4: CreateBatchJobWizard.tsx (컨테이너) 작성**

```tsx
// frontend/src/components/batch-jobs/CreateBatchJobWizard.tsx
import { useEffect, useState } from 'react';
import type { BatchJob } from '@/services/api';
import { useClusters } from '@/hooks/useCluster';
import { useBatchJobTypes, useCreateBatchJob } from '@/hooks/useBatchJobs';
import { formatApiError } from '@/lib/utils';
import {
  EMPTY_WIZARD,
  StepType,
  isStepTypeValid,
  type WizardState,
} from './CreateBatchJobWizard.StepType';
import { StepHost, isStepHostValid } from './CreateBatchJobWizard.StepHost';
import { StepSchedule, isStepScheduleValid } from './CreateBatchJobWizard.StepSchedule';

interface CreateBatchJobWizardProps {
  open: boolean;
  /** 호출자가 미리 정해둔 cluster — wizard 가 step 1 에서 select 를 readonly 로 표시. */
  defaultClusterId?: string;
  /** 호출자가 미리 정해둔 jobType. */
  defaultJobType?: string;
  onClose: () => void;
  /** 등록 성공 시 새 잡을 인자로 전달 — 부모에서 자동 선택. */
  onCreated: (job: BatchJob) => void;
}

const STEP_LABELS = ['잡 종류', '호스트 / 파라미터', '스케줄 / 자격증명'];

export function CreateBatchJobWizard({
  open, defaultClusterId, defaultJobType, onClose, onCreated,
}: CreateBatchJobWizardProps) {
  const { data: clusters = [] } = useClusters();
  const typesQ = useBatchJobTypes();
  const create = useCreateBatchJob();

  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [state, setState] = useState<WizardState>(EMPTY_WIZARD);
  const [error, setError] = useState<string | null>(null);

  // open 될 때마다 초기화 + prefilled 값 적용.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setError(null);
    setState({
      ...EMPTY_WIZARD,
      clusterId: defaultClusterId ?? '',
      jobType: defaultJobType ?? '',
    });
  }, [open, defaultClusterId, defaultJobType]);

  if (!open) return null;

  const types = typesQ.data ?? [];

  const update = (next: Partial<WizardState>) => setState((s) => ({ ...s, ...next }));

  const goNext = () => {
    setError(null);
    if (step === 0 && !isStepTypeValid(state)) {
      setError('클러스터, 잡 타입, 이름은 필수입니다.');
      return;
    }
    if (step === 1 && !isStepHostValid(state)) {
      setError('params JSON 파싱에 실패했습니다.');
      return;
    }
    if (step < 2) setStep((s) => ((s + 1) as 0 | 1 | 2));
  };

  const goBack = () => {
    setError(null);
    if (step > 0) setStep((s) => ((s - 1) as 0 | 1 | 2));
  };

  const submit = async () => {
    setError(null);
    if (!isStepTypeValid(state) || !isStepHostValid(state) || !isStepScheduleValid()) {
      setError('필수 입력이 누락되었습니다.');
      return;
    }
    let params: Record<string, unknown> = {};
    try {
      params = state.paramsJson.trim() ? JSON.parse(state.paramsJson) : {};
    } catch {
      setError('params JSON 파싱 실패.');
      return;
    }
    try {
      const { data } = await create.mutateAsync({
        clusterId: state.clusterId,
        name: state.name.trim(),
        description: state.description.trim() || undefined,
        jobType: state.jobType,
        defaultHost: state.defaultHost.trim() || undefined,
        defaultPort: state.defaultPort,
        defaultUsername: state.defaultUsername.trim() || 'root',
        cron: state.cron.trim() || undefined,
        params,
        savedPassword: state.savedPassword || undefined,
        savedPrivateKey: state.savedPrivateKey || undefined,
      });
      onCreated(data);
      onClose();
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold">새 배치 잡 등록</h3>
          <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
            닫기
          </button>
        </header>

        {/* Step indicator */}
        <div className="px-5 pt-4">
          <div className="flex items-center gap-2">
            {STEP_LABELS.map((label, idx) => {
              const active = idx === step;
              const done = idx < step;
              return (
                <div key={label} className="flex items-center gap-2 flex-1">
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                      active ? 'bg-primary text-primary-foreground' :
                      done ? 'bg-emerald-500 text-white' :
                      'bg-secondary text-muted-foreground'
                    }`}
                  >
                    {idx + 1}
                  </div>
                  <span className={`text-xs ${active ? 'text-foreground font-medium' : 'text-muted-foreground'} truncate`}>
                    {label}
                  </span>
                  {idx < STEP_LABELS.length - 1 && <div className="flex-1 h-px bg-border" />}
                </div>
              );
            })}
          </div>
        </div>

        <div className="p-5 overflow-y-auto flex-1">
          {step === 0 && (
            <StepType
              clusters={clusters}
              types={types}
              fixedClusterId={defaultClusterId}
              state={state}
              onChange={update}
            />
          )}
          {step === 1 && <StepHost types={types} state={state} onChange={update} />}
          {step === 2 && <StepSchedule state={state} onChange={update} />}

          {error && <div className="mt-3 text-xs text-red-500">{error}</div>}
        </div>

        <footer className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
          <button
            onClick={goBack}
            disabled={step === 0}
            className="px-3 py-1.5 text-xs rounded-xl bg-secondary text-secondary-foreground disabled:opacity-40 hover:bg-secondary/80"
          >
            이전
          </button>
          <div className="text-[11px] text-muted-foreground">
            {step + 1} / {STEP_LABELS.length}
          </div>
          {step < 2 ? (
            <button
              onClick={goNext}
              className="px-3 py-1.5 text-xs rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 mac-shadow"
            >
              다음
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={create.isPending}
              className="px-3 py-1.5 text-xs rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 mac-shadow disabled:opacity-60"
            >
              {create.isPending ? '등록 중…' : '등록'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: barrel 갱신**

```ts
// frontend/src/components/batch-jobs/index.ts
export { StatusPill } from './StatusPill';
export { BatchJobFilters } from './BatchJobFilters';
export { applyFilter, FILTER_PREDICATES } from './filters';
export { BatchJobRow } from './BatchJobRow';
export { BatchJobTable } from './BatchJobTable';
export { UnregisteredTypeChips } from './UnregisteredTypeChips';
export { BatchJobSlideOver } from './BatchJobSlideOver';
export { CreateBatchJobWizard } from './CreateBatchJobWizard';
export * from './types';
```

- [ ] **Step 6: 타입 체크 & lint 실행**

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: PASS — 0 errors, 0 warnings.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/batch-jobs/
git commit -m "$(cat <<'EOF'
feat(batch-jobs): CreateBatchJobWizard 3단계 wizard 추가

Step 1: 클러스터·잡 타입·이름·설명 (타입 선택 시 label/description/params 자동 prefill)
Step 2: 호스트(MasterHostPicker)·포트·사용자·params JSON + 스키마 details
Step 3: cron + 저장 자격증명. cron 입력했는데 자격증명이 없으면 경고 표시.

진행 indicator 헤더에 추가, 단계 검증 통과 시 다음 활성.
등록 성공 시 onCreated 콜백으로 새 잡을 전달 — 부모에서 자동 선택 가능.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: BatchJobsPage 재작성 (orchestrator)

**Files:**
- Modify: `frontend/src/pages/BatchJobsPage.tsx` (전체 재작성)

- [ ] **Step 1: 페이지 컴포넌트 전체 재작성**

기존 파일 내용을 모두 삭제하고 아래 코드로 교체:

```tsx
// frontend/src/pages/BatchJobsPage.tsx
import { useEffect, useMemo, useState } from 'react';
import { ListTree, Plus } from 'lucide-react';

import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar, ConfirmDialog } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import {
  useBatchJobTypes,
  useBatchJobs,
  useDeleteBatchJob,
} from '@/hooks/useBatchJobs';
import type { BatchJob } from '@/services/api';
import {
  BatchJobFilters,
  BatchJobSlideOver,
  BatchJobTable,
  CreateBatchJobWizard,
  UnregisteredTypeChips,
  applyFilter,
  type FilterKey,
  type SortState,
} from '@/components/batch-jobs';

const DEFAULT_SORT: SortState = { key: 'lastRunAt', dir: 'desc' };

export function BatchJobsPage() {
  const { data: clusters = [] } = useClusters();
  const allJobsQ = useBatchJobs();
  const typesQ = useBatchJobTypes();
  const del = useDeleteBatchJob();

  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null); // null = 전체
  const [statusFilter, setStatusFilter] = useState<FilterKey>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [wizardCtx, setWizardCtx] = useState<{ clusterId?: string; jobType?: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BatchJob | null>(null);

  const allJobs = useMemo(() => allJobsQ.data ?? [], [allJobsQ.data]);
  const types = useMemo(() => typesQ.data ?? [], [typesQ.data]);

  // 클러스터 격리 후 필터/검색 적용.
  const scopedJobs = useMemo(() => {
    if (selectedClusterId === null) return allJobs;
    return allJobs.filter((j) => j.clusterId === selectedClusterId);
  }, [allJobs, selectedClusterId]);

  const visibleJobs = useMemo(
    () => applyFilter(scopedJobs, statusFilter, search),
    [scopedJobs, statusFilter, search],
  );

  // 잡이 사라지면 selectedJobId 자동 정리.
  const selectedJob = useMemo(
    () => allJobs.find((j) => j.id === selectedJobId) ?? null,
    [allJobs, selectedJobId],
  );
  useEffect(() => {
    if (selectedJobId && !selectedJob) setSelectedJobId(null);
  }, [selectedJobId, selectedJob]);

  // 좁은 뷰포트 (<1280px) 에서 슬라이드오버 overlay 모드.
  const [overlayMode, setOverlayMode] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1279px)');
    const sync = () => setOverlayMode(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // 페이지 헤더 부제 텍스트.
  const headerSubtitle = useMemo(() => {
    if (selectedClusterId === null) {
      return `전체 ${clusters.length}개 클러스터 · 등록 잡 ${allJobs.length}`;
    }
    const c = clusters.find((x) => x.id === selectedClusterId);
    const stats = {
      total: scopedJobs.length,
      failed: scopedJobs.filter((j) =>
        ['error', 'timeout', 'auth_error', 'connect_error'].includes(j.lastStatus),
      ).length,
      running: scopedJobs.filter((j) => j.lastStatus === 'running').length,
    };
    return `${c?.name ?? selectedClusterId}${c?.region ? ` · ${c.region}` : ''} · 잡 ${stats.total} · 실패 ${stats.failed} · 실행 중 ${stats.running}`;
  }, [selectedClusterId, clusters, allJobs.length, scopedJobs]);

  const canCreate = clusters.length > 0 && types.length > 0;

  // "+ 새 잡" 헤더 버튼: 단일 모드면 그 cluster 로 prefilled, 전체 모드면 빈 wizard.
  const openCreateFromHeader = () => {
    setWizardCtx({ clusterId: selectedClusterId ?? undefined });
  };

  // 미등록 타입 칩에서 잡 타입 prefilled 로 진입.
  const openCreateFromMissingType = (jobType: string) => {
    setWizardCtx({ clusterId: selectedClusterId ?? undefined, jobType });
  };

  return (
    <div className="min-h-screen bg-background flex">
      <ClusterSidebar
        clusters={clusters}
        selectedId={selectedClusterId}
        onSelect={(id) => setSelectedClusterId(id ?? null)}
        allowAll
        allLabel="전체"
        iconOnly
      />

      <main className="flex-1 min-w-0 px-4 lg:px-6 py-5 space-y-4 max-w-[1700px]">
        {/* Page Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <ListTree className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold leading-tight">Batch Jobs</h1>
              <p className="text-xs text-muted-foreground">{headerSubtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={openCreateFromHeader}
            disabled={!canCreate}
            className="px-3.5 py-1.5 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl mac-shadow flex items-center gap-1.5 disabled:opacity-50"
            title={
              clusters.length === 0
                ? '먼저 클러스터를 등록하세요'
                : types.length === 0
                  ? '사용 가능한 잡 타입이 없습니다'
                  : '새 배치 잡 등록'
            }
          >
            <Plus className="w-3.5 h-3.5" />
            새 잡{selectedClusterId !== null && clusters.find((c) => c.id === selectedClusterId) ? ` (${clusters.find((c) => c.id === selectedClusterId)?.name})` : ''}
          </button>
        </div>

        {/* Body: 본문 + 슬라이드오버 */}
        <div className="flex gap-4">
          <div className="flex-1 min-w-0 space-y-4">
            <MacCard title="배치 잡" bodyPadding="p-4">
              {allJobsQ.isLoading ? (
                <p className="text-xs text-muted-foreground py-6 text-center">로딩 중…</p>
              ) : clusters.length === 0 ? (
                <p className="text-sm text-muted-foreground py-10 text-center">
                  등록된 클러스터가 없습니다. /cluster-manage 에서 추가하세요.
                </p>
              ) : types.length === 0 ? (
                <p className="text-sm text-muted-foreground py-10 text-center">
                  사용 가능한 잡 타입이 없습니다 — 백엔드 batch-jobs/types 응답을 확인해 주세요.
                </p>
              ) : (
                <div className="space-y-4">
                  <BatchJobFilters
                    jobs={scopedJobs}
                    active={statusFilter}
                    onChange={setStatusFilter}
                    search={search}
                    onSearchChange={setSearch}
                  />
                  <BatchJobTable
                    jobs={visibleJobs}
                    clusters={selectedClusterId === null ? clusters : undefined}
                    selectedJobId={selectedJobId}
                    sort={sort}
                    onSortChange={setSort}
                    onSelectJob={(job) => setSelectedJobId(job.id)}
                    emptyMessage={
                      scopedJobs.length === 0
                        ? selectedClusterId === null
                          ? '아직 등록된 배치 잡이 없습니다. ＋ 새 잡 으로 시작하세요.'
                          : '이 클러스터에 등록된 잡이 없습니다.'
                        : '필터에 일치하는 잡이 없습니다. 필터를 해제해 보세요.'
                    }
                  />
                  {selectedClusterId !== null && (
                    <UnregisteredTypeChips
                      clusterJobs={scopedJobs}
                      allTypes={types}
                      onPick={openCreateFromMissingType}
                    />
                  )}
                </div>
              )}
            </MacCard>
          </div>

          {/* 슬라이드오버 — dock 또는 overlay */}
          {selectedJob && !overlayMode && (
            <BatchJobSlideOver
              job={selectedJob}
              onClose={() => setSelectedJobId(null)}
              onDelete={setConfirmDelete}
            />
          )}
        </div>
      </main>

      {/* Overlay 모드 슬라이드오버 — 좁은 뷰포트 */}
      {selectedJob && overlayMode && (
        <BatchJobSlideOver
          job={selectedJob}
          onClose={() => setSelectedJobId(null)}
          onDelete={setConfirmDelete}
          overlayMode
        />
      )}

      {/* Wizard */}
      {wizardCtx && (
        <CreateBatchJobWizard
          open
          defaultClusterId={wizardCtx.clusterId}
          defaultJobType={wizardCtx.jobType}
          onClose={() => setWizardCtx(null)}
          onCreated={(job) => setSelectedJobId(job.id)}
        />
      )}

      {/* 삭제 확인 */}
      {confirmDelete && (
        <ConfirmDialog
          open
          title="배치 잡 삭제"
          description={`"${confirmDelete.name}" 잡과 모든 실행 이력을 삭제합니다. 계속할까요?`}
          confirmLabel="삭제"
          danger
          onConfirm={async () => {
            await del.mutateAsync(confirmDelete.id);
            if (selectedJobId === confirmDelete.id) setSelectedJobId(null);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: 타입 체크 실행**

Run: `cd frontend && npx tsc --noEmit`
Expected: PASS — 0 errors. (만약 import 경로 / 타입 미스매치가 있으면 fix 후 재시도.)

- [ ] **Step 3: lint 실행**

Run: `cd frontend && npm run lint`
Expected: PASS — 0 warnings.

- [ ] **Step 4: 빌드 실행 (Vite 가 실제로 컴파일 가능한지 확인)**

Run: `cd frontend && npm run build`
Expected: 빌드 성공, `dist/` 생성.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/BatchJobsPage.tsx
git commit -m "$(cat <<'EOF'
refactor(batch-jobs): BatchJobsPage 를 orchestrator 로 재작성

매트릭스 뷰 → 잡 중심 리스트 + ClusterSidebar(iconOnly) + dock 슬라이드오버.
기존 inline 컴포넌트(CreateJobModal·RunModal·JobRunsModal·RunDetailModal·
JobCell·JobEntry·StatusPill) 를 모두 제거하고 components/batch-jobs/ 의
컴포넌트들을 조합한다.

상태: selectedClusterId / statusFilter / search / sort / selectedJobId / wizardCtx
+ overlayMode (matchMedia 1279px 이하).

레이아웃: min-h-screen flex + ClusterSidebar + main(max-w-1700) + MacCard 본문.
PlaybooksPage·CiliumTracePage 와 동일 wrapper 패턴.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: 수동 검증 + 정리

**Files:**
- (변경 없음 — 검증 only)

- [ ] **Step 1: 백엔드 + 프론트엔드 dev 서버 가동**

Run (두 터미널):

```bash
# 터미널 1
docker-compose up -d postgres redis
cd backend && uvicorn app.main:app --reload --port 8000

# 터미널 2
cd frontend && npm run dev
```

브라우저: `http://localhost:5173/batch-jobs`

- [ ] **Step 2: 수동 시나리오 검증**

spec §8 의 12 개 시나리오를 모두 실행:

1. 사이드바 ⊞ 전체 → 모든 클러스터의 잡이 한 리스트로 표시되고, 클러스터 컬럼이 보임.
2. 사이드바에서 특정 클러스터 클릭 → 그 클러스터 잡만 보이고, 클러스터 컬럼이 사라지며, 헤더 부제에 "이름 · region · 잡 N · 실패 X · 실행 중 Y" 표시, 하단에 미등록 잡 타입 칩 노출.
3. 상태 칩 "⚠ 실패" 클릭 → error/timeout/auth_error/connect_error 만 노출. "전체" 클릭 시 reset.
4. 검색 input 에 잡 이름 일부 / cron / 호스트 / 타입 입력 → 실시간 필터링.
5. 행 클릭 → 우측 슬라이드오버 펼침 (≥1280px) 또는 overlay drawer (<1280px). ESC / 외부 클릭 / 헤더 ✕ 로 닫힘.
6. 슬라이드오버 "지금 실행" 클릭 → RunForm 펼침. 비밀번호 미입력 시 에러 메시지. 성공 시 결과 영역에 stdout/stderr/executedCommand 표시.
7. 슬라이드오버 최근 이력 행 클릭 → 같은 슬라이드오버 안에서 상세 영역 펼침. 다른 이력 행 클릭 시 이전 상세 닫히고 새 상세 펼침.
8. "+ 새 잡" 클릭 → wizard step 1. 클러스터/타입 readonly 여부 확인 (단일 클러스터 모드에서 클러스터가 fixed).
9. 미등록 타입 칩 클릭 → wizard 가 (clusterId + jobType) prefilled 로 열림.
10. 등록 성공 → 모달 닫히고 새로 만든 잡이 자동 선택되어 슬라이드오버가 펼침.
11. 슬라이드오버에서 "삭제" → ConfirmDialog → 확인 시 잡 사라지고 슬라이드오버 자동 닫힘.
12. 다크 모드 토글 → 모든 칩 / 행 / 슬라이드오버 / wizard 색상 정상.
13. 1024 / 1440 / 1700px 폭에서 레이아웃 정상. 1024px 에서 overlay drawer 동작.

각 시나리오 옆에 ✓ 또는 실패 메모. 실패 발견 시 해당 컴포넌트 수정 후 commit (별도 commit, "fix(batch-jobs): ..." 메시지) 후 재검증.

- [ ] **Step 3: 사용 안 하는 import / 죽은 코드 점검**

기존 BatchJobsPage.tsx 가 import 했던 항목 중 새 코드에 없는 것은 자동 제거됐는지 확인:

Run: `cd frontend && npx tsc --noEmit && npm run lint`
Expected: 모두 PASS, "X is defined but never used" 경고 없음.

- [ ] **Step 4: 최종 빌드 + 번들 사이즈 확인**

Run: `cd frontend && npm run build`
Expected: 빌드 성공. Vite 의 번들 사이즈 출력에서 BatchJobsPage 청크가 비정상적으로 커지지 않았는지 확인 (이전 대비 ±20% 이내가 정상).

- [ ] **Step 5: (선택) PR 작성**

본 작업이 PR 로 가야 한다면, CLAUDE.md "Pull Request Description (Required)" 섹션의 4 항목(Summary / Changes / Test plan / Screenshots) 을 포함해 한국어 Markdown 으로 작성. heredoc 사용. — 단, 사용자가 명시적으로 PR 작성을 요청하지 않았다면 commit 으로 마무리하고 사용자에게 다음 행동을 묻는다.

- [ ] **Step 6: 마무리 — task 5~7 의 commit 들이 의도대로 쌓였는지 확인**

Run: `git log --oneline -10`
Expected: Task 1~7 의 commit 들이 순서대로 보임. 빠진 게 있으면 해당 task 로 돌아가 재검토.

---

## Self-Review

**1. Spec coverage 점검**

| Spec 섹션 | 어디서 다뤘는가 |
|---|---|
| §3 컴포넌트 분해 | Task 1~7 의 File Structure |
| §4.1 페이지 레이아웃 | Task 7 의 BatchJobsPage 코드 |
| §4.2 ClusterScopeHeader | Task 7 headerSubtitle 계산 + 페이지 헤더 |
| §4.3 BatchJobFilters | Task 2 |
| §4.4 BatchJobTable | Task 3 |
| §4.5 BatchJobSlideOver | Task 5 |
| §4.6 CreateBatchJobWizard | Task 6 |
| §4.7 UnregisteredTypeChips | Task 4 + Task 7 의 wiring |
| §4.8 시각 컨벤션 | 전 task 의 className 토큰 |
| §5 상태 관리 | Task 7 |
| §6 에러/빈 상태 | Task 3 emptyMessage + Task 7 의 조건 분기 |
| §7 접근성 | Task 3 aria-sort, Task 5 ESC handler, label htmlFor |
| §8 테스트 계획 | Task 8 |
| §9 백엔드 변경 | (없음 — Task 8 까지 백엔드 미터치) |
| §10 마이그레이션 | Task 7 (라우트·export·데이터 모델 호환성) |
| §12 위험 | Task 5 overlay fallback, Task 7 matchMedia |

모든 spec 요구사항이 task 에 매핑됨.

**2. Placeholder scan**

- "TBD"/"TODO"/"implement later" 없음 ✓
- 모든 step 에 실제 코드 / 명령 포함 ✓
- "Similar to Task N" 사용 없음 (각 task 가 독립적으로 읽힘) ✓

**3. Type consistency**

- `WizardState` 는 Task 6 step 1 에서 정의되고 step 2, 3, 컨테이너에서 동일하게 import ✓
- `FilterKey` / `SortState` 는 Task 1 의 `types.ts` 정의, Task 2/3/7 에서 동일 이름 사용 ✓
- `BatchJob` / `BatchJobRun` / `Cluster` / `BatchJobTypeDescriptor` 는 모두 `@/services/api` 에서 import (현재 코드 패턴 그대로) ✓
- `MacCard`, `MasterHostPicker`, `LogViewer`, `ConfirmDialog`, `ClusterSidebar` 는 기존 컴포넌트 그대로 사용 ✓
- `applyFilter` signature: Task 2 정의 `(jobs, active, search) → BatchJob[]` 와 Task 7 호출 시그니처 일치 ✓
- `BatchJobSlideOver` props: Task 5 `{job, onClose, onDelete, overlayMode?}` 와 Task 7 호출부 일치 ✓
- `CreateBatchJobWizard` props: Task 6 `{open, defaultClusterId?, defaultJobType?, onClose, onCreated}` 와 Task 7 호출부 일치 ✓
- `onCreated` 콜백이 `BatchJob` 을 받아 `setSelectedJobId(job.id)` 로 사용 — Task 6 의 mutateAsync 응답 타입과 일치 ✓
