// 클러스터 요약 **압축 스트립** — 문제 신호(있을 때만) → 용량 한 줄 → 할당·사용 시트(CPU/MEM) 순.
//
// 기존 요약은 큰 Stat 카드 7장 + POD 용량/상태 카드 2장이라 세로로 화면을 다 먹고, 정작 봐야 할
// "노드별 자원 / 네임스페이스별 자원" 탭이 접히는 선 아래로 밀려났다. 이 스트립이 기본이고,
// 큰 카드(SummarySection · PodCapacityStatusCards)는 "상세" 를 켰을 때만 펼친다.
//
// 칩 나열 대신 정보 종류별로 나눈다 — 눌러서 목록을 여는 버튼 / 평문 용량 / 격자 시트.
// 색 규칙(DESIGN_SYSTEM §12.12): 정상 값은 전부 중립. 상태색은 과할당·Pending·Error·request 미설정
// 처럼 "지금 손봐야 하는" 신호의 아이콘·숫자에만 쓰고, 색만으로 전달하지 않도록 경고 아이콘을 함께 그린다.
import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useAllocNamespaces, usePodsSummary } from '@/hooks/useK8sAllocation';
import { fmtCores, fmtGi, fmtN, ratio } from './format';
import { fmtMetric, useMetricMode } from './metricMode';
import type { ProblemPodKind } from './ProblemPodsDialog';

/** 눌러서 원인 목록을 여는 문제 버튼 — 아이콘 + 글자 + 숫자(색 단독 금지). */
function TodoButton({ label, value, tone, title, onClick }: {
  label: string; value: string; tone: 'warning' | 'critical'; title: string; onClick?: () => void;
}) {
  const tc = tone === 'critical' ? 'text-status-critical' : 'text-status-warning';
  return (
    <button type="button" onClick={onClick} title={title} aria-label={`${label} ${value} — ${title}`}
      className="inline-flex items-center gap-1.5 px-1.5 py-px text-xs rounded-md border border-border bg-card hover:bg-secondary">
      <AlertTriangle className={`w-3 h-3 ${tc}`} aria-hidden="true" />
      {label}
      <b className={`tabular-nums ${tc}`}>{value}</b>
      <ChevronRight className="w-3 h-3 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

const TH = 'border border-border bg-secondary px-2 py-px font-semibold text-right';
const TD = 'border border-border px-2 py-px text-right tabular-nums';

export function SummaryStrip({ clusterId, expanded, onToggle, onShowProblemNodes, onShowProblemPods }: {
  clusterId: string; expanded: boolean; onToggle: () => void;
  /** 과할당 버튼 → 노드 탭 "문제 노드만". */
  onShowProblemNodes?: () => void;
  /** Pod 오류 / Pod 대기 / request 미설정 버튼 → 해당 Pod 목록 팝업. */
  onShowProblemPods?: (kind: ProblemPodKind) => void;
}) {
  const mode = useMetricMode();
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
  const over = (r: number | null) => r != null && r > 1;
  const cpuUse = s?.cpuUsageM ?? 0;
  const memUse = s?.memUsageB ?? 0;
  const hasTodo = !!s && (over(cpuAllocR) || over(memAllocR) || errors > 0 || pending > 0 || s.noRequestPods > 0);

  return (
    <MacCard bodyPadding="px-2 py-1.5">
      <div className="flex gap-2">
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {isError && !s ? (
            <span className="inline-flex items-center gap-1 text-xs text-status-critical" role="alert">
              <AlertTriangle className="w-3 h-3" aria-hidden="true" /> 클러스터 요약을 불러오지 못했습니다. 헤더의 새로고침으로 다시 집계하세요.
            </span>
          ) : !s ? (
            <span className="text-xs text-muted-foreground" role="status">요약 집계 중…</span>
          ) : (
            <>
              {hasTodo && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {over(cpuAllocR) && <TodoButton tone="critical" label="CPU 과할당" value={fmtMetric(mode, 'cpu', s.cpuReqM, s.cpuAllocM)}
                    title="request 합계가 allocatable 을 넘었습니다 — 문제 노드 보기" onClick={onShowProblemNodes} />}
                  {over(memAllocR) && <TodoButton tone="critical" label="MEM 과할당" value={fmtMetric(mode, 'mem', s.memReqB, s.memAllocB)}
                    title="request 합계가 allocatable 을 넘었습니다 — 문제 노드 보기" onClick={onShowProblemNodes} />}
                  {errors > 0 && <TodoButton tone="critical" label="Pod 오류" value={fmtN(errors)}
                    title="Error·Failed 상태 Pod — 목록 보기" onClick={() => onShowProblemPods?.('error')} />}
                  {pending > 0 && <TodoButton tone="warning" label="Pod 대기" value={fmtN(pending)}
                    title="Pending 상태 Pod(스케줄 대기) — 목록 보기" onClick={() => onShowProblemPods?.('pending')} />}
                  {s.noRequestPods > 0 && <TodoButton tone="warning" label="request 미설정" value={fmtN(s.noRequestPods)}
                    title="request 가 없는 Pod 는 스케줄러가 자원을 계산하지 못합니다 — 목록 보기" onClick={() => onShowProblemPods?.('norequest')} />}
                </div>
              )}

              <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-xs text-muted-foreground">
                <span>노드 <b className="text-foreground tabular-nums">{fmtN(s.nodeCount)}</b></span>
                <span>네임스페이스 <b className="text-foreground tabular-nums">{fmtN(s.namespaceCount)}</b></span>
                <span title="활성 Pod / 전체 노드 max-pods 합계">
                  Pod <b className="text-foreground tabular-nums">{cap ? `${fmtN(s.podCount)} / ${fmtN(cap.allocatablePods)}` : fmtN(s.podCount)}</b>
                </span>
                {cap && (
                  <span title={`Ready·비cordon 노드(${cap.nodesSchedulable}/${cap.nodesTotal})의 남은 Pod 개수 한도 — CPU·메모리 크기는 반영하지 않음`}>
                    <b className="text-foreground tabular-nums">{fmtN(cap.schedulableFreeSlots)}개</b> Pod 스케줄 가능
                  </span>
                )}
              </div>

              <table className="text-xs border-collapse w-fit">
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}><span className="sr-only">구분</span></th>
                    <th className={TH}>CPU</th>
                    <th className={TH}>MEM</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className={`${TD} text-left font-semibold bg-secondary`}>할당</td>
                    <td className={TD} title={`request ${fmtCores(s.cpuReqM)} / allocatable ${fmtCores(s.cpuAllocM)}`}>{fmtMetric(mode, 'cpu', s.cpuReqM, s.cpuAllocM)}</td>
                    <td className={TD} title={`request ${fmtGi(s.memReqB)} / allocatable ${fmtGi(s.memAllocB)}`}>{fmtMetric(mode, 'mem', s.memReqB, s.memAllocB)}</td>
                  </tr>
                  <tr>
                    <td className={`${TD} text-left font-semibold bg-secondary`}>사용</td>
                    <td className={TD} title={`실사용 ${fmtCores(cpuUse)} / request ${fmtCores(s.cpuReqM)}`}>{cpuUseR == null ? '—' : fmtMetric(mode, 'cpu', cpuUse, s.cpuReqM)}</td>
                    <td className={TD} title={`실사용 ${fmtGi(memUse)} / request ${fmtGi(s.memReqB)}`}>{memUseR == null ? '—' : fmtMetric(mode, 'mem', memUse, s.memReqB)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          title={expanded ? '요약 상세 접기' : '요약 상세 펼치기 (효율 설명·Pod 용량/상태·스케줄 계산기)'}
          className="self-start inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded-xl border border-border"
        >
          {expanded ? <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />}
          요약 상세
        </button>
      </div>
    </MacCard>
  );
}
