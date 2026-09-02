// Pod 스케줄 가능 수 계산기 — "CPU x코어 / MEM yGi 인 Pod 를 현재 여유(allocatable−request)로 몇 개 스케줄 가능한가"
import { useMemo, useState } from 'react';
import { AlertTriangle, Cpu } from 'lucide-react';
import { useAllocNodes } from '@/hooks/useK8sAllocation';
import { fmtN } from './format';

export function PodScheduleCalc({ clusterId }: { clusterId: string }) {
  const { data, isError } = useAllocNodes(clusterId);
  const [cpu, setCpu] = useState('0.5');   // 코어
  const [mem, setMem] = useState('1');     // Gi

  const result = useMemo(() => {
    // `min="0"` 은 브라우저 UI 힌트일 뿐 실제 입력값을 막지 않는다 — 음수가 들어오면
    // 아래 나눗셈이 음수 fit 을 만들어 결과가 조용히 "0개"로 보이므로 여기서 명시적으로 clamp.
    const reqCpuM = Math.max(0, Math.round((parseFloat(cpu) || 0) * 1000));
    const reqMemB = Math.max(0, Math.round((parseFloat(mem) || 0) * 1024 ** 3));
    if (reqCpuM <= 0 && reqMemB <= 0) return null;
    const nodes = (data?.items ?? []).filter((n) => !n.unschedulable);
    let total = 0;
    const per: { name: string; fit: number; limit: 'cpu' | 'mem' | 'pods' }[] = [];
    for (const n of nodes) {
      const freeCpu = Math.max(0, n.cpuAllocM - n.cpuReqM);
      const freeMem = Math.max(0, n.memAllocB - n.memReqB);
      // max-pods(allocatable pods) 제약 — 0이면 미상 → 비제약
      const podsFree = n.podsAllocatable > 0 ? Math.max(0, n.podsAllocatable - n.podCount) : Infinity;
      const byCpu = reqCpuM > 0 ? Math.floor(freeCpu / reqCpuM) : Infinity;
      const byMem = reqMemB > 0 ? Math.floor(freeMem / reqMemB) : Infinity;
      const fit = Math.min(byCpu, byMem, podsFree);
      if (Number.isFinite(fit) && fit > 0) {
        // 어떤 축이 한도를 정했는지(동률이면 pods>cpu>mem 순으로 표기)
        const limit: 'cpu' | 'mem' | 'pods' = podsFree === fit ? 'pods' : byCpu === fit ? 'cpu' : 'mem';
        total += fit;
        per.push({ name: n.name, fit, limit });
      }
    }
    per.sort((a, b) => b.fit - a.fit);
    return { total, per, nodeCount: nodes.length };
  }, [data, cpu, mem]);

  const LIMIT_LABEL: Record<'cpu' | 'mem' | 'pods', string> = { cpu: 'CPU', mem: 'MEM', pods: 'max-pods' };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm border-t border-border pt-2">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Cpu className="w-4 h-4 text-status-info" /> Pod 스케줄 가능 수:
      </span>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        CPU
        <input type="number" min="0" step="0.1" value={cpu} onChange={(e) => setCpu(e.target.value)}
          className="w-16 px-1.5 py-0.5 rounded-lg border border-border bg-card text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary" /> 코어
      </label>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        MEM
        <input type="number" min="0" step="0.5" value={mem} onChange={(e) => setMem(e.target.value)}
          className="w-16 px-1.5 py-0.5 rounded-lg border border-border bg-card text-foreground tabular-nums focus:outline-none focus:ring-1 focus:ring-primary" /> Gi
      </label>
      {isError ? (
        <span className="inline-flex items-center gap-1 text-xs text-status-warning">
          <AlertTriangle className="w-3.5 h-3.5" /> 노드 자원을 불러오지 못해 계산할 수 없습니다.
        </span>
      ) : result ? (
        <>
          {/* 결과 + 마우스오버/포커스 시 배치 가능 노드 박스 */}
          <span className="relative group">
            <button type="button" title="배치 가능 노드 상세 보기" aria-label="배치 가능 노드 상세 보기"
              className="font-semibold tabular-nums text-status-info underline decoration-dotted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded">≈ {fmtN(result.total)}개</button>
            {result.per.length > 0 && (
              <div data-export-ignore
                className="hidden group-hover:block group-focus-within:block absolute left-0 top-full mt-1 z-50 w-72 max-h-72 overflow-auto
                  rounded-lg border border-border bg-card shadow-lg p-2 text-xs">
                <div className="text-muted-foreground mb-1">배치 가능 노드 (alloc−req · max-pods 기준)</div>
                {result.per.slice(0, 30).map((p) => (
                  <div key={p.name} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="font-mono truncate" title={p.name}>{p.name}</span>
                    <span className="shrink-0 tabular-nums">
                      <b className="text-status-info">{p.fit}</b>
                      <span className="ml-1 text-muted-foreground">제약:{LIMIT_LABEL[p.limit]}</span>
                    </span>
                  </div>
                ))}
                {result.per.length > 30 && (
                  <div className="text-muted-foreground pt-1">+{result.per.length - 30}개 노드 더…</div>
                )}
              </div>
            )}
          </span>
          <span className="text-xs text-muted-foreground">
            (배치 가능 노드 {result.per.length} / schedulable {result.nodeCount} · CPU/MEM/max-pods 반영 · 마우스오버로 노드별 보기)
          </span>
        </>
      ) : (
        <span className="text-xs text-muted-foreground">CPU/MEM 요청량을 입력하세요.</span>
      )}
    </div>
  );
}
