// 관측 지표 화면 설정 — push 스냅샷 "오래됨" 기준(D-183, 정책 결정 ③ 기본 15분).
// UI-First: 기준은 코드가 아니라 여기서 바꾼다. 변경은 admin 만(서버 require_admin).
import { useEffect, useId, useState } from 'react';
import { ErrorState, LoadingState, useToast } from '@/components/common';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useObservabilitySettings, useUpdateObservabilitySettings } from '@/hooks/useObservability';
import { useAuthStore, hasRole } from '@/stores/authStore';
import { formatApiError } from '@/lib/utils';

const INPUT = 'w-28 text-sm px-3 py-1.5 rounded-xl border border-border bg-secondary text-foreground '
  + 'focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50';
const BTN = 'text-sm inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-border bg-secondary '
  + 'hover:bg-secondary/80 transition-colors disabled:opacity-50';
const BTN_PRIMARY = 'text-sm inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground '
  + 'hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed';
const ADMIN_HINT = 'admin 권한이 필요합니다';
const MIN = 1;
const MAX = 1440;

export function ObservabilitySettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const inputId = useId();
  const helpId = useId();
  const isAdmin = useAuthStore((s) => hasRole(s.user, 'admin'));
  const settings = useObservabilitySettings(open);
  const save = useUpdateObservabilitySettings();
  const [minutes, setMinutes] = useState('');

  useEffect(() => {
    if (open && settings.data) setMinutes(String(settings.data.staleMinutes));
  }, [open, settings.data]);

  const value = Number(minutes);
  const valid = Number.isInteger(value) && value >= MIN && value <= MAX;

  const onSave = async () => {
    if (!valid) return;
    try {
      await save.mutateAsync({ staleMinutes: value });
      toast.success('관측 설정 저장됨');
      onClose();
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>관측 지표 설정</DialogTitle>
          <DialogDescription>
            push 모드 클러스터의 스냅샷이 이 시간보다 오래되면 화면에 &quot;오래된 스냅샷&quot; 경고를 붙인다.
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 pb-3">
          {settings.isLoading ? (
            <LoadingState compact />
          ) : settings.isError ? (
            <ErrorState
              compact
              error={settings.error}
              title="관측 설정을 불러오지 못했습니다"
              onRetry={() => { void settings.refetch(); }}
            />
          ) : (
            <div className="space-y-1">
              <label htmlFor={inputId} className="block text-xs text-muted-foreground">
                오래됨 기준 (분)
              </label>
              <input
                id={inputId}
                type="number"
                min={MIN}
                max={MAX}
                className={INPUT}
                value={minutes}
                disabled={!isAdmin}
                aria-describedby={helpId}
                onChange={(e) => setMinutes(e.target.value)}
              />
              <p id={helpId} className="text-xs text-muted-foreground">
                {MIN}~{MAX}분. 수집기 전송 주기보다 넉넉하게 잡는다.
                {!isAdmin ? ` 변경은 ${ADMIN_HINT}.` : ''}
              </p>
              {minutes !== '' && !valid ? (
                <p role="alert" className="text-xs text-status-critical">{MIN}~{MAX} 사이의 정수를 입력하세요.</p>
              ) : null}
            </div>
          )}
        </div>
        <DialogFooter>
          <button type="button" className={BTN} onClick={onClose} disabled={save.isPending}>취소</button>
          <button
            type="button"
            className={BTN_PRIMARY}
            onClick={() => void onSave()}
            disabled={!isAdmin || !settings.data || !valid || save.isPending}
            title={isAdmin ? '저장' : ADMIN_HINT}
            aria-label={isAdmin ? '저장' : `저장 — ${ADMIN_HINT}`}
          >
            {save.isPending ? '저장 중…' : '저장'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
