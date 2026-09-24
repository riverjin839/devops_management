import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Plus, Leaf, Contrast, Brush, Paintbrush, Frame, Newspaper, Shapes, Diamond, Shell,
  Moon, Sun, Monitor, LogOut, User,
  KeyRound, Home, MessageSquare, Bot, HelpCircle, Search, ScrollText, Bug, UserCog, Palette,
} from 'lucide-react';
import { useUiSettings } from '@/hooks/useUiSettings';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { useHomePrefs, useUpdateHomePrefs } from '@/hooks/useHomePrefs';
import { useThemeStore, accentApplies, ACCENTS, THEMES, type Accent, type Theme } from '@/stores/themeStore';
import { ACCENT_SWATCH, ACCENT_LABEL } from '@/lib/themeSwatches';
import { NAV_WIDTH } from '@/stores/sidebarStore';
import { useAuthStore } from '@/stores/authStore';
import { useAgentChatStore } from '@/stores/agentChatStore';
import { AGENT_CHAT_FEATURE_KEY } from '@/components/agent';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import { SidePane, ConfirmDialog } from '@/components/common';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { SelfAssigneePanel } from './SelfAssigneePanel';
import { UserFeedbackPanel, USER_FEEDBACK_TAB_TITLE, type UserFeedbackTab } from './UserFeedbackPanel';
import { FlyoutShell, FlyoutLink, FlyoutAction } from './NavFlyout';
import { AddAppDialog } from './AddAppDialog';
import { installableAppById, sidebarAppSections } from './installableApps';

// 정적 네비게이션 정의(NAV_MAP / GROUPS / GroupId / DEFAULT_TITLE)는 navConfig 로 분리 —
// Settings 의 "화면 UI 설정" 탭(NavMenuManager / PageStyleManager)과 공유한다.
// D-077 — 테마는 레일 버튼 순환 클릭이 아니라 사용자 메뉴 안의 목록에서 1클릭으로 고른다.
// P2 — 바탕 테마 4종 + 시스템, 그 아래 강조색 6종(대표 색 스와치). 전체를 카드로 비교하는
// "테마 갤러리"는 Settings ▸ 화면 UI 설정 탭에 별도로 있다.
const THEME_ICON: Record<Theme, ComponentType<{ className?: string }>> = {
  light: Sun,
  dark: Moon,
  comfort: Leaf,
  'high-contrast': Contrast,
  umber: Brush,
  'umber-light': Paintbrush,
  plaster: Frame,
  journal: Newspaper,
  relief: Shapes,
  harlequin: Diamond,
  ozenfant: Shell,
  system: Monitor,
};
const THEME_LABEL: Record<Theme, string> = {
  light: '라이트 (기본)',
  dark: '다크',
  comfort: '컴포트',
  'high-contrast': '고대비',
  umber: '움버',
  'umber-light': '움버 라이트',
  plaster: '플래스터',
  journal: '아침 식사',
  relief: '릴리프',
  harlequin: '할리퀸과 목걸이를 한 여인',
  ozenfant: '오장팡 자개',
  system: '시스템',
};
// 강조색 스와치 아이콘 — 팩토리로 한 번만 만들어 매 렌더마다 컴포넌트 정체성이 바뀌지 않게 한다.
function makeAccentSwatchIcon(accent: Accent): ComponentType<{ className?: string }> {
  const hsl = ACCENT_SWATCH[accent];
  return function AccentSwatchIcon({ className }: { className?: string }) {
    return (
      <span
        className={`${className ?? ''} inline-block rounded-full ring-1 ring-inset ring-border/60`}
        style={{ backgroundColor: `hsl(${hsl})` }}
        aria-hidden="true"
      />
    );
  };
}
const ACCENT_SWATCH_ICON = Object.fromEntries(
  ACCENTS.map((a) => [a, makeAccentSwatchIcon(a)]),
) as Record<Accent, ComponentType<{ className?: string }>>;

// flyout 을 여는 아이콘에 마우스를 올렸을 때 클릭 없이 바로 열리게 하는 hover-intent 지연.
// OPEN 은 레일을 스쳐 지나가는 마우스에 flyout 이 깜빡이지 않도록, CLOSE 는 아이콘→flyout
// 이동 중 잠깐 hover 가 끊겨도 안 닫히도록 여유를 둔다(패널 쪽 onMouseEnter 가 다시 취소).
const HOVER_OPEN_DELAY = 150;
const HOVER_CLOSE_DELAY = 200;

// ── 호버 툴팁이 붙은 아이콘 버튼 — 레일에서 사용 ────────────────────────────
interface RailIconButtonProps {
  label: string;
  Icon: ComponentType<{ className?: string }>;
  active?: boolean;
  highlighted?: boolean;
  /** 클릭 시 호출. 클릭한 버튼의 화면상 위치(popover 앵커링)와 버튼 element(D-080 — flyout 이
   *  닫힐 때 포커스를 돌려줄 트리거)를 같이 넘긴다. 단순 액션(라우팅 등)은 무시해도 된다. */
  onClick: (rect?: DOMRect, el?: HTMLButtonElement | null) => void;
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
    if (rect) onClick(rect, buttonRef.current);
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
        aria-haspopup={hasFlyout ? 'menu' : undefined}
        aria-expanded={hasFlyout ? !!highlighted : undefined}
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
          className="fixed px-2 py-1 text-sm font-medium whitespace-nowrap bg-foreground text-background rounded shadow-lg pointer-events-none z-[60]"
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export function Sidebar() {
  const { theme, setTheme, accent, setAccent } = useThemeStore();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: settings } = useUiSettings();

  const currentUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.clear);
  const isAdmin = currentUser?.role === 'admin';
  // 동적 navMap / 라벨 오버라이드 / 기능별 접근 제어 — 설치된 leaf 아이콘 렌더에 사용.
  const { navMap, getLabel, featureAllowed } = useNavCatalog();

  // 사이드바 "SaaS 앱" 개편 — 레일에는 사용자가 설치(opt-in)한 것만 순서대로 보인다.
  // 기본값은 빈 리스트("+" 버튼만) 이고, 기존 계정은 백엔드 1회 이관으로 채워져 있다.
  // 설치 단위는 leaf(최하위) 페이지 하나하나 — installedApps 배열은 Sidebar/AppTopBar 가
  // 공유하므로, 여기서는 그중 platform/system 도메인(+뒤로가기)에 해당하는 것만 골라 그린다.
  const { data: homePrefs } = useHomePrefs();
  const updateHomePrefs = useUpdateHomePrefs();
  const installedApps = useMemo(() => homePrefs?.installedApps ?? [], [homePrefs?.installedApps]);
  const sidebarInstalled = useMemo(
    () => installedApps.filter((id) => {
      const meta = installableAppById(id);
      return meta && (meta.domain === 'platform' || meta.domain === 'system');
    }),
    [installedApps],
  );
  const [catalogOpen, setCatalogOpen] = useState(false);
  const toggleInstalledApp = (id: string) => {
    const next = installedApps.includes(id) ? installedApps.filter((x) => x !== id) : [...installedApps, id];
    updateHomePrefs.mutate({ installedApps: next });
  };

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

  // D-077 — 레일 하단 개인 존을 사용자 메뉴(아바타) flyout 하나로 접었다: 내 정보·담당 설정
  // (SidePane) / 테마 / 비밀번호 변경 / 로그아웃(확인). 예전엔 테마·사용자·VOC·로그아웃이
  // 무라벨 아이콘 4개로 나란히 있어 로그아웃 오클릭이 잦았다.
  const [userFlyoutAnchor, setUserFlyoutAnchor] = useState<DOMRect | null>(null);
  const [selfPaneOpen, setSelfPaneOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  // "도움말·지원" flyout — 화면 검색(⌘K) / VOC / 릴리즈 노트 / 버그 픽스 로그(admin).
  // 개발팀 내부 산출물(버그 픽스 로그)이 제품 셸에 상시 노출되던 것을 admin 전용으로 격리.
  const [helpFlyoutAnchor, setHelpFlyoutAnchor] = useState<DOMRect | null>(null);
  const openPalette = useCommandPaletteStore((s) => s.setOpen);
  // 사용자 VOC 게시판 / 릴리즈 노트 / 버그 픽스 로그 — 우측 SidePane 하나 + 탭.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackTab, setFeedbackTab] = useState<UserFeedbackTab>('voc');
  // D-080 — flyout 을 클릭/키보드로 열었는지(첫 항목 포커스 + 닫힐 때 트리거 복귀) hover 로
  // 열었는지(포커스 불간섭). 열 때마다 갱신하고 모든 FlyoutShell 에 같이 넘긴다.
  const [flyoutFocus, setFlyoutFocus] = useState<{ autoFocus: boolean; trigger: HTMLElement | null }>({ autoFocus: false, trigger: null });
  const openByClick = (el?: HTMLElement | null) => setFlyoutFocus({ autoFocus: true, trigger: el ?? null });

  // 마우스를 flyout 이 있는 아이콘에 올리면(hover-intent) 클릭 없이도 열리고, 벗어나면
  // 지연 후 닫힌다. 아이콘→패널로 이동하는 짧은 순간 hover 가 끊겨도 패널 쪽
  // onMouseEnter(cancelScheduledClose) 가 예약된 닫기를 취소해준다.
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const clearHoverTimers = () => {
    if (openTimerRef.current !== undefined) { window.clearTimeout(openTimerRef.current); openTimerRef.current = undefined; }
    if (closeTimerRef.current !== undefined) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = undefined; }
  };
  // 여러 flyout 이 동시에 열리지 않도록, 새로 열기 전에 나머지를 전부 닫는다.
  const closeAllFlyouts = () => {
    setUserFlyoutAnchor(null);
    setHelpFlyoutAnchor(null);
  };
  const scheduleFlyoutOpen = (openFn: () => void) => {
    clearHoverTimers();
    openTimerRef.current = window.setTimeout(() => {
      closeAllFlyouts();
      setFlyoutFocus({ autoFocus: false, trigger: null });
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

  // 경로 변경되면 flyout 자동 닫기
  useEffect(() => {
    setUserFlyoutAnchor(null);
    setHelpFlyoutAnchor(null);
    setSelfPaneOpen(false);
    setFeedbackOpen(false);
  }, [location.pathname]);

  // ESC 로 flyout / edit mode 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setUserFlyoutAnchor(null);
        setHelpFlyoutAnchor(null);
        setSelfPaneOpen(false);
        setFeedbackOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** flyout 이 닫힐 때(라우팅/액션) 호출 — 포커스 복귀는 FlyoutShell 이 트리거로 알아서 한다. */
  const focusProps = { autoFocus: flyoutFocus.autoFocus, returnFocusTo: flyoutFocus.trigger };

  const catalogSections = useMemo(() => sidebarAppSections(isAdmin), [isAdmin]);

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
            className={`w-9 h-9 bg-gradient-to-br from-primary to-status-info rounded-md flex items-center justify-center text-white shadow-sm transition-transform hover:scale-105 active:scale-95 ${
              location.pathname === '/' ? 'ring-2 ring-primary/50' : ''
            }`}
          >
            {renderHomeButtonIcon()}
          </button>
        </div>

        {/* leaf 아이콘 레일 — 사용자가 설치(opt-in)한 leaf 페이지만, 설치 순서대로 직행
            링크로 보인다(그룹 flyout 없음 — 설치 단위 자체가 이미 최하위 메뉴). 기본은
            빈 레일 + "+" 버튼(맨 아래) 뿐이다 — 뒤로가기도 설치 대상, 홈은 유일한 예외로
            위 로고가 항상 대신한다. */}
        <nav className="flex-1 py-2 overflow-y-auto" aria-label="메인 네비게이션">
          <div className="flex flex-col items-center gap-1">
            {sidebarInstalled.map((appId) => {
              if (appId === 'back') {
                if (location.pathname === '/') return null;
                const backApp = installableAppById('back')!;
                return (
                  <RailIconButton key="back" label={backApp.label} Icon={backApp.icon} onClick={handleBack} />
                );
              }
              const meta = installableAppById(appId);
              if (meta?.adminOnly && !isAdmin) return null;
              const entry = navMap[appId];
              if (!entry || !featureAllowed(appId)) return null;
              return (
                <RailIconButton
                  key={appId}
                  label={getLabel(appId)}
                  Icon={entry.icon}
                  active={location.pathname === appId}
                  onClick={() => navigate(appId)}
                />
              );
            })}
            <RailIconButton label="사이드바에 앱 추가" Icon={Plus} onClick={() => setCatalogOpen(true)} />
          </div>
        </nav>

        {/* 푸터 — 설정(admin) / AI / 도움말·지원 / 사용자 메뉴. */}
        <div className="flex-shrink-0 border-t border-border py-2 flex flex-col items-center gap-1">
          {/* AI 어시스턴트 — 패널(AgentChat.tsx)은 이 상태를 Zustand 로 공유해서 연다.
              접근 제어(기능 접근)가 꺼진 사용자에게는 아이콘 자체를 숨긴다. */}
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
              label="도움말·지원"
              Icon={HelpCircle}
              highlighted={!!helpFlyoutAnchor}
              suppressTooltip={!!helpFlyoutAnchor}
              hasFlyout
              onHoverOpen={(rect) => scheduleFlyoutOpen(() => setHelpFlyoutAnchor(rect))}
              onHoverClose={() => scheduleFlyoutClose(() => setHelpFlyoutAnchor(null))}
              onClick={(rect, el) => {
                clearHoverTimers();
                const wasOpen = !!helpFlyoutAnchor;
                closeAllFlyouts();
                openByClick(el);
                if (!wasOpen) setHelpFlyoutAnchor(rect ?? null);
              }}
            />
          )}
          {currentUser && (
            <RailIconButton
              label={`${currentUser.displayName || currentUser.username} · ${currentUser.role}`}
              Icon={User}
              highlighted={!!userFlyoutAnchor}
              suppressTooltip={!!userFlyoutAnchor}
              hasFlyout
              onHoverOpen={(rect) => scheduleFlyoutOpen(() => setUserFlyoutAnchor(rect))}
              onHoverClose={() => scheduleFlyoutClose(() => setUserFlyoutAnchor(null))}
              onClick={(rect, el) => {
                clearHoverTimers();
                const wasOpen = !!userFlyoutAnchor;
                closeAllFlyouts();
                openByClick(el);
                if (!wasOpen) setUserFlyoutAnchor(rect ?? null);
              }}
            />
          )}
        </div>
      </aside>

      {/* 도움말·지원 flyout — 화면 검색(⌘K) / VOC / 릴리즈 노트 / 버그 픽스 로그(admin). */}
      {helpFlyoutAnchor && currentUser && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setHelpFlyoutAnchor(null)} aria-hidden />
          <FlyoutShell
            title="도움말·지원"
            anchorRect={helpFlyoutAnchor}
            {...focusProps}
            onClose={() => setHelpFlyoutAnchor(null)}
            onMouseEnter={cancelScheduledClose}
            onMouseLeave={() => scheduleFlyoutClose(() => setHelpFlyoutAnchor(null))}
          >
            <div className="space-y-1 pb-2">
              <FlyoutAction
                label="화면 검색"
                Icon={Search}
                trailing={<kbd className="text-[11px] font-mono text-muted-foreground border border-border rounded px-1">⌘K</kbd>}
                onSelect={() => { setHelpFlyoutAnchor(null); openPalette(true); }}
              />
              <div className="mx-2 my-1 border-t border-border" />
              <FlyoutAction
                label="사용자 VOC 게시판"
                Icon={MessageSquare}
                onSelect={() => { setHelpFlyoutAnchor(null); setFeedbackTab('voc'); setFeedbackOpen(true); }}
              />
              <FlyoutAction
                label="릴리즈 노트"
                Icon={ScrollText}
                onSelect={() => { setHelpFlyoutAnchor(null); setFeedbackTab('release-notes'); setFeedbackOpen(true); }}
              />
              {isAdmin && (
                <FlyoutAction
                  label="버그 픽스 로그"
                  Icon={Bug}
                  title="admin 전용 — 개발팀 내부 산출물"
                  onSelect={() => { setHelpFlyoutAnchor(null); setFeedbackTab('bug-fix-log'); setFeedbackOpen(true); }}
                />
              )}
            </div>
          </FlyoutShell>
        </>
      )}

      {/* 사용자 메뉴 flyout — 내 정보·담당 설정 / 비밀번호 변경 / 테마 / 로그아웃(확인). */}
      {userFlyoutAnchor && currentUser && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setUserFlyoutAnchor(null)} aria-hidden />
          <FlyoutShell
            title={`${currentUser.displayName || currentUser.username} · ${currentUser.role}`}
            anchorRect={userFlyoutAnchor}
            {...focusProps}
            onClose={() => setUserFlyoutAnchor(null)}
            onMouseEnter={cancelScheduledClose}
            onMouseLeave={() => scheduleFlyoutClose(() => setUserFlyoutAnchor(null))}
          >
            <div className="space-y-1 pb-2">
              <FlyoutAction
                label="내 정보 · 담당 설정"
                Icon={UserCog}
                onSelect={() => { setUserFlyoutAnchor(null); setSelfPaneOpen(true); }}
              />
              <FlyoutLink
                to="/me/change-password"
                label="비밀번호 변경"
                Icon={KeyRound}
                active={location.pathname === '/me/change-password'}
                onSelect={() => setUserFlyoutAnchor(null)}
              />
              <div className="mx-2 my-1 border-t border-border" />
              <p className="px-2.5 pt-1.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                <Palette className="w-3 h-3" aria-hidden="true" /> 테마
              </p>
              {THEMES.map((t) => (
                <FlyoutAction key={t} label={THEME_LABEL[t]} Icon={THEME_ICON[t]} checked={theme === t} onSelect={() => setTheme(t)} />
              ))}
              <p className="px-2.5 pt-1.5 pb-0.5 text-[11px] text-muted-foreground">강조색</p>
              {ACCENTS.map((a) => (
                <FlyoutAction
                  key={a}
                  label={ACCENT_LABEL[a]}
                  Icon={ACCENT_SWATCH_ICON[a]}
                  checked={accent === a}
                  disabled={!accentApplies(theme)}
                  title={accentApplies(theme) ? undefined : '그림 테마(움버·플래스터·아침 식사·릴리프·할리퀸과 목걸이를 한 여인·오장팡 자개)와 컴포트·고대비 바탕은 자체 색을 써서 강조색을 바꿀 수 없다'}
                  onSelect={() => setAccent(a)}
                />
              ))}
              <div className="mx-2 my-1 border-t border-border" />
              <FlyoutAction
                label="로그아웃"
                Icon={LogOut}
                tone="danger"
                onSelect={() => { setUserFlyoutAnchor(null); setLogoutConfirmOpen(true); }}
              />
            </div>
          </FlyoutShell>
        </>
      )}

      {/* 로그아웃 확인 — 1클릭 즉시 로그아웃이던 것을 확인 다이얼로그로(작성 중인 폼 보호). */}
      <ConfirmDialog
        open={logoutConfirmOpen}
        title="로그아웃"
        description="작성 중인 내용은 저장되지 않습니다. 로그아웃할까요?"
        confirmLabel="로그아웃"
        danger
        onConfirm={() => { setLogoutConfirmOpen(false); logout(); }}
        onCancel={() => setLogoutConfirmOpen(false)}
      />

      {/* 사이드바 "앱 추가" 카탈로그 — 레일에 설치할 leaf 페이지를 그룹 섹션별 카드에서 골라 켠다. */}
      <AddAppDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        title="사이드바에 앱 추가"
        description="필요한 화면만 골라 레일에 추가한다."
        sections={catalogSections}
        installedApps={installedApps}
        onToggle={toggleInstalledApp}
      />

      {/* 내 정보·담당 설정 — 우측 슬라이드 SidePane. 다른 상세 편집 패널(WbsFlowPage 등)과 동일한 패턴. */}
      {currentUser && (
        <SidePane
          open={selfPaneOpen}
          onClose={() => setSelfPaneOpen(false)}
          title={currentUser.displayName || currentUser.username}
          width="380px"
          bodyClassName="p-0"
        >
          <SelfAssigneePanel />
        </SidePane>
      )}

      {/* 사용자 VOC 게시판 / 릴리즈 노트 / 버그 픽스 로그 — 우측 슬라이드 SidePane 하나에
          탭 3개로 통합. 제목은 활성 탭을 따라간다. */}
      <SidePane
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        title={USER_FEEDBACK_TAB_TITLE[feedbackTab]}
        width="640px"
        bodyClassName="p-0"
        resizable
        widthStorageKey="k8s:userFeedbackPanelWidth"
        minWidth={420}
        maxWidth={1100}
      >
        <UserFeedbackPanel open={feedbackOpen} activeTab={feedbackTab} onTabChange={setFeedbackTab} showBugFixLog={isAdmin} />
      </SidePane>

    </>
  );
}
