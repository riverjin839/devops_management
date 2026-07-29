import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import {
  ListTodo, Sparkles, Palmtree,
  Moon, Sun, Monitor, X, LogOut, User, ChevronRight, ArrowLeft,
  KeyRound, ShieldCheck, ScrollText, ServerCog, MessageSquare, Bug,
} from 'lucide-react';
import { useUiSettings } from '@/hooks/useUiSettings';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { useIslands } from '@/hooks/useIslands';
import { useThemeStore, type Theme } from '@/stores/themeStore';
import { NAV_WIDTH } from '@/stores/sidebarStore';
import { useAuthStore } from '@/stores/authStore';
import { useIslandStore } from '@/stores/islandStore';
import { useHomeStore } from '@/stores/homeStore';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import { SidePane } from '@/components/common';
import { SelfAssigneePanel } from './SelfAssigneePanel';
import { ReleaseNotesPanel } from './ReleaseNotesPanel';
import { BugFixLogPanel } from './BugFixLogPanel';
import { VocBoardPanel } from './VocBoardPanel';
import { GROUPS, type GroupId } from './navConfig';

// 정적 네비게이션 정의(NAV_MAP / GROUPS / GroupId / DEFAULT_TITLE)는 navConfig 로 분리 —
// Settings 의 "화면 UI 설정" 탭(NavMenuManager / PageStyleManager)과 공유한다.
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
          className="fixed px-2 py-1 text-sm font-medium whitespace-nowrap bg-zinc-700 text-white rounded shadow-lg pointer-events-none z-[60]"
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
      className="fixed z-50 bg-white text-black border border-zinc-200 rounded-md shadow-xl flex flex-col overflow-hidden min-w-[180px] max-w-[260px]"
      role="dialog"
      aria-label={title}
    >
      <div className="px-3 py-1.5 border-b border-zinc-200 flex items-center justify-between bg-zinc-50">
        <span className="text-xs font-semibold text-zinc-700 uppercase tracking-wider truncate">{title}</span>
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
  to, label, Icon, active, onSelect, iconColor, iconSize,
}: {
  to: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  active: boolean;
  onSelect: () => void;
  iconColor?: string;
  iconSize?: string;
}) {
  return (
    <Link
      to={to}
      onClick={onSelect}
      className={`${FLYOUT_LINK_BASE} ${active ? FLYOUT_LINK_ACTIVE : FLYOUT_LINK_INACTIVE}`}
    >
      <Icon className={`${iconSize || 'w-4 h-4'} flex-shrink-0 ${iconColor || ''}`} />
      <span className="flex-1 min-w-0 break-keep">{label}</span>
      {active && <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-primary" />}
    </Link>
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
  const { navMap, servicePaths, getLabel, featureAllowed } = useNavCatalog();

  const { mode, toggle } = useHomeStore();

  const handleHomeClick = () => {
    if (location.pathname === '/') {
      toggle();
    } else {
      // 업무현황 홈 = 메인 홈. 현재 모드를 유지한 채 홈으로 — 아이콘이 가리키는 홈으로 일관 이동.
      navigate('/');
    }
  };

  const homeTooltip = location.pathname === '/'
    ? (mode === 'work' ? '업무 현황 (클릭 시 플랫폼 현황)' : '플랫폼 현황 (클릭 시 업무 현황)')
    : (mode === 'work' ? '업무 현황 홈으로' : '플랫폼 현황 홈으로');

  // 전역 뒤로가기 — 브라우저 히스토리 기반(navigate(-1)). React Router 가 history.state.idx 를
  // 기록하므로 idx>0 이면 실제 이전 화면으로, 딥링크로 바로 진입(idx=0)했으면 홈으로 fallback.
  const historyIdx = (window.history.state?.idx as number | undefined) ?? 0;
  const canGoBack = historyIdx > 0;
  const handleBack = () => {
    if (canGoBack) navigate(-1);
    else navigate('/');
  };

  // 홈 버튼 아이콘 — 홈은 2개(업무현황=메인 홈 / 플랫폼현황)뿐이다. 어느 화면이든 현재 모드를
  // 모양으로 구분(업무=ListTodo, 플랫폼=ServerCog). Settings(홈 화면 설정)에서 모드별 커스텀 가능.
  const renderHomeButtonIcon = () => {
    const custom = mode === 'platform' ? settings?.homeIcons?.platform : settings?.homeIcons?.work;
    const resolved = resolveClusterIcon(custom);
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
    // 미설정 → 기본값 (업무=ListTodo, 플랫폼=ServerCog)
    return mode === 'platform'
      ? <ServerCog className="w-5 h-5" />
      : <ListTodo className="w-5 h-5" />;
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

  // 현재 모드에서 보여줄 그룹만 필터링 (상단 레일).
  // system(Settings) 그룹은 상단이 아니라 하단 푸터에서 admin 에게만 렌더한다.
  const visibleGroups = useMemo(
    () => GROUPS.filter((g) => g.modes.includes(mode) && g.id !== 'system'),
    [mode],
  );

  // 하단 푸터에 둘 Settings(system) 그룹 — admin 전용.
  const systemGroup = useMemo(() => GROUPS.find((g) => g.id === 'system') ?? null, []);

  // 현재 경로가 속한 그룹을 표시(레일에서 active 강조)
  const activeGroup: GroupId | null = useMemo(() => {
    if (location.pathname.startsWith('/services/')) return 'services';
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleGroup = (id: GroupId, rect?: DOMRect) => {
    setOpenGroup((cur) => (cur === id ? null : id));
    if (rect) setOpenAnchor(rect);
  };

  // 그룹별 flyout 본문 렌더링
  const renderFlyoutBody = (id: GroupId) => {
    const group = GROUPS.find((g) => g.id === id);
    if (!group) return null;
    const close = () => setOpenGroup(null);

    if (id === 'services') {
      return (
        <div className="space-y-1 pb-2">
          {group.paths.map((p) => {
            const entry = navMap[p];
            if (!entry || !featureAllowed(p)) return null;
            return (
              <FlyoutLink key={p} to={p} label={getLabel(p)} Icon={entry.icon} iconColor={entry.iconColor} iconSize={entry.iconSize}
                active={location.pathname === p} onSelect={close} />
            );
          })}
          {servicePaths.length > 0 && <div className="mx-2 my-1 border-t border-zinc-200" />}
          {servicePaths.map((p) => {
            const entry = navMap[p];
            if (!entry || !featureAllowed(p)) return null;
            return (
              <FlyoutLink key={p} to={p} label={getLabel(p)} Icon={entry.icon} iconColor={entry.iconColor} iconSize={entry.iconSize}
                active={location.pathname === p} onSelect={close} />
            );
          })}
        </div>
      );
    }

    if (id === 'system') {
      return (
        <div className="space-y-1 pb-2">
          {group.paths.map((p) => {
            const entry = navMap[p];
            if (!entry || !featureAllowed(p)) return null;
            return (
              <FlyoutLink key={p} to={p} label={getLabel(p)} Icon={entry.icon} iconColor={entry.iconColor} iconSize={entry.iconSize}
                active={location.pathname === p} onSelect={close} />
            );
          })}
        </div>
      );
    }

    return (
      <div className="space-y-1 pb-2">
        {group.paths.map((p) => {
          const entry = navMap[p];
          if (!entry || !featureAllowed(p)) return null;
          return (
            <FlyoutLink key={p} to={p} label={getLabel(p)} Icon={entry.icon} iconColor={entry.iconColor} iconSize={entry.iconSize}
              active={location.pathname === p} onSelect={close} />
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
          <button
            type="button"
            onClick={handleHomeClick}
            title={homeTooltip}
            aria-label={homeTooltip}
            className={`w-9 h-9 bg-gradient-to-br rounded-md flex items-center justify-center text-white shadow-sm transition-transform hover:scale-105 active:scale-95 ${
              mode === 'platform' ? 'from-amber-500 to-orange-600' : 'from-primary to-sky-700'
            } ${
              location.pathname === '/'
                ? mode === 'platform'
                  ? 'ring-2 ring-amber-300/70'
                  : 'ring-2 ring-primary/50'
                : ''
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

        {/* 그룹 아이콘 레일 — 현재 모드에 맞는 그룹만 표시 */}
        <nav className="flex-1 py-2 overflow-y-auto" aria-label="메인 네비게이션">
          <div className="flex flex-col items-center gap-1">
            {visibleGroups.map((g) => (
              <RailIconButton
                key={g.id}
                label={g.label}
                Icon={g.icon}
                active={activeGroup === g.id}
                highlighted={openGroup === g.id}
                suppressTooltip={openGroup === g.id}
                onClick={(rect) => {
                  // 하위 경로가 1개뿐인 그룹(PEP 서비스/APP 서비스 등)은 플라이아웃이 무의미하므로
                  // 바로 이동. 2개 이상이면 플라이아웃으로 하위 메뉴를 고른다.
                  if (g.paths.length === 1) { setOpenGroup(null); navigate(g.paths[0]); }
                  else toggleGroup(g.id, rect);
                }}
              />
            ))}
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
              onClick={(rect) => {
                // 하위 경로가 1개뿐이면(현재 '/settings' 단일) 플라이아웃 없이 바로 이동.
                if (systemGroup.paths.length === 1) { setOpenGroup(null); navigate(systemGroup.paths[0]); }
                else toggleGroup('system', rect);
              }}
            />
          )}
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
              onClick={goToIsland}
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
          {isAdmin && (
            <RailIconButton
              label="사용자 관리"
              Icon={ShieldCheck}
              active={location.pathname === '/settings/users'}
              onClick={() => navigate('/settings/users')}
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

      {/* Your Island flyout — 아일랜드가 여러 개일 때 목록에서 고른다. */}
      {islandFlyoutAnchor && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIslandFlyoutAnchor(null)} aria-hidden />
          <FlyoutShell
            title="Your Island"
            anchorRect={islandFlyoutAnchor}
            onClose={() => setIslandFlyoutAnchor(null)}
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

