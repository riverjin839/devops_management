import { useEffect, useState } from 'react';
import { Pencil, StickyNote, Trash2, X } from 'lucide-react';
import type { ArchDoc } from '@/types';
import type { ArchCanvasNode } from './ArchDocCanvas';

interface Props {
  node: ArchCanvasNode;
  doc: ArchDoc;
  onClose: () => void;
  onSaveAnnotation: (nodeId: string, text: string | null) => void;
  /** 주석 삭제 요청 — 페이지가 확인 창을 띄운 뒤 지운다. */
  onDeleteAnnotation: (nodeId: string) => void;
  onEditManualNode: (manualPk: string) => void;
  /** 수동 노드 삭제 요청 — 페이지가 확인 창(연결 n개 함께 삭제)을 띄운다. */
  onDeleteManualNode: (manualPk: string) => void;
  /** 수동 연결 삭제 요청 — 페이지가 확인 창을 띄운다. */
  onDeleteManualEdge: (edgePk: string) => void;
  savingAnnotation: boolean;
  /** 저장하지 않은 주석 여부 — 노드 전환 전에 페이지가 확인한다. */
  onDirtyChange?: (dirty: boolean) => void;
  /** operator + 클러스터 operate 권한. false 면 쓰기 버튼을 사유와 함께 비활성. */
  canEdit: boolean;
  /** 비활성 사유(`useCanOperate().hint`). */
  editHint?: string;
}

/** 우측 노드 인스펙터 — 역할(LLM)/주석 편집/연결 목록/수동 노드 관리. */
export function NodeDetailPanel({
  node, doc, onClose, onSaveAnnotation, onDeleteAnnotation,
  onEditManualNode, onDeleteManualNode, onDeleteManualEdge, savingAnnotation,
  onDirtyChange, canEdit, editHint,
}: Props) {
  const saved = doc.annotations[node.id] ?? '';
  const [text, setText] = useState(saved);
  // 노드가 바뀌거나 저장된 값이 바뀔 때만 초기화 — 백그라운드 재조회(annotations 객체 교체)로
  // 입력 중인 주석이 지워지지 않게 한다.
  useEffect(() => { setText(saved); }, [node.id, saved]);

  const role = doc.llmContent?.components.find((c) => c.nodeId === node.id)?.role;
  const relatedEdges = doc.manualEdges.filter(
    (e) => e.sourceId === node.id || e.targetId === node.id,
  );
  const dirty = text !== saved;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const hintTitle = (t: string) => (canEdit ? t : (editHint ?? t));
  const hintAria = (t: string) => (canEdit || !editHint ? t : `${t} — ${editHint}`);

  return (
    <div className="w-72 shrink-0 border-l border-border bg-card/60 p-4 space-y-4 overflow-y-auto">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-muted-foreground">{node.kind}</div>
          <div className="text-sm font-semibold break-all">{node.name}</div>
          {node.stale && (
            <div className="mt-1 text-xs text-status-warning">
              사라진 노드 — 최근 현행화 시점에 클러스터에 없습니다.
            </div>
          )}
        </div>
        <button onClick={onClose} aria-label="패널 닫기" title="패널 닫기"
          className="p-1 rounded-xl text-muted-foreground hover:bg-secondary">
          <X className="w-4 h-4" />
        </button>
      </div>

      {role && (
        <div className="text-xs bg-secondary/50 border border-border rounded-xl px-3 py-2">
          <div className="font-semibold text-muted-foreground mb-0.5">AI 분석 역할</div>
          <div>{role}</div>
        </div>
      )}

      {node.detail && !node.stale && (
        <div className="text-xs text-muted-foreground break-all">{node.detail}</div>
      )}

      <div>
        <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground mb-1">
          <StickyNote className="w-3.5 h-3.5" /> 주석 (수동)
          {dirty && <span className="font-normal">· 저장 안 됨</span>}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={!canEdit}
          rows={4}
          aria-label="노드 주석"
          title={canEdit ? undefined : editHint}
          placeholder={canEdit ? '이 노드에 대한 운영 메모/설명…' : '주석 없음'}
          className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm resize-none"
        />
        <div className="flex justify-end gap-2 mt-1.5">
          {saved && (
            <button
              onClick={() => onDeleteAnnotation(node.id)}
              disabled={savingAnnotation || !canEdit}
              title={hintTitle('주석 삭제')}
              aria-label={hintAria('주석 삭제')}
              className="px-2.5 py-1 text-xs font-medium text-status-critical hover:bg-secondary rounded-xl disabled:opacity-50">
              주석 삭제
            </button>
          )}
          <button
            onClick={() => onSaveAnnotation(node.id, text.trim() || null)}
            disabled={savingAnnotation || !dirty || !canEdit}
            title={hintTitle('주석 저장')}
            aria-label={hintAria('주석 저장')}
            className="px-2.5 py-1 text-xs font-semibold bg-primary text-primary-foreground rounded-xl disabled:opacity-50">
            저장
          </button>
        </div>
      </div>

      {relatedEdges.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-1.5">수동 연결</div>
          <ul className="space-y-1.5">
            {relatedEdges.map((e) => (
              <li key={e.id}
                className="flex items-center gap-2 text-xs bg-secondary/40 border border-border rounded-xl px-2.5 py-1.5">
                <span className="flex-1 min-w-0 truncate">
                  {e.sourceId === node.id ? '→' : '←'} {e.label || e.edgeType}
                </span>
                <button onClick={() => onDeleteManualEdge(e.id)}
                  disabled={!canEdit}
                  aria-label={hintAria('수동 연결 삭제')} title={hintTitle('수동 연결 삭제')}
                  className="p-0.5 rounded-xl text-muted-foreground hover:text-status-critical disabled:opacity-50">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {node.manual && node.manualPk && (
        <div className="flex gap-2 pt-1 border-t border-border">
          <button onClick={() => onEditManualNode(node.manualPk!)}
            disabled={!canEdit} title={hintTitle('수동 노드 수정')}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50">
            <Pencil className="w-3.5 h-3.5" /> 수정
          </button>
          <button onClick={() => onDeleteManualNode(node.manualPk!)}
            disabled={!canEdit} title={hintTitle('수동 노드 삭제')}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-status-critical hover:bg-secondary border border-border rounded-xl disabled:opacity-50">
            <Trash2 className="w-3.5 h-3.5" /> 삭제
          </button>
        </div>
      )}
    </div>
  );
}
