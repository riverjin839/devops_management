// 서비스 토폴로지 표 보기 — 그래프(2D SVG·3D WebGL)의 대체 뷰(D-092).
// 키보드·스크린리더 사용자도 노드·연결·실트래픽을 읽고, 노드를 선택(상세 패널)하거나 링크 편집의
// 출발·도착을 고를 수 있다. 검색어가 있으면 일치 노드와 그 연결만 남긴다.
import { useMemo } from 'react';
import type { TopoNode, TopoEdge, TopologyTrafficEdge } from '@/types';
import { KIND_ABBR, EDGE_TYPE_LABEL, kindRank, statusGlyph } from './topologyShared';

const STATUS_TEXT: Record<string, string> = {
  critical: 'text-status-critical', warning: 'text-status-warning', healthy: 'text-status-healthy',
};
const STATUS_LABEL: Record<string, string> = { critical: '위험', warning: '경고', healthy: '정상' };

interface Props {
  graph: { nodes: TopoNode[]; edges: TopoEdge[] };
  trafficEdges?: TopologyTrafficEdge[];
  showTraffic: boolean;
  selectedId: string | null;
  onSelectNode: (id: string | null) => void;
  editMode: boolean;
  linkSourceId: string | null;
  /** 검색 일치 노드 — null 이면 전체. */
  highlightIds?: Set<string> | null;
  nodeName: (id: string) => string;
  /** 상세 패널이 표 오른쪽을 덮을 때 여백을 둔다. */
  panelOpen?: boolean;
}

export function TopologyTable({
  graph, trafficEdges = [], showTraffic, selectedId, onSelectNode, editMode, linkSourceId,
  highlightIds = null, nodeName, panelOpen = false,
}: Props) {
  const degree = useMemo(() => {
    const d: Record<string, { in: number; out: number }> = {};
    for (const e of graph.edges) {
      (d[e.source] ??= { in: 0, out: 0 }).out += 1;
      (d[e.target] ??= { in: 0, out: 0 }).in += 1;
    }
    return d;
  }, [graph.edges]);

  const nodes = useMemo(
    () => graph.nodes
      .filter((n) => !highlightIds || highlightIds.has(n.id))
      .sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || a.name.localeCompare(b.name)),
    [graph.nodes, highlightIds],
  );
  const touches = (s: string, t: string) => !highlightIds || highlightIds.has(s) || highlightIds.has(t);
  const edges = graph.edges.filter((e) => touches(e.source, e.target));
  const traffic = showTraffic ? trafficEdges.filter((t) => touches(t.source, t.target)) : [];

  const nodeButtonLabel = (n: TopoNode) => {
    if (!editMode) return selectedId === n.id ? `${n.name} 상세 닫기` : `${n.name} 상세 보기`;
    if (!linkSourceId) return `${n.name} 을(를) 링크 출발로 선택`;
    if (linkSourceId === n.id) return `${n.name} 링크 출발 선택 해제`;
    return `${n.name} 을(를) 링크 도착으로 선택`;
  };

  // 다른 노드 이름을 눌러도 그 노드로 이동 — 편집 모드에서는 출발/도착 선택 규칙을 그대로 따른다.
  const nodeLink = (id: string) => (
    <button type="button" onClick={() => onSelectNode(id)}
      className="text-left text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl px-0.5 break-all">
      {nodeName(id)}
    </button>
  );

  const th = 'px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap';
  const td = 'px-2 py-1.5 align-top';

  return (
    <div className={`absolute inset-0 overflow-auto p-3 space-y-5 ${panelOpen ? 'pr-[19.5rem]' : ''}`}>
      {highlightIds && (
        <p role="status" className="text-xs text-muted-foreground">
          검색 일치 노드 {nodes.length}개와 그 연결만 표시한다.
        </p>
      )}

      <section aria-labelledby="topo-table-nodes">
        <h3 id="topo-table-nodes" className="text-sm font-semibold text-foreground mb-1.5">노드 {nodes.length}</h3>
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th scope="col" className={th}>종류</th>
                <th scope="col" className={th}>이름</th>
                <th scope="col" className={th}>네임스페이스</th>
                <th scope="col" className={th}>상태</th>
                <th scope="col" className={`${th} text-right`}>Pod(Ready)</th>
                <th scope="col" className={`${th} text-right`}>재시작</th>
                <th scope="col" className={`${th} text-right`}>연결(들어옴/나감)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {nodes.map((n) => {
                const active = selectedId === n.id || linkSourceId === n.id;
                const d = degree[n.id] ?? { in: 0, out: 0 };
                return (
                  <tr key={n.id} className={active ? 'bg-primary/10' : 'hover:bg-muted/30'}>
                    <td className={`${td} font-mono text-muted-foreground`}>{KIND_ABBR[n.kind] ?? n.kind}</td>
                    <td className={td}>
                      <button type="button" onClick={() => onSelectNode(!editMode && selectedId === n.id ? null : n.id)} aria-pressed={active}
                        aria-label={nodeButtonLabel(n)} title={nodeButtonLabel(n)}
                        className="text-left font-medium text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl px-0.5 break-all">
                        {n.name}
                      </button>
                      {n.ghost && <span className="ml-1 text-muted-foreground">(미참조)</span>}
                      {editMode && linkSourceId === n.id && <span className="ml-1 text-primary">· 링크 출발</span>}
                    </td>
                    <td className={`${td} text-muted-foreground`}>{n.namespace || '-'}</td>
                    <td className={`${td} whitespace-nowrap ${STATUS_TEXT[n.status] ?? 'text-muted-foreground'}`}>
                      {statusGlyph(n.status) && <span aria-hidden className="font-bold mr-1">{statusGlyph(n.status)}</span>}
                      {STATUS_LABEL[n.status] ?? n.status}
                    </td>
                    <td className={`${td} text-right tabular-nums`}>{n.podCount ? `${n.readyCount}/${n.podCount}` : '-'}</td>
                    <td className={`${td} text-right tabular-nums`}>{n.restartCount || '-'}</td>
                    <td className={`${td} text-right tabular-nums`}>{d.in}/{d.out}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="topo-table-edges">
        <h3 id="topo-table-edges" className="text-sm font-semibold text-foreground mb-1.5">연결 {edges.length}</h3>
        {edges.length === 0 ? (
          <p className="text-xs text-muted-foreground">표시할 연결이 없다.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th scope="col" className={th}>출발</th>
                  <th scope="col" className={th}>도착</th>
                  <th scope="col" className={th}>유형</th>
                  <th scope="col" className={th}>설명</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {edges.map((e) => (
                  <tr key={e.id} className="hover:bg-muted/30">
                    <td className={td}>{nodeLink(e.source)}</td>
                    <td className={td}>{nodeLink(e.target)}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      {EDGE_TYPE_LABEL[e.type] ?? e.type}
                      {e.manualId && <span className="ml-1 text-primary">(수동)</span>}
                    </td>
                    <td className={`${td} text-muted-foreground break-all`}>{[e.label, e.detail].filter(Boolean).join(' · ') || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showTraffic && (
        <section aria-labelledby="topo-table-traffic">
          <h3 id="topo-table-traffic" className="text-sm font-semibold text-foreground mb-1.5">실트래픽 {traffic.length}</h3>
          {traffic.length === 0 ? (
            <p className="text-xs text-muted-foreground">관측된 트래픽이 없다.</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    <th scope="col" className={th}>출발</th>
                    <th scope="col" className={th}>도착</th>
                    <th scope="col" className={`${th} text-right`}>흐름</th>
                    <th scope="col" className={`${th} text-right`}>드롭</th>
                    <th scope="col" className={th}>프로토콜·포트</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {traffic.map((t) => (
                    <tr key={`${t.source}->${t.target}`} className="hover:bg-muted/30">
                      <td className={td}>{nodeLink(t.source)}</td>
                      <td className={td}>{nodeLink(t.target)}</td>
                      <td className={`${td} text-right tabular-nums`}>{t.flowCount}</td>
                      <td className={`${td} text-right tabular-nums ${t.droppedCount ? 'text-status-critical font-medium' : ''}`}>
                        {t.droppedCount}
                      </td>
                      <td className={`${td} text-muted-foreground`}>
                        {[t.protocols.join('/'), t.ports.join(', ')].filter(Boolean).join(' · ') || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
