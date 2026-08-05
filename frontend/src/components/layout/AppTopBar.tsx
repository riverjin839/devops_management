import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, Star, Sun } from 'lucide-react';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { useAuthStore } from '@/stores/authStore';
import { useFavorites } from '@/hooks/useFavorites';
import { useToday } from '@/hooks/useToday';
import { cn, fmtKoreanDate } from '@/lib/utils';
import { FlyoutShell, FlyoutLink } from './NavFlyout';
import { FavoritesFlyoutBody } from './FavoritesFlyoutBody';
import { WorkAlarmBell } from './WorkAlarmBell';
import { GROUPS, type GroupId } from './navConfig';

const WORK_GROUPS = GROUPS.filter((g) => g.domain === 'work');

/**
 * 전역 상단바 — 업무 도메인 그룹(협업/문서 관리)을 여기서 노출한다.
 *
 * 예전엔 이 그룹들이 사이드바에 있었고, 사이드바 홈 버튼의 숨은 "모드" 토글이 플랫폼
 * 도메인과 서로 배타적으로 갈아 끼웠다(D-054) — 반대 도메인 화면은 4클릭 없이는 갈 수
 * 없었다. 상단바는 모든 화면에서 항상 렌더되므로, 어느 플랫폼 화면에 있든 업무 도메인이
 * 1~2클릭 거리에 있다. 좌측 사이드바는 플랫폼 도메인 그룹만 남는다(`Sidebar.tsx`).
 */
export function AppTopBar() {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const myName = user?.displayName?.trim() || user?.username || null;
  useToday(); // 자정 넘기면 날짜 표기가 갱신되도록 리렌더만 구독(반환값은 안 씀)
  const { navMap, getLabel, featureAllowed } = useNavCatalog();
  const { isPinned, togglePin } = useFavorites();

  const [openGroup, setOpenGroup] = useState<GroupId | null>(null);
  const [openAnchor, setOpenAnchor] = useState<DOMRect | null>(null);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [favoritesAnchor, setFavoritesAnchor] = useState<DOMRect | null>(null);

  useEffect(() => { setOpenGroup(null); setFavoritesOpen(false); }, [location.pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpenGroup(null); setFavoritesOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const activeGroup = useMemo<GroupId | null>(() => {
    for (const g of WORK_GROUPS) {
      if (g.paths.includes(location.pathname)) return g.id;
    }
    return null;
  }, [location.pathname]);

  const dateStr = fmtKoreanDate(new Date());

  const openGroupDef = openGroup ? WORK_GROUPS.find((g) => g.id === openGroup) ?? null : null;

  return (
    <header className="sticky top-0 z-30 flex-none h-[var(--topbar-h)] flex items-center gap-3 pl-3 lg:pl-4 pr-3 lg:pr-4 border-b border-border bg-background/95 backdrop-blur">
      {/* 사용자 / 날짜 */}
      <div className="flex items-center gap-2 min-w-0 flex-shrink-0">
        <Sun className="w-4 h-4 text-primary flex-shrink-0" />
        {myName && <span className="text-sm font-bold leading-none whitespace-nowrap">{myName}님</span>}
        <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">{dateStr}</span>
      </div>

      {/* 업무 도메인 그룹 — 라벨 있는 가로 항목. 하위 경로 1개면 직행, 2개 이상이면 드롭다운
          (chevron 유무로 구분). */}
      <nav aria-label="업무" className="flex items-center gap-1 min-w-0 overflow-x-auto">
        {WORK_GROUPS.map((g) => {
          const single = g.paths.length === 1;
          const isOpen = openGroup === g.id;
          const active = activeGroup === g.id;
          const itemClass = cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors',
            active || isOpen
              ? 'bg-primary/10 text-primary font-semibold'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          );
          if (single) {
            return (
              <Link key={g.id} to={g.paths[0]} className={itemClass}>
                <g.icon className="w-4 h-4 flex-shrink-0" />
                {g.label}
              </Link>
            );
          }
          return (
            <button
              key={g.id}
              type="button"
              aria-haspopup="true"
              aria-expanded={isOpen}
              className={itemClass}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setOpenAnchor(rect);
                setOpenGroup((cur) => (cur === g.id ? null : g.id));
              }}
            >
              <g.icon className="w-4 h-4 flex-shrink-0" />
              {g.label}
              <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
            </button>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
        <button
          type="button"
          aria-haspopup="true"
          aria-expanded={favoritesOpen}
          title="즐겨찾기"
          aria-label="즐겨찾기"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setFavoritesAnchor(rect);
            setFavoritesOpen((cur) => !cur);
          }}
          className={cn(
            'flex items-center justify-center w-8 h-8 rounded-lg border transition-colors',
            favoritesOpen
              ? 'bg-primary/10 text-primary border-primary/30'
              : 'text-muted-foreground border-border hover:bg-secondary hover:text-foreground',
          )}
        >
          <Star className="w-4 h-4" />
        </button>
        <div className="flex items-center rounded-lg border border-border bg-card overflow-hidden">
          <WorkAlarmBell />
        </div>
      </div>

      {openGroup && openAnchor && openGroupDef && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpenGroup(null)} aria-hidden />
          <FlyoutShell
            title={openGroupDef.label}
            anchorRect={openAnchor}
            placement="bottom"
            onClose={() => setOpenGroup(null)}
          >
            <div className="space-y-1 pb-2">
              {openGroupDef.paths.map((p) => {
                const entry = navMap[p];
                if (!entry || !featureAllowed(p)) return null;
                return (
                  <FlyoutLink
                    key={p}
                    to={p}
                    label={getLabel(p)}
                    Icon={entry.icon}
                    iconColor={entry.iconColor}
                    iconSize={entry.iconSize}
                    active={location.pathname === p}
                    onSelect={() => setOpenGroup(null)}
                    isPinned={isPinned(p)}
                    onTogglePin={() => togglePin(p)}
                  />
                );
              })}
            </div>
          </FlyoutShell>
        </>
      )}

      {favoritesOpen && favoritesAnchor && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setFavoritesOpen(false)} aria-hidden />
          <FlyoutShell
            title="즐겨찾기"
            anchorRect={favoritesAnchor}
            placement="bottom"
            onClose={() => setFavoritesOpen(false)}
          >
            <FavoritesFlyoutBody onClose={() => setFavoritesOpen(false)} />
          </FlyoutShell>
        </>
      )}
    </header>
  );
}
