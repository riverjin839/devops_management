// 실행 로그 패널 — "실행" 버튼 아래에 단계 칩 + 상세 로그(LogViewer)를 보여준다(D-089).
// 로그는 항상 수집하고, 펼쳐 볼지는 사용자가 "로그 보기" 로 정한다. 선택은 화면별로 localStorage 에 기억한다.
// 어디에 보일지는 전역 설정(useLogWindowStore) — 기본은 우측 상단 새 창(PopoutWindow), "화면 안" 으로 바꿀 수 있다.
// 새 창이 차단되면 화면 안 표시로 폴백하고, 사용자가 창을 닫으면 다음 실행이 시작될 때 다시 연다.
import { useEffect, useId, useRef, useState } from 'react';
import {
  CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, PanelBottom, PictureInPicture2, ScrollText, X, XCircle,
} from 'lucide-react';
import { LogViewer } from './LogViewer';
import { PopoutWindow } from './PopoutWindow';
import { formatRunLog, type RunLog } from '@/hooks/useRunLog';
import { useLogWindowStore } from '@/stores/logWindowStore';

interface Props {
  run: RunLog;
  show: boolean;
  onShowChange: (v: boolean) => void;
  /** 헤더 오른쪽 추가 버튼(예: "결과 상세 보기"). */
  actions?: React.ReactNode;
  maxHeight?: string;
  /** 로그 중심 화면 — 부모 높이를 채우고(flex-1), 실행 전에도 같은 자리에 대기 상태로 존재하며, 새 줄을 따라간다(DESIGN_SYSTEM §12.6.1). */
  fill?: boolean;
  /** fill 모드의 대기 문구. */
  idleHint?: string;
}

function StatusIcon({ run, idle, hasError }: { run: RunLog; idle: boolean; hasError: boolean }) {
  if (run.running) return <Loader2 className="w-4 h-4 animate-spin text-primary" aria-hidden />;
  if (idle) return <ScrollText className="w-4 h-4 text-muted-foreground" aria-hidden />;
  if (hasError) return <XCircle className="w-4 h-4 text-status-critical" aria-hidden />;
  return <CheckCircle2 className="w-4 h-4 text-status-healthy" aria-hidden />;
}

function StepChips({ run }: { run: RunLog }) {
  if (run.steps.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 px-3 pb-2" aria-label="단계">
      {run.steps.map((s) => (
        <li
          key={s.name}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
            s.status === 'running'
              ? 'border-primary/30 bg-primary/10 text-primary'
              : s.status === 'failed'
                ? 'border-status-critical/30 bg-status-critical/10 text-status-critical'
                : 'border-border bg-secondary text-muted-foreground'
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
  );
}

const btnCls = 'text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-background hover:bg-secondary';

export function RunLogPanel({
  run, show, onShowChange, actions, maxHeight = 'max-h-72', fill = false,
  idleHint = '실행하면 요청·접속·출력이 여기에 실시간으로 쌓입니다.',
}: Props) {
  const mode = useLogWindowStore((s) => s.mode);
  const setMode = useLogWindowStore((s) => s.setMode);
  const popupName = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [blocked, setBlocked] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [focusKey, setFocusKey] = useState(0);

  // 새 실행이 시작되면 닫았던/차단됐던 창을 다시 시도한다.
  const wasRunning = useRef(run.running);
  useEffect(() => {
    if (run.running && !wasRunning.current) {
      setDismissed(false);
      setBlocked(false);
    }
    wasRunning.current = run.running;
  }, [run.running]);

  const idle = !run.running && run.lines.length === 0;
  if (idle && !fill) return null;
  const last = run.lines[run.lines.length - 1];
  const hasError = run.lines.some((l) => l.level === 'error');
  const statusText = `${run.running ? '실행 중' : idle ? '대기' : hasError ? '오류 있음' : '완료'} · ${run.lines.length}줄`;
  const title = run.title || '실행 로그';

  const windowMode = mode === 'window' && !blocked;
  const popped = windowMode && show && !idle && !dismissed;
  const inlineLog = show && !windowMode;
  const logText = idle ? idleHint : (formatRunLog(run.lines) || '로그 대기 중…');

  return (
    <section aria-label={`${run.title || '실행'} 로그`} className={`rounded-md border border-border bg-muted/20 ${fill ? 'flex flex-col min-h-0 flex-1' : ''}`}>
      <div className="flex items-center gap-2 px-3 py-2 flex-wrap">
        <StatusIcon run={run} idle={idle} hasError={hasError} />
        <span className="text-sm font-medium">{title}</span>
        <span role="status" className="text-xs text-muted-foreground">{statusText}</span>
        <div className="ml-auto flex items-center gap-2">
          {actions}
          <button
            type="button"
            onClick={() => onShowChange(!show)}
            aria-pressed={show}
            title={show ? '로그 숨기기' : '로그 보기'}
            className={btnCls}
          >
            {show ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
            <ScrollText className="w-3.5 h-3.5" aria-hidden /> 로그 보기
          </button>
          {windowMode && show && !idle && (
            <button
              type="button"
              onClick={() => (dismissed ? setDismissed(false) : setFocusKey((k) => k + 1))}
              title={dismissed ? '로그 새 창 다시 열기' : '로그 새 창 앞으로 가져오기'}
              aria-label={dismissed ? '로그 새 창 다시 열기' : '로그 새 창 앞으로 가져오기'}
              className={btnCls}
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden /> 새 창
            </button>
          )}
          <button
            type="button"
            onClick={() => { setBlocked(false); setDismissed(false); setMode(mode === 'window' ? 'inline' : 'window'); }}
            title={mode === 'window' ? '로그를 화면 안에 표시(전체 기본 설정 변경)' : '로그를 우측 상단 새 창에 표시(전체 기본 설정 변경)'}
            aria-label={mode === 'window' ? '로그를 화면 안에 표시' : '로그를 새 창에 표시'}
            className="p-1 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {mode === 'window' ? <PanelBottom className="w-3.5 h-3.5" aria-hidden /> : <PictureInPicture2 className="w-3.5 h-3.5" aria-hidden />}
          </button>
          {!run.running && !idle && (
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

      {blocked && show && (
        <p role="alert" className="px-3 pb-2 text-xs text-status-warning">
          팝업이 차단돼 로그를 화면 안에 표시합니다 — 브라우저에서 이 사이트의 팝업을 허용하면 새 창으로 뜹니다.
        </p>
      )}

      <StepChips run={run} />

      {inlineLog ? (
        <div className={`px-2 pb-2 ${fill ? 'flex flex-col flex-1 min-h-0' : ''}`}>
          <LogViewer
            text={logText}
            maxHeight={fill ? 'flex-1 min-h-0' : maxHeight}
            className={fill ? 'flex flex-col flex-1 min-h-0' : ''}
            hideToolbar={idle}
            follow={fill}
          />
        </div>
      ) : windowMode && show && idle ? (
        <p className="px-3 pb-2 text-xs text-muted-foreground">실행하면 로그가 우측 상단 새 창에 실시간으로 표시됩니다.</p>
      ) : (
        last && (
          <p className="px-3 pb-2 text-xs text-muted-foreground truncate" title={last.message}>
            {popped && <span className="text-primary">새 창에 표시 중 · </span>}
            {last.message}
          </p>
        )
      )}

      {popped && (
        <PopoutWindow
          name={popupName}
          title={`${title} — ${statusText}`}
          focusKey={focusKey}
          onClose={() => setDismissed(true)}
          onBlocked={() => setBlocked(true)}
        >
          <div className="flex items-center gap-2 px-1">
            <StatusIcon run={run} idle={idle} hasError={hasError} />
            <span className="text-sm font-medium">{title}</span>
            <span role="status" className="text-xs text-muted-foreground">{statusText}</span>
          </div>
          <StepChips run={run} />
          <LogViewer text={logText} maxHeight="flex-1 min-h-0" className="flex flex-col flex-1 min-h-0" follow allowPopout={false} />
        </PopoutWindow>
      )}
    </section>
  );
}
