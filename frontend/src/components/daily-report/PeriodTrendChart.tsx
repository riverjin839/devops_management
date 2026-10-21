// 주간·월간 추이 — 일자별 클러스터 CPU·메모리 사용률(사용량 ÷ request, 사용량이 수집된 NS 기준).
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import type { DailyReportPeriod } from '@/types';

const LABEL: Record<string, string> = { cpu: 'CPU 사용률', mem: '메모리 사용률' };

export function PeriodTrendChart({ series }: { series: DailyReportPeriod['series'] }) {
  const data = series.map((p) => ({
    label: p.date.slice(5),
    cpu: p.cpuRate == null ? null : Math.round(p.cpuRate * 1000) / 10,
    mem: p.memRate == null ? null : Math.round(p.memRate * 1000) / 10,
  }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} minTickGap={16} />
        <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} unit="%" width={48} domain={[0, 'auto']} />
        <RechartsTooltip
          formatter={(v: number, name) => [`${v}%`, LABEL[String(name)] ?? String(name)]}
          contentStyle={{ fontSize: 12, borderRadius: 8, background: 'hsl(var(--card))', color: 'hsl(var(--foreground))', border: '1px solid hsl(var(--border))' }}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => LABEL[String(v)] ?? String(v)} />
        <Line type="monotone" dataKey="cpu" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={{ r: 2 }} connectNulls />
        <Line type="monotone" dataKey="mem" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={{ r: 2 }} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}
