// 공통 서비스 감시 설정(admin) — 주기 수집 켜기·주기, 변경 알람·도달 불가 알람(연속 실패 수)·심각도.
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LoadingState, SwitchToggle, useToast } from '@/components/common';
import { useCommonServiceWatchSettings, useUpdateCommonServiceWatchSettings } from '@/hooks/useCommonServices';
import { formatApiError } from '@/lib/utils';
import type { CommonServiceWatchSettings } from '@/types';

const INPUT = 'w-full px-2.5 py-1.5 rounded-xl border border-border bg-card text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';
const SEVERITIES: [CommonServiceWatchSettings['changeSeverity'], string][] = [['info', '정보'], ['warning', '경고'], ['critical', '위험']];

export function WatchSettingsDialog({ open, isAdmin, onClose }: { open: boolean; isAdmin: boolean; onClose: () => void }) {
  const { data, isLoading } = useCommonServiceWatchSettings();
  const save = useUpdateCommonServiceWatchSettings();
  const toast = useToast();
  const [draft, setDraft] = useState<CommonServiceWatchSettings | null>(null);
  useEffect(() => { if (open && data) setDraft(data); }, [open, data]);
  const set = (patch: Partial<CommonServiceWatchSettings>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const ro = !isAdmin;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>감시 설정</DialogTitle>
          <DialogDescription>모든 공통 서비스 인스턴스에 적용됩니다. 인스턴스별로는 편집 화면의 '주기 수집'으로 끕니다.{ro ? ' 변경은 admin 만 할 수 있습니다.' : ''}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 pb-3">
          {isLoading || !draft ? <LoadingState /> : (
            <>
              <SwitchToggle checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="주기 수집 켜기" disabled={ro} />
              <label className="block text-xs">
                <span className="text-muted-foreground">수집 주기(분, 5~1440)</span>
                <input type="number" min={5} max={1440} className={`${INPUT} mt-1`} value={draft.intervalMin} disabled={ro}
                  onChange={(e) => set({ intervalMin: Number(e.target.value) || 30 })} aria-label="수집 주기(분)" />
              </label>
              <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
                <SwitchToggle checked={draft.changeAlert} onChange={(v) => set({ changeAlert: v })} label="설정 변경 알람" disabled={ro} />
                <select className={INPUT} value={draft.changeSeverity} disabled={ro} aria-label="설정 변경 알람 심각도"
                  onChange={(e) => set({ changeSeverity: e.target.value as CommonServiceWatchSettings['changeSeverity'] })}>
                  {SEVERITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
                <SwitchToggle checked={draft.unreachableAlert} onChange={(v) => set({ unreachableAlert: v })} label="수집 실패 알람" disabled={ro} />
                <select className={INPUT} value={draft.unreachableSeverity} disabled={ro} aria-label="수집 실패 알람 심각도"
                  onChange={(e) => set({ unreachableSeverity: e.target.value as CommonServiceWatchSettings['unreachableSeverity'] })}>
                  {SEVERITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <label className="block text-xs">
                <span className="text-muted-foreground">연속 실패 몇 번째에 알람(1~100, 복구되면 닫힘)</span>
                <input type="number" min={1} max={100} className={`${INPUT} mt-1`} value={draft.unreachableAfter} disabled={ro}
                  onChange={(e) => set({ unreachableAfter: Number(e.target.value) || 3 })} aria-label="연속 실패 알람 기준" />
              </label>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>닫기</Button>
          {isAdmin && (
            <Button disabled={!draft || save.isPending} onClick={() => draft && save.mutate(draft, {
              onSuccess: () => { toast.success('감시 설정을 저장했습니다.'); onClose(); },
              onError: (e) => toast.error(formatApiError(e)),
            })}>{save.isPending ? '저장 중…' : '저장'}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
