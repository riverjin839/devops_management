// 색은 전부 테마 토큰 경유 — 고정 팔레트(text-*-400 등)는 테마마다 대비가 깨진다 (D-049).
// 의미색(상태) = `status-*`, 범주 구분색(겹침 그룹) = categorical `chart-*`.
// (구 `OPERATION_LEVELS`/`LEVEL_BADGE` 는 운영레벨이 Settings 기반 `useOperationLevels`
//  로 옮겨간 뒤 참조가 0건이라 제거했다.)

export const STATUS_STYLE: Record<string, { dot: string; border: string; badge: string; label: string }> = {
  healthy:  { dot: 'bg-status-healthy',  border: 'border-l-status-healthy',  badge: 'bg-status-healthy/10 text-status-healthy',   label: 'Healthy'  },
  warning:  { dot: 'bg-status-warning',  border: 'border-l-status-warning',  badge: 'bg-status-warning/10 text-status-warning',   label: 'Warning'  },
  critical: { dot: 'bg-status-critical', border: 'border-l-status-critical', badge: 'bg-status-critical/10 text-status-critical', label: 'Critical' },
  pending:  { dot: 'bg-status-unknown',  border: 'border-l-status-unknown',  badge: 'bg-status-unknown/10 text-status-unknown',   label: '미연결'   },
};

// CIDR 겹침 그룹 구분 — 의미가 아니라 "몇 번째 겹침 묶음인지" 를 나타내는 범주색.
export const OVERLAP_COLORS = [
  { bg: 'bg-chart-7/10', text: 'text-chart-7', border: 'border-chart-7/40', dot: 'bg-chart-7' },
  { bg: 'bg-chart-5/10', text: 'text-chart-5', border: 'border-chart-5/40', dot: 'bg-chart-5' },
  { bg: 'bg-chart-6/10', text: 'text-chart-6', border: 'border-chart-6/40', dot: 'bg-chart-6' },
  { bg: 'bg-chart-3/10', text: 'text-chart-3', border: 'border-chart-3/40', dot: 'bg-chart-3' },
  { bg: 'bg-chart-4/10', text: 'text-chart-4', border: 'border-chart-4/40', dot: 'bg-chart-4' },
];

export type OverlapColor = typeof OVERLAP_COLORS[0];
