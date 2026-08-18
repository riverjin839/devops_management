import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import type { WorkItem } from '@/types';
import { stripHtml } from '@/lib/utils';
import { JiraIssueChip } from './JiraIssueChip';
import { WorkItemActionsMenu, type WorkItemActionsMenuProps } from './WorkItemActionsMenu';

// WorkItemTableRow.tsx 의 KS_DOT/KS_TEXT/KS_LABEL/PRI_STYLES/JIRA_CAT_*/jiraTypeClass 와 동일한
// 색 토큰 — 목록 뷰와 에픽 뷰가 같은 상태/우선순위를 다른 색으로 보여주면 안 되므로 값을
// 그대로 맞춘다(테이블 전용 인라인 편집 로직은 없어 컴포넌트 자체 공유는 하지 않음).
const KS_DOT: Record<string, string> = {
  backlog: 'bg-status-unknown', todo: 'bg-status-info', in_progress: 'bg-status-warning',
  review_test: 'bg-muted-foreground', done: 'bg-status-healthy',
};
const KS_TEXT: Record<string, string> = {
  backlog: 'text-status-unknown', todo: 'text-status-info', in_progress: 'text-status-warning',
  review_test: 'text-muted-foreground', done: 'text-status-healthy',
};
const KS_LABEL: Record<string, string> = {
  backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress', review_test: 'Review', done: 'Done',
};
const JIRA_CAT_DOT: Record<string, string> = {
  new: 'bg-status-info', indeterminate: 'bg-status-warning', done: 'bg-status-healthy',
};
const JIRA_CAT_TEXT: Record<string, string> = {
  new: 'text-status-info', indeterminate: 'text-status-warning', done: 'text-status-healthy',
};
const PRI_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  high:   { dot: 'bg-status-critical', text: 'text-status-critical', label: 'High' },
  medium: { dot: 'bg-status-warning',  text: 'text-status-warning',  label: 'Medium' },
  low:    { dot: 'bg-status-info',     text: 'text-status-info',     label: 'Low' },
};

function jiraTypeClass(type: string): string {
  const t = type.toLowerCase();
  if (t === 'epic') return 'bg-[hsl(var(--chart-4)/0.15)] text-[hsl(var(--chart-4))] border-[hsl(var(--chart-4)/0.3)]';
  if (t.includes('sub')) return 'bg-[hsl(var(--chart-6)/0.15)] text-[hsl(var(--chart-6))] border-[hsl(var(--chart-6)/0.3)]';
  if (t === 'bug' || t === '버그' || t === '결함') return 'bg-status-critical/15 text-status-critical border-status-critical/30';
  return 'bg-secondary text-muted-foreground border-border';
}

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '-';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayDateInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── 계층 구성 ──────────────────────────────────────────────────────────────────
interface TreeNode {
  item: WorkItem;
  children: TreeNode[];
}

interface EpicGroup {
  key: string;
  jiraKey: string | null;
  label: string;
  nodes: TreeNode[];
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function sortSiblings(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    const po = (PRIORITY_ORDER[a.item.priority] ?? 1) - (PRIORITY_ORDER[b.item.priority] ?? 1);
    if (po !== 0) return po;
    return a.item.startedAt.localeCompare(b.item.startedAt);
  });
}

/** 하위 업무 체인 — PEP 자체 상하위(parentId)와 Jira Task→Sub-task(jiraParentKey→jiraIssueKey)
 *  둘 다 지원한다. 상위가 현재 필터·검색 결과에 없으면(다른 조건으로 빠졌거나 가져오지 않은
 *  상위) 그 항목은 최상위(Task)로 취급 — "상위업무" 컬럼의 fallback 표시 방식과 동일한 원칙. */
function buildForest(items: WorkItem[]): TreeNode[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const byJiraKey = new Map(items.filter((i) => i.jiraIssueKey).map((i) => [i.jiraIssueKey as string, i]));

  const parentOf = (item: WorkItem): WorkItem | null => {
    if (item.parentId && byId.has(item.parentId)) return byId.get(item.parentId)!;
    if (item.jiraParentKey && byJiraKey.has(item.jiraParentKey)) return byJiraKey.get(item.jiraParentKey)!;
    return null;
  };

  const childrenById = new Map<string, WorkItem[]>();
  for (const item of items) {
    const parent = parentOf(item);
    if (!parent) continue;
    const arr = childrenById.get(parent.id) ?? [];
    arr.push(item);
    childrenById.set(parent.id, arr);
  }

  const buildNode = (item: WorkItem): TreeNode => ({
    item,
    children: sortSiblings((childrenById.get(item.id) ?? []).map(buildNode)),
  });

  return items.filter((i) => !parentOf(i)).map(buildNode);
}

/** Task(최상위) 를 Epic 기준으로 묶는다 — Epic 자체가 별도 work item 으로 존재하지 않아도
 *  jiraEpicKey/jiraEpicSummary(또는 레거시 jiraEpic 문자열) 만으로 그룹을 만든다. Epic 이
 *  없는 업무는 맨 뒤 "에픽 없음" 그룹으로 모아 목록에서 빠지지 않게 한다. */
function groupByEpic(roots: TreeNode[]): EpicGroup[] {
  const groups = new Map<string, EpicGroup>();
  for (const node of sortSiblings(roots)) {
    const item = node.item;
    const jiraKey = item.jiraEpicKey || null;
    const label = jiraKey ? (item.jiraEpicSummary || jiraKey) : (item.jiraEpic || null);
    const key = jiraKey ?? (label ? `label:${label}` : '__no_epic__');
    let group = groups.get(key);
    if (!group) {
      group = { key, jiraKey, label: label || '에픽 없음', nodes: [] };
      groups.set(key, group);
    }
    group.nodes.push(node);
  }
  return Array.from(groups.values()).sort((a, b) => {
    if (a.key === '__no_epic__') return 1;
    if (b.key === '__no_epic__') return -1;
    return a.label.localeCompare(b.label);
  });
}

function countDescendants(node: TreeNode): number {
  return node.children.reduce((sum, c) => sum + 1 + countDescendants(c), 0);
}

// 행별 Jira/Confluence 동기화 "진행중" 표시는 busy 대상 id 하나만 전역으로 들고 있다가
// 각 행에서 자기 id 와 비교해야 한다 — WorkItemActionsMenuProps 의 boolean(jiraBusy 등)을
// 그대로 모든 행에 내려버리면 한 행이 바쁠 때 트리 전체가 스피너로 보인다.
type ActionMenuHandlers = Omit<WorkItemActionsMenuProps, 'item' | 'jiraBusy' | 'confluenceBusy'> & {
  jiraBusyId?: string | null;
  confluenceBusyId?: string | null;
};

// ── 행 렌더링 ──────────────────────────────────────────────────────────────────
interface TreeRowProps extends ActionMenuHandlers {
  node: TreeNode;
  depth: number;
  collapsedIds: Set<string>;
  onToggle: (id: string) => void;
  onItemClick: (item: WorkItem) => void;
}

function TreeRow({ node, depth, collapsedIds, onToggle, onItemClick, jiraBusyId, confluenceBusyId, ...menuProps }: TreeRowProps) {
  const { item, children } = node;
  const hasChildren = children.length > 0;
  const isCollapsed = collapsedIds.has(item.id);
  const ks = item.kanbanStatus ?? 'todo';
  const pStyle = PRI_STYLES[item.priority] ?? PRI_STYLES.medium;
  const overdue = !!item.dueDate && item.kanbanStatus !== 'done' && item.dueDate.slice(0, 10) < todayDateInput();

  return (
    <>
      <tr className="border-b border-border last:border-b-0 hover:bg-muted/20 transition-colors">
        <td className="px-4 py-1.5 max-w-sm">
          <div className="flex items-center gap-1.5 min-w-0" style={{ paddingLeft: depth * 20 }}>
            {hasChildren ? (
              <button
                type="button"
                onClick={() => onToggle(item.id)}
                className="p-0.5 text-muted-foreground hover:text-foreground flex-shrink-0"
                title={isCollapsed ? '하위 업무 펼치기' : '하위 업무 접기'}
                aria-label={isCollapsed ? '하위 업무 펼치기' : '하위 업무 접기'}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            ) : (
              <span className="w-4 flex-shrink-0" />
            )}
            {item.jiraIssueType && (
              <span className={`flex-shrink-0 inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${jiraTypeClass(item.jiraIssueType)}`}>
                {item.jiraIssueType}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onItemClick(item); }}
              className="text-left min-w-0 truncate text-foreground/90 hover:text-primary hover:underline transition-colors"
              title={item.title?.trim() || stripHtml(item.content) || '업무'}
            >
              {item.title?.trim() || stripHtml(item.content) || '-'}
            </button>
            {hasChildren && (
              <span className="flex-shrink-0 text-[11px] text-muted-foreground/60">({countDescendants(node)})</span>
            )}
          </div>
        </td>
        <td className="px-4 py-1.5 whitespace-nowrap">
          {item.jiraIssueKey ? (
            <a
              href={item.jiraUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={`Jira ${item.jiraIssueKey}${item.jiraStatus ? ` · ${item.jiraStatus}` : ''} (새 창)`}
              className="inline-flex items-center font-mono text-[10px] font-semibold px-1 py-0.5 rounded bg-brand-jira/10 text-brand-jira dark:text-blue-300 border border-brand-jira/20 hover:bg-brand-jira/20"
            >
              {item.jiraIssueKey}
            </a>
          ) : (
            <span className="text-muted-foreground/50 text-sm">-</span>
          )}
        </td>
        <td className="px-4 py-1.5 whitespace-nowrap">
          {item.jiraStatus ? (
            <span className="flex items-center gap-1.5" title={`Jira 상태: ${item.jiraStatus}`}>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${JIRA_CAT_DOT[item.jiraStatusCategory ?? ''] ?? KS_DOT[ks] ?? 'bg-status-unknown'}`} />
              <span className={`text-sm font-medium whitespace-nowrap ${JIRA_CAT_TEXT[item.jiraStatusCategory ?? ''] ?? KS_TEXT[ks] ?? 'text-status-unknown'}`}>
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
        </td>
        <td className="px-4 py-1.5 whitespace-nowrap text-sm">
          {item.primaryAssignee || item.assignee || <span className="text-muted-foreground/50">-</span>}
          {item.secondaryAssignee && <span className="text-muted-foreground"> · {item.secondaryAssignee}</span>}
        </td>
        <td className="px-4 py-1.5 whitespace-nowrap">
          <span className={`inline-flex items-center gap-1 text-sm font-medium ${pStyle.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${pStyle.dot}`} />
            {pStyle.label}
          </span>
        </td>
        <td className={`px-4 py-1.5 whitespace-nowrap font-mono text-sm ${overdue ? 'text-status-critical' : 'text-muted-foreground'}`}>
          {overdue ? (
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
              {formatDate(item.dueDate)}
            </span>
          ) : formatDate(item.dueDate)}
        </td>
        <td className="px-4 py-1.5">
          <WorkItemActionsMenu
            item={item}
            {...menuProps}
            jiraBusy={jiraBusyId === item.id}
            confluenceBusy={confluenceBusyId === item.id}
          />
        </td>
      </tr>
      {hasChildren && !isCollapsed && children.map((child) => (
        <TreeRow
          key={child.item.id}
          node={child}
          depth={depth + 1}
          collapsedIds={collapsedIds}
          onToggle={onToggle}
          onItemClick={onItemClick}
          jiraBusyId={jiraBusyId}
          confluenceBusyId={confluenceBusyId}
          {...menuProps}
        />
      ))}
    </>
  );
}

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────────
interface WorkItemEpicViewProps extends ActionMenuHandlers {
  items: WorkItem[];
  onItemClick: (item: WorkItem) => void;
}

/**
 * 에픽뷰 — Epic → Task → Sub-task 순으로 표를 정렬해 보여준다. Epic 그룹, Task(및 그 이하
 * 임의 깊이의 하위 업무) 모두 기본 펼침이고 각자 접기/펼치기가 가능하다. 목록 뷰와 달리
 * 컬럼 커스터마이즈·드래그 정렬은 없다 — 구조 자체가 정렬 기준이라 칸반/달력처럼 별도의
 * 고정 뷰로 둔다.
 */
export function WorkItemEpicView({ items, onItemClick, ...menuProps }: WorkItemEpicViewProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const groups = useMemo(() => groupByEpic(buildForest(items)), [items]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: '860px' }}>
        <thead>
          <tr className="border-b border-border bg-muted/30">
            <th className="px-4 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">작업</th>
            <th className="px-4 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">DL</th>
            <th className="px-4 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">상태</th>
            <th className="px-4 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">담당자</th>
            <th className="px-4 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">우선순위</th>
            <th className="px-4 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">마감일</th>
            <th className="px-4 py-1.5 text-center font-medium text-muted-foreground whitespace-nowrap">변경</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const groupKey = `epic:${group.key}`;
            const groupCollapsed = collapsed.has(groupKey);
            const taskCount = group.nodes.reduce((sum, n) => sum + 1 + countDescendants(n), 0);
            const epicUrl = group.jiraKey
              ? (group.nodes[0]?.item.jiraUrl ?? undefined)?.replace(/\/browse\/.*$/, `/browse/${group.jiraKey}`)
              : undefined;
            return (
              <Fragment key={groupKey}>
                <tr className="bg-muted/20 border-b border-border">
                  <td colSpan={7} className="px-4 py-2">
                    <button
                      type="button"
                      onClick={() => toggle(groupKey)}
                      className="w-full flex items-center gap-2 text-left"
                      aria-expanded={!groupCollapsed}
                      title={groupCollapsed ? '에픽 펼치기' : '에픽 접기'}
                    >
                      {groupCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                      {group.jiraKey ? (
                        <JiraIssueChip issueKey={group.jiraKey} title={group.label !== group.jiraKey ? group.label : undefined} url={epicUrl} />
                      ) : (
                        <span className="text-sm font-semibold text-muted-foreground">{group.label}</span>
                      )}
                      <span className="ml-auto flex-shrink-0 text-xs text-muted-foreground">{taskCount}개</span>
                    </button>
                  </td>
                </tr>
                {!groupCollapsed && group.nodes.map((node) => (
                  <TreeRow
                    key={node.item.id}
                    node={node}
                    depth={0}
                    collapsedIds={collapsed}
                    onToggle={toggle}
                    onItemClick={onItemClick}
                    {...menuProps}
                  />
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
