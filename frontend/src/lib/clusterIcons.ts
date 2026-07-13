import {
  // 기본
  Server, Database, Cloud, CloudCog, Cpu, HardDrive, Network,
  Box, Boxes, Layers, Workflow, Activity, Container, Cog, Hexagon, Component, Waypoints,
  // 지역 / 위치
  Globe, MapPin, Map, Flag, Building2, Building, Landmark, Mountain,
  Trees, Waves, Compass, Palmtree, Tent, Castle,
  // 운영레벨 / 상태
  ShieldCheck, Shield, FlaskConical, Wrench, Code2, AlertCircle, BadgeCheck,
  Diamond, Crown, Rocket, Flame, Star, Award, Bug, Hammer,
  Sparkles, Zap, Atom, Anchor, Settings2,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { BRAND_ICONS, BRAND_ICON_LIST } from './brandIcons';

/** className 만 받는 일반 아이콘 컴포넌트 타입 — lucide 아이콘과 브랜드(SVG) 아이콘 공용. */
export type IconComponent = ComponentType<{ className?: string }>;

/** 사용자가 클러스터 사이드바에서 선택할 수 있는 아이콘 화이트리스트.
 *  키는 저장값(Cluster.icon)과 동일 — lucide 컴포넌트 이름 또는 브랜드 이름(Prometheus 등).
 *  하단 CLUSTER_ICON_GROUPS 에서 카테고리화한 것의 union 이다. */
export const CLUSTER_ICON_OPTIONS: Record<string, IconComponent> = {
  // 기본
  Server, Database, Cloud, CloudCog, Cpu, HardDrive, Network,
  Box, Boxes, Layers, Workflow, Activity, Container, Cog, Hexagon, Component,
  Settings2, Anchor, Atom, Zap,
  'CI/CD': Waypoints,
  // 지역 / 위치
  Globe, MapPin, Map, Flag, Building2, Building, Landmark, Mountain,
  Trees, Waves, Compass, Palmtree, Tent, Castle,
  // 운영레벨 / 상태
  ShieldCheck, Shield, FlaskConical, Wrench, Code2, AlertCircle, BadgeCheck,
  Diamond, Crown, Rocket, Flame, Star, Award, Bug, Hammer, Sparkles,
  // 오픈소스 / CNCF 브랜드 로고 (simple-icons)
  ...BRAND_ICONS,
};

export interface ClusterIconGroup<T> {
  key: string;
  label: string;
  hint?: string;
  items: T[];
}

/** 카테고리화된 아이콘 그룹. 그리드에서 섹션 헤더와 함께 보여 줘 의미를 강조한다. */
export const CLUSTER_ICON_GROUPS: ClusterIconGroup<{ name: string; Component: IconComponent }>[] = [
  {
    key: 'oss',
    label: '오픈소스 / CNCF',
    hint: 'Kubernetes·Prometheus·Cilium·Keycloak·Nexus 등 CNCF 졸업/인기 OSS 브랜드 로고',
    items: BRAND_ICON_LIST,
  },
  {
    key: 'general',
    label: '기본',
    hint: '서버 / 컨테이너 / DB 등 일반',
    items: [
      { name: 'Server',    Component: Server },
      { name: 'Database',  Component: Database },
      { name: 'Cloud',     Component: Cloud },
      { name: 'CloudCog',  Component: CloudCog },
      { name: 'Container', Component: Container },
      { name: 'Box',       Component: Box },
      { name: 'Boxes',     Component: Boxes },
      { name: 'Layers',    Component: Layers },
      { name: 'Workflow',  Component: Workflow },
      { name: 'Network',   Component: Network },
      { name: 'Cpu',       Component: Cpu },
      { name: 'HardDrive', Component: HardDrive },
      { name: 'Activity',  Component: Activity },
      { name: 'Hexagon',   Component: Hexagon },
      { name: 'Component', Component: Component },
      { name: 'Cog',       Component: Cog },
      { name: 'Settings2', Component: Settings2 },
      { name: 'Anchor',    Component: Anchor },
      { name: 'Atom',      Component: Atom },
      { name: 'Zap',       Component: Zap },
      { name: 'CI/CD',     Component: Waypoints },
    ],
  },
  {
    key: 'region',
    label: '지역 / 위치',
    hint: '클러스터가 위치한 리전·도시·환경을 강조',
    items: [
      { name: 'Globe',      Component: Globe },
      { name: 'MapPin',     Component: MapPin },
      { name: 'Map',        Component: Map },
      { name: 'Flag',       Component: Flag },
      { name: 'Compass',    Component: Compass },
      { name: 'Building2',  Component: Building2 },
      { name: 'Building',   Component: Building },
      { name: 'Landmark',   Component: Landmark },
      { name: 'Castle',     Component: Castle },
      { name: 'Mountain',   Component: Mountain },
      { name: 'Trees',      Component: Trees },
      { name: 'Waves',      Component: Waves },
      { name: 'Palmtree',   Component: Palmtree },
      { name: 'Tent',       Component: Tent },
    ],
  },
  {
    key: 'level',
    label: '운영레벨 / 등급',
    hint: 'production / staging / dev / test 등 운영 등급을 시각화',
    items: [
      { name: 'ShieldCheck',   Component: ShieldCheck },
      { name: 'Shield',        Component: Shield },
      { name: 'BadgeCheck',    Component: BadgeCheck },
      { name: 'Crown',         Component: Crown },
      { name: 'Diamond',       Component: Diamond },
      { name: 'Star',          Component: Star },
      { name: 'Award',         Component: Award },
      { name: 'Rocket',        Component: Rocket },
      { name: 'Sparkles',      Component: Sparkles },
      { name: 'FlaskConical',  Component: FlaskConical },
      { name: 'Code2',         Component: Code2 },
      { name: 'Wrench',        Component: Wrench },
      { name: 'Hammer',        Component: Hammer },
      { name: 'Bug',           Component: Bug },
      { name: 'AlertCircle',   Component: AlertCircle },
      { name: 'Flame',         Component: Flame },
    ],
  },
];

/** UI 에서 자주 쓰일만한 emoji 추천 — 사용자는 임의 emoji 도 직접 입력 가능.
 *  하단 CLUSTER_EMOJI_GROUPS 의 union (flat). */
export const CLUSTER_EMOJI_SUGGESTIONS = [
  // 기본 / 운영
  '🚀', '☸️', '🛡️', '🔥', '⚡', '💾', '🗄️', '🌐', '🛰️', '🪐',
  '🧱', '🧊', '🐳', '☁️', '🔧', '🛠️', '📦', '🧠', '🤖', '🎯',
  // 국가 / 글로벌
  '🇰🇷', '🇯🇵', '🇺🇸', '🇨🇳', '🇪🇺', '🇩🇪', '🇬🇧', '🇸🇬', '🇮🇳', '🇨🇦',
  '🌏', '🌍', '🌎', '🗺️', '📍', '🧭',
  // 지역 / 장소 / 한국 도시
  '🏙️', '🏛️', '🌆', '🌇', '⚓', '🌊', '🏝️', '🍊', '✈️', '🚄',
  '🌸', '🍎', '🏞️', '⛰️', '🗼', '🏰', '🏢', '🏠',
  // 운영레벨 / 등급 / 상태
  '💎', '🌟', '⭐', '🔴', '🟢', '🟡', '🟠', '🔵', '⚪', '🟣',
  '🥇', '🥈', '🥉', '🏆', '🎖️', '🧪', '🔬', '🌱', '🐛', '🚧',
  '🏗️', '⚠️', '🔐', '🏷️',
] as const;

/** 카테고리화된 emoji 그룹. */
export const CLUSTER_EMOJI_GROUPS: ClusterIconGroup<string>[] = [
  {
    key: 'general',
    label: '기본',
    hint: '인프라 / 컨테이너 / 일반 운영',
    items: [
      '🚀', '☸️', '🛡️', '🔥', '⚡', '💾', '🗄️', '🌐', '🛰️', '🪐',
      '🧱', '🧊', '🐳', '☁️', '🔧', '🛠️', '📦', '🧠', '🤖', '🎯',
    ],
  },
  {
    key: 'region-flag',
    label: '국가 / 글로벌',
    hint: '리전을 국가/클라우드 사업자 단위로 표현',
    items: [
      '🇰🇷', '🇯🇵', '🇺🇸', '🇨🇳', '🇪🇺', '🇩🇪', '🇬🇧', '🇸🇬', '🇮🇳', '🇨🇦',
      '🌏', '🌍', '🌎', '🗺️', '📍', '🧭',
    ],
  },
  {
    key: 'region-place',
    label: '지역 / 도시',
    hint: '서울 🏙️ · 부산 ⚓ · 제주 🏝️ · 인천 ✈️ · 대전 🚄 · 광주 🌸 · 대구 🍎 ...',
    items: [
      '🏙️', '🏛️', '🌆', '🌇', '⚓', '🌊', '🏝️', '🍊', '✈️', '🚄',
      '🌸', '🍎', '🏞️', '⛰️', '🗼', '🏰', '🏢', '🏠',
    ],
  },
  {
    key: 'level',
    label: '운영레벨 / 등급',
    hint: 'production 💎 · staging 🟡 · dev 🛠️ · test 🧪 · DR/sandbox 🏝️',
    items: [
      '💎', '🌟', '⭐', '🔴', '🟢', '🟡', '🟠', '🔵', '⚪', '🟣',
      '🥇', '🥈', '🥉', '🏆', '🎖️', '🧪', '🔬', '🌱', '🐛', '🚧',
      '🏗️', '⚠️', '🔐', '🏷️',
    ],
  },
];

export type ResolvedClusterIcon =
  | { kind: 'lucide'; Component: IconComponent }
  | { kind: 'text'; value: string }
  | { kind: 'image'; value: string }   // base64 data URL or http(s) image URL
  | null;

/** icon 값을 어떻게 렌더할지 결정 (cluster / service 카탈로그 공용).
 *  - 화이트리스트의 lucide 컴포넌트 이름 → lucide 컴포넌트
 *  - "data:image/..." 또는 "http(s)://..." 로 시작 → 이미지
 *  - 그 외 비어있지 않은 값 → 텍스트(주로 emoji)
 *  - null/empty → null (호출자가 status 기반 기본 아이콘으로 fallback) */
export function resolveClusterIcon(icon?: string | null): ResolvedClusterIcon {
  if (!icon) return null;
  const trimmed = icon.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:image/') || /^https?:\/\//i.test(trimmed)) {
    return { kind: 'image', value: trimmed };
  }
  if (Object.prototype.hasOwnProperty.call(CLUSTER_ICON_OPTIONS, trimmed)) {
    return { kind: 'lucide', Component: CLUSTER_ICON_OPTIONS[trimmed] };
  }
  return { kind: 'text', value: trimmed };
}
