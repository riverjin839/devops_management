import { useEffect, useMemo, useState } from 'react';
import { LogViewer } from './LogViewer';

type StreamKey = 'stdout' | 'stderr';

interface ExecOutputTabsProps {
  stdout: string;
  stderr?: string | null;
  /** 탭 라벨 오버라이드 (예: cilium 은 '출력' / '에러'). */
  stdoutLabel?: string;
  stderrLabel?: string;
  /** LogViewer 본문 max-height (기본 max-h-96). */
  maxHeight?: string;
  /** 상위 페이지의 global filter 를 그대로 전달. */
  filterOverride?: string;
  /** LogViewer 툴바 감춤 (상위가 직접 관리할 때). */
  hideToolbar?: boolean;
  className?: string;
}

/**
 * PEP 콘솔 화면 표준 — 실행 결과 stdout/stderr 를 위아래로 쌓지 않고 **탭으로 전환**해
 * 세로 공간을 아낀다. 탭 라벨에는 결과 유무 dot(초록=stdout, 빨강=stderr)과 라인 수를
 * 표기해 클릭 전에 어느 스트림에 내용이 있는지 알 수 있다. 내용이 있는 스트림이
 * 기본 활성 탭이 된다(stdout 우선, stdout 이 비면 stderr).
 */
export function ExecOutputTabs({
  stdout, stderr, stdoutLabel = 'stdout', stderrLabel = 'stderr',
  maxHeight = 'max-h-96', filterOverride, hideToolbar, className = '',
}: ExecOutputTabsProps) {
  const err = stderr ?? '';
  const outLines = useMemo(() => (stdout.trim() ? stdout.split('\n').filter((l) => l.trim()).length : 0), [stdout]);
  const errLines = useMemo(() => (err.trim() ? err.split('\n').filter((l) => l.trim()).length : 0), [err]);

  const [tab, setTab] = useState<StreamKey>(outLines > 0 || errLines === 0 ? 'stdout' : 'stderr');
  // 새 실행 결과가 오면 내용이 있는 쪽으로 활성 탭을 재조정.
  useEffect(() => {
    setTab(outLines > 0 || errLines === 0 ? 'stdout' : 'stderr');
  }, [stdout, err, outLines, errLines]);

  const TabButton = ({ id, label, lines, dotCls }: { id: StreamKey; label: string; lines: number; dotCls: string }) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      aria-pressed={tab === id}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${
        tab === id
          ? 'bg-secondary border-border text-foreground'
          : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${lines > 0 ? dotCls : 'bg-border'}`} aria-hidden />
      {label}
      <span className={`tabular-nums ${lines > 0 ? '' : 'opacity-50'}`}>
        {lines > 0 ? `${lines}줄` : '없음'}
      </span>
    </button>
  );

  return (
    <div className={className}>
      <div className="flex items-center gap-1 mb-1.5">
        <TabButton id="stdout" label={stdoutLabel} lines={outLines} dotCls="bg-emerald-500" />
        <TabButton id="stderr" label={stderrLabel} lines={errLines} dotCls="bg-red-500" />
      </div>
      {tab === 'stdout' ? (
        <LogViewer text={stdout} maxHeight={maxHeight} filterOverride={filterOverride} hideToolbar={hideToolbar} />
      ) : (
        <LogViewer text={err} maxHeight={maxHeight} asError filterOverride={filterOverride} hideToolbar={hideToolbar} />
      )}
    </div>
  );
}
