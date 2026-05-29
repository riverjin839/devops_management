# PEP — Platform Engineering Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱을 "Platform Engineering Portal (PEP)"로 재정의 — 브랜딩 변경, 내비게이션 9개 PE 도메인 재구조화, 홈 페이지 듀얼모드(업무 ↔ 플랫폼) 토글 구현.

**Architecture:** homeStore(Zustand)가 `'work' | 'platform'` 모드를 localStorage에 영속. Sidebar 로고 버튼이 이미 `/`에 있을 때 재클릭하면 모드를 토글. HomePage는 모드에 따라 Mode A(업무 전용, ClusterSidebar 제거)와 Mode B(인프라 KPI + 인시던트 + 도메인 카드)를 분기 렌더.

**Tech Stack:** React 18, TypeScript 5.3, Zustand 4, TanStack Query 5, Tailwind CSS, lucide-react, axios (via `@/services/api`)

**Spec:** `docs/superpowers/specs/2026-05-28-pep-platform-engineering-portal-design.md`

---

## File Map

| 파일 | 유형 | 역할 |
|---|---|---|
| `frontend/src/stores/homeStore.ts` | 신규 | homeMode Zustand store + localStorage 동기화 |
| `frontend/src/components/layout/Sidebar.tsx` | 수정 | GROUPS 9개 PE 도메인 + 홈 토글 버튼 |
| `frontend/src/components/layout/Header.tsx` | 수정 | PEP 브랜딩 |
| `frontend/src/hooks/useDailyCheck.ts` | 수정 | `useDailyCheckSummary` hook 추가 |
| `frontend/src/components/dashboard/InfraHealthBar.tsx` | 신규 | 인프라 건강 KPI 바 (Mode B) |
| `frontend/src/components/dashboard/IncidentMiniPanel.tsx` | 신규 | 인시던트 미니 패널 (Mode B) |
| `frontend/src/components/dashboard/DomainQuickAccess.tsx` | 신규 | 9개 도메인 빠른 접근 카드 (Mode B) |
| `frontend/src/pages/HomePage.tsx` | 수정 | 듀얼모드 분기 (ClusterSidebar 제거, Mode B 통합) |
| `frontend/src/pages/SettingsPage.tsx` | 수정 | "홈 화면" 섹션 + 클러스터 필터 placeholder |
| `frontend/index.html` | 수정 | `<title>PEP — Platform Engineering Portal</title>` |

---

## Task 1: homeStore.ts 생성

**Files:**
- Create: `frontend/src/stores/homeStore.ts`

- [ ] **Step 1: homeStore.ts 작성**

```typescript
// frontend/src/stores/homeStore.ts
import { create } from 'zustand';

export type HomeMode = 'work' | 'platform';

const STORAGE_KEY = 'pep:homeMode';

function loadMode(): HomeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'platform' ? 'platform' : 'work';
}

interface HomeStore {
  mode: HomeMode;
  toggle: () => void;
  setMode: (m: HomeMode) => void;
}

export const useHomeStore = create<HomeStore>((set, get) => ({
  mode: loadMode(),
  toggle: () => {
    const next: HomeMode = get().mode === 'work' ? 'platform' : 'work';
    localStorage.setItem(STORAGE_KEY, next);
    set({ mode: next });
  },
  setMode: (m) => {
    localStorage.setItem(STORAGE_KEY, m);
    set({ mode: m });
  },
}));
```

- [ ] **Step 2: TypeScript 타입 체크**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 에러 없음

- [ ] **Step 3: Commit**

```bash
git add frontend/src/stores/homeStore.ts
git commit -m "feat(pep): homeStore — work/platform 모드 토글 + localStorage 영속"
```

---

## Task 2: useDailyCheckSummary hook 추가

`InfraHealthBar`와 `IncidentMiniPanel`이 `GET /api/v1/daily-check/summary`를 사용. 응답: `ClusterSummary[]` = `{ cluster_id, cluster_name, latest_check, today_checks_count, status }`.

**Files:**
- Modify: `frontend/src/hooks/useDailyCheck.ts`

- [ ] **Step 1: hook 추가 (파일 끝에 append)**

기존 파일 끝에 다음을 추가:

```typescript
// frontend/src/hooks/useDailyCheck.ts — 파일 끝에 추가

export interface DailyCheckSummaryItem {
  cluster_id: string;
  cluster_name: string;
  status: 'healthy' | 'warning' | 'critical';
  today_checks_count: number;
  latest_check: {
    overall_status: string;
    total_nodes: number | null;
    ready_nodes: number | null;
    error_messages: string[] | null;
    warning_messages: string[] | null;
    checked_at: string | null;
  } | null;
}

export function useDailyCheckSummary() {
  return useQuery<DailyCheckSummaryItem[]>({
    queryKey: ['dailyCheckSummary'],
    queryFn: async () => {
      try {
        const { data } = await dailyCheckApi.getSummary();
        return data;
      } catch {
        return [];
      }
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}
```

- [ ] **Step 2: api.ts에 `getSummary` 메서드 존재 여부 확인**

```bash
grep -n "getSummary\|daily-check/summary" frontend/src/services/api.ts
```

없으면 Step 3으로, 있으면 Step 4로.

- [ ] **Step 3: api.ts에 getSummary 추가** (없는 경우에만)

`frontend/src/services/api.ts`에서 `dailyCheckApi` 객체를 찾아 다음 메서드 추가:

```typescript
getSummary: () => api.get('/daily-check/summary'),
```

- [ ] **Step 4: TypeScript 타입 체크**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 에러 없음

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useDailyCheck.ts frontend/src/services/api.ts
git commit -m "feat(pep): useDailyCheckSummary hook + api.getSummary"
```

---

## Task 3: InfraHealthBar 컴포넌트

Mode B 최상단에 표시되는 1줄 인프라 건강 KPI 바.
클러스터 수는 `useClusterStore` (이미 앱 레벨에서 로드됨), 노드 카운트는 `useDailyCheckSummary`.

**Files:**
- Create: `frontend/src/components/dashboard/InfraHealthBar.tsx`

- [ ] **Step 1: InfraHealthBar.tsx 작성**

```typescript
// frontend/src/components/dashboard/InfraHealthBar.tsx
import { Server, CheckCircle2, AlertTriangle, XCircle, Cpu } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useClusterStore } from '@/stores/clusterStore';
import { useDailyCheckSummary } from '@/hooks/useDailyCheck';

export function InfraHealthBar() {
  const { clusters } = useClusterStore();
  const { data: summary = [] } = useDailyCheckSummary();

  const healthy  = clusters.filter((c) => c.status === 'healthy').length;
  const warning  = clusters.filter((c) => c.status === 'warning').length;
  const critical = clusters.filter((c) => c.status === 'critical').length;

  const totalNodes = summary.reduce(
    (acc, s) => acc + (s.latest_check?.total_nodes ?? 0), 0,
  );
  const readyNodes = summary.reduce(
    (acc, s) => acc + (s.latest_check?.ready_nodes ?? 0), 0,
  );

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-card/80 border-b border-border flex-wrap">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mr-1">
        인프라 현황
      </span>

      <Link
        to="/cluster-overview"
        className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-background border border-border hover:border-primary/40 transition-colors text-[11px]"
      >
        <Server className="w-3 h-3 text-muted-foreground" />
        <span className="text-muted-foreground">클러스터</span>
        <span className="font-semibold tabular-nums">{clusters.length}</span>
      </Link>

      {healthy > 0 && (
        <span className="flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400">
          <CheckCircle2 className="w-3 h-3" />
          <span className="tabular-nums">{healthy}</span>
          <span className="text-muted-foreground">정상</span>
        </span>
      )}
      {warning > 0 && (
        <Link
          to="/cluster-overview"
          className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 hover:underline"
        >
          <AlertTriangle className="w-3 h-3" />
          <span className="tabular-nums">{warning}</span>
          <span>경고</span>
        </Link>
      )}
      {critical > 0 && (
        <Link
          to="/cluster-overview"
          className="flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400 hover:underline"
        >
          <XCircle className="w-3 h-3" />
          <span className="tabular-nums">{critical}</span>
          <span>위험</span>
        </Link>
      )}

      {totalNodes > 0 && (
        <Link
          to="/node-specs"
          className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-background border border-border hover:border-primary/40 transition-colors text-[11px] ml-1"
        >
          <Cpu className="w-3 h-3 text-muted-foreground" />
          <span className="text-muted-foreground">노드</span>
          <span className="font-semibold tabular-nums">{readyNodes}/{totalNodes}</span>
        </Link>
      )}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 타입 체크**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 에러 없음

- [ ] **Step 3: ESLint 확인**

```bash
cd frontend && npx eslint src/components/dashboard/InfraHealthBar.tsx --max-warnings 0
```

Expected: 경고/오류 없음

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/dashboard/InfraHealthBar.tsx
git commit -m "feat(pep): InfraHealthBar — 인프라 건강 KPI 1줄 바"
```

---

## Task 4: IncidentMiniPanel 컴포넌트

Mode B 중단에 표시되는 접을 수 있는 인시던트 패널.
`useDailyCheckSummary`에서 critical/warning 클러스터를 필터링해 표시.

**Files:**
- Create: `frontend/src/components/dashboard/IncidentMiniPanel.tsx`

- [ ] **Step 1: IncidentMiniPanel.tsx 작성**

```typescript
// frontend/src/components/dashboard/IncidentMiniPanel.tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, AlertTriangle, XCircle, ExternalLink } from 'lucide-react';
import { useDailyCheckSummary } from '@/hooks/useDailyCheck';

export function IncidentMiniPanel() {
  const [collapsed, setCollapsed] = useState(true);
  const { data: summary = [] } = useDailyCheckSummary();

  const incidents = summary
    .filter((s) => s.status === 'critical' || s.status === 'warning')
    .sort((a, b) => {
      if (a.status === b.status) return 0;
      return a.status === 'critical' ? -1 : 1;
    });

  const criticalCount = incidents.filter((s) => s.status === 'critical').length;
  const warningCount  = incidents.filter((s) => s.status === 'warning').length;

  if (incidents.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        )}
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          인시던트 현황
        </span>
        {criticalCount > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-red-600 dark:text-red-400 ml-2">
            <XCircle className="w-3 h-3" />
            위험 {criticalCount}
          </span>
        )}
        {warningCount > 0 && (
          <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400 ml-1">
            <AlertTriangle className="w-3 h-3" />
            경고 {warningCount}
          </span>
        )}
        <Link
          to="/daily-check/review"
          onClick={(e) => e.stopPropagation()}
          className="ml-auto flex items-center gap-1 text-[11px] text-primary hover:underline"
        >
          전체보기
          <ExternalLink className="w-3 h-3" />
        </Link>
      </button>

      {!collapsed && (
        <div className="border-t border-border divide-y divide-border">
          {incidents.slice(0, 5).map((item) => (
            <Link
              key={item.cluster_id}
              to={`/daily-check/review?cluster=${item.cluster_id}`}
              className="flex items-start gap-2 px-3 py-2 hover:bg-muted/40 transition-colors"
            >
              {item.status === 'critical' ? (
                <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
              )}
              <div className="min-w-0">
                <span className="text-[12px] font-medium truncate block">{item.cluster_name}</span>
                {item.latest_check?.error_messages?.[0] && (
                  <span className="text-[11px] text-muted-foreground truncate block">
                    {item.latest_check.error_messages[0]}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 타입 체크 + ESLint**

```bash
cd frontend && npx tsc --noEmit && npx eslint src/components/dashboard/IncidentMiniPanel.tsx --max-warnings 0
```

Expected: 에러/경고 없음

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/dashboard/IncidentMiniPanel.tsx
git commit -m "feat(pep): IncidentMiniPanel — 인시던트 접힘 패널"
```

---

## Task 5: DomainQuickAccess 컴포넌트

Mode B 하단의 9개 PE 도메인 빠른 접근 카드 그리드.

**Files:**
- Create: `frontend/src/components/dashboard/DomainQuickAccess.tsx`

- [ ] **Step 1: DomainQuickAccess.tsx 작성**

```typescript
// frontend/src/components/dashboard/DomainQuickAccess.tsx
import { Link } from 'react-router-dom';
import {
  Layers, Server, Network, Database, Package,
  GitBranch, Users, BookOpen, Settings,
} from 'lucide-react';

const DOMAINS = [
  { id: 'cluster',   label: '클러스터',   icon: Layers,    to: '/cluster-overview' },
  { id: 'server',    label: '서버/인프라', icon: Server,    to: '/node-specs' },
  { id: 'network',   label: '네트워크',   icon: Network,   to: '/cilium-trace' },
  { id: 'storage',   label: '스토리지',   icon: Database,  to: '/mc' },
  { id: 'services',  label: '서비스/앱',  icon: Package,   to: '/lake-services' },
  { id: 'devops',    label: 'DevOps',     icon: GitBranch, to: '/playbooks' },
  { id: 'collab',    label: '협업',       icon: Users,     to: '/tasks-mgmt' },
  { id: 'knowledge', label: '지식/분석',  icon: BookOpen,  to: '/docs' },
  { id: 'system',    label: '시스템',     icon: Settings,  to: '/settings' },
] as const;

export function DomainQuickAccess() {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        플랫폼 도메인
      </span>
      <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-1.5">
        {DOMAINS.map(({ id, label, icon: Icon, to }) => (
          <Link
            key={id}
            to={to}
            className="flex flex-col items-center gap-1 px-2 py-2 rounded-lg hover:bg-muted/60 transition-colors group"
          >
            <Icon className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
            <span className="text-[10px] text-muted-foreground group-hover:text-foreground leading-none text-center">
              {label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 타입 체크 + ESLint**

```bash
cd frontend && npx tsc --noEmit && npx eslint src/components/dashboard/DomainQuickAccess.tsx --max-warnings 0
```

Expected: 에러/경고 없음

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/dashboard/DomainQuickAccess.tsx
git commit -m "feat(pep): DomainQuickAccess — 9개 PE 도메인 빠른 접근 카드"
```

---

## Task 6: Header.tsx 브랜딩 + index.html title

**Files:**
- Modify: `frontend/src/components/layout/Header.tsx`
- Modify: `frontend/index.html`

- [ ] **Step 1: Header.tsx — DEVOPS MANAGEMENT → PEP 변경**

`frontend/src/components/layout/Header.tsx` line 32:

```
변경 전: <span className="font-semibold text-lg">DEVOPS MANAGEMENT</span>
변경 후:
<div className="flex flex-col leading-none">
  <span className="font-bold text-sm tracking-wide">PEP</span>
  <span className="text-[10px] text-muted-foreground font-normal">Platform Engineering Portal</span>
</div>
```

- [ ] **Step 2: index.html title 변경**

`frontend/index.html`에서 `<title>` 태그 수정:

```
변경 전: <title>DevOps Management</title>  (또는 현재 title 값)
변경 후: <title>PEP — Platform Engineering Portal</title>
```

- [ ] **Step 3: TypeScript 타입 체크 + ESLint**

```bash
cd frontend && npx tsc --noEmit && npx eslint src/components/layout/Header.tsx --max-warnings 0
```

Expected: 에러/경고 없음

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/layout/Header.tsx frontend/index.html
git commit -m "feat(pep): 브랜딩 — Header/title PEP으로 변경"
```

---

## Task 7: Sidebar.tsx — GROUPS 재구조화 + 홈 토글

이 태스크가 가장 변경량이 많다. 3단계로 나눠 진행.

**Files:**
- Modify: `frontend/src/components/layout/Sidebar.tsx`

### 7-A: GroupId 타입 + GROUPS 배열 교체

- [ ] **Step 1: 파일 상단 import에 필요한 아이콘 추가 확인**

기존 import에 아래 아이콘들이 있는지 확인. 없으면 추가:
`Package`, `GitBranch`, `Network` (이미 있음), `Database` (이미 있음), `Layers` (이미 있음)

현재 import line 4-11 기준 — `Package`, `GitBranch` 추가 필요. 기존 import를 다음으로 교체:

```typescript
import {
  LayoutDashboard, BookOpen, ListTodo, Sparkles, Settings, Server,
  Pencil, Moon, Sun, Monitor, X, LogOut, User, ChevronRight,
  CalendarCheck2, Link2, Tags, Calculator, GitFork, BookMarked, Layers, Boxes,
  Map, BarChart3, Network, Zap, Route, Share2, Rss, Users, GitCommit, Terminal, Database, Cpu, HardDrive,
  ClipboardCheck, ListTree, Waves, TerminalSquare, Library, Home,
  KeyRound, ShieldCheck, FileSearch, Activity, Package, GitBranch,
} from 'lucide-react';
```

> 위 블록은 참고용 전체 import. **실제 수정**: 기존 Sidebar.tsx import line 8에 `, Package, GitBranch` 두 아이콘만 추가.

실제 수정은 line 8에 `, Package, GitBranch` 추가:

```typescript
// 변경 전 line 8:
  Map, BarChart3, Network, Zap, Route, Share2, Rss, Users, GitCommit, Terminal, Database, Cpu, HardDrive,
// 변경 후:
  Map, BarChart3, Network, Zap, Route, Share2, Rss, Users, GitCommit, Terminal, Database, Cpu, HardDrive, Package, GitBranch,
```

- [ ] **Step 2: `DEFAULT_TITLE` 상수 변경**

```
변경 전: const DEFAULT_TITLE = 'DEVOPS MANAGEMENT';
변경 후: const DEFAULT_TITLE = 'PEP';
```

- [ ] **Step 3: `GroupId` 타입 교체**

```
// 변경 전:
type GroupId = 'monitoring' | 'work' | 'cluster' | 'analysis' | 'docs' | 'system';

// 변경 후:
type GroupId = 'cluster' | 'server' | 'network' | 'storage' | 'services' | 'devops' | 'collab' | 'knowledge' | 'system';
```

- [ ] **Step 4: `GROUPS` 배열 교체**

```typescript
// 변경 전 (lines 75-83):
const GROUPS: Array<...> = [
  { id: 'monitoring', ... },
  { id: 'work', ... },
  { id: 'cluster', ... },
  { id: 'analysis', ... },
  { id: 'docs', ... },
  { id: 'system', ... },
];

// 변경 후:
const GROUPS: Array<{ id: GroupId; label: string; icon: ComponentType<{ className?: string }>; paths: string[] }> = [
  { id: 'cluster',   label: '클러스터',   icon: Layers,      paths: ['/cluster-overview', '/daily-check/review', '/daily-check/settings', '/pod-bottleneck', '/versions', '/bulk-exec', '/etcdctl', '/cluster-manage'] },
  { id: 'server',    label: '서버/인프라', icon: Server,      paths: ['/node-specs', '/node-labels', '/node-images', '/kernel-params', '/infra-topology'] },
  { id: 'network',   label: '네트워크',   icon: Network,     paths: ['/cilium-trace', '/packet-flow', '/cidr', '/links'] },
  { id: 'storage',   label: '스토리지',   icon: Database,    paths: ['/mc'] },
  { id: 'services',  label: '서비스/앱',  icon: Package,     paths: ['/lake-services'] },
  { id: 'devops',    label: 'DevOps',     icon: GitBranch,   paths: ['/playbooks', '/batch-jobs', '/commands'] },
  { id: 'collab',    label: '협업',       icon: Users,       paths: ['/tasks-mgmt', '/todo-today', '/work-summary', '/members', '/workflow', '/wbs'] },
  { id: 'knowledge', label: '지식/분석',  icon: BookOpen,    paths: ['/docs', '/ops-notes', '/mindmap', '/incident-analysis', '/ontology', '/trends', '/work-guides'] },
  { id: 'system',    label: '시스템',     icon: Settings,    paths: ['/settings'] },
];
```

- [ ] **Step 5: `activeGroup` 로직 업데이트**

현재 `activeGroup` 계산(lines 268-278)이 `docs` 그룹에 대한 특별 처리를 포함. 새 구조는 모든 그룹이 `paths`로만 동작하므로 단순화:

```typescript
// 변경 후 (activeGroup useMemo):
const activeGroup: GroupId | null = useMemo(() => {
  if (location.pathname.startsWith('/services/')) return 'services';
  for (const g of GROUPS) {
    if (g.paths.includes(location.pathname)) return g.id;
  }
  return null;
}, [location.pathname]);
```

### 7-B: renderFlyoutBody 업데이트

- [ ] **Step 6: `renderFlyoutBody` 수정**

현재 `id === 'docs'` 특별 처리를 제거하고, `services` 그룹에만 동적 service 항목 포함.

```typescript
// renderFlyoutBody 전체 교체 (lines 316-429):
const renderFlyoutBody = (id: GroupId) => {
  const group = GROUPS.find((g) => g.id === id);
  if (!group) return null;
  const close = () => setOpenGroup(null);

  // services 그룹: 정적 paths + 동적 서비스 카탈로그
  if (id === 'services') {
    return (
      <div className="space-y-1 pb-2">
        {group.paths.map((p) => {
          const entry = navMap[p];
          if (!entry) return null;
          return (
            <FlyoutLink key={p} to={p} label={getLabel(p)} Icon={entry.icon}
              active={location.pathname === p} onSelect={close} />
          );
        })}
        {servicePaths.length > 0 && <div className="mx-2 my-1 border-t border-zinc-200" />}
        {servicePaths.map((p) => {
          const entry = navMap[p];
          if (!entry) return null;
          return (
            <FlyoutLink key={p} to={p} label={getLabel(p)} Icon={entry.icon}
              active={location.pathname === p} onSelect={close} />
          );
        })}
      </div>
    );
  }

  // system 그룹: 메뉴 이름 편집 버튼 포함
  if (id === 'system') {
    return (
      <div className="space-y-1 pb-2">
        {group.paths.map((p) => {
          const entry = navMap[p];
          if (!entry) return null;
          return (
            <FlyoutLink key={p} to={p} label={getLabel(p)} Icon={entry.icon}
              active={location.pathname === p} onSelect={close} />
          );
        })}
        <button
          type="button"
          onClick={() => { close(); setEditMode(true); }}
          className={`${FLYOUT_LINK_BASE} ${FLYOUT_LINK_INACTIVE} w-[calc(100%-12px)]`}
        >
          <Pencil className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1 text-left">메뉴 이름 편집</span>
        </button>
      </div>
    );
  }

  // 나머지 그룹: 플랫 리스트
  return (
    <div className="space-y-1 pb-2">
      {group.paths.map((p) => {
        const entry = navMap[p];
        if (!entry) return null;
        return (
          <FlyoutLink key={p} to={p} label={getLabel(p)} Icon={entry.icon}
            active={location.pathname === p} onSelect={close} />
        );
      })}
    </div>
  );
};
```

### 7-C: 홈 로고 버튼 토글 로직

- [ ] **Step 7: Sidebar 함수 상단에 homeStore import + 핸들러 추가**

파일 상단 import에 추가:
```typescript
import { useHomeStore } from '@/stores/homeStore';
```

`Sidebar()` 함수 내 기존 `const [openGroup, ...` 선언 바로 위에 추가:
```typescript
const { mode, toggle, setMode } = useHomeStore();

const handleHomeClick = () => {
  if (location.pathname === '/') {
    toggle();
  } else {
    setMode('work');
    navigate('/');
  }
};

const homeTooltip = location.pathname === '/'
  ? (mode === 'work' ? '플랫폼 현황 보기' : '업무 현황으로 돌아가기')
  : '홈으로 이동';
```

- [ ] **Step 8: 로고 Link → button 교체**

`aside` 내 로고 영역 (현재 `<Link to="/" ...>☸</Link>`):

```typescript
// 변경 전:
<Link
  to="/"
  title={`${title} — 홈`}
  aria-label="홈으로 이동"
  className={`w-9 h-9 bg-gradient-to-br from-primary to-sky-700 rounded-md flex items-center justify-center text-white text-sm shadow-sm transition-transform hover:scale-105 active:scale-95 ${
    location.pathname === '/' ? 'ring-2 ring-primary/50' : ''
  }`}
>
  ☸
</Link>

// 변경 후:
<button
  type="button"
  onClick={handleHomeClick}
  title={homeTooltip}
  aria-label={homeTooltip}
  className={`w-9 h-9 bg-gradient-to-br from-primary to-sky-700 rounded-md flex items-center justify-center text-white text-sm shadow-sm transition-transform hover:scale-105 active:scale-95 ${
    location.pathname === '/'
      ? mode === 'platform'
        ? 'ring-2 ring-sky-300/70'
        : 'ring-2 ring-primary/50'
      : ''
  }`}
>
  ☸
</button>
```

- [ ] **Step 9: TypeScript 타입 체크 + ESLint**

```bash
cd frontend && npx tsc --noEmit && npx eslint src/components/layout/Sidebar.tsx --max-warnings 0
```

Expected: 에러/경고 없음. 만약 `DOCS_SECTIONS`, `WORK_STANDARD_PATHS` 미사용 경고가 있으면 해당 상수 선언 삭제.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/layout/Sidebar.tsx
git commit -m "feat(pep): Sidebar — 9개 PE 도메인 재구조화 + 홈 토글 버튼"
```

---

## Task 8: HomePage.tsx 듀얼모드 리팩터

**Files:**
- Modify: `frontend/src/pages/HomePage.tsx`

- [ ] **Step 1: 전체 파일 교체**

```typescript
// frontend/src/pages/HomePage.tsx
import { useMemo } from 'react';
import {
  Sun, ClipboardList, AlertCircle, CalendarClock, Server, CalendarDays,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { MemberTodayTodos } from '@/components/dashboard/MemberTodayTodos';
import { WorkCalendar } from '@/components/dashboard/WorkCalendar';
import { InfraHealthBar } from '@/components/dashboard/InfraHealthBar';
import { IncidentMiniPanel } from '@/components/dashboard/IncidentMiniPanel';
import { DomainQuickAccess } from '@/components/dashboard/DomainQuickAccess';
import { useAuthStore } from '@/stores/authStore';
import { useClusterStore } from '@/stores/clusterStore';
import { useHomeStore } from '@/stores/homeStore';
import { useClusters } from '@/hooks/useCluster';
import { useWorkItems } from '@/hooks/useWorkItems';
import type { WorkItem } from '@/types';

// ── helpers ──────────────────────────────────────────────────────────────────
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function greeting(hour: number): string {
  if (hour < 6)  return '늦은 시간 수고 많으세요';
  if (hour < 12) return '좋은 아침입니다';
  if (hour < 18) return '오후 운영 잘 부탁드립니다';
  return '오늘도 마무리 잘 부탁드립니다';
}

function fmtKoreanDate(d: Date): string {
  const week = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} (${week[d.getDay()]})`;
}

function nextDueTask(items: WorkItem[]): WorkItem | null {
  const now = Date.now();
  const candidates = items
    .filter((t) => t.startedAt && t.kanbanStatus !== 'done')
    .map((t) => ({ t, ms: new Date(t.startedAt as string).getTime() }))
    .filter(({ ms }) => Number.isFinite(ms) && ms >= now - 1000 * 60 * 60 * 24)
    .sort((a, b) => a.ms - b.ms);
  return candidates[0]?.t ?? null;
}

// ── KPI pill ─────────────────────────────────────────────────────────────────
interface KpiPillProps {
  label: string;
  value: number | string;
  hint?: string;
  Icon: typeof ClipboardList;
  accent: string;
  to?: string;
}

function KpiPill({ label, value, hint, Icon, accent, to }: KpiPillProps) {
  const body = (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-card border border-border hover:border-primary/40 transition-colors text-[11px] whitespace-nowrap">
      <Icon className={`w-3 h-3 flex-shrink-0 ${accent}`} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-muted-foreground">{hint}</span>}
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

// ── Main ─────────────────────────────────────────────────────────────────────
export function HomePage() {
  const mode = useHomeStore((s) => s.mode);
  const user = useAuthStore((s) => s.user);
  const myName = user?.displayName?.trim() || user?.username || null;

  const { clusters } = useClusterStore();
  const { isLoading: clustersLoading } = useClusters();

  const { data: workItemsData } = useWorkItems();
  const allWorkItems = useMemo<WorkItem[]>(() => workItemsData?.data ?? [], [workItemsData]);
  const allTasks  = useMemo<WorkItem[]>(() => allWorkItems.filter((w) => w.type === 'task'), [allWorkItems]);
  const allIssues = useMemo<WorkItem[]>(() => allWorkItems.filter((w) => w.type === 'issue'), [allWorkItems]);

  const today = dateKey(new Date());
  const myTodayTasks = useMemo(() => {
    if (!myName) return [];
    return allTasks.filter((t) => {
      if (t.kanbanStatus === 'done') return false;
      const match = t.assignee === myName || t.primaryAssignee === myName || t.secondaryAssignee === myName;
      if (!match) return false;
      const due = t.startedAt?.slice(0, 10);
      return !due || due <= today;
    });
  }, [allTasks, myName, today]);

  const openIssueCount = useMemo(() => allIssues.filter((i) => !i.closedAt).length, [allIssues]);
  const criticalClusters = useMemo(() => clusters.filter((c) => c.status === 'critical').length, [clusters]);
  const upcomingTask = useMemo(() => nextDueTask(allTasks), [allTasks]);
  const upcomingLabel = upcomingTask?.startedAt
    ? new Date(upcomingTask.startedAt).toLocaleString('ko-KR', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '없음';

  const now = new Date();
  const hello = greeting(now.getHours());
  const dateStr = fmtKoreanDate(now);

  return (
    <div className="h-screen overflow-hidden bg-background flex flex-col">

      {/* ── 상단 KPI 바 ──────────────────────────────────────────────────── */}
      <div className="flex-none flex items-center gap-3 px-3 lg:px-4 py-2 border-b border-border bg-background/95 backdrop-blur flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Sun className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-sm font-bold leading-none whitespace-nowrap">
            {hello}{myName ? `, ${myName}님` : ''}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums hidden sm:inline">{dateStr}</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          <KpiPill label="내 할일" value={myName ? myTodayTasks.length : '—'} hint={myName ? '건' : undefined}
            Icon={ClipboardList} accent="text-primary" to="/todo-today" />
          <KpiPill label="미해결 이슈" value={openIssueCount} hint="건"
            Icon={AlertCircle} accent="text-red-500" to="/tasks-mgmt" />
          <KpiPill label="위험 클러스터" value={clustersLoading ? '…' : criticalClusters} hint={clustersLoading ? '' : `/ ${clusters.length}`}
            Icon={Server} accent="text-amber-500" to="/cluster-overview" />
          <KpiPill label="다음 일정" value={upcomingLabel}
            Icon={CalendarClock} accent="text-sky-500" to="/tasks-mgmt" />
        </div>
      </div>

      {/* ── Mode B: 플랫폼 모드 ────────────────────────────────────────────── */}
      {mode === 'platform' && (
        <div className="flex-none px-3 pt-2 flex flex-col gap-2">
          <InfraHealthBar />
          <IncidentMiniPanel />
          <DomainQuickAccess />
        </div>
      )}

      {/* ── Mode A: 업무 모드 (항상 표시, platform 모드에서는 아래로 밀림) ── */}
      <div className="flex-1 min-h-0 flex flex-col px-3 py-3 gap-3 overflow-auto">
        <div className="flex-1 min-h-0 grid grid-cols-10 gap-3">

          {/* 담당자별 진행 현황 (4/10) */}
          <div className="col-span-10 xl:col-span-4 flex flex-col min-h-0 rounded-md border border-border bg-card overflow-hidden">
            <div className="flex-none px-4 py-2.5 border-b border-border bg-muted/40">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
                Platform 담당자별 진행 현황
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <MemberTodayTodos selectedClusterId={null} />
            </div>
          </div>

          {/* 이번 달 일정 캘린더 (6/10) */}
          <div className="col-span-10 xl:col-span-6 flex flex-col min-h-0 rounded-md border border-border bg-card overflow-hidden">
            <div className="flex-none flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
                이번 달 일정
              </span>
              <CalendarDays className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <WorkCalendar selectedClusterId={null} />
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TypeScript 타입 체크 + ESLint**

```bash
cd frontend && npx tsc --noEmit && npx eslint src/pages/HomePage.tsx --max-warnings 0
```

Expected: 에러/경고 없음

> 만약 `MemberTodayTodos` 또는 `WorkCalendar`가 `selectedClusterId: string | null`을 필수 props로 요구하고 타입 에러가 나면 — 이미 `null`을 넘기므로 타입 문제는 없을 것. 만약 에러나면 해당 컴포넌트 props 타입을 `selectedClusterId?: string | null`로 변경.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/HomePage.tsx
git commit -m "feat(pep): HomePage 듀얼모드 — Mode A full-width (ClusterSidebar 제거) + Mode B 플랫폼 패널"
```

---

## Task 9: SettingsPage.tsx — 홈 화면 섹션 placeholder

Settings에 "홈 화면 설정" 섹션 추가. 클러스터 필터 토글은 disabled + "추후 지원" 배지.

**Files:**
- Modify: `frontend/src/pages/SettingsPage.tsx`

- [ ] **Step 1: SettingsPage.tsx에서 기존 섹션 구조 파악**

```bash
grep -n "섹션\|section\|<h2\|<h3\|Card\|MacCard\|border-b" frontend/src/pages/SettingsPage.tsx | head -30
```

기존 섹션 패턴을 확인하고 동일한 패턴으로 삽입.

- [ ] **Step 2: 홈 화면 섹션 추가**

`SettingsPage.tsx`에서 적절한 위치(첫 번째 섹션 앞 또는 마지막 섹션 뒤)에 다음 블록 추가:

```tsx
{/* 홈 화면 설정 */}
<div className="rounded-md border border-border bg-card overflow-hidden">
  <div className="px-4 py-3 border-b border-border bg-muted/40">
    <h3 className="text-sm font-semibold">홈 화면 설정</h3>
    <p className="text-[11px] text-muted-foreground mt-0.5">PEP 홈 페이지 표시 옵션</p>
  </div>
  <div className="px-4 py-3 flex items-center justify-between">
    <div>
      <p className="text-sm">업무 모드에서 클러스터 필터 표시</p>
      <p className="text-[11px] text-muted-foreground">업무 현황을 특정 클러스터로 필터링</p>
    </div>
    <div className="flex items-center gap-2">
      <span className="px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground rounded">
        추후 지원
      </span>
      <button
        type="button"
        disabled
        className="relative w-9 h-5 rounded-full bg-muted border border-border opacity-50 cursor-not-allowed"
        aria-label="추후 지원 예정"
      >
        <span className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform" />
      </button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: TypeScript 타입 체크 + ESLint**

```bash
cd frontend && npx tsc --noEmit && npx eslint src/pages/SettingsPage.tsx --max-warnings 0
```

Expected: 에러/경고 없음

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/SettingsPage.tsx
git commit -m "feat(pep): Settings — 홈 화면 섹션 placeholder (클러스터 필터 추후 지원)"
```

---

## Task 10: 전체 빌드 검증 + CLAUDE.md 업데이트

- [ ] **Step 1: 전체 lint + 타입 체크 + 빌드**

```bash
cd frontend && npm run lint && npx tsc --noEmit && npm run build
```

Expected: 에러/경고 없음, 빌드 성공

> 빌드 실패 시: 에러 메시지를 보고 해당 파일 수정 후 재시도. 주요 원인: 미사용 import, 타입 불일치, ESLint 규칙 위반.

- [ ] **Step 2: CLAUDE.md 프로젝트 설명 업데이트**

`CLAUDE.md` 상단 `## Project Overview` 섹션에서:

```
변경 전: **DEVOPS MANAGEMENT** (originally "K8s Daily Monitor") is a DevOps-focused...
변경 후:
**PEP (Platform Engineering Portal)** is a platform engineering tool covering:
- K8s cluster monitoring and operations (original core)
- Infrastructure management (servers, network, storage, GPU)
- Team collaboration (work items, workflows, members)
- Knowledge sharing (documentation, AI analysis, ontology)

Originally "K8s Daily Monitor" (DevOps Management), redefined as Platform Engineering Portal in May 2026.
```

- [ ] **Step 3: 최종 Commit**

```bash
git add CLAUDE.md
git commit -m "docs(pep): CLAUDE.md — 프로젝트 PEP으로 재정의 반영"
```

---

## 검증 체크리스트 (구현 완료 후)

- [ ] 앱 실행 후 Header에 `PEP` + `Platform Engineering Portal` 표시
- [ ] 브라우저 탭 제목이 `PEP — Platform Engineering Portal`
- [ ] Sidebar 레일에 9개 그룹 아이콘 표시 (클러스터/서버/네트워크/스토리지/서비스/DevOps/협업/지식/시스템)
- [ ] 각 그룹 클릭 시 flyout에 해당 페이지 목록 표시
- [ ] `/` 홈에서 로고(`☸`) 클릭 → Mode B(플랫폼) 전환, ring 색 변경
- [ ] Mode B에서 로고 재클릭 → Mode A(업무) 전환
- [ ] 다른 페이지에서 로고 클릭 → `/`로 이동 + Mode A
- [ ] Mode A: ClusterSidebar 없음, MemberTodayTodos + WorkCalendar full-width
- [ ] Mode B: InfraHealthBar(클러스터 카운트) + IncidentMiniPanel + DomainQuickAccess 표시
- [ ] IncidentMiniPanel: critical/warning 클러스터 있을 때만 표시, 클릭으로 접힘/펼침
- [ ] DomainQuickAccess: 9개 카드 각각 해당 도메인 페이지로 이동
- [ ] Settings 페이지에 "홈 화면 설정" 섹션 + disabled 토글 표시
- [ ] `npm run lint` — 경고 0
- [ ] `npx tsc --noEmit` — 에러 0
