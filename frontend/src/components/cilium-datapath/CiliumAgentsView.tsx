// 프로그램·에이전트 — 노드별 에이전트 상태·커널 기능 표 + 선택한 노드의 BPF 프로그램 목록(기준 대비 변경).
// 기준(baseline)은 첫 보고 때 잡히고, 「현재를 기준으로」 로 다시 잡는다 — Cilium 설정 적용 직전에 누르면 전후 비교가 된다.
import { useState } from 'react';
import { Cpu, ListTree, Trash2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, EmptyState, StatusBadge, useToast } from '@/components/common';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useDeleteCiliumBpfAgent, useSetCiliumProgramBaseline } from '@/hooks/useCiliumDatapath';
import { formatApiError, formatRelativeTime } from '@/lib/utils';
import type { CiliumBpfAgent, CiliumBpfProgram, CiliumDatapathView } from '@/types';

function Flag({ ok, warnWhenMissing = false, label }: { ok: boolean | undefined; warnWhenMissing?: boolean; label?: string }) {
  if (ok) return <span className="text-xs text-foreground">{label ?? '있음'}</span>;
  return warnWhenMissing
    ? <StatusBadge variant="warning" label="없음" size="sm" />
    : <span className="text-xs text-muted-foreground">없음</span>;
}

function stateCell(a: CiliumBpfAgent) {
  if (a.state === 'reporting') return <span className="text-xs text-foreground">보고 중</span>;
  if (a.state === 'offline') return <StatusBadge variant="critical" label="무응답" size="sm" />;
  return <StatusBadge variant="pending" label="보고 없음" size="sm" />;
}

const DIFF: Record<CiliumBpfProgram['diff'], { text: string; variant?: 'warning' | 'info' }> = {
  same: { text: '같음' },
  changed: { text: '바뀜(다시 로드)', variant: 'warning' },
  new: { text: '새로 붙음', variant: 'info' },
  removed: { text: '사라짐' },
};

function avgRunTime(p: CiliumBpfProgram): string {
  if (!p.runCnt || p.runTimeNs === null) return '—';
  return `${Math.round(p.runTimeNs / p.runCnt).toLocaleString('ko-KR')}ns`;
}

function ProgramsCard({ agent, clusterId, sysAdmin, onInstall }: {
  agent: CiliumBpfAgent; clusterId: string; sysAdmin: boolean; onInstall: () => void;
}) {
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);
  const baseline = useSetCiliumProgramBaseline(clusterId);
  const statsOff = agent.features.bpfStatsEnabled === false;

  const onBaseline = async () => {
    try {
      await baseline.mutateAsync(agent.id);
      toast.success('비교 기준을 저장했습니다', `${agent.node} 의 현재 프로그램 목록이 기준이 됩니다.`);
    } catch (e) {
      toast.error('기준 저장 실패', formatApiError(e));
    }
  };

  return (
    <MacCard
      title={`${agent.node} · BPF 프로그램`}
      icon={ListTree}
      description={agent.baselineAt ? `기준 ${formatRelativeTime(agent.baselineAt)} 저장` : '기준 없음'}
      actions={(
        <Button size="sm" variant="outline" disabled={!canOperate || baseline.isPending || agent.programs.length === 0}
          onClick={() => { void onBaseline(); }}
          title={withHint('현재 프로그램 목록을 비교 기준으로 저장 — Cilium 설정 적용 직전에 누르면 전후 비교가 된다')}
          aria-label={ariaWithHint('현재를 기준으로')}>
          현재를 기준으로
        </Button>
      )}
      bodyPadding="p-0"
    >
      {agent.programsError ? (
        <EmptyState compact icon={ListTree} title="프로그램 목록을 읽지 못했습니다" description={agent.programsError} />
      ) : agent.programs.length === 0 ? (
        <EmptyState compact icon={ListTree}
          title={sysAdmin ? '보고된 프로그램이 없습니다' : '프로그램 목록은 수집하지 않습니다'}
          description={sysAdmin
            ? '이름 접두어(설정)에 맞는 프로그램이 없거나 에이전트가 아직 다음 보고를 하지 않았습니다.'
            : '프로그램 목록은 CAP_SYS_ADMIN 이 필요합니다. 설정에서 「CAP_SYS_ADMIN 부여」 를 켜고 매니페스트를 다시 적용하세요.'}
          action={sysAdmin ? undefined : { label: '에이전트 설치·설정으로', onClick: onInstall, variant: 'secondary' }} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th scope="col" className="px-4 py-2 font-medium">프로그램</th>
                <th scope="col" className="px-2 py-2 font-medium">유형</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">개수</th>
                <th scope="col" className="px-2 py-2 font-medium">tag</th>
                <th scope="col" className="px-2 py-2 font-medium">마지막 로드</th>
                <th scope="col" className="px-2 py-2 font-medium" title={statsOff ? 'kernel.bpf_stats_enabled 가 꺼져 있어 수집되지 않음' : undefined}>평균 실행 시간</th>
                <th scope="col" className="px-4 py-2 font-medium">기준 대비</th>
              </tr>
            </thead>
            <tbody>
              {agent.programs.map((p) => {
                const d = DIFF[p.diff];
                return (
                  <tr key={`${p.name}-${p.diff}`} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-mono text-xs">{p.name}</td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">{p.progType}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{p.count}</td>
                    <td className="px-2 py-2 font-mono text-xs text-muted-foreground" title={p.tags.join(', ')}>
                      {p.tags[0] ?? '—'}{p.tags.length > 1 ? ` 외 ${p.tags.length - 1}` : ''}
                    </td>
                    <td className="px-2 py-2 text-xs">{p.loadedAt ? new Date(p.loadedAt).toLocaleString('ko-KR') : '—'}</td>
                    <td className="px-2 py-2 text-xs tabular-nums">{avgRunTime(p)}</td>
                    <td className="px-4 py-2">
                      {d.variant ? <StatusBadge variant={d.variant} label={d.text} size="sm" icon={false} />
                        : <span className="text-xs text-muted-foreground">{d.text}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-4 py-2 text-xs text-muted-foreground">
            이름 접두어 밖의 프로그램 {agent.programsOther}개는 목록에서 뺐다.
            {statsOff && ' 실행 시간은 노드의 kernel.bpf_stats_enabled 가 1 일 때만 집계된다.'}
          </p>
        </div>
      )}
    </MacCard>
  );
}

export function CiliumAgentsView({ view, clusterId, onInstall }: { view: CiliumDatapathView; clusterId: string; onInstall: () => void }) {
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);
  const del = useDeleteCiliumBpfAgent(clusterId);
  const [selected, setSelected] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CiliumBpfAgent | null>(null);
  const agents = view.agents;
  const current = agents.find((a) => a.node === selected) ?? agents[0];

  const onRemove = async () => {
    if (!removing) return;
    try {
      await del.mutateAsync(removing.id);
      toast.success('목록에서 지웠습니다', removing.node);
      setRemoving(null);
    } catch (e) {
      toast.error('지우기 실패', formatApiError(e));
    }
  };

  return (
    <div className="space-y-4">
      <MacCard title="노드 에이전트" icon={Cpu} description="행을 누르면 아래에 그 노드의 프로그램 목록" bodyPadding="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th scope="col" className="px-4 py-2 font-medium">노드</th>
                <th scope="col" className="px-2 py-2 font-medium">상태</th>
                <th scope="col" className="px-2 py-2 font-medium">커널</th>
                <th scope="col" className="px-2 py-2 font-medium" title="고정 맵을 읽기 전용으로 여는 권한(5.8+)">CAP_BPF</th>
                <th scope="col" className="px-2 py-2 font-medium" title="프로그램 목록·고정되지 않은 맵 조회">CAP_SYS_ADMIN</th>
                <th scope="col" className="px-2 py-2 font-medium" title="커널 드롭 사유(skb:kfree_skb reason, 5.17+) — 다음 단계 드롭 관측의 전제">drop reason</th>
                <th scope="col" className="px-2 py-2 font-medium">bpf_stats</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">맵</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">수집</th>
                <th scope="col" className="px-2 py-2 font-medium">오류</th>
                <th scope="col" className="px-4 py-2 font-medium"><span className="sr-only">동작</span></th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const on = current?.id === a.id;
                const f = a.features;
                return (
                  <tr key={a.id} className={`border-b border-border last:border-0 ${on ? 'bg-muted/40' : ''}`}>
                    <td className="px-4 py-2">
                      <button type="button" className="font-mono text-xs font-semibold text-primary hover:underline"
                        aria-pressed={on} onClick={() => setSelected(a.node)}>
                        {a.node}
                      </button>
                      <span className="block text-xs text-muted-foreground">{a.hostIp ?? ''}{a.agentVersion ? ` · v${a.agentVersion}` : ''}</span>
                    </td>
                    <td className="px-2 py-2">
                      {stateCell(a)}
                      {a.lastSeenAt && <span className="block text-xs text-muted-foreground">{formatRelativeTime(a.lastSeenAt)}</span>}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs">{f.kernel || '—'}</td>
                    <td className="px-2 py-2"><Flag ok={f.capBpf} warnWhenMissing={!f.capSysAdmin} /></td>
                    <td className="px-2 py-2"><Flag ok={f.capSysAdmin} /></td>
                    <td className="px-2 py-2"><Flag ok={f.kernelDropReason} label="지원" /></td>
                    <td className="px-2 py-2"><Flag ok={f.bpfStatsEnabled} label="켜짐" /></td>
                    <td className="px-2 py-2 text-right tabular-nums text-xs" title={`항목 수를 세지 않은 배열류 ${a.mapsSkipped}개`}>
                      {a.maps.length}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-xs">{a.collectMs === null ? '—' : `${a.collectMs}ms`}</td>
                    <td className="px-2 py-2 text-xs">
                      {a.errors.length
                        ? <span className="text-status-warning" title={a.errors.join('\n')}>{a.errors.length}건</span>
                        : <span className="text-muted-foreground">없음</span>}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button type="button" disabled={!canOperate}
                        onClick={() => setRemoving(a)}
                        title={withHint('목록에서 지우기(없앤 노드 정리)')} aria-label={ariaWithHint(`${a.node} 에이전트 목록에서 지우기`)}
                        className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </MacCard>

      {current && <ProgramsCard agent={current} clusterId={clusterId} sysAdmin={view.settings.sysAdmin} onInstall={onInstall} />}

      <ConfirmDialog
        open={!!removing}
        danger
        title="에이전트를 목록에서 지울까요?"
        description={removing ? `${removing.node} 의 맵·프로그램 요약을 지우고 열린 사용률 알람을 닫습니다. 노드가 살아 있으면 다음 보고 때 다시 나타납니다.` : undefined}
        confirmLabel="지우기"
        busy={del.isPending}
        onConfirm={() => { void onRemove(); }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
