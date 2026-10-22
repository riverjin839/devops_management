// 클러스터 요약 **압축 스트립** — 위험 신호(있을 때만) → 용량 → 할당·사용 순으로 한 줄(칩)에.
//
// 기존 요약은 큰 Stat 카드 7장 + POD 용량/상태 카드 2장이라 세로로 화면을 다 먹고, 정작 봐야 할
// "노드별 자원 / 네임스페이스별 자원" 탭이 접히는 선 아래로 밀려났다. 이 스트립이 기본이고,
// 큰 카드(SummarySection · PodCapacityStatusCards)는 "상세" 를 켰을 때만 펼친다.
//
// 색 규칙(DESIGN_SYSTEM §12.12): 정상 값은 전부 중립. 상태색은 과할당·사용 초과·Pending·Error·request 미설정
// 처럼 "지금 손봐야 하는" 신호에만 쓰고, 색만으로 전달하지 않도록 경고 아이콘을 함께 그린다.
// 할당률이 낮은 것(여유)과 낭비는 비용 정보라 경고색을 쓰지 않는다.
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useAllocNamespaces, usePodsSummary } from '@/hooks/useK8sAllocation';
import { fmtCores, fmtGi, fmtN, pctText, ratio } from './format';

/** 라벨 + 값 한 쌍의 초소형 칩. 세로 공간을 쓰지 않도록 한 줄(약 24px)로 유지한다. */
function Chip({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded-lg bg-secondary/60" title={title}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums leading-none text-foreground">{value}</span>
    </span>
  );
}

/** 위험 신호 칩 — 눌러서 원인 목록으로 이동한다. 아이콘 + 글자로 전달(색 단독 금지). */
function AlertChip({ label, value, tone, title, onClick }: {
  label: string; value: string; tone: 'warning' | 'critical'; title: string; onClick?: () => void;
}) {
  const cls = tone === 'critical'
    ? 'bg-status-critical/10 text-status-critical border-status-critical/30'
    : 'bg-status-warning/10 text-status-warning border-status-warning/30';
  const body = (
    <>
      <AlertTriangle className="w-3 h-3 self-center" aria-hidden="true" />
      <span className="text-xs">{label}</span>
      <span className="text-sm font-semibold tabular-nums leading-none">{value}</span>
    </>
  );
  if (!onClick) {
    return <span className={`inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded-lg border ${cls}`} title={title}>{body}</span>;
  }
  return (
    <button type="button" onClick={onClick} title={title} aria-label={`${label} ${value} — ${title}`}
      className={`inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded-xl border hover:brightness-95 ${cls}`}>
      {body}
    </button>
  );
}

export function SummaryStrip({ clusterId, expanded, onToggle, onShowProblemNodes, onShowPodStatus, onShowNoRequest }: {
  clusterId: string; expanded: boolean; onToggle: () => void;
  /** 과할당 칩 → 노드 탭 "문제 노드만". */
  onShowProblemNodes?: () => void;
  /** Pending/Error 칩 → 요약 상세(Pod 상태 카드) 펼침. */
  onShowPodStatus?: () => void;
  /** request 미설정 칩 → 네임스페이스 탭. */
  onShowNoRequest?: () => void;
}) {
  const { data, isError } = useAllocNamespaces(clusterId);
  const { data: podsSummary } = usePodsSummary(clusterId);
  const cap = podsSummary?.capacity;
  const counts = podsSummary?.statusCounts ?? {};
  const s = data?.summary;

  const cpuUseR = s?.cpuUsageM == null || !s ? null : ratio(s.cpuUsageM, s.cpuReqM);
  const memUseR = s?.memUsageB == null || !s ? null : ratio(s.memUsageB, s.memReqB);
  const cpuAllocR = s ? ratio(s.cpuReqM, s.cpuAllocM) : null;
  const memAllocR = s ? ratio(s.memReqB, s.memAllocB) : null;
  const pending = counts.pending ?? 0;
  const errors = (counts.error ?? 0) + (counts.failed ?? 0);
  const over = (r: number | null, limit: number) => r != null && r > limit;

  return (
    <MacCard bodyPadding="px-2 py-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        {isError && !s ? (
          <span className="inline-flex items-center gap-1 text-xs text-status-critical" role="alert">
            <AlertTriangle className="w-3 h-3" aria-hidden="true" /> 클러스터 요약을 불러오지 못했습니다. 헤더의 새로고침으로 다시 집계하세요.
          </span>
        ) : !s ? (
          <span className="text-xs text-muted-foreground" role="status">요약 집계 중…</span>
        ) : (
          <>
            {/* 위험 신호 — 있을 때만, 맨 앞 */}
            {over(cpuAllocR, 1) && <AlertChip tone="critical" label="CPU 과할당" value={pctText(s.cpuReqM, s.cpuAllocM)}
              title="request 합계가 allocatable 을 넘었습니다 — 문제 노드 보기" onClick={onShowProblemNodes} />}
            {over(memAllocR, 1) && <AlertChip tone="critical" label="MEM 과할당" value={pctText(s.memReqB, s.memAllocB)}
              title="request 합계가 allocatable 을 넘었습니다 — 문제 노드 보기" onClick={onShowProblemNodes} />}
            {over(cpuUseR, 1.05) && <AlertChip tone="critical" label="CPU 사용 초과" value={pctText(s.cpuUsageM ?? 0, s.cpuReqM)}
              title="실사용이 request 를 넘었습니다(스로틀 위험) — 문제 노드 보기" onClick={onShowProblemNodes} />}
            {over(memUseR, 1.05) && <AlertChip tone="critical" label="MEM 사용 초과" value={pctText(s.memUsageB ?? 0, s.memReqB)}
              title="실사용이 request 를 넘었습니다(OOM 위험) — 문제 노드 보기" onClick={onShowProblemNodes} />}
            {errors > 0 && <AlertChip tone="critical" label="Pod 오류" value={fmtN(errors)}
              title="Error·Failed 상태 Pod — Pod 상태 상세 보기" onClick={onShowPodStatus} />}
            {pending > 0 && <AlertChip tone="warning" label="Pod 대기" value={fmtN(pending)}
              title="Pending 상태 Pod(스케줄 대기) — Pod 상태 상세 보기" onClick={onShowPodStatus} />}
            {s.noRequestPods > 0 && <AlertChip tone="warning" label="request 미설정" value={fmtN(s.noRequestPods)}
              title="request 가 없는 Pod 는 스케줄러가 자원을 계산하지 못합니다 — 네임스페이스별로 보기" onClick={onShowNoRequest} />}

            {/* 용량 */}
            <Chip label="노드" value={fmtN(s.nodeCount)} />
            <Chip label="NS" value={fmtN(s.namespaceCount)} />
            <Chip label="Pod" value={cap ? `${fmtN(s.podCount)}/${fmtN(cap.allocatablePods)}` : fmtN(s.podCount)}
              title="활성 Pod / 전체 노드 max-pods 합계" />
            {cap && <Chip label="배치 여유" value={fmtN(cap.schedulableFreeSlots)}
              title={`Ready·비cordon 노드(${cap.nodesSchedulable}/${cap.nodesTotal}) 기준 남은 스케줄 슬롯`} />}
            <span className="w-px h-4 bg-border" aria-hidden="true" />

            {/* 할당·사용 — 위 위험 칩으로 올라간 값은 여기서 다시 그리지 않는다 */}
            {!over(cpuAllocR, 1) && <Chip label="CPU 할당" value={pctText(s.cpuReqM, s.cpuAllocM)}
              title={`request ${fmtCores(s.cpuReqM)} / allocatable ${fmtCores(s.cpuAllocM)} · 여유 ${fmtCores(Math.max(0, s.cpuAllocM - s.cpuReqM))}`} />}
            {!over(memAllocR, 1) && <Chip label="MEM 할당" value={pctText(s.memReqB, s.memAllocB)}
              title={`request ${fmtGi(s.memReqB)} / allocatable ${fmtGi(s.memAllocB)} · 여유 ${fmtGi(Math.max(0, s.memAllocB - s.memReqB))}`} />}
            {!over(cpuUseR, 1.05) && <Chip label="CPU 사용" value={cpuUseR == null ? '—' : pctText(s.cpuUsageM ?? 0, s.cpuReqM)} title="실사용 ÷ request" />}
            {!over(memUseR, 1.05) && <Chip label="MEM 사용" value={memUseR == null ? '—' : pctText(s.memUsageB ?? 0, s.memReqB)} title="실사용 ÷ request" />}
            <Chip label="낭비"
              value={s.cpuUsageM == null || s.memUsageB == null
                ? '—'
                : `${fmtCores(Math.max(0, s.cpuReqM - s.cpuUsageM))} · ${fmtGi(Math.max(0, s.memReqB - s.memUsageB))}`}
              title="추정 낭비 = request − 실사용 (효율화 탭에서 축소 추천)" />
          </>
        )}

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          title={expanded ? '요약 상세 접기' : '요약 상세 펼치기 (효율 설명·Pod 용량/상태·스케줄 계산기)'}
          className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded-xl border border-border"
        >
          {expanded ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
          요약 상세
        </button>
      </div>
    </MacCard>
  );
}
