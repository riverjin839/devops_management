import { useEffect, useState } from 'react';
import { X, Copy, Check, Terminal, AlertTriangle, XCircle, CheckCircle } from 'lucide-react';
import type { Playbook } from '@/types';
import { DoubleScrollX, useModalA11y } from '@/components/common';
import { parseUTC } from '@/lib/utils';

interface PlaybookLogDialogProps {
  playbook: Playbook | null;
  onClose: () => void;
}

interface HostStat {
  ok?: number;
  changed?: number;
  failures?: number;
  unreachable?: number;
  skipped?: number;
}

interface FailedTask {
  task?: string;
  host?: string;
  msg?: string;
  stderr?: string;
  rc?: number;
}

/** Playbook 실행 결과 상세 로그 — last_result 의 모든 필드 (요약, 호스트별 통계, 실패 task, raw stdout) 표시.
 *  ESC / 배경 클릭 / X 로 닫음. raw output 복사 기능 포함. */
export function PlaybookLogDialog({ playbook, onClose }: PlaybookLogDialogProps) {
  const [copied, setCopied] = useState(false);

  // ESC 닫기 · 포커스 트랩 · 초점 복원 (공용 훅) — playbook 이 있으면 열림
  const dialogRef = useModalA11y(!!playbook, onClose);

  useEffect(() => {
    if (copied) {
      const t = setTimeout(() => setCopied(false), 1500);
      return () => clearTimeout(t);
    }
  }, [copied]);

  if (!playbook) return null;

  const result = playbook.lastResult ?? {};
  const stats = (result.stats ?? {}) as Record<string, unknown>;
  const totals = (stats.totals ?? {}) as HostStat;
  const hosts = (stats.hosts ?? {}) as Record<string, HostStat>;
  const failedTasks = ((stats.failed_tasks as FailedTask[] | undefined) ?? []);
  const unreachableTasks = ((stats.unreachable_tasks as FailedTask[] | undefined) ?? []);
  const returncode = stats.returncode as number | undefined;
  const message = result.message as string | undefined;
  const rawOutput = result.raw_output as string | undefined;
  const durationMs = result.duration_ms as number | undefined;

  const isSuccess = (returncode === 0) || (totals.failures === 0 && totals.unreachable === 0);

  const handleCopyRaw = async () => {
    if (!rawOutput) return;
    try {
      await navigator.clipboard.writeText(rawOutput);
      setCopied(true);
    } catch {
      // 복사 실패 시 무시 — 환경에 따라 권한 없을 수 있음.
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${playbook.name} 실행 로그`}
        className="fixed inset-4 sm:inset-10 z-50 bg-card border border-border rounded-2xl shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <Terminal className="w-5 h-5 text-primary flex-shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold truncate">{playbook.name}</h2>
              <p className="text-xs text-muted-foreground truncate">
                실행 결과 상세
                {playbook.lastRunAt && ` · ${parseUTC(playbook.lastRunAt).toLocaleString('ko-KR')}`}
                {durationMs != null && ` · ${(durationMs / 1000).toFixed(2)}s`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground"
            aria-label="닫기"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Summary */}
          <section>
            <SectionTitle icon={isSuccess ? CheckCircle : XCircle} title="요약" tone={isSuccess ? 'success' : 'error'} />
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <SummaryCell label="Return Code" value={returncode ?? '—'} accent={returncode === 0 ? 'success' : returncode == null ? 'neutral' : 'error'} />
              <SummaryCell label="OK"          value={totals.ok ?? 0}          accent="success" />
              <SummaryCell label="Changed"     value={totals.changed ?? 0}     accent="warning" />
              <SummaryCell label="Failures"    value={totals.failures ?? 0}    accent={(totals.failures ?? 0) > 0 ? 'error' : 'neutral'} />
              <SummaryCell label="Unreachable" value={totals.unreachable ?? 0} accent={(totals.unreachable ?? 0) > 0 ? 'error' : 'neutral'} />
              <SummaryCell label="Skipped"     value={totals.skipped ?? 0}     accent="neutral" />
            </div>
            {message && (
              <p className="mt-3 text-sm text-muted-foreground bg-secondary/50 border border-border rounded-lg px-3 py-2">
                {message}
              </p>
            )}
          </section>

          {/* Per-host */}
          {Object.keys(hosts).length > 0 && (
            <section>
              <SectionTitle title="호스트별 결과" />
              <DoubleScrollX className="rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-secondary/50">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">Host</th>
                      <th className="px-3 py-1.5 text-right font-medium text-emerald-500">OK</th>
                      <th className="px-3 py-1.5 text-right font-medium text-amber-500">Changed</th>
                      <th className="px-3 py-1.5 text-right font-medium text-red-500">Failures</th>
                      <th className="px-3 py-1.5 text-right font-medium text-orange-500">Unreachable</th>
                      <th className="px-3 py-1.5 text-right font-medium text-slate-400">Skipped</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {Object.entries(hosts).map(([host, h]) => (
                      <tr key={host} className="border-t border-border">
                        <td className="px-3 py-1.5 truncate">{host}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{h.ok ?? 0}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{h.changed ?? 0}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{h.failures ?? 0}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{h.unreachable ?? 0}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{h.skipped ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DoubleScrollX>
            </section>
          )}

          {/* Failed tasks */}
          {failedTasks.length > 0 && (
            <section>
              <SectionTitle icon={XCircle} title={`실패한 Task (${failedTasks.length})`} tone="error" />
              <div className="space-y-2">
                {failedTasks.map((t, i) => (
                  <FailedTaskCard key={i} task={t} variant="failed" />
                ))}
              </div>
            </section>
          )}

          {/* Unreachable */}
          {unreachableTasks.length > 0 && (
            <section>
              <SectionTitle icon={AlertTriangle} title={`Unreachable (${unreachableTasks.length})`} tone="warning" />
              <div className="space-y-2">
                {unreachableTasks.map((t, i) => (
                  <FailedTaskCard key={i} task={t} variant="unreachable" />
                ))}
              </div>
            </section>
          )}

          {/* Raw output */}
          <section>
            <div className="flex items-center justify-between mb-1.5">
              <SectionTitle title="Raw Output (stdout / stderr · 최대 5000자)" inline />
              <button
                onClick={handleCopyRaw}
                disabled={!rawOutput}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-border hover:bg-secondary disabled:opacity-40"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                {copied ? '복사됨' : '복사'}
              </button>
            </div>
            {rawOutput ? (
              <pre className="text-xs font-mono bg-zinc-950 text-zinc-100 rounded-lg p-3 overflow-x-auto max-h-[40vh] whitespace-pre-wrap break-words">
                {rawOutput}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground italic px-3 py-2 bg-secondary/30 rounded">raw output 없음 — 실행 기록이 없거나 너무 짧아 저장되지 않음</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function SectionTitle({
  title, icon: Icon, tone = 'neutral', inline = false,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'neutral' | 'success' | 'warning' | 'error';
  inline?: boolean;
}) {
  const toneClass =
    tone === 'success' ? 'text-emerald-500'
    : tone === 'warning' ? 'text-amber-500'
    : tone === 'error' ? 'text-red-500'
    : 'text-foreground';
  return (
    <div className={`flex items-center gap-1.5 ${inline ? '' : 'mb-2'}`}>
      {Icon && <Icon className={`w-4 h-4 ${toneClass}`} />}
      <h3 className={`text-sm font-semibold uppercase tracking-wider ${toneClass}`}>{title}</h3>
    </div>
  );
}

function SummaryCell({
  label, value, accent,
}: {
  label: string;
  value: number | string;
  accent: 'success' | 'warning' | 'error' | 'neutral';
}) {
  const cls =
    accent === 'success' ? 'text-emerald-600 dark:text-emerald-400'
    : accent === 'warning' ? 'text-amber-600 dark:text-amber-400'
    : accent === 'error' ? 'text-red-600 dark:text-red-400'
    : 'text-foreground';
  return (
    <div className="bg-secondary/50 border border-border rounded-lg px-3 py-2">
      <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${cls}`}>{value}</p>
    </div>
  );
}

function FailedTaskCard({ task, variant }: { task: FailedTask; variant: 'failed' | 'unreachable' }) {
  const borderClass = variant === 'failed' ? 'border-red-500/30 bg-red-500/5' : 'border-orange-500/30 bg-orange-500/5';
  return (
    <div className={`border rounded-lg p-3 ${borderClass}`}>
      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-sm font-semibold">{task.task ?? '(unnamed task)'}</span>
        {task.host && (
          <span className="text-xs font-mono text-muted-foreground">@ {task.host}</span>
        )}
        {task.rc != null && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">rc={task.rc}</span>
        )}
      </div>
      {task.msg && (
        <pre className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80">{task.msg}</pre>
      )}
      {task.stderr && (
        <pre className="text-xs font-mono whitespace-pre-wrap break-words text-muted-foreground mt-1 pt-1 border-t border-border/50">stderr: {task.stderr}</pre>
      )}
    </div>
  );
}
