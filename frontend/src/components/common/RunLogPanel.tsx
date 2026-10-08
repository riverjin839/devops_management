// 실행 로그 패널 — "실행" 버튼 아래에 단계 칩 + 상세 로그(LogViewer)를 보여준다(D-089).
// 로그는 항상 수집하고, 펼쳐 볼지는 사용자가 "로그 보기" 로 정한다. 선택은 화면별로 localStorage 에 기억한다.
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, ScrollText, X, XCircle } from 'lucide-react';
import { LogViewer } from './LogViewer';
import { formatRunLog, type RunLog } from '@/hooks/useRunLog';

interface Props {
  run: RunLog;
  show: boolean;
  onShowChange: (v: boolean) => void;
  /** 헤더 오른쪽 추가 버튼(예: "결과 상세 보기"). */
  actions?: React.ReactNode;
  maxHeight?: string;
}

export function RunLogPanel({ run, show, onShowChange, actions, maxHeight = 'max-h-72' }: Props) {
  if (!run.running && run.lines.length === 0) return null;
  const last = run.lines[run.lines.length - 1];
  const hasError = run.lines.some((l) => l.level === 'error');

  return (
    <section aria-label={`${run.title || '실행'} 로그`} className="rounded-md border border-border bg-muted/20">
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        {run.running ? (
          <Loader2 className="w-4 h-4 animate-spin text-primary" aria-hidden />
        ) : hasError ? (
          <XCircle className="w-4 h-4 text-status-critical" aria-hidden />
        ) : (
          <CheckCircle2 className="w-4 h-4 text-status-healthy" aria-hidden />
        )}
        <span className="text-sm font-medium">{run.title || '실행'}</span>
        <span role="status" className="text-xs text-muted-foreground">
          {run.running ? '실행 중' : hasError ? '오류 있음' : '완료'} · {run.lines.length}줄
        </span>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          <button
            type="button"
            onClick={() => onShowChange(!show)}
            aria-pressed={show}
            title={show ? '로그 숨기기' : '로그 보기'}
            aria-label={show ? '로그 숨기기' : '로그 보기'}
            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-background hover:bg-secondary"
          >
            {show ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <ScrollText className="w-3.5 h-3.5" /> 로그 보기
          </button>
          {!run.running && (
            <button
              type="button"
              onClick={run.clear}
              title="실행 로그 닫기"
              aria-label="실행 로그 닫기"
              className="p-1 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {run.steps.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-3 pb-2" aria-label="단계">
          {run.steps.map((s) => (
            <li
              key={s.name}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
                s.status === 'running'
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : s.status === 'failed'
                    ? 'border-status-critical/30 bg-status-critical/10 text-status-critical'
                    : 'border-status-healthy/30 bg-status-healthy/10 text-status-healthy'
              }`}
            >
              {s.status === 'running' && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
              {s.label}
              <span className="sr-only">
                {s.status === 'running' ? '진행 중' : s.status === 'failed' ? '실패' : '완료'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {show ? (
        <div className="px-2 pb-2">
          <LogViewer text={formatRunLog(run.lines) || '로그 대기 중…'} maxHeight={maxHeight} />
        </div>
      ) : (
        last && (
          <p className="px-3 pb-2 text-xs text-muted-foreground truncate" title={last.message}>
            {last.message}
          </p>
        )
      )}
    </section>
  );
}
