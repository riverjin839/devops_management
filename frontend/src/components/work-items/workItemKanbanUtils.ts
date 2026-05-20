import { ListTodo, AlertTriangle, Users, GraduationCap, MoreHorizontal, type LucideIcon } from 'lucide-react';
import type { WorkItem, KanbanStatus, WorkItemModule, WorkItemType, WorkItemTypeLabel } from '@/types';

export type { KanbanStatus };

// ── 업무 유형(task/issue/meeting/training/etc) 공통 메타 ─────────────────────
// 게시판 탭, 캘린더 범례, QuickAdd picker, CSV 라벨 등에서 공통으로 사용.
export const WORK_ITEM_TYPE_ORDER: WorkItemType[] = ['task', 'issue', 'meeting', 'training', 'etc'];

export const WORK_ITEM_TYPE_CONFIG: Record<WorkItemType, { label: string; Icon: LucideIcon; cls: string }> = {
  task:     { label: '작업', Icon: ListTodo,        cls: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' },
  issue:    { label: '이슈', Icon: AlertTriangle,   cls: 'bg-red-500/10 text-red-700 dark:text-red-300' },
  meeting:  { label: '회의', Icon: Users,           cls: 'bg-violet-500/10 text-violet-700 dark:text-violet-300' },
  training: { label: '교육', Icon: GraduationCap,   cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  etc:      { label: '기타', Icon: MoreHorizontal,  cls: 'bg-slate-500/10 text-slate-700 dark:text-slate-300' },
};

// ── 컬럼 정의 ─────────────────────────────────────────────────────────────────
export interface KanbanColumnConfig {
  key: KanbanStatus;
  label: string;
  headerCls: string;
  dotCls: string;
  emptyText: string;
  wipLimit?: number;
}

export const KANBAN_COLUMNS: KanbanColumnConfig[] = [
  {
    key: 'backlog',
    label: 'Backlog',
    headerCls: 'border-slate-500/40 bg-slate-500/5',
    dotCls: 'bg-slate-400',
    emptyText: '백로그가 비어 있습니다',
  },
  {
    key: 'todo',
    label: 'To Do',
    headerCls: 'border-blue-500/40 bg-blue-500/5',
    dotCls: 'bg-blue-400',
    emptyText: '이번 스프린트에 할 작업을 추가하세요',
  },
  {
    key: 'in_progress',
    label: 'In Progress',
    headerCls: 'border-amber-500/40 bg-amber-500/5',
    dotCls: 'bg-amber-400',
    emptyText: '진행 중인 작업이 없습니다',
    wipLimit: 2,
  },
  {
    key: 'review_test',
    label: 'Review & Test',
    headerCls: 'border-purple-500/40 bg-purple-500/5',
    dotCls: 'bg-purple-400',
    emptyText: '검증 중인 작업이 없습니다',
  },
  {
    key: 'done',
    label: 'Done',
    headerCls: 'border-emerald-500/40 bg-emerald-500/5',
    dotCls: 'bg-emerald-400',
    emptyText: '완료된 작업이 없습니다',
  },
];

export const KANBAN_STATUS_ORDER: KanbanStatus[] = ['backlog', 'todo', 'in_progress', 'review_test', 'done'];

export const KANBAN_STATUS_LABEL: Record<KanbanStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  in_progress: 'In Progress',
  review_test: 'Review & Test',
  done: 'Done',
};

// ── 모듈 배지 설정 ─────────────────────────────────────────────────────────────
export const MODULE_CONFIG: Record<WorkItemModule, { label: string; cls: string }> = {
  k8s:        { label: 'K8s',       cls: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  keycloak:   { label: 'Keycloak',  cls: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30' },
  nexus:      { label: 'Nexus',     cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  cilium:     { label: 'Cilium',    cls: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30' },
  argocd:     { label: 'ArgoCD',    cls: 'bg-violet-500/15 text-violet-400 border-violet-500/30' },
  jenkins:    { label: 'Jenkins',   cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
  backend:    { label: 'Backend',   cls: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
  frontend:   { label: 'Frontend',  cls: 'bg-pink-500/15 text-pink-400 border-pink-500/30' },
  monitoring: { label: 'Monitor',   cls: 'bg-red-500/15 text-red-400 border-red-500/30' },
  infra:      { label: 'Infra',     cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
};

// ── 유형 배지 설정 ─────────────────────────────────────────────────────────────
export const TYPE_LABEL_CONFIG: Record<WorkItemTypeLabel, { label: string; cls: string }> = {
  feature:  { label: 'feat',     cls: 'bg-blue-500/10 text-blue-300' },
  bug:      { label: 'fix',      cls: 'bg-red-500/10 text-red-300' },
  chore:    { label: 'chore',    cls: 'bg-slate-500/10 text-slate-400' },
  docs:     { label: 'docs',     cls: 'bg-teal-500/10 text-teal-300' },
  security: { label: 'security', cls: 'bg-rose-500/10 text-rose-300' },
};

// ── 헬퍼 ──────────────────────────────────────────────────────────────────────
export function getNextStatus(current: KanbanStatus): KanbanStatus | null {
  const idx = KANBAN_STATUS_ORDER.indexOf(current);
  return idx < KANBAN_STATUS_ORDER.length - 1 ? KANBAN_STATUS_ORDER[idx + 1] : null;
}

export function getPrevStatus(current: KanbanStatus): KanbanStatus | null {
  const idx = KANBAN_STATUS_ORDER.indexOf(current);
  return idx > 0 ? KANBAN_STATUS_ORDER[idx - 1] : null;
}

// 하위 호환: 기존 코드에서 classifyTask 를 import 하는 경우를 위해 유지
export function classifyTask(item: WorkItem): KanbanStatus {
  return item.kanbanStatus ?? 'todo';
}
