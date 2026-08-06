import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import {
  Sparkles, Palmtree, Leaf, Star,
  Moon, Sun, Monitor, LogOut, User, ChevronRight, ArrowLeft,
  KeyRound, ScrollText, Home, MessageSquare, Bug, Bot,
  Flame, Sunset, Zap,
} from 'lucide-react';
import { useUiSettings } from '@/hooks/useUiSettings';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { useIslands } from '@/hooks/useIslands';
import { useFavorites } from '@/hooks/useFavorites';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { NAV_WIDTH } from '@/stores/sidebarStore';
import { useAuthStore } from '@/stores/authStore';
import { useIslandStore } from '@/stores/islandStore';
import { useAgentChatStore } from '@/stores/agentChatStore';
import { AGENT_CHAT_FEATURE_KEY } from '@/components/agent';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import { SidePane } from '@/components/common';
import { SelfAssigneePanel } from './SelfAssigneePanel';
import { ReleaseNotesPanel } from './ReleaseNotesPanel';
import { BugFixLogPanel } from './BugFixLogPanel';
import { VocBoardPanel } from './VocBoardPanel';
import { FlyoutShell, FlyoutLink } from './NavFlyout';
import { FavoritesFlyoutBody } from './FavoritesFlyoutBody';
import { GROUPS, type GroupId } from './navConfig';

// 정적 네비게이션 정의(NAV_MAP / GROUPS / GroupId / DEFAULT_TITLE)는 navConfig 로 분리 —
// Settings 의 "화면 UI 설정" 탭(NavMenuManager / PageStyleManager)과 공유한다.
// default(Claude paper) → 컴포트(크림+그린) → 번트시에나 → 토스카나 선셋 → 일렉트로팝
// → 라이트 → 다크 → 시스템 → default …
const THEME_CYCLE: Record<Theme, Theme> = {
  default: 'comfort',
  comfort: 'burnt-sienna',
  'burnt-sienna': 'tuscan-sunset',
  'tuscan-sunset': 'electropop',
  electropop: 'light',
  light: 'dark',
  dark: 'system',
  system: 'default',
};
const THEME_LABEL: Record<Theme, string> = {
  default: '기본',
  comfort: '컴포트',
  'burnt-sienna': '번트 시에나',
  'tuscan-sunset': '토스카나 선셋',
  electropop: '일렉트로팝',
  light: '라이트',
  dark: '다크',
  system: '시스템',
};

// flyout 을 여는 아이콘에 마우스를 올렸을 때 클릭 없이 바로 열리게 하는 hover-intent 지연.
// OPEN 은 레일을 스쳐 지나가는 마우스에 flyout 이 깜빡이지 않도록, CLOSE 는 아이콘→flyout
// 이동 중 잠깐 hover 가 끊겨도 안 닫히도록 여유를 둔다(패널 쪽 onMouseEnter 가 다시 취소).
const HOVER_OPEN_DELAY = 150;
const HOVER_CLOSE_DELAY = 200;

// D-058 — '클러스터' 그룹 flyout 이 20여 개 항목의 단일 플랫 리스트라 스캔 시간이 길었다
// (Hick's law). GROUPS.cluster.paths 자체는 그대로 두고, flyout 렌더링만 성격별 섹션
// (모니터링/콘솔/점검/관리)으로 재배열한다. 여기 없는 새 경로가 그룹에 추가되면 렌더링
// 쪽에서 "기타" 섹션으로 떨어뜨려 드리프트를 눈에 띄게 한다.
const CLUSTER_FLYOUT_SECTIONS: Array<{ label: string; paths: string[] }> = [
  { label: '모니터링', paths: ['/cluster-overview', '/cluster-trends', '/observability', '/alerts', '/k8s-events', '/incident-analysis', '/pod-bottleneck'] },
  { label: '콘솔', paths: ['/k9s', '/node-ssh', '/etcdctl', '/bulk-exec'] },
  { label: '점검', paths: ['/ops-checks', '/daily-check/review', '/daily-check/settings'] },
  { label: '관리', paths: ['/cluster-manage', '/versions', '/k8s-manage', '/k8s-allocation', '/node-labels', '/node-images', '/k8s-logs'] },
];

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
  /** D-059 — 클릭 시 flyout 이 열리는 아이콘(하위 경로 2개 이상)에 점 인디케이터를 붙여
   *  즉시 이동하는 아이콘과 시각적으로 구분한다. */
  hasFlyout?: boolean;
  /** 마우스를 올리면(hover-intent) 클릭 시 열리던 flyout 을 바로 연다. 지정하지 않으면
   *  기존처럼 클릭으로만 열린다(테마 토글 등 flyout 이 없는 단순 액션). */
  onHoverOpen?: (rect: DOMRect) => void;
  /** 위 hover-open 과 짝 — 마우스가 벗어나면 지연 후 닫는다(패널로 이동 중이면 flyout 쪽에서 취소). */
  onHoverClose?: () => void;
}

function RailIconButton({ label, Icon, active, highlighted, onClick, suppressTooltip, hasFlyout, onHoverOpen, onHoverClose }: RailIconButtonProps) {
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

  const handleMouseEnter = () => {
    // flyout 이 있는 아이콘은 hover 시 flyout 자체가 열려 헤더에 라벨을 보여주므로,
    // 이름만 뜨는 툴팁을 따로 띄우면 두 개가 겹쳐 보인다 — flyout 이 없는 아이콘에만 띄운다.
    if (!hasFlyout) showTooltip();
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) onHoverOpen?.(rect);
  };
  const handleMouseLeave = () => {
    hideTooltip();
    onHoverClose?.();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
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
        {hasFlyout && (
          <span aria-hidden className="absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full bg-current opacity-50" />
        )}
      </button>
      {tooltipPos && !suppressTooltip && createPortal(
        <span
          role="tooltip"
          style={{ top: tooltipPos.top, left: tooltipPos.left, transform: 'translateY(-50%)' }}
          className="fixed px-2 py-1 text-sm font-medium whitespace-nowrap bg-zinc-700 text-white rounded shadow-lg pointer-events-none z-[60]"
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}

/** 아일랜드 아이콘(lucide 이름/이모지/이미지) → flyout 이 기대하는 ComponentType.
 *  lucide 가 아닌 값은 FlyoutLink 가 컴포넌트만 받으므로 기본 아이콘으로 폴백한다. */
function islandFlyoutIcon(icon?: string | null): ComponentType<{ className?: string }> {
  const resolved = resolveClusterIcon(icon);
  return resolved?.kind === 'lucide' ? resolved.Component : Palmtree;
}

// ── Main ────────────────────────────────────────────────────────────────────

export function Sidebar() {
  const { theme, setTheme } = useThemeStore();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: settings } = useUiSettings();

  const currentUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.clear);
  const isAdmin = currentUser?.role === 'admin';
  // 동적 navMap / 라벨 오버라이드 / 기능별 접근 제어 — Your Island 패널 피커와 공유.
  const { navMap, getLabel, featureAllowed } = useNavCatalog();
  const { isPinned, togglePin } = useFavorites();

  const { open: agentChatOpen, toggle: toggleAgentChat } = useAgentChatStore();

  // 홈 버튼 — 항상 홈으로 이동만 한다. 예전엔 이미 홈에 있을 때 work/platform 모드를
  // 토글하는 이중 동작이었지만(D-055), 모드 개념 자체가 폐지되며 순수 홈 이동 버튼이 됐다.
  const handleHomeClick = () => navigate('/');

  // 전역 뒤로가기 — 브라우저 히스토리 기반(navigate(-1)). React Router 가 history.state.idx 를
  // 기록하므로 idx>0 이면 실제 이전 화면으로, 딥링크로 바로 진입(idx=0)했으면 홈으로 fallback.
  const historyIdx = (window.history.state?.idx as number | undefined) ?? 0;
  const canGoBack = historyIdx > 0;
  const handleBack = () => {
    if (canGoBack) navigate(-1);
    else navigate('/');
  };

  // 홈 버튼 아이콘 — Settings(화면 UI 설정 → 홈 아이콘)에서 커스텀 가능, 미설정 시 기본 Home.
  // 과거 work/platform 모드별로 아이콘이 갈리던 것을 모드 폐지와 함께 단일화했다.
  const renderHomeButtonIcon = () => {
    const resolved = resolveClusterIcon(settings?.homeIcons?.work);
    if (resolved?.kind === 'lucide') {
      const IconC = resolved.Component;
      return <IconC className="w-5 h-5" />;
    }
    if (resolved?.kind === 'image') {
      return <img src={resolved.value} alt="" className="w-6 h-6 object-contain rounded-sm" />;
    }
    if (resolved?.kind === 'text') {
      return <span className="text-base leading-none">{resolved.value}</span>;
    }
    return <Home className="w-5 h-5" />;
  };

  // Your Island — 내 아일랜드가 2개 이상이면 레일 버튼 클릭 시 flyout 으로 고른다.
  const { data: islandData } = useIslands();
  const myIslands = useMemo(() => islandData?.data ?? [], [islandData?.data]);
  const sharedIslands = useMemo(() => islandData?.shared ?? [], [islandData?.shared]);
  const lastIslandId = useIslandStore((s) => s.lastIslandId);
  const [islandFlyoutAnchor, setIslandFlyoutAnchor] = useState<DOMRect | null>(null);

  const goToIsland = (rect?: DOMRect) => {
    // 내 것 + 공유받은 것을 합쳐 2개 이상이면 flyout 으로 고르고, 아니면 바로 이동한다.
    if (myIslands.length + sharedIslands.length > 1) {
      setIslandFlyoutAnchor((cur) => (cur ? null : rect ?? null));
      return;
    }
    setIslandFlyoutAnchor(null);
    const target = myIslands[0]?.id ?? sharedIslands[0]?.id ?? lastIslandId;
    navigate(target ? `/island/${target}` : '/island');
  };

  const [openGroup, setOpenGroup] = useState<GroupId | null>(null);
  // flyout 의 위치를 클릭한 아이콘 우측에 맞추기 위해 마지막 클릭한 버튼의 rect 를 보관.
  const [openAnchor, setOpenAnchor] = useState<DOMRect | null>(null);
  // 사용자 아이콘 클릭 시 여는 개인 메뉴(담당자 정보 / 비밀번호 변경) — 우측 슬라이드 SidePane.
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  // 릴리즈 노트 — 우측 슬라이드 SidePane (감사 로그가 Settings 탭으로 이동한 자리).
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  // 버그 픽스 로그 — 릴리즈 노트 옆 레일 아이콘 → 우측 SidePane (CHANGELOG Fixed 항목).
  const [bugFixLogOpen, setBugFixLogOpen] = useState(false);
  // 사용자 VOC 게시판 — 릴리즈 노트 바로 위 레일 아이콘 → 우측 SidePane.
  const [vocOpen, setVocOpen] = useState(false);
  // 즐겨찾기 — 레일 최상단 진입점 (AppTopBar 의 ★ 과 같은 본문을 공유).
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [favoritesAnchor, setFavoritesAnchor] = useState<DOMRect | null>(null);

  // 마우스를 flyout 이 있는 아이콘에 올리면(hover-intent) 클릭 없이도 열리고, 벗어나면
  // 지연 후 닫힌다. 아이콘→패널로 이동하는 짧은 순간 hover 가 끊겨도 패널 쪽
  // onMouseEnter(cancelScheduledClose) 가 예약된 닫기를 취소해준다. 클릭은 기존처럼
  // toggleGroup 등을 통해 즉시 토글한다(hover 타이머는 clearHoverTimers 로 정리).
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const clearHoverTimers = () => {
    if (openTimerRef.current !== undefined) { window.clearTimeout(openTimerRef.current); openTimerRef.current = undefined; }
    if (closeTimerRef.current !== undefined) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = undefined; }
  };
  // 여러 flyout 이 동시에 열리지 않도록, 새로 열기 전에 나머지를 전부 닫는다.
  const closeAllFlyouts = () => {
    setOpenGroup(null);
    setFavoritesOpen(false);
    setIslandFlyoutAnchor(null);
  };
  const scheduleFlyoutOpen = (openFn: () => void) => {
    clearHoverTimers();
    openTimerRef.current = window.setTimeout(() => {
      closeAllFlyouts();
      openFn();
      openTimerRef.current = undefined;
    }, HOVER_OPEN_DELAY);
  };
  const scheduleFlyoutClose = (closeFn: () => void) => {
    clearHoverTimers();
    closeTimerRef.current = window.setTimeout(() => {
      closeFn();
      closeTimerRef.current = undefined;
    }, HOVER_CLOSE_DELAY);
  };
  const cancelScheduledClose = () => {
    if (closeTimerRef.current !== undefined) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = undefined; }
  };
  useEffect(() => clearHoverTimers, []);

  // 레일에는 플랫폼 도메인 그룹만 — 업무 도메인은 전역 상단바(AppTopBar)로 이동했다(D-054).
  // 더는 홈 모드가 사이드바 노출 범위를 게이팅하지 않는다 — 항상 전체가 보인다.
  const visibleGroups = useMemo(
    () => GROUPS.filter((g) => g.domain === 'platform'),
    [],
  );

  // 하단 푸터에 둘 Settings(system) 그룹 — admin 전용.
  const systemGroup = useMemo(() => GROUPS.find((g) => g.id === 'system') ?? null, []);
  const systemHasFlyout = (systemGroup?.paths.length ?? 0) > 1;
  const islandHasFlyout = myIslands.length + sharedIslands.length > 1;

  // 현재 경로가 속한 그룹을 표시(레일에서 active 강조)
  const activeGroup: GroupId | null = useMemo(() => {
    for (const g of GROUPS) {
      if (g.paths.includes(location.pathname)) return g.id;
    }
    return null;
  }, [location.pathname]);

  // 경로 변경되면 flyout 자동 닫기 (단 사용자가 직접 클릭 후 같은 페이지인 경우는 무시)
  useEffect(() => {
    setOpenGroup(null);
    setIslandFlyoutAnchor(null);
    setUserMenuOpen(false);
    setReleaseNotesOpen(false);
    setBugFixLogOpen(false);
    setVocOpen(false);
    setFavoritesOpen(false);
  }, [location.pathname]);

  // ESC 로 flyout / edit mode 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenGroup(null);
        setIslandFlyoutAnchor(null);
        setUserMenuOpen(false);
        setReleaseNotesOpen(false);
        setBugFixLogOpen(false);
        setVocOpen(false);
        setFavoritesOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleGroup = (id: GroupId, rect?: DOMRect) => {
    clearHoverTimers();
    setOpenGroup((cur) => (cur === id ? null : id));
    if (rect) setOpenAnchor(rect);
  };

  // 그룹별 flyout 본문 렌더링
  const renderFlyoutBody = (id: GroupId) => {
    const group = GROUPS.find((g) => g.id === id);
    if (!group) return null;
    const close = () => setOpenGroup(null);

    const renderLink = (p: string) => {
      const entry = navMap[p];
      if (!entry || !featureAllowed(p)) return null;
      return (
        <FlyoutLink key={p} to={p} label={getLabel(p)} Icon={entry.icon} iconColor={entry.iconColor} iconSize={entry.iconSize}
          active={location.pathname === p} onSelect={close}
          isPinned={isPinned(p)} onTogglePin={() => togglePin(p)} />
      );
    };

    // D-058 — '클러스터' 그룹만 항목이 20여 개라 성격별 섹션으로 나눠서 보여준다.
    // CLUSTER_FLYOUT_SECTIONS 에 없는 경로(그룹에 새로 추가됐는데 섹션 갱신을 놓친 경우)는
    // "기타" 섹션으로 떨어뜨려 조용히 숨지 않게 한다.
    if (id === 'cluster') {
      const sectioned = new Set(CLUSTER_FLYOUT_SECTIONS.flatMap((s) => s.paths));
      const leftover = group.paths.filter((p) => !sectioned.has(p));
      const sections = leftover.length > 0
        ? [...CLUSTER_FLYOUT_SECTIONS, { label: '기타', paths: leftover }]
        : CLUSTER_FLYOUT_SECTIONS;
      return (
        <div className="space-y-1 pb-2">
          {sections.map((section, i) => (
            <div key={section.label}>
              {i > 0 && <div className="mx-2 my-1 border-t border-zinc-200" />}
              <p className="px-2.5 pt-1.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                {section.label}
              </p>
              {section.paths.map(renderLink)}
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="space-y-1 pb-2">
        {group.paths.map(renderLink)}
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
        {/* 로고 — 클릭 시 홈으로 이동만 한다(D-055 — 예전엔 모드 토글도 겸했다). */}
        <div className="flex items-center justify-center py-3 border-b border-border flex-shrink-0">
          <button
            type="button"
            onClick={handleHomeClick}
            title="홈으로"
            aria-label="홈으로"
            className={`w-9 h-9 bg-gradient-to-br from-primary to-sky-700 rounded-md flex items-center justify-center text-white shadow-sm transition-transform hover:scale-105 active:scale-95 ${
              location.pathname === '/' ? 'ring-2 ring-primary/50' : ''
            }`}
          >
            {renderHomeButtonIcon()}
          </button>
        </div>

        {/* 전역 뒤로가기 — 홈이 아닐 때만 노출. 어느 화면에서든 이전 화면으로 돌아간다. */}
        {location.pathname !== '/' && (
          <div className="flex items-center justify-center py-2 border-b border-border flex-shrink-0">
            <button
              type="button"
              onClick={handleBack}
              title={canGoBack ? '뒤로 (이전 화면)' : '홈으로'}
              aria-label={canGoBack ? '이전 화면으로 뒤로 가기' : '홈으로'}
              className="w-9 h-9 rounded-md flex items-center justify-center text-sidebar-muted hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors active:scale-95"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* 그룹 아이콘 레일 — 플랫폼 도메인 그룹만 (업무 도메인은 상단바로 이동) */}
        <nav className="flex-1 py-2 overflow-y-auto" aria-label="메인 네비게이션">
          <div className="flex flex-col items-center gap-1">
            {/* 즐겨찾기 — 레일 최상단, 공용 그룹과 성격이 달라(개인 선택) 구분선으로 분리.
                마우스를 올리면 클릭 없이도 바로 열린다(hover-intent). */}
            <RailIconButton
              label="즐겨찾기"
              Icon={Star}
              highlighted={favoritesOpen}
              suppressTooltip={favoritesOpen}
              hasFlyout
              onHoverOpen={(rect) => scheduleFlyoutOpen(() => { setFavoritesOpen(true); setFavoritesAnchor(rect); })}
              onHoverClose={() => scheduleFlyoutClose(() => setFavoritesOpen(false))}
              onClick={(rect) => {
                clearHoverTimers();
                setFavoritesOpen((cur) => !cur);
                if (rect) setFavoritesAnchor(rect);
              }}
            />
            <div className="w-6 border-t border-border my-1" aria-hidden />
            {visibleGroups.map((g) => {
              const hasFlyout = g.paths.length > 1;
              return (
                <RailIconButton
                  key={g.id}
                  label={g.label}
                  Icon={g.icon}
                  active={activeGroup === g.id}
                  highlighted={openGroup === g.id}
                  suppressTooltip={openGroup === g.id}
                  hasFlyout={hasFlyout}
                  onHoverOpen={hasFlyout ? (rect) => scheduleFlyoutOpen(() => { setOpenGroup(g.id); setOpenAnchor(rect); }) : undefined}
                  onHoverClose={hasFlyout ? () => scheduleFlyoutClose(() => setOpenGroup(null)) : undefined}
                  onClick={(rect) => {
                    // 하위 경로가 1개뿐인 그룹은 플라이아웃이 무의미하므로 바로 이동.
                    // 2개 이상이면 플라이아웃으로 하위 메뉴를 고른다.
                    if (!hasFlyout) { clearHoverTimers(); setOpenGroup(null); navigate(g.paths[0]); }
                    else toggleGroup(g.id, rect);
                  }}
                />
              );
            })}
          </div>
        </nav>

        {/* 푸터 — 설정(admin) / 테마 / 사용자 / 로그아웃 */}
        <div className="flex-shrink-0 border-t border-border py-2 flex flex-col items-center gap-1">
          {isAdmin && systemGroup && (
            <RailIconButton
              label={systemGroup.label}
              Icon={systemGroup.icon}
              active={activeGroup === 'system'}
              highlighted={openGroup === 'system'}
              suppressTooltip={openGroup === 'system'}
              hasFlyout={systemHasFlyout}
              onHoverOpen={systemHasFlyout ? (rect) => scheduleFlyoutOpen(() => { setOpenGroup('system'); setOpenAnchor(rect); }) : undefined}
              onHoverClose={systemHasFlyout ? () => scheduleFlyoutClose(() => setOpenGroup(null)) : undefined}
              onClick={(rect) => {
                // 하위 경로가 1개뿐이면(현재 '/settings' 단일) 플라이아웃 없이 바로 이동.
                if (!systemHasFlyout) { clearHoverTimers(); setOpenGroup(null); navigate(systemGroup.paths[0]); }
                else toggleGroup('system', rect);
              }}
            />
          )}
          <RailIconButton
            label={`테마: ${THEME_LABEL[theme]}`}
            Icon={
              theme === 'default' ? Sparkles
              : theme === 'comfort' ? Leaf
              : theme === 'burnt-sienna' ? Flame
              : theme === 'tuscan-sunset' ? Sunset
              : theme === 'electropop' ? Zap
              : theme === 'light'   ? Sun
              : theme === 'dark'    ? Moon
              : Monitor
            }
            onClick={() => setTheme(THEME_CYCLE[theme])}
          />
          {/* Your Island — 개인 커스텀 화면이라 공용 그룹 레일이 아니라 푸터 개인 존에 둔다
              (사용자 메뉴 · VOC · 릴리즈 노트와 같은 성격). 아일랜드가 여러 개면 flyout 으로
              고르고, 0~1개면 바로 이동한다. 발견성은 HomePage 상단 진입 필이 보완한다. */}
          {currentUser && (
            <RailIconButton
              label="Your Island"
              Icon={Palmtree}
              active={location.pathname.startsWith('/island')}
              highlighted={!!islandFlyoutAnchor}
              suppressTooltip={!!islandFlyoutAnchor}
              hasFlyout={islandHasFlyout}
              onHoverOpen={islandHasFlyout ? (rect) => scheduleFlyoutOpen(() => setIslandFlyoutAnchor(rect)) : undefined}
              onHoverClose={islandHasFlyout ? () => scheduleFlyoutClose(() => setIslandFlyoutAnchor(null)) : undefined}
              onClick={(rect) => { clearHoverTimers(); goToIsland(rect); }}
            />
          )}
          {/* AI 어시스턴트 — 우하단 플로팅 버튼이었던 것을 좌측 사이드바 하단 레일로 이동해
              항상 같은 자리에 고정했다. 패널(AgentChat.tsx)은 이 상태를 Zustand 로 공유해서
              연다 — 접근 제어(기능 접근)가 꺼진 사용자에게는 아이콘 자체를 숨긴다. */}
          {currentUser && featureAllowed(AGENT_CHAT_FEATURE_KEY) && (
            <RailIconButton
              label="AI 어시스턴트"
              Icon={Bot}
              highlighted={agentChatOpen}
              suppressTooltip={agentChatOpen}
              onClick={toggleAgentChat}
            />
          )}
          {currentUser && (
            <RailIconButton
              label={`${currentUser.displayName || currentUser.username} · ${currentUser.role}`}
              Icon={User}
              highlighted={userMenuOpen}
              suppressTooltip={userMenuOpen}
              onClick={() => setUserMenuOpen((v) => !v)}
            />
          )}
          {currentUser && (
            <RailIconButton
              label="사용자 VOC 게시판"
              Icon={MessageSquare}
              highlighted={vocOpen}
              suppressTooltip={vocOpen}
              onClick={() => setVocOpen((v) => !v)}
            />
          )}
          {currentUser && (
            <RailIconButton
              label="릴리즈 노트"
              Icon={ScrollText}
              highlighted={releaseNotesOpen}
              suppressTooltip={releaseNotesOpen}
              onClick={() => setReleaseNotesOpen((v) => !v)}
            />
          )}
          {currentUser && (
            <RailIconButton
              label="버그 픽스 로그"
              Icon={Bug}
              highlighted={bugFixLogOpen}
              suppressTooltip={bugFixLogOpen}
              onClick={() => setBugFixLogOpen((v) => !v)}
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

      {/* Flyout — 그룹 아이콘 우측에 컴팩트 popover. 외부 클릭으로 닫힘 (투명 캐처).
          z-30(< aside 의 z-40) 로 레일보다 낮게 둔다 — 같은 z-40 이면 이 캐처가 DOM 순서상
          레일 위에 그려져 호버 중인 아이콘이 즉시 mouseleave 로 판정되고, hover 로 연
          flyout 이 열리자마자 닫혀버린다. */}
      {openGroup && openAnchor && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpenGroup(null)}
            aria-hidden
          />
          <FlyoutShell
            title={flyoutTitle}
            anchorRect={openAnchor}
            onClose={() => setOpenGroup(null)}
            onMouseEnter={cancelScheduledClose}
            onMouseLeave={() => scheduleFlyoutClose(() => setOpenGroup(null))}
          >
            {renderFlyoutBody(openGroup)}
          </FlyoutShell>
        </>
      )}

      {/* 즐겨찾기 flyout — AppTopBar 의 ★ 과 같은 본문(FavoritesFlyoutBody)을 공유. */}
      {favoritesOpen && favoritesAnchor && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setFavoritesOpen(false)} aria-hidden />
          <FlyoutShell
            title="즐겨찾기"
            anchorRect={favoritesAnchor}
            onClose={() => setFavoritesOpen(false)}
            onMouseEnter={cancelScheduledClose}
            onMouseLeave={() => scheduleFlyoutClose(() => setFavoritesOpen(false))}
          >
            <FavoritesFlyoutBody onClose={() => setFavoritesOpen(false)} />
          </FlyoutShell>
        </>
      )}

      {/* Your Island flyout — 아일랜드가 여러 개일 때 목록에서 고른다. */}
      {islandFlyoutAnchor && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setIslandFlyoutAnchor(null)} aria-hidden />
          <FlyoutShell
            title="Your Island"
            anchorRect={islandFlyoutAnchor}
            onClose={() => setIslandFlyoutAnchor(null)}
            onMouseEnter={cancelScheduledClose}
            onMouseLeave={() => scheduleFlyoutClose(() => setIslandFlyoutAnchor(null))}
          >
            <div className="space-y-1 pb-2">
              {myIslands.map((isl) => (
                <FlyoutLink
                  key={isl.id}
                  to={`/island/${isl.id}`}
                  label={isl.name}
                  Icon={islandFlyoutIcon(isl.icon)}
                  active={location.pathname === `/island/${isl.id}`}
                  onSelect={() => setIslandFlyoutAnchor(null)}
                />
              ))}
              {/* 공유받은 아일랜드도 여기서 바로 열 수 있어야 한다 — 없으면 관리 패널을
                  거쳐야만 접근된다. 읽기 전용이라는 건 아일랜드 헤더 배지가 알려준다. */}
              {sharedIslands.length > 0 && (
                <>
                  <div className="mx-2 my-1 border-t border-zinc-200" />
                  <p className="px-2.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    팀 공유
                  </p>
                  {sharedIslands.map((isl) => (
                    <FlyoutLink
                      key={isl.id}
                      to={`/island/${isl.id}`}
                      label={`${isl.name} · ${isl.ownerName || '공유'}`}
                      Icon={islandFlyoutIcon(isl.icon)}
                      active={location.pathname === `/island/${isl.id}`}
                      onSelect={() => setIslandFlyoutAnchor(null)}
                    />
                  ))}
                </>
              )}
            </div>
          </FlyoutShell>
        </>
      )}

      {/* 사용자 메뉴 — 우측 슬라이드 SidePane. 다른 상세 편집 패널(WbsFlowPage 등)과 동일한 패턴. */}
      {currentUser && (
        <SidePane
          open={userMenuOpen}
          onClose={() => setUserMenuOpen(false)}
          title={currentUser.displayName || currentUser.username}
          width="380px"
          bodyClassName="p-0"
        >
          <SelfAssigneePanel />
          <div className="border-t border-border">
            <Link
              to="/me/change-password"
              onClick={() => setUserMenuOpen(false)}
              className={`flex items-center gap-2 px-5 py-3 text-sm transition-colors ${
                location.pathname === '/me/change-password'
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-foreground hover:bg-secondary'
              }`}
            >
              <KeyRound className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1 min-w-0">비밀번호 변경</span>
              {location.pathname === '/me/change-password' && <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />}
            </Link>
          </div>
        </SidePane>
      )}

      {/* 릴리즈 노트 — 우측 슬라이드 SidePane. CHANGELOG.md 를 파싱한 API 를 표로 렌더.
          요약 텍스트가 잘리지 않도록 기본 폭을 넉넉히 잡고, 왼쪽 가장자리 드래그로 추가 확장 가능. */}
      <SidePane
        open={releaseNotesOpen}
        onClose={() => setReleaseNotesOpen(false)}
        title="릴리즈 노트"
        width="640px"
        bodyClassName="p-0"
        resizable
        widthStorageKey="k8s:releaseNotesPanelWidth"
        minWidth={420}
        maxWidth={1100}
      >
        <ReleaseNotesPanel open={releaseNotesOpen} />
      </SidePane>

      {/* 버그 픽스 로그 — 릴리즈 노트와 동일한 우측 슬라이드 SidePane. CHANGELOG 의 Fixed 항목만 표시. */}
      <SidePane
        open={bugFixLogOpen}
        onClose={() => setBugFixLogOpen(false)}
        title="버그 픽스 로그"
        width="640px"
        bodyClassName="p-0"
        resizable
        widthStorageKey="k8s:bugFixLogPanelWidth"
        minWidth={420}
        maxWidth={1100}
      >
        <BugFixLogPanel open={bugFixLogOpen} />
      </SidePane>

      {/* 사용자 VOC 게시판 — 릴리즈 노트와 동일한 우측 슬라이드 SidePane. */}
      <SidePane
        open={vocOpen}
        onClose={() => setVocOpen(false)}
        title="사용자 VOC 게시판"
        width="640px"
        bodyClassName="p-0"
        resizable
        widthStorageKey="k8s:vocPanelWidth"
        minWidth={420}
        maxWidth={1100}
      >
        <VocBoardPanel open={vocOpen} />
      </SidePane>

    </>
  );
}

