/**
 * 액세스 발급 실행 결과 패널 — 진행 단계 + 실시간 로그 + 발급 결과(kubeconfig).
 *
 * 로그는 항상 수집하고, **보여줄지 말지는 사용자가 "로그 보기" 로 정한다**
 * (CLAUDE.md riverjin839 custom 요청). 접어둔 동안에도 스트림은 계속 쌓여서,
 * 실행이 끝난 뒤 펼쳐도 전체 로그가 그대로 있다.
 */
import { useMemo } from 'react';
import { Check, Loader2, ShieldCheck, ShieldX, Square, X } from 'lucide-react';
import { EmptyState, LogViewer } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { PROVISION_STEPS, type ProvisionStream } from '@/hooks/useK8sRbac';

interface ProvisionConsoleProps {
  stream: ProvisionStream;
  showLogs: boolean;
}

function StepChips({ steps, running }: { steps: ProvisionStream['steps']; running: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PROVISION_STEPS.map(({ key, label }) => {
        const status = steps[key] ?? 'pending';
        const cls =
          status === 'done'
            ? 'bg-secondary border-border text-foreground font-medium'
            : status === 'running'
              ? 'bg-primary/10 border-primary text-primary font-semibold'
              : 'bg-secondary border-border text-muted-foreground';
        return (
          <span
            key={key}
            className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border ${cls}`}
          >
            {status === 'done' && <Check className="w-3 h-3" />}
            {status === 'running' && running && <Loader2 className="w-3 h-3 animate-spin" />}
            {label}
          </span>
        );
      })}
    </div>
  );
}

export function ProvisionConsole({ stream, showLogs }: ProvisionConsoleProps) {
  const { running, logs, steps, result, error, abort } = stream;

  const logText = useMemo(
    () =>
      logs
        .map((l) => {
          const time = l.ts ? l.ts.slice(11, 19) : '';
          const mark = l.level === 'warn' ? 'WARN' : l.level === 'error' ? 'ERROR' : 'INFO';
          return `${time} [${mark}] ${l.message}`;
        })
        .join('\n'),
    [logs],
  );

  const denied = result?.accessReview.filter((r) => !r.allowed) ?? [];
  const allowedCount = (result?.accessReview.length ?? 0) - denied.length;

  if (!running && logs.length === 0 && !result && !error) {
    return (
      <EmptyState icon={ShieldCheck} title="아직 발급을 실행하지 않았습니다."
        description="왼쪽에서 대상과 권한을 정한 뒤 '액세스 발급 실행'을 누르면 단계별 로그와 발급된 kubeconfig 가 여기에 나옵니다." />
    );
  }

  return (
    <div className="space-y-3">
      <MacCard
        title="실행 로그"
        titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{logs.length}줄</span>}
        actions={running ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> 실행 중
            </span>
            <button
              type="button"
              onClick={abort}
              title="실행 중단 (이미 만들어진 오브젝트는 남습니다)"
              aria-label="실행 중단"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-border text-xs hover:border-destructive hover:text-destructive"
            >
              <Square className="w-3 h-3" /> 중단
            </button>
          </>
        ) : undefined}
      >
        <div className="space-y-3">
          <StepChips steps={steps} running={running} />

          {error && (
            <div className="text-sm rounded-md border border-status-critical/40 bg-status-critical/10 text-status-critical px-3 py-2">
              {error}
            </div>
          )}

          {showLogs ? (
            <LogViewer text={logText || '로그 대기 중…'} maxHeight="max-h-80" />
          ) : (
            <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md px-3 py-2.5">
              로그 {logs.length}줄을 수집했습니다 — 상단의 <span className="text-foreground">로그 보기</span> 를 켜면
              전체가 펼쳐집니다.
              {logs.length > 0 && (
                <span className="block mt-1 font-mono text-[11px] text-foreground truncate">
                  {logs[logs.length - 1].message}
                </span>
              )}
            </div>
          )}
        </div>
      </MacCard>

      {result && (
        <MacCard title={result.dryRun ? '모의 실행 결과 (변경 없음)' : '발급 결과'}>
          <div className="space-y-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-xs text-muted-foreground">ServiceAccount</dt>
              <dd className="font-mono text-xs">
                {result.namespace}/{result.serviceAccount}
              </dd>
              <dt className="text-xs text-muted-foreground">적용 네임스페이스</dt>
              <dd className="font-mono text-xs">{result.namespaces.join(', ')}</dd>
              <dt className="text-xs text-muted-foreground">권한 오브젝트</dt>
              <dd className="font-mono text-xs">{result.roleName}</dd>
              <dt className="text-xs text-muted-foreground">토큰 만료</dt>
              <dd className="font-mono text-xs">
                {result.tokenExpiresAt ? result.tokenExpiresAt.replace('T', ' ').slice(0, 16) : '만료 없음'}
              </dd>
              <dt className="text-xs text-muted-foreground">소요</dt>
              <dd className="text-xs tabular-nums">{result.elapsedSeconds}초</dd>
            </dl>

            {result.created.length > 0 && (
              <div className="text-xs">
                <div className="text-muted-foreground mb-1">생성·갱신 {result.created.length}개</div>
                <div className="flex flex-wrap gap-1">
                  {result.created.map((c, i) => (
                    <span
                      key={`${c.kind}-${c.namespace}-${c.name}-${i}`}
                      className="font-mono text-[11px] px-1.5 py-0.5 rounded border border-border bg-secondary"
                    >
                      {c.kind} {c.namespace ? `${c.namespace}/` : ''}
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {result.accessReview.length > 0 && (
              <div className="text-xs">
                <div className="flex items-center gap-2 mb-1">
                  {denied.length === 0 ? (
                    <ShieldCheck className="w-4 h-4 text-status-healthy" aria-hidden="true" />
                  ) : (
                    <ShieldX className="w-4 h-4 text-status-critical" aria-hidden="true" />
                  )}
                  <span className="text-muted-foreground">
                    권한 점검 {allowedCount}/{result.accessReview.length} 통과
                  </span>
                </div>
                {denied.length > 0 && (
                  <ul className="space-y-0.5">
                    {denied.map((d, i) => (
                      <li key={i} className="flex items-start gap-1 text-foreground">
                        <X className="w-3 h-3 mt-0.5 flex-shrink-0 text-status-critical" aria-hidden />
                        <span>[{d.namespace}] {d.label}
                        {d.reason ? ` — ${d.reason}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {result.kubeconfig && (
              <p className="text-xs text-muted-foreground">
                kubeconfig 는 화면 위쪽 <span className="text-foreground">발급된 kubeconfig</span> 카드에 있습니다 — 닫기 전까지
                탭이나 클러스터를 옮겨도 남습니다.
              </p>
            )}
          </div>
        </MacCard>
      )}
    </div>
  );
}
