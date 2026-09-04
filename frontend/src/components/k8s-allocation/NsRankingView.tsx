// 네임스페이스 비효율 랭킹 — req vs 실사용 바 차트(간격이 클수록 낭비).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, CartesianGrid, Cell, Legend,
} from 'recharts';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, Skeleton, SnapshotProgressCard } from '@/components/common';
import { useAllocNamespaces } from '@/hooks/useK8sAllocation';
import { fmtN } from './format';
import { PageSizeSelect, Pager, SearchInput } from './primitives';
import { paginate } from './tableSort';

type ChartMetric = 'cpu' | 'mem';
const RANK_PAGE_SIZES = [10, 15, 25, 50];

export function NsRankingView({ clusterId }: { clusterId: string }) {
  const nsQ = useAllocNamespaces(clusterId);
  const { isError, error } = nsQ;
  const [metric, setMetric] = useState<ChartMetric>('cpu');
  const [q, setQ] = useState('');
  const [pageSize, setPageSize] = useState(15);
  const [page, setPage] = useState(1);
  const computing = nsQ.data?.status === 'computing';

  const nsRanked = useMemo(() => {
    const s = q.trim().toLowerCase();
    const src = (nsQ.data?.items ?? []).filter((n) => !s || n.namespace.toLowerCase().includes(s));
    const items = src.map((n) => {
      const req = metric === 'cpu' ? n.cpuReqM / 1000 : n.memReqB / 1024 ** 3;
      const useRaw = metric === 'cpu' ? n.cpuUsageM : n.memUsageB;
      const use = useRaw == null ? null : (metric === 'cpu' ? useRaw / 1000 : useRaw / 1024 ** 3);
      const slack = use == null ? null : Math.max(0, req - use);
      return { namespace: n.namespace, req: +req.toFixed(2), use: use == null ? null : +use.toFixed(2), slack };
    });
    // 단일 정렬키(slack, 없으면 -Infinity)로 비교해야 추이성이 보장된다.
    const sortKey = (x: (typeof items)[number]) => x.slack ?? -Infinity;
    items.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (ka !== kb) return kb - ka;
      return b.req - a.req;
    });
    return items;
  }, [nsQ.data, metric, q]);

  const { totalPages, safePage, pageRows: nsChart } = paginate(nsRanked, page, pageSize);
  // 기준/검색/페이지당 변경 시 1페이지로 리셋.
  useEffect(() => { setPage(1); }, [metric, q, pageSize]);

  // 차트 높이는 마지막 ready 행 수 기준 — 집계 중 부분 결과가 늘어날 때마다 박스가 커지지 않게.
  const readyRowsRef = useRef(0);
  if (!computing) readyRowsRef.current = nsChart.length;
  const chartRows = computing && readyRowsRef.current ? readyRowsRef.current : nsChart.length;

  const unit = metric === 'cpu' ? ' 코어' : ' Gi';

  let body: React.ReactNode;
  if (isError && !nsQ.data) {
    // 조회 실패를 "데이터 없음" 과 구분 — 안 그러면 502 가 빈 클러스터처럼 보인다.
    body = <EmptyState title="조회 실패" description={(error as Error)?.message ?? '네임스페이스 자원을 불러오지 못했습니다.'} />;
  } else if (computing && !(nsQ.data?.items?.length)) {
    body = (
      <SnapshotProgressCard processed={nsQ.data?.processed ?? 0} total={nsQ.data?.total ?? null}
        progress={nsQ.data?.progress ?? null} label="자원 집계 중" unit="Pod" />
    );
  } else if (nsQ.isLoading && !nsQ.data) {
    body = <Skeleton className="h-64 w-full" />;
  } else if (!nsChart.length) {
    body = <EmptyState title="데이터 없음" description={q.trim() ? `'${q}' 와 일치하는 네임스페이스가 없습니다.` : '표시할 네임스페이스가 없습니다.'} />;
  } else {
    body = (
      <ResponsiveContainer width="100%" height={Math.max(280, chartRows * 32)}>
        <BarChart data={nsChart} layout="vertical" margin={{ left: 12, right: 24, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
          <XAxis type="number" tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} unit={unit} />
          <YAxis type="category" dataKey="namespace" width={150} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} />
          <RechartsTooltip
            formatter={(v: number, name) => [`${v}${unit}`, name === 'req' ? 'request' : '실사용']}
            contentStyle={{ fontSize: 13, borderRadius: 8, background: 'hsl(var(--card))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border))' }}
          />
          <Legend formatter={(v) => (v === 'req' ? 'request' : '실사용')} wrapperStyle={{ fontSize: 13 }} />
          <Bar dataKey="req" name="req" fill="hsl(var(--chart-1))" radius={[0, 4, 4, 0]}>
            {nsChart.map((d, i) => (
              <Cell key={i} fill={d.use != null && d.req > 0 && d.use / d.req < 0.3 ? 'hsl(var(--status-warning))' : 'hsl(var(--chart-1))'} />
            ))}
          </Bar>
          <Bar dataKey="use" name="use" fill="hsl(var(--chart-2))" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <MacCard title={`네임스페이스 비효율 랭킹 (${fmtN(nsRanked.length)}개 · req vs 실사용, 간격이 클수록 낭비)`} bodyPadding="p-3">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span className="text-sm text-muted-foreground">기준</span>
        {(['cpu', 'mem'] as ChartMetric[]).map((m) => (
          <button key={m} type="button" onClick={() => setMetric(m)}
            className={`px-2.5 py-1 rounded-lg border text-sm ${metric === m ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}>
            {m === 'cpu' ? 'CPU' : 'MEM'}
          </button>
        ))}
        <SearchInput value={q} onChange={setQ} placeholder="네임스페이스 찾기" width="w-52" />
        <span className="text-xs text-muted-foreground ml-1">비효율(req−use) 내림차순</span>
        <div className="ml-auto flex items-center gap-3">
          <PageSizeSelect value={pageSize} onChange={setPageSize} options={RANK_PAGE_SIZES} />
          <Pager page={safePage} totalPages={totalPages} onPage={setPage} />
        </div>
      </div>
      <div className="min-h-64">{body}</div>
      {nsQ.data && !nsQ.data.metricsAvailable && (
        <div className="text-sm text-muted-foreground mt-2">※ 사용량(use) 미가용 — request 기준만 표시됩니다.</div>
      )}
    </MacCard>
  );
}
