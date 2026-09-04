// 적용 확인 다이얼로그 — before/after 목록 + dry-run(기본 on) + "로그 보기" 기본 설정.
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common';
import type { EffRecommendation } from '@/types';
import { readLogPref, writeLogPref } from './effUtils';

export function ApplyDialog({ open, recs, onConfirm, onCancel }: {
  open: boolean; recs: EffRecommendation[];
  onConfirm: (dryRun: boolean) => void; onCancel: () => void;
}) {
  const [dryRun, setDryRun] = useState(true);
  const [showLog, setShowLog] = useState<boolean>(() => readLogPref());
  const grouped = new Map<string, EffRecommendation[]>();
  for (const r of recs) {
    const k = `${r.kind}/${r.namespace}/${r.name}:${r.container}`;
    grouped.set(k, [...(grouped.get(k) ?? []), r]);
  }
  return (
    <ConfirmDialog
      open={open}
      title={dryRun ? 'request 축소 — 드라이런(검증만)' : 'request 축소 적용'}
      description={dryRun
        ? 'apiserver 에 dry-run 으로 보내 유효성만 검증합니다. 실제 변경은 없습니다.'
        : '선택한 워크로드의 컨테이너 request 를 패치합니다. 롤링 재시작이 발생할 수 있으며, before 값은 실행 로그에 남아 롤백할 수 있습니다.'}
      confirmLabel={dryRun ? '드라이런 실행' : '적용 실행'}
      danger={!dryRun}
      onConfirm={() => { writeLogPref(showLog); onConfirm(dryRun); }}
      onCancel={onCancel}
    >
      <div className="space-y-2 text-sm">
        <div className="max-h-56 overflow-auto rounded-lg border border-border">
          {[...grouped.entries()].map(([k, rs]) => (
            <div key={k} className="px-2 py-1.5 border-b border-border/60 last:border-b-0">
              <div className="font-mono text-xs truncate" title={k}>{k}</div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {rs.map((r) => (
                  <span key={r.id} className="mr-3">
                    {r.resource === 'cpu' ? 'CPU' : 'MEM'} <span className="line-through">{r.currentReqDisplay}</span> → <b className="text-foreground">{r.targetReqDisplay}</b>
                    {r.targetLim != null && ' (limit 동반)'}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} className="accent-primary" />
          드라이런(검증만, 변경 없음)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={showLog} onChange={(e) => setShowLog(e.target.checked)} className="accent-primary" />
          실행 후 실시간 로그 보기
        </label>
      </div>
    </ConfirmDialog>
  );
}
