import { StatusBadge, statusToVariant } from '@/components/common/StatusBadge';
import type { LakeStatus } from '@/types';

interface HealthBadgeProps {
  status: LakeStatus;
  size?: 'sm' | 'md';
  showIcon?: boolean;
}

/**
 * LAKE 상태 배지 — 공용 StatusBadge 의 얇은 래퍼 (D-020: --status-* 토큰 경유).
 * LakeStatus(healthy/warning/critical/pending) → statusToVariant 로 매핑.
 */
export function HealthBadge({ status, size = 'sm', showIcon = true }: HealthBadgeProps) {
  return <StatusBadge variant={statusToVariant(status)} size={size} icon={showIcon} />;
}
