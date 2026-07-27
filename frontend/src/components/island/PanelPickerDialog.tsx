import { useMemo, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useNavCatalog, groupLabelForPath } from '@/hooks/useNavCatalog';
import { isEmbeddable } from './panelRegistry';

interface PanelPickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** 이미 담겨 있는 경로들 — 체크 표시용(중복 추가 자체는 허용). */
  existingPaths: string[];
  onPick: (path: string) => void;
}

const UNGROUPED_LABEL = '기타';

/**
 * 아일랜드에 담을 화면을 고르는 다이얼로그.
 *
 * 카탈로그는 사이드바와 **같은** 소스를 쓴다(`useNavCatalog`) — 관리자가 바꾼 메뉴 라벨과
 * 숨긴 기능이 그대로 반영되도록. 여기에 더해 `panelRegistry` 에 등록돼 임베드 가능한
 * 화면만 남긴다.
 */
export function PanelPickerDialog({ open, onClose, existingPaths, onPick }: PanelPickerDialogProps) {
  const { navMap, getLabel, featureAllowed } = useNavCatalog();
  const [query, setQuery] = useState('');

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const buckets = new Map<string, { path: string; label: string }[]>();
    for (const path of Object.keys(navMap)) {
      if (!isEmbeddable(path) || !featureAllowed(path)) continue;
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
  }, [navMap, getLabel, featureAllowed, query]);

  const existing = useMemo(() => new Set(existingPaths), [existingPaths]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>화면 추가</DialogTitle>
        </DialogHeader>

        <div className="px-5 pb-5 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="화면 이름으로 검색"
              aria-label="화면 검색"
              autoFocus
              className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          <div className="max-h-[55vh] overflow-y-auto space-y-4 pr-1">
            {grouped.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                조건에 맞는 화면이 없습니다.
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
                    const already = existing.has(item.path);
                    return (
                      <button
                        key={item.path}
                        type="button"
                        onClick={() => onPick(item.path)}
                        className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-left text-foreground hover:bg-secondary transition-colors"
                      >
                        <Icon className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
                        <span className="flex-1 min-w-0 truncate">{item.label}</span>
                        {already && (
                          <Check className="w-3.5 h-3.5 flex-shrink-0 text-primary" aria-label="이미 추가됨" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
