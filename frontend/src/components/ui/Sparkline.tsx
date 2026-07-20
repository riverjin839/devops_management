// DESIGN_SYSTEM.md §5② Sparkline — KPI 카드 하단 트렌드. Recharts 호환 표준 패턴.
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import type { MetricSparklinePoint } from '@/types';

export interface SparklineProps {
  points: MetricSparklinePoint[];
  /** 선 색 — hsl(var(--status-*)) 등. 미지정 시 muted-foreground */
  color?: string;
  height?: number;
  className?: string;
}

export function Sparkline({ points, color = 'hsl(var(--muted-foreground))', height = 32, className = '' }: SparklineProps) {
  if (points.length < 2) return null;

  return (
    <>
      <div className={className} style={{ width: '100%', height }} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
            <YAxis domain={['dataMin', 'dataMax']} hide />
            <Line
              type="monotone"
              dataKey="value"
              stroke={color}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {/* 스크린리더용 — 위 차트는 aria-hidden 이라 실제 값을 표로 동반한다(DESIGN_SYSTEM §8). */}
      <table className="sr-only">
        <caption>최근 추이</caption>
        <thead>
          <tr><th>시각</th><th>값</th></tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.ts}>
              <td>{new Date(p.ts * 1000).toLocaleTimeString('ko-KR')}</td>
              <td>{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
