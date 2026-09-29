import { Copy } from 'lucide-react';
import type { CheckMatrixItem } from '@/types';

/** D-062 "대상 중복 표시" — 같은 target_key 를 서로 다른 실행기술이 점검 중일 때만 뜬다
 * (targetDuplicateCount, check_matrix_service._target_duplicate_map 이 판정). */
export function TargetDuplicateBadge({ item }: { item: Pick<CheckMatrixItem, 'targetKey' | 'targetDuplicateCount' | 'targetPeers'> }) {
  if (!item.targetDuplicateCount) return null;
  const peerNames = (item.targetPeers ?? []).map((p) => p.name).join(', ');
  return (
    <span
      title={`"${item.targetKey}" 대상을 ${item.targetDuplicateCount + 1}개 실행기술이 중복 점검 중: ${peerNames}`}
      className="flex-shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded border border-status-warning/30 bg-status-warning/10 text-[11px] font-medium text-status-warning select-none"
    >
      <Copy className="w-2.5 h-2.5" />
      중복 {item.targetDuplicateCount + 1}
    </span>
  );
}
