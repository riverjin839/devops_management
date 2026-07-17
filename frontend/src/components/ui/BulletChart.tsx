// DESIGN_SYSTEM.md §5① Bullet Chart — Radial Gauge 대신 채택(A11y AAA, 다중 KPI 비교 가능).
// Recharts 미지원이라 SVG 로 직접 구현. 가로 막대 + 타겟 마커 + 3-zone 정성적 배경.
import { useId } from 'react';

export interface BulletZone {
  /** 이 zone 이 끝나는 지점 (0~100, 이전 zone 의 end 부터 이어짐) */
  end: number;
  /** 배경색 — hsl(var(--status-*)) 권장 */
  color: string;
  label: string;
}

export interface BulletChartProps {
  /** 실제 값 (0~100) */
  value: number;
  /** 정성적 구간(예: critical/warning/healthy 임계값) — end 오름차순 */
  zones: BulletZone[];
  /** 목표선 위치 (0~100). 미지정 시 표시 안 함 */
  target?: number;
  /** 값 막대 색 */
  valueColor?: string;
  height?: number;
  className?: string;
  /** 스크린리더용 설명 — 미지정 시 value/target 로 자동 생성 */
  ariaLabel?: string;
}

/** 단일 가로 Bullet Chart — 3-zone 배경 위에 실제값 막대 + 목표 마커. */
export function BulletChart({
  value, zones, target, valueColor = 'hsl(var(--foreground))', height = 14, className = '', ariaLabel,
}: BulletChartProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const gradId = useId();
  const label = ariaLabel
    ?? `현재 값 ${Math.round(clamped)}%${target != null ? `, 목표 ${Math.round(target)}%` : ''}`;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      width="100%"
      height={height}
      className={className}
      role="img"
      aria-label={label}
    >
      <defs>
        <clipPath id={`${gradId}-clip`}>
          <rect x="0" y="0" width="100" height="100" rx="20" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${gradId}-clip)`}>
        {/* 3-zone 정성적 배경 */}
        {zones.map((z, i) => {
          const start = i === 0 ? 0 : zones[i - 1].end;
          return <rect key={i} x={start} y="0" width={z.end - start} height="100" fill={z.color} />;
        })}
        {/* 실제 값 막대 — zone 배경 중앙에 얇게 */}
        <rect x="0" y="35" width={clamped} height="30" fill={valueColor} />
      </g>
      {/* 목표 마커 */}
      {target != null && (
        <line x1={target} y1="0" x2={target} y2="100" stroke="hsl(var(--foreground))" strokeWidth="3" />
      )}
    </svg>
  );
}
