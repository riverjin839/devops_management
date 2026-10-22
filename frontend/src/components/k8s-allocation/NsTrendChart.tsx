// NS 자원 추이 — request / 실사용 / Quota 한도 시계열(24h/7d/30d), CPU/MEM 토글.
import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import { EmptyState, ErrorState, Skeleton } from '@/components/common';
import { useEffNsSeries, useEffSummary } from '@/hooks/useK8sEfficiency';
import type { EffNsSummaryItem } from '@/types';

import { RANGE_OPTIONS } from './effUtils';
import type { EffRange } from './effUtils';
import { SegTabs } from './primitives';

const fmtT = (t: number, range: EffRange) => {
  const d = new Date(t * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return range === '24h' ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}h`;
};

const RANGE_LABEL: Record<EffRange, string> = { '24h': '24시간', '7d': '7일', '30d': '30일' };

export function RangeToggle({ value, onChange }: { value: EffRange; onChange: (r: EffRange) => void }) {
  return <SegTabs<EffRange> label="기간" value={value} onChange={onChange} options={RANGE_OPTIONS.map((r) => [r, RANGE_LABEL[r]] as const)} />;
}

export function MetricToggle({ value, onChange }: { value: 'cpu' | 'mem'; onChange: (m: 'cpu' | 'mem') => void }) {
  return <SegTabs<'cpu' | 'mem'> label="자원" value={value} onChange={onChange} options={[['cpu', 'CPU'], ['mem', 'MEM']]} />;
}

export function NsTrendChart({ clusterId, range, metric, namespace, onNamespace }: {
  clusterId: string; range: EffRange; metric: 'cpu' | 'mem'; namespace: string; onNamespace: (ns: string) => void;
}) {
  const summaryQ = useEffSummary(clusterId);
  const namespaces = useMemo(() => (summaryQ.data?.items ?? []).map((s: EffNsSummaryItem) => s.namespace).sort(), [summaryQ.data]);
  // 첫 진입 시 저효율(use/req 낮은) NS 를 기본 선택
  useEffect(() => {
    if (namespace || !summaryQ.data?.items?.length) return;
    const items = [...summaryQ.data.items].filter((s) => s.cpuUseM != null && s.cpuReqM > 0)
      .sort((a, b) => ((a.cpuUseM ?? 0) / a.cpuReqM) - ((b.cpuUseM ?? 0) / b.cpuReqM));
    onNamespace((items[0] ?? summaryQ.data.items[0]).namespace);
  }, [namespace, summaryQ.data, onNamespace]);
  const seriesQ = useEffNsSeries(clusterId, namespace, range);
  const [showQuota, setShowQuota] = useState(true);

  const data = useMemo(() => (seriesQ.data?.points ?? []).map((p) => {
    const div = metric === 'cpu' ? 1000 : 1024 ** 3;
    const pick = (v: number | null) => (v == null ? null : +(v / div).toFixed(2));
    return {
      t: p.t, label: fmtT(p.t, range),
      req: pick(metric === 'cpu' ? p.cpuReq : p.memReq),
      use: pick(metric === 'cpu' ? p.cpuUse : p.memUse),
      quota: pick(metric === 'cpu' ? p.cpuQuota : p.memQuota),
      quotaUsed: pick(metric === 'cpu' ? p.cpuQuotaUsed : p.memQuotaUsed),
    };
  }), [seriesQ.data, metric, range]);
  const unit = metric === 'cpu' ? '코어' : 'Gi';
  const hasQuota = data.some((d) => d.quota != null);

  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <label className="text-xs text-muted-foreground flex items-center gap-1">
          NS
          <select value={namespace} onChange={(e) => onNamespace(e.target.value)} aria-label="네임스페이스 선택"
            className="text-sm px-2 py-1 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary max-w-[240px]">
            {!namespaces.includes(namespace) && namespace && <option value={namespace}>{namespace}</option>}
            {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {hasQuota && (
          <label className="text-xs text-muted-foreground flex items-center gap-1">
            <input type="checkbox" checked={showQuota} onChange={(e) => setShowQuota(e.target.checked)} className="accent-primary" /> Quota 한도 표시
          </label>
        )}
      </div>
      <div className="min-h-56">
        {seriesQ.isLoading && !seriesQ.data ? <Skeleton className="h-56 w-full" />
          : seriesQ.isError && !seriesQ.data ? <ErrorState error={seriesQ.error} title="자원 추이를 불러오지 못했습니다" onRetry={() => void seriesQ.refetch()} compact />
          : !namespace ? <EmptyState title="네임스페이스 없음" description="수집이 한 번 이상 돌아야 추이가 표시됩니다." />
          : !data.length ? <EmptyState title="샘플 없음" description={`${RANGE_LABEL[range]} 범위에 샘플이 없습니다. 기간을 늘리거나 '정책 설정 → 수집 스케줄'에서 수집 주기를 확인하세요.`} />
          : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} minTickGap={24} />
                <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} unit={` ${unit}`} width={64} />
                <RechartsTooltip
                  formatter={(v: number, name) => [`${v} ${unit}`, name === 'req' ? 'request' : name === 'use' ? '실사용' : name === 'quota' ? 'Quota 한도' : 'Quota 사용']}
                  contentStyle={{ fontSize: 12, borderRadius: 8, background: 'hsl(var(--card))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border))' }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (v === 'req' ? 'request' : v === 'use' ? '실사용' : v === 'quota' ? 'Quota 한도' : 'Quota 사용')} />
                <Line type="monotone" dataKey="req" stroke="hsl(var(--chart-1))" dot={false} strokeWidth={2} connectNulls />
                <Line type="monotone" dataKey="use" stroke="hsl(var(--chart-2))" dot={false} strokeWidth={2} connectNulls />
                {showQuota && hasQuota && <Line type="stepAfter" dataKey="quota" stroke="hsl(var(--chart-3))" dot={false} strokeDasharray="6 3" connectNulls />}
                {showQuota && hasQuota && <Line type="monotone" dataKey="quotaUsed" stroke="hsl(var(--chart-4))" dot={false} strokeDasharray="2 2" connectNulls />}
              </LineChart>
            </ResponsiveContainer>
          )}
      </div>
    </div>
  );
}
