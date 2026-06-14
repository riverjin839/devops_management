import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

interface Props {
  value: string | null | undefined;
  onSave: (next: string | null) => Promise<void> | void;
  placeholder?: string;
  /** 편집 진입을 외부에서 제어 (예: dblclick 을 GridCell 가 받아서 토글) */
  editing?: boolean;
  onEditingChange?: (v: boolean) => void;
  className?: string;
  inputClassName?: string;
  emptyLabel?: string;
  multiline?: boolean;
}

/** 텍스트 셀 — dblclick → input 편집. Enter 저장 / Esc 취소.
 *  null 문자열('') 저장은 null 로 변환해 전달.
 */
export function InlineTextCell({
  value, onSave, placeholder, editing: editingProp, onEditingChange,
  className = '', inputClassName = '', emptyLabel = '-', multiline = false,
}: Props) {
  const [internalEditing, setInternalEditing] = useState(false);
  const editing = editingProp ?? internalEditing;
  const setEditing = (v: boolean) => {
    if (onEditingChange) onEditingChange(v);
    else setInternalEditing(v);
  };

  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value ?? '');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [editing, value]);

  const commit = async () => {
    const next = draft.trim() === '' ? null : draft;
    const prev = value ?? null;
    if (next === prev) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch { /* 상위 처리 */ }
    finally { setSaving(false); }
  };

  if (editing) {
    const Tag = multiline ? 'textarea' : 'input';
    return (
      <div className={`relative ${className}`}>
        <Tag
          ref={inputRef as never}
          value={draft}
          onChange={(e) => setDraft((e.target as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { setEditing(false); }
          }}
          placeholder={placeholder}
          className={`w-full px-1.5 py-0.5 text-sm bg-background border border-primary rounded ${inputClassName}`}
        />
        {saving && <Loader2 className="absolute right-1 top-1 w-3 h-3 animate-spin text-muted-foreground" />}
      </div>
    );
  }

  const shown = value == null || value === '' ? emptyLabel : value;
  return (
    <span
      className={`cursor-text hover:bg-primary/5 rounded px-0.5 ${className}`}
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
      title="더블클릭으로 편집"
    >
      {shown}
    </span>
  );
}
