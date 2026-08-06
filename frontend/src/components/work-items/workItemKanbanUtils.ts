import { Wrench, AlertTriangle, Users, GraduationCap, MoreHorizontal, HardHat, type LucideIcon } from 'lucide-react';
import type { WorkItem, KanbanStatus, WorkItemModule, WorkItemType, WorkItemTypeLabel } from '@/types';

export type { KanbanStatus };

// ── 업무 유형(task/issue/meeting/training/etc/build_response) 공통 메타 ────────
// 게시판 탭, 캘린더 범례, QuickAdd picker, CSV 라벨 등에서 공통으로 사용.
//
// "유형"은 곧 "업무 유형"이므로 옵션 안에 "업무" 자체가 들어있는 게 순환이었다 — 선택
// 가능한 유형을 [이슈 대응 · 회의 · 운영 대응 · 구축 대응 · 기타] 5종으로 정리한다(사용자 요청).
// 기존 값과의 호환을 위해 DB 컬럼/백엔드 Literal(`WorkItemType`)은 그대로 두고 프론트
// 레이블만 바꾼다 — `task`(구 "업무")는 "운영 대응"으로 재정의해 재사용하고(과거 데이터가
// 자연스럽게 새 라벨을 얻음), `training`(구 "교육")은 선택 목록(ORDER)에서만 제외한다.
// CONFIG 에는 남겨둬 기존 training 항목의 배지/라벨 조회(WORK_ITEM_TYPE_CONFIG[item.type])는
// 계속 정상 동작한다 — 신규 등록 시에만 고를 수 없다. `build_response`("구축 대응")는 시스템/
// 인프라 구축 요청에 대응하는 업무를 다른 유형과 구분하기 위해 신규 추가된 선택지.
export const WORK_ITEM_TYPE_ORDER: WorkItemType[] = ['issue', 'meeting', 'task', 'build_response', 'etc'];

export const WORK_ITEM_TYPE_CONFIG: Record<WorkItemType, { label: string; Icon: LucideIcon; cls: string }> = {
  issue:           { label: '이슈 대응', Icon: AlertTriangle,   cls: 'bg-[hsl(var(--chart-5)/0.1)] text-[hsl(var(--chart-5))]' },
  meeting:         { label: '회의',      Icon: Users,           cls: 'bg-[hsl(var(--chart-4)/0.1)] text-[hsl(var(--chart-4))]' },
  task:            { label: '운영 대응', Icon: Wrench,          cls: 'bg-[hsl(var(--chart-1)/0.1)] text-[hsl(var(--chart-1))]' },
  build_response:  { label: '구축 대응', Icon: HardHat,         cls: 'bg-[hsl(var(--chart-3)/0.1)] text-[hsl(var(--chart-3))]' },
  etc:             { label: '기타',      Icon: MoreHorizontal,  cls: 'bg-[hsl(var(--chart-8)/0.1)] text-[hsl(var(--chart-8))]' },
  training:        { label: '교육',      Icon: GraduationCap,   cls: 'bg-[hsl(var(--chart-2)/0.1)] text-[hsl(var(--chart-2))]' },
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
    headerCls: 'border-[hsl(var(--chart-8)/0.4)] bg-[hsl(var(--chart-8)/0.05)]',
    dotCls: 'bg-[hsl(var(--chart-8))]',
    emptyText: '백로그가 비어 있습니다',
  },
  {
    key: 'todo',
    label: 'To Do',
    headerCls: 'border-[hsl(var(--chart-1)/0.4)] bg-[hsl(var(--chart-1)/0.05)]',
    dotCls: 'bg-[hsl(var(--chart-1))]',
    emptyText: '이번 스프린트에 할 업무를 추가하세요',
  },
  {
    key: 'in_progress',
    label: 'In Progress',
    headerCls: 'border-[hsl(var(--chart-3)/0.4)] bg-[hsl(var(--chart-3)/0.05)]',
    dotCls: 'bg-[hsl(var(--chart-3))]',
    emptyText: '진행 중인 업무가 없습니다',
    wipLimit: 2,
  },
  {
    key: 'review_test',
    label: 'Review & Test',
    headerCls: 'border-[hsl(var(--chart-4)/0.4)] bg-[hsl(var(--chart-4)/0.05)]',
    dotCls: 'bg-[hsl(var(--chart-4))]',
    emptyText: '검증 중인 업무가 없습니다',
  },
  {
    key: 'done',
    label: 'Done',
    headerCls: 'border-[hsl(var(--chart-2)/0.4)] bg-[hsl(var(--chart-2)/0.05)]',
    dotCls: 'bg-[hsl(var(--chart-2))]',
    emptyText: '완료된 업무가 없습니다',
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
  k8s:        { label: 'K8s',       cls: 'bg-[hsl(var(--chart-1)/0.15)] text-[hsl(var(--chart-1))] border-[hsl(var(--chart-1)/0.3)]' },
  keycloak:   { label: 'Keycloak',  cls: 'bg-[hsl(var(--chart-4)/0.15)] text-[hsl(var(--chart-4))] border-[hsl(var(--chart-4)/0.3)]' },
  nexus:      { label: 'Nexus',     cls: 'bg-[hsl(var(--chart-2)/0.15)] text-[hsl(var(--chart-2))] border-[hsl(var(--chart-2)/0.3)]' },
  cilium:     { label: 'Cilium',    cls: 'bg-[hsl(var(--chart-6)/0.15)] text-[hsl(var(--chart-6))] border-[hsl(var(--chart-6)/0.3)]' },
  argocd:     { label: 'ArgoCD',    cls: 'bg-[hsl(var(--chart-4)/0.15)] text-[hsl(var(--chart-4))] border-[hsl(var(--chart-4)/0.3)]' },
  jenkins:    { label: 'Jenkins',   cls: 'bg-[hsl(var(--chart-3)/0.15)] text-[hsl(var(--chart-3))] border-[hsl(var(--chart-3)/0.3)]' },
  backend:    { label: 'Backend',   cls: 'bg-[hsl(var(--chart-7)/0.15)] text-[hsl(var(--chart-7))] border-[hsl(var(--chart-7)/0.3)]' },
  frontend:   { label: 'Frontend',  cls: 'bg-[hsl(var(--chart-5)/0.15)] text-[hsl(var(--chart-5))] border-[hsl(var(--chart-5)/0.3)]' },
  monitoring: { label: 'Monitor',   cls: 'bg-[hsl(var(--chart-5)/0.15)] text-[hsl(var(--chart-5))] border-[hsl(var(--chart-5)/0.3)]' },
  infra:      { label: 'Infra',     cls: 'bg-[hsl(var(--chart-8)/0.15)] text-[hsl(var(--chart-8))] border-[hsl(var(--chart-8)/0.3)]' },
};

// ── 유형 배지 설정 ─────────────────────────────────────────────────────────────
export const TYPE_LABEL_CONFIG: Record<WorkItemTypeLabel, { label: string; cls: string }> = {
  feature:  { label: 'feat',     cls: 'bg-[hsl(var(--chart-1)/0.1)] text-[hsl(var(--chart-1))]' },
  bug:      { label: 'fix',      cls: 'bg-status-critical/10 text-status-critical' },
  chore:    { label: 'chore',    cls: 'bg-muted text-muted-foreground' },
  docs:     { label: 'docs',     cls: 'bg-[hsl(var(--chart-2)/0.1)] text-[hsl(var(--chart-2))]' },
  security: { label: 'security', cls: 'bg-status-warning/10 text-status-warning' },
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
