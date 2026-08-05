import { useState, useRef, useEffect } from 'react';
import { GripVertical, Pencil, Trash2, ImagePlus, Plus, Check, X, GitBranch, ExternalLink, RefreshCw, Upload, Loader2, Rocket, Link2Off, ChevronRight, ChevronDown } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { WorkItem, Cluster, WorkItemUpdate, WorkItemCreate, KanbanStatus } from '@/types';
import { useUpdateWorkItem } from '@/hooks/useWorkItems';
import { ServiceChip } from '@/components/services/ServiceChip';
import { Badge } from '@/components/ui/badge';
import { stripHtml, formatApiError } from '@/lib/utils';
import { useToast } from '@/components/common';
import { DocLinkChip } from './DocLinkChip';
import { JiraIssueChip } from './JiraIssueChip';
import type { WorkItemColumnKey } from './workItemColumns';

// 상태색은 semantic status 토큰으로 (D-011). backlog=대기→unknown, todo=정보→info,
// in_progress=진행중→warning, done=완료→healthy. review_test 는 status 토큰이 없는
// 장식(purple)이므로 임의 status 대신 중립 토큰(muted)으로 둔다.
const KS_DOT: Record<string, string> = {
  backlog: 'bg-status-unknown', todo: 'bg-status-info', in_progress: 'bg-status-warning',
  review_test: 'bg-muted-foreground', done: 'bg-status-healthy',
};
const KS_TEXT: Record<string, string> = {
  backlog: 'text-status-unknown', todo: 'text-status-info', in_progress: 'text-status-warning',
  review_test: 'text-muted-foreground', done: 'text-status-healthy',
};
const KS_LABEL: Record<string, string> = {
  backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress',
  review_test: 'Review', done: 'Done',
};
const KS_OPTIONS: KanbanStatus[] = ['backlog', 'todo', 'in_progress', 'review_test', 'done'];

const PRI_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  high:   { dot: 'bg-status-critical', text: 'text-status-critical', label: 'High' },
  medium: { dot: 'bg-status-warning',  text: 'text-status-warning',  label: 'Medium' },
  low:    { dot: 'bg-status-info',     text: 'text-status-info',     label: 'Low' },
};
const PRI_OPTIONS: Array<'high' | 'medium' | 'low'> = ['high', 'medium', 'low'];

/** Jira statusCategory.key → 점 색. 프로젝트마다 상태명이 달라도 색은 일관되게 간다. */
const JIRA_CAT_DOT: Record<string, string> = {
  new: 'bg-status-info', indeterminate: 'bg-status-warning', done: 'bg-status-healthy',
};
const JIRA_CAT_TEXT: Record<string, string> = {
  new: 'text-status-info', indeterminate: 'text-status-warning', done: 'text-status-healthy',
};

/** Jira 이슈 종류 배지 색 — Epic/Sub-task 를 눈으로 바로 구분할 수 있게. */
function jiraTypeClass(type: string): string {
  const t = type.toLowerCase();
  if (t === 'epic') return 'bg-purple-500/15 text-purple-500 border-purple-500/30';
  if (t.includes('sub')) return 'bg-sky-500/15 text-sky-500 border-sky-500/30';
  if (t === 'bug' || t === '버그' || t === '결함') return 'bg-status-critical/15 text-status-critical border-status-critical/30';
  return 'bg-secondary text-muted-foreground border-border';
}

/** 컴포넌트/라벨 같은 문자열 목록을 작은 칩으로. 비면 '-'. */
function ChipList({ values, className = '' }: { values?: string[] | null; className?: string }) {
  if (!values || values.length === 0) return <span className="text-muted-foreground/50">-</span>;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {values.map((v) => (
        <span key={v} className={`px-1.5 py-0.5 text-[11px] rounded border border-border bg-secondary/60 whitespace-nowrap ${className}`}>
          {v}
        </span>
      ))}
    </div>
  );
}

function formatDateTime(dateStr?: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 날짜만(시간 제외) 표시. 기본 표시는 이 형식, '시간 표시' 옵션이 켜지면 formatDateTime 사용. */
function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  | 'dueDate'
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
    return <td className={`px-4 py-1.5 ${className}`}>{children}</td>;
  }
  return (
    <td
      role="button"
      tabIndex={0}
      className={`px-4 py-1.5 select-none cursor-pointer hover:bg-primary/5 focus:outline-none focus:ring-1 focus:ring-primary/40 transition-colors ${className}`}
      onClick={onEnter}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEnter(); }
      }}
      title={title}
      aria-label={title}
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
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
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
  /** 표시할 컬럼 키 (순서대로). 행 드래그 핸들은 별도 선두 고정. */
  columns: WorkItemColumnKey[];
  /** projectId → 프로젝트명 매핑 (읽기전용 표시용). */
  projectNameById: Map<string, string>;
  /** sprintId → 스프린트명 매핑 (읽기전용 표시용). */
  sprintNameById?: Map<string, string>;
  isDragDisabled: boolean;
  /** 시작일/완료일 셀에 시간까지 표시할지. 기본 false(날짜만). */
  showTime?: boolean;
  onEdit: (item: WorkItem) => void;
  onDelete: (item: WorkItem) => void;
  onAddSubItem: (parent: WorkItem) => void;
  /** 제목 클릭 시 상세 보기 진입. */
  onOpenDetail: (item: WorkItem) => void;
  /** Jira 연결 업무 — 행 단위 재가져오기 / Jira 로 보내기 (연결된 행에서만 노출). */
  onJiraRefresh?: (item: WorkItem) => void;
  onJiraPush?: (item: WorkItem) => void;
  /** 이 행에서 Jira 동기화가 진행 중인지 (버튼 스피너/중복 클릭 방지). */
  jiraBusy?: boolean;
  /** 아직 Jira 와 연결되지 않은 업무 — Jira·Confluence 자동 생성 진입. */
  onJiraProvision?: (item: WorkItem) => void;
  /** 연결 관리(해제/다른 이슈로 변경/업무 삭제) 다이얼로그 진입. */
  onJiraLink?: (item: WorkItem) => void;
  /** Confluence 연결 업무 — 현재 내용을 연결된 문서에 반영(재게시). Jira "보내기"와 동일 역할. */
  onConfluenceSync?: (item: WorkItem) => void;
  /** 이 행에서 Confluence 동기화가 진행 중인지 (버튼 스피너/중복 클릭 방지). */
  confluenceBusy?: boolean;
}

export function WorkItemTableRow({
  item, clusters, columns, projectNameById, sprintNameById, isDragDisabled, showTime = false,
  onEdit, onDelete, onAddSubItem, onOpenDetail, onJiraRefresh, onJiraPush, onJiraProvision, onJiraLink,
  jiraBusy = false, onConfluenceSync, confluenceBusy = false,
}: WorkItemTableRowProps) {
  const fmtDate = showTime ? formatDateTime : formatDate;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id, disabled: isDragDisabled });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  const updateTask = useUpdateWorkItem();
  const toast = useToast();
  const [editing, setEditing] = useState<EditField>(null);
  const [confluenceLinksOpen, setConfluenceLinksOpen] = useState(false);

  const save = (patch: WorkItemUpdate) => {
    updateTask.mutate({ id: item.id, data: patch }, {
      onSettled: () => setEditing(null),
      onError: (err) => toast.error('수정 실패', formatApiError(err, '수정할 수 없습니다.')),
    });
  };

  const ks = item.kanbanStatus ?? 'todo';
  const pStyle = PRI_STYLES[item.priority] ?? PRI_STYLES.medium;
  const hasImages = hasLocalImages(item.id);

  // 컬럼 키 → 셀. 순서/표시여부는 호출부(columns)가 결정한다.
  const renderCell = (key: WorkItemColumnKey): React.ReactNode => {
    switch (key) {
      case 'project':
        return (
          <td key="project" className="px-4 py-1.5 text-muted-foreground whitespace-nowrap">
            {item.projectId
              ? (projectNameById.get(item.projectId) ?? '-')
              : <span className="text-muted-foreground/50">-</span>}
          </td>
        );

      case 'sprint':
        return (
          <td key="sprint" className="px-4 py-1.5 text-muted-foreground whitespace-nowrap">
            {item.sprintId
              ? (sprintNameById?.get(item.sprintId) ?? '-')
              : <span className="text-muted-foreground/50">-</span>}
          </td>
        );

      case 'status':
        return (
          <EditableCell key="status" isEditing={editing === 'kanbanStatus'} onEnter={() => setEditing('kanbanStatus')} title="클릭하여 상태 변경">
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
            ) : item.jiraStatus ? (
              // Jira 연결 업무는 **Jira 원본 상태명**을 그대로 보여준다 — 칸반 5단계로
              // 축약해 표시하면 화면과 Jira 가 달라 보여 혼란이 생긴다. 점 색은
              // statusCategory 기준이라 커스텀 워크플로에서도 의미가 유지된다.
              <span className="flex items-center gap-1.5" title={`Jira 상태: ${item.jiraStatus} (클릭하면 PEP 진행 상태 변경)`}>
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  JIRA_CAT_DOT[item.jiraStatusCategory ?? ''] ?? KS_DOT[ks] ?? 'bg-status-unknown'
                }`} />
                <span className={`text-sm font-medium whitespace-nowrap ${
                  JIRA_CAT_TEXT[item.jiraStatusCategory ?? ''] ?? KS_TEXT[ks] ?? 'text-status-unknown'
                }`}>
                  {item.jiraStatus}
                </span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${KS_DOT[ks] ?? 'bg-status-unknown'}`} />
                <span className={`text-sm font-medium whitespace-nowrap ${KS_TEXT[ks] ?? 'text-status-unknown'}`}>
                  {KS_LABEL[ks] ?? ks}
                </span>
              </span>
            )}
          </EditableCell>
        );

      case 'priority':
        return (
          <EditableCell key="priority" isEditing={editing === 'priority'} onEnter={() => setEditing('priority')} title="클릭하여 우선순위 변경">
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
              <Badge variant="outline" dot dotClassName={pStyle.dot} className={`border-transparent px-0 py-0 text-sm font-medium ${pStyle.text}`}>
                {pStyle.label}
              </Badge>
            )}
          </EditableCell>
        );

      case 'assignee':
        return (
          <td key="assignee" className="px-4 py-1.5 font-medium whitespace-nowrap">
            <div className="flex items-center gap-1.5 flex-wrap">
              {editing === 'primaryAssignee' ? (
                <TextInlineInput
                  initial={item.primaryAssignee || item.assignee || ''}
                  onSave={(v) => save({ primaryAssignee: v, assignee: v })}
                  onCancel={() => setEditing(null)}
                  placeholder="정 담당자"
                  className="text-xs w-32"
                />
              ) : (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditing('primaryAssignee')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing('primaryAssignee'); }
                  }}
                  className="px-2 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground border border-border cursor-pointer hover:bg-secondary/80 focus:outline-none focus:ring-1 focus:ring-primary/40 transition-colors"
                  title="클릭하여 수정"
                  aria-label="정 담당자 클릭하여 수정"
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
                  className="text-xs w-32"
                />
              ) : item.secondaryAssignee ? (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditing('secondaryAssignee')}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditing('secondaryAssignee'); }
                  }}
                  className="px-2 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground border border-border cursor-pointer hover:bg-secondary/80 focus:outline-none focus:ring-1 focus:ring-primary/40 transition-colors"
                  title="클릭하여 수정"
                  aria-label="부 담당자 클릭하여 수정"
                >
                  부: {item.secondaryAssignee}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing('secondaryAssignee')}
                  className="px-1.5 py-0.5 text-xs rounded-full border border-dashed border-border text-muted-foreground/60 hover:text-foreground hover:border-primary/40 transition-colors inline-flex items-center gap-0.5"
                  title="부 담당자 추가"
                >
                  <Plus className="w-2.5 h-2.5" />부
                </button>
              )}
            </div>
          </td>
        );

      case 'cluster':
        return (
          <EditableCell key="cluster" isEditing={editing === 'cluster'} onEnter={() => setEditing('cluster')} className="text-muted-foreground whitespace-nowrap">
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
            ) : (
              item.clusterName
                ? <>{item.clusterName}{item.clusterIds && item.clusterIds.length > 1 && <span className="text-primary"> +{item.clusterIds.length - 1}</span>}</>
                : '-'
            )}
          </EditableCell>
        );

      case 'category':
        return (
          <EditableCell key="category" isEditing={editing === 'category'} onEnter={() => setEditing('category')}>
            {editing === 'category' ? (
              <TextInlineInput
                initial={item.category}
                onSave={(v) => save({ category: v })}
                onCancel={() => setEditing(null)}
                placeholder="업무 분류"
              />
            ) : (
              <div className="flex items-center gap-1 flex-wrap">
                <span className="px-2 py-0.5 text-sm rounded-full bg-primary/10 text-primary border border-primary/20 whitespace-nowrap">
                  {item.category}
                </span>
                {item.service && <ServiceChip service={item.service} />}
              </div>
            )}
          </EditableCell>
        );

      case 'title':
        // 제목 클릭 → 상세 보기. title 미설정 레거시 항목은 내용 첫 줄로 대체.
        return (
          <td key="title" className="px-4 py-1.5 max-w-xs">
            <div className="flex items-start gap-1.5">
              {item.jiraIssueKey && (
                <a
                  href={item.jiraUrl ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={`Jira ${item.jiraIssueKey}${item.jiraStatus ? ` · ${item.jiraStatus}` : ''} (새 창)`}
                  className="flex-shrink-0 mt-0.5 inline-flex items-center font-mono text-[10px] font-semibold px-1 py-0.5 rounded bg-brand-jira/10 text-brand-jira dark:text-blue-300 border border-brand-jira/20 hover:bg-brand-jira/20"
                >
                  {item.jiraIssueKey}
                </a>
              )}
              {/* Jira 키 박스 옆의 Confluence 문서 박스 — 없으면 그 자리에서 링크를 붙인다. */}
              <DocLinkChip
                url={item.confluenceUrl}
                onSave={(url) => save({ confluenceUrl: url || null })}
              />
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenDetail(item); }}
                className="text-left flex-1 min-w-0 text-foreground/90 hover:text-primary transition-colors"
                title="클릭하여 상세 보기"
              >
                <span className="line-clamp-2 hover:underline">
                  {item.title?.trim() || stripHtml(item.content) || '-'}
                </span>
              </button>
            </div>
          </td>
        );

      case 'content':
        return (
          <EditableCell key="content" isEditing={editing === 'content'} onEnter={() => setEditing('content')} className="max-w-xs" title="클릭하여 수정 (서식 보존은 ✏ 사용)">
            {editing === 'content' ? (
              <TextareaInline
                initial={stripHtml(item.content)}
                onSave={(v) => save({ content: v })}
                onCancel={() => setEditing(null)}
                placeholder="업무 내용"
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
        );

      case 'result':
        return (
          <EditableCell key="result" isEditing={editing === 'resolution'} onEnter={() => setEditing('resolution')} className="max-w-xs" title="클릭하여 수정 (서식 보존은 ✏ 사용)">
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
        );

      case 'startedAt':
        return (
          <EditableCell key="startedAt" isEditing={editing === 'startedAt'} onEnter={() => setEditing('startedAt')} className="text-muted-foreground whitespace-nowrap font-mono text-sm">
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
                className="px-2 py-1 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary"
              />
            ) : fmtDate(item.startedAt)}
          </EditableCell>
        );

      case 'closedAt':
        return (
          <EditableCell key="closedAt" isEditing={editing === 'closedAt'} onEnter={() => setEditing('closedAt')} className="text-muted-foreground whitespace-nowrap font-mono text-sm">
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
                className="px-2 py-1 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary"
              />
            ) : fmtDate(item.closedAt)}
          </EditableCell>
        );

      case 'dueDate': {
        // 마감 지났고 아직 완료 안 됐으면 강조(closedAt 과 같은 인라인 편집 패턴).
        const overdue = !!item.dueDate && item.kanbanStatus !== 'done'
          && toDateInput(item.dueDate) < todayDateInput();
        return (
          <EditableCell key="dueDate" isEditing={editing === 'dueDate'} onEnter={() => setEditing('dueDate')}
            className={`whitespace-nowrap font-mono text-sm ${overdue ? 'text-status-critical' : 'text-muted-foreground'}`}>
            {editing === 'dueDate' ? (
              <input
                autoFocus
                type="date"
                defaultValue={toDateInput(item.dueDate)}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (v !== toDateInput(item.dueDate)) save({ dueDate: v || null });
                  else setEditing(null);
                }}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
                className="px-2 py-1 text-sm bg-background border border-primary/40 rounded focus:outline-none focus:border-primary"
              />
            ) : fmtDate(item.dueDate)}
          </EditableCell>
        );
      }

      case 'jiraLink':
        return (
          <td key="jiraLink" className="px-4 py-1.5 whitespace-nowrap">
            {item.jiraUrl ? (
              <a
                href={item.jiraUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={item.jiraUrl}
                className="inline-flex items-center gap-1 text-sm text-brand-jira dark:text-blue-300 hover:underline"
              >
                <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                {item.jiraIssueKey || 'Jira'}
              </a>
            ) : (
              <span className="text-muted-foreground/50 text-sm">-</span>
            )}
          </td>
        );

      case 'confluenceLink': {
        // 다중 링크(Jira 원격 링크에서 찾은 전체 목록)가 있으면 배지+드롭다운, 없으면
        // 기존처럼 대표(단일) 링크만 표시(하위호환).
        const links = item.confluenceLinks ?? [];
        if (links.length > 1) {
          return (
            <td key="confluenceLink" className="px-4 py-1.5 whitespace-nowrap relative">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setConfluenceLinksOpen((v) => !v); }}
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                Confl. {links.length}
                <ChevronDown className="w-3 h-3 opacity-60" />
              </button>
              {confluenceLinksOpen && (
                <>
                  <div className="fixed inset-0 z-30" onClick={(e) => { e.stopPropagation(); setConfluenceLinksOpen(false); }} />
                  <div className="absolute left-0 top-full mt-1 z-40 bg-card border border-border rounded-lg mac-shadow p-1 min-w-[220px] max-w-xs">
                    {links.map((link, i) => (
                      <a
                        key={link.url + i}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title={link.url}
                        className="block px-2 py-1.5 rounded-md text-sm text-foreground hover:bg-secondary truncate"
                      >
                        {link.title || link.url}
                      </a>
                    ))}
                  </div>
                </>
              )}
            </td>
          );
        }
        return (
          <td key="confluenceLink" className="px-4 py-1.5 whitespace-nowrap">
            {item.confluenceUrl ? (
              <a
                href={item.confluenceUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={item.confluenceUrl}
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
                Confl.
              </a>
            ) : (
              <span className="text-muted-foreground/50 text-sm">-</span>
            )}
          </td>
        );
      }

      case 'jiraEpic':
        // "상위업무" — Epic→Task 체인을 가시화한다. 둘 다 있고 서로 다르면 Epic 칩 →
        // 화살표 → 상위(Task) 칩을 나란히, 하나만 있으면 그 칩만(기존 동작 유지).
        return (
          <td key="jiraEpic" className="px-4 py-1.5 max-w-xs">
            {(() => {
              const hasEpic = !!(item.jiraEpicKey || item.jiraEpic);
              const hasParent = !!item.jiraParentKey && item.jiraParentKey !== item.jiraEpicKey;
              if (!hasEpic && !hasParent) return <span className="text-muted-foreground/50">-</span>;
              const jiraKeyUrl = (key: string) =>
                item.jiraUrl ? item.jiraUrl.replace(/\/browse\/.*$/, `/browse/${key}`) : undefined;
              return (
                <div className="flex items-center gap-1 min-w-0">
                  {hasEpic && (
                    <JiraIssueChip
                      issueKey={item.jiraEpicKey ?? undefined}
                      title={item.jiraEpicKey ? item.jiraEpicSummary ?? undefined : item.jiraEpic ?? undefined}
                      url={item.jiraEpicKey ? jiraKeyUrl(item.jiraEpicKey) : undefined}
                    />
                  )}
                  {hasEpic && hasParent && (
                    <ChevronRight className="w-3 h-3 flex-shrink-0 text-muted-foreground/50" />
                  )}
                  {hasParent && (
                    <JiraIssueChip
                      issueKey={item.jiraParentKey ?? undefined}
                      title={item.jiraParentSummary ?? undefined}
                      url={item.jiraParentKey ? jiraKeyUrl(item.jiraParentKey) : undefined}
                    />
                  )}
                </div>
              );
            })()}
          </td>
        );

      case 'jiraType':
        return (
          <td key="jiraType" className="px-4 py-1.5 whitespace-nowrap">
            {item.jiraIssueType ? (
              <span className={`inline-flex items-center px-1.5 py-0.5 text-[11px] font-medium rounded border ${jiraTypeClass(item.jiraIssueType)}`}>
                {item.jiraIssueType}
              </span>
            ) : (
              <span className="text-muted-foreground/50">-</span>
            )}
          </td>
        );

      case 'jiraComponents':
        return (
          <td key="jiraComponents" className="px-4 py-1.5">
            <ChipList values={item.jiraComponents} />
          </td>
        );

      case 'jiraLabels':
        return (
          <td key="jiraLabels" className="px-4 py-1.5">
            <ChipList values={item.jiraLabels} className="text-primary border-primary/20 bg-primary/10" />
          </td>
        );

      case 'remarks':
        return (
          <EditableCell key="remarks" isEditing={editing === 'remarks'} onEnter={() => setEditing('remarks')} className="max-w-[120px]">
            {editing === 'remarks' ? (
              <TextInlineInput
                initial={item.remarks ?? ''}
                onSave={(v) => save({ remarks: v || undefined })}
                onCancel={() => setEditing(null)}
                placeholder="비고"
                className="text-sm"
              />
            ) : (
              <p className="line-clamp-2 text-muted-foreground text-sm">
                {item.remarks || '-'}
              </p>
            )}
          </EditableCell>
        );

      case 'actions':
        return (
          <td key="actions" className="px-4 py-1.5">
            <div className="flex items-center justify-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(item); }}
                className="p-1.5 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground"
                title="전체 수정 (리치 텍스트 / 이미지 포함)"
                aria-label="전체 수정 (리치 텍스트 / 이미지 포함)"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              {(!item.jiraIssueKey || item.provisionStatus === 'partial') && onJiraProvision && (
                <button
                  onClick={(e) => { e.stopPropagation(); onJiraProvision(item); }}
                  className={`p-1.5 hover:bg-secondary rounded-md transition-colors ${
                    item.provisionStatus === 'partial'
                      ? 'text-amber-500 hover:text-amber-400'
                      : 'text-muted-foreground hover:text-primary'
                  }`}
                  title={item.provisionStatus === 'partial'
                    ? `일부만 생성됨 — ${!item.jiraIssueKey ? item.provisionJiraError || 'Jira 생성 실패' : item.provisionConfluenceError || 'Confluence 생성 실패'} (클릭해서 재시도)`
                    : 'Jira 이슈 · Confluence 문서 자동 생성'}
                  aria-label={item.provisionStatus === 'partial' ? '일부만 생성됨 — 재시도' : 'Jira · Confluence 자동 생성'}
                >
                  <Rocket className="w-3.5 h-3.5" />
                </button>
              )}
              {item.jiraIssueKey && onJiraRefresh && (
                <button
                  onClick={(e) => { e.stopPropagation(); onJiraRefresh(item); }}
                  disabled={jiraBusy}
                  className="p-1.5 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-brand-jira disabled:opacity-50"
                  title={`Jira(${item.jiraIssueKey})에서 다시 가져오기`}
                  aria-label={`Jira ${item.jiraIssueKey} 다시 가져오기`}
                >
                  {jiraBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                </button>
              )}
              {item.jiraIssueKey && onJiraPush && (
                <button
                  onClick={(e) => { e.stopPropagation(); onJiraPush(item); }}
                  disabled={jiraBusy}
                  className="p-1.5 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-brand-jira disabled:opacity-50"
                  title={`수정한 내용을 Jira(${item.jiraIssueKey})로 보내기`}
                  aria-label={`Jira ${item.jiraIssueKey} 로 보내기`}
                >
                  <Upload className="w-3.5 h-3.5" />
                </button>
              )}
              {item.jiraIssueKey && onJiraLink && (
                <button
                  onClick={(e) => { e.stopPropagation(); onJiraLink(item); }}
                  className="p-1.5 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-brand-jira"
                  title={`Jira 연결 관리 (${item.jiraIssueKey} 해제 · 다른 이슈로 변경)`}
                  aria-label={`Jira ${item.jiraIssueKey} 연결 관리`}
                >
                  <Link2Off className="w-3.5 h-3.5" />
                </button>
              )}
              {item.confluenceUrl && onConfluenceSync && (
                <button
                  onClick={(e) => { e.stopPropagation(); onConfluenceSync(item); }}
                  disabled={confluenceBusy}
                  className="p-1.5 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-status-info disabled:opacity-50"
                  title="수정한 내용을 연결된 Confluence 문서에 반영"
                  aria-label="Confluence 문서 동기화"
                >
                  {confluenceBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onAddSubItem(item); }}
                className="p-1.5 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-primary"
                title="하위 업무 추가"
                aria-label="하위 업무 추가"
              >
                <GitBranch className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(item); }}
                className="p-1.5 hover:bg-status-critical/10 rounded-md transition-colors text-muted-foreground hover:text-status-critical"
                title="삭제"
                aria-label="삭제"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </td>
        );

      default:
        return null;
    }
  };

  return (
    <tr ref={setNodeRef} style={style} className="border-b border-border last:border-b-0 hover:bg-muted/20 transition-colors">
      <td className="px-2 py-1.5 w-7">
        {!isDragDisabled && (
          <button {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground p-0.5 rounded">
            <GripVertical className="w-4 h-4" />
          </button>
        )}
      </td>
      {columns.map((key) => renderCell(key))}
    </tr>
  );
}

/** 인라인 행 추가 — 헤더 바로 아래(목록 최상단). 필수: category + content + startedAt + primaryAssignee.
 *  컬럼 개인화(순서/숨김)와 무관하게 동작하도록 colSpan 한 줄 폼으로 렌더한다. */
interface AddWorkItemRowProps {
  clusters: Cluster[];
  /** 표시 컬럼 수 + 드래그 핸들(1) — 폼을 가로로 펼칠 colSpan. */
  colSpan: number;
  defaultClusterId?: string;
  defaultAssignee?: string;
  onCreate: (data: WorkItemCreate) => void;
}

export function AddWorkItemRow({ clusters, colSpan, defaultClusterId, defaultAssignee, onCreate }: AddWorkItemRowProps) {
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
      // 헤더 바로 아래(목록 최상단)에 배치되므로 아래쪽 경계선으로 다음 행과 구분한다.
      <tr className="border-b border-border bg-muted/10">
        <td colSpan={colSpan}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-full px-3 py-1.5 text-sm text-muted-foreground hover:text-primary hover:bg-primary/5 flex items-center justify-center gap-1.5 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> 행 추가
          </button>
        </td>
      </tr>
    );
  }

  // 컬럼 표시/순서와 독립적인 한 줄 폼 — 필수 입력(분류·내용·시작일·정담당)을 항상 노출.
  return (
    <tr className="border-b border-border bg-primary/[0.04]">
      <td colSpan={colSpan} className="px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <select value={kanbanStatus} onChange={(e) => setKanbanStatus(e.target.value as KanbanStatus)}
            aria-label="상태 선택"
            className="px-1.5 py-1 text-sm bg-background border border-border rounded">
            {KS_OPTIONS.map((s) => <option key={s} value={s}>{KS_LABEL[s]}</option>)}
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value as 'high' | 'medium' | 'low')}
            aria-label="우선순위 선택"
            className="px-1.5 py-1 text-sm bg-background border border-border rounded">
            {PRI_OPTIONS.map((p) => <option key={p} value={p}>{PRI_STYLES[p].label}</option>)}
          </select>
          <input
            ref={inputRef}
            type="text"
            value={primaryAssignee}
            onChange={(e) => setPrimaryAssignee(e.target.value)}
            placeholder="정 담당자 (필수)"
            aria-label="정 담당자 입력"
            className="w-32 px-2 py-1 text-sm bg-background border border-border rounded"
          />
          <select value={clusterId} onChange={(e) => setClusterId(e.target.value)}
            aria-label="클러스터 선택"
            className="px-1.5 py-1 text-sm bg-background border border-border rounded">
            <option value="">— 클러스터 —</option>
            {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="text" value={category} onChange={(e) => setTaskCategory(e.target.value)}
            placeholder="분류 (필수)"
            aria-label="분류 입력"
            className="w-32 px-2 py-1 text-sm bg-background border border-border rounded" />
          <input type="text" value={content} onChange={(e) => setTaskContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) { e.preventDefault(); submit(); }
              if (e.key === 'Escape') { reset(); setOpen(false); }
            }}
            placeholder="업무 내용 (필수, Enter 저장)"
            aria-label="업무 내용 입력"
            className="flex-1 min-w-[180px] px-2 py-1 text-sm bg-background border border-border rounded" />
          <input type="date" value={startedAt} onChange={(e) => setScheduledAt(e.target.value)}
            aria-label="시작일 입력"
            className="px-1.5 py-1 text-sm bg-background border border-border rounded font-mono" />
          <button type="button" onClick={submit} disabled={!canSave}
            aria-label="저장"
            className="px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1">
            <Check className="w-3 h-3" /> 저장
          </button>
          <button type="button" onClick={() => { reset(); setOpen(false); }}
            aria-label="취소"
            className="px-2.5 py-1 text-xs rounded-md text-muted-foreground hover:bg-secondary inline-flex items-center gap-1">
            <X className="w-3 h-3" /> 취소
          </button>
        </div>
      </td>
    </tr>
  );
}
