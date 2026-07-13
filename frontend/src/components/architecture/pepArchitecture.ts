import { Globe, Server, Database, Zap, CalendarCheck2, Cpu, Boxes, Bot, Gauge } from 'lucide-react';
import type { ComponentType, CSSProperties } from 'react';
import type { FlowSide } from './flowTypes';

/** PEP(Platform Engineering Portal) 자체 아키텍처 노드 id — CLAUDE.md 의 Tech Stack 구성 그대로 */
export type PepNodeId =
  | 'frontend' | 'backend' | 'postgres' | 'redis'
  | 'celeryBeat' | 'celeryWorker' | 'k8s' | 'ollama' | 'prometheus';

export interface PepNodeLayout {
  id: PepNodeId;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
}

export interface PepEdgeLayout {
  id: string;
  from: PepNodeId;
  to: PepNodeId;
  label: string;
  fromSide?: FlowSide;
  toSide?: FlowSide;
}

const W = 200;
const H = 76;

export const PEP_DIAGRAM_WIDTH = 1160;
export const PEP_DIAGRAM_HEIGHT = 440;

export const PEP_NODES: PepNodeLayout[] = [
  { id: 'frontend', x: 20, y: 222, w: W, h: H, label: '브라우저 (React)', icon: Globe },
  { id: 'backend', x: 300, y: 210, w: W, h: 100, label: 'Backend API (FastAPI)', icon: Server },
  { id: 'postgres', x: 620, y: 20, w: W, h: H, label: 'PostgreSQL', icon: Database },
  { id: 'redis', x: 620, y: 120, w: W, h: H, label: 'Redis', icon: Zap },
  { id: 'prometheus', x: 620, y: 220, w: W, h: H, label: 'Prometheus', icon: Gauge },
  { id: 'ollama', x: 620, y: 320, w: W, h: H, label: 'Ollama (AI)', icon: Bot },
  { id: 'celeryBeat', x: 900, y: 20, w: W, h: H, label: 'Celery Beat', icon: CalendarCheck2 },
  { id: 'celeryWorker', x: 900, y: 120, w: W, h: H, label: 'Celery Worker', icon: Cpu },
  { id: 'k8s', x: 900, y: 320, w: W, h: H, label: 'K8s 클러스터', icon: Boxes },
];

export const PEP_EDGES: PepEdgeLayout[] = [
  { id: 'fe-be', from: 'frontend', to: 'backend', label: 'REST (axios)' },
  { id: 'be-pg', from: 'backend', to: 'postgres', label: 'SQLAlchemy' },
  { id: 'be-redis', from: 'backend', to: 'redis', label: 'enqueue' },
  { id: 'be-prom', from: 'backend', to: 'prometheus', label: 'PromQL' },
  { id: 'be-ollama', from: 'backend', to: 'ollama', label: 'AI 챗' },
  { id: 'be-k8s', from: 'backend', to: 'k8s', label: '수동 점검', fromSide: 'bottom', toSide: 'bottom' },
  { id: 'cb-redis', from: 'celeryBeat', to: 'redis', label: '09·13·18시', fromSide: 'left', toSide: 'right' },
  { id: 'redis-cw', from: 'redis', to: 'celeryWorker', label: 'dequeue' },
  { id: 'cw-pg', from: 'celeryWorker', to: 'postgres', label: '결과 저장', fromSide: 'left', toSide: 'right' },
  { id: 'cw-k8s', from: 'celeryWorker', to: 'k8s', label: 'kubectl/httpx', fromSide: 'bottom', toSide: 'top' },
];
