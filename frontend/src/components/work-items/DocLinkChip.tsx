import { useRef, useState } from 'react';
import { FileText, Plus, X } from 'lucide-react';

interface DocLinkChipProps {
  /** 현재 링크. 비어 있으면 "추가" 점선 버튼을 보여준다. */
  url?: string | null;
  /** 저장 콜백 — 빈 문자열이면 링크 해제. */
  onSave: (url: string) => void;
  label?: string;
  className?: string;
}

/**
 * Confluence 문서를 제목 옆 **작은 박스**로 보여주는 칩 (`JiraIssueChip` 과 같은 결).
 *
 * 링크가 없으면 점선 `＋문서` 버튼이 되고, 클릭하면 그 자리에서 URL 을 입력해 저장한다 —
 * 문서를 붙이려고 상세 화면까지 들어갈 필요가 없게 하기 위함.
 */
export function DocLinkChip({ url, onSave, label = '문서', className = '' }: DocLinkChipProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const committed = useRef(false);

  const open = () => {
    setDraft(url ?? '');
    committed.current = false;
    setEditing(true);
  };

  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const next = draft.trim();
    setEditing(false);
    if (next !== (url ?? '').trim()) onSave(next);
  };

  if (editing) {
    return (
      <input
        autoFocus
        type="url"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { committed.current = true; setEditing(false); }
        }}
        onBlur={commit}
        placeholder="Confluence 문서 URL (비우면 해제)"
        aria-label="Confluence 문서 URL"
        className={`min-w-[200px] flex-1 px-2 py-0.5 text-xs bg-background border border-primary/40 rounded focus:outline-none focus:border-primary ${className}`}
      />
    );
  }

  if (!url) {
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); open(); }}
        title="Confluence 문서 링크 추가"
        aria-label="Confluence 문서 링크 추가"
        className={`flex-shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded border border-dashed border-border text-[10px] text-muted-foreground/60 hover:text-foreground hover:border-primary/40 transition-colors ${className}`}
      >
        <Plus className="w-2.5 h-2.5" />{label}
      </button>
    );
  }

  return (
    <span
      className={`flex-shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded border border-primary/20 bg-primary/10 ${className}`}
    >
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        title={url}
        className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-primary hover:underline"
      >
        <FileText className="w-2.5 h-2.5" />{label}
      </a>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); open(); }}
        title="Confluence 링크 수정"
        aria-label="Confluence 링크 수정"
        className="text-primary/60 hover:text-primary leading-none"
      >
        <X className="w-2.5 h-2.5 rotate-45" />
      </button>
    </span>
  );
}
