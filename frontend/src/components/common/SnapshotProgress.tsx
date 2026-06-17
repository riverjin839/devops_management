import { Loader2 } from 'lucide-react';

interface SnapshotProgressCardProps {
  /** 지금까지 처리한 개수 */
  processed: number;
  /** 전체 추정 개수 (모르면 null → 불확정 스피너) */
  total: number | null;
  /** 0..1 진행 비율 (모르면 null) */
  progress: number | null;
  /** 헤드라인 (예: "노드 이미지 수집 중", "자원 집계 중") */
  label: string;
  /** 처리 단위 (예: "노드", "Pod") */
  unit?: string;
}

/**
 * 대규모 클러스터에서 백그라운드 전수 집계가 진행되는 동안 표시하는 진행률 카드.
 * 무결성을 위해 집계는 끝까지 수행되며, 완료되면 전체 결과로 대체된다.
 */
export function SnapshotProgressCard({
  processed,
  total,
  progress,
  label,
  unit = '',
}: SnapshotProgressCardProps) {
  const pct = progress != null ? Math.min(100, Math.round(progress * 100)) : null;
  return (
    <div className="bg-card border border-border rounded-xl p-8">
      <div className="flex flex-col items-center gap-4 text-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
        <div>
          <p className="font-medium text-foreground mb-1">
            {label}
            {pct != null ? ` — ${pct}%` : ''}
          </p>
          <p className="text-sm text-muted-foreground">
            {processed.toLocaleString()}
            {total != null ? ` / ${total.toLocaleString()}` : ''} {unit} 처리됨
          </p>
        </div>
        <div className="w-full max-w-md h-2 rounded-full bg-muted overflow-hidden">
          {pct != null ? (
            <div
              className="h-full bg-primary transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          ) : (
            // total 미상 — 불확정 진행 표시(좌우로 흐르는 바)
            <div className="h-full w-1/3 bg-primary/70 animate-pulse" />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          대규모 클러스터는 수 초~수십 초 걸릴 수 있습니다. 완료되면 전체 결과가 표시됩니다.
        </p>
      </div>
    </div>
  );
}
