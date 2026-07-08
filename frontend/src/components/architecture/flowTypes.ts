import type { ComponentType, CSSProperties } from 'react';
import type { StatusVariant } from '@/components/common/StatusBadge';

export type FlowSide = 'left' | 'right' | 'top' | 'bottom';

export interface FlowNodeDef {
  id: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  label: string;
  sublabel?: string;
  icon?: ComponentType<{ className?: string; style?: CSSProperties }>;
  /** 아이콘 대신 이모지 표시 (addon.icon 처럼 이모지 문자열인 경우) */
  emoji?: string;
  status: StatusVariant;
  /** 실시간 상태 신호가 없어 구조만 보여주는 노드 (점선 테두리, 저속 애니메이션) */
  muted?: boolean;
  tooltip?: string;
}

export interface FlowEdgeDef {
  id: string;
  from: string;
  to: string;
  fromSide?: FlowSide;
  toSide?: FlowSide;
  status: StatusVariant;
  label?: string;
  muted?: boolean;
}
