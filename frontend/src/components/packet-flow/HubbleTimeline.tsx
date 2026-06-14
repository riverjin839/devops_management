import { useId, useState } from 'react';
import { Play, Square, CheckCircle2, XCircle, Info, AlertTriangle, RefreshCw } from 'lucide-react';
import { topologyTraceApi } from '@/services/api';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import type { HubbleFlow, HubbleFlowsResponse } from '@/types';
import { DoubleScrollX } from '@/components/common';

interface Props {
  clusterId: string;
  /** Phase A 의 source/dest 를 자동 프리필 */
  initialFromPod?: string;
  initialToPod?: string;
  initialToService?: string;
}

const VERDICT_CLS: Record<string, string> = {
  FORWARDED: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  DROPPED:   'bg-red-500/10 text-red-400 border-red-500/30',
  AUDIT:     'bg-amber-500/10 text-amber-400 border-amber-500/30',
  TRACED:    'bg-sky-500/10 text-sky-400 border-sky-500/30',
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
  return `(${ep.identity ?? '-'})`;
}

function FlowRow({ f }: { f: HubbleFlow }) {
  const cls = VERDICT_CLS[f.verdict ?? ''] ?? 'bg-slate-500/10 text-slate-400 border-slate-500/30';
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
          {f.verdict ?? '-'}
        </span>
      </td>
      <td className="px-2 py-1.5 font-mono text-sm text-foreground">{formatEndpoint(f.source)}</td>
      <td className="px-2 py-1.5 font-mono text-sm text-foreground">{formatEndpoint(f.destination)}{port}</td>
      <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground">{proto}</td>
      <td className="px-2 py-1.5 text-xs text-muted-foreground">{f.trafficDirection}</td>
      <td className="px-2 py-1.5 text-xs text-foreground/80 max-w-[480px]">
        <div className="truncate" title={f.summary || f.dropReason || ''}>
          {f.dropReason ? <span className="text-red-400">{f.dropReason}</span> : f.summary || '-'}
        </div>
      </td>
    </tr>
  );
}

export function HubbleTimeline({ clusterId, initialFromPod, initialToPod, initialToService }: Props) {
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
    onSuccess: (d) => setResp(d),
  });

  const canRun = !!clusterId;

  return (
    <div className="space-y-3">
      <div className="bg-card border border-border rounded-xl p-3 flex items-end gap-2 flex-wrap">
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
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-red-500 text-primary-foreground rounded-lg hover:bg-red-600"
          >
            <Square className="w-4 h-4 fill-current" />
            중지
          </button>
        ) : (
          <button
            onClick={() => runMut.mutate()}
            disabled={!canRun}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
          >
            <Play className="w-4 h-4" />
            플로우 조회
          </button>
        )}
      </div>

      {resp?.error && (
        <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium">Hubble Relay 조회 실패</p>
            <p className="text-sm text-muted-foreground mt-0.5">{resp.error}</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              • 클러스터에 <code className="font-mono">hubble-relay</code> 가 배포돼 있어야 합니다.
              <br />
              • 백엔드 컨테이너에 kubectl + hubble CLI 가 설치돼 있어야 합니다.
            </p>
          </div>
          <button onClick={() => runMut.mutate()} className="p-1 rounded hover:bg-secondary" title="재시도">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      )}

      {resp && !resp.error && (
        <>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{resp.count} flows</span>
            {resp.executed && (
              <span className="ml-2 font-mono text-xs truncate" title={resp.executed}>
                {resp.executed}
              </span>
            )}
          </div>
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <DoubleScrollX>
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-left">
                  <tr>
                    <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Time</th>
                    <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Verdict</th>
                    <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Source</th>
                    <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Destination</th>
                    <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">L4</th>
                    <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Dir</th>
                    <th className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase">Summary / Drop Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {resp.flows.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-6 text-muted-foreground">조건에 맞는 flow 가 없습니다.</td></tr>
                  ) : resp.flows.map((f, i) => <FlowRow key={i} f={f} />)}
                </tbody>
              </table>
            </DoubleScrollX>
          </div>
        </>
      )}

      {!resp && (
        <div className="bg-card border border-border rounded-xl p-10 text-center text-sm text-muted-foreground">
          <Info className="w-8 h-8 mx-auto mb-2 text-muted-foreground/50" />
          필터를 입력하고 "플로우 조회" 를 눌러 Hubble Relay 에서 최근 패킷 플로우를 가져오세요.
        </div>
      )}
    </div>
  );
}
