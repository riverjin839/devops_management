import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import type { WorkGuide } from '@/types';

/**
 * Confluence 동기화 상태 배지 — synced(동일) / modified(재게시 필요) / error(실패).
 * 미연결 문서(confluencePageId 없음)는 아무것도 렌더하지 않는다.
 */
export function SyncStatusBadge({ guide, showVersion = false }: { guide: WorkGuide; showVersion?: boolean }) {
  if (!guide.confluencePageId) return null;
  const status = guide.confluenceSyncStatus ?? 'synced';
  const version = showVersion && guide.confluenceVersion ? ` · v${guide.confluenceVersion}` : '';

  if (status === 'modified') {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-500"
        title="PEP 에서 수정된 뒤 아직 Confluence 에 게시되지 않았습니다"
      >
        <RefreshCw className="w-3 h-3" /> 재게시 필요{version}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/10 text-red-500"
        title={guide.confluenceSyncError || '마지막 동기화가 실패했습니다'}
      >
        <AlertTriangle className="w-3 h-3" /> 동기화 오류{version}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-500"
      title={guide.confluenceSyncedAt ? `마지막 동기화 ${guide.confluenceSyncedAt.slice(0, 10)}` : undefined}
    >
      <CheckCircle2 className="w-3 h-3" /> 동기화됨{version}
    </span>
  );
}
