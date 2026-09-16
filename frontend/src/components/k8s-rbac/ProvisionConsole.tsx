/**
 * 액세스 발급 실행 결과 패널 — 진행 단계 + 실시간 로그 + 발급 결과(kubeconfig).
 *
 * 로그는 항상 수집하고, **보여줄지 말지는 사용자가 "로그 보기" 로 정한다**
 * (CLAUDE.md riverjin839 custom 요청). 접어둔 동안에도 스트림은 계속 쌓여서,
 * 실행이 끝난 뒤 펼쳐도 전체 로그가 그대로 있다.
 */
import { useMemo, useState } from 'react';
import { Check, Copy, Download, Loader2, ShieldCheck, ShieldX, Square } from 'lucide-react';
import { LogViewer } from '@/components/common';
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
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-700 dark:text-emerald-400 font-medium'
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

/** 클립보드 복사 — 브라우저가 막으면 사용자가 직접 선택할 수 있게 조용히 실패한다. */
function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 클립보드 권한 없음 — 아래 텍스트를 직접 선택해 복사 */
    }
  };
  return { copied, copy };
}

export function ProvisionConsole({ stream, showLogs }: ProvisionConsoleProps) {
  const { running, logs, steps, result, error, abort } = stream;
  const { copied, copy } = useCopy();

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

  const downloadKubeconfig = () => {
    if (!result?.kubeconfig) return;
    const blob = new Blob([result.kubeconfig], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `kubeconfig-${result.serviceAccount}-${result.namespace}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!running && logs.length === 0 && !result && !error) {
    return (
      <MacCard title="실행 결과">
        <div className="py-10 text-center text-sm text-muted-foreground">
          왼쪽에서 대상과 권한을 정한 뒤 <span className="text-foreground font-medium">액세스 발급 실행</span>
          을 누르면
          <br />
          단계별 로그와 발급된 kubeconfig 가 여기에 나온다.
        </div>
      </MacCard>
    );
  }

  return (
    <div className="space-y-3">
      <MacCard title="실행 로그">
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <StepChips steps={steps} running={running} />
            <div className="flex-1" />
            {running && (
              <>
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> 실행 중
                </span>
                <button
                  type="button"
                  onClick={abort}
                  title="실행 중단 (이미 만들어진 오브젝트는 남는다)"
                  aria-label="실행 중단"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border border-border text-xs hover:border-destructive hover:text-destructive"
                >
                  <Square className="w-3 h-3" /> 중단
                </button>
              </>
            )}
            <span className="text-xs text-muted-foreground">{logs.length}줄</span>
          </div>

          {error && (
            <div className="text-sm rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2">
              {error}
            </div>
          )}

          {showLogs ? (
            <LogViewer text={logText || '로그 대기 중…'} maxHeight="max-h-80" />
          ) : (
            <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md px-3 py-2.5">
              로그 {logs.length}줄을 수집했다 — 상단의 <span className="text-foreground">로그 보기</span> 를 켜면
              전체가 펼쳐진다.
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
              <dd className="font-mono text-xs">{result.elapsedSeconds}s</dd>
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
                    <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <ShieldX className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  )}
                  <span className="text-muted-foreground">
                    권한 점검 {allowedCount}/{result.accessReview.length} 통과
                  </span>
                </div>
                {denied.length > 0 && (
                  <ul className="space-y-0.5">
                    {denied.map((d, i) => (
                      <li key={i} className="text-amber-700 dark:text-amber-400">
                        ✘ [{d.namespace}] {d.label}
                        {d.reason ? ` — ${d.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {result.kubeconfig && (
              <>
                <pre className="bg-secondary border border-border rounded-md p-3 text-[11px] font-mono overflow-x-auto max-h-56 text-foreground">
                  {result.kubeconfig}
                </pre>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => copy(result.kubeconfig ?? '')}
                    title="kubeconfig 복사"
                    aria-label="kubeconfig 복사"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-medium"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? '복사됨' : 'kubeconfig 복사'}
                  </button>
                  <button
                    type="button"
                    onClick={downloadKubeconfig}
                    title="kubeconfig 파일로 저장"
                    aria-label="kubeconfig 파일로 저장"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border text-xs hover:border-primary"
                  >
                    <Download className="w-3.5 h-3.5" /> .yaml 저장
                  </button>
                </div>
                <div className="text-[11.5px] rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-3 py-2">
                  토큰은 이 화면에서만 볼 수 있다. 창을 닫으면 다시 발급해야 한다 — 감사 로그에는 발급
                  사실만 남고 토큰 값은 남지 않는다.
                </div>
              </>
            )}
          </div>
        </MacCard>
      )}
    </div>
  );
}
