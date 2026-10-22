import { useEffect, useId, useState } from 'react';
import { CalendarClock, Loader2, X } from 'lucide-react';
import { useModalA11y } from '@/components/common/useModalA11y';
import { ErrorState, LoadingState, useToast } from '@/components/common';
import { useArchDocSchedule, useSetArchDocSchedule } from '@/hooks/useArchDoc';
import { formatApiError } from '@/lib/utils';

/** admin 이 아닐 때 저장 버튼·입력에 붙는 사유. */
const ARCH_SCHEDULE_ADMIN_HINT = '관리자만 현행화 주기를 바꿀 수 있습니다';

interface Props {
  isAdmin: boolean;
  onClose: () => void;
}

/**
 * 전역 현행화 주기(cron) — 모든 클러스터·모듈의 자동 동기화에 공통 적용된다.
 * 조회는 누구나, 저장은 admin 만(서버 `PUT /architecture-docs/schedule` 도 admin).
 */
export function ArchScheduleDialog({ isAdmin, onClose }: Props) {
  const toast = useToast();
  const query = useArchDocSchedule();
  const save = useSetArchDocSchedule();
  const [enabled, setEnabled] = useState(false);
  const [cron, setCron] = useState('');
  const [loaded, setLoaded] = useState(false);
  const titleId = useId();
  const cronId = useId();
  const cronHelpId = useId();
  const dialogRef = useModalA11y(true, () => { if (!save.isPending) onClose(); });

  useEffect(() => {
    if (query.data && !loaded) {
      setEnabled(query.data.enabled);
      setCron(query.data.cron);
      setLoaded(true);
    }
  }, [query.data, loaded]);

  const onSave = () => {
    save.mutate({ enabled, cron: cron.trim() }, {
      onSuccess: () => { toast.success('현행화 주기 저장됨'); onClose(); },
      onError: (e) => toast.error(formatApiError(e)),
    });
  };

  const readOnly = !isAdmin;
  const canSave = isAdmin && loaded && !!cron.trim() && !save.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !save.isPending && onClose()} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative bg-card border border-border rounded-md shadow-card w-full max-w-sm mx-4"
      >
        <div className="flex items-center gap-2 px-5 pt-4 pb-3 border-b border-border">
          <CalendarClock className="w-4 h-4 text-muted-foreground" />
          <h2 id={titleId} className="text-sm font-semibold flex-1">현행화 주기</h2>
          <button onClick={onClose} disabled={save.isPending} aria-label="닫기" title="닫기"
            className="p-1 rounded-xl text-muted-foreground hover:bg-secondary disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          {query.isLoading ? (
            <LoadingState compact />
          ) : query.isError ? (
            <ErrorState compact error={query.error} onRetry={() => { void query.refetch(); }} />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                모든 클러스터·서비스 모듈의 자동 동기화에 공통으로 적용됩니다. 수동 편집(배치·주석·수동 노드)은 덮어쓰지 않습니다.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={enabled} disabled={readOnly}
                  onChange={(e) => setEnabled(e.target.checked)}
                  title={readOnly ? ARCH_SCHEDULE_ADMIN_HINT : undefined} />
                자동 현행화 사용
              </label>
              <div>
                <label htmlFor={cronId} className="text-sm font-medium text-muted-foreground mb-1 block">cron 식</label>
                <input id={cronId} value={cron} onChange={(e) => setCron(e.target.value)}
                  readOnly={readOnly} aria-describedby={cronHelpId}
                  title={readOnly ? ARCH_SCHEDULE_ADMIN_HINT : undefined}
                  placeholder="예) 0 3 * * *"
                  className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm font-mono" />
                <p id={cronHelpId} className="mt-1 text-xs text-muted-foreground">
                  분 시 일 월 요일 5필드(서버 시간대). 예) <span className="font-mono">0 3 * * *</span> = 매일 03:00
                </p>
              </div>
              {query.data?.lastRunAt && (
                <p className="text-xs text-muted-foreground">
                  마지막 실행: {new Date(query.data.lastRunAt).toLocaleString('ko-KR')}
                </p>
              )}
              {readOnly && (
                <p className="text-xs text-muted-foreground">{ARCH_SCHEDULE_ADMIN_HINT}.</p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button onClick={onClose} disabled={save.isPending}
            className="px-3.5 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50">
            닫기
          </button>
          <button
            onClick={onSave}
            disabled={!canSave}
            title={isAdmin ? '현행화 주기 저장' : ARCH_SCHEDULE_ADMIN_HINT}
            aria-label={isAdmin ? '현행화 주기 저장' : `현행화 주기 저장 — ${ARCH_SCHEDULE_ADMIN_HINT}`}
            className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50">
            {save.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
