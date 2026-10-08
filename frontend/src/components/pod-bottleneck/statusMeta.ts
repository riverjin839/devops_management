// 병목 진단 상태 메타 — 색만으로 상태를 전달하지 않도록 라벨·아이콘을 함께 쓴다(D-096).
// ProbeResultCard·이력 행(PodBottleneckPage)·상세 배지(PodBottleneckDetailPage)가 공유한다.
import { CheckCircle, AlertTriangle, XCircle, WifiOff } from 'lucide-react';
import type { BottleneckStatus } from '@/types';

export const BOTTLENECK_STATUS_META: Record<BottleneckStatus, { label: string; cls: string; icon: typeof CheckCircle }> = {
  healthy:  { label: '정상',   cls: 'text-status-healthy',  icon: CheckCircle },
  warning:  { label: '경고',   cls: 'text-status-warning',  icon: AlertTriangle },
  critical: { label: '위험',   cls: 'text-status-critical', icon: XCircle },
  pending:  { label: '미연결', cls: 'text-status-unknown',  icon: WifiOff },
};
