import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileCode2, Rocket } from 'lucide-react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { LogViewer } from '@/components/common/LogViewer';
import { RunLogPanel } from '@/components/common/RunLogPanel';
import { StatusBadge } from '@/components/common/StatusBadge';
import { useToast } from '@/components/common/Toast';
import type { CanOperate } from '@/hooks/useCanOperate';
import { alarmRequestKeys, useAlarmApplySettings } from '@/hooks/useAlarmRequests';
import { useLogPref } from '@/hooks/useLogPref';
import { formatRunLog, streamLogged, toRunLogLevel, useRunLog, type RunLogEntry } from '@/hooks/useRunLog';
import { alarmRequestsApi } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { formatDateTime } from '@/lib/utils';
import type { AlarmApplyResult, AlarmRequest } from '@/types';
import { RulePreviewDialog } from './RulePreviewDialog';
import { BTN, BTN_PRIMARY, BTN_SM } from './styles';

const RESULT_LABEL = { created: '생성', updated: '갱신', failed: '실패' } as const;

/**
 * 진행·완료 요청 → 적용 클러스터마다 PrometheusRule 을 만든다(SSE 실시간 로그).
 * 관리자에게는 실제로 나간 K8S API 호출이 cmd 줄로 먼저 보인다. 지난 실행 기록(클러스터별 결과·로그)도 여기서 본다.
 */
export function RuleApplyPanel({ req, perm }: { req: AlarmRequest; perm: CanOperate }) {
  const toast = useToast();
  const qc = useQueryClient();
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('alarm-request-rule-apply');
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState(false);
  const [pastIdx, setPastIdx] = useState<number | null>(null);
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const settings = useAlarmApplySettings();

  const canApply = req.status !== 'rejected';
  const last = req.applyRuns[0];
  const nsOf = (clusterId: string) =>
    settings.data?.clusterOverrides.find((o) => o.clusterId === clusterId)?.namespace || settings.data?.namespace || '—';

  const apply = async () => {
    setConfirm(false);
    const res = await streamLogged<AlarmApplyResult>(runLog, {
      title: `${req.code} PrometheusRule 적용`,
      first: `클러스터 ${req.clusters.length}개에 PrometheusRule 적용 요청`,
      url: alarmRequestsApi.applyRulesStreamUrl(req.id),
      body: {},
      summarize: (r): RunLogEntry[] => r.results.map((x) => [
        x.status === 'failed' ? 'error' : 'info',
        `${x.clusterName}: ${RESULT_LABEL[x.status]}${x.namespace ? ` (${x.namespace}/${x.name})` : ''}${x.status === 'failed' ? ` — ${x.message}` : ''}`,
      ]),
    });
    qc.invalidateQueries({ queryKey: alarmRequestKeys.all });
    if (res.ok) {
      if (res.data.ok) toast.success(`${req.code} PrometheusRule 적용 완료`, res.data.summary);
      else toast.warning(`${req.code} 일부 클러스터 적용 실패`, res.data.summary);
    } else if (!res.aborted) {
      toast.error('PrometheusRule 을 적용하지 못했습니다', res.error instanceof Error ? res.error.message : undefined);
    }
  };

  if (!canApply && req.applyRuns.length === 0) return null;
  const past = pastIdx != null ? req.applyRuns[pastIdx] : null;

  return (
    <div className="grid gap-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground">PrometheusRule 적용</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN_SM} onClick={() => setPreview(true)}>
            <FileCode2 className="w-3.5 h-3.5" /> 규칙 미리보기
          </button>
          {canApply && (
            <button type="button" className={BTN_PRIMARY} disabled={!perm.canOperate || runLog.running}
              title={perm.withHint('클러스터에 적용')} aria-label={perm.ariaWithHint('클러스터에 적용')}
              onClick={() => setConfirm(true)}>
              <Rocket className="w-4 h-4" /> 클러스터에 적용
            </button>
          )}
        </div>
      </div>
      {canApply && (
        <p className="text-xs text-muted-foreground">
          적용 클러스터마다 <span className="font-mono">{settings.data?.namespace ?? 'monitoring'}</span> 네임스페이스(클러스터별 재정의 가능)에
          PrometheusRule 을 만들거나 PEP 가 만든 규칙을 교체합니다.
          {req.status === 'in_progress' && settings.data?.markAppliedOnSuccess !== false && ' 모든 클러스터에 성공하면 「완료」로 바뀝니다.'}
        </p>
      )}

      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-64" />

      {last && (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">최근 적용 {formatDateTime(last.at)} · {last.by}</span>
            <StatusBadge variant={last.ok ? 'healthy' : 'critical'} label={last.ok ? '성공' : '일부 실패'} size="sm" />
          </div>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-secondary/60 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">클러스터</th>
                  <th className="px-2 py-1.5 text-left font-medium">PrometheusRule</th>
                  <th className="px-2 py-1.5 text-left font-medium">결과</th>
                </tr>
              </thead>
              <tbody>
                {last.results.map((r) => (
                  <tr key={r.clusterId} className="border-t border-border align-top">
                    <td className="px-2 py-1.5 whitespace-nowrap">{r.clusterName}</td>
                    <td className="px-2 py-1.5 font-mono break-all">{r.namespace ? `${r.namespace}/${r.name}` : '—'}</td>
                    <td className={`px-2 py-1.5 ${r.status === 'failed' ? 'text-status-critical' : ''}`}>
                      {RESULT_LABEL[r.status]}{r.status === 'failed' && ` — ${r.message}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">지난 실행 로그</span>
            {req.applyRuns.map((r, i) => (
              <button key={r.at + i} type="button" aria-pressed={pastIdx === i}
                className={`${BTN_SM} ${pastIdx === i ? 'border-primary text-primary' : ''}`}
                onClick={() => setPastIdx(pastIdx === i ? null : i)}>
                {formatDateTime(r.at)}{r.ok ? '' : ' (실패)'}
              </button>
            ))}
          </div>
          {past && (
            <LogViewer
              text={formatRunLog(past.log.map(([ts, level, message]) => ({ ts, level: toRunLogLevel(level), message })))}
              maxHeight="max-h-64"
              popoutTitle={`${req.code} PrometheusRule 적용 로그`}
            />
          )}
          {past && isAdmin && <span className="text-xs text-muted-foreground">CMD 줄 = 실제로 보낸 K8S API 호출(관리자에게만 보임)</span>}
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        title={`${req.code} PrometheusRule 을 클러스터에 적용할까요?`}
        description="적용 클러스터에 PrometheusRule 을 만들거나, PEP 가 만든 같은 이름의 규칙을 새 임계치로 교체합니다. 다른 도구가 만든 같은 이름의 규칙은 건드리지 않습니다."
        confirmLabel="적용"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={apply}
      >
        <ul className="text-xs text-muted-foreground grid gap-0.5">
          {req.clusters.map((c) => (
            <li key={c.id}><span className="text-foreground">{c.name}</span> → <span className="font-mono">{nsOf(c.id)}</span></li>
          ))}
        </ul>
        <button type="button" className={`${BTN} mt-2`} onClick={() => { setConfirm(false); setPreview(true); }}>
          적용 전에 YAML 보기
        </button>
      </ConfirmDialog>
      <RulePreviewDialog requestId={req.id} code={req.code} open={preview} onClose={() => setPreview(false)} />
    </div>
  );
}
