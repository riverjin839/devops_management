import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Server, Clock, CornerDownLeft, LayoutGrid } from 'lucide-react';
import { useCommandPaletteStore } from '@/stores/commandPaletteStore';
import { useRecentPathsStore } from '@/stores/recentPathsStore';
import { useNavCatalog, groupLabelForPath } from '@/hooks/useNavCatalog';
import { useModalA11y } from '@/components/common/useModalA11y';
import { clustersApi } from '@/services/api';
import { cn } from '@/lib/utils';
import type { Cluster } from '@/types';

/** 결과 한 줄 — 화면 / 클러스터 / 최근 방문 을 같은 모양으로 그린다. */
interface PaletteItem {
  key: string;
  label: string;
  /** 보조 텍스트 — 화면은 소속 그룹, 클러스터는 종합 상태. */
  hint?: string;
  section: '최근 방문' | '화면' | '클러스터';
  to: string;
  Icon: ComponentType<{ className?: string }>;
  iconColor?: string;
}

const MAX_PER_SECTION = 12;
const MAX_RECENT = 5;

/** 검색어가 라벨/경로/그룹 어디에 맞는지 — 앞머리 일치를 부분 일치보다 위에 둔다. */
function score(q: string, ...fields: Array<string | undefined>): number {
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    const v = f.toLowerCase();
    if (v === q) return 3;
    if (v.startsWith(q)) best = Math.max(best, 2);
    else if (v.includes(q)) best = Math.max(best, 1);
  }
  return best;
}

/**
 * D-073 — 커맨드 팔레트(Ctrl/⌘+K). 화면 이름은 아는데 어느 그룹 flyout 에 있는지 모르는
 * 사용자가 8개 flyout 을 차례로 열어보던 것을 검색 한 번으로 줄인다.
 *
 * - 화면: `useNavCatalog()` 의 라벨 오버라이드·`featureAllowed` 를 그대로 써서 사이드바에
 *   보이는 것과 같은 이름·같은 권한 범위만 나온다.
 * - 클러스터: 이름으로 `/clusters/:id` 로 점프. 팔레트가 열렸을 때만 조회(전역 폴링 없음).
 * - 최근 방문: `recentPathsStore`(기기 로컬) — 검색어가 비어 있을 때 맨 위.
 * - 키보드: ↑↓ 이동, Enter 이동, Esc 닫기. 포커스 트랩·복원은 `useModalA11y`.
 */
export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  const close = () => setOpen(false);
  const navigate = useNavigate();
  const dialogRef = useModalA11y(open, close);

  const { navMap, getLabel, featureAllowed } = useNavCatalog();
  const recentPaths = useRecentPathsStore((s) => s.paths);
  const { data: clusters } = useQuery({
    queryKey: ['command-palette', 'clusters'],
    queryFn: async () => (await clustersApi.getAll()).data?.data ?? [],
    enabled: open,
    staleTime: 30_000,
  });

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // 열릴 때마다 초기화 — 지난 검색어가 남아 있으면 첫 화면이 "결과 없음" 으로 시작할 수 있다.
  useEffect(() => {
    if (open) { setQuery(''); setCursor(0); }
  }, [open]);

  const screenItems = useMemo<PaletteItem[]>(() => (
    Object.keys(navMap)
      .filter((p) => featureAllowed(p))
      .map((p) => ({
        key: `screen:${p}`,
        label: getLabel(p),
        hint: groupLabelForPath(p)?.label ?? (p === '/' ? '홈' : '기타'),
        section: '화면' as const,
        to: p,
        Icon: navMap[p].icon,
        iconColor: navMap[p].iconColor,
      }))
  ), [navMap, getLabel, featureAllowed]);

  const clusterItems = useMemo<PaletteItem[]>(() => (
    (clusters ?? []).map((c: Cluster) => ({
      key: `cluster:${c.id}`,
      label: c.name,
      hint: c.status === 'critical' ? '위험' : c.status === 'warning' ? '경고' : c.status === 'healthy' ? '정상' : '미판정',
      section: '클러스터' as const,
      to: `/clusters/${c.id}`,
      Icon: Server,
    }))
  ), [clusters]);

  const results = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const recent = recentPaths
        .filter((p) => navMap[p] && featureAllowed(p))
        .slice(0, MAX_RECENT)
        .map<PaletteItem>((p) => ({
          key: `recent:${p}`,
          label: getLabel(p),
          hint: groupLabelForPath(p)?.label ?? undefined,
          section: '최근 방문',
          to: p,
          Icon: Clock,
        }));
      const recentSet = new Set(recentPaths);
      const screens = [...screenItems]
        .filter((s) => !recentSet.has(s.to))
        .sort((a, b) => (a.hint ?? '').localeCompare(b.hint ?? '', 'ko') || a.label.localeCompare(b.label, 'ko'));
      return [...recent, ...screens, ...clusterItems.slice(0, MAX_PER_SECTION)];
    }
    const rank = (items: PaletteItem[]) => items
      .map((it) => ({ it, s: score(q, it.label, it.to, it.hint) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.it.label.localeCompare(b.it.label, 'ko'))
      .slice(0, MAX_PER_SECTION)
      .map((x) => x.it);
    return [...rank(screenItems), ...rank(clusterItems)];
  }, [query, recentPaths, navMap, featureAllowed, getLabel, screenItems, clusterItems]);

  useEffect(() => { setCursor(0); }, [query, results.length]);

  // 선택 줄이 스크롤 밖으로 나가지 않게.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const go = (item: PaletteItem) => {
    close();
    navigate(item.to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % results.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + results.length) % results.length); }
    else if (e.key === 'Home') { e.preventDefault(); setCursor(0); }
    else if (e.key === 'End') { e.preventDefault(); setCursor(results.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = results[cursor]; if (it) go(it); }
  };

  if (!open) return null;

  // 섹션 헤더는 섹션이 바뀌는 첫 줄 앞에만 그린다.
  let lastSection: PaletteItem['section'] | null = null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={close} aria-hidden />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="화면 검색"
        onKeyDown={onKeyDown}
        className="relative w-full max-w-xl bg-card text-card-foreground border border-border rounded-2xl mac-shadow overflow-hidden flex flex-col max-h-[70vh]"
      >
        <div className="flex items-center gap-2 px-4 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
          <input
            data-autofocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="화면 이름, 경로, 클러스터 이름으로 검색…"
            aria-label="화면 검색"
            aria-controls="command-palette-results"
            aria-activedescendant={results[cursor] ? `cp-${results[cursor].key}` : undefined}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent py-3 text-sm focus:outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden sm:inline text-[10px] font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        <div ref={listRef} id="command-palette-results" role="listbox" aria-label="검색 결과" className="flex-1 min-h-0 overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">"{query}" 에 맞는 화면이나 클러스터가 없습니다.</p>
          ) : results.map((it, idx) => {
            const header = it.section !== lastSection ? it.section : null;
            lastSection = it.section;
            const selected = idx === cursor;
            return (
              <div key={it.key}>
                {header && (
                  <p className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{header}</p>
                )}
                <button
                  type="button"
                  id={`cp-${it.key}`}
                  role="option"
                  aria-selected={selected}
                  data-idx={idx}
                  onMouseMove={() => { if (!selected) setCursor(idx); }}
                  onClick={() => go(it)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors',
                    selected ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-secondary',
                  )}
                >
                  <it.Icon className={cn('w-4 h-4 flex-shrink-0', it.iconColor)} />
                  <span className="flex-1 min-w-0 truncate">{it.label}</span>
                  {it.hint && <span className="text-xs text-muted-foreground flex-shrink-0">{it.hint}</span>}
                  {selected && <CornerDownLeft className="w-3.5 h-3.5 flex-shrink-0 text-primary" aria-hidden="true" />}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-3 px-4 py-2 border-t border-border bg-muted/40 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><LayoutGrid className="w-3 h-3" aria-hidden="true" /> 화면 {screenItems.length}개</span>
          <span className="ml-auto flex items-center gap-2">
            <kbd className="font-mono border border-border rounded px-1">↑↓</kbd> 이동
            <kbd className="font-mono border border-border rounded px-1">Enter</kbd> 열기
          </span>
        </div>
      </div>
    </div>
  );
}
