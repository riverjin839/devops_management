import { Link2, Link2Off, StickyNote, Trash2 } from 'lucide-react';
import type { ArchCanvasEdge, ArchCanvasNode } from './ArchDocCanvas';

interface Props {
  nodes: ArchCanvasNode[];
  edges: ArchCanvasEdge[];
  nodeName: (id: string) => string;
  selectedId: string | null;
  /** 상세·주석 패널 열기. */
  onSelectNode: (id: string) => void;
  /** 수동 연결 — 시작 노드(없으면 null). */
  linkSourceId: string | null;
  onStartLink: (id: string) => void;
  onCompleteLink: (id: string) => void;
  onCancelLink: () => void;
  onDeleteManualEdge: (edgePk: string) => void;
  canEdit: boolean;
  editHint?: string;
}

const EDGE_TYPE_LABEL: Record<string, string> = {
  routes: '라우팅',
  exposes: '노출',
  owns: '소유',
  uses_config: '설정 참조',
  uses_secret: '시크릿 참조',
  mounts_pvc: 'PVC 마운트',
  traffic: '실트래픽',
};

function edgeTypeLabel(e: ArchCanvasEdge): string {
  if (e.manualPk) return '수동 연결';
  if (e.type === 'manual') return 'AI 플로우';
  return EDGE_TYPE_LABEL[e.type] ?? e.type;
}

function nodeStateLabel(n: ArchCanvasNode): { text: string; cls: string } {
  if (n.stale) return { text: '사라진 노드', cls: 'text-status-warning' };
  if (n.manual) return { text: '수동', cls: 'text-muted-foreground' };
  if (n.status === 'critical') return { text: '위험', cls: 'text-status-critical' };
  if (n.status === 'warning') return { text: '경고', cls: 'text-status-warning' };
  return { text: '정상', cls: 'text-muted-foreground' };
}

const btn = 'inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50';

/**
 * 캔버스 대안 "목록 보기"(A-16) — 노드·연결을 표로 보여 주고, 키보드만으로 상세·주석 열기와
 * 수동 연결(시작 → 대상)·수동 연결 삭제를 할 수 있게 한다.
 */
export function ArchDocListView({
  nodes, edges, nodeName, selectedId, onSelectNode,
  linkSourceId, onStartLink, onCompleteLink, onCancelLink, onDeleteManualEdge,
  canEdit, editHint,
}: Props) {
  const hintTitle = (t: string) => (canEdit ? t : (editHint ?? t));
  const hintAria = (t: string) => (canEdit || !editHint ? t : `${t} — ${editHint}`);

  return (
    <div className="h-full overflow-y-auto p-4 space-y-5">
      {linkSourceId && (
        <div role="status" className="flex items-center gap-2 text-xs bg-secondary/40 border border-border rounded-xl px-3 py-2">
          <span className="flex-1 min-w-0 truncate">
            <span className="font-semibold">{nodeName(linkSourceId)}</span> 에서 연결할 대상 노드의 「여기로 연결」을 누르세요.
          </span>
          <button type="button" onClick={onCancelLink} className={btn}>연결 취소</button>
        </div>
      )}

      <section aria-label="노드 목록">
        <h3 className="text-xs font-semibold text-muted-foreground mb-1.5">노드 {nodes.length}개</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border">
              <th scope="col" className="py-1.5 pr-2 font-medium">종류</th>
              <th scope="col" className="py-1.5 pr-2 font-medium">이름</th>
              <th scope="col" className="py-1.5 pr-2 font-medium">상태</th>
              <th scope="col" className="py-1.5 pr-2 font-medium">주석</th>
              <th scope="col" className="py-1.5 font-medium text-right">동작</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => {
              const st = nodeStateLabel(n);
              const isSel = selectedId === n.id;
              const isSrc = linkSourceId === n.id;
              return (
                <tr key={n.id} className={`border-b border-border/60 ${isSel ? 'bg-secondary/50' : ''}`}>
                  <td className="py-1.5 pr-2 text-xs text-muted-foreground whitespace-nowrap">{n.kind}</td>
                  <td className="py-1.5 pr-2 min-w-0 break-all">{n.name}</td>
                  <td className={`py-1.5 pr-2 text-xs whitespace-nowrap ${st.cls}`}>{st.text}</td>
                  <td className="py-1.5 pr-2 text-xs text-muted-foreground">
                    {n.annotated ? (
                      <span className="inline-flex items-center gap-1">
                        <StickyNote className="w-3.5 h-3.5" aria-hidden="true" />있음
                      </span>
                    ) : '없음'}
                  </td>
                  <td className="py-1.5">
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => onSelectNode(n.id)}
                        aria-pressed={isSel}
                        aria-label={`${n.name} 상세·주석`}
                        className={btn}
                      >
                        상세·주석
                      </button>
                      {isSrc ? (
                        <button type="button" onClick={onCancelLink} className={btn}
                          aria-label={`${n.name} 연결 취소`}>
                          <Link2Off className="w-3.5 h-3.5" aria-hidden="true" />연결 취소
                        </button>
                      ) : linkSourceId ? (
                        <button type="button" onClick={() => onCompleteLink(n.id)} disabled={!canEdit}
                          title={hintTitle('여기로 연결')} aria-label={hintAria(`${n.name} 으로 연결`)}
                          className={btn}>
                          <Link2 className="w-3.5 h-3.5" aria-hidden="true" />여기로 연결
                        </button>
                      ) : (
                        <button type="button" onClick={() => onStartLink(n.id)} disabled={!canEdit}
                          title={hintTitle('이 노드에서 수동 연결 시작')} aria-label={hintAria(`${n.name} 에서 연결 시작`)}
                          className={btn}>
                          <Link2 className="w-3.5 h-3.5" aria-hidden="true" />연결 시작
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section aria-label="연결 목록">
        <h3 className="text-xs font-semibold text-muted-foreground mb-1.5">연결 {edges.length}개</h3>
        {edges.length === 0 ? (
          <p className="text-xs text-muted-foreground">이 뷰에 표시할 연결이 없습니다.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th scope="col" className="py-1.5 pr-2 font-medium">출발</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">도착</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">유형</th>
                <th scope="col" className="py-1.5 pr-2 font-medium">라벨·흐름</th>
                <th scope="col" className="py-1.5 font-medium text-right">동작</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((e) => {
                const extra = e.type === 'traffic'
                  ? `흐름 ${e.flowCount ?? 0}${e.dropped ? ' · 드롭 있음' : ''}`
                  : (e.label ?? '');
                return (
                  <tr key={e.id} className="border-b border-border/60">
                    <td className="py-1.5 pr-2 break-all">{nodeName(e.source)}</td>
                    <td className="py-1.5 pr-2 break-all">{nodeName(e.target)}</td>
                    <td className="py-1.5 pr-2 text-xs text-muted-foreground whitespace-nowrap">
                      {edgeTypeLabel(e)}{e.step != null ? ` · ${e.step}단계` : ''}
                    </td>
                    <td className={`py-1.5 pr-2 text-xs ${e.dropped ? 'text-status-critical' : 'text-muted-foreground'}`}>
                      {extra || '—'}
                    </td>
                    <td className="py-1.5">
                      <div className="flex justify-end">
                        {e.manualPk && (
                          <button type="button" onClick={() => onDeleteManualEdge(e.manualPk!)} disabled={!canEdit}
                            title={hintTitle('수동 연결 삭제')}
                            aria-label={hintAria(`${nodeName(e.source)} → ${nodeName(e.target)} 수동 연결 삭제`)}
                            className={`${btn} text-status-critical`}>
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />삭제
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
