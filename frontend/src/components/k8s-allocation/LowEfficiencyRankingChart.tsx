// 저효율 NS 추이 랭킹 — 기간 평균 사용효율(use/req)이 낮은 NS 상위 N 의 효율 시계열 + 추세.
import { useMemo } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import { EmptyState, Skeleton } from '@/components/common';
import { useEffRanking } from '@/hooks/useK8sEfficiency';
import { fmtCores, fmtGi } from './format';
import type { EffRange } from './effUtils';

const COLORS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--status-warning', '--status-info', '--status-critical'];

export function LowEfficiencyRankingChart({ clusterId, range, metric, onPick }: {
  clusterId: string; range: EffRange; metric: 'cpu' | 'mem'; onPick?: (ns: string) => void;
}) {
  const q = useEffRanking(clusterId, range, metric, 8);
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const { data, keys } = useMemo(() => {
    const byT = new Map<number, Record<string, number | null | string>>();
    for (const it of items) {
      for (const p of it.points) {
        const row = byT.get(p.t) ?? { t: p.t };
        row[it.namespace] = p.eff == null ? null : +(p.eff * 100).toFixed(1);
        byT.set(p.t, row);
      }
    }
    const rows = [...byT.values()].sort((a, b) => (a.t as number) - (b.t as number)).map((r) => {
      const d = new Date((r.t as number) * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      return { ...r, label: range === '24h' ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}` };
    });
    return { data: rows, keys: items.map((i) => i.namespace) };
  }, [items, range]);
  const fmt = metric === 'cpu' ? fmtCores : fmtGi;

  return (
    <div className="min-h-56">
      {q.isLoading && !q.data ? <Skeleton className="h-56 w-full" />
        : !items.length ? <EmptyState title="데이터 없음" description="실사용(usage) 샘플이 있는 NS 가 없습니다. metrics-server 또는 Prometheus 연결을 확인하세요." />
        : (
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_260px] gap-3">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} unit="%" width={48} domain={[0, 'auto']} />
                <RechartsTooltip formatter={(v: number) => [`${v}%`, '사용효율(use/req)']}
                  contentStyle={{ fontSize: 12, borderRadius: 8, background: 'hsl(var(--card))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border))' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {keys.map((k, i) => (
                  <Line key={k} type="monotone" dataKey={k} stroke={`hsl(var(${COLORS[i % COLORS.length]}))`} dot={false} strokeWidth={1.5} connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
            <ul className="text-xs divide-y divide-border rounded-lg border border-border overflow-hidden self-start">
              {items.map((it, i) => {
                const Icon = it.trend === 'up' ? ArrowUpRight : it.trend === 'down' ? ArrowDownRight : ArrowRight;
                const cls = it.trend === 'up' ? 'text-status-healthy' : it.trend === 'down' ? 'text-status-critical' : 'text-muted-foreground';
                return (
                  <li key={it.namespace}>
                    <button type="button" onClick={() => onPick?.(it.namespace)} title="추이 차트에서 보기"
                      className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-muted/10 text-left">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: `hsl(var(${COLORS[i % COLORS.length]}))` }} />
                      <span className="truncate flex-1" title={it.namespace}>{it.namespace}</span>
                      <span className="tabular-nums font-medium">{it.avgEfficiency == null ? '—' : `${Math.round(it.avgEfficiency * 100)}%`}</span>
                      <span className="tabular-nums text-muted-foreground" title="평균 낭비(req−use)">{fmt(it.avgSlack)}</span>
                      <Icon className={`w-3.5 h-3.5 ${cls}`} aria-label={it.trend ?? 'flat'} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
    </div>
  );
}
