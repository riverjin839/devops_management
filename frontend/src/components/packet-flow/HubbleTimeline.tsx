import { useId, useState } from 'react';
import { Play, Square, CheckCircle2, XCircle, Info, AlertTriangle, RefreshCw } from 'lucide-react';
import { topologyTraceApi } from '@/services/api';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { runLogged, type RunLog, type RunLogEntry } from '@/hooks/useRunLog';
import type { HubbleFlow, HubbleFlowsResponse } from '@/types';
import { DoubleScrollX, EmptyState } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';

interface Props {
  clusterId: string;
  /** 화면(패킷 흐름 분석) 공용 실행 로그 — 패널은 페이지가 탭 위에 렌더한다. */
  runLog: RunLog;
  /** Phase A 의 source/dest 를 자동 프리필 */
  initialFromPod?: string;
  initialToPod?: string;
  initialToService?: string;
}

const VERDICT_CLS: Record<string, string> = {
  FORWARDED: 'bg-secondary text-muted-foreground border-border',
  DROPPED:   'bg-status-critical/10 text-status-critical border-status-critical/30',
  AUDIT:     'bg-status-warning/10 text-status-warning border-status-warning/30',
  TRACED:    'bg-status-info/10 text-status-info border-status-info/30',
};

function formatTime(iso?: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
}

function formatEndpoint(ep: HubbleFlow['source']): string {
  if (!ep) return '-';
  if (ep.podName) return `${ep.namespace ?? '?'}/${ep.podName}`;
  if (ep.ip) return ep.ip;
  return `(${ep.identity ?? '—'})`;
}

/** 조회 응답 → 실행 로그 요약(건수·verdict 별 집계·drop 사유 상위 3). */
function summarizeFlows(res: HubbleFlowsResponse): RunLogEntry[] {
  if (res.error) return [['error', `Hubble Relay 조회 실패 — ${res.error}`]];
  const byVerdict = new Map<string, number>();
  const byDrop = new Map<string, number>();
  for (const fl of res.flows) {
    const v = fl.verdict ?? '—';
    byVerdict.set(v, (byVerdict.get(v) ?? 0) + 1);
    if (fl.dropReason) byDrop.set(fl.dropReason, (byDrop.get(fl.dropReason) ?? 0) + 1);
  }
  const verdicts = Array.from(byVerdict.entries()).map(([k, n]) => `${k} ${n}`).join(' · ');
  const out: RunLogEntry[] = [['info', `플로우 ${res.count}건${verdicts ? ` · ${verdicts}` : ''}`]];
  if (res.executed) out.push(['info', `실행 명령 — ${res.executed}`]);
  const dropped = byVerdict.get('DROPPED') ?? 0;
  if (dropped) {
    const top = Array.from(byDrop.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3);
    out.push(['warn', `DROPPED ${dropped}건${top.length ? ` — 사유 ${top.map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`]);
  }
  return out;
}

function FlowRow({ f }: { f: HubbleFlow }) {
  const cls = VERDICT_CLS[f.verdict ?? ''] ?? 'bg-status-unknown/10 text-status-unknown border-status-unknown/30';
  const port = f.l4?.destinationPort ? `:${f.l4.destinationPort}` : '';
  const proto = f.l4?.protocol ?? '';
  return (
    <tr className="border-b border-border hover:bg-muted/20">
      <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground whitespace-nowrap">
        {formatTime(f.time)}
      </td>
      <td className="px-2 py-1.5">
        <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border ${cls}`}>
          {f.verdict === 'FORWARDED' && <CheckCircle2 className="w-2.5 h-2.5" />}
          {f.verdict === 'DROPPED' && <XCircle className="w-2.5 h-2.5" />}
          {f.verdict === 'AUDIT' && <AlertTriangle className="w-2.5 h-2.5" />}
          {f.verdict === 'TRACED' && <Info className="w-2.5 h-2.5" />}
          {f.verdict ?? '—'}
        </span>
      </td>
      <td className="px-2 py-1.5 font-mono text-sm text-foreground">{formatEndpoint(f.source)}</td>
      <td className="px-2 py-1.5 font-mono text-sm text-foreground">{formatEndpoint(f.destination)}{port}</td>
      <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground">{proto}</td>
      <td className="px-2 py-1.5 text-xs text-muted-foreground">{f.trafficDirection}</td>
      <td className="px-2 py-1.5 text-xs text-foreground/80 max-w-[480px]">
        <div className="truncate" title={f.summary || f.dropReason || ''}>
          {f.dropReason ? <span className="text-status-critical">{f.dropReason}</span> : f.summary || '—'}
        </div>
      </td>
    </tr>
  );
}

export function HubbleTimeline({ clusterId, runLog, initialFromPod, initialToPod, initialToService }: Props) {
  const [fromPod, setFromPod] = useState(initialFromPod ?? '');
  const [toPod, setToPod] = useState(initialToPod ?? '');
  const [toService, setToService] = useState(initialToService ?? '');
  const [verdict, setVerdict] = useState('');
  const [sinceSeconds, setSinceSeconds] = useState(60);
  const [limit, setLimit] = useState(200);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [resp, setResp] = useState<HubbleFlowsResponse | null>(null);

  const runMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const r = await topologyTraceApi.hubbleFlows({
        clusterId,
        fromPod: fromPod.trim() || undefined,
        toPod: toPod.trim() || undefined,
        toService: toService.trim() || undefined,
        verdict: verdict || undefined,
        sinceSeconds,
        limit,
      }, signal);
      return r.data;
    },
  });

  const canRun = !!clusterId;

  const doQuery = async () => {
    const cond = [
      fromPod.trim() && `from ${fromPod.trim()}`,
      toPod.trim() && `to ${toPod.trim()}`,
      toService.trim() && `svc ${toService.trim()}`,
      verdict && `verdict ${verdict}`,
    ].filter(Boolean).join(' · ') || '전체';
    const r = await runLogged(runLog, {
      title: 'Hubble 플로우 조회',
      first: `Hubble Relay 조회 요청 — ${cond} · 최근 ${sinceSeconds}초 · 최대 ${limit}건`,
      fn: () => runMut.mutateAsync(),
      summarize: summarizeFlows,
    });
    if (r.ok) setResp(r.data);
  };

  return (
    <div className="space-y-3">
      <MacCard title="플로우 조회 조건" bodyPadding="p-3" className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[180px]">
          <label htmlFor={f('fromPod')} className="block text-xs text-muted-foreground mb-0.5">From Pod (ns/name)</label>
          <input id={f('fromPod')} value={fromPod} onChange={(e) => setFromPod(e.target.value)}
            placeholder="default/client-pod"
            className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded" />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label htmlFor={f('toPod')} className="block text-xs text-muted-foreground mb-0.5">To Pod (ns/name)</label>
          <input id={f('toPod')} value={toPod} onChange={(e) => setToPod(e.target.value)}
            placeholder="default/backend"
            className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded" />
        </div>
        <div className="flex-1 min-w-[180px]">
          <label htmlFor={f('toSvc')} className="block text-xs text-muted-foreground mb-0.5">To Service (ns/name)</label>
          <input id={f('toSvc')} value={toService} onChange={(e) => setToService(e.target.value)}
            placeholder="default/api"
            className="w-full px-2 py-1 text-sm font-mono bg-background border border-border rounded" />
        </div>
        <div>
          <label htmlFor={f('verdict')} className="block text-xs text-muted-foreground mb-0.5">Verdict</label>
          <select id={f('verdict')} value={verdict} onChange={(e) => setVerdict(e.target.value)}
            className="px-2 py-1 text-sm bg-background border border-border rounded">
            <option value="">All</option>
            <option value="FORWARDED">FORWARDED</option>
            <option value="DROPPED">DROPPED</option>
            <option value="AUDIT">AUDIT</option>
          </select>
        </div>
        <div>
          <label htmlFor={f('since')} className="block text-xs text-muted-foreground mb-0.5">Since (s)</label>
          <input id={f('since')} type="number" value={sinceSeconds} onChange={(e) => setSinceSeconds(Number(e.target.value) || 60)}
            min={1} max={3600}
            className="w-20 px-2 py-1 text-sm bg-background border border-border rounded" />
        </div>
        <div>
          <label htmlFor={f('limit')} className="block text-xs text-muted-foreground mb-0.5">Limit</label>
          <input id={f('limit')} type="number" value={limit} onChange={(e) => setLimit(Number(e.target.value) || 200)}
            min={1} max={5000}
            className="w-20 px-2 py-1 text-sm bg-background border border-border rounded" />
        </div>
        {runMut.isPending ? (
          <button
            onClick={runMut.abort}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-status-critical text-primary-foreground rounded-lg hover:bg-status-critical"
          >
            <Square className="w-4 h-4 fill-current" />
            중지
          </button>
        ) : (
          <button
            onClick={() => void doQuery()}
            disabled={!canRun}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
          >
            <Play className="w-4 h-4" />
            플로우 조회
          </button>
        )}
      </MacCard>

      {resp?.error && (
        <div className="px-3 py-2 rounded-lg bg-status-warning/10 border border-status-warning/30 text-status-warning text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium">Hubble Relay 조회 실패</p>
            <p className="text-sm text-muted-foreground mt-0.5">{resp.error}</p>
            <p className="text-xs text-muted-foreground mt-1">
              • 클러스터에 <code className="font-mono">hubble-relay</code> 가 배포돼 있어야 합니다.
              <br />
              • 백엔드 컨테이너에 kubectl + hubble CLI 가 설치돼 있어야 합니다.
            </p>
          </div>
          <button onClick={() => void doQuery()} className="p-1 rounded hover:bg-secondary" title="재시도" aria-label="재시도">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      )}

      {resp && !resp.error && (
        <MacCard
          title="Hubble 플로우"
          titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{resp.count}건</span>}
          description={resp.executed ? (
            <span className="font-mono" title={resp.executed}>{resp.executed}</span>
          ) : undefined}
          bodyPadding="p-0"
        >
          <DoubleScrollX>
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-left">
                <tr>
                  <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Time</th>
                  <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Verdict</th>
                  <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Source</th>
                  <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Destination</th>
                  <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">L4</th>
                  <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Dir</th>
                  <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Summary / Drop Reason</th>
                </tr>
              </thead>
              <tbody>
                {resp.flows.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-6 text-muted-foreground">조건에 맞는 flow 가 없습니다.</td></tr>
                ) : resp.flows.map((f, i) => <FlowRow key={i} f={f} />)}
              </tbody>
            </table>
          </DoubleScrollX>
        </MacCard>
      )}

      {!resp && (
        <EmptyState
          icon={Info}
          title="아직 조회한 플로우가 없습니다"
          description={'필터를 입력하고 "플로우 조회" 를 눌러 Hubble Relay 에서 최근 패킷 플로우를 가져오세요.'}
        />
      )}
    </div>
  );
}
