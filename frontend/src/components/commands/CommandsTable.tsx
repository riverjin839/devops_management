import { useEffect, useRef, useState } from 'react';
import {
  Check, X, Plus, Pencil, Trash2, Pin, PinOff, ExternalLink, AlertTriangle, Copy,
} from 'lucide-react';
import type { CommandEntry, CommandEntryCreate, CommandImportance } from '@/types';
import { IMPORTANCE_OPTIONS, IMPORTANCE_META } from './constants';
import { DoubleScrollX } from '@/components/common';

function ImportanceBadge({ value, onClick, title }: { value: CommandImportance; onClick?: () => void; title?: string }) {
  const meta = IMPORTANCE_META[value] ?? IMPORTANCE_META.medium;
  return (
    <span
      onClick={onClick}
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${meta.badge} ${
        onClick ? 'cursor-pointer hover:opacity-80' : ''
      }`}
      title={title}
    >
      {value === 'critical' && <AlertTriangle className="w-3 h-3" />}
      {meta.label}
    </span>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch { /* ignore */ }
      }}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded-md bg-secondary text-muted-foreground hover:text-foreground flex-shrink-0 self-start"
      title="복사"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
      {copied ? '복사됨' : '복사'}
    </button>
  );
}

/** 단일 라인 텍스트 인풋 — Enter 저장 / Esc 취소 / blur 저장. */
function InlineText({
  initial, onSave, onCancel, placeholder, className = '', mono = false,
}: {
  initial: string;
  onSave: (v: string) => void;
  onCancel: () => void;
  placeholder?: string;
  className?: string;
  mono?: boolean;
}) {
  const [v, setV] = useState(initial);
  const committed = useRef(false);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    if (v.trim() === initial.trim()) onCancel();
    else onSave(v.trim());
  };
  return (
    <input
      autoFocus
      type="text"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { committed.current = true; onCancel(); }
      }}
      onBlur={commit}
      placeholder={placeholder}
      className={`w-full px-2 py-1 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary ${
        mono ? 'font-mono' : ''
      } ${className}`}
    />
  );
}

/** 멀티라인 — Ctrl+Enter 저장 / Esc 취소. blur 는 저장하지 않음(우발 저장 방지). */
function InlineTextarea({
  initial, onSave, onCancel, placeholder, mono = false, rows = 2,
}: {
  initial: string;
  onSave: (v: string) => void;
  onCancel: () => void;
  placeholder?: string;
  mono?: boolean;
  rows?: number;
}) {
  const [v, setV] = useState(initial);
  return (
    <div className="space-y-1">
      <textarea
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (v === initial) onCancel();
            else onSave(v);
          }
          if (e.key === 'Escape') onCancel();
        }}
        rows={rows}
        placeholder={placeholder}
        className={`w-full px-2 py-1.5 text-sm bg-background border border-primary/40 rounded resize-y focus:outline-none focus:border-primary ${
          mono ? 'font-mono' : ''
        }`}
      />
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <button type="button" onClick={() => v === initial ? onCancel() : onSave(v)} className="p-0.5 text-primary hover:text-primary/80">
          <Check className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={onCancel} className="p-0.5 hover:text-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
        <span className="ml-auto">Ctrl+Enter 저장 · Esc 취소</span>
      </div>
    </div>
  );
}

type Editing = null | 'importance' | 'category' | 'command' | 'description' | 'caution' | 'examples' | 'tags' | 'confluence';

interface CommandRowProps {
  entry: CommandEntry;
  onUpdate: (patch: Partial<CommandEntryCreate>) => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onOpenForm: () => void;
}

function CommandRow({ entry: e, onUpdate, onDelete, onTogglePin, onOpenForm }: CommandRowProps) {
  const meta = IMPORTANCE_META[e.importance] ?? IMPORTANCE_META.medium;
  const [editing, setEditing] = useState<Editing>(null);

  const cell = <K extends Editing>(key: K, render: () => React.ReactNode, content: React.ReactNode) =>
    editing === key ? render() : (
      <div
        className="cursor-pointer rounded hover:bg-primary/5 -mx-1 px-1 py-0.5 transition-colors"
        onClick={() => setEditing(key)}
        title="클릭하여 수정"
      >
        {content}
      </div>
    );

  return (
    <tr className={`border-b border-border last:border-b-0 hover:bg-muted/10 border-l-4 ${meta.rowAccent}`}>
      <td className="px-3 py-3 align-top">
        <div className="flex flex-col gap-1">
          {editing === 'importance' ? (
            <select
              autoFocus
              value={e.importance}
              onChange={(ev) => { onUpdate({ importance: ev.target.value as CommandImportance }); setEditing(null); }}
              onBlur={() => setEditing(null)}
              onKeyDown={(ev) => { if (ev.key === 'Escape') setEditing(null); }}
              className="px-1 py-0.5 text-sm bg-background border border-primary/40 rounded"
            >
              {IMPORTANCE_OPTIONS.map((v) => <option key={v} value={v}>{IMPORTANCE_META[v].label}</option>)}
            </select>
          ) : (
            <ImportanceBadge value={e.importance} onClick={() => setEditing('importance')} title="클릭하여 중요도 변경" />
          )}
          <button
            onClick={onTogglePin}
            className={`inline-flex items-center gap-1 text-xs ${e.pinned ? 'text-primary' : 'text-muted-foreground/50 hover:text-primary'}`}
            title={e.pinned ? '고정 해제' : '상단 고정'}
          >
            {e.pinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
            {e.pinned ? '고정' : '고정'}
          </button>
        </div>
      </td>

      <td className="px-3 py-3 align-top">
        {cell(
          'category',
          () => (
            <InlineText
              initial={e.category ?? ''}
              onSave={(v) => { onUpdate({ category: v || undefined }); setEditing(null); }}
              onCancel={() => setEditing(null)}
              placeholder="kubectl / helm …"
              className="text-xs"
              mono
            />
          ),
          e.category ? (
            <span className="text-xs font-mono text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded">{e.category}</span>
          ) : (
            <span className="text-xs text-muted-foreground/40">—</span>
          )
        )}
      </td>

      <td className="px-3 py-3 align-top">
        <div className="space-y-1.5">
          {/* command */}
          {editing === 'command' ? (
            <InlineTextarea
              initial={e.command}
              onSave={(v) => { onUpdate({ command: v }); setEditing(null); }}
              onCancel={() => setEditing(null)}
              placeholder="kubectl …"
              mono
              rows={3}
            />
          ) : (
            <div className="flex items-start gap-2">
              <pre
                className="flex-1 text-[12px] font-mono bg-background border border-border rounded-lg px-2 py-1.5 whitespace-pre-wrap break-all cursor-pointer hover:border-primary/40 transition-colors"
                onClick={() => setEditing('command')}
                title="클릭하여 수정"
              >
                {e.command}
              </pre>
              <CopyButton value={e.command} />
            </div>
          )}

          {/* description */}
          {editing === 'description' ? (
            <InlineTextarea
              initial={e.description ?? ''}
              onSave={(v) => { onUpdate({ description: v || undefined }); setEditing(null); }}
              onCancel={() => setEditing(null)}
              placeholder="이 명령어가 무엇을 하는지"
              rows={2}
            />
          ) : cell(
            'description',
            () => null,
            e.description ? (
              <p className="text-[12px] text-foreground/90">
                <span className="text-xs uppercase tracking-wider text-muted-foreground mr-1.5">의미</span>
                {e.description}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground/50 italic">+ 의미 추가</p>
            )
          )}

          {/* caution */}
          {editing === 'caution' ? (
            <InlineTextarea
              initial={e.caution ?? ''}
              onSave={(v) => { onUpdate({ caution: v || undefined }); setEditing(null); }}
              onCancel={() => setEditing(null)}
              placeholder="실행 전 주의해야 할 점 / 부작용"
              rows={2}
            />
          ) : cell(
            'caution',
            () => null,
            e.caution ? (
              <div className={`text-[12px] rounded-md px-2 py-1.5 border ${meta.badge}`}>
                <span className="text-xs uppercase tracking-wider mr-1.5">주의</span>
                {e.caution}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/50 italic">+ 주의사항 추가</p>
            )
          )}

          {/* examples */}
          {editing === 'examples' ? (
            <InlineTextarea
              initial={e.examples ?? ''}
              onSave={(v) => { onUpdate({ examples: v || undefined }); setEditing(null); }}
              onCancel={() => setEditing(null)}
              placeholder="실제 사용 예시"
              rows={3}
              mono
            />
          ) : e.examples ? (
            <details
              className="text-xs text-muted-foreground"
              onClick={(ev) => {
                if ((ev.target as HTMLElement).tagName === 'PRE') {
                  ev.preventDefault();
                  setEditing('examples');
                }
              }}
            >
              <summary className="cursor-pointer hover:text-foreground select-none">예시 보기</summary>
              <pre className="mt-1 font-mono bg-muted/20 border border-border rounded p-2 whitespace-pre-wrap cursor-pointer">{e.examples}</pre>
            </details>
          ) : (
            <p
              className="text-xs text-muted-foreground/50 italic cursor-pointer hover:text-primary transition-colors"
              onClick={() => setEditing('examples')}
            >
              + 예시 추가
            </p>
          )}

          {/* tags */}
          {editing === 'tags' ? (
            <InlineText
              initial={e.tags ?? ''}
              onSave={(v) => { onUpdate({ tags: v || undefined }); setEditing(null); }}
              onCancel={() => setEditing(null)}
              placeholder="node, maintenance, drain (쉼표 구분)"
              className="text-sm"
            />
          ) : cell(
            'tags',
            () => null,
            e.tags ? (
              <div className="flex flex-wrap gap-1">
                {e.tags.split(',').map((t) => t.trim()).filter(Boolean).map((tag) => (
                  <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">#{tag}</span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/50 italic">+ 태그 추가</p>
            )
          )}

          {/* confluence */}
          {editing === 'confluence' ? (
            <InlineText
              initial={e.confluenceUrl ?? ''}
              onSave={(v) => { onUpdate({ confluenceUrl: v || undefined }); setEditing(null); }}
              onCancel={() => setEditing(null)}
              placeholder="https://confluence.example.com/..."
              className="text-sm"
            />
          ) : e.confluenceUrl ? (
            <div className="inline-flex items-center gap-0.5">
              <a
                href={e.confluenceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                title={e.confluenceUrl}
              >
                <ExternalLink className="w-2.5 h-2.5" /> Confluence
              </a>
              <button
                onClick={() => setEditing('confluence')}
                className="p-0.5 text-muted-foreground/40 hover:text-primary"
                title="Confluence URL 수정"
              >
                <Pencil className="w-2.5 h-2.5" />
              </button>
            </div>
          ) : (
            <p
              className="text-xs text-muted-foreground/50 italic cursor-pointer hover:text-primary transition-colors"
              onClick={() => setEditing('confluence')}
            >
              + Confluence 링크 추가
            </p>
          )}
        </div>
      </td>

      <td className="px-3 py-3 align-top text-right">
        <div className="inline-flex items-center gap-1">
          <button
            onClick={onOpenForm}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-secondary hover:bg-secondary/80"
            title="전체 폼으로 수정"
          >
            <Pencil className="w-3 h-3" /> 폼
          </button>
          <button
            onClick={onDelete}
            className="inline-flex items-center justify-center px-1.5 py-1 text-xs rounded-md text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
            title="삭제"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** 인라인 행 추가 — 본 테이블의 꼬리 행. 기본 importance=medium. */
function AddCommandRow({ onCreate }: { onCreate: (data: CommandEntryCreate) => void }) {
  const [open, setOpen] = useState(false);
  const [importance, setImportance] = useState<CommandImportance>('medium');
  const [category, setCategory] = useState('');
  const [command, setCommand] = useState('');
  const [description, setDescription] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const reset = () => {
    setImportance('medium');
    setCategory('');
    setCommand('');
    setDescription('');
  };

  const submit = () => {
    if (!command.trim()) return;
    onCreate({
      command: command.trim(),
      description: description.trim() || undefined,
      category: category.trim() || undefined,
      importance,
    });
    reset();
    setOpen(false);
  };

  const meta = IMPORTANCE_META[importance];

  if (!open) {
    return (
      <tr className="border-t border-border bg-muted/10">
        <td colSpan={4}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-full px-3 py-2.5 text-sm text-muted-foreground hover:text-primary hover:bg-primary/5 flex items-center justify-center gap-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> 행 추가
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className={`border-t border-border bg-primary/[0.04] border-l-4 ${meta.rowAccent}`}>
      <td className="px-3 py-3 align-top">
        <select
          value={importance}
          onChange={(e) => setImportance(e.target.value as CommandImportance)}
          className="px-1 py-0.5 text-sm bg-background border border-border rounded"
        >
          {IMPORTANCE_OPTIONS.map((v) => <option key={v} value={v}>{IMPORTANCE_META[v].label}</option>)}
        </select>
      </td>
      <td className="px-3 py-3 align-top">
        <input
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="kubectl"
          className="w-full px-2 py-1 text-xs font-mono bg-background border border-border rounded"
        />
      </td>
      <td className="px-3 py-3 align-top">
        <div className="space-y-1.5">
          <textarea
            ref={inputRef}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
              if (e.key === 'Escape') { reset(); setOpen(false); }
            }}
            placeholder="명령어 (필수, Ctrl+Enter 로 저장)"
            rows={2}
            className="w-full px-2 py-1.5 text-sm font-mono bg-background border border-border rounded focus:outline-none focus:border-primary"
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="의미 (선택)"
            className="w-full px-2 py-1 text-sm bg-background border border-border rounded"
          />
        </div>
      </td>
      <td className="px-3 py-3 align-top">
        <div className="flex flex-col gap-1 items-end">
          <button
            type="button"
            onClick={submit}
            disabled={!command.trim()}
            className="px-2 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1"
          >
            <Check className="w-3 h-3" /> 저장
          </button>
          <button
            type="button"
            onClick={() => { reset(); setOpen(false); }}
            className="px-2 py-1 text-xs rounded-md text-muted-foreground hover:bg-secondary inline-flex items-center gap-1"
          >
            <X className="w-3 h-3" /> 취소
          </button>
        </div>
      </td>
    </tr>
  );
}

interface CommandsTableProps {
  entries: CommandEntry[];
  onUpdate: (id: string, data: Partial<CommandEntryCreate>) => void;
  onCreate: (data: CommandEntryCreate) => void;
  onDelete: (entry: CommandEntry) => void;
  onTogglePin: (entry: CommandEntry) => void;
  onOpenForm: (entry: CommandEntry) => void;
}

export function CommandsTable({
  entries, onUpdate, onCreate, onDelete, onTogglePin, onOpenForm,
}: CommandsTableProps) {
  return (
    <DoubleScrollX>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-secondary/40 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium w-24">중요도</th>
            <th className="px-3 py-2 font-medium w-24">카테고리</th>
            <th className="px-3 py-2 font-medium">명령어 / 의미 / 주의사항</th>
            <th className="px-3 py-2 font-medium w-24 text-right">액션</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <CommandRow
              key={e.id}
              entry={e}
              onUpdate={(patch) => onUpdate(e.id, patch)}
              onDelete={() => onDelete(e)}
              onTogglePin={() => onTogglePin(e)}
              onOpenForm={() => onOpenForm(e)}
            />
          ))}
          <AddCommandRow onCreate={onCreate} />
        </tbody>
      </table>
    </DoubleScrollX>
  );
}
