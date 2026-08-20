import { useEffect, useState } from 'react';
import { Settings, X, Loader2, Check, List, CalendarDays, Kanban, ListTree } from 'lucide-react';
import { useModalA11y, useToast } from '@/components/common';
import { useWorkItemBoardSettings, useUpdateWorkItemBoardSettings } from '@/hooks/useUiSettings';
import { formatApiError } from '@/lib/utils';
import type { WorkItemBoardBadgeKey, WorkItemBoardSettings, WorkItemBoardViewKey } from '@/types';

interface WorkItemBoardSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

const VIEW_ITEMS: { key: WorkItemBoardViewKey; label: string; icon: React.ReactNode }[] = [
  { key: 'epic', label: '에픽뷰', icon: <ListTree className="w-3.5 h-3.5" /> },
  { key: 'table', label: '목록', icon: <List className="w-3.5 h-3.5" /> },
  { key: 'calendar', label: '달력', icon: <CalendarDays className="w-3.5 h-3.5" /> },
  { key: 'kanban', label: '칸반', icon: <Kanban className="w-3.5 h-3.5" /> },
];

// 백엔드 `_normalize_board_settings` 의 폴백 우선순위와 동일하게 맞춘다.
const DEFAULT_VIEW_FALLBACK_ORDER: WorkItemBoardViewKey[] = ['epic', 'table', 'kanban', 'calendar'];

const BADGE_ITEMS: { key: WorkItemBoardBadgeKey; label: string }[] = [
  { key: 'total', label: '전체' },
  { key: 'wip', label: 'WIP' },
  { key: 'done', label: 'Done' },
  { key: 'overdue', label: '지연' },
];

/**
 * 업무 관리 게시판 공통 설정(전 사용자 적용) — admin 전용. 보여주기 뷰(목록/달력/칸반/에픽뷰)와
 * 기본 뷰, 헤더 배지(전체/WIP/Done/지연) 노출 여부를 설정한다.
 */
export function WorkItemBoardSettingsModal({ open, onClose }: WorkItemBoardSettingsModalProps) {
  const toast = useToast();
  const dialogRef = useModalA11y(open, onClose);
  const { data: settings } = useWorkItemBoardSettings();
  const updateMut = useUpdateWorkItemBoardSettings();

  const [draft, setDraft] = useState<WorkItemBoardSettings | null>(null);

  useEffect(() => {
    if (open && settings) setDraft(settings);
    if (!open) setDraft(null);
  }, [open, settings]);

  if (!open || !draft) return null;
  const busy = updateMut.isPending;

  const visibleViewCount = VIEW_ITEMS.filter((v) => draft.viewVisibility[v.key]).length;

  const toggleView = (key: WorkItemBoardViewKey) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const nextVisibility = { ...prev.viewVisibility, [key]: !prev.viewVisibility[key] };
      // 최소 1개는 항상 보여야 한다 — 마지막 남은 뷰는 끌 수 없다.
      if (!Object.values(nextVisibility).some(Boolean)) return prev;
      const nextDefaultView = nextVisibility[prev.defaultView]
        ? prev.defaultView
        : DEFAULT_VIEW_FALLBACK_ORDER.find((k) => nextVisibility[k]) ?? prev.defaultView;
      return { ...prev, viewVisibility: nextVisibility, defaultView: nextDefaultView };
    });
  };

  const toggleBadge = (key: WorkItemBoardBadgeKey) => {
    setDraft((prev) => (prev ? { ...prev, badgeVisibility: { ...prev.badgeVisibility, [key]: !prev.badgeVisibility[key] } } : prev));
  };

  const handleSave = async () => {
    if (!draft) return;
    try {
      await updateMut.mutateAsync(draft);
      toast.success('설정 저장 완료', '업무 관리 게시판 공통 설정이 저장되었습니다.');
      onClose();
    } catch (err) {
      toast.error('저장 실패', formatApiError(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-item-board-settings-title"
        className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-md mx-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Settings className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="work-item-board-settings-title" className="text-base font-semibold leading-tight">Settings</h2>
            <p className="text-xs text-muted-foreground">업무 관리 게시판 공통 설정 (전 사용자 적용)</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-5">
          <section>
            <div className="text-sm font-medium mb-1">보여주기 뷰</div>
            <p className="text-xs text-muted-foreground mb-2">체크된 뷰만 게시판 상단 탭에 표시됩니다. 기본 뷰로 쓸 항목을 선택하세요.</p>
            <div className="rounded-xl border border-border divide-y divide-border/60">
              {VIEW_ITEMS.map(({ key, label, icon }) => {
                const checked = draft.viewVisibility[key];
                const isDefault = draft.defaultView === key;
                return (
                  <div key={key} className="flex items-center gap-2 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggleView(key)}
                      disabled={busy || (checked && visibleViewCount === 1)}
                      className="flex items-center gap-2 flex-1 text-left disabled:opacity-50"
                      title={checked && visibleViewCount === 1 ? '최소 1개 뷰는 보여야 합니다' : undefined}
                    >
                      <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                        checked ? 'bg-primary border-primary text-primary-foreground' : 'border-border'
                      }`}>
                        {checked && <Check className="w-3 h-3" />}
                      </span>
                      {icon}
                      <span className="text-sm text-foreground">{label}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => checked && setDraft((prev) => (prev ? { ...prev, defaultView: key } : prev))}
                      disabled={busy || !checked}
                      className={`text-xs px-2 py-1 rounded-full border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        isDefault
                          ? 'bg-primary/10 text-primary border-primary/30'
                          : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
                      }`}
                    >
                      {isDefault ? '기본 뷰' : '기본으로'}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <div className="text-sm font-medium mb-1">헤더 배지</div>
            <p className="text-xs text-muted-foreground mb-2">게시판 제목 옆에 표시할 카운트 배지를 선택하세요.</p>
            <div className="flex flex-wrap gap-2">
              {BADGE_ITEMS.map(({ key, label }) => {
                const checked = draft.badgeVisibility[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleBadge(key)}
                    disabled={busy}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm transition-colors disabled:opacity-50 ${
                      checked
                        ? 'bg-primary/10 text-primary border-primary/30'
                        : 'bg-secondary text-muted-foreground border-border hover:text-foreground'
                    }`}
                  >
                    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                      checked ? 'bg-primary border-primary text-primary-foreground' : 'border-border'
                    }`}>
                      {checked && <Check className="w-2.5 h-2.5" />}
                    </span>
                    {label}
                  </button>
                );
              })}
            </div>
          </section>

          <div className="flex items-center gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={busy}
              className="px-3.5 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors disabled:opacity-50">
              취소
            </button>
            <button type="button" onClick={handleSave} disabled={busy}
              className="ml-auto inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              저장
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
