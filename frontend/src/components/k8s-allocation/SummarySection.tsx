// 클러스터 요약 카드 — 노드/NS/파드 수 + 할당·사용 효율 + 가용/낭비.
// 카드 프레임(MacCard)은 항상 렌더하고 내부만 로딩/실패/집계중/데이터로 교체한다 —
// 통째로 다른 컴포넌트로 바꾸면 폴링마다 높이가 달라져 화면이 흔들린다.
import { AlertTriangle, Cpu, Layers, PackageOpen, RefreshCw, Server, TrendingDown } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, Skeleton, SnapshotProgressCard } from '@/components/common';
import { useAllocNamespaces, usePodsSummary } from '@/hooks/useK8sAllocation';
import { fmtCores, fmtGi, fmtN, pctText, ratio } from './format';
import { Stat } from './primitives';
import { PodScheduleCalc } from './PodScheduleCalc';

export function SummarySection({ clusterId }: { clusterId: string }) {
  const { data, isLoading, isError, error } = useAllocNamespaces(clusterId);
  const { data: podsSummary } = usePodsSummary(clusterId);
  const cap = podsSummary?.capacity;

  let body: React.ReactNode;
  if (isLoading && !data) {
    body = <Skeleton className="h-16 w-full" />;
  } else if (isError && !data) {
    body = <EmptyState title="조회 실패" description={(error as Error)?.message ?? '클러스터 요약을 불러오지 못했습니다.'} />;
  } else if (data?.status === 'computing' && !data.items?.length) {
    body = (
      <SnapshotProgressCard processed={data.processed ?? 0} total={data.total ?? null}
        progress={data.progress ?? null} label="자원 집계 중" unit="Pod" />
    );
  } else if (!data) {
    body = <EmptyState title="데이터 없음" description="클러스터 요약을 표시할 수 없습니다." />;
  } else {
    const s = data.summary;
    const useEff = s.cpuUsageM == null ? null : ratio(s.cpuUsageM, s.cpuReqM);
    const memUseEff = s.memUsageB == null ? null : ratio(s.memUsageB, s.memReqB);
    const cpuWasteM = s.cpuUsageM == null ? null : Math.max(0, s.cpuReqM - s.cpuUsageM);
    const memWasteB = s.memUsageB == null ? null : Math.max(0, s.memReqB - s.memUsageB);
    // 전체 기준 할당 가용(여유) = allocatable − request → 추가로 스케줄 가능한 자원량.
    const cpuAvailM = Math.max(0, s.cpuAllocM - s.cpuReqM);
    const memAvailB = Math.max(0, s.memAllocB - s.memReqB);
    // 할당효율 경고 — CPU/MEM 동일 기준(alloc 미상 시 null → 경고 안 띄움, 0%로 오인 방지).
    const cpuAllocRatio = ratio(s.cpuReqM, s.cpuAllocM);
    const memAllocRatio = ratio(s.memReqB, s.memAllocB);
    // 사용효율 경고 — 30% 미만(낭비, 주황) / 105% 초과(스로틀·OOM 위험, 빨강).
    const usageWarn = (r: number | null): boolean | 'critical' => (r == null ? false : r > 1.05 ? 'critical' : r < 0.3 ? true : false);

    body = (
      <>
        <div className="grid grid-cols-3 lg:grid-cols-7 gap-2">
          <Stat label="노드" value={fmtN(s.nodeCount)} icon={<Server className="w-3.5 h-3.5" />} />
          <Stat label="네임스페이스" value={fmtN(s.namespaceCount)} icon={<Layers className="w-3.5 h-3.5" />} />
          <Stat label="파드 (활성)"
            value={cap ? `${fmtN(s.podCount)} / ${fmtN(cap.allocatablePods)}` : fmtN(s.podCount)}
            icon={<Cpu className="w-3.5 h-3.5" />}
            help={cap && (
              <div className="space-y-1.5">
                <p className="font-semibold text-foreground">파드 (활성)</p>
                <p><b>{fmtN(s.podCount)}</b> = 현재 활성 파드 수, <b>{fmtN(cap.allocatablePods)}</b> = 전체 노드
                  max-pods 합계(노드별 <code>allocatable.pods</code> × 노드 수).</p>
                <p>여유 <b>{fmtN(cap.schedulableFreeSlots)}개</b> = Ready·비cordon 노드({cap.nodesSchedulable}/{cap.nodesTotal})
                  기준 남은 스케줄 슬롯.</p>
              </div>
            )}
          />
          <Stat label="CPU 할당효율" value={pctText(s.cpuReqM, s.cpuAllocM)}
            sub={`req ${fmtCores(s.cpuReqM)} / alloc ${fmtCores(s.cpuAllocM)}`}
            warn={cpuAllocRatio != null && cpuAllocRatio < 0.5}
            help={
              <div className="space-y-1.5">
                <p className="font-semibold text-foreground">CPU 할당효율 (Allocation Efficiency)</p>
                <p className="text-primary">관점: <b>쿠버네티스 스케줄러 기준</b> — 파드를 더 배치(스케줄)할 여유가 있는지를 봅니다.</p>
                <p><b>= Request ÷ Allocatable × 100</b></p>
                <p>노드의 할당 가능 CPU 중 파드들이 <b>request로 예약</b>한 비율입니다.</p>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  <li>100% 초과 → 오버커밋 (스케줄 불가 위험)</li>
                  <li>50% 미만 → 할당 여유 많음 (주황 경고)</li>
                  <li>50–90% → 적정 범위</li>
                </ul>
              </div>
            }
          />
          <Stat label="MEM 할당효율" value={pctText(s.memReqB, s.memAllocB)}
            sub={`req ${fmtGi(s.memReqB)} / alloc ${fmtGi(s.memAllocB)}`}
            warn={memAllocRatio != null && memAllocRatio < 0.5}
            help={
              <div className="space-y-1.5">
                <p className="font-semibold text-foreground">MEM 할당효율 (Allocation Efficiency)</p>
                <p className="text-primary">관점: <b>쿠버네티스 스케줄러 기준</b> — 파드를 더 배치(스케줄)할 여유가 있는지를 봅니다.</p>
                <p><b>= Request ÷ Allocatable × 100</b></p>
                <p>노드의 할당 가능 메모리 중 파드들이 <b>request로 예약</b>한 비율입니다.</p>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  <li>100% 초과 → 오버커밋 (OOM 위험)</li>
                  <li>50% 미만 → 메모리 여유 많음</li>
                </ul>
              </div>
            }
          />
          <Stat label="CPU 사용효율" value={useEff == null ? '—' : pctText(s.cpuUsageM ?? 0, s.cpuReqM)}
            sub={s.cpuUsageM == null ? '드릴다운에서 확인' : `use ${fmtCores(s.cpuUsageM)}`}
            warn={usageWarn(useEff)}
            help={
              <div className="space-y-1.5">
                <p className="font-semibold text-foreground">CPU 사용효율 (Usage Efficiency)</p>
                <p className="text-primary">관점: <b>노드 실사용(모니터링) 기준</b> — 예약해둔 자원을 실제로 얼마나 쓰고 있는지를 봅니다.</p>
                <p><b>= 실사용량 ÷ Request × 100</b></p>
                <p>request로 예약한 CPU 중 실제로 <b>사용 중인</b> 비율입니다.</p>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  <li>30% 미만 → request 과대 설정 (낭비, 주황 경고)</li>
                  <li>105% 초과 → 실사용이 request 초과 (스로틀 위험, 빨강 경고)</li>
                  <li>30–105% → 적정 범위</li>
                </ul>
                <p className="text-muted-foreground">※ 메트릭 서버 없으면 표시 불가</p>
              </div>
            }
          />
          <Stat label="MEM 사용효율" value={memUseEff == null ? '—' : pctText(s.memUsageB ?? 0, s.memReqB)}
            sub={s.memUsageB == null ? '드릴다운에서 확인' : `use ${fmtGi(s.memUsageB)}`}
            warn={usageWarn(memUseEff)}
            help={
              <div className="space-y-1.5">
                <p className="font-semibold text-foreground">MEM 사용효율 (Usage Efficiency)</p>
                <p className="text-primary">관점: <b>노드 실사용(모니터링) 기준</b> — 예약해둔 자원을 실제로 얼마나 쓰고 있는지를 봅니다.</p>
                <p><b>= 실사용량 ÷ Request × 100</b></p>
                <p>request로 예약한 메모리 중 실제로 <b>사용 중인</b> 비율입니다.</p>
                <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                  <li>30% 미만 → request 과대 설정 (낭비, 주황 경고)</li>
                  <li>105% 초과 → 실사용이 request 초과 (OOM 위험, 빨강 경고)</li>
                  <li>30–105% → 적정 범위</li>
                </ul>
                <p className="text-muted-foreground">※ 메트릭 서버 없으면 표시 불가</p>
              </div>
            }
          />
        </div>

        {/* Pod 스케줄 가능 수 계산기 (MEM 할당효율 아래) */}
        <PodScheduleCalc clusterId={clusterId} />
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm border-t border-border pt-2">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <PackageOpen className="w-4 h-4 text-status-healthy" /> 할당 가용(여유 = alloc − req):
          </span>
          <span className="font-semibold tabular-nums text-status-healthy">CPU {fmtCores(cpuAvailM)}</span>
          <span className="font-semibold tabular-nums text-status-healthy">MEM {fmtGi(memAvailB)}</span>
          <span className="text-xs text-muted-foreground">· 추가 스케줄 가능한 자원 (request 미반영분)</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm border-t border-border pt-2">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <TrendingDown className="w-4 h-4 text-status-warning" /> 추정 낭비(slack=req−use):
          </span>
          <span className="font-semibold tabular-nums">CPU {cpuWasteM == null ? '—' : fmtCores(cpuWasteM)}</span>
          <span className="font-semibold tabular-nums">MEM {memWasteB == null ? '—' : fmtGi(memWasteB)}</span>
          {s.noRequestPods > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-status-warning/10 text-status-warning border border-status-warning/30">
              <AlertTriangle className="w-3 h-3" /> request 미설정 파드 {fmtN(s.noRequestPods)}개
            </span>
          )}
          {data.partial && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-status-info/10 text-status-info border border-status-info/30">
              <RefreshCw className="w-3 h-3 animate-spin" /> 누적 집계 중 — 부분 결과(완료 시 확정)
            </span>
          )}
          {data.podUsageSkipped && (
            <span className="text-xs text-muted-foreground">· 메트릭 서버 미가용 — 사용량(use) 미표시</span>
          )}
        </div>
      </>
    );
  }

  return (
    <MacCard title="클러스터 요약" bodyPadding="p-3">
      <div className="min-h-16">{body}</div>
    </MacCard>
  );
}
