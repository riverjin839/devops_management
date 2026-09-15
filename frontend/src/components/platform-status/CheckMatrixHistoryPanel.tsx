import { useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { StatusBadge } from '@/components/common';
import { useCheckMatrixCellHistory } from '@/hooks/useCheckMatrix';
import { parseUTC } from '@/lib/utils';

interface Props {
  itemId: string;
  clusterId: string;
  /** 차트 Y축 단위 + 툴팁 시리즈명 */
  unit?: string | null;
  seriesName: string;
}

const DAY_OPTIONS = [7, 30, 90];

/**
 * 추이 차트 + 변경 이력 — `CheckMatrixCellDetailModal`(셀 상세)과 항목 상세(`/checks/:itemId`,
 * R-4 6차 라운드 4단계)가 공유한다. 수동 입력·cron 편집은 각 화면의 컨텍스트가 달라(모달=이미
 * 선택된 클러스터, 항목 상세=클러스터 선택형) 이 컴포넌트에 넣지 않고 호출부에 남겨둔다.
 */
export function CheckMatrixHistoryPanel({ itemId, clusterId, unit, seriesName }: Props) {
  const [days, setDays] = useState(30);
  const { data: history, isLoading } = useCheckMatrixCellHistory(itemId, clusterId, days);

  const chartData = useMemo(
    () => (history?.points ?? [])
      .filter((p) => p.value != null)
      .map((p) => ({
        time: parseUTC(p.checkedAt).toLocaleString('ko-KR', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        }),
        value: p.value,
      })),
    [history],
  );

  return (
    <>
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">추이</h3>
          <div className="flex items-center rounded-md border border-border overflow-hidden text-xs">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-2 py-1 transition-colors ${
                  days === d ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'
                }`}
              >
                {d}일
              </button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">불러오는 중…</div>
        ) : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="time" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} unit={unit ?? ''} />
              <Tooltip />
              <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} name={seriesName} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="text-sm text-muted-foreground italic py-8 text-center">
            최근 {days}일간 수치 이력이 없습니다.
          </div>
        )}
      </section>

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">변경 이력</h3>
        {(history?.changes.length ?? 0) === 0 ? (
          <div className="text-sm text-muted-foreground italic">기록이 없습니다.</div>
        ) : (
          <ul className="space-y-1.5 max-h-48 overflow-y-auto">
            {history!.changes.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <StatusBadge variant={c.status} size="sm" />
                <span className="text-muted-foreground text-xs tabular-nums">
                  {parseUTC(c.checkedAt).toLocaleString('ko-KR')}
                </span>
                {c.message && <span className="text-xs text-muted-foreground truncate">{c.message}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
