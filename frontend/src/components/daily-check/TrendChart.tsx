import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import type { AxiosError } from 'axios';
import { MacCard } from '@/components/ui/MacCard';
import type { DailyCheckTrend } from '@/types';
import { parseUTC } from '@/lib/utils';

interface Props {
  trend: DailyCheckTrend | undefined;
  days?: number;
  isError?: boolean;
  error?: unknown;
}

function errMsg(e: unknown): string {
  const ax = e as AxiosError<{ detail?: string }>;
  return ax?.response?.data?.detail || (e as Error)?.message || '알 수 없는 오류';
}

export function TrendChart({ trend, days = 7, isError, error }: Props) {
  // 조회 실패 — "기록 없음"(정상 빈 상태)과 구분해 에러로 안내 (D-021)
  if (isError) {
    return (
      <MacCard title={`최근 ${days}일 추이`}>
        <div className="rounded-xl border border-status-critical/40 bg-status-critical-soft p-3 text-sm">
          <p className="font-medium text-status-critical">추이를 불러오지 못했습니다</p>
          <p className="mt-1 text-muted-foreground break-words">{errMsg(error)}</p>
        </div>
      </MacCard>
    );
  }
  if (!trend || trend.points.length === 0) {
    return (
      <MacCard title={`최근 ${days}일 추이`}>
        <div className="text-sm text-muted-foreground italic">
          최근 {days}일간의 점검 기록이 없습니다.
        </div>
      </MacCard>
    );
  }

  const data = trend.points.map((p) => ({
    time: p.checkedAt ? parseUTC(p.checkedAt).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }) : '',
    errors: p.errors,
    warnings: p.warnings,
    readyNodes: p.readyNodes,
    totalNodes: p.totalNodes,
  }));

  return (
    <MacCard title={`최근 ${days}일 추이`}>
      <div className="space-y-3">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {Object.entries(trend.totals || {}).map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5"
            >
              <span
                className={
                  k === 'critical' ? 'h-2 w-2 rounded-full bg-status-critical' :
                  k === 'warning'  ? 'h-2 w-2 rounded-full bg-status-warning' :
                  k === 'healthy'  ? 'h-2 w-2 rounded-full bg-status-healthy' :
                                     'h-2 w-2 rounded-full bg-status-unknown'
                }
              />
              {k}: {v}
            </span>
          ))}
        </div>
        {/* errors/warnings 카운트(보통 0~5)와 readyNodes(보통 3~수십+)는 스케일이 달라
            같은 Y축에 그리면 errors 변화가 시각적으로 묻힌다 → 좌/우 dual Y-axis 로 분리. */}
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="time" tick={{ fontSize: 10 }} />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 10 }}
              label={{
                value: '이벤트 수',
                angle: -90,
                position: 'insideLeft',
                style: { fontSize: 10, fill: 'hsl(var(--muted-foreground))' },
              }}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              tick={{ fontSize: 10 }}
              label={{
                value: '노드 수',
                angle: 90,
                position: 'insideRight',
                style: { fontSize: 10, fill: 'hsl(var(--muted-foreground))' },
              }}
              allowDecimals={false}
            />
            <Tooltip />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            {/* 색 토큰 + 라인 패턴 차등(색 단독 의존 보완, D-020):
                에러=실선 · 경고=파선 · Ready 노드=점선 */}
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="errors"
              stroke="hsl(var(--status-critical))"
              name="에러"
              strokeWidth={2}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="warnings"
              stroke="hsl(var(--status-warning))"
              name="경고"
              strokeWidth={2}
              strokeDasharray="6 3"
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="readyNodes"
              stroke="hsl(var(--status-healthy))"
              name="Ready 노드"
              strokeWidth={2}
              strokeDasharray="2 3"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </MacCard>
  );
}
