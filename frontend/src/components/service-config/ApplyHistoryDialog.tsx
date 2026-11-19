// 적용 이력 — 실행 목록(상태·버전·대상·시작한 사람·시각) → 고르면 저장된 실행 로그와 노드별 결과.
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState, LogViewer, StatusBadge } from '@/components/common';
import { useServiceConfigApplyRun, useServiceConfigApplyRuns } from '@/hooks/useServiceConfig';
import { formatDateTime } from '@/lib/utils';
import { NodeResultsTable } from './ApplyRunPanel';
import { RUN_STATUS } from './runStatus';

const TH = 'text-left px-2 py-1.5 text-xs font-medium text-muted-foreground border-b border-border';
const TD = 'px-2 py-1.5 border-b border-border text-sm';

interface Props {
  open: boolean;
  clusterId: string;
  service: string;
  serviceLabel: string;
  onClose: () => void;
}

export function ApplyHistoryDialog({ open, clusterId, service, serviceLabel, onClose }: Props) {
  const runsQ = useServiceConfigApplyRuns(clusterId, service, open);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => { if (!open) setSelected(null); }, [open]);
  const detailQ = useServiceConfigApplyRun(clusterId, service, open ? selected : null);
  const detail = detailQ.data;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>적용 이력 — {serviceLabel}</DialogTitle>
          <DialogDescription>적용 1회마다 실행 로그와 노드별 결과가 1년간 남습니다. SSH 자격증명은 남지 않습니다.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[64vh] overflow-y-auto px-5 space-y-4">
          {runsQ.isLoading ? <LoadingState /> : runsQ.isError ? <ErrorState error={runsQ.error} title="이력을 불러오지 못했습니다" /> : (runsQ.data ?? []).length === 0 ? (
            <EmptyState compact title="아직 적용한 적이 없습니다" />
          ) : (
            <table className="w-full">
              <thead><tr><th className={TH}>시작</th><th className={TH}>버전</th><th className={TH}>대상</th><th className={TH}>상태</th><th className={TH}>시작한 사람</th><th className={TH}><span className="sr-only">보기</span></th></tr></thead>
              <tbody>
                {(runsQ.data ?? []).map((r) => {
                  const st = RUN_STATUS[r.status];
                  return (
                    <tr key={r.id} className={selected === r.id ? 'bg-primary/5' : ''}>
                      <td className={`${TD} text-xs`}>{r.startedAt ? formatDateTime(r.startedAt) : '—'}</td>
                      <td className={TD}>V{r.versionNo}</td>
                      <td className={`${TD} text-xs`}>{r.targetMode === 'nodes' ? `고른 노드 ${r.targets.length}` : `범위 전체 ${r.targets.length}`}</td>
                      <td className={TD}><StatusBadge variant={st.variant} label={st.label} /></td>
                      <td className={`${TD} text-xs`}>{r.startedBy ?? '—'}</td>
                      <td className={TD}>
                        <Button size="sm" variant="outline" onClick={() => setSelected(r.id)} aria-label={`${formatDateTime(r.startedAt ?? '')} 적용 상세`}>상세</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {selected && (detailQ.isLoading ? <LoadingState /> : detail ? (
            <div className="space-y-3">
              <NodeResultsTable run={detail} />
              <LogViewer text={(detail.logLines ?? []).map(([ts, level, msg]) => `${ts.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${msg}`).join('\n')} maxHeight="max-h-80" />
            </div>
          ) : null)}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>닫기</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
