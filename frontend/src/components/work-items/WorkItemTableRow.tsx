import { useState, useRef, useEffect } from 'react';
import { GripVertical, Pencil, Trash2, ImagePlus, Plus, Check, X, GitBranch } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { WorkItem, Cluster, WorkItemUpdate, WorkItemCreate, KanbanStatus } from '@/types';
import { useUpdateWorkItem } from '@/hooks/useWorkItems';
import { ServiceChip } from '@/components/services/ServiceChip';
import { stripHtml } from '@/lib/utils';

const KS_DOT: Record<string, string> = {
  backlog: 'bg-slate-400', todo: 'bg-blue-400', in_progress: 'bg-amber-400',
  review_test: 'bg-purple-400', done: 'bg-emerald-400',
};
const KS_TEXT: Record<string, string> = {
  backlog: 'text-slate-400', todo: 'text-blue-400', in_progress: 'text-amber-400',
  review_test: 'text-purple-400', done: 'text-emerald-400',
};
const KS_LABEL: Record<string, string> = {
  backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress',
  review_test: 'Review', done: 'Done',
};
const KS_OPTIONS: KanbanStatus[] = ['backlog', 'todo', 'in_progress', 'review_test', 'done'];

const PRI_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  high:   { dot: 'bg-red-500',   text: 'text-red-400',   label: 'High' },
  medium: { dot: 'bg-amber-500', text: 'text-amber-400', label: 'Medium' },
  low:    { dot: 'bg-sky-500',   text: 'text-sky-400',   label: 'Low' },
};
const PRI_OPTIONS: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];

function formatDateTime(dateStr?: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDateInput(dateStr?: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayDateInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function hasLocalImages(id: string): boolean {
  try {
    const raw = localStorage.getItem('k8s:img:work-item:' + id);
    if (!raw) return false;
    const arr = JSON.parse(raw) as string[];
    return arr.length > 0;
  } catch {
    return false;
  }
}

type EditField =
  | null
  | 'kanbanStatus'
  | 'priority'
  | 'primaryAssignee'
  | 'secondaryAssignee'
  | 'cluster'
  | 'category'
  | 'content'
  | 'resolution'
  | 'startedAt'
  | 'closedAt'
  | 'remarks';

function EditableCell({
  isEditing, onEnter, children, className = '', title = '클릭하여 수정',
}: {
  isEditing: boolean;
  onEnter: () => void;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  if (isEditing) {
    return <td className={`px-4 py-3 ${className}`}>{children}</td>;
  }
  return (
    <td
      className={`px-4 py-3 select-none cursor-pointer hover:bg-primary/5 transition-colors ${className}`}
      onClick={onEnter}
      title={title}
    >
      {children}
    </td>
  );
}

function TextInlineInput({
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
      className={`w-full px-2 py-1 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary ${className}`}
    />
  );
}

function TextareaInline({
  initial, onSave, onCancel, placeholder,
}: {
  initial: string;
  onSave: (v: string) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const [v, setV] = useState(initial);
  const committed = useRef(false);
  const commit = () => {
    if (committed.current) return;
    committed.current = true;
    if (v === initial) onCancel();
    else onSave(v);
  };
  return (
    <div className="flex flex-col gap-1">
      <textarea
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { committed.current = true; onCancel(); }
        }}
        placeholder={placeholder}
        rows={3}
        className="w-full px-2 py-1 text-sm bg-background border border-primary/40 rounded resize-y focus:outline-none focus:border-primary"
      />
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        <button type="button" onClick={commit} className="p-0.5 text-primary hover:text-primary/80">
          <Check className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={() => { committed.current = true; onCancel(); }} className="p-0.5 hover:text-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
        <span className="ml-auto">Ctrl+Enter 저장 / Esc 취소 · 서식 보존은 ✏ 사용</span>
      </div>
    </div>
  );
}

interface WorkItemTableRowProps {
  item: WorkItem;
  clusters: Cluster[];
  isDragDisabled: boolean;
  onEdit: (item: WorkItem) => void;
  onDelete: (item: WorkItem) => void;
  onAddSubItem: (parent: WorkItem) => void;
}

export function WorkItemTableRow({ item, clusters, isDragDisabled, onEdit, onDelete, onAddSubItem }: WorkItemTableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: isDragDisabled });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  const updateTask = useUpdateWorkItem();
  const [editing, setEditing] = useState<EditField>(null);

  const save = (patch: WorkItemUpdate) => {
    updateTask.mutate({ id: item.id, data: patch }, { onSettled: () => setEditing(null) });
  };

  const ks = item.kanbanStatus ?? 'todo';
  const pStyle = PRI_STYLES[item.priority] ?? PRI_STYLES.medium;
  const hasImages = hasLocalImages(item.id);

  return (
    <tr ref={setNodeRef} style={style} className="border-b border-border last:border-b-0 hover:bg-muted/20 transition-colors">
      <td className="px-2 py-3 w-7">
        {!isDragDisabled && (
          <button {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground p-0.5 rounded">
            <GripVertical className="w-4 h-4" />
          </button>
        )}
      </td>

      {/* Kanban Status */}
      <EditableCell
        isEditing={editing === 'kanbanStatus'}
        onEnter={() => setEditing('kanbanStatus')}
        title="클릭하여 상태 변경"
      >
        {editing === 'kanbanStatus' ? (
          <select
            autoFocus
            value={ks}
            onChange={(e) => {
              const next = e.target.value as KanbanStatus;
              const patch: WorkItemUpdate = { kanbanStatus: next };
              // done 으로 바꾸면 closedAt 자동 채움(아직 비어있을 때)
              if (next === 'done' && !item.closedAt) patch.closedAt = todayDateInput();
              save(patch);
            }}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
            className="w-full px-2 py-1 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary"
          >
            {KS_OPTIONS.map((s) => <option key={s} value={s}>{KS_LABEL[s]}</option>)}
          </select>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${KS_DOT[ks] ?? 'bg-slate-400'}`} />
            <span className={`text-xs font-medium whitespace-nowrap ${KS_TEXT[ks] ?? 'text-slate-400'}`}>
              {KS_LABEL[ks] ?? ks}
            </span>
          </span>
        )}
      </EditableCell>

      {/* Priority */}
      <EditableCell
        isEditing={editing === 'priority'}
        onEnter={() => setEditing('priority')}
        title="클릭하여 우선순위 변경"
      >
        {editing === 'priority' ? (
          <select
            autoFocus
            value={item.priority}
            onChange={(e) => save({ priority: e.target.value })}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
            className="w-full px-2 py-1 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary"
          >
            {PRI_OPTIONS.map((p) => <option key={p} value={p}>{PRI_STYLES[p].label}</option>)}
          </select>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${pStyle.dot}`} />
            <span className={`text-xs font-medium ${pStyle.text}`}>{pStyle.label}</span>
          </span>
        )}
      </EditableCell>

      {/* Assignees */}
      <td className="px-4 py-3 font-medium whitespace-nowrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {editing === 'primaryAssignee' ? (
            <TextInlineInput
              initial={item.primaryAssignee || item.assignee || ''}
              onSave={(v) => save({ primaryAssignee: v, assignee: v })}
              onCancel={() => setEditing(null)}
              placeholder="정 담당자"
              className="text-[11px] w-32"
            />
          ) : (
            <span
              onClick={() => setEditing('primaryAssignee')}
              className="px-2 py-0.5 text-[11px] rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20 cursor-pointer hover:bg-blue-500/20 transition-colors"
              title="클릭하여 수정"
            >
              정: {item.primaryAssignee || item.assignee || '-'}
            </span>
          )}
          {editing === 'secondaryAssignee' ? (
            <TextInlineInput
              initial={item.secondaryAssignee ?? ''}
              onSave={(v) => save({ secondaryAssignee: v || undefined })}
              onCancel={() => setEditing(null)}
              placeholder="부 담당자"
              className="text-[11px] w-32"
            />
          ) : item.secondaryAssignee ? (
            <span
              onClick={() => setEditing('secondaryAssignee')}
              className="px-2 py-0.5 text-[11px] rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20 cursor-pointer hover:bg-purple-500/20 transition-colors"
              title="클릭하여 수정"
            >
              부: {item.secondaryAssignee}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setEditing('secondaryAssignee')}
              className="px-1.5 py-0.5 text-[10px] rounded-full border border-dashed border-border text-muted-foreground/60 hover:text-foreground hover:border-primary/40 transition-colors inline-flex items-center gap-0.5"
              title="부 담당자 추가"
            >
              <Plus className="w-2.5 h-2.5" />부
            </button>
          )}
        </div>
      </td>

      {/* Cluster */}
      <EditableCell
        isEditing={editing === 'cluster'}
        onEnter={() => setEditing('cluster')}
        className="text-muted-foreground whitespace-nowrap"
      >
        {editing === 'cluster' ? (
          <select
            autoFocus
            value={item.clusterId ?? ''}
            onChange={(e) => {
              const id = e.target.value || undefined;
              const name = clusters.find((c) => c.id === id)?.name;
              save({ clusterId: id, clusterName: id ? name : undefined });
            }}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
            className="w-full px-2 py-1 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary"
          >
            <option value="">—</option>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        ) : (item.clusterName || '-')}
      </EditableCell>

      {/* Category */}
      <EditableCell
        isEditing={editing === 'category'}
        onEnter={() => setEditing('category')}
      >
        {editing === 'category' ? (
          <TextInlineInput
            initial={item.category}
            onSave={(v) => save({ category: v })}
            onCancel={() => setEditing(null)}
            placeholder="작업 분류"
          />
        ) : (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary border border-primary/20 whitespace-nowrap">
              {item.category}
            </span>
            {item.service && <ServiceChip service={item.service} />}
          </div>
        )}
      </EditableCell>

      {/* WorkItem content */}
      <EditableCell
        isEditing={editing === 'content'}
        onEnter={() => setEditing('content')}
        className="max-w-xs"
        title="클릭하여 수정 (서식 보존은 ✏ 사용)"
      >
        {editing === 'content' ? (
          <TextareaInline
            initial={stripHtml(item.content)}
            onSave={(v) => save({ content: v })}
            onCancel={() => setEditing(null)}
            placeholder="작업 내용"
          />
        ) : (
          <div className="flex items-start gap-1.5">
            <p className="line-clamp-2 text-foreground/90">{stripHtml(item.content)}</p>
            {hasImages && (
              <span title="이미지 첨부 있음"><ImagePlus className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" /></span>
            )}
          </div>
        )}
      </EditableCell>

      {/* Result content */}
      <EditableCell
        isEditing={editing === 'resolution'}
        onEnter={() => setEditing('resolution')}
        className="max-w-xs"
        title="클릭하여 수정 (서식 보존은 ✏ 사용)"
      >
        {editing === 'resolution' ? (
          <TextareaInline
            initial={stripHtml(item.resolution ?? '')}
            onSave={(v) => save({ resolution: v || undefined })}
            onCancel={() => setEditing(null)}
            placeholder="결과 내용"
          />
        ) : (
          <p className="line-clamp-2 text-muted-foreground">
            {stripHtml(item.resolution) || '-'}
          </p>
        )}
      </EditableCell>

      {/* Scheduled at */}
      <EditableCell
        isEditing={editing === 'startedAt'}
        onEnter={() => setEditing('startedAt')}
        className="text-muted-foreground whitespace-nowrap font-mono text-xs"
      >
        {editing === 'startedAt' ? (
          <input
            autoFocus
            type="date"
            defaultValue={toDateInput(item.startedAt)}
            onBlur={(e) => {
              const v = e.target.value;
              if (v && v !== toDateInput(item.startedAt)) save({ startedAt: v });
              else setEditing(null);
            }}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
            className="px-2 py-1 text-xs bg-background border border-primary/40 rounded focus:outline-none focus:border-primary"
          />
        ) : formatDateTime(item.startedAt)}
      </EditableCell>

      {/* Completed at */}
      <EditableCell
        isEditing={editing === 'closedAt'}
        onEnter={() => setEditing('closedAt')}
        className="text-muted-foreground whitespace-nowrap font-mono text-xs"
      >
        {editing === 'closedAt' ? (
          <input
            autoFocus
            type="date"
            defaultValue={toDateInput(item.closedAt)}
            onBlur={(e) => {
              const v = e.target.value;
              if (v !== toDateInput(item.closedAt)) save({ closedAt: v || null });
              else setEditing(null);
            }}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
            className="px-2 py-1 text-xs bg-background border border-primary/40 rounded focus:outline-none focus:border-primary"
          />
        ) : formatDateTime(item.closedAt)}
      </EditableCell>

      {/* Remarks */}
      <EditableCell
        isEditing={editing === 'remarks'}
        onEnter={() => setEditing('remarks')}
        className="max-w-[120px]"
      >
        {editing === 'remarks' ? (
          <TextInlineInput
            initial={item.remarks ?? ''}
            onSave={(v) => save({ remarks: v || undefined })}
            onCancel={() => setEditing(null)}
            placeholder="비고"
            className="text-xs"
          />
        ) : (
          <p className="line-clamp-2 text-muted-foreground text-xs">
            {item.remarks || '-'}
          </p>
        )}
      </EditableCell>

      <td className="px-4 py-3">
        <div className="flex items-center justify-center gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(item); }}
            className="p-1.5 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground"
            title="전체 수정 (리치 텍스트 / 이미지 포함)"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onAddSubItem(item); }}
            className="p-1.5 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-primary"
            title="하위 작업 추가"
          >
            <GitBranch className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(item); }}
            className="p-1.5 hover:bg-red-500/10 rounded-md transition-colors text-muted-foreground hover:text-red-400"
            title="삭제"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** 인라인 행 추가 — 테이블 꼬리. 필수: category + content + startedAt + primaryAssignee. */
interface AddWorkItemRowProps {
  clusters: Cluster[];
  defaultClusterId?: string;
  defaultAssignee?: string;
  onCreate: (data: WorkItemCreate) => void;
}

export function AddWorkItemRow({ clusters, defaultClusterId, defaultAssignee, onCreate }: AddWorkItemRowProps) {
  const [open, setOpen] = useState(false);
  const [kanbanStatus, setKanbanStatus] = useState<KanbanStatus>('todo');
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [primaryAssignee, setPrimaryAssignee] = useState(defaultAssignee ?? '');
  const [clusterId, setClusterId] = useState(defaultClusterId ?? '');
  const [category, setTaskCategory] = useState('');
  const [content, setTaskContent] = useState('');
  const [startedAt, setScheduledAt] = useState(todayDateInput());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const reset = () => {
    setKanbanStatus('todo');
    setPriority('medium');
    setPrimaryAssignee(defaultAssignee ?? '');
    setClusterId(defaultClusterId ?? '');
    setTaskCategory('');
    setTaskContent('');
    setScheduledAt(todayDateInput());
  };

  const canSave = !!category.trim() && !!content.trim() && !!primaryAssignee.trim() && !!startedAt;

  const submit = () => {
    if (!canSave) return;
    const name = clusters.find((c) => c.id === clusterId)?.name;
    onCreate({
      type: 'task',
      assignee: primaryAssignee.trim(),
      primaryAssignee: primaryAssignee.trim(),
      kanbanStatus,
      priority,
      clusterId: clusterId || undefined,
      clusterName: clusterId ? name : undefined,
      category: category.trim(),
      content: content.trim(),
      startedAt,
    });
    reset();
    setOpen(false);
  };

  if (!open) {
    return (
      <tr className="border-t border-border bg-muted/10">
        <td colSpan={11}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-full px-3 py-2.5 text-xs text-muted-foreground hover:text-primary hover:bg-primary/5 flex items-center justify-center gap-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> 행 추가
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-border bg-primary/[0.04]">
      <td className="px-2 py-3 w-7" />
      <td className="px-4 py-3">
        <select value={kanbanStatus} onChange={(e) => setKanbanStatus(e.target.value as KanbanStatus)}
          className="w-full px-1.5 py-1 text-xs bg-background border border-border rounded">
          {KS_OPTIONS.map((s) => <option key={s} value={s}>{KS_LABEL[s]}</option>)}
        </select>
      </td>
      <td className="px-4 py-3">
        <select value={priority} onChange={(e) => setPriority(e.target.value as 'high' | 'medium' | 'low')}
          className="w-full px-1.5 py-1 text-xs bg-background border border-border rounded">
          {PRI_OPTIONS.map((p) => <option key={p} value={p}>{PRI_STYLES[p].label}</option>)}
        </select>
      </td>
      <td className="px-4 py-3">
        <input
          ref={inputRef}
          type="text"
          value={primaryAssignee}
          onChange={(e) => setPrimaryAssignee(e.target.value)}
          placeholder="정 담당자 (필수)"
          className="w-32 px-2 py-1 text-xs bg-background border border-border rounded"
        />
      </td>
      <td className="px-4 py-3">
        <select value={clusterId} onChange={(e) => setClusterId(e.target.value)}
          className="w-full px-1.5 py-1 text-xs bg-background border border-border rounded">
          <option value="">—</option>
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </td>
      <td className="px-4 py-3">
        <input type="text" value={category} onChange={(e) => setTaskCategory(e.target.value)}
          placeholder="분류 (필수)"
          className="w-full px-2 py-1 text-xs bg-background border border-border rounded" />
      </td>
      <td className="px-4 py-3" colSpan={2}>
        <input type="text" value={content} onChange={(e) => setTaskContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) { e.preventDefault(); submit(); }
            if (e.key === 'Escape') { reset(); setOpen(false); }
          }}
          placeholder="작업 내용 (필수, Enter 저장)"
          className="w-full px-2 py-1 text-xs bg-background border border-border rounded" />
      </td>
      <td className="px-4 py-3">
        <input type="date" value={startedAt} onChange={(e) => setScheduledAt(e.target.value)}
          className="w-full px-1.5 py-1 text-xs bg-background border border-border rounded font-mono" />
      </td>
      <td className="px-4 py-3" />
      <td className="px-4 py-3" />
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1 items-center">
          <button type="button" onClick={submit} disabled={!canSave}
            className="px-2 py-1 text-[11px] rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1">
            <Check className="w-3 h-3" /> 저장
          </button>
          <button type="button" onClick={() => { reset(); setOpen(false); }}
            className="px-2 py-1 text-[11px] rounded-md text-muted-foreground hover:bg-secondary inline-flex items-center gap-1">
            <X className="w-3 h-3" /> 취소
          </button>
        </div>
      </td>
    </tr>
  );
}
