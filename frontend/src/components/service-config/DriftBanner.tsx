// 드리프트 배너 — 이 범위(기본·그룹) 노드 값이 마지막 기준 버전(가져옴·적용됨)과 다를 때만 보인다.
// "다시 적용" 은 기준 버전으로 적용 대화상자를 열고 다른 노드만 미리 골라 둔다.
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import type { ServiceConfigStatus } from '@/types';

const BASELINE_LABEL: Record<string, string> = { imported: '가져옴', applied: '적용됨' };

interface Props {
  status: ServiceConfigStatus;
  /** 지금 보는 범위의 그룹 id(null = 기본). */
  groupId: string | null;
  canApply: boolean;
  applyHint?: string;
  onShowSummary: () => void;
  onReapply: (nodes: string[]) => void;
}

export function DriftBanner({ status, groupId, canApply, applyHint, onShowSummary, onReapply }: Props) {
  const nodes = status.drift.byGroup[groupId ?? ''] ?? [];
  if (!nodes.length) return null;
  const rows = status.drift.rows.filter((r) => (r.groupId ?? null) === (groupId ?? null));
  const keys = [...new Set(rows.map((r) => r.key))];
  const base = rows[0]?.baselineVersionNo ?? status.drift.baselineVersionNo;
  const label = BASELINE_LABEL[status.drift.baselineStatus ?? ''] ?? '';
  return (
    <MacCard
      title={`노드 값이 V${base}${label ? `(${label})` : ''} 와(과) 다름`}
      description={`노드 ${nodes.length}개 · 키 ${keys.length}개 — 노드에서 직접 바뀌었거나 적용이 일부만 됐다`}
      actions={(
        <>
          <Button size="sm" variant="outline" onClick={onShowSummary}>요약에서 보기</Button>
          <Button size="sm" disabled={!canApply} onClick={() => onReapply(nodes)} title={applyHint}
            aria-label={`V${base} 을(를) 다른 노드 ${nodes.length}개에 다시 적용`}>다시 적용…</Button>
        </>
      )}
    >
      <p className="text-sm text-muted-foreground break-all">
        {keys.slice(0, 4).join(', ')}{keys.length > 4 ? ` 외 ${keys.length - 4}개` : ''} · {nodes.slice(0, 6).join(', ')}{nodes.length > 6 ? ' …' : ''}
      </p>
    </MacCard>
  );
}
