// 클러스터 요약 **압축 스트립** — 노드/NS/파드/할당·사용효율/여유·낭비/POD 상태를 한 줄(칩)로.
//
// 기존 요약은 큰 Stat 카드 7장 + POD 용량/상태 카드 2장이라 세로로 화면을 다 먹고, 정작 봐야 할
// "노드별 자원 / 네임스페이스별 자원" 탭이 접히는 선 아래로 밀려났다. 이 스트립이 기본이고,
// 큰 카드(SummarySection · PodCapacityStatusCards)는 "상세" 를 켰을 때만 펼친다.
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { useAllocNamespaces, usePodsSummary } from '@/hooks/useK8sAllocation';
import { fmtCores, fmtGi, fmtN, pctText, ratio } from './format';

/** 라벨 + 값 한 쌍의 초소형 칩. 세로 공간을 쓰지 않도록 한 줄(약 24px)로 유지한다. */
function Chip({ label, value, tone = 'default', title }: {
  label: string; value: string; tone?: 'default' | 'warn' | 'critical' | 'good' | 'info'; title?: string;
}) {
  const cls = tone === 'critical' ? 'text-status-critical'
    : tone === 'warn' ? 'text-status-warning'
    : tone === 'good' ? 'text-status-healthy'
    : tone === 'info' ? 'text-status-info'
    : 'text-foreground';
  return (
    <span className="inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded-lg bg-secondary/60" title={title}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold tabular-nums leading-none ${cls}`}>{value}</span>
    </span>
  );
}

export function SummaryStrip({ clusterId, expanded, onToggle }: {
  clusterId: string; expanded: boolean; onToggle: () => void;
}) {
  const { data, isError } = useAllocNamespaces(clusterId);
  const { data: podsSummary } = usePodsSummary(clusterId);
  const cap = podsSummary?.capacity;
  const counts = podsSummary?.statusCounts ?? {};
  const s = data?.summary;

  // 사용효율 경고 기준은 큰 카드(SummarySection)와 동일 — 30% 미만 낭비 / 105% 초과 위험.
  const tone = (r: number | null): 'default' | 'warn' | 'critical' =>
    (r == null ? 'default' : r > 1.05 ? 'critical' : r < 0.3 ? 'warn' : 'default');

  const cpuUseR = s?.cpuUsageM == null || !s ? null : ratio(s.cpuUsageM, s.cpuReqM);
  const memUseR = s?.memUsageB == null || !s ? null : ratio(s.memUsageB, s.memReqB);
  const cpuAllocR = s ? ratio(s.cpuReqM, s.cpuAllocM) : null;
  const memAllocR = s ? ratio(s.memReqB, s.memAllocB) : null;

  return (
    <div className="flex items-center gap-1.5 flex-wrap rounded-md border border-border bg-card px-2 py-1.5">
      {isError && !s ? (
        <span className="text-xs text-status-critical">클러스터 요약을 불러오지 못했습니다.</span>
      ) : !s ? (
        <span className="text-xs text-muted-foreground">요약 집계 중…</span>
      ) : (
        <>
          <Chip label="노드" value={fmtN(s.nodeCount)} />
          <Chip label="NS" value={fmtN(s.namespaceCount)} />
          <Chip label="파드" value={cap ? `${fmtN(s.podCount)}/${fmtN(cap.allocatablePods)}` : fmtN(s.podCount)}
            title="활성 파드 / 전체 노드 max-pods 합계" />
          {cap && <Chip label="배치여유" value={fmtN(cap.schedulableFreeSlots)} tone="info"
            title={`Ready·비cordon 노드(${cap.nodesSchedulable}/${cap.nodesTotal}) 기준 남은 스케줄 슬롯`} />}
          <span className="w-px h-4 bg-border" aria-hidden="true" />
          <Chip label="CPU 할당" value={pctText(s.cpuReqM, s.cpuAllocM)}
            tone={cpuAllocR != null && cpuAllocR < 0.5 ? 'warn' : 'default'}
            title={`request ${fmtCores(s.cpuReqM)} / allocatable ${fmtCores(s.cpuAllocM)}`} />
          <Chip label="MEM 할당" value={pctText(s.memReqB, s.memAllocB)}
            tone={memAllocR != null && memAllocR < 0.5 ? 'warn' : 'default'}
            title={`request ${fmtGi(s.memReqB)} / allocatable ${fmtGi(s.memAllocB)}`} />
          <Chip label="CPU 사용" value={cpuUseR == null ? '—' : pctText(s.cpuUsageM ?? 0, s.cpuReqM)}
            tone={tone(cpuUseR)} title="실사용 ÷ request" />
          <Chip label="MEM 사용" value={memUseR == null ? '—' : pctText(s.memUsageB ?? 0, s.memReqB)}
            tone={tone(memUseR)} title="실사용 ÷ request" />
          <span className="w-px h-4 bg-border" aria-hidden="true" />
          <Chip label="여유" value={`${fmtCores(Math.max(0, s.cpuAllocM - s.cpuReqM))} · ${fmtGi(Math.max(0, s.memAllocB - s.memReqB))}`}
            tone="good" title="할당 가용 = allocatable − request (추가 스케줄 가능한 자원)" />
          <Chip label="낭비"
            value={s.cpuUsageM == null || s.memUsageB == null
              ? '—'
              : `${fmtCores(Math.max(0, s.cpuReqM - s.cpuUsageM))} · ${fmtGi(Math.max(0, s.memReqB - s.memUsageB))}`}
            tone="warn" title="추정 낭비 = request − 실사용" />
          <span className="w-px h-4 bg-border" aria-hidden="true" />
          <Chip label="Run" value={fmtN(counts.running ?? 0)} tone="good" title="Running 파드" />
          <Chip label="Pend" value={fmtN(counts.pending ?? 0)}
            tone={(counts.pending ?? 0) > 0 ? 'warn' : 'default'} title="Pending 파드" />
          <Chip label="Err" value={fmtN(counts.error ?? 0)}
            tone={(counts.error ?? 0) > 0 ? 'critical' : 'default'} title="Error 상태 파드" />
          {s.noRequestPods > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg text-[11px] bg-status-warning/10 text-status-warning border border-status-warning/30"
              title="request 가 없는 파드는 스케줄러가 자원을 계산하지 못한다">
              <AlertTriangle className="w-3 h-3" /> req미설정 {fmtN(s.noRequestPods)}
            </span>
          )}
        </>
      )}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? '요약 상세 접기' : '요약 상세 펼치기 (효율 설명·POD 용량/상태·스케줄 계산기)'}
        className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded-lg border border-border"
      >
        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        요약 상세
      </button>
    </div>
  );
}
