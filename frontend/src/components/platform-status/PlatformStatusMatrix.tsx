import { useState } from 'react';
import {
  Plus, Settings, Pencil, Trash2, ChevronUp, ChevronDown, Clock, Lock, HelpCircle,
  Play, ScrollText, Loader2,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusDot, ConfirmDialog, useToast, Skeleton } from '@/components/common';
import {
  useCheckMatrixGrid, useReorderCheckMatrixItems, useDeleteCheckMatrixItem, usePutClusterCron,
  useRunCheckMatrixCluster, useRunCheckMatrixItem,
} from '@/hooks/useCheckMatrix';
import type { CheckMatrixCell, CheckMatrixItem, CheckMatrixGridCluster, Status } from '@/types';
import { formatApiError } from '@/lib/utils';
import { CheckMatrixCellDetailModal } from './CheckMatrixCellDetailModal';
import { CheckMatrixItemFormModal } from './CheckMatrixItemFormModal';
import { CheckMatrixSettingsModal } from './CheckMatrixSettingsModal';
import { CheckMatrixHelpPanel } from './CheckMatrixHelpPanel';
import { CheckMatrixRunLogPanel } from './CheckMatrixRunLogPanel';

const STATUS_LABEL: Record<Status, string> = {
  healthy: '정상', warning: '경고', critical: '위험', pending: '대기',
};

function CellButton({
  item, cell, onClick,
}: { item: CheckMatrixItem; cell: CheckMatrixCell | undefined; onClick: () => void }) {
  const empty = !cell || !cell.hasResult || !cell.status;
  return (
    <button
      onClick={onClick}
      className="w-full h-full min-h-[36px] flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-muted/60 transition-colors"
      title={cell?.message || undefined}
    >
      {empty ? (
        <span className="text-muted-foreground/50 text-xs">—</span>
      ) : (
        <>
          <StatusDot variant={cell.status!} />
          <span className="text-xs font-medium tabular-nums">
            {cell.value != null ? `${cell.value}${item.unit ?? ''}` : STATUS_LABEL[cell.status!]}
          </span>
        </>
      )}
    </button>
  );
}

function ClusterCronBadge({ cluster }: { cluster: CheckMatrixGridCluster }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(cluster.checkCronExpr ?? '');
  const mutation = usePutClusterCron();

  const handleSave = async () => {
    try {
      await mutation.mutateAsync({ clusterId: cluster.id, checkCronExpr: value.trim() || null });
      toast.success('클러스터 cron 을 저장했습니다.');
      setOpen(false);
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  return (
    <div className="relative inline-block">
      <button
        onClick={() => { setValue(cluster.checkCronExpr ?? ''); setOpen((v) => !v); }}
        className="inline-flex items-center gap-1 text-[10px] font-mono text-muted-foreground hover:text-primary transition-colors px-1.5 py-0.5 rounded border border-border/60 hover:border-primary/50"
      >
        <Clock className="w-2.5 h-2.5" />
        {cluster.checkCronExpr || '미설정'}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 top-full mt-1 left-1/2 -translate-x-1/2 w-56 bg-card border border-border rounded-lg shadow-xl p-3 space-y-2">
            <p className="text-[11px] text-muted-foreground">핵심 점검(API 응답시간 등) cron. 5분 미만 간격 불가.</p>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0 9,13,18 * * *"
              className="w-full text-xs font-mono border border-border rounded-md px-2 py-1 bg-background"
            />
            <div className="flex justify-end gap-1.5">
              <button
                onClick={() => setOpen(false)}
                className="px-2 py-1 text-xs bg-secondary hover:bg-secondary/80 border border-border rounded-md"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={mutation.isPending}
                className="px-2 py-1 text-xs font-semibold bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
              >
                저장
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function PlatformStatusMatrix() {
  const toast = useToast();
  const { data: grid, isLoading } = useCheckMatrixGrid();
  const reorderMut = useReorderCheckMatrixItems();
  const deleteMut = useDeleteCheckMatrixItem();
  const runClusterMut = useRunCheckMatrixCluster();
  const runItemMut = useRunCheckMatrixItem();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [formItem, setFormItem] = useState<CheckMatrixItem | null | 'new'>(null);
  const [deleteTarget, setDeleteTarget] = useState<CheckMatrixItem | null>(null);
  const [cellTarget, setCellTarget] = useState<{ item: CheckMatrixItem; cluster: CheckMatrixGridCluster } | null>(null);
  // 로그 패널은 두 가지로 쓰인다 — batch 가 있으면 방금 트리거한 일괄 수행 추적, 없으면 전체 로그.
  const [runLog, setRunLog] = useState<{ open: boolean; batchId?: string | null; label?: string | null }>(
    { open: false },
  );
  // 어느 열/행이 실행 중인지 — 버튼 스피너 표시용(mutation 은 전역 pending 만 주므로 대상 키를 따로 든다).
  const [runningKey, setRunningKey] = useState<string | null>(null);

  const items = grid?.items ?? [];
  const clusters = grid?.clusters ?? [];

  const handleRunCluster = async (cluster: CheckMatrixGridCluster) => {
    setRunningKey(`cluster:${cluster.id}`);
    try {
      const res = await runClusterMut.mutateAsync(cluster.id);
      toast.success(`${cluster.name} 전체 점검을 시작했습니다.`, `${res.queued}/${res.total}건 큐잉`);
      setRunLog({ open: true, batchId: res.batchId, label: `${cluster.name} 전체 실행` });
    } catch (e) {
      toast.error('실행 실패', formatApiError(e));
    } finally {
      setRunningKey(null);
    }
  };

  const handleRunItem = async (item: CheckMatrixItem) => {
    setRunningKey(`item:${item.id}`);
    try {
      const res = await runItemMut.mutateAsync(item.id);
      toast.success(`"${item.name}" 전 클러스터 점검을 시작했습니다.`, `${res.queued}/${res.total}건 큐잉`);
      setRunLog({ open: true, batchId: res.batchId, label: `${item.name} · 전 클러스터` });
    } catch (e) {
      toast.error('실행 실패', formatApiError(e));
    } finally {
      setRunningKey(null);
    }
  };

  const moveItem = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const reordered = [...items];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    reorderMut.mutate(reordered.map((i) => i.id));
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMut.mutateAsync(deleteTarget.id);
      toast.success('항목을 삭제했습니다.');
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 min-h-0">
      <MacCard bodyPadding="p-0" rootClassName="min-h-0">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
            플랫폼 현황
          </span>
          <button
            onClick={() => setHelpOpen(true)}
            className="p-0.5 rounded-full text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
            title="사용법 도움말"
            aria-label="사용법 도움말"
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>
          <span className="text-[11px] text-muted-foreground">항목 × 클러스터 점검 매트릭스</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={() => setRunLog({ open: true, batchId: null })}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md hover:bg-secondary transition-colors"
              title="모든 수행의 실행 로그"
              aria-label="모든 수행의 실행 로그"
            >
              <ScrollText className="w-3.5 h-3.5" /> 수행 로그
            </button>
            <button
              onClick={() => setFormItem('new')}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md hover:bg-secondary transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> 항목 추가
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-1.5 rounded-md hover:bg-secondary transition-colors text-muted-foreground"
              title="매트릭스 설정"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>

        {isLoading ? (
          // 실제 매트릭스 구조(항목 라벨 열 + 클러스터 셀 그리드)를 흉내낸 skeleton — 로드 전환 시 시프트 최소화
          <div className="p-3 space-y-2" aria-busy="true" aria-label="점검 매트릭스 불러오는 중">
            {Array.from({ length: 6 }).map((_, r) => (
              <div key={r} className="flex items-center gap-3">
                <Skeleton height={14} width="20%" className="flex-shrink-0" />
                <div className="flex-1 flex gap-3">
                  {Array.from({ length: 5 }).map((_, c) => (
                    <Skeleton key={c} height={24} className="flex-1" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 || clusters.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {clusters.length === 0 ? '등록된 클러스터가 없습니다.' : '점검 항목이 없습니다 — 우측 상단에서 추가하세요.'}
          </div>
        ) : (
          <div className="overflow-auto max-h-[520px]">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="sticky top-0 z-20 bg-card">
                  <th className="sticky left-0 z-30 bg-card border-b border-r border-border text-left px-3 py-2 min-w-[200px]">
                    점검 항목
                  </th>
                  {clusters.map((cluster) => (
                    <th key={cluster.id} className="border-b border-border px-3 py-2 min-w-[130px] font-medium">
                      <div className="flex flex-col items-center gap-1">
                        <div className="flex items-center gap-1 min-w-0">
                          <span className="truncate max-w-[120px]">{cluster.name}</span>
                          <button
                            onClick={() => handleRunCluster(cluster)}
                            disabled={runningKey === `cluster:${cluster.id}`}
                            title={`${cluster.name} 의 모든 점검 항목을 지금 실행`}
                            aria-label={`${cluster.name} 전체 점검 실행`}
                            className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-secondary transition-colors disabled:opacity-50 flex-shrink-0"
                          >
                            {runningKey === `cluster:${cluster.id}`
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <Play className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        <ClusterCronBadge cluster={cluster} />
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={item.id} className="group hover:bg-muted/30">
                    <td className="sticky left-0 z-10 bg-card group-hover:bg-muted/30 border-r border-b border-border px-3 py-1.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div className="flex flex-col -my-1 flex-shrink-0">
                          <button
                            onClick={() => moveItem(idx, -1)}
                            disabled={idx === 0}
                            className="text-muted-foreground hover:text-foreground disabled:opacity-20"
                          >
                            <ChevronUp className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => moveItem(idx, 1)}
                            disabled={idx === items.length - 1}
                            className="text-muted-foreground hover:text-foreground disabled:opacity-20"
                          >
                            <ChevronDown className="w-3 h-3" />
                          </button>
                        </div>
                        <span className="truncate flex-1 min-w-0" title={item.description ?? undefined}>
                          {item.name}
                        </span>
                        {item.isSystem && (
                          <span title="시스템 항목" className="flex-shrink-0">
                            <Lock className="w-3 h-3 text-muted-foreground" />
                          </span>
                        )}
                        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          {item.sourceType !== 'manual' && (
                            <button
                              onClick={() => handleRunItem(item)}
                              disabled={runningKey === `item:${item.id}`}
                              className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-primary disabled:opacity-50"
                              title="모든 클러스터에서 이 항목 실행"
                              aria-label="모든 클러스터에서 이 항목 실행"
                            >
                              {runningKey === `item:${item.id}`
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : <Play className="w-3 h-3" />}
                            </button>
                          )}
                          <button
                            onClick={() => setFormItem(item)}
                            className="p-1 rounded hover:bg-secondary text-muted-foreground"
                            title="수정"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          {!item.isSystem && (
                            <button
                              onClick={() => setDeleteTarget(item)}
                              className="p-1 rounded hover:bg-secondary text-red-500"
                              title="삭제"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    </td>
                    {clusters.map((cluster) => (
                      <td key={cluster.id} className="border-b border-border text-center">
                        <CellButton
                          item={item}
                          cell={grid?.cells[item.id]?.[cluster.id]}
                          onClick={() => setCellTarget({ item, cluster })}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </MacCard>

      <CheckMatrixSettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CheckMatrixHelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CheckMatrixRunLogPanel
        open={runLog.open}
        onClose={() => setRunLog({ open: false })}
        batchId={runLog.batchId}
        batchLabel={runLog.label}
      />
      <CheckMatrixItemFormModal
        isOpen={formItem !== null}
        onClose={() => setFormItem(null)}
        editingItem={formItem === 'new' ? null : formItem}
      />
      {cellTarget && (
        <CheckMatrixCellDetailModal
          item={cellTarget.item}
          cluster={cellTarget.cluster}
          cronExpr={grid?.cells[cellTarget.item.id]?.[cellTarget.cluster.id]?.cronExpr ?? null}
          scheduleEnabled={grid?.cells[cellTarget.item.id]?.[cellTarget.cluster.id]?.scheduleEnabled ?? false}
          onClose={() => setCellTarget(null)}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          open={!!deleteTarget}
          title="항목 삭제"
          description={`"${deleteTarget.name}" 항목을 삭제할까요? 이력도 함께 삭제됩니다.`}
          danger
          confirmLabel="삭제"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
