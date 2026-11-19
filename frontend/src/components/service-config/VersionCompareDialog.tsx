// 버전 비교 — 두 버전의 값 차이(변경·추가·삭제)와 "이 버전 값으로 되돌리기(새 버전)".
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/common';
import { useServiceConfigCompare } from '@/hooks/useServiceConfig';
import type { ServiceConfigVersionInfo } from '@/types';

const TH = 'text-left px-2 py-1.5 text-xs font-medium text-muted-foreground border-b border-border';
const TD = 'px-2 py-1.5 border-b border-border align-top';
const SELECT = 'px-2 py-1 text-sm rounded-xl border border-border bg-card text-foreground';
const CHANGE: Record<string, string> = { changed: '변경', added: '추가', removed: '삭제' };
const STATUS: Record<string, string> = { imported: '가져옴', saved: '저장됨·미적용', applied: '적용됨', superseded: '대체됨' };

interface Props {
  open: boolean;
  clusterId: string;
  service: string;
  groupId: string | null;
  versions: ServiceConfigVersionInfo[];
  initialA: number | null;
  initialB: number | null;
  canRevert: boolean;
  revertHint?: string;
  onClose: () => void;
  onRevert: (versionNo: number) => void;
}

export function VersionCompareDialog({
  open, clusterId, service, groupId, versions, initialA, initialB, canRevert, revertHint, onClose, onRevert,
}: Props) {
  const [a, setA] = useState<number | null>(initialA);
  const [b, setB] = useState<number | null>(initialB);
  useEffect(() => {
    if (open) { setA(initialA); setB(initialB); }
  }, [open, initialA, initialB]);
  const q = useServiceConfigCompare(clusterId, service, a, b, groupId, open);
  const label = (v: ServiceConfigVersionInfo) => `V${v.versionNo} · ${STATUS[v.status] ?? v.status}${v.createdBy ? ` · ${v.createdBy}` : ''}`;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>버전 비교</DialogTitle>
          <DialogDescription>되돌리기는 고른 버전의 값으로 새 버전을 저장할 뿐이고, 노드 반영은 적용으로 따로 합니다.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 pb-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select className={SELECT} aria-label="왼쪽 버전" value={a ?? ''} onChange={(e) => setA(Number(e.target.value))}>
              {versions.map((v) => <option key={v.id} value={v.versionNo}>{label(v)}</option>)}
            </select>
            <span className="text-muted-foreground">↔</span>
            <select className={SELECT} aria-label="오른쪽 버전" value={b ?? ''} onChange={(e) => setB(Number(e.target.value))}>
              {versions.map((v) => <option key={v.id} value={v.versionNo}>{label(v)}</option>)}
            </select>
          </div>
          <div className="max-h-[50vh] overflow-y-auto">
            {q.isLoading ? <LoadingState /> : q.isError ? <ErrorState error={q.error} title="비교하지 못했습니다" /> : !q.data || q.data.rows.length === 0 ? (
              <EmptyState compact title="두 버전의 값이 같습니다" />
            ) : (
              <table className="w-full text-sm">
                <thead><tr><th className={TH}>키</th><th className={TH}>V{a}</th><th className={TH}>V{b}</th><th className={TH}>구분</th></tr></thead>
                <tbody>
                  {q.data.rows.map((r) => (
                    <tr key={r.key}>
                      <td className={`${TD} font-mono text-xs break-all`}>{r.key}{r.section && <span className="block font-sans text-muted-foreground">{r.section}</span>}</td>
                      <td className={`${TD} font-mono text-xs text-muted-foreground break-all`}>{r.a ?? '—'}</td>
                      <td className={`${TD} font-mono text-xs font-semibold break-all`}>{r.b ?? '—'}</td>
                      <td className={`${TD} text-xs`}>{CHANGE[r.change] ?? r.change}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>닫기</Button>
          {a != null && versions[0] && a !== versions[0].versionNo && (
            <Button variant="outline" disabled={!canRevert} title={canRevert ? undefined : revertHint}
              aria-label={canRevert ? `V${a} 값으로 되돌리기` : `V${a} 값으로 되돌리기 — ${revertHint ?? ''}`}
              onClick={() => onRevert(a)}>
              V{a} 값으로 되돌리기 (새 버전)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
