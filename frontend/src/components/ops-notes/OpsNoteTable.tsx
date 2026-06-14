import { useRef, useState, type ComponentType } from 'react';
import { Pencil, Trash2, Pin, PinOff, ExternalLink, ChevronUp, ChevronDown, ArrowUpDown } from 'lucide-react';
import type { OpsNote, OpsNoteUpdate } from '@/types';
import { formatRelativeTime, stripHtml } from '@/lib/utils';
import { DoubleScrollX } from '@/components/common';

export type OpsNoteSortKey = 'title' | 'service' | 'author' | 'updatedAt';

export interface OpsNoteServiceMeta {
  value: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  accent: string;
  soft: string;
}

interface OpsNoteTableProps {
  notes: OpsNote[];
  services: OpsNoteServiceMeta[];
  sortKey: OpsNoteSortKey;
  sortDir: 'asc' | 'desc';
  onSort: (k: OpsNoteSortKey) => void;
  onOpen: (n: OpsNote) => void;
  onEdit: (n: OpsNote) => void;
  onDelete: (n: OpsNote) => void;
  onTogglePin: (n: OpsNote) => void;
  onUpdate: (id: string, data: OpsNoteUpdate) => void;
  deletingId: string | null;
}

function InlineText({
  initial, onSave, onCancel, placeholder, className = '',
}: {
  initial: string;
  onSave: (v: string) => void;
  onCancel: () => void;
  placeholder?: string;
  className?: string;
}) {
  const [v, setV] = useState(initial);
  const committed = useRef(false);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    const t = v.trim();
    if (t === initial.trim()) onCancel();
    else onSave(t);
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
      onClick={(e) => e.stopPropagation()}
      className={`w-full px-2 py-1 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary ${className}`}
    />
  );
}

type CellKey = 'title' | 'service' | 'author';

function OpsNoteRow({
  note, services, serviceMap, onOpen, onEdit, onDelete, onTogglePin, onUpdate, deleting,
}: {
  note: OpsNote;
  services: OpsNoteServiceMeta[];
  serviceMap: Record<string, OpsNoteServiceMeta>;
  onOpen: (n: OpsNote) => void;
  onEdit: (n: OpsNote) => void;
  onDelete: (n: OpsNote) => void;
  onTogglePin: (n: OpsNote) => void;
  onUpdate: (id: string, data: OpsNoteUpdate) => void;
  deleting: boolean;
}) {
  const [editing, setEditing] = useState<CellKey | null>(null);
  const svc = serviceMap[note.service];
  const answerText = stripHtml(note.content);
  const hasBack = !!note.backContent?.trim();
  const save = (patch: OpsNoteUpdate) => { onUpdate(note.id, patch); setEditing(null); };

  return (
    <tr
      className={`border-b border-border last:border-b-0 hover:bg-muted/20 transition-colors ${
        deleting ? 'opacity-40 pointer-events-none' : ''
      }`}
    >
      <td className="px-3 py-3 text-center cursor-pointer" onClick={() => onOpen(note)}>
        {note.pinned ? (
          <Pin className="w-3.5 h-3.5 inline text-primary" />
        ) : (
          <span className="text-muted-foreground/30">·</span>
        )}
      </td>
      {/* Service — click-to-edit select */}
      <td
        className="px-4 py-3"
        onClick={(e) => { e.stopPropagation(); setEditing('service'); }}
      >
        {editing === 'service' ? (
          <select
            autoFocus
            value={note.service}
            onChange={(e) => save({ service: e.target.value as OpsNote['service'] })}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
            onClick={(e) => e.stopPropagation()}
            className="px-2 py-1 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary"
          >
            {services.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        ) : svc ? (
          <span
            className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-md text-white cursor-pointer ${svc.accent}`}
            title="클릭하여 서비스 변경"
          >
            <svc.Icon className="w-3 h-3" />{svc.label}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground cursor-pointer">{note.service}</span>
        )}
      </td>
      {/* Title — click-to-edit */}
      <td
        className="px-4 py-3 max-w-md"
        onClick={(e) => { if (editing !== 'title') { e.stopPropagation(); setEditing('title'); } }}
      >
        {editing === 'title' ? (
          <InlineText
            initial={note.title}
            onSave={(v) => save({ title: v })}
            onCancel={() => setEditing(null)}
            placeholder="질문"
          />
        ) : (
          <p
            className="font-semibold text-foreground truncate cursor-pointer hover:text-primary transition-colors"
            title={note.title}
          >
            {note.title}
          </p>
        )}
      </td>
      <td className="px-4 py-3 max-w-md cursor-pointer" onClick={() => onOpen(note)} title="클릭하여 상세 보기">
        <p className="text-sm text-muted-foreground line-clamp-2">
          {answerText
            ? answerText
            : <span className="italic opacity-60">답변 없음</span>}
        </p>
        {hasBack && (
          <span className="inline-block mt-0.5 text-xs px-1.5 py-0 rounded bg-slate-500/10 text-slate-500">
            히스토리 있음
          </span>
        )}
      </td>
      {/* Author — click-to-edit */}
      <td
        className="px-4 py-3 text-sm text-muted-foreground truncate"
        onClick={(e) => { if (editing !== 'author') { e.stopPropagation(); setEditing('author'); } }}
      >
        {editing === 'author' ? (
          <InlineText
            initial={note.author ?? ''}
            onSave={(v) => save({ author: v || undefined })}
            onCancel={() => setEditing(null)}
            placeholder="작성자"
            className="text-sm"
          />
        ) : note.author ? (
          <span className="cursor-pointer hover:text-foreground transition-colors">{note.author}</span>
        ) : (
          <span className="text-muted-foreground/50 italic cursor-pointer hover:text-primary transition-colors">+ 작성자</span>
        )}
      </td>
      <td
        className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap font-mono cursor-pointer"
        onClick={() => onOpen(note)}
      >
        {formatRelativeTime(note.updatedAt)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-center gap-1" onClick={(e) => e.stopPropagation()}>
          {note.confluenceUrl && (
            <a
              href={note.confluenceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 hover:bg-primary/10 rounded-md text-muted-foreground hover:text-primary transition-colors"
              title={`Confluence: ${note.confluenceUrl}`}
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
          <button
            onClick={() => onTogglePin(note)}
            className="p-1.5 hover:bg-secondary rounded-md text-muted-foreground hover:text-primary transition-colors"
            title={note.pinned ? '고정 해제' : '상단 고정'}
          >
            {note.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => onEdit(note)}
            className="p-1.5 hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground transition-colors"
            title="전체 폼으로 수정"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(note)}
            className="p-1.5 hover:bg-red-500/10 rounded-md text-muted-foreground hover:text-red-400 transition-colors"
            title="삭제"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function SortTh({
  label, col, sortKey, sortDir, onSort, className,
}: {
  label: string;
  col: OpsNoteSortKey;
  sortKey: OpsNoteSortKey;
  sortDir: 'asc' | 'desc';
  onSort: (col: OpsNoteSortKey) => void;
  className?: string;
}) {
  const isActive = sortKey === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none group hover:text-foreground transition-colors ${className ?? ''}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          sortDir === 'asc'
            ? <ChevronUp   className="w-3 h-3 text-primary" />
            : <ChevronDown className="w-3 h-3 text-primary" />
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-40 transition-opacity" />
        )}
      </span>
    </th>
  );
}

export function OpsNoteTable({
  notes, services, sortKey, sortDir, onSort,
  onOpen, onEdit, onDelete, onTogglePin, onUpdate, deletingId,
}: OpsNoteTableProps) {
  const serviceMap = Object.fromEntries(services.map((s) => [s.value, s])) as Record<string, OpsNoteServiceMeta>;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <DoubleScrollX>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="px-3 py-3 text-center font-medium text-muted-foreground w-10" title="고정">
                <Pin className="w-3 h-3 inline" />
              </th>
              <SortTh label="서비스" col="service" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-36" />
              <SortTh label="질문"    col="title"   sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">답변 미리보기</th>
              <SortTh label="작성자" col="author"    sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-28" />
              <SortTh label="업데이트" col="updatedAt" sortKey={sortKey} sortDir={sortDir} onSort={onSort} className="w-28" />
              <th className="px-4 py-3 text-center font-medium text-muted-foreground w-32">작업</th>
            </tr>
          </thead>
          <tbody>
            {notes.map((note) => (
              <OpsNoteRow
                key={note.id}
                note={note}
                services={services}
                serviceMap={serviceMap}
                onOpen={onOpen}
                onEdit={onEdit}
                onDelete={onDelete}
                onTogglePin={onTogglePin}
                onUpdate={onUpdate}
                deleting={deletingId === note.id}
              />
            ))}
          </tbody>
        </table>
      </DoubleScrollX>
    </div>
  );
}
