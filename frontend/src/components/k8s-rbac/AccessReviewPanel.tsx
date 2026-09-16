/**
 * 권한 점검 — "이 SA 로 정말 배포·로그 조회가 되나" 를 API server 에 직접 물어본다.
 *
 * 규칙을 눈으로 읽어 추측하는 것과 다른 값이 나오는 경우가 실제로 있다(다른 바인딩이
 * 겹치거나, 네임스페이스에 별도 정책이 걸려 있을 때). 그래서 SubjectAccessReview 를 쓴다.
 */
import { useMemo, useState } from 'react';
import { Play, ShieldCheck } from 'lucide-react';
import { EmptyState, LogViewer, useToastSafe } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useAccessReview } from '@/hooks/useK8sRbac';
import { formatApiError } from '@/lib/utils';
import type { RbacAccessReviewEntry, RbacServiceAccount } from '@/types';

interface Props {
  clusterId: string;
  serviceAccounts: RbacServiceAccount[];
  showLogs: boolean;
}

export function AccessReviewPanel({ clusterId, serviceAccounts, showLogs }: Props) {
  const toast = useToastSafe();
  const review = useAccessReview(clusterId);
  const [target, setTarget] = useState('');
  const [entries, setEntries] = useState<RbacAccessReviewEntry[] | null>(null);

  const options = useMemo(
    () => serviceAccounts.filter((sa) => sa.name !== 'default'),
    [serviceAccounts],
  );

  const run = async () => {
    const chosen = options.find((sa) => `${sa.namespace}/${sa.name}` === target);
    if (!chosen) return;
    // 이 SA 가 실제로 바인딩된 네임스페이스 전부를 대상으로 본다 — 주 네임스페이스만
    // 확인하면 "다른 네임스페이스도 되는지" 라는 정작 궁금한 걸 놓친다.
    const namespaces = Array.from(
      new Set([
        chosen.namespace,
        ...chosen.bindings.map((b) => b.namespace).filter((n): n is string => !!n),
      ]),
    );
    try {
      const data = await review.mutateAsync({
        namespace: chosen.namespace,
        serviceAccount: chosen.name,
        namespaces,
      });
      setEntries(data);
      const denied = data.filter((d) => !d.allowed).length;
      if (denied === 0) toast.success('권한 점검 완료', `${data.length}건 모두 허용`);
      else toast.warning('권한 점검 완료', `${data.length}건 중 ${denied}건 거부`);
    } catch (e) {
      toast.error('점검 실패', formatApiError(e));
    }
  };

  // 항목(행) × 네임스페이스(열) 매트릭스로 접는다.
  const matrix = useMemo(() => {
    if (!entries) return null;
    const namespaces = Array.from(new Set(entries.map((e) => e.namespace ?? '-')));
    const labels = Array.from(new Set(entries.map((e) => e.label)));
    const cell = new Map<string, RbacAccessReviewEntry>();
    entries.forEach((e) => cell.set(`${e.label}::${e.namespace ?? '-'}`, e));
    return { namespaces, labels, cell };
  }, [entries]);

  const logText = useMemo(() => {
    if (!entries) return '';
    return entries
      .map(
        (e) =>
          `${e.allowed ? '✔ 허용' : '✘ 거부'}  [${e.namespace}] ${e.label}  (${e.verb} ${e.resource}${
            e.subresource ? `/${e.subresource}` : ''
          })${e.reason ? ` — ${e.reason}` : ''}`,
      )
      .join('\n');
  }, [entries]);

  const denied = entries?.filter((e) => !e.allowed) ?? [];

  return (
    <MacCard title="권한 점검">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground font-medium">
          대상
          <select
            id="rbac-review-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="px-3 py-2 bg-secondary border border-border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="">ServiceAccount 선택…</option>
            {options.map((sa) => (
              <option key={`${sa.namespace}/${sa.name}`} value={`${sa.namespace}/${sa.name}`}>
                {sa.namespace} / {sa.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={run}
          disabled={!target || review.isPending}
          title={!target ? '점검할 ServiceAccount 를 고르세요' : '권한 점검 실행'}
          aria-label="권한 점검 실행"
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Play className="w-3.5 h-3.5" /> {review.isPending ? '점검 중…' : '점검 실행'}
        </button>
        <div className="flex-1" />
        {entries && (
          <span className="text-xs text-muted-foreground">
            <b className={denied.length === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}>
              {entries.length - denied.length}
            </b>
            /{entries.length} 통과
          </span>
        )}
      </div>

      {!matrix ? (
        <EmptyState
          icon={ShieldCheck}
          title="점검할 ServiceAccount 를 고르세요"
          description="규칙을 읽어 추측하는 대신 API 서버에 직접 물어본다 — 겹친 바인딩까지 반영된 실제 결과가 나온다."
          compact
        />
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto border border-border rounded-md">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="bg-secondary">
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    확인 항목
                  </th>
                  {matrix.namespaces.map((ns) => (
                    <th
                      key={ns}
                      className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground font-mono whitespace-nowrap"
                    >
                      {ns}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.labels.map((label) => (
                  <tr key={label} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">{label}</td>
                    {matrix.namespaces.map((ns) => {
                      const e = matrix.cell.get(`${label}::${ns}`);
                      if (!e)
                        return (
                          <td key={ns} className="px-3 py-2 text-xs text-muted-foreground">
                            -
                          </td>
                        );
                      return (
                        <td key={ns} className="px-3 py-2">
                          <span
                            className={`inline-flex items-center gap-1 text-xs font-semibold ${
                              e.allowed
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {e.allowed ? '✔ 허용' : '✘ 거부'}
                          </span>
                          {!e.allowed && e.reason && (
                            <div className="text-[11px] text-muted-foreground mt-0.5">{e.reason}</div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {denied.length > 0 && (
            <p className="text-[11.5px] leading-relaxed rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-3 py-2">
              {denied.length}건이 거부됐다. 의도한 것이 아니라면 Binding 탭에서 그 네임스페이스에 다른
              바인딩이 걸려 있지 않은지 확인한다.
            </p>
          )}

          {showLogs && <LogViewer text={logText} maxHeight="max-h-72" />}
        </div>
      )}
    </MacCard>
  );
}
