import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import {
  LayoutDashboard, BookOpen, ListTodo, Sparkles, Settings, Server,
  Pencil, Moon, Sun, Monitor, X, LogOut, User, ChevronRight,
  CalendarCheck2, Link2, Tags, Calculator, GitFork, BookMarked, Layers, Boxes,
  Map, BarChart3, Network, Zap, Route, Share2, Rss, Users, GitCommit, Terminal, Database, Cpu, HardDrive,
  ClipboardCheck, ListTree, Waves, TerminalSquare, Library, Home,
  KeyRound, ShieldCheck, FileSearch,
} from 'lucide-react';
import { useUiSettings, useUpdateUiSettings } from '@/hooks/useUiSettings';
import { useServiceCatalog } from '@/hooks/useServiceCatalog';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { NAV_WIDTH } from '@/stores/sidebarStore';
import { useAuthStore } from '@/stores/authStore';
import { InlineEdit } from '@/components/common';

// ── Nav registry ──────────────────────────────────────────────────────────────
// `/services` (통합 지식/SOP) 는 운영 기준 섹션에서 제거됨 — flyout 에서 보이지 않음.
const NAV_MAP: Record<string, { defaultLabel: string; icon: ComponentType<{ className?: string }> }> = {
  '/':                   { defaultLabel: '홈 (Today)',     icon: Home },
  '/cluster-overview':   { defaultLabel: '클러스터 현황',  icon: LayoutDashboard },
  '/daily-check/review': { defaultLabel: '일일 점검 리뷰',  icon: ClipboardCheck },
  '/daily-check/settings':{ defaultLabel: 'Deep Check 설정', icon: Sparkles },
  '/docs':               { defaultLabel: '지식 허브 홈',    icon: Library },
  '/playbooks':          { defaultLabel: 'Playbooks',      icon: BookOpen },
  '/tasks-mgmt':         { defaultLabel: '업무 관리',      icon: ListTodo },
  '/todo-today':         { defaultLabel: '오늘 할일',      icon: CalendarCheck2 },
  '/work-summary':       { defaultLabel: '업무 현황',      icon: BarChart3 },
  '/members':            { defaultLabel: '멤버별 업무',    icon: Users },
  '/cluster-manage':     { defaultLabel: '클러스터 관리',  icon: Server },
  '/versions':           { defaultLabel: '버전 / 설정',     icon: GitCommit },
  '/bulk-exec':          { defaultLabel: '노드 일괄 실행', icon: Terminal },
  '/etcdctl':            { defaultLabel: 'etcdctl 콘솔',   icon: Database },
  '/batch-jobs':         { defaultLabel: 'Batch Jobs',     icon: ListTree },
  '/mc':                 { defaultLabel: 'mc 클라이언트',  icon: HardDrive },
  '/kernel-params':      { defaultLabel: '커널 파라미터',  icon: Cpu },
  '/infra-topology':     { defaultLabel: '인프라 토폴로지', icon: Network },
  '/node-specs':         { defaultLabel: '노드 서버스펙',  icon: ClipboardCheck },
  '/links':              { defaultLabel: '클러스터 링크',  icon: Link2 },
  '/node-labels':        { defaultLabel: '노드 라벨',      icon: Tags },
  '/node-images':        { defaultLabel: '노드 이미지',    icon: Boxes },
  '/cidr':               { defaultLabel: 'CIDR 계산기',    icon: Calculator },
  '/incident-analysis':  { defaultLabel: '장애 로그 분석', icon: Zap },
  '/packet-flow':        { defaultLabel: '패킷 흐름 분석', icon: Route },
  '/cilium-trace':       { defaultLabel: 'Cilium BPF Trace', icon: Waves },
  '/ontology':           { defaultLabel: '온톨로지 그래프', icon: Share2 },
  '/trends':             { defaultLabel: '기술 동향',      icon: Rss },
  '/work-guides':        { defaultLabel: '표준 작업 가이드', icon: BookMarked },
  '/commands':           { defaultLabel: '주요 명령어',     icon: TerminalSquare },
  '/ops-notes':          { defaultLabel: '운영 노트보드',   icon: Layers },
  '/wbs':                { defaultLabel: 'WBS 작업흐름',   icon: BarChart3 },
  '/mindmap':            { defaultLabel: '마인드맵',       icon: Map },
  '/workflow':           { defaultLabel: '워크플로우',     icon: GitFork },
  '/settings':           { defaultLabel: 'Settings',       icon: Settings },
};

// docs 그룹의 서브섹션. /services (통합 지식/SOP) 은 운영 기준에서 제거됨.
// 첫 줄 `/docs` 는 지식 허브 랜딩(미리보기 + 통합 검색) 페이지.
const DOCS_SECTIONS: Array<{ id: string; label: string; paths: string[] }> = [
  { id: 'home',  label: '허브 홈',     paths: ['/docs'] },
  { id: 'ops',   label: '운영 기준',  paths: ['/ops-notes'] },
  { id: 'issue', label: '이슈/장애',   paths: ['/tasks-mgmt', '/incident-analysis'] },
  { id: 'flow',  label: '흐름/설계',  paths: ['/workflow', '/wbs', '/mindmap'] },
];

// 서비스 카탈로그 섹션에 포함되는 작업 기준 경로
const WORK_STANDARD_PATHS = ['/work-guides', '/commands', '/tasks-mgmt'];

// 사이드바 레일에 표시되는 그룹들
type GroupId = 'monitoring' | 'work' | 'cluster' | 'analysis' | 'docs' | 'system';
const GROUPS: Array<{ id: GroupId; label: string; icon: ComponentType<{ className?: string }>; paths: string[] }> = [
  // 홈(/) 은 좌측 상단 로고 버튼이 담당하므로 그룹 paths 에서 제외.
  { id: 'monitoring', label: '모니터링', icon: LayoutDashboard, paths: ['/cluster-overview', '/daily-check/review', '/daily-check/settings', '/playbooks'] },
  { id: 'work',       label: '업무관리', icon: ListTodo,        paths: ['/tasks-mgmt', '/todo-today', '/work-summary', '/members'] },
  { id: 'cluster',    label: '클러스터', icon: Server,          paths: ['/cluster-manage', '/node-specs', '/versions', '/bulk-exec', '/etcdctl', '/batch-jobs', '/mc', '/kernel-params', '/infra-topology', '/links', '/node-labels', '/node-images', '/cidr'] },
  { id: 'analysis',   label: 'AI 분석',  icon: Sparkles,        paths: ['/incident-analysis', '/packet-flow', '/cilium-trace', '/ontology', '/trends'] },
  { id: 'docs',       label: '지식 허브', icon: BookOpen,        paths: [] },  // sections 사용
  { id: 'system',     label: '시스템',   icon: Settings,        paths: ['/settings'] },
];

const DEFAULT_TITLE = 'DEVOPS MANAGEMENT';
// default(Claude paper) → 라이트 → 다크 → 시스템 → default …
const THEME_CYCLE: Record<Theme, Theme> = { default: 'light', light: 'dark', dark: 'system', system: 'default' };
const THEME_LABEL: Record<Theme, string> = { default: '기본', light: '라이트', dark: '다크', system: '시스템' };

// ── 호버 툴팁이 붙은 아이콘 버튼 — 레일에서 사용 ────────────────────────────
interface RailIconButtonProps {
  label: string;
  Icon: ComponentType<{ className?: string }>;
  active?: boolean;
  highlighted?: boolean;
  /** 클릭 시 호출. 클릭한 버튼의 화면상 위치를 같이 넘겨 — 호출 측이 popover 앵커링에 활용.
   *  popover 가 필요 없는 단순 액션(테마 토글 / 라우팅 / 로그아웃 등) 은 rect 를 무시해도 된다. */
  onClick: (rect?: DOMRect) => void;
  /** flyout 이 열려있을 때는 툴팁을 숨김 (중복) */
  suppressTooltip?: boolean;
}

function RailIconButton({ label, Icon, active, highlighted, onClick, suppressTooltip }: RailIconButtonProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // top / left 는 viewport 기준 (position: fixed). 툴팁은 부모 overflow:auto 의 클리핑을
  // 회피하기 위해 document.body 에 portal 로 렌더한다.
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

  const showTooltip = () => {
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 8 });
  };
  const hideTooltip = () => setTooltipPos(null);

  const handleClick = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) onClick(rect);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        onClick={handleClick}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        className={`relative flex items-center justify-center w-10 h-10 rounded-md transition-colors ${
          active
            ? 'bg-primary/15 text-primary'
            : highlighted
              ? 'bg-secondary text-foreground'
              : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
        }`}
      >
        {active && (
          <span aria-hidden className="absolute left-0 top-1.5 -translate-x-[3px] w-1 h-7 bg-primary rounded-r" />
        )}
        <Icon className="w-5 h-5" />
      </button>
      {tooltipPos && !suppressTooltip && createPortal(
        <span
          role="tooltip"
          style={{ top: tooltipPos.top, left: tooltipPos.left, transform: 'translateY(-50%)' }}
          className="fixed px-2 py-1 text-xs font-medium whitespace-nowrap bg-zinc-700 text-white rounded shadow-lg pointer-events-none z-[60]"
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}

// ── Flyout 패널 — 클릭한 아이콘 우측에 컴팩트 popover 형태로 표시 ─────────────
interface FlyoutProps {
  title: string;
  /** 앵커 아이콘의 viewport 좌표. flyout 의 top 을 여기 맞춤. */
  anchorRect: DOMRect;
  children: React.ReactNode;
  onClose: () => void;
}

function FlyoutShell({ title, anchorRect, children, onClose }: FlyoutProps) {
  // popover top 은 아이콘의 top 에 맞추되, 화면 아래로 넘치면 위로 끌어올림.
  // max-height 로 본문 스크롤을 보장.
  const top = Math.min(anchorRect.top, window.innerHeight - 100);
  const maxHeight = window.innerHeight - top - 8;

  return createPortal(
    <div
      style={{ top, left: NAV_WIDTH, maxHeight }}
      className="fixed z-50 bg-white text-black border border-zinc-200 rounded-md shadow-xl flex flex-col min-w-[180px] max-w-[260px] overflow-hidden"
      role="dialog"
      aria-label={title}
    >
      <div className="px-3 py-1.5 border-b border-zinc-200 flex items-center justify-between bg-zinc-50">
        <span className="text-[11px] font-semibold text-zinc-700 uppercase tracking-wider truncate">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="p-0.5 rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-900"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      <div className="overflow-y-auto py-1">{children}</div>
    </div>,
    document.body,
  );
}

// flyout 내부에서 항목 한 줄을 그릴 때 쓰는 공통 스타일.
const FLYOUT_LINK_BASE = 'flex items-center gap-2 px-2.5 py-1.5 mx-1 rounded text-[13px] transition-colors';
const FLYOUT_LINK_INACTIVE = 'text-black hover:bg-zinc-100';
const FLYOUT_LINK_ACTIVE = 'bg-primary/10 text-primary font-semibold';

function FlyoutLink({
  to, label, Icon, active, onSelect,
}: {
  to: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onSelect}
      className={`${FLYOUT_LINK_BASE} ${active ? FLYOUT_LINK_ACTIVE : FLYOUT_LINK_INACTIVE}`}
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1 min-w-0 break-keep">{label}</span>
      {active && <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-primary" />}
    </Link>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export function Sidebar() {
  const { theme, setTheme } = useThemeStore();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: settings } = useUiSettings();
  const updateSettings = useUpdateUiSettings();

  const currentUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.clear);
  const isAdmin = currentUser?.role === 'admin';

  const [openGroup, setOpenGroup] = useState<GroupId | null>(null);
  // flyout 의 위치를 클릭한 아이콘 우측에 맞추기 위해 마지막 클릭한 버튼의 rect 를 보관.
  const [openAnchor, setOpenAnchor] = useState<DOMRect | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingNavPath, setEditingNavPath] = useState<string | null>(null);

  const title = settings?.appTitle || DEFAULT_TITLE;
  const navLabels = useMemo(() => settings?.navLabels || {}, [settings?.navLabels]);
  const services = useServiceCatalog();

  // 동적 NAV_MAP — 정적 위에 ui_settings 의 서비스 항목을 덧씌움.
  const navMap = useMemo(() => {
    const m: typeof NAV_MAP = { ...NAV_MAP };
    for (const s of services) {
      if (s.key === 'other') continue;
      m[`/services/${s.key}`] = { defaultLabel: s.label, icon: s.icon };
    }
    return m;
  }, [services]);

  const servicePaths = useMemo(
    () => services.filter((s) => s.key !== 'other').map((s) => `/services/${s.key}`),
    [services],
  );

  const getLabel = (path: string) => navLabels[path] || navMap[path]?.defaultLabel || path;

  // 현재 경로가 속한 그룹을 표시(레일에서 active 강조)
  const activeGroup: GroupId | null = useMemo(() => {
    if (location.pathname.startsWith('/services/')) return 'docs';
    for (const g of GROUPS) {
      if (g.id === 'docs') {
        if (DOCS_SECTIONS.some((s) => s.paths.includes(location.pathname))) return 'docs';
        continue;
      }
      if (g.paths.includes(location.pathname)) return g.id;
    }
    return null;
  }, [location.pathname]);

  // 경로 변경되면 flyout 자동 닫기 (단 사용자가 직접 클릭 후 같은 페이지인 경우는 무시)
  useEffect(() => {
    setOpenGroup(null);
  }, [location.pathname]);

  // ESC 로 flyout / edit mode 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenGroup(null);
        setEditMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleTitleSave = (val: string) => {
    updateSettings.mutate({ appTitle: val || DEFAULT_TITLE, navLabels });
    setIsEditingTitle(false);
  };

  const handleNavSave = (path: string, val: string) => {
    const updated = { ...navLabels, [path]: val };
    if (!val) delete updated[path];
    updateSettings.mutate({ appTitle: title, navLabels: updated });
    setEditingNavPath(null);
  };

  const toggleGroup = (id: GroupId, rect?: DOMRect) => {
    setEditMode(false);
    setOpenGroup((cur) => (cur === id ? null : id));
    if (rect) setOpenAnchor(rect);
  };

  // 그룹별 flyout 본문 렌더링
  const renderFlyoutBody = (id: GroupId) => {
    const group = GROUPS.find((g) => g.id === id);
    if (!group) return null;
    const close = () => setOpenGroup(null);

    if (id === 'docs') {
      return (
        <div className="space-y-1 pb-1">
          <FlyoutSection title="서비스 카탈로그">
            {servicePaths.map((p) => {
              const entry = navMap[p];
              if (!entry) return null;
              return (
                <FlyoutLink
                  key={p}
                  to={p}
                  label={getLabel(p)}
                  Icon={entry.icon}
                  active={location.pathname === p}
                  onSelect={close}
                />
              );
            })}
            {servicePaths.length > 0 && (
              <div className="mx-2 my-1 border-t border-zinc-200" />
            )}
            <div className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
              작업 기준
            </div>
            {WORK_STANDARD_PATHS.map((p) => {
              const entry = navMap[p];
              if (!entry) return null;
              return (
                <FlyoutLink
                  key={p}
                  to={p}
                  label={getLabel(p)}
                  Icon={entry.icon}
                  active={location.pathname === p}
                  onSelect={close}
                />
              );
            })}
          </FlyoutSection>
          {DOCS_SECTIONS.map((sec) => (
            <FlyoutSection key={sec.id} title={sec.label}>
              {sec.paths.map((p) => {
                const entry = navMap[p];
                if (!entry) return null;
                return (
                  <FlyoutLink
                    key={p}
                    to={p}
                    label={getLabel(p)}
                    Icon={entry.icon}
                    active={location.pathname === p}
                    onSelect={close}
                  />
                );
              })}
            </FlyoutSection>
          ))}
        </div>
      );
    }

    if (id === 'system') {
      return (
        <div className="space-y-1 pb-2">
          {group.paths.map((p) => {
            const entry = navMap[p];
            if (!entry) return null;
            return (
              <FlyoutLink
                key={p}
                to={p}
                label={getLabel(p)}
                Icon={entry.icon}
                active={location.pathname === p}
                onSelect={close}
              />
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

    return (
      <div className="space-y-1 pb-2">
        {group.paths.map((p) => {
          const entry = navMap[p];
          if (!entry) return null;
          return (
            <FlyoutLink
              key={p}
              to={p}
              label={getLabel(p)}
              Icon={entry.icon}
              active={location.pathname === p}
              onSelect={close}
            />
          );
        })}
      </div>
    );
  };

  const flyoutTitle = useMemo(
    () => (openGroup ? GROUPS.find((g) => g.id === openGroup)?.label ?? '' : ''),
    [openGroup],
  );

  return (
    <>
      <aside
        style={{
          width: NAV_WIDTH,
          ['--card' as string]: 'var(--sidebar)',
          ['--card-foreground' as string]: 'var(--sidebar-foreground)',
          ['--foreground' as string]: 'var(--sidebar-foreground)',
          ['--muted-foreground' as string]: 'var(--sidebar-muted-foreground)',
          ['--secondary' as string]: 'var(--sidebar-accent)',
          ['--secondary-foreground' as string]: 'var(--sidebar-accent-foreground)',
          ['--border' as string]: 'var(--sidebar-border)',
          ['--background' as string]: 'var(--sidebar)',
          ['--primary' as string]: 'var(--sidebar-primary)',
        } as React.CSSProperties}
        className="fixed top-0 left-0 h-full bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col z-40"
      >
        {/* 로고 — 클릭 시 홈으로. 좌측 상단의 공식 홈 버튼 역할. */}
        <div className="flex items-center justify-center py-3 border-b border-border flex-shrink-0">
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
        </div>

        {/* 그룹 아이콘 레일 */}
        <nav className="flex-1 py-2 overflow-y-auto" aria-label="메인 네비게이션">
          <div className="flex flex-col items-center gap-1">
            {GROUPS.map((g) => (
              <RailIconButton
                key={g.id}
                label={g.label}
                Icon={g.icon}
                active={activeGroup === g.id}
                highlighted={openGroup === g.id}
                suppressTooltip={openGroup === g.id}
                onClick={(rect) => toggleGroup(g.id, rect)}
              />
            ))}
          </div>
        </nav>

        {/* 푸터 — 테마 / 사용자 / 로그아웃 */}
        <div className="flex-shrink-0 border-t border-border py-2 flex flex-col items-center gap-1">
          <RailIconButton
            label={`테마: ${THEME_LABEL[theme]}`}
            Icon={
              theme === 'default' ? Sparkles
              : theme === 'light'   ? Sun
              : theme === 'dark'    ? Moon
              : Monitor
            }
            onClick={() => setTheme(THEME_CYCLE[theme])}
          />
          {currentUser && (
            <RailIconButton
              label={`${currentUser.displayName || currentUser.username} · ${currentUser.role}`}
              Icon={User}
              onClick={() => { /* 호버 툴팁만 — 별도 동작 없음 */ }}
            />
          )}
          {currentUser && (
            <RailIconButton
              label="비밀번호 변경"
              Icon={KeyRound}
              onClick={() => navigate('/me/change-password')}
            />
          )}
          {isAdmin && (
            <RailIconButton
              label="사용자 관리"
              Icon={ShieldCheck}
              active={location.pathname === '/settings/users'}
              onClick={() => navigate('/settings/users')}
            />
          )}
          {isAdmin && (
            <RailIconButton
              label="감사 로그"
              Icon={FileSearch}
              active={location.pathname === '/settings/audit-logs'}
              onClick={() => navigate('/settings/audit-logs')}
            />
          )}
          {currentUser && (
            <RailIconButton
              label="로그아웃"
              Icon={LogOut}
              onClick={logout}
            />
          )}
        </div>
      </aside>

      {/* Flyout — 그룹 아이콘 우측에 컴팩트 popover. 외부 클릭으로 닫힘 (투명 캐처). */}
      {openGroup && openAnchor && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpenGroup(null)}
            aria-hidden
          />
          <FlyoutShell
            title={flyoutTitle}
            anchorRect={openAnchor}
            onClose={() => setOpenGroup(null)}
          >
            {renderFlyoutBody(openGroup)}
          </FlyoutShell>
        </>
      )}

      {/* 메뉴 이름 편집 오버레이 — 시스템 flyout 안의 버튼으로 진입 */}
      {editMode && (
        <>
          <div
            className="fixed inset-0 z-30 bg-black/20 backdrop-blur-[1px]"
            onClick={() => setEditMode(false)}
            aria-hidden
          />
          <aside
            style={{ left: NAV_WIDTH, width: 288 }}
            className="fixed top-0 h-full bg-card border-r border-border shadow-2xl flex flex-col z-40"
          >
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <span className="text-sm font-semibold flex-1">메뉴 편집</span>
              <button onClick={() => setEditMode(false)}
                className="p-1 rounded hover:bg-secondary text-muted-foreground"
                title="닫기">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4 py-3 border-b border-border">
              <p className="text-xs text-muted-foreground/70 mb-1 uppercase tracking-wider">앱 타이틀</p>
              {isEditingTitle ? (
                <InlineEdit value={title} onSave={handleTitleSave} onCancel={() => setIsEditingTitle(false)}
                  inputClassName="text-sm font-semibold w-full px-1.5 py-0.5 bg-secondary border border-primary rounded" />
              ) : (
                <button onClick={() => setIsEditingTitle(true)}
                  className="w-full flex items-center justify-between px-2 py-1 rounded hover:bg-secondary text-left">
                  <span className="font-semibold text-sm truncate">{title}</span>
                  <Pencil className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                </button>
              )}
            </div>
            <nav className="flex-1 py-2 px-2 overflow-y-auto">
              {GROUPS.map((g) => {
                const paths = g.id === 'docs'
                  ? [...servicePaths, ...WORK_STANDARD_PATHS, ...DOCS_SECTIONS.flatMap((s) => s.paths)]
                  : g.paths;
                if (paths.length === 0) return null;
                return (
                  <div key={g.id} className="mb-3">
                    <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">{g.label}</p>
                    <div className="space-y-0.5">
                      {paths.map((path) => {
                        const navItem = navMap[path];
                        if (!navItem) return null;
                        const { icon: Icon } = navItem;
                        const itemLabel = getLabel(path);
                        const isEditing = editingNavPath === path;
                        if (isEditing) {
                          return (
                            <div key={path} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-secondary/50 border border-primary/30">
                              <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                              <InlineEdit value={itemLabel} onSave={(v) => handleNavSave(path, v)} onCancel={() => setEditingNavPath(null)}
                                className="flex-1 min-w-0" inputClassName="text-sm" />
                            </div>
                          );
                        }
                        return (
                          <button key={path} onClick={() => setEditingNavPath(path)}
                            className="group w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-secondary text-left text-sm">
                            <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                            <span className="flex-1 min-w-0 truncate">{itemLabel}</span>
                            <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 flex-shrink-0" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </nav>
            <div className="px-3 py-2 border-t border-border text-xs text-muted-foreground">
              외부 클릭으로 닫기. 이름만 수정됩니다.
            </div>
          </aside>
        </>
      )}
    </>
  );
}

// ── Flyout 내부 섹션 (헤더 + 자식) ─────────────────────────────────────────────
function FlyoutSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}
