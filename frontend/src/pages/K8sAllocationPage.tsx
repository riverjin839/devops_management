import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Gauge, ChevronRight, ChevronDown, RefreshCw, AlertTriangle,
  Cpu, MemoryStick, Server, Layers, TrendingDown, BarChart3,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, Legend,
} from 'recharts';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { EmptyState, Skeleton } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import {
  useAllocNodes, useAllocNamespaces, useAllocWorkloads, useAllocPods,
} from '@/hooks/useK8sAllocation';
import type {
  AllocNodeRow, AllocNamespaceRow, AllocWorkloadRow,
} from '@/types';

// ── 포맷/계산 헬퍼 ───────────────────────────────────────────────────────────
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
const pctText = (part: number, whole: number) => `${Math.round(ratio(part, whole) * 100)}%`;
const fmtCores = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)}` : `${m}m`);
const fmtGi = (b: number) => {
  const gi = b / 1024 ** 3;
  if (gi >= 1) return `${gi.toFixed(1)}Gi`;
  const mi = b / 1024 ** 2;
  return `${mi.toFixed(0)}Mi`;
};

/** 효율 판정: 사용량/request 비율 → 배지. usage 없으면 null. */
type EffKind = 'over' | 'ok' | 'under' | null;
function efficiency(reqM: number, usageM: number | null): EffKind {
  if (usageM == null || reqM <= 0) return null;
  const r = usageM / reqM;
  if (r < 0.3) return 'over';      // request 과대(낭비)
  if (r > 1.05) return 'under';    // 실사용이 request 초과(위험)
  return 'ok';
}
const EFF_BADGE: Record<Exclude<EffKind, null>, { label: string; cls: string }> = {
  over: { label: 'request 과대', cls: 'bg-amber-100 text-amber-700 border-amber-300' },
  ok: { label: '적정', cls: 'bg-green-100 text-green-700 border-green-300' },
  under: { label: '사용 초과', cls: 'bg-red-100 text-red-700 border-red-300' },
};

function EffBadge({ kind }: { kind: EffKind }) {
  if (!kind) return null;
  const b = EFF_BADGE[kind];
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] border ${b.cls}`}>
      {b.label}
    </span>
  );
}

// ── 미터 바: alloc(=track) 대비 request(파랑) + usage(초록) 2줄 ─────────────────
function MeterBar({
  alloc, req, usage, reqDisplay, usageDisplay, allocDisplay, unitLabel,
}: {
  alloc: number; req: number; usage: number | null;
  reqDisplay: string; usageDisplay: string | null; allocDisplay: string; unitLabel: string;
}) {
  const reqPct = Math.min(100, ratio(req, alloc) * 100);
  const usagePct = usage == null ? 0 : Math.min(100, ratio(usage, alloc) * 100);
  // request 가 alloc 초과(over-committed)면 빨강으로
  const reqColor = ratio(req, alloc) > 1 ? 'bg-red-500' : 'bg-sky-500';
  return (
    <div className="min-w-[180px]">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="w-9 text-[10px] text-muted-foreground shrink-0">req</span>
        <div className="flex-1 h-2 rounded-full bg-muted/40 overflow-hidden">
          <div className={`h-full ${reqColor}`} style={{ width: `${reqPct}%` }} />
        </div>
        <span className="w-24 text-[11px] tabular-nums text-right shrink-0">
          {reqDisplay}{unitLabel} · {pctText(req, alloc)}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="w-9 text-[10px] text-muted-foreground shrink-0">use</span>
        <div className="flex-1 h-2 rounded-full bg-muted/40 overflow-hidden">
          {usage != null && <div className="h-full bg-green-500" style={{ width: `${usagePct}%` }} />}
        </div>
        <span className="w-24 text-[11px] tabular-nums text-right shrink-0 text-muted-foreground">
          {usage == null ? '—' : `${usageDisplay}${unitLabel} · ${pctText(usage, alloc)}`}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5 text-right">
        alloc {allocDisplay}{unitLabel}
      </div>
    </div>
  );
}

// ── 작은 req vs usage 셀 (NS/워크로드/파드 테이블용) ──────────────────────────────
function ReqUseCell({ req, usage, icon }: { req: string; usage: string | null; icon: 'cpu' | 'mem' }) {
  const Icon = icon === 'cpu' ? Cpu : MemoryStick;
  return (
    <div className="text-[12px] tabular-nums whitespace-nowrap">
      <div className="flex items-center gap-1"><Icon className="w-3 h-3 text-muted-foreground" />{req}</div>
      <div className="text-muted-foreground pl-4">{usage == null ? '—' : usage}</div>
    </div>
  );
}

type ViewMode = 'visual' | 'nodes' | 'namespaces';

export function K8sAllocationPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const { data: clusters = [] } = useClusters();
  const [view, setView] = useState<ViewMode>('visual');

  useEffect(() => {
    if (!clusterId && clusters.length > 0) {
      navigate(`/k8s-allocation/${clusters[0].id}`, { replace: true });
    }
  }, [clusterId, clusters, navigate]);

  return (
    <div className="min-h-screen bg-background p-5">
      <div className="flex gap-3 max-w-[1700px] mx-auto">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => { if (id) navigate(`/k8s-allocation/${id}`); }}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/cluster-overview" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" /> 클러스터 현황
            </Link>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <Gauge className="w-5 h-5 text-orange-500" /> K8S 자원 관리
            </h1>
            <span className="text-xs text-muted-foreground">노드 여유 대비 request·사용량(slack) 진단</span>
          </div>

          {!clusterId ? (
            <MacCard><EmptyState title="클러스터를 선택하세요" description="좌측에서 클러스터를 고르면 자원 현황이 표시됩니다." /></MacCard>
          ) : (
            <>
              <SummarySection clusterId={clusterId} />

              <div className="inline-flex rounded-xl border border-border bg-card p-1">
                {([
                  ['visual', '시각화', <BarChart3 key="i" className="w-4 h-4" />],
                  ['nodes', '노드별 자원', <Server key="i" className="w-4 h-4" />],
                  ['namespaces', '네임스페이스별 자원', <Layers key="i" className="w-4 h-4" />],
                ] as [ViewMode, string, ReactNode][]).map(([k, l, icon]) => (
                  <button
                    key={k}
                    onClick={() => setView(k)}
                    className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 ${view === k ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {icon} {l}
                  </button>
                ))}
              </div>

              {view === 'visual' && <VisualView clusterId={clusterId} />}
              {view === 'nodes' && <NodesView clusterId={clusterId} />}
              {view === 'namespaces' && <NamespacesView clusterId={clusterId} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 클러스터 요약 ────────────────────────────────────────────────────────────
function SummarySection({ clusterId }: { clusterId: string }) {
  const { data, isLoading } = useAllocNamespaces(clusterId);
  if (isLoading) return <MacCard title="클러스터 요약"><Skeleton className="h-20 w-full" /></MacCard>;
  if (!data) return null;
  const s = data.summary;
  const allocEff = ratio(s.cpuReqM, s.cpuAllocM);          // request / allocatable
  const useEff = s.cpuUsageM == null ? null : ratio(s.cpuUsageM, s.cpuReqM); // usage / request
  const cpuWasteM = s.cpuUsageM == null ? null : Math.max(0, s.cpuReqM - s.cpuUsageM);
  const memWasteB = s.memUsageB == null ? null : Math.max(0, s.memReqB - s.memUsageB);

  return (
    <MacCard title="클러스터 요약">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="노드 / 파드" value={`${s.nodeCount} / ${s.podCount}`} icon={<Server className="w-4 h-4" />} />
        <Stat
          label="CPU 할당효율 (req/alloc)"
          value={pctText(s.cpuReqM, s.cpuAllocM)}
          sub={`req ${fmtCores(s.cpuReqM)} / alloc ${fmtCores(s.cpuAllocM)} 코어`}
          warn={allocEff < 0.5}
        />
        <Stat
          label="MEM 할당효율 (req/alloc)"
          value={pctText(s.memReqB, s.memAllocB)}
          sub={`req ${fmtGi(s.memReqB)} / alloc ${fmtGi(s.memAllocB)}`}
        />
        <Stat
          label="CPU 사용효율 (use/req)"
          value={useEff == null ? '—' : pctText(s.cpuUsageM ?? 0, s.cpuReqM)}
          sub={s.cpuUsageM == null ? 'metrics-server 없음' : `use ${fmtCores(s.cpuUsageM)} 코어`}
          warn={useEff != null && useEff < 0.3}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm border-t border-border pt-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <TrendingDown className="w-4 h-4 text-amber-500" />
          추정 낭비(slack = request − 사용량):
        </div>
        <span className="font-semibold tabular-nums">
          CPU {cpuWasteM == null ? '—' : `${fmtCores(cpuWasteM)} 코어`}
        </span>
        <span className="font-semibold tabular-nums">
          MEM {memWasteB == null ? '—' : fmtGi(memWasteB)}
        </span>
        {s.noRequestPods > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] bg-amber-100 text-amber-700 border border-amber-300">
            <AlertTriangle className="w-3 h-3" /> request 미설정 파드 {s.noRequestPods}개
          </span>
        )}
        {!data.metricsAvailable && (
          <span className="text-xs text-muted-foreground">· 사용량은 metrics-server 가용 시 표시됩니다</span>
        )}
      </div>
    </MacCard>
  );
}

function Stat({ label, value, sub, icon, warn }: { label: string; value: string; sub?: string; icon?: ReactNode; warn?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-3">
      <div className="text-[11px] text-muted-foreground flex items-center gap-1">{icon}{label}</div>
      <div className={`text-xl font-semibold mt-0.5 ${warn ? 'text-amber-600' : ''}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

// ── 시각화 뷰 (테이블 외 — 게이지 카드 + 슬랙 랭킹 차트) ──────────────────────────
function GaugeRow({ label, alloc, req, usage }: { label: string; alloc: number; req: number; usage: number | null }) {
  const reqPct = Math.min(100, ratio(req, alloc) * 100);
  const usePct = usage == null ? 0 : Math.min(100, ratio(usage, alloc) * 100);
  const over = ratio(req, alloc) > 1;
  return (
    <div>
      <div className="flex justify-between text-[11px] text-muted-foreground mb-0.5">
        <span>{label}</span>
        <span className="tabular-nums">
          req <b className={over ? 'text-red-500' : 'text-sky-600'}>{pctText(req, alloc)}</b>
          {usage != null && <> · use <b className="text-green-600">{pctText(usage, alloc)}</b></>}
        </span>
      </div>
      {/* 트랙(alloc) 위에 request(파랑) + usage(초록, 얇게 오버레이) */}
      <div className="relative h-3 rounded-full bg-muted/40 overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${over ? 'bg-red-400' : 'bg-sky-400/70'}`} style={{ width: `${reqPct}%` }} />
        {usage != null && <div className="absolute inset-y-0 left-0 bg-green-500" style={{ width: `${usePct}%`, height: '100%', opacity: 0.85 }} />}
      </div>
    </div>
  );
}

function VisualView({ clusterId }: { clusterId: string }) {
  const nodesQ = useAllocNodes(clusterId);
  const nsQ = useAllocNamespaces(clusterId);

  const nsChart = useMemo(() => {
    const items = [...(nsQ.data?.items ?? [])];
    return items
      .map((n) => ({
        namespace: n.namespace,
        req: +(n.cpuReqM / 1000).toFixed(2),
        use: n.cpuUsageM == null ? null : +(n.cpuUsageM / 1000).toFixed(2),
        slack: n.cpuUsageM == null ? 0 : Math.max(0, (n.cpuReqM - n.cpuUsageM) / 1000),
      }))
      .sort((a, b) => b.req - a.req)
      .slice(0, 12);
  }, [nsQ.data]);

  return (
    <div className="space-y-3">
      {/* 노드 게이지 카드 그리드 */}
      <MacCard title="노드 자원 게이지 (alloc 대비 request·사용량)">
        {nodesQ.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !nodesQ.data?.items.length ? (
          <EmptyState title="노드 없음" description="표시할 노드가 없습니다." />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {nodesQ.data.items.map((n) => (
              <div key={n.name} className="rounded-xl border border-border bg-card/50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="font-medium text-sm truncate" title={n.name}>{n.name}</div>
                  <span className="text-[10px] text-muted-foreground">{n.roles.join(',')}</span>
                </div>
                <div className="space-y-2">
                  <GaugeRow label="CPU" alloc={n.cpuAllocM} req={n.cpuReqM} usage={n.cpuUsageM} />
                  <GaugeRow label="MEM" alloc={n.memAllocB} req={n.memReqB} usage={n.memUsageB} />
                </div>
                <div className="flex justify-between text-[11px] text-emerald-600 mt-2 tabular-nums">
                  <span>여유 CPU {fmtCores(n.cpuSlackM)}</span>
                  <span>여유 MEM {fmtGi(n.memSlackB)}</span>
                  <span className="text-muted-foreground">{n.podCount} pods</span>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-4 mt-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-sm inline-block bg-sky-400/70" /> request</span>
          <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-sm inline-block bg-green-500" /> 실사용</span>
          <span className="flex items-center gap-1"><i className="w-3 h-3 rounded-sm inline-block bg-red-400" /> request &gt; alloc(과할당)</span>
        </div>
      </MacCard>

      {/* 네임스페이스 슬랙 랭킹 — request vs 실사용 (gap = 낭비) */}
      <MacCard title="네임스페이스 CPU request vs 실사용 (Top 12 · 간격이 클수록 낭비)">
        {nsQ.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : !nsChart.length ? (
          <EmptyState title="데이터 없음" description="표시할 네임스페이스가 없습니다." />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(260, nsChart.length * 34)}>
            <BarChart data={nsChart} layout="vertical" margin={{ left: 12, right: 24, top: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
              <XAxis type="number" tick={{ fontSize: 11 }} unit=" 코어" />
              <YAxis type="category" dataKey="namespace" width={130} tick={{ fontSize: 11 }} />
              <Tooltip
                formatter={(v: number, name) => [`${v} 코어`, name === 'req' ? 'request' : '실사용']}
                contentStyle={{ fontSize: 12, borderRadius: 8 }}
              />
              <Legend formatter={(v) => (v === 'req' ? 'request' : '실사용')} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="req" name="req" fill="#7dd3fc" radius={[0, 4, 4, 0]}>
                {nsChart.map((d, i) => (
                  <Cell key={i} fill={d.use != null && d.req > 0 && d.use / d.req < 0.3 ? '#fbbf24' : '#7dd3fc'} />
                ))}
              </Bar>
              <Bar dataKey="use" name="use" fill="#22c55e" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
        {!nsQ.data?.metricsAvailable && (
          <div className="text-xs text-muted-foreground mt-2">※ metrics-server 가 없어 실사용(use)은 표시되지 않습니다. request 기준만 노출됩니다.</div>
        )}
      </MacCard>
    </div>
  );
}

// ── 노드 뷰 ──────────────────────────────────────────────────────────────────
type NodeSort = 'name' | 'cpuSlack' | 'memSlack';
function NodesView({ clusterId }: { clusterId: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useAllocNodes(clusterId);
  const [sort, setSort] = useState<NodeSort>('cpuSlack');

  const rows = useMemo(() => {
    const items = [...(data?.items ?? [])];
    if (sort === 'cpuSlack') items.sort((a, b) => b.cpuSlackM - a.cpuSlackM);
    else if (sort === 'memSlack') items.sort((a, b) => b.memSlackB - a.memSlackB);
    else items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
  }, [data, sort]);

  if (isLoading) return <MacCard title="노드별 자원"><Skeleton className="h-40 w-full" /></MacCard>;
  if (isError) return <MacCard title="노드별 자원"><EmptyState title="조회 실패" description={(error as Error)?.message ?? '노드 자원을 불러오지 못했습니다.'} /></MacCard>;
  if (!rows.length) return <MacCard title="노드별 자원"><EmptyState title="노드 없음" description="표시할 노드가 없습니다." /></MacCard>;

  return (
    <MacCard title="노드별 자원" bodyPadding="p-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">정렬</span>
          {([['cpuSlack', 'CPU slack'], ['memSlack', 'MEM slack'], ['name', '이름']] as [NodeSort, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setSort(k)}
              className={`px-2 py-0.5 rounded-lg border ${sort === k ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}>
              {l}
            </button>
          ))}
        </div>
        <button onClick={() => refetch()} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> 새로고침
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/20 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Node</th>
              <th className="px-4 py-2 font-medium">CPU (alloc 대비)</th>
              <th className="px-4 py-2 font-medium">MEM (alloc 대비)</th>
              <th className="px-4 py-2 font-medium text-right">CPU slack</th>
              <th className="px-4 py-2 font-medium text-right">MEM slack</th>
              <th className="px-4 py-2 font-medium text-right">Pods</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n: AllocNodeRow) => (
              <tr key={n.name} className="border-t border-border align-top hover:bg-muted/10">
                <td className="px-4 py-3">
                  <div className="font-medium">{n.name}</div>
                  <div className="text-[11px] text-muted-foreground">{n.roles.join(', ')}</div>
                  {n.unschedulable && <span className="text-[10px] text-amber-600">cordoned</span>}
                </td>
                <td className="px-4 py-3">
                  <MeterBar alloc={n.cpuAllocM} req={n.cpuReqM} usage={n.cpuUsageM}
                    reqDisplay={n.cpuReqDisplay} usageDisplay={n.cpuUsageDisplay} allocDisplay={n.cpuAllocDisplay} unitLabel="" />
                </td>
                <td className="px-4 py-3">
                  <MeterBar alloc={n.memAllocB} req={n.memReqB} usage={n.memUsageB}
                    reqDisplay={n.memReqDisplay} usageDisplay={n.memUsageDisplay} allocDisplay={n.memAllocDisplay} unitLabel="" />
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-emerald-600 font-medium">{fmtCores(n.cpuSlackM)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-emerald-600 font-medium">{fmtGi(n.memSlackB)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{n.podCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </MacCard>
  );
}

// ── 네임스페이스 뷰 (드릴다운) ───────────────────────────────────────────────────
function NamespacesView({ clusterId }: { clusterId: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useAllocNamespaces(clusterId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (ns: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    return next;
  });

  if (isLoading) return <MacCard title="네임스페이스별 자원"><Skeleton className="h-40 w-full" /></MacCard>;
  if (isError) return <MacCard title="네임스페이스별 자원"><EmptyState title="조회 실패" description={(error as Error)?.message ?? '불러오지 못했습니다.'} /></MacCard>;
  const rows = data?.items ?? [];
  if (!rows.length) return <MacCard title="네임스페이스별 자원"><EmptyState title="데이터 없음" description="표시할 네임스페이스가 없습니다." /></MacCard>;

  return (
    <MacCard title="네임스페이스별 자원" bodyPadding="p-0">
      <div className="flex items-center justify-end px-4 py-2 border-b border-border">
        <button onClick={() => refetch()} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> 새로고침
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/20 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium w-8" />
              <th className="px-3 py-2 font-medium">Namespace</th>
              <th className="px-3 py-2 font-medium text-right">Pods</th>
              <th className="px-3 py-2 font-medium text-right">Workloads</th>
              <th className="px-3 py-2 font-medium">CPU req/use</th>
              <th className="px-3 py-2 font-medium">MEM req/use</th>
              <th className="px-3 py-2 font-medium">효율</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((ns: AllocNamespaceRow) => {
              const open = expanded.has(ns.namespace);
              return (
                <Fragment key={ns.namespace}>
                  <tr className="border-t border-border hover:bg-muted/10 cursor-pointer" onClick={() => toggle(ns.namespace)}>
                    <td className="px-3 py-2.5 text-muted-foreground">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                    <td className="px-3 py-2.5 font-medium">
                      {ns.namespace}
                      {ns.noRequestPods > 0 && (
                        <span className="ml-2 text-[10px] text-amber-600">· req미설정 {ns.noRequestPods}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{ns.podCount}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{ns.workloadCount}</td>
                    <td className="px-3 py-2.5"><ReqUseCell req={ns.cpuReqDisplay} usage={ns.cpuUsageDisplay} icon="cpu" /></td>
                    <td className="px-3 py-2.5"><ReqUseCell req={ns.memReqDisplay} usage={ns.memUsageDisplay} icon="mem" /></td>
                    <td className="px-3 py-2.5"><EffBadge kind={efficiency(ns.cpuReqM, ns.cpuUsageM)} /></td>
                  </tr>
                  {open && (
                    <tr className="bg-muted/5">
                      <td />
                      <td colSpan={6} className="px-3 py-2">
                        <WorkloadsDrill clusterId={clusterId} namespace={ns.namespace} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </MacCard>
  );
}

function WorkloadsDrill({ clusterId, namespace }: { clusterId: string; namespace: string }) {
  const { data, isLoading, isError } = useAllocWorkloads(clusterId, namespace, true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const key = (w: AllocWorkloadRow) => `${w.kind}/${w.name}`;
  const toggle = (k: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  if (isLoading) return <Skeleton className="h-12 w-full" />;
  if (isError) return <div className="text-xs text-red-600">워크로드 조회 실패</div>;
  const rows = data?.items ?? [];
  if (!rows.length) return <div className="text-xs text-muted-foreground py-1">워크로드 없음</div>;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/20 text-left text-[11px] text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 font-medium w-8" />
            <th className="px-3 py-1.5 font-medium">Workload</th>
            <th className="px-3 py-1.5 font-medium text-right">Pods</th>
            <th className="px-3 py-1.5 font-medium">CPU req/use</th>
            <th className="px-3 py-1.5 font-medium">MEM req/use</th>
            <th className="px-3 py-1.5 font-medium">효율</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => {
            const k = key(w);
            const open = expanded.has(k);
            return (
              <Fragment key={k}>
                <tr className="border-t border-border hover:bg-muted/10 cursor-pointer" onClick={() => toggle(k)}>
                  <td className="px-3 py-2 text-muted-foreground">{open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</td>
                  <td className="px-3 py-2">
                    <span className="text-[10px] uppercase text-muted-foreground mr-1.5">{w.kind}</span>
                    <span className="font-medium">{w.name}</span>
                    {w.noRequestPods > 0 && <span className="ml-2 text-[10px] text-amber-600">· req미설정 {w.noRequestPods}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{w.podCount}</td>
                  <td className="px-3 py-2"><ReqUseCell req={fmtCores(w.cpuReqM)} usage={w.cpuUsageM == null ? null : fmtCores(w.cpuUsageM)} icon="cpu" /></td>
                  <td className="px-3 py-2"><ReqUseCell req={fmtGi(w.memReqB)} usage={w.memUsageB == null ? null : fmtGi(w.memUsageB)} icon="mem" /></td>
                  <td className="px-3 py-2"><EffBadge kind={efficiency(w.cpuReqM, w.cpuUsageM)} /></td>
                </tr>
                {open && (
                  <tr className="bg-muted/5">
                    <td />
                    <td colSpan={5} className="px-3 py-2">
                      <PodsDrill clusterId={clusterId} namespace={namespace} kind={w.kind} name={w.name} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PodsDrill({ clusterId, namespace, kind, name }: { clusterId: string; namespace: string; kind: string; name: string }) {
  const { data, isLoading, isError } = useAllocPods(clusterId, namespace, kind, name, true);
  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (isError) return <div className="text-xs text-red-600">파드 조회 실패</div>;
  const rows = data?.items ?? [];
  if (!rows.length) return <div className="text-xs text-muted-foreground py-1">파드 없음</div>;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/20 text-left text-[11px] text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 font-medium">Pod / Container</th>
            <th className="px-3 py-1.5 font-medium">QoS</th>
            <th className="px-3 py-1.5 font-medium">Node</th>
            <th className="px-3 py-1.5 font-medium">CPU req/lim/use</th>
            <th className="px-3 py-1.5 font-medium">MEM req/lim/use</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <Fragment key={p.name}>
              <tr className="border-t border-border">
                <td className="px-3 py-1.5 font-medium">{p.name}</td>
                <td className="px-3 py-1.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${p.qos === 'Guaranteed' ? 'bg-green-100 text-green-700' : p.qos === 'BestEffort' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                    {p.qos ?? '-'}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-[11px] text-muted-foreground">{p.node ?? '-'}</td>
                <td className="px-3 py-1.5 text-[11px] tabular-nums">{fmtCores(p.cpuReqM)} / {fmtCores(p.cpuLimM)} / {p.cpuUsageM == null ? '—' : fmtCores(p.cpuUsageM)}</td>
                <td className="px-3 py-1.5 text-[11px] tabular-nums">{fmtGi(p.memReqB)} / {fmtGi(p.memLimB)} / {p.memUsageB == null ? '—' : fmtGi(p.memUsageB)}</td>
              </tr>
              {p.containers.map((c) => (
                <tr key={`${p.name}-${c.name}`} className="text-muted-foreground">
                  <td className="px-3 py-1 pl-8 text-[11px]">
                    ↳ {c.name}
                    {!c.hasRequests && <span className="ml-2 text-[10px] text-amber-600">req 미설정</span>}
                  </td>
                  <td />
                  <td />
                  <td className="px-3 py-1 text-[11px] tabular-nums">{fmtCores(c.cpuReqM)} / {fmtCores(c.cpuLimM)} / {c.cpuUsageM == null ? '—' : fmtCores(c.cpuUsageM)}</td>
                  <td className="px-3 py-1 text-[11px] tabular-nums">{fmtGi(c.memReqB)} / {fmtGi(c.memLimB)} / {c.memUsageB == null ? '—' : fmtGi(c.memUsageB)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default K8sAllocationPage;
