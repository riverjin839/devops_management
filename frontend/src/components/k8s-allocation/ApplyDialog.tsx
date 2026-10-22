// 적용 확인 다이얼로그 — before/after 목록 + 영향 요약 + 드라이런(열 때마다 on) + "로그 보기" 기본 설정.
// 호출부는 열 때만 마운트한다 — 드라이런 체크가 이전 실제 적용 상태로 남지 않게(열 때마다 초기화).
import { useState } from 'react';
import { ConfirmDialog } from '@/components/common';
import type { EffRecommendation } from '@/types';
import { readLogPref, writeLogPref } from './effUtils';
import { fmtCores, fmtGi, fmtN } from './format';

export function ApplyDialog({ recs, dryRunDone, onConfirm, onCancel }: {
  recs: EffRecommendation[];
  /** 지금 선택이 직전 드라이런과 같은 대상인지 — 실제 적용 전에 로그 확인을 안내한다. */
  dryRunDone: boolean;
  onConfirm: (dryRun: boolean) => void; onCancel: () => void;
}) {
  const [dryRun, setDryRun] = useState(true);
  const [showLog, setShowLog] = useState<boolean>(() => readLogPref());
  const grouped = new Map<string, EffRecommendation[]>();
  for (const r of recs) {
    const k = `${r.kind}/${r.namespace}/${r.name}:${r.container}`;
    grouped.set(k, [...(grouped.get(k) ?? []), r]);
  }
  // 워크로드 단위 영향 — 같은 워크로드의 CPU/MEM 추천은 한 번의 롤링 재시작으로 묶인다.
  const workloads = new Map<string, number>();
  for (const r of recs) workloads.set(`${r.kind}/${r.namespace}/${r.name}`, r.podCount);
  const podTotal = [...workloads.values()].reduce((a, b) => a + b, 0);
  const cpuSavings = recs.filter((r) => r.resource === 'cpu').reduce((a, r) => a + r.savings, 0);
  const memSavings = recs.filter((r) => r.resource === 'memory').reduce((a, r) => a + r.savings, 0);

  return (
    <ConfirmDialog
      open
      title={dryRun ? 'request 축소 — 드라이런(검증만)' : 'request 축소 적용'}
      description={dryRun
        ? 'apiserver 에 드라이런으로 보내 유효성만 검증합니다. 실제 변경은 없습니다.'
        : '선택한 워크로드의 컨테이너 request 를 패치합니다. 롤링 재시작이 발생할 수 있으며, 이전 값은 실행 로그에 남아 롤백할 수 있습니다.'}
      confirmLabel={dryRun ? '드라이런 실행' : '적용 실행'}
      danger={!dryRun}
      onConfirm={() => { writeLogPref(showLog); onConfirm(dryRun); }}
      onCancel={onCancel}
    >
      <div className="space-y-2 text-sm">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs">
          <dt className="text-muted-foreground">대상 워크로드</dt>
          <dd className="tabular-nums text-right text-foreground">{fmtN(workloads.size)}개 · Pod {fmtN(podTotal)}개</dd>
          <dt className="text-muted-foreground">절감 합계</dt>
          <dd className="tabular-nums text-right text-foreground">CPU {fmtCores(cpuSavings)} · MEM {fmtGi(memSavings)}</dd>
        </dl>
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
        {dryRunDone && (
          <p className="text-xs text-muted-foreground">
            이 대상으로 방금 드라이런을 실행했습니다. 실행 로그에서 결과를 확인한 뒤 드라이런을 끄고 실제 적용하세요.
          </p>
        )}
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
