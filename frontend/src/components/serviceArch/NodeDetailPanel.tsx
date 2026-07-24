import { useEffect, useState } from 'react';
import { Pencil, StickyNote, Trash2, X } from 'lucide-react';
import type { ArchDoc } from '@/types';
import type { ArchCanvasNode } from './ArchDocCanvas';

interface Props {
  node: ArchCanvasNode;
  doc: ArchDoc;
  onClose: () => void;
  onSaveAnnotation: (nodeId: string, text: string | null) => void;
  onEditManualNode: (manualPk: string) => void;
  onDeleteManualNode: (manualPk: string) => void;
  onDeleteManualEdge: (edgePk: string) => void;
  savingAnnotation: boolean;
}

/** 우측 노드 인스펙터 — 역할(LLM)/주석 편집/연결 목록/수동 노드 관리. */
export function NodeDetailPanel({
  node, doc, onClose, onSaveAnnotation,
  onEditManualNode, onDeleteManualNode, onDeleteManualEdge, savingAnnotation,
}: Props) {
  const saved = doc.annotations[node.id] ?? '';
  const [text, setText] = useState(saved);
  useEffect(() => { setText(doc.annotations[node.id] ?? ''); }, [node.id, doc.annotations]);

  const role = doc.llmContent?.components.find((c) => c.nodeId === node.id)?.role;
  const relatedEdges = doc.manualEdges.filter(
    (e) => e.sourceId === node.id || e.targetId === node.id,
  );
  const dirty = text !== saved;

  return (
    <div className="w-72 shrink-0 border-l border-border bg-card/60 p-4 space-y-4 overflow-y-auto">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold uppercase text-muted-foreground">{node.kind}</div>
          <div className="text-sm font-semibold break-all">{node.name}</div>
          {node.stale && (
            <div className="mt-1 text-[11px] text-amber-500">
              최근 현행화 시점에 클러스터에 존재하지 않음 (stale)
            </div>
          )}
        </div>
        <button onClick={onClose} aria-label="패널 닫기" title="패널 닫기"
          className="p-1 rounded-lg text-muted-foreground hover:bg-secondary">
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
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          aria-label="노드 주석"
          placeholder="이 노드에 대한 운영 메모/설명…"
          className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm resize-none"
        />
        <div className="flex justify-end gap-2 mt-1.5">
          {saved && (
            <button
              onClick={() => onSaveAnnotation(node.id, null)}
              disabled={savingAnnotation}
              className="px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-secondary rounded-lg disabled:opacity-50">
              주석 삭제
            </button>
          )}
          <button
            onClick={() => onSaveAnnotation(node.id, text.trim() || null)}
            disabled={savingAnnotation || !dirty}
            className="px-2.5 py-1 text-xs font-semibold bg-primary text-primary-foreground rounded-lg disabled:opacity-50">
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
                className="flex items-center gap-2 text-xs bg-secondary/40 border border-border rounded-lg px-2.5 py-1.5">
                <span className="flex-1 min-w-0 truncate">
                  {e.sourceId === node.id ? '→' : '←'} {e.label || e.edgeType}
                </span>
                <button onClick={() => onDeleteManualEdge(e.id)} aria-label="수동 연결 삭제" title="수동 연결 삭제"
                  className="p-0.5 rounded text-muted-foreground hover:text-red-500">
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
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl">
            <Pencil className="w-3.5 h-3.5" /> 수정
          </button>
          <button onClick={() => onDeleteManualNode(node.manualPk!)}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-red-500 hover:bg-secondary border border-border rounded-xl">
            <Trash2 className="w-3.5 h-3.5" /> 삭제
          </button>
        </div>
      )}
    </div>
  );
}
