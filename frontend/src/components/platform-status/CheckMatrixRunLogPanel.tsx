import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { SidePane } from '@/components/common';
import { checkMatrixKeys, useCheckMatrixRuns } from '@/hooks/useCheckMatrix';
import { useCheckMatrixLogStore } from '@/stores/checkMatrixLogStore';
import type { CheckMatrixTrigger } from '@/types';
import { CheckMatrixRunList, CheckMatrixRunDetailView } from './CheckMatrixRunLog';
import { CancelRunsButton } from './CancelRunsButton';

const TERMINAL_STATES = new Set(['success', 'failed', 'skipped', 'cancelled']);

const TRIGGER_FILTERS: { value: '' | CheckMatrixTrigger; label: string }[] = [
  { value: '', label: '전체' },
  { value: 'cron', label: '자동(cron)' },
  { value: 'manual_cell', label: '셀' },
  { value: 'manual_cluster', label: '클러스터' },
  { value: 'manual_item', label: '항목' },
  { value: 'manual_entry', label: '수동 입력' },
];

/**
 * 점검 매트릭스 수행 로그 패널 — 화면 어디서 실행하든(셀/행/열/항목 상세) 이 패널 하나로 본다.
 * 무엇을 보여줄지는 `useCheckMatrixLogStore` 가 정한다.
 *
 * - 단일 수행(`target.runId`): 그 수행의 상세를 바로 펼쳐 진행 로그를 2초 간격으로 따라간다.
 * - 일괄 수행(`target.batchId`): 그 배치만 3초 간격으로 따라가고, 전부 끝나면 완료/실패 건수를 알린다.
 * - 대상 없음: 전체 수행 로그(트리거 필터) — 10초마다 가볍게 갱신.
 */
export function CheckMatrixRunLogPanel() {
  const { open, target, close } = useCheckMatrixLogStore();
  if (!open) return null; // 닫혀 있으면 목록/상세 폴링도 하지 않는다
  return <PanelBody target={target} onClose={close} />;
}

function PanelBody({
  target, onClose,
}: { target: ReturnType<typeof useCheckMatrixLogStore.getState>['target']; onClose: () => void }) {
  const qc = useQueryClient();
  const batchId = target?.batchId ?? null;
  const runId = target?.runId ?? null;
  const [trigger, setTrigger] = useState<'' | CheckMatrixTrigger>('');
  const [selectedId, setSelectedId] = useState<string | null>(runId);

  // 대상이 바뀌면 이전 선택을 비우고(단일 수행이면 그것을) 고른다.
  useEffect(() => { setSelectedId(runId); }, [runId, batchId]);

  // 배치는 200건까지 한 번에 받아 완료를 판정한다 — 예전엔 50건만 보고 "끝났다" 고 오판했다.
  const batchFilter = { batchId: batchId ?? undefined, limit: 200 };
  const { data: batchData } = useCheckMatrixRuns(batchFilter, !!batchId, false);
  const runs = batchData?.runs ?? [];
  const batchTotal = batchData?.total ?? 0;
  const finished = runs.filter((r) => TERMINAL_STATES.has(r.runState)).length;
  const batchDone = !!batchId && !!batchData && (batchTotal === 0 || (finished >= batchTotal && runs.length >= batchTotal));
  const batchFailedCount = batchDone ? runs.filter((r) => r.runState === 'failed').length : 0;
  const batchCancelledCount = batchDone ? runs.filter((r) => r.runState === 'cancelled').length : 0;

  // 완료되면 셀 결과가 바로 보이도록 그리드를 1회 갱신한다.
  const invalidatedFor = useRef<string | null>(null);
  useEffect(() => {
    if (batchDone && batchId && invalidatedFor.current !== batchId) {
      invalidatedFor.current = batchId;
      qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
    }
  }, [batchDone, batchId, qc]);

  const title = runId
    ? `실행 로그 — ${target?.label ?? '셀 실행'}`
    : batchId ? `실행 로그 — ${target?.label ?? '일괄 실행'}` : '점검 수행 로그';

  return (
    <SidePane
      open
      onClose={onClose}
      title={title}
      width="720px"
      resizable
      widthStorageKey="pep:checkMatrixRunLogWidth"
    >
      <div className="space-y-4 pb-4">
        {runId ? null : batchId ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
          <p className={`text-xs flex items-center gap-1.5 ${
            batchDone ? (batchFailedCount > 0 ? 'text-status-warning' : 'text-status-healthy') : 'text-muted-foreground'
          }`} aria-live="polite">
            {batchDone ? (batchFailedCount > 0
              ? <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
              : <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />)
              : <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin" aria-hidden="true" />}
            {batchDone
              ? (batchTotal === 0
                ? '새로 실행할 셀이 없었습니다 — 이미 실행 중이었거나 대상이 없습니다.'
                : batchFailedCount > 0
                  ? `일괄 실행이 끝났습니다 — ${batchTotal}건 중 ${batchFailedCount}건 실패. 실패 행을 눌러 원인을 확인하세요.`
                  : batchCancelledCount > 0
                    ? `일괄 실행이 끝났습니다 — ${batchTotal}건 중 ${batchCancelledCount}건 취소.`
                    : `일괄 실행이 끝났습니다 — ${batchTotal}건 모두 마쳤고 매트릭스 셀이 갱신되었습니다.`)
              : `진행 중 — ${finished}/${batchTotal}건 완료 · 3초마다 갱신. 행을 누르면 그 셀의 실시간 로그가 열립니다.`}
          </p>
          {!batchDone && batchTotal > 0 && <CancelRunsButton batchId={batchId} />}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="트리거 필터">
            <span className="text-xs text-muted-foreground">트리거</span>
            {TRIGGER_FILTERS.map((f) => (
              <button
                key={f.value || 'all'}
                onClick={() => setTrigger(f.value)}
                aria-pressed={trigger === f.value}
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

        {!runId && (
          <CheckMatrixRunList
            filter={batchId ? batchFilter : { trigger: trigger || undefined, limit: 50 }}
            live={batchId ? !batchDone : 10000}
            showCell
            selectedId={selectedId}
            onSelect={(id) => setSelectedId((cur) => (cur === id ? null : id))}
          />
        )}

        {selectedId && (
          <div className={runId ? '' : 'border-t border-border pt-4'}>
            <CheckMatrixRunDetailView key={selectedId} runId={selectedId} />
          </div>
        )}
      </div>
    </SidePane>
  );
}
