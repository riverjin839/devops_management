import { useMemo, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { useNavCatalog, groupLabelForPath } from '@/hooks/useNavCatalog';

const UNGROUPED_LABEL = '기타';

export interface ScreenCatalogRowProps {
  path: string;
  label: string;
}

interface ScreenCatalogListProps {
  /** 후보 경로를 추가로 좁힌다 (예: 임베드 가능한 화면만, admin 전용 화면 제외). 없으면 전체. */
  filter?: (path: string) => boolean;
  /** 각 줄 클릭 시 호출. 없으면 줄은 표시 전용이고 상호작용은 트레일링 슬롯이 담당한다. */
  onSelect?: (path: string) => void;
  /** 줄 우측에 렌더할 커스텀 UI (체크마크, 체크박스, 배지 등). */
  renderTrailing?: (path: string) => ReactNode;
  /** 개별 줄 비활성화(클릭 불가) 여부 — 예: 상한 도달. */
  isRowDisabled?: (path: string) => boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  /** 목록 스크롤 영역 최대 높이. 기본 55vh(다이얼로그용). */
  maxHeight?: string;
  /** 검색창 자동 포커스 — 다이얼로그로 쓸 때만 true. */
  autoFocusSearch?: boolean;
}

/**
 * 사이드바 네비게이션 카탈로그(NAV_MAP + 동적 서비스)를 그룹별로 검색·나열하는 공용 목록.
 *
 * Your Island 의 "화면 추가" 피커(`PanelPickerDialog`)와 Settings 의 "화면별 노출" 관리자가
 * 공유한다 — 대상 화면 범위(필터)와 우측 컨트롤(트레일링)만 다르고 그룹핑·검색·레이아웃은
 * 동일해야 두 곳의 카탈로그가 서로 다르게 보이는 혼란이 없다.
 */
export function ScreenCatalogList({
  filter, onSelect, renderTrailing, isRowDisabled, searchPlaceholder, emptyText, maxHeight,
  autoFocusSearch,
}: ScreenCatalogListProps) {
  const { navMap, getLabel, featureAllowed } = useNavCatalog();
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const buckets = new Map<string, ScreenCatalogRowProps[]>();
    for (const path of Object.keys(navMap)) {
      if (filter && !filter(path)) continue;
      if (!featureAllowed(path)) continue;
      const label = getLabel(path);
      if (q && !label.toLowerCase().includes(q) && !path.toLowerCase().includes(q)) continue;
      const groupLabel = groupLabelForPath(path)?.label ?? UNGROUPED_LABEL;
      const list = buckets.get(groupLabel) ?? [];
      list.push({ path, label });
      buckets.set(groupLabel, list);
    }
    return [...buckets.entries()].map(([label, items]) => ({
      label,
      items: items.sort((a, b) => a.label.localeCompare(b.label, 'ko')),
    }));
  }, [navMap, getLabel, featureAllowed, filter, query]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder ?? '화면 이름으로 검색'}
          aria-label="화면 검색"
          autoFocus={autoFocusSearch}
          className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="overflow-y-auto space-y-4 pr-1" style={{ maxHeight: maxHeight ?? '55vh' }}>
        {grouped.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {emptyText ?? '조건에 맞는 화면이 없습니다.'}
          </p>
        )}
        {grouped.map((group) => (
          <div key={group.label}>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {group.items.map((item) => {
                const Icon = navMap[item.path].icon;
                const disabled = isRowDisabled?.(item.path) ?? false;
                const rowContent = (
                  <>
                    <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                    <span className="flex-1 min-w-0 truncate">{item.label}</span>
                    {renderTrailing?.(item.path)}
                  </>
                );
                // onSelect 가 있으면 줄 전체가 버튼(피커: 클릭=추가). 없으면 줄은 표시용
                // div 이고 트레일링 슬롯(체크박스 등)이 독립적으로 상호작용한다 — 버튼 안에
                // 버튼/체크박스를 중첩하면 안 되기 때문.
                if (onSelect) {
                  return (
                    <button
                      key={item.path}
                      type="button"
                      onClick={() => onSelect(item.path)}
                      disabled={disabled}
                      className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-left text-foreground transition-colors hover:bg-secondary disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                    >
                      {rowContent}
                    </button>
                  );
                }
                return (
                  <div
                    key={item.path}
                    className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-foreground"
                  >
                    {rowContent}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
