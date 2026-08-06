import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { SidePane } from '@/components/common';
import { checkMatrixKeys, useCheckMatrixRuns } from '@/hooks/useCheckMatrix';
import type { CheckMatrixTrigger } from '@/types';
import { CheckMatrixRunList, CheckMatrixRunDetailView } from './CheckMatrixRunLog';

const TERMINAL_STATES = new Set(['success', 'failed', 'skipped']);

interface Props {
  open: boolean;
  onClose: () => void;
  /** 특정 일괄 수행만 따라볼 때 — 지정하면 필터가 잠기고 폴링이 켜진다. */
  batchId?: string | null;
  /** 배치 컨텍스트 설명 (예: "prod-01 전체 실행"). */
  batchLabel?: string | null;
}

const TRIGGER_FILTERS: { value: '' | CheckMatrixTrigger; label: string }[] = [
  { value: '', label: '전체' },
  { value: 'cron', label: '자동(cron)' },
  { value: 'manual_cell', label: '셀' },
  { value: 'manual_cluster', label: '클러스터' },
  { value: 'manual_item', label: '항목' },
  { value: 'manual_entry', label: '수동 입력' },
];

/**
 * 점검 매트릭스 전체 수행 로그 — cron 자동 실행과 수동 실행을 한 줄기로 본다.
 *
 * `batchId` 를 주면 방금 트리거한 일괄 수행만 3초 간격으로 따라가며, 대기열 → 실행 중 →
 * 완료로 바뀌는 것을 그 자리에서 볼 수 있다.
 */
export function CheckMatrixRunLogPanel({ open, onClose, batchId, batchLabel }: Props) {
  const qc = useQueryClient();
  const [trigger, setTrigger] = useState<'' | CheckMatrixTrigger>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 배치가 바뀌면 이전 배치에서 고른 항목이 남지 않도록 선택을 비운다.
  useEffect(() => { setSelectedId(null); }, [batchId]);

  const batchFilter = { batchId: batchId ?? undefined, limit: 50 };
  // 배치 완료 감지 — 같은 queryKey 라 목록 컴포넌트와 캐시를 공유한다(추가 요청 없음).
  const { data: batchData } = useCheckMatrixRuns(batchFilter, open && !!batchId, false);
  const batchDone =
    !!batchId && !!batchData && batchData.runs.length > 0 &&
    batchData.runs.every((r) => TERMINAL_STATES.has(r.runState));
  // 완료 문구가 "끝났습니다"라고만 하면 그 안에 실패가 섞여도 안심하고 넘어가게 된다 —
  // 실패 건수가 있으면 확신 대신 정직한 경고 톤으로 바꾼다(연출이 아니라 정확도 문제).
  const batchFailedCount = batchDone ? (batchData?.runs.filter((r) => r.runState === 'failed').length ?? 0) : 0;

  // 완료되면 폴링을 멈추고, 셀 결과가 바로 보이도록 그리드를 1회 갱신한다.
  const invalidatedFor = useRef<string | null>(null);
  useEffect(() => {
    if (batchDone && batchId && invalidatedFor.current !== batchId) {
      invalidatedFor.current = batchId;
      qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
    }
  }, [batchDone, batchId, qc]);

  return (
    <SidePane
      open={open}
      onClose={onClose}
      title={batchId ? `수행 로그 — ${batchLabel ?? '일괄 실행'}` : '점검 수행 로그'}
      width="720px"
      resizable
      widthStorageKey="pep:checkMatrixRunLogWidth"
    >
      <div className="space-y-4 pb-4">
        {batchId ? (
          <p className={`text-xs flex items-center gap-1.5 ${
            batchDone ? (batchFailedCount > 0 ? 'text-status-warning' : 'text-status-healthy') : 'text-muted-foreground'
          }`}>
            {batchDone && (batchFailedCount > 0
              ? <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
              : <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />)}
            {batchDone
              ? (batchFailedCount > 0
                ? `일괄 수행이 끝났습니다 — ${batchFailedCount}건 실패, 매트릭스 셀이 갱신되었습니다.`
                : '일괄 수행이 끝났습니다 — 전부 성공, 매트릭스 셀이 갱신되었습니다.')
              : '방금 요청한 일괄 수행만 표시합니다 — 3초마다 갱신됩니다.'}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">트리거</span>
            {TRIGGER_FILTERS.map((f) => (
              <button
                key={f.value || 'all'}
                onClick={() => setTrigger(f.value)}
                className={`px-2 py-1 text-xs rounded-xl border transition-colors ${
                  trigger === f.value
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border hover:bg-secondary text-muted-foreground'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}

        <CheckMatrixRunList
          filter={batchId ? batchFilter : { trigger: trigger || undefined, limit: 50 }}
          live={!!batchId && !batchDone}
          showCell
          selectedId={selectedId}
          onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
        />

        {selectedId && (
          <div className="border-t border-border pt-4">
            <CheckMatrixRunDetailView runId={selectedId} />
          </div>
        )}
      </div>
    </SidePane>
  );
}
