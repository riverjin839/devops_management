import {
  Server, Lock, Box, Wrench, GitBranch, Activity, BarChart3, Network,
  Database, Eye, ArrowRightLeft, Container, MoreHorizontal, type LucideIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';

/** 서비스 아이콘은 lucide 컴포넌트 / emoji 텍스트 / 업로드 이미지 모두 받을 수 있도록
 *  ``ComponentType<{className?: string}>`` 으로 일반화. ``getServiceIcon()`` 이 raw
 *  문자열 (lucide 이름 / emoji / data URL)을 적절한 렌더러로 변환한다. */
export type ServiceIconComponent = ComponentType<{ className?: string }>;

export interface ServiceDef {
  key: string;
  label: string;
  icon: ServiceIconComponent;
  /** 컬러 — StatusBadge / Card 에서 활용 */
  color: string;
  description?: string;
}

/** 카탈로그 — 사용자가 정의 가능하도록 추후 ui_settings 로 옮길 수 있음.
 *  지금은 자주 쓰이는 12개 서비스를 하드코딩 + 'other' 폴백.
 */
export const SERVICE_CATALOG: ServiceDef[] = [
  { key: 'k8s',         label: 'Kubernetes',  icon: Server,         color: 'sky',     description: '컨트롤 플레인 / 워크로드 / 노드' },
  { key: 'keycloak',    label: 'Keycloak',    icon: Lock,           color: 'amber',   description: '인증 / SSO / Realm 관리' },
  { key: 'nexus',       label: 'Nexus',       icon: Box,            color: 'blue',    description: '아티팩트 / 레지스트리' },
  { key: 'jenkins',     label: 'Jenkins',     icon: Wrench,         color: 'orange',  description: 'CI / 파이프라인' },
  { key: 'argocd',      label: 'ArgoCD',      icon: GitBranch,      color: 'purple',  description: 'GitOps / Application 동기화' },
  { key: 'prometheus',  label: 'Prometheus',  icon: Activity,       color: 'red',     description: '메트릭 수집 / 알람' },
  { key: 'grafana',     label: 'Grafana',     icon: BarChart3,      color: 'orange',  description: '대시보드 / 시각화' },
  { key: 'cilium',      label: 'Cilium',      icon: Network,        color: 'cyan',    description: 'CNI / eBPF / 정책' },
  { key: 'etcd',        label: 'etcd',        icon: Database,       color: 'emerald', description: 'K8s 백업 / consensus' },
  { key: 'hubble',      label: 'Hubble',      icon: Eye,            color: 'sky',     description: 'Cilium observability' },
  { key: 'ingress',     label: 'Ingress',     icon: ArrowRightLeft, color: 'pink',    description: 'NGINX / 트래픽 진입' },
  { key: 'storage',     label: 'Storage',     icon: Container,      color: 'violet',  description: 'PV / StorageClass / 스토리지 백엔드' },
  { key: 'other',       label: '기타',         icon: MoreHorizontal, color: 'slate',   description: '카탈로그에 없는 임의 서비스' },
];

export const SERVICE_BY_KEY: Record<string, ServiceDef> = Object.fromEntries(
  SERVICE_CATALOG.map((s) => [s.key, s]),
);

export function getServiceDef(key: string): ServiceDef {
  return SERVICE_BY_KEY[key] ?? { ...SERVICE_BY_KEY.other, key, label: key };
}

// kind 메타
export interface KindDef {
  key: 'note' | 'guide' | 'troubleshoot' | 'history' | 'link';
  label: string;
  icon: LucideIcon;
  color: string;
}

import { FileText, BookOpen, AlertTriangle, Clock, Link2 } from 'lucide-react';

export const KIND_CATALOG: KindDef[] = [
  { key: 'note',         label: '메모',         icon: FileText,       color: 'slate' },
  { key: 'guide',        label: '운영 가이드',   icon: BookOpen,       color: 'sky' },
  { key: 'troubleshoot', label: '트러블슈팅',    icon: AlertTriangle,  color: 'amber' },
  { key: 'history',      label: '변경 이력',     icon: Clock,          color: 'emerald' },
  { key: 'link',         label: '리소스 링크',   icon: Link2,          color: 'purple' },
];

export const KIND_BY_KEY: Record<string, KindDef> = Object.fromEntries(
  KIND_CATALOG.map((k) => [k.key, k]),
);

// 컬러 → tailwind 클래스 (StatusBadge 와 같은 매핑이지만 가벼운 버전)
const COLOR_BG: Record<string, string> = {
  sky:     'bg-sky-500/10     text-sky-500     border-sky-500/30',
  amber:   'bg-amber-500/10   text-amber-500   border-amber-500/30',
  blue:    'bg-blue-500/10    text-blue-500    border-blue-500/30',
  orange:  'bg-orange-500/10  text-orange-500  border-orange-500/30',
  purple:  'bg-purple-500/10  text-purple-500  border-purple-500/30',
  red:     'bg-red-500/10     text-red-500     border-red-500/30',
  cyan:    'bg-cyan-500/10    text-cyan-500    border-cyan-500/30',
  emerald: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30',
  pink:    'bg-pink-500/10    text-pink-500    border-pink-500/30',
  violet:  'bg-violet-500/10  text-violet-500  border-violet-500/30',
  slate:   'bg-slate-500/10   text-slate-500   border-slate-500/30',
};

export function colorBadgeClass(color: string): string {
  return COLOR_BG[color] ?? COLOR_BG.slate;
}
