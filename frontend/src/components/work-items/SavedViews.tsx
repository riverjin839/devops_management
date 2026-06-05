import { useState } from 'react';
import { Save, Trash2 } from 'lucide-react';

/** 업무 게시판에서 저장하는 뷰 = 필터 + 정렬 + 보기 모드 스냅샷. (컬럼은 별도 영속화) */
export interface SavedViewState {
  typeFilter: string;
  filterClusterId: string;
  filterAssignee: string;
  filterCategory: string;
  filterPriority: string;
  filterModule: string;
  filterSprintId?: string;
  filterFrom: string;
  filterTo: string;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  viewMode: string;
}

interface SavedView {
  name: string;
  state: SavedViewState;
}

const STORAGE_KEY = 'k8s:item-board:saved-views';

function loadViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as SavedView[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function persist(views: SavedView[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(views)); } catch { /* ignore */ }
}

interface SavedViewsProps {
  current: SavedViewState;
  onApply: (state: SavedViewState) => void;
}

/**
 * 저장된 뷰 — 현재 필터/정렬/보기 조합을 이름으로 저장하고 드롭다운으로 전환.
 * (AFFiNE/AppFlowy 의 saved view 차용 — localStorage 기반, 프론트 전용)
 */
export function SavedViews({ current, onApply }: SavedViewsProps) {
  const [views, setViews] = useState<SavedView[]>(loadViews);
  const [selected, setSelected] = useState('');

  const apply = (name: string) => {
    setSelected(name);
    const v = views.find((x) => x.name === name);
    if (v) onApply(v.state);
  };

  const saveCurrent = () => {
    const name = window.prompt('뷰 이름을 입력하세요 (같은 이름이면 덮어씀)')?.trim();
    if (!name) return;
    const next = [...views.filter((v) => v.name !== name), { name, state: current }]
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    setViews(next);
    persist(next);
    setSelected(name);
  };

  const removeSelected = () => {
    if (!selected) return;
    const next = views.filter((v) => v.name !== selected);
    setViews(next);
    persist(next);
    setSelected('');
  };

  return (
    <div className="flex items-center gap-1">
      <select
        value={selected}
        onChange={(e) => apply(e.target.value)}
        aria-label="저장된 뷰"
        title="저장된 뷰 적용"
        className="px-2.5 py-1.5 text-xs bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50 max-w-[140px]"
      >
        <option value="">저장된 뷰</option>
        {views.map((v) => (
          <option key={v.name} value={v.name}>{v.name}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={saveCurrent}
        title="현재 필터·정렬·보기를 뷰로 저장"
        aria-label="현재 뷰 저장"
        className="p-1.5 rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground transition-colors"
      >
        <Save className="w-3.5 h-3.5" />
      </button>
      {selected && (
        <button
          type="button"
          onClick={removeSelected}
          title="선택한 뷰 삭제"
          aria-label="선택 뷰 삭제"
          className="p-1.5 rounded-lg border border-border bg-secondary text-muted-foreground hover:text-rose-500 transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
