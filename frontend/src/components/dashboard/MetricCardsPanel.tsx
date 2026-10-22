import { useState } from 'react';
import { Activity, Plus } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ConfirmDialog } from '@/components/common';
import { useMetricCards, useMetricResults, useDeleteMetricCard } from '@/hooks/useMetricCards';
import { useCanOperate } from '@/hooks/useCanOperate';
import type { MetricCard } from '@/types';
import { MetricCardGrid } from './MetricCardGrid';
import { AddMetricCardModal } from './AddMetricCardModal';

/**
 * PromQL 메트릭 카드(`metric_cards`) 조회·추가·편집·삭제 — 클러스터 선택과 무관한 전역 카드.
 * 구 `/cluster-overview` 의 "Prometheus 지표" 섹션을 `/observability` 로 옮긴 것이다.
 * 생성/수정/삭제는 백엔드가 operator 이상만 허용(require_operator) — viewer 에게는 비활성 + 사유.
 */
export function MetricCardsPanel() {
  const { data: cards = [], isLoading } = useMetricCards();
  const { data: results = [] } = useMetricResults();
  const deleteCard = useDeleteMetricCard();
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<MetricCard | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  return (
    <>
      <MacCard
        title="PromQL 카드"
        icon={Activity}
        titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{cards.length}개</span>}
        description="PROMETHEUS_URL 기준으로 실행하는 사용자 정의 PromQL 카드입니다."
        bodyPadding="p-4"
        className="overflow-hidden"
        rootClassName="min-w-0"
        actions={
          <button
            type="button"
            onClick={() => { setEditing(null); setShowModal(true); }}
            disabled={!canOperate}
            title={withHint('PromQL 카드 추가')}
            aria-label={ariaWithHint('PromQL 카드 추가')}
            className="inline-flex items-center gap-1 rounded-xl border border-border bg-secondary px-2.5 py-1 text-sm hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-3 h-3" /> 카드
          </button>
        }
      >
        <MetricCardGrid
          cards={cards}
          results={results}
          isLoading={isLoading}
          onDeleteCard={canOperate ? (id) => setPendingDeleteId(id) : undefined}
          onEditCard={canOperate ? (card) => { setEditing(card); setShowModal(true); } : undefined}
        />
      </MacCard>

      <AddMetricCardModal
        isOpen={showModal}
        onClose={() => { setShowModal(false); setEditing(null); }}
        editingCard={editing}
      />

      <ConfirmDialog
        open={!!pendingDeleteId}
        title="이 메트릭 카드를 삭제할까요?"
        description="이 작업은 되돌릴 수 없습니다."
        confirmLabel="삭제"
        danger
        onCancel={() => setPendingDeleteId(null)}
        onConfirm={() => {
          if (pendingDeleteId) deleteCard.mutate(pendingDeleteId);
          setPendingDeleteId(null);
        }}
      />
    </>
  );
}
