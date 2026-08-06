import type { ComponentType } from 'react';
import { CheckCircle2, Clock, Circle, CircleDashed, type LucideProps } from 'lucide-react';
import type { KanbanStatus } from '@/types';

/**
 * 홈 화면(당일 스케줄 · 주간 스윔레인 · 담당자별 진행 현황)이 공유하는 업무 상태 → 색
 * 토큰의 단일 소스. 세 컴포넌트가 각자 이 값을 참조해 탭을 넘나들어도 같은 상태가 같은
 * 색으로 보이게 한다 — 이전엔 컴포넌트마다 다른 토큰(status-* vs chart-*)을 써서 담당자별
 * 진행 현황 카드의 주간/월간/담당자 탭 사이에서 색 의미가 바뀌는 문제가 있었다.
 */
export interface StatusColorEntry {
  /** CSS 커스텀 프로퍼티 이름 — inline hsl(var(token)) 스타일(투명도 조절 등)에 사용. */
  cssVar: string;
  bgClass: string;
  textClass: string;
  /** 10% 불투명 배경(tint) — 카드/칩 배경용. */
  tintClass: string;
  /** 30% 불투명 ring — 막대 테두리용. */
  ringClass: string;
  label: string;
}

export const STATUS_COLOR: Record<KanbanStatus, StatusColorEntry> = {
  backlog: {
    cssVar: '--status-unknown', bgClass: 'bg-status-unknown', textClass: 'text-status-unknown',
    tintClass: 'bg-status-unknown/10', ringClass: 'ring-status-unknown/30', label: 'Backlog',
  },
  todo: {
    cssVar: '--status-info', bgClass: 'bg-status-info', textClass: 'text-status-info',
    tintClass: 'bg-status-info/10', ringClass: 'ring-status-info/30', label: 'Todo',
  },
  in_progress: {
    cssVar: '--status-warning', bgClass: 'bg-status-warning', textClass: 'text-status-warning',
    tintClass: 'bg-status-warning/10', ringClass: 'ring-status-warning/30', label: '진행중',
  },
  review_test: {
    cssVar: '--chart-4', bgClass: 'bg-chart-4', textClass: 'text-chart-4',
    tintClass: 'bg-chart-4/10', ringClass: 'ring-chart-4/30', label: '검토',
  },
  done: {
    cssVar: '--status-healthy', bgClass: 'bg-status-healthy', textClass: 'text-status-healthy',
    tintClass: 'bg-status-healthy/10', ringClass: 'ring-status-healthy/30', label: '완료',
  },
};

/** 색상에 의존하지 않는 보조 신호(모양) — done=체크, in_progress/review_test=시계, backlog=점선원, todo=원. */
export const STATUS_ICON: Record<KanbanStatus, ComponentType<LucideProps>> = {
  backlog: CircleDashed,
  todo: Circle,
  in_progress: Clock,
  review_test: Clock,
  done: CheckCircle2,
};
