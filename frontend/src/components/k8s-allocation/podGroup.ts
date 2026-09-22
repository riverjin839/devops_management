// 파드 목록 → 상위 워크로드 집계. 컴포넌트가 아닌 export 는 react-refresh 규칙상 별도 파일.
import type { AllocPodRow, AllocWorkloadRow } from '@/types';

/** 노드에 뜬 파드들을 상위 워크로드(ns/kind/name) 로 묶어 request·limit·usage 를 합산.
 * NS 드릴다운처럼 서버 집계를 다시 부르지 않고 이미 받은 파드 목록에서 파생한다. */
export function groupPodsByWorkload(pods: AllocPodRow[]): AllocWorkloadRow[] {
  const map = new Map<string, { row: AllocWorkloadRow; hasUsage: boolean }>();
  for (const p of pods) {
    const kind = p.ownerKind || 'Pod';
    const name = p.ownerName || p.name;
    const k = `${p.namespace}/${kind}/${name}`;
    let e = map.get(k);
    if (!e) {
      e = {
        row: {
          namespace: p.namespace, kind, name,
          podCount: 0, noRequestPods: 0,
          cpuReqM: 0, memReqB: 0, cpuLimM: 0, memLimB: 0,
          cpuUsageM: null, memUsageB: null,
        },
        hasUsage: false,
      };
      map.set(k, e);
    }
    const r = e.row;
    r.podCount += 1;
    if (p.cpuReqM === 0 && p.memReqB === 0) r.noRequestPods += 1;
    r.cpuReqM += p.cpuReqM; r.memReqB += p.memReqB;
    r.cpuLimM += p.cpuLimM; r.memLimB += p.memLimB;
    if (p.cpuUsageM != null || p.memUsageB != null) {
      e.hasUsage = true;
      r.cpuUsageM = (r.cpuUsageM ?? 0) + (p.cpuUsageM ?? 0);
      r.memUsageB = (r.memUsageB ?? 0) + (p.memUsageB ?? 0);
    }
  }
  const rows = [...map.values()].map((e) => e.row);
  rows.sort((a, b) => b.cpuReqM - a.cpuReqM || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
  return rows;
}

