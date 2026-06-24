import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Gauge, ChevronRight, ChevronDown, RefreshCw, AlertTriangle,
  Cpu, MemoryStick, Server, Layers, TrendingDown, BarChart3, PackageOpen,
  FileSpreadsheet, ArrowUp, ArrowDown, ChevronsUpDown, HelpCircle,
  LayoutGrid, List,
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, Legend,
} from 'recharts';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { EmptyState, Skeleton, SnapshotProgressCard, SnapshotProgressBar, ExportMenu } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import {
  useAllocNodes, useAllocNamespaces, useAllocWorkloads, useAllocPods,
  useRefreshAllocNode, useRefreshAllocNamespace, useForceAllocRefresh,
} from '@/hooks/useK8sAllocation';
import { buildCsv, downloadCsv } from '@/lib/csv';
import type { AllocNodeRow, AllocNamespaceRow, AllocWorkloadRow } from '@/types';

// ── 컬럼 정렬 공용(테이블 헤더 클릭) ───────────────────────────────────────────
type SortDir = 'asc' | 'desc';
interface SortState { key: string; dir: SortDir }

/** 정렬 가능한 테이블 헤더 셀. 활성 시 ▲/▼, 비활성은 흐린 양방향 아이콘. */
function SortableTh({ label, k, sort, onSort, align = 'left', title }: {
  label: string; k: string; sort: SortState; onSort: (k: string) => void;
  align?: 'left' | 'right'; title?: string;
}) {
  const active = sort.key === k;
  const Icon = !active ? ChevronsUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`px-3 py-2 font-medium ${align === 'right' ? 'text-right' : ''}`} title={title}>
      <button
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-primary' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        {label}
        <Icon className={`w-3 h-3 ${active ? '' : 'opacity-40'}`} />
      </button>
    </th>
  );
}

/** rows 를 accessors[sort.key] 기준 정렬(숫자/문자). 동일값은 name tiebreak. null 은 말단. */
function useTableSort<T extends { name?: string; namespace?: string }>(
  rows: T[], accessors: Record<string, (r: T) => number | string | null>, sort: SortState,
): T[] {
  return useMemo(() => {
    const acc = accessors[sort.key];
    if (!acc) return rows;
    const mul = sort.dir === 'asc' ? 1 : -1;
    const nameOf = (r: T) => (r.name ?? r.namespace ?? '') as string;
    return [...rows].sort((a, b) => {
      const va = acc(a); const vb = acc(b);
      // null/undefined 는 항상 뒤로
      if (va == null && vb == null) return nameOf(a).localeCompare(nameOf(b));
      if (va == null) return 1;
      if (vb == null) return -1;
      let c: number;
      if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
      else c = String(va).localeCompare(String(vb));
      if (c === 0) return nameOf(a).localeCompare(nameOf(b));
      return c * mul;
    });
  }, [rows, accessors, sort]);
}

function nextSort(prev: SortState, k: string, numeric: boolean): SortState {
  if (prev.key === k) return { key: k, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
  return { key: k, dir: numeric ? 'desc' : 'asc' };
}

function CsvButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled}
      title="현재 표를 CSV(엑셀)로 추출"
      className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50">
      <FileSpreadsheet className="w-3.5 h-3.5" /> CSV 내보내기
    </button>
  );
}

function csvCluster(name: string | undefined): string {
  return (name || 'cluster').replace(/[^\w.-]+/g, '-');
}
const today = () => new Date().toISOString().slice(0, 10);

// 자동갱신 간격 옵션 (ms). false = 끔.
const AUTO_OPTIONS: { label: string; ms: number | false }[] = [
  { label: '자동갱신 끔', ms: false },
  { label: '15초', ms: 15_000 },
  { label: '30초', ms: 30_000 },
  { label: '1분', ms: 60_000 },
  { label: '5분', ms: 300_000 },
];

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
const fmtN = (n: number) => n.toLocaleString();

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
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs border ${b.cls}`}>{b.label}</span>;
}

// ── 미터 바: alloc(=track) 대비 request(파랑) + usage(초록) 2줄 ─────────────────
function MeterBar({
  alloc, req, usage, reqDisplay, usageDisplay,
}: {
  alloc: number; req: number; usage: number | null;
  reqDisplay: string; usageDisplay: string | null;
}) {
  const reqPct = Math.min(100, ratio(req, alloc) * 100);
  const usagePct = usage == null ? 0 : Math.min(100, ratio(usage, alloc) * 100);
  const reqColor = ratio(req, alloc) > 1 ? 'bg-red-500' : 'bg-sky-500';
  return (
    <div className="min-w-[150px]">
      <div className="flex items-center gap-1.5">
        <span className="w-7 text-xs text-muted-foreground shrink-0">req</span>
        <div className="flex-1 h-2.5 rounded-full bg-muted/40 overflow-hidden">
          <div className={`h-full ${reqColor}`} style={{ width: `${reqPct}%` }} />
        </div>
        <span className="w-20 text-xs tabular-nums text-right shrink-0">{reqDisplay} · {pctText(req, alloc)}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <span className="w-7 text-xs text-muted-foreground shrink-0">use</span>
        <div className="flex-1 h-2.5 rounded-full bg-muted/40 overflow-hidden">
          {usage != null && <div className="h-full bg-green-500" style={{ width: `${usagePct}%` }} />}
        </div>
        <span className="w-20 text-xs tabular-nums text-right shrink-0 text-muted-foreground">
          {usage == null ? '—' : `${usageDisplay} · ${pctText(usage, alloc)}`}
        </span>
      </div>
    </div>
  );
}

// ── req / use 인라인 셀 (항목명 req/use 패턴에 맞춤) ──────────────────────────────
function ReqUseCell({ req, usage, icon }: { req: string; usage: string | null; icon: 'cpu' | 'mem' }) {
  const Icon = icon === 'cpu' ? Cpu : MemoryStick;
  return (
    <div className="flex items-center gap-1 text-sm tabular-nums whitespace-nowrap">
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span>{req}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-muted-foreground">{usage == null ? '—' : usage}</span>
    </div>
  );
}

type ViewMode = 'nodes' | 'namespaces' | 'ns-ranking';

export function K8sAllocationPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const { data: clusters = [] } = useClusters();
  const [view, setView] = useState<ViewMode>('nodes');
  const [autoMs, setAutoMs] = useState<number | false>(false);

  // 페이지 레벨 observer — computing 진행 표시 + 새로고침. (하위 뷰들과 동일 queryKey 라 캐시 공유)
  const nsQ = useAllocNamespaces(clusterId);
  const nodesQ = useAllocNodes(clusterId);
  const forceRefresh = useForceAllocRefresh(clusterId);
  const computing = nsQ.data?.status === 'computing' || nodesQ.data?.status === 'computing';
  const progSrc = nsQ.data?.status === 'computing' ? nsQ.data : nodesQ.data;
  const isFetching = nsQ.isFetching || nodesQ.isFetching;
  const clusterName = clusters.find((c) => c.id === clusterId)?.name;
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!clusterId && clusters.length > 0) {
      navigate(`/k8s-allocation/${clusters[0].id}`, { replace: true });
    }
  }, [clusterId, clusters, navigate]);

  // 자동 갱신: 켜져 있으면(autoMs) 주기마다 강제 재집계. OFF 면 완료 결과를 그대로 유지(0부터 재집계 없음).
  useEffect(() => {
    if (!autoMs || !clusterId) return;
    const id = setInterval(() => { void forceRefresh(); }, autoMs);
    return () => clearInterval(id);
  }, [autoMs, clusterId, forceRefresh]);

  return (
    <div className="min-h-screen bg-background p-3">
      <div className="flex gap-3 max-w-[1800px] mx-auto">
        <div className="sticky top-3 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => { if (id) navigate(`/k8s-allocation/${id}`); }}
            iconOnly
          />
        </div>

        <div ref={contentRef} className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/cluster-overview" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" /> 클러스터 현황
            </Link>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <Gauge className="w-5 h-5 text-orange-500" /> K8S 자원 관리
            </h1>
            <span className="text-sm text-muted-foreground">노드 여유 대비 request·사용량(slack) 진단</span>

            {clusterId && (
              <div className="ml-auto flex items-center gap-2" data-export-ignore>
                <ExportMenu targetRef={contentRef} filenameBase={`k8s-alloc-${csvCluster(clusterName)}`} />
                <button onClick={() => void forceRefresh()}
                  className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-card">
                  <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> 새로고침
                </button>
                <select
                  value={autoMs === false ? 'off' : String(autoMs)}
                  onChange={(e) => setAutoMs(e.target.value === 'off' ? false : Number(e.target.value))}
                  className="text-sm px-2 py-1 rounded-lg border border-border bg-card text-foreground"
                  title="자동 갱신 간격"
                >
                  {AUTO_OPTIONS.map((o) => (
                    <option key={o.label} value={o.ms === false ? 'off' : String(o.ms)}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* 누적 집계 진행률 — 데이터(부분결과)는 그대로 두고 별도 바로 표시 */}
          {clusterId && computing && (
            <SnapshotProgressBar
              processed={progSrc?.processed ?? 0}
              total={progSrc?.total ?? null}
              progress={progSrc?.progress ?? null}
              label="자원 누적 집계 중"
            />
          )}

          {!clusterId ? (
            <MacCard><EmptyState title="클러스터를 선택하세요" description="좌측에서 클러스터를 고르면 자원 현황이 표시됩니다." /></MacCard>
          ) : (
            <>
              <SummarySection clusterId={clusterId} />

              <div className="inline-flex rounded-xl border border-border bg-card p-1">
                {([
                  ['nodes', '노드별 자원', <Server key="i" className="w-4 h-4" />],
                  ['namespaces', '네임스페이스별 자원', <Layers key="i" className="w-4 h-4" />],
                  ['ns-ranking', '네임스페이스 비효율 랭킹', <BarChart3 key="i" className="w-4 h-4" />],
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

              {view === 'nodes' && <NodesView clusterId={clusterId} clusterName={clusterName} />}
              {view === 'namespaces' && <NamespacesView clusterId={clusterId} clusterName={clusterName} />}
              {view === 'ns-ranking' && <NsRankingView clusterId={clusterId} />}
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
  if (isLoading) return <MacCard title="클러스터 요약" bodyPadding="p-3"><Skeleton className="h-16 w-full" /></MacCard>;
  if (data?.status === 'computing' && !data.items?.length) {
    return (
      <MacCard title="클러스터 요약" bodyPadding="p-3">
        <SnapshotProgressCard processed={data.processed ?? 0} total={data.total ?? null}
          progress={data.progress ?? null} label="자원 집계 중" unit="Pod" />
      </MacCard>
    );
  }
  if (!data) return null;
  const s = data.summary;
  const useEff = s.cpuUsageM == null ? null : ratio(s.cpuUsageM, s.cpuReqM);
  const cpuWasteM = s.cpuUsageM == null ? null : Math.max(0, s.cpuReqM - s.cpuUsageM);
  const memWasteB = s.memUsageB == null ? null : Math.max(0, s.memReqB - s.memUsageB);
  // 전체 기준 할당 가용(여유) = allocatable − request → 추가로 스케줄 가능한 자원량.
  const cpuAvailM = Math.max(0, s.cpuAllocM - s.cpuReqM);
  const memAvailB = Math.max(0, s.memAllocB - s.memReqB);

  return (
    <MacCard title="클러스터 요약" bodyPadding="p-3">
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="노드" value={fmtN(s.nodeCount)} icon={<Server className="w-3.5 h-3.5" />} />
        <Stat label="네임스페이스" value={fmtN(s.namespaceCount)} icon={<Layers className="w-3.5 h-3.5" />} />
        <Stat label="파드 (활성)" value={fmtN(s.podCount)} icon={<Cpu className="w-3.5 h-3.5" />} />
        <Stat label="CPU 할당효율" value={pctText(s.cpuReqM, s.cpuAllocM)}
          sub={`req ${fmtCores(s.cpuReqM)} / alloc ${fmtCores(s.cpuAllocM)}`}
          warn={ratio(s.cpuReqM, s.cpuAllocM) < 0.5}
          help={
            <div className="space-y-1.5">
              <p className="font-semibold text-foreground">CPU 할당효율 (Allocation Efficiency)</p>
              <p><b>= Request ÷ Allocatable × 100</b></p>
              <p>노드의 할당 가능 CPU 중 파드들이 <b>request로 예약</b>한 비율입니다.</p>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                <li>100% 초과 → 오버커밋 (스케줄 불가 위험)</li>
                <li>50% 미만 → 할당 여유 많음 (주황 경고)</li>
                <li>50–90% → 적정 범위</li>
              </ul>
            </div>
          }
        />
        <Stat label="MEM 할당효율" value={pctText(s.memReqB, s.memAllocB)}
          sub={`req ${fmtGi(s.memReqB)} / alloc ${fmtGi(s.memAllocB)}`}
          help={
            <div className="space-y-1.5">
              <p className="font-semibold text-foreground">MEM 할당효율 (Allocation Efficiency)</p>
              <p><b>= Request ÷ Allocatable × 100</b></p>
              <p>노드의 할당 가능 메모리 중 파드들이 <b>request로 예약</b>한 비율입니다.</p>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                <li>100% 초과 → 오버커밋 (OOM 위험)</li>
                <li>50% 미만 → 메모리 여유 많음</li>
              </ul>
            </div>
          }
        />
        <Stat label="CPU 사용효율" value={useEff == null ? '—' : pctText(s.cpuUsageM ?? 0, s.cpuReqM)}
          sub={s.cpuUsageM == null ? '드릴다운에서 확인' : `use ${fmtCores(s.cpuUsageM)}`}
          warn={useEff != null && useEff < 0.3}
          help={
            <div className="space-y-1.5">
              <p className="font-semibold text-foreground">CPU 사용효율 (Usage Efficiency)</p>
              <p><b>= 실사용량 ÷ Request × 100</b></p>
              <p>request로 예약한 CPU 중 실제로 <b>사용 중인</b> 비율입니다.</p>
              <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                <li>30% 미만 → request 과대 설정 (낭비, 주황 경고)</li>
                <li>105% 초과 → 실사용이 request 초과 (스로틀 위험)</li>
                <li>30–100% → 적정 범위</li>
              </ul>
              <p className="text-muted-foreground">※ 메트릭 서버 없으면 표시 불가</p>
            </div>
          }
        />
      </div>

      {/* Pod 스케줄 가능 수 계산기 (MEM 할당효율 아래) */}
      <PodScheduleCalc clusterId={clusterId} />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm border-t border-border pt-2">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <PackageOpen className="w-4 h-4 text-emerald-500" /> 할당 가용(여유 = alloc − req):
        </span>
        <span className="font-semibold tabular-nums text-emerald-600">CPU {fmtCores(cpuAvailM)} 코어</span>
        <span className="font-semibold tabular-nums text-emerald-600">MEM {fmtGi(memAvailB)}</span>
        <span className="text-xs text-muted-foreground">· 추가 스케줄 가능한 자원 (request 미반영분)</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm border-t border-border pt-2">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <TrendingDown className="w-4 h-4 text-amber-500" /> 추정 낭비(slack=req−use):
        </span>
        <span className="font-semibold tabular-nums">CPU {cpuWasteM == null ? '—' : `${fmtCores(cpuWasteM)} 코어`}</span>
        <span className="font-semibold tabular-nums">MEM {memWasteB == null ? '—' : fmtGi(memWasteB)}</span>
        {s.noRequestPods > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700 border border-amber-300">
            <AlertTriangle className="w-3 h-3" /> request 미설정 파드 {fmtN(s.noRequestPods)}개
          </span>
        )}
        {data.partial && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-sky-100 text-sky-700 border border-sky-300">
            <RefreshCw className="w-3 h-3 animate-spin" /> 누적 집계 중 — 부분 결과(완료 시 확정)
          </span>
        )}
        {data.podUsageSkipped && (
          <span className="text-xs text-muted-foreground">· 메트릭 서버 미가용 — 사용량(use) 미표시</span>
        )}
      </div>
    </MacCard>
  );
}

// ── Pod 스케줄 가능 수 계산기 ──────────────────────────────────────────────────
// "CPU x코어 / MEM yGi 인 Pod 를 현재 여유(allocatable−request)로 몇 개 스케줄 가능한가"
function PodScheduleCalc({ clusterId }: { clusterId: string }) {
  const { data } = useAllocNodes(clusterId);
  const [cpu, setCpu] = useState('0.5');   // 코어
  const [mem, setMem] = useState('1');     // Gi

  const result = useMemo(() => {
    const reqCpuM = Math.round((parseFloat(cpu) || 0) * 1000);
    const reqMemB = Math.round((parseFloat(mem) || 0) * 1024 ** 3);
    if (reqCpuM <= 0 && reqMemB <= 0) return null;
    const nodes = (data?.items ?? []).filter((n) => !n.unschedulable);
    let total = 0;
    const per: { name: string; fit: number; limit: 'cpu' | 'mem' | 'pods' }[] = [];
    for (const n of nodes) {
      const freeCpu = Math.max(0, n.cpuAllocM - n.cpuReqM);
      const freeMem = Math.max(0, n.memAllocB - n.memReqB);
      // max-pods(allocatable pods) 제약 — 0이면 미상 → 비제약
      const podsFree = n.podsAllocatable > 0 ? Math.max(0, n.podsAllocatable - n.podCount) : Infinity;
      const byCpu = reqCpuM > 0 ? Math.floor(freeCpu / reqCpuM) : Infinity;
      const byMem = reqMemB > 0 ? Math.floor(freeMem / reqMemB) : Infinity;
      const fit = Math.min(byCpu, byMem, podsFree);
      if (Number.isFinite(fit) && fit > 0) {
        // 어떤 축이 한도를 정했는지(동률이면 pods>cpu>mem 순으로 표기)
        const limit: 'cpu' | 'mem' | 'pods' = podsFree === fit ? 'pods' : byCpu === fit ? 'cpu' : 'mem';
        total += fit;
        per.push({ name: n.name, fit, limit });
      }
    }
    per.sort((a, b) => b.fit - a.fit);
    return { total, per, nodeCount: nodes.length };
  }, [data, cpu, mem]);

  const LIMIT_LABEL: Record<'cpu' | 'mem' | 'pods', string> = { cpu: 'CPU', mem: 'MEM', pods: 'max-pods' };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm border-t border-border pt-2">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Cpu className="w-4 h-4 text-sky-500" /> Pod 스케줄 가능 수:
      </span>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        CPU
        <input type="number" min="0" step="0.1" value={cpu} onChange={(e) => setCpu(e.target.value)}
          className="w-16 px-1.5 py-0.5 rounded border border-border bg-card text-foreground tabular-nums" /> 코어
      </label>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        MEM
        <input type="number" min="0" step="0.5" value={mem} onChange={(e) => setMem(e.target.value)}
          className="w-16 px-1.5 py-0.5 rounded border border-border bg-card text-foreground tabular-nums" /> Gi
      </label>
      {result ? (
        <>
          {/* 결과 + 마우스오버 시 배치 가능 노드 박스 */}
          <span className="relative group cursor-help">
            <span className="font-semibold tabular-nums text-sky-600 underline decoration-dotted">≈ {fmtN(result.total)}개</span>
            {result.per.length > 0 && (
              <div data-export-ignore
                className="hidden group-hover:block absolute left-0 top-full mt-1 z-50 w-72 max-h-72 overflow-auto
                  rounded-lg border border-border bg-card shadow-lg p-2 text-xs">
                <div className="text-muted-foreground mb-1">배치 가능 노드 (alloc−req · max-pods 기준)</div>
                {result.per.slice(0, 30).map((p) => (
                  <div key={p.name} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="font-mono truncate" title={p.name}>{p.name}</span>
                    <span className="shrink-0 tabular-nums">
                      <b className="text-sky-600">{p.fit}</b>
                      <span className="ml-1 text-muted-foreground">제약:{LIMIT_LABEL[p.limit]}</span>
                    </span>
                  </div>
                ))}
                {result.per.length > 30 && (
                  <div className="text-muted-foreground pt-1">+{result.per.length - 30}개 노드 더…</div>
                )}
              </div>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            (schedulable 노드 {result.per.length}/{result.nodeCount} · CPU/MEM/max-pods 반영 · 마우스오버로 노드별 보기)
          </span>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">CPU/MEM 요청량을 입력하세요.</span>
      )}
    </div>
  );
}

function StatTooltip({ children }: { children: ReactNode }) {
  return (
    <span className="relative group inline-flex items-center ml-0.5 cursor-help">
      <HelpCircle className="w-3 h-3 text-muted-foreground/60 hover:text-muted-foreground" />
      <div
        data-export-ignore
        className="hidden group-hover:block absolute left-0 top-full mt-1 z-50 w-64
          rounded-lg border border-border bg-card shadow-lg p-2.5 text-xs leading-relaxed text-foreground whitespace-normal"
      >
        {children}
      </div>
    </span>
  );
}

function Stat({ label, value, sub, icon, warn, help }: { label: string; value: string; sub?: string; icon?: ReactNode; warn?: boolean; help?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/50 px-2.5 py-2">
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {icon}{label}
        {help && <StatTooltip>{help}</StatTooltip>}
      </div>
      <div className={`text-xl font-semibold leading-tight mt-0.5 ${warn ? 'text-amber-600' : ''}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5 truncate" title={sub}>{sub}</div>}
    </div>
  );
}

// ── 노드 게이지 행 (카드 뷰에서 사용) ─────────────────────────────────────────────
function GaugeRow({ label, alloc, req, usage }: { label: string; alloc: number; req: number; usage: number | null }) {
  const reqPct = Math.min(100, ratio(req, alloc) * 100);
  const usePct = usage == null ? 0 : Math.min(100, ratio(usage, alloc) * 100);
  const over = ratio(req, alloc) > 1;
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground mb-0.5">
        <span>{label}</span>
        <span className="tabular-nums">
          req <b className={over ? 'text-red-500' : 'text-sky-600'}>{pctText(req, alloc)}</b>
          {usage != null && <> · use <b className="text-green-600">{pctText(usage, alloc)}</b></>}
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-muted/40 overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${over ? 'bg-red-400' : 'bg-sky-400/70'}`} style={{ width: `${reqPct}%` }} />
        {usage != null && <div className="absolute inset-y-0 left-0 bg-green-500" style={{ width: `${usePct}%`, opacity: 0.85 }} />}
      </div>
    </div>
  );
}

/** 노드 수에 따라 한 행에 표시할 컬럼 수를 동적으로 계산 */
function calcGridCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  if (count <= 9) return 3;
  if (count <= 12) return 4;
  if (count <= 16) return 4;
  if (count <= 20) return 5;
  return 6;
}

// ── 네임스페이스 비효율 랭킹 탭 ──────────────────────────────────────────────────
type ChartMetric = 'cpu' | 'mem';

function NsRankingView({ clusterId }: { clusterId: string }) {
  const nsQ = useAllocNamespaces(clusterId);
  const [metric, setMetric] = useState<ChartMetric>('cpu');

  const nsChart = useMemo(() => {
    const items = (nsQ.data?.items ?? []).map((n) => {
      const req = metric === 'cpu' ? n.cpuReqM / 1000 : n.memReqB / 1024 ** 3;
      const useRaw = metric === 'cpu' ? n.cpuUsageM : n.memUsageB;
      const use = useRaw == null ? null : (metric === 'cpu' ? useRaw / 1000 : useRaw / 1024 ** 3);
      const slack = use == null ? null : Math.max(0, req - use);
      return { namespace: n.namespace, req: +req.toFixed(2), use: use == null ? null : +use.toFixed(2), slack };
    });
    items.sort((a, b) => {
      if (a.slack != null && b.slack != null) return b.slack - a.slack;
      return b.req - a.req;
    });
    return items.slice(0, 15);
  }, [nsQ.data, metric]);

  const unit = metric === 'cpu' ? ' 코어' : ' Gi';

  return (
    <MacCard title="네임스페이스 비효율 랭킹 (Top 15 · req vs 실사용, 간격이 클수록 낭비)" bodyPadding="p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm text-muted-foreground">기준</span>
        {(['cpu', 'mem'] as ChartMetric[]).map((m) => (
          <button key={m} onClick={() => setMetric(m)}
            className={`px-2.5 py-1 rounded-lg border text-sm ${metric === m ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}>
            {m === 'cpu' ? 'CPU' : 'MEM'}
          </button>
        ))}
        <span className="text-xs text-muted-foreground ml-1">비효율(req−use) 내림차순</span>
      </div>
      {nsQ.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !nsChart.length ? (
        <EmptyState title="데이터 없음" description="표시할 네임스페이스가 없습니다." />
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(280, nsChart.length * 32)}>
          <BarChart data={nsChart} layout="vertical" margin={{ left: 12, right: 24, top: 4, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
            <XAxis type="number" tick={{ fontSize: 12 }} unit={unit} />
            <YAxis type="category" dataKey="namespace" width={150} tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(v: number, name) => [`${v}${unit}`, name === 'req' ? 'request' : '실사용']}
              contentStyle={{ fontSize: 13, borderRadius: 8 }}
            />
            <Legend formatter={(v) => (v === 'req' ? 'request' : '실사용')} wrapperStyle={{ fontSize: 13 }} />
            <Bar dataKey="req" name="req" fill="#7dd3fc" radius={[0, 4, 4, 0]}>
              {nsChart.map((d, i) => (
                <Cell key={i} fill={d.use != null && d.req > 0 && d.use / d.req < 0.3 ? '#fbbf24' : '#7dd3fc'} />
              ))}
            </Bar>
            <Bar dataKey="use" name="use" fill="#22c55e" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}
      {nsQ.data && !nsQ.data.metricsAvailable && (
        <div className="text-sm text-muted-foreground mt-2">※ 사용량(use) 미가용 — request 기준만 표시됩니다.</div>
      )}
    </MacCard>
  );
}

// ── 노드 뷰 ──────────────────────────────────────────────────────────────────
const NODE_ACCESSORS: Record<string, (r: AllocNodeRow) => number | string | null> = {
  name: (r) => r.name,
  cpuReqM: (r) => r.cpuReqM,
  memReqB: (r) => r.memReqB,
  cpuSlackM: (r) => r.cpuSlackM,
  memSlackB: (r) => r.memSlackB,
  podCount: (r) => r.podCount,
};
function NodesView({ clusterId, clusterName }: { clusterId: string; clusterName?: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useAllocNodes(clusterId);
  const refreshNode = useRefreshAllocNode(clusterId);
  const [sort, setSort] = useState<SortState>({ key: 'cpuSlackM', dir: 'desc' });
  const [viewStyle, setViewStyle] = useState<'table' | 'card'>('table');
  const onSort = (k: string) => setSort((p) => nextSort(p, k, k !== 'name'));

  const rows = useTableSort(data?.items ?? [], NODE_ACCESSORS, sort);

  const exportCsv = () => {
    const headers = ['Node', 'Roles', 'Cordoned', 'Pods',
      'CPU 할당', 'CPU 요청', 'CPU 사용', 'CPU 가용',
      'MEM 할당', 'MEM 요청', 'MEM 사용', 'MEM 가용'];
    const data2 = rows.map((n) => [
      n.name, n.roles.join(' '), n.unschedulable ? 'Y' : '',
      n.podCount,
      n.cpuAllocDisplay, n.cpuReqDisplay, n.cpuUsageDisplay ?? '', fmtCores(n.cpuSlackM),
      n.memAllocDisplay, n.memReqDisplay, n.memUsageDisplay ?? '', fmtGi(n.memSlackB),
    ]);
    downloadCsv(`k8s-alloc-nodes-${csvCluster(clusterName)}-${today()}.csv`, buildCsv(headers, data2));
  };

  if (isLoading) return <MacCard title="노드별 자원" bodyPadding="p-3"><Skeleton className="h-40 w-full" /></MacCard>;
  if (isError) return <MacCard title="노드별 자원" bodyPadding="p-3"><EmptyState title="조회 실패" description={(error as Error)?.message ?? '노드 자원을 불러오지 못했습니다.'} /></MacCard>;
  if (data?.status === 'computing' && !rows.length) {
    return (
      <MacCard title="노드별 자원" bodyPadding="p-3">
        <SnapshotProgressCard processed={data.processed ?? 0} total={data.total ?? null}
          progress={data.progress ?? null} label="자원 집계 중" unit="Pod" />
      </MacCard>
    );
  }
  if (!rows.length) return <MacCard title="노드별 자원" bodyPadding="p-3"><EmptyState title="노드 없음" description="표시할 노드가 없습니다." /></MacCard>;

  const gridCols = calcGridCols(rows.length);

  return (
    <MacCard title="노드별 자원" bodyPadding="p-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          {/* 뷰 전환 토글 */}
          <div className="inline-flex rounded-lg border border-border bg-muted/20 p-0.5">
            <button
              onClick={() => setViewStyle('table')}
              title="테이블 뷰"
              className={`p-1.5 rounded-md ${viewStyle === 'table' ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewStyle('card')}
              title="카드 뷰"
              className={`p-1.5 rounded-md ${viewStyle === 'card' ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
          {viewStyle === 'table' && <span className="text-xs text-muted-foreground">열 머리글을 클릭해 정렬</span>}
          {viewStyle === 'card' && <span className="text-xs text-muted-foreground">노드 {rows.length}개 · {gridCols}열 자동 배치</span>}
        </div>
        <div className="flex items-center gap-3">
          <CsvButton onClick={exportCsv} disabled={!rows.length} />
          <button onClick={() => refetch()} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>
      </div>

      {/* 카드 뷰 */}
      {viewStyle === 'card' && (
        <div className="p-3">
          <div
            style={{ display: 'grid', gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
            className="gap-2"
          >
            {rows.map((n: AllocNodeRow) => (
              <div key={n.name} className="rounded-lg border border-border bg-card/50 p-2.5">
                <div className="flex items-center justify-between mb-1">
                  <div className="font-medium text-sm truncate" title={n.name}>{n.name}</div>
                  <div className="flex items-center gap-1 shrink-0 ml-1.5">
                    <span className="text-xs text-muted-foreground">{n.roles.join(',')}</span>
                    {n.unschedulable && <span className="text-xs text-amber-600">cordoned</span>}
                    <button
                      onClick={() => refreshNode.mutate(n.name)}
                      title="이 노드만 새로고침"
                      className="text-muted-foreground hover:text-primary"
                    >
                      <RefreshCw className={`w-3 h-3 ${refreshNode.isPending && refreshNode.variables === n.name ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <GaugeRow label="CPU" alloc={n.cpuAllocM} req={n.cpuReqM} usage={n.cpuUsageM} />
                  <GaugeRow label="MEM" alloc={n.memAllocB} req={n.memReqB} usage={n.memUsageB} />
                </div>
                <div className="flex justify-between text-xs text-emerald-600 mt-1.5 tabular-nums">
                  <span>여유 {fmtCores(n.cpuSlackM)}</span>
                  <span>여유 {fmtGi(n.memSlackB)}</span>
                  <span className="text-muted-foreground">{n.podCount}p</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 테이블 뷰 */}
      {viewStyle === 'table' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/20 text-left text-xs text-muted-foreground">
              <tr>
                <SortableTh label="Node" k="name" sort={sort} onSort={onSort} />
                <SortableTh label="CPU (req)" k="cpuReqM" sort={sort} onSort={onSort} title="CPU 요청량 기준 정렬" />
                <SortableTh label="MEM (req)" k="memReqB" sort={sort} onSort={onSort} title="MEM 요청량 기준 정렬" />
                <SortableTh label="CPU 가용 / 할당" k="cpuSlackM" sort={sort} onSort={onSort} align="right" title="할당 가용(slack=alloc−req) 기준 정렬" />
                <SortableTh label="MEM 가용 / 할당" k="memSlackB" sort={sort} onSort={onSort} align="right" title="할당 가용(slack=alloc−req) 기준 정렬" />
                <SortableTh label="Pods" k="podCount" sort={sort} onSort={onSort} align="right" />
              </tr>
            </thead>
            <tbody>
              {rows.map((n: AllocNodeRow) => (
                <tr key={n.name} className="border-t border-border align-middle hover:bg-muted/10">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{n.name}</span>
                      <button
                        onClick={() => refreshNode.mutate(n.name)}
                        title="이 노드만 새로고침"
                        className="text-muted-foreground hover:text-primary shrink-0"
                      >
                        <RefreshCw className={`w-3 h-3 ${refreshNode.isPending && refreshNode.variables === n.name ? 'animate-spin' : ''}`} />
                      </button>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {n.roles.join(', ')}{n.unschedulable && <span className="text-amber-600"> · cordoned</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <MeterBar alloc={n.cpuAllocM} req={n.cpuReqM} usage={n.cpuUsageM}
                      reqDisplay={n.cpuReqDisplay} usageDisplay={n.cpuUsageDisplay} />
                  </td>
                  <td className="px-3 py-2">
                    <MeterBar alloc={n.memAllocB} req={n.memReqB} usage={n.memUsageB}
                      reqDisplay={n.memReqDisplay} usageDisplay={n.memUsageDisplay} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <div className="text-emerald-600 font-medium">{fmtCores(n.cpuSlackM)}</div>
                    <div className="text-xs text-muted-foreground">/ {fmtCores(n.cpuAllocM)}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <div className="text-emerald-600 font-medium">{fmtGi(n.memSlackB)}</div>
                    <div className="text-xs text-muted-foreground">/ {fmtGi(n.memAllocB)}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{n.podCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </MacCard>
  );
}

// ── 네임스페이스 뷰 (드릴다운) ───────────────────────────────────────────────────
const NS_ACCESSORS: Record<string, (r: AllocNamespaceRow) => number | string | null> = {
  namespace: (r) => r.namespace,
  podCount: (r) => r.podCount,
  workloadCount: (r) => r.workloadCount,
  cpuReqM: (r) => r.cpuReqM,
  memReqB: (r) => r.memReqB,
  eff: (r) => (r.cpuUsageM == null ? null : r.cpuUsageM / Math.max(1, r.cpuReqM)),
};
function NamespacesView({ clusterId, clusterName }: { clusterId: string; clusterName?: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useAllocNamespaces(clusterId);
  const refreshNs = useRefreshAllocNamespace(clusterId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>({ key: 'cpuReqM', dir: 'desc' });
  const onSort = (k: string) => setSort((p) => nextSort(p, k, k !== 'namespace'));

  const toggle = (ns: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    return next;
  });

  const rows = useTableSort(data?.items ?? [], NS_ACCESSORS, sort);

  const exportCsv = () => {
    const headers = ['Namespace', 'Pods', 'Workloads', 'req미설정',
      'CPU 요청', 'CPU 사용', 'MEM 요청', 'MEM 사용', '효율'];
    const effLabel = (r: AllocNamespaceRow) => {
      const k = efficiency(r.cpuReqM, r.cpuUsageM);
      return k ? EFF_BADGE[k].label : '';
    };
    const data2 = rows.map((ns) => [
      ns.namespace, ns.podCount, ns.workloadCount, ns.noRequestPods,
      ns.cpuReqDisplay, ns.cpuUsageDisplay ?? '', ns.memReqDisplay, ns.memUsageDisplay ?? '', effLabel(ns),
    ]);
    downloadCsv(`k8s-alloc-namespaces-${csvCluster(clusterName)}-${today()}.csv`, buildCsv(headers, data2));
  };

  if (isLoading) return <MacCard title="네임스페이스별 자원" bodyPadding="p-3"><Skeleton className="h-40 w-full" /></MacCard>;
  if (isError) return <MacCard title="네임스페이스별 자원" bodyPadding="p-3"><EmptyState title="조회 실패" description={(error as Error)?.message ?? '불러오지 못했습니다.'} /></MacCard>;
  if (data?.status === 'computing' && !rows.length) {
    return (
      <MacCard title="네임스페이스별 자원" bodyPadding="p-3">
        <SnapshotProgressCard processed={data.processed ?? 0} total={data.total ?? null}
          progress={data.progress ?? null} label="자원 집계 중" unit="Pod" />
      </MacCard>
    );
  }
  if (!rows.length) return <MacCard title="네임스페이스별 자원" bodyPadding="p-3"><EmptyState title="데이터 없음" description="표시할 네임스페이스가 없습니다." /></MacCard>;

  return (
    <MacCard title={`네임스페이스별 자원 (${fmtN(rows.length)}개)`} bodyPadding="p-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs text-muted-foreground">열 머리글을 클릭해 정렬</span>
        <div className="flex items-center gap-3">
          <CsvButton onClick={exportCsv} disabled={!rows.length} />
          <button onClick={() => refetch()} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/20 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-2 py-2 font-medium w-7" />
              <SortableTh label="Namespace" k="namespace" sort={sort} onSort={onSort} />
              <SortableTh label="Pods" k="podCount" sort={sort} onSort={onSort} align="right" />
              <SortableTh label="Workloads" k="workloadCount" sort={sort} onSort={onSort} align="right" />
              <SortableTh label="CPU req/use" k="cpuReqM" sort={sort} onSort={onSort} title="CPU 요청량 기준 정렬" />
              <SortableTh label="MEM req/use" k="memReqB" sort={sort} onSort={onSort} title="MEM 요청량 기준 정렬" />
              <SortableTh label="효율" k="eff" sort={sort} onSort={onSort} title="사용/요청 비율 기준 정렬" />
            </tr>
          </thead>
          <tbody>
            {rows.map((ns: AllocNamespaceRow) => {
              const open = expanded.has(ns.namespace);
              return (
                <Fragment key={ns.namespace}>
                  <tr className="border-t border-border hover:bg-muted/10 cursor-pointer" onClick={() => toggle(ns.namespace)}>
                    <td className="px-2 py-2 text-muted-foreground">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                    <td className="px-2 py-2 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {ns.namespace}
                        <button
                          onClick={(e) => { e.stopPropagation(); refreshNs.mutate(ns.namespace); }}
                          title="이 네임스페이스만 새로고침"
                          className="text-muted-foreground hover:text-primary shrink-0"
                        >
                          <RefreshCw className={`w-3 h-3 ${refreshNs.isPending && refreshNs.variables === ns.namespace ? 'animate-spin' : ''}`} />
                        </button>
                      </span>
                      {ns.noRequestPods > 0 && <span className="ml-2 text-xs text-amber-600">· req미설정 {ns.noRequestPods}</span>}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{ns.podCount}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{ns.workloadCount}</td>
                    <td className="px-2 py-2"><ReqUseCell req={ns.cpuReqDisplay} usage={ns.cpuUsageDisplay} icon="cpu" /></td>
                    <td className="px-2 py-2"><ReqUseCell req={ns.memReqDisplay} usage={ns.memUsageDisplay} icon="mem" /></td>
                    <td className="px-2 py-2"><EffBadge kind={efficiency(ns.cpuReqM, ns.cpuUsageM)} /></td>
                  </tr>
                  {open && (
                    <tr className="bg-muted/5">
                      <td />
                      <td colSpan={6} className="px-2 py-2">
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
  if (isError) return <div className="text-sm text-red-600">워크로드 조회 실패</div>;
  const rows = data?.items ?? [];
  if (!rows.length) return <div className="text-sm text-muted-foreground py-1">워크로드 없음</div>;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/20 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium w-7" />
            <th className="px-2 py-1.5 font-medium">Workload</th>
            <th className="px-2 py-1.5 font-medium text-right">Pods</th>
            <th className="px-2 py-1.5 font-medium">CPU req/use</th>
            <th className="px-2 py-1.5 font-medium">MEM req/use</th>
            <th className="px-2 py-1.5 font-medium">효율</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => {
            const k = key(w);
            const open = expanded.has(k);
            return (
              <Fragment key={k}>
                <tr className="border-t border-border hover:bg-muted/10 cursor-pointer" onClick={() => toggle(k)}>
                  <td className="px-2 py-1.5 text-muted-foreground">{open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</td>
                  <td className="px-2 py-1.5">
                    <span className="text-xs uppercase text-muted-foreground mr-1.5">{w.kind}</span>
                    <span className="font-medium">{w.name}</span>
                    {w.noRequestPods > 0 && <span className="ml-2 text-xs text-amber-600">· req미설정 {w.noRequestPods}</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{w.podCount}</td>
                  <td className="px-2 py-1.5"><ReqUseCell req={fmtCores(w.cpuReqM)} usage={w.cpuUsageM == null ? null : fmtCores(w.cpuUsageM)} icon="cpu" /></td>
                  <td className="px-2 py-1.5"><ReqUseCell req={fmtGi(w.memReqB)} usage={w.memUsageB == null ? null : fmtGi(w.memUsageB)} icon="mem" /></td>
                  <td className="px-2 py-1.5"><EffBadge kind={efficiency(w.cpuReqM, w.cpuUsageM)} /></td>
                </tr>
                {open && (
                  <tr className="bg-muted/5">
                    <td />
                    <td colSpan={5} className="px-2 py-1.5">
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
  if (isError) return <div className="text-sm text-red-600">파드 조회 실패</div>;
  const rows = data?.items ?? [];
  if (!rows.length) return <div className="text-sm text-muted-foreground py-1">파드 없음</div>;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/20 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">Pod / Container</th>
            <th className="px-2 py-1.5 font-medium">QoS</th>
            <th className="px-2 py-1.5 font-medium">Node</th>
            <th className="px-2 py-1.5 font-medium">CPU req/lim/use</th>
            <th className="px-2 py-1.5 font-medium">MEM req/lim/use</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <Fragment key={p.name}>
              <tr className="border-t border-border">
                <td className="px-2 py-1.5 font-medium">{p.name}</td>
                <td className="px-2 py-1.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${p.qos === 'Guaranteed' ? 'bg-green-100 text-green-700' : p.qos === 'BestEffort' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                    {p.qos ?? '-'}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-xs text-muted-foreground">{p.node ?? '-'}</td>
                <td className="px-2 py-1.5 text-xs tabular-nums">{fmtCores(p.cpuReqM)} / {fmtCores(p.cpuLimM)} / {p.cpuUsageM == null ? '—' : fmtCores(p.cpuUsageM)}</td>
                <td className="px-2 py-1.5 text-xs tabular-nums">{fmtGi(p.memReqB)} / {fmtGi(p.memLimB)} / {p.memUsageB == null ? '—' : fmtGi(p.memUsageB)}</td>
              </tr>
              {p.containers.map((c) => (
                <tr key={`${p.name}-${c.name}`} className="text-muted-foreground">
                  <td className="px-2 py-1 pl-7 text-xs">
                    ↳ {c.name}
                    {!c.hasRequests && <span className="ml-2 text-amber-600">req 미설정</span>}
                  </td>
                  <td />
                  <td />
                  <td className="px-2 py-1 text-xs tabular-nums">{fmtCores(c.cpuReqM)} / {fmtCores(c.cpuLimM)} / {c.cpuUsageM == null ? '—' : fmtCores(c.cpuUsageM)}</td>
                  <td className="px-2 py-1 text-xs tabular-nums">{fmtGi(c.memReqB)} / {fmtGi(c.memLimB)} / {c.memUsageB == null ? '—' : fmtGi(c.memUsageB)}</td>
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
