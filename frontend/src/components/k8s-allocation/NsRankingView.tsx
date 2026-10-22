// 네임스페이스 비효율 랭킹 — req vs 실사용 바 차트(간격이 클수록 낭비).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, CartesianGrid, Legend,
} from 'recharts';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, ErrorState, Skeleton, SnapshotProgressCard } from '@/components/common';
import { useAllocNamespaces } from '@/hooks/useK8sAllocation';
import { fmtN } from './format';
import { PageSizeSelect, Pager, SearchInput, SegTabs } from './primitives';
import { paginate } from './tableSort';
import type { AllocDetailTarget } from './AllocDetailDialog';
import { allocPhaseText } from './effUtils';

type ChartMetric = 'cpu' | 'mem';

/** Y축(네임스페이스) 라벨 — 클릭하면 그 NS 의 리소스 할당·사용 상세를 연다. */
function NsAxisTick({ x, y, payload, onOpenDetail }: {
  x?: number; y?: number; payload?: { value?: string };
  onOpenDetail: (t: AllocDetailTarget) => void;
}) {
  const ns = payload?.value ?? '';
  return (
    <text
      x={x} y={y} dy={4} textAnchor="end" fontSize={12} fill="hsl(var(--muted-foreground))"
      className="cursor-pointer hover:fill-[hsl(var(--primary))]"
      onClick={() => ns && onOpenDetail({ scope: 'namespace', name: ns })}
    >
      <title>{`${ns} — 리소스 할당·사용 상세 보기`}</title>
      {ns}
    </text>
  );
}
const RANK_PAGE_SIZES = [10, 15, 25, 50];

export function NsRankingView({ clusterId, onOpenDetail }: {
  clusterId: string; onOpenDetail: (t: AllocDetailTarget) => void;
}) {
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
    body = <ErrorState error={error} title="네임스페이스 자원을 불러오지 못했습니다" onRetry={() => void nsQ.refetch()} />;
  } else if (computing && !(nsQ.data?.items?.length)) {
    body = (
      <SnapshotProgressCard processed={nsQ.data?.processed ?? 0} total={nsQ.data?.total ?? null}
        progress={nsQ.data?.progress ?? null} label="자원 집계 중" unit="Pod"
          detail={allocPhaseText(nsQ.data?.phase, nsQ.data?.processed)} />
    );
  } else if (nsQ.isLoading && !nsQ.data) {
    body = <Skeleton className="h-64 w-full" />;
  } else if (!nsChart.length) {
    body = q.trim()
      ? <EmptyState title="검색 결과 없음" description={`'${q}' 와 일치하는 네임스페이스가 없습니다.`} action={{ label: '검색 지우기', onClick: () => setQ(''), variant: 'secondary' }} />
      : <EmptyState title="네임스페이스 없음" description="이 클러스터에서 집계된 네임스페이스가 없습니다. 헤더의 새로고침으로 다시 집계하세요." />;
  } else {
    body = (
      <ResponsiveContainer width="100%" height={Math.max(280, chartRows * 32)}>
        <BarChart data={nsChart} layout="vertical" margin={{ left: 12, right: 24, top: 4, bottom: 4 }}
          onClick={(e) => {
            // 막대/플롯 영역 클릭 → 해당 NS 상세. activeLabel 이 Y축(카테고리) 값이다.
            const ns = (e as { activeLabel?: string })?.activeLabel;
            if (ns) onOpenDetail({ scope: 'namespace', name: ns });
          }}
          className="cursor-pointer">
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
          <XAxis type="number" tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} unit={unit} />
          <YAxis
            type="category"
            dataKey="namespace"
            width={150}
            tick={<NsAxisTick onOpenDetail={onOpenDetail} />}
          />
          <RechartsTooltip
            formatter={(v: number, name) => [`${v}${unit}`, name === 'req' ? 'request' : '실사용']}
            contentStyle={{ fontSize: 13, borderRadius: 8, background: 'hsl(var(--card))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border))' }}
          />
          <Legend formatter={(v) => (v === 'req' ? 'request' : '실사용')} wrapperStyle={{ fontSize: 13 }} />
          {/* 낭비는 막대 간격 자체가 보여준다 — 상태색(주황)으로 따로 칠하지 않는다(카테고리는 --chart-* 만). */}
          <Bar dataKey="req" name="req" fill="hsl(var(--chart-1))" radius={[0, 4, 4, 0]} />
          <Bar dataKey="use" name="use" fill="hsl(var(--chart-2))" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }
  // 차트 막대·축 라벨은 마우스 전용이다 — 키보드·스크린리더용으로 같은 NS 목록을 버튼으로 둔다(포커스하면 보인다).
  const keyboardList = nsChart.length > 0 && !(isError && !nsQ.data) && (
    <ul aria-label="네임스페이스 상세 열기" className="sr-only focus-within:not-sr-only focus-within:mt-2 focus-within:flex focus-within:flex-wrap focus-within:gap-1">
      {nsChart.map((d) => (
        <li key={d.namespace}>
          <button type="button" onClick={() => onOpenDetail({ scope: 'namespace', name: d.namespace })}
            className="text-xs px-2 py-0.5 rounded-xl border border-border bg-card hover:bg-secondary">
            {d.namespace} 상세 (request {d.req}{unit} · 실사용 {d.use == null ? '—' : `${d.use}${unit}`})
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <MacCard
      title="네임스페이스 비효율 랭킹"
      titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{fmtN(nsRanked.length)}개</span>}
      description="request vs 실사용 — 간격이 클수록 낭비"
      bodyPadding="p-3"
      actions={<SegTabs<ChartMetric> label="랭킹 기준 자원" value={metric} onChange={setMetric}
        options={[['cpu', 'CPU'], ['mem', 'MEM']]} />}
    >
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <SearchInput value={q} onChange={setQ} placeholder="네임스페이스 찾기" width="w-52" />
        <span className="text-xs text-muted-foreground ml-1">비효율(request − 실사용) 내림차순 · 막대/NS 명 클릭 시 상세</span>
        <div className="ml-auto flex items-center gap-3">
          <PageSizeSelect value={pageSize} onChange={setPageSize} options={RANK_PAGE_SIZES} />
          <Pager page={safePage} totalPages={totalPages} onPage={setPage} />
        </div>
      </div>
      <div className="min-h-64">{body}</div>
      {keyboardList}
      {nsQ.data && !nsQ.data.metricsAvailable && (
        <div className="text-sm text-muted-foreground mt-2">실사용량을 가져오지 못해 request 기준만 표시합니다(metrics-server 확인).</div>
      )}
    </MacCard>
  );
}
