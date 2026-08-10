/**
 * 수집 모달 공용 — per-host 원본 stdout/stderr 열람 + 전체 오류 목록.
 *
 * CLAUDE.md 실행-로그 규칙: 모든 수집 실행은 원본 출력을 사용자가 열람할 수 있어야
 * 한다(성공 호스트 포함). 예전엔 NodeNicsCollectModal 안에만 있었고 나머지 4개 수집
 * 모달은 요약 표만 보여줬다 — 여기로 빼서 다섯 모달이 같은 진단 수단을 갖는다.
 */
import { LogViewer } from '@/components/common';

export function RawOutputDetails({
  stdout, stderr, exitCode,
}: {
  stdout?: string | null;
  stderr?: string | null;
  exitCode?: number | null;
}) {
  const hasStdout = !!stdout;
  const hasStderr = !!stderr;
  if (!hasStdout && !hasStderr && exitCode === undefined) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
        raw 출력 보기
        {exitCode !== null && exitCode !== undefined && (
          <span className="ml-1 font-mono">(exit {exitCode})</span>
        )}
      </summary>
      <div className="mt-1 space-y-1">
        {hasStdout && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">stdout</div>
            <LogViewer text={stdout!} maxHeight="max-h-40" hideToolbar />
          </div>
        )}
        {hasStderr && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">stderr</div>
            <LogViewer text={stderr!} maxHeight="max-h-40" asError hideToolbar />
          </div>
        )}
      </div>
    </details>
  );
}

/** 오류 전체 목록 — "N건 오류: 앞 3건" 절단으로 나머지가 유실되던 것을 펼침형으로 전부 노출. */
export function CollectErrorList({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="px-3 py-2 text-xs text-status-warning border-t border-border bg-status-warning/5">
      <details>
        <summary className="cursor-pointer select-none hover:text-foreground">
          {errors.length}건 오류 — 전체 보기
          <span className="text-muted-foreground ml-1">({errors.slice(0, 2).join(' / ')}{errors.length > 2 ? ' …' : ''})</span>
        </summary>
        <ul className="list-disc pl-4 mt-1 space-y-0.5">
          {errors.map((e, i) => <li key={i} className="font-mono break-all">{e}</li>)}
        </ul>
      </details>
    </div>
  );
}
