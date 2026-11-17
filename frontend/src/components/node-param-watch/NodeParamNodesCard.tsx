// 노드별 에이전트 상태 + 파라미터 판정. 정상은 중립색, 비정상(위반·불일치·무응답)만 상태색(§12.12-3).
import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search, Server, Trash2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ConfirmDialog, EmptyState, StatusBadge, useToast } from '@/components/common';
import type { StatusVariant } from '@/components/common';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useDeleteNodeParamAgent } from '@/hooks/useNodeParamWatch';
import { formatApiError, formatDateTime, formatRelativeTime } from '@/lib/utils';
import type { NodeParamAgentState, NodeParamNode, NodeParamStatus } from '@/types';

const TH = 'text-left px-3 py-2 text-xs font-medium text-muted-foreground';
const TD = 'px-3 py-2 align-top';

const AGENT_STATE: Record<NodeParamAgentState, { variant: StatusVariant; label: string }> = {
  reporting: { variant: 'healthy', label: '보고 중' },
  late: { variant: 'warning', label: '보고 지연' },
  offline: { variant: 'critical', label: '무응답' },
  unknown: { variant: 'pending', label: '보고 없음' },
};

const OP_TEXT: Record<string, string> = { eq: '=', ne: '≠', gte: '≥', lte: '≤', in: '∈' };

function expectedText(p: NodeParamStatus): string {
  if (p.operator === 'any') return '변경 추적';
  return `${OP_TEXT[p.operator] ?? p.operator} ${p.expected ?? ''}`;
}

function paramVerdict(p: NodeParamStatus): { variant: StatusVariant; label: string; title?: string } {
  if (!p.reported) return { variant: 'pending', label: '미보고', title: p.reason };
  if (!p.ok) return { variant: p.severity === 'critical' ? 'critical' : 'warning', label: '기준 위반', title: p.reason };
  if (!p.persistedOk) return { variant: 'warning', label: '영구 설정 불일치', title: '재부팅하면 영구 설정 값으로 돌아갑니다' };
  return { variant: 'healthy', label: '정상' };
}

function ParamTable({ params }: { params: NodeParamStatus[] }) {
  if (params.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">이 노드에 적용되는 감시 규칙이 없다.</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className={TH}>파라미터</th>
          <th className={TH}>현재 값</th>
          <th className={TH}>영구 설정</th>
          <th className={TH}>기준</th>
          <th className={TH}>판정</th>
        </tr>
      </thead>
      <tbody>
        {params.map((p) => {
          const v = paramVerdict(p);
          return (
            <tr key={p.param} className="border-b border-border last:border-0">
              <td className={`${TD} font-mono text-xs`}>{p.param}</td>
              <td className={`${TD} font-mono text-xs`}>{p.reported ? (p.runtime ?? <span className="text-muted-foreground">없음</span>) : '—'}</td>
              <td className={`${TD} font-mono text-xs`} title={p.persistentSource ?? '영구 설정 파일에 없음(커널 기본값)'}>
                {p.persistent ?? <span className="text-muted-foreground">파일에 없음</span>}
                {p.persistentSource && <span className="block text-xs text-muted-foreground font-sans">{p.persistentSource}</span>}
              </td>
              <td className={`${TD} font-mono text-xs`}>{expectedText(p)}</td>
              <td className={TD}>
                <StatusBadge variant={v.variant} label={v.label} title={v.title} />
                {v.title && v.variant !== 'healthy' && <span className="block mt-1 text-xs text-muted-foreground">{v.title}</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function problemCount(n: NodeParamNode): number {
  return n.violationCount + n.mismatchCount + (n.state === 'offline' || n.state === 'late' ? 1 : 0);
}

interface Props {
  clusterId: string;
  nodes: NodeParamNode[];
  intervalSec: number;
  onShowInstall: () => void;
}

export function NodeParamNodesCard({ clusterId, nodes, intervalSec, onShowInstall }: Props) {
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);
  const del = useDeleteNodeParamAgent(clusterId);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [removing, setRemoving] = useState<NodeParamNode | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodes.filter((n) => {
      if (problemsOnly && problemCount(n) === 0) return false;
      if (!q) return true;
      return n.node.toLowerCase().includes(q) || (n.hostIp ?? '').includes(q)
        || n.params.some((p) => p.param.toLowerCase().includes(q));
    });
  }, [nodes, query, problemsOnly]);
  const withProblems = nodes.filter((n) => problemCount(n) > 0).length;

  const toggle = (id: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const onRemove = async () => {
    if (!removing) return;
    try {
      await del.mutateAsync(removing.agentId);
      toast.success(`${removing.node} 을(를) 목록에서 지웠습니다`, '노드가 살아 있으면 다음 보고 때 다시 나타납니다.');
      setRemoving(null);
    } catch (e) {
      toast.error('지우기 실패', formatApiError(e));
    }
  };

  if (nodes.length === 0) {
    return (
      <MacCard title="노드">
        <EmptyState
          icon={Server}
          title="보고한 노드가 없습니다"
          description="이 클러스터에 노드 파라미터 에이전트(DaemonSet)를 설치하면 노드마다 값이 올라온다."
          action={{ label: '에이전트 설치 방법 보기', onClick: onShowInstall }}
        />
      </MacCard>
    );
  }

  return (
    <MacCard
      title="노드"
      titleExtra={<span className="text-xs text-muted-foreground">{nodes.length}개 · 문제 {withProblems}개</span>}
      description={`에이전트 보고 주기 ${intervalSec}초`}
      actions={(
        <>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="노드·IP·파라미터 검색"
              aria-label="노드·IP·파라미터 검색"
              className="pl-8 pr-2.5 py-1 text-sm rounded-xl border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" className="accent-primary" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
            문제 있는 노드만
          </label>
        </>
      )}
      bodyPadding="p-0"
    >
      {filtered.length === 0 ? (
        <EmptyState compact title="조건에 맞는 노드가 없습니다" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className={`${TH} w-8`}><span className="sr-only">펼치기</span></th>
                <th className={TH}>노드</th>
                <th className={TH}>에이전트</th>
                <th className={TH}>기준 위반</th>
                <th className={TH}>영구 설정 불일치</th>
                <th className={TH}>마지막 변경</th>
                <th className={`${TH} w-10`}><span className="sr-only">동작</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((n) => {
                const st = AGENT_STATE[n.state];
                const expanded = open.has(n.agentId);
                return (
                  <Fragment key={n.agentId}>
                    <tr className="border-b border-border hover:bg-secondary/40 cursor-pointer" onClick={() => toggle(n.agentId)}>
                      <td className={TD}>
                        <button type="button" className="text-muted-foreground" aria-expanded={expanded}
                          aria-label={`${n.node} 파라미터 ${expanded ? '접기' : '펼치기'}`} title={expanded ? '접기' : '펼치기'}
                          onClick={(e) => { e.stopPropagation(); toggle(n.agentId); }}>
                          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className={TD}>
                        <span className="font-medium text-foreground">{n.node}</span>
                        {n.hostIp && <span className="block text-xs text-muted-foreground font-mono">{n.hostIp}</span>}
                      </td>
                      <td className={TD}>
                        <StatusBadge variant={st.variant} label={st.label} />
                        <span className="block mt-1 text-xs text-muted-foreground"
                          title={n.lastSeenAt ? formatDateTime(n.lastSeenAt) : undefined}>
                          {n.lastSeenAt ? formatRelativeTime(n.lastSeenAt) : '—'}{n.agentVersion ? ` · v${n.agentVersion}` : ''}
                        </span>
                        {n.lastError && <span className="block mt-1 text-xs text-status-warning whitespace-pre-line">{n.lastError}</span>}
                      </td>
                      <td className={TD}>
                        {n.violationCount > 0
                          ? <StatusBadge variant="critical" label={`${n.violationCount}건`} />
                          : <span className="text-muted-foreground">0</span>}
                      </td>
                      <td className={TD}>
                        {n.mismatchCount > 0
                          ? <StatusBadge variant="warning" label={`${n.mismatchCount}건`} />
                          : <span className="text-muted-foreground">0</span>}
                      </td>
                      <td className={`${TD} text-xs text-muted-foreground`}
                        title={n.lastChangeAt ? formatDateTime(n.lastChangeAt) : undefined}>
                        {n.lastChangeAt ? formatRelativeTime(n.lastChangeAt) : '—'}
                      </td>
                      <td className={TD}>
                        <button type="button" disabled={!canOperate}
                          onClick={(e) => { e.stopPropagation(); setRemoving(n); }}
                          className="inline-flex items-center justify-center w-7 h-7 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-40"
                          title={withHint('목록에서 지우기 (없앤 노드)')} aria-label={ariaWithHint(`${n.node} 목록에서 지우기`)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-border bg-secondary/30">
                        <td colSpan={7} className="py-1 pl-10">
                          <ParamTable params={n.params} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!removing}
        danger
        title="에이전트를 목록에서 지울까요?"
        description={removing ? `${removing.node} 의 에이전트 상태와 열린 알람(무응답·위반)을 정리합니다. 변경 이력은 남습니다. 노드가 살아 있으면 다음 보고 때 다시 나타납니다.` : undefined}
        confirmLabel="지우기"
        busy={del.isPending}
        onConfirm={() => { void onRemove(); }}
        onCancel={() => setRemoving(null)}
      />
    </MacCard>
  );
}
