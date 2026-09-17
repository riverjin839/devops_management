import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, Star, Sun, Search, Menu, Plus, Palmtree } from 'lucide-react';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { useAuthStore } from '@/stores/authStore';
import { useFavorites } from '@/hooks/useFavorites';
import { useHomePrefs, useUpdateHomePrefs } from '@/hooks/useHomePrefs';
import { useIslands } from '@/hooks/useIslands';
import { useIslandStore } from '@/stores/islandStore';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { useToday } from '@/hooks/useToday';
import { cn, fmtKoreanDate } from '@/lib/utils';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import { FlyoutShell, FlyoutLink, FlyoutAction } from './NavFlyout';
import { FavoritesFlyoutBody } from './FavoritesFlyoutBody';
import { WorkAlarmBell } from './WorkAlarmBell';
import { AddAppDialog } from './AddAppDialog';
import { installableAppById, topbarAppSections } from './installableApps';

// Sidebar.tsx 의 flyout hover-intent 와 동일한 지연값 — 두 진입점의 체감 반응 속도를 맞춘다.
const HOVER_OPEN_DELAY = 150;
const HOVER_CLOSE_DELAY = 200;

/** 아일랜드 아이콘(lucide 이름/이모지/이미지) → flyout 이 기대하는 ComponentType. */
function islandFlyoutIcon(icon?: string | null) {
  const resolved = resolveClusterIcon(icon);
  return resolved?.kind === 'lucide' ? resolved.Component : Palmtree;
}

/**
 * 전역 상단바 — 사용자가 설치(opt-in)한 업무 도메인 leaf 페이지 + 즐겨찾기/Your Island 를
 * 이름 옆에 노출한다.
 *
 * 예전엔 "협업"/"문서 관리" 그룹 전체와 즐겨찾기가 항상 떠 있었다. 사용자 요청("업무 관리로
 * 개명 + 문서관리·즐겨찾기·아일랜드도 개인이 추가하는 방식으로")에 따라 사이드바와 같은
 * opt-in leaf 카탈로그로 바꿨다 — 기본은 빈 목록 + "+" 버튼뿐이고, 기존 계정은 1회 이관으로
 * 이전과 동일한 항목이 채워진다(main.py::_backfill_installed_sidebar_apps).
 */
export function AppTopBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const myName = user?.displayName?.trim() || user?.username || null;
  useToday(); // 자정 넘기면 날짜 표기가 갱신되도록 리렌더만 구독(반환값은 안 씀)
  const { navMap, getLabel, featureAllowed } = useNavCatalog();
  const { isPinned, togglePin } = useFavorites();

  const { data: homePrefs } = useHomePrefs();
  const updateHomePrefs = useUpdateHomePrefs();
  const installedApps = useMemo(() => homePrefs?.installedApps ?? [], [homePrefs?.installedApps]);
  const topbarInstalled = useMemo(
    () => installedApps.filter((id) => installableAppById(id)?.domain === 'work'),
    [installedApps],
  );
  const [catalogOpen, setCatalogOpen] = useState(false);
  const toggleInstalledApp = (id: string) => {
    const next = installedApps.includes(id) ? installedApps.filter((x) => x !== id) : [...installedApps, id];
    updateHomePrefs.mutate({ installedApps: next });
  };
  const catalogSections = useMemo(() => topbarAppSections(), []);

  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [favoritesAnchor, setFavoritesAnchor] = useState<DOMRect | null>(null);
  // Your Island — 내 아일랜드가 2개 이상이면 클릭 시 flyout 으로 고른다.
  const { data: islandData } = useIslands();
  const myIslands = useMemo(() => islandData?.data ?? [], [islandData?.data]);
  const sharedIslands = useMemo(() => islandData?.shared ?? [], [islandData?.shared]);
  const lastIslandId = useIslandStore((s) => s.lastIslandId);
  const islandHasFlyout = myIslands.length + sharedIslands.length > 1;
  const [islandFlyoutAnchor, setIslandFlyoutAnchor] = useState<DOMRect | null>(null);

  // D-076 — `lg:` 미만(<1024px)에서는 버튼이 `overflow-x-auto` 로 조용히 잘려 보이지
  // 않게 밀려나므로, 개별 버튼 대신 이 트리거 하나로 접는다.
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState<DOMRect | null>(null);
  const openPalette = useCommandPaletteStore((s) => s.setOpen);
  // D-080 — 클릭/키보드로 연 flyout 만 첫 항목으로 포커스를 옮기고 닫힐 때 트리거로 돌아온다.
  // hover 로 연 것은 포커스를 건드리지 않는다(Sidebar.tsx 와 동일).
  const [flyoutFocus, setFlyoutFocus] = useState<{ autoFocus: boolean; trigger: HTMLElement | null }>({ autoFocus: false, trigger: null });
  const focusProps = { autoFocus: flyoutFocus.autoFocus, returnFocusTo: flyoutFocus.trigger };

  // 마우스를 올리면(hover-intent) 클릭 없이도 드롭다운이 바로 열리고, 벗어나면 지연 후
  // 닫힌다. Sidebar.tsx 와 동일한 패턴 — 패널 위에서는 onMouseEnter 가 예약된 닫기를
  // 취소해준다(FlyoutShell onMouseEnter/onMouseLeave).
  const openTimerRef = useRef<number | undefined>(undefined);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const clearHoverTimers = () => {
    if (openTimerRef.current !== undefined) { window.clearTimeout(openTimerRef.current); openTimerRef.current = undefined; }
    if (closeTimerRef.current !== undefined) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = undefined; }
  };
  // 여러 드롭다운이 동시에 열리지 않도록, 새로 열기 전에 나머지를 전부 닫는다.
  const closeAllFlyouts = () => {
    setFavoritesOpen(false);
    setIslandFlyoutAnchor(null);
    setMoreOpen(false);
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

  useEffect(() => { setFavoritesOpen(false); setIslandFlyoutAnchor(null); setMoreOpen(false); }, [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setFavoritesOpen(false); setIslandFlyoutAnchor(null); setMoreOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const goToIsland = (rect?: DOMRect, el?: HTMLElement | null) => {
    if (islandHasFlyout) {
      clearHoverTimers();
      const wasOpen = !!islandFlyoutAnchor;
      closeAllFlyouts();
      setFlyoutFocus({ autoFocus: true, trigger: el ?? null });
      if (!wasOpen) setIslandFlyoutAnchor(rect ?? null);
      return;
    }
    setIslandFlyoutAnchor(null);
    const target = myIslands[0]?.id ?? sharedIslands[0]?.id ?? lastIslandId;
    navigate(target ? `/island/${target}` : '/island');
  };

  const dateStr = fmtKoreanDate(new Date());

  /** leaf 링크 하나를 가로 pill 버튼으로 그린다 — 설치 단위 자체가 최하위 메뉴라 드롭다운이 없다. */
  const renderLeafButton = (path: string, key: string) => {
    const entry = navMap[path];
    if (!entry || !featureAllowed(path)) return null;
    const active = location.pathname === path;
    return (
      <Link
        key={key}
        to={path}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors',
          active ? 'bg-primary/10 text-primary font-semibold' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
        )}
      >
        <entry.icon className={cn('w-4 h-4 flex-shrink-0', entry.iconColor)} />
        {getLabel(path)}
      </Link>
    );
  };

  const renderInstalled = () => topbarInstalled.map((appId) => {
    if (appId === 'favorites') {
      const isOpen = favoritesOpen;
      return (
        <button
          key="favorites"
          type="button"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          title="즐겨찾기"
          aria-label="즐겨찾기"
          onMouseEnter={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            scheduleFlyoutOpen(() => { setFavoritesOpen(true); setFavoritesAnchor(rect); });
          }}
          onMouseLeave={() => scheduleFlyoutClose(() => setFavoritesOpen(false))}
          onClick={(e) => {
            clearHoverTimers();
            const rect = e.currentTarget.getBoundingClientRect();
            const wasOpen = favoritesOpen;
            closeAllFlyouts();
            setFlyoutFocus({ autoFocus: true, trigger: e.currentTarget });
            if (!wasOpen) { setFavoritesAnchor(rect); setFavoritesOpen(true); }
          }}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors',
            isOpen ? 'bg-primary/10 text-primary font-semibold' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          <Star className="w-4 h-4 flex-shrink-0" />
          즐겨찾기
        </button>
      );
    }
    if (appId === 'island') {
      const isOpen = !!islandFlyoutAnchor;
      return (
        <button
          key="island"
          type="button"
          aria-haspopup={islandHasFlyout ? 'menu' : undefined}
          aria-expanded={islandHasFlyout ? isOpen : undefined}
          title="나의 아일랜드"
          aria-label="나의 아일랜드"
          onMouseEnter={!islandHasFlyout ? undefined : (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            scheduleFlyoutOpen(() => setIslandFlyoutAnchor(rect));
          }}
          onMouseLeave={!islandHasFlyout ? undefined : () => scheduleFlyoutClose(() => setIslandFlyoutAnchor(null))}
          onClick={(e) => { clearHoverTimers(); goToIsland(e.currentTarget.getBoundingClientRect(), e.currentTarget); }}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors',
            location.pathname.startsWith('/island') || isOpen
              ? 'bg-primary/10 text-primary font-semibold'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          <Palmtree className="w-4 h-4 flex-shrink-0" />
          나의 아일랜드
        </button>
      );
    }
    return renderLeafButton(appId, appId);
  });

  return (
    <header className="sticky top-0 z-30 flex-none h-[var(--topbar-h)] flex items-center gap-3 pl-3 lg:pl-4 pr-3 lg:pr-4 border-b border-border bg-background/95 backdrop-blur">
      {/* 사용자 / 날짜 */}
      <div className="relative z-10 flex items-center gap-2 min-w-0 flex-shrink-0">
        <Sun className="w-4 h-4 text-primary flex-shrink-0" />
        {myName && <span className="text-sm font-bold leading-none whitespace-nowrap">{myName}님</span>}
        <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">{dateStr}</span>
      </div>

      {/* 설치된 업무 도메인 앱 — 사용자가 opt-in 으로 고른 leaf 페이지 + 즐겨찾기/아일랜드.
          relative z-10 로 아래 click-outside 오버레이(z-0)보다 위에 둔다 — 안 그러면 버튼이
          포지션 없는 요소라 오버레이가 항상 위에 그려져, hover 로 연 flyout 이 열리자마자
          오버레이에 가려 mouseleave 로 판정돼 바로 닫혀버린다. */}
      <nav aria-label="업무" className="relative z-10 hidden lg:flex items-center gap-1 min-w-0 overflow-x-auto">
        {renderInstalled()}
        <button
          type="button"
          title="상단바에 앱 추가"
          aria-label="상단바에 앱 추가"
          onClick={() => setCatalogOpen(true)}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors flex-shrink-0"
        >
          <Plus className="w-4 h-4" />
        </button>
      </nav>

      {/* D-076 — 1024px 미만은 개별 버튼 대신 이 트리거 하나로 접는다. */}
      <div className="relative z-10 lg:hidden flex items-center gap-1">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          title="업무 메뉴"
          aria-label="업무 메뉴"
          onMouseEnter={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            scheduleFlyoutOpen(() => { setMoreOpen(true); setMoreAnchor(rect); });
          }}
          onMouseLeave={() => scheduleFlyoutClose(() => setMoreOpen(false))}
          onClick={(e) => {
            clearHoverTimers();
            const rect = e.currentTarget.getBoundingClientRect();
            setFlyoutFocus({ autoFocus: true, trigger: e.currentTarget });
            setMoreAnchor(rect);
            setMoreOpen((cur) => !cur);
          }}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors',
            moreOpen
              ? 'bg-primary/10 text-primary font-semibold'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          <Menu className="w-4 h-4 flex-shrink-0" />
          메뉴
          <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
        </button>
        <button
          type="button"
          title="상단바에 앱 추가"
          aria-label="상단바에 앱 추가"
          onClick={() => setCatalogOpen(true)}
          className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors flex-shrink-0"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="relative z-10 ml-auto flex items-center gap-1.5 flex-shrink-0">
        {/* D-073 — 화면 검색(커맨드 팔레트) 진입점. 넓은 화면에선 검색창 모양, 좁으면 아이콘만. */}
        <button
          type="button"
          onClick={() => openPalette(true)}
          title="화면 검색 (Ctrl/⌘+K)"
          aria-label="화면 검색 (Ctrl/⌘+K)"
          aria-keyshortcuts="Control+K Meta+K"
          className={cn(
            'flex items-center gap-2 h-8 rounded-lg border border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors',
            'w-8 justify-center md:w-auto md:justify-start md:px-2.5 md:min-w-[180px]',
          )}
        >
          <Search className="w-4 h-4 flex-shrink-0" />
          <span className="hidden md:inline text-xs flex-1 text-left">화면 검색</span>
          <kbd className="hidden md:inline text-[10px] font-mono border border-border rounded px-1">⌘K</kbd>
        </button>
        <div className="flex items-center rounded-lg border border-border bg-card overflow-hidden">
          <WorkAlarmBell />
        </div>
      </div>

      {moreOpen && moreAnchor && (
        <>
          <div className="fixed inset-0 z-0" onClick={() => setMoreOpen(false)} aria-hidden />
          <FlyoutShell
            title="업무 메뉴"
            anchorRect={moreAnchor}
            placement="bottom"
            {...focusProps}
            onClose={() => setMoreOpen(false)}
            onMouseEnter={cancelScheduledClose}
            onMouseLeave={() => scheduleFlyoutClose(() => setMoreOpen(false))}
          >
            <div className="space-y-1 pb-2">
              {topbarInstalled.length === 0 && (
                <div className="px-3 py-4 text-xs text-muted-foreground text-center leading-relaxed">
                  설치된 앱이 없습니다.
                </div>
              )}
              {topbarInstalled.map((appId) => {
                if (appId === 'favorites') {
                  return (
                    <FlyoutAction
                      key="favorites"
                      label="즐겨찾기"
                      Icon={Star}
                      onSelect={() => { setMoreOpen(false); setFavoritesAnchor(moreAnchor); setFavoritesOpen(true); }}
                    />
                  );
                }
                if (appId === 'island') {
                  const target = myIslands[0]?.id ?? sharedIslands[0]?.id ?? lastIslandId;
                  return (
                    <FlyoutLink
                      key="island"
                      to={target ? `/island/${target}` : '/island'}
                      label="나의 아일랜드"
                      Icon={Palmtree}
                      active={location.pathname.startsWith('/island')}
                      onSelect={() => setMoreOpen(false)}
                    />
                  );
                }
                const entry = navMap[appId];
                if (!entry || !featureAllowed(appId)) return null;
                return (
                  <FlyoutLink
                    key={appId}
                    to={appId}
                    label={getLabel(appId)}
                    Icon={entry.icon}
                    iconColor={entry.iconColor}
                    iconSize={entry.iconSize}
                    active={location.pathname === appId}
                    onSelect={() => setMoreOpen(false)}
                    isPinned={isPinned(appId)}
                    onTogglePin={() => togglePin(appId)}
                  />
                );
              })}
            </div>
          </FlyoutShell>
        </>
      )}

      {favoritesOpen && favoritesAnchor && (
        <>
          <div className="fixed inset-0 z-0" onClick={() => setFavoritesOpen(false)} aria-hidden />
          <FlyoutShell
            title="즐겨찾기"
            anchorRect={favoritesAnchor}
            placement="bottom"
            {...focusProps}
            onClose={() => setFavoritesOpen(false)}
            onMouseEnter={cancelScheduledClose}
            onMouseLeave={() => scheduleFlyoutClose(() => setFavoritesOpen(false))}
          >
            <FavoritesFlyoutBody onClose={() => setFavoritesOpen(false)} />
          </FlyoutShell>
        </>
      )}

      {islandFlyoutAnchor && (
        <>
          <div className="fixed inset-0 z-0" onClick={() => setIslandFlyoutAnchor(null)} aria-hidden />
          <FlyoutShell
            title="Your Island"
            anchorRect={islandFlyoutAnchor}
            placement="bottom"
            {...focusProps}
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
              {sharedIslands.length > 0 && (
                <>
                  <div className="mx-2 my-1 border-t border-border" />
                  <p className="px-2.5 pb-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
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

      {/* 상단바 "앱 추가" 카탈로그 — 이름 옆에 설치할 leaf 페이지 + 즐겨찾기/아일랜드를 고른다. */}
      <AddAppDialog
        open={catalogOpen}
        onClose={() => setCatalogOpen(false)}
        title="상단바에 앱 추가"
        description="이름 옆에 필요한 업무 화면만 골라 추가한다."
        sections={catalogSections}
        installedApps={installedApps}
        onToggle={toggleInstalledApp}
      />
    </header>
  );
}
