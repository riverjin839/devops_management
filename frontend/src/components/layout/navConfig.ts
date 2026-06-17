import type { ComponentType } from 'react';
import {
  LayoutDashboard, BookOpen, ListTodo, Sparkles, Settings, Server,
  CalendarCheck2, Link2, Tags, Calculator, GitFork, BookMarked, Layers, Boxes,
  Map, BarChart3, Network, Zap, Route, Share2, Rss, Users, GitCommit, Terminal, Database, Cpu, HardDrive,
  ClipboardCheck, ListTree, Waves, TerminalSquare, Library, Home, Workflow,
  ShieldCheck, Activity, Package, GitBranch, ScrollText, Rocket, ShipWheel, Gauge, FolderTree,
} from 'lucide-react';

// ── Nav registry ──────────────────────────────────────────────────────────────
// 사이드바(Sidebar)와 Settings 의 "화면 UI 설정" 탭(NavMenuManager / PageStyleManager)이
// 공유하는 정적 네비게이션 정의. 컴포넌트 파일에 두면 react-refresh 가 경고하므로 분리.
// `/services` (통합 지식/SOP) 는 운영 기준 섹션에서 제거됨 — flyout 에서 보이지 않음.
export const NAV_MAP: Record<string, { defaultLabel: string; icon: ComponentType<{ className?: string }>; iconColor?: string; iconSize?: string }> = {
  '/':                   { defaultLabel: '홈 (Today)',     icon: Home },
  '/cluster-overview':   { defaultLabel: '클러스터 현황',  icon: LayoutDashboard },
  '/k8s-manage':         { defaultLabel: 'K8S 상세 관리',  icon: ShipWheel, iconColor: 'text-orange-500', iconSize: 'w-5 h-5' },
  '/k8s-allocation':     { defaultLabel: 'K8S 자원 관리',  icon: Gauge, iconColor: 'text-orange-500', iconSize: 'w-5 h-5' },
  '/ops-checks':         { defaultLabel: '운영 점검',       icon: ShieldCheck },
  '/k8s-logs':           { defaultLabel: '파드 로그',       icon: ScrollText },
  '/daily-check/review': { defaultLabel: '점검 결과 리뷰',  icon: ClipboardCheck },
  '/daily-check/settings':{ defaultLabel: '점검 항목 관리',  icon: Sparkles },
  '/lake-services':      { defaultLabel: 'LAKE 서비스',     icon: Database },
  '/coroot':             { defaultLabel: '애플리케이션 APM', icon: Gauge, iconColor: 'text-blue-500', iconSize: 'w-5 h-5' },
  '/pod-bottleneck':     { defaultLabel: 'Pod 병목 진단',   icon: Activity },
  '/docs':               { defaultLabel: '지식 허브 홈',    icon: Library },
  '/knowledge':          { defaultLabel: '지식베이스',      icon: FolderTree },
  '/playbooks':          { defaultLabel: 'Playbooks',      icon: BookOpen },
  '/tasks-mgmt':         { defaultLabel: '업무 관리',      icon: ListTodo },
  '/todo-today':         { defaultLabel: 'Work To Do',     icon: CalendarCheck2 },
  '/sprints':            { defaultLabel: '스프린트',        icon: Rocket },
  '/members':            { defaultLabel: '멤버별 업무',    icon: Users },
  '/cluster-manage':     { defaultLabel: '클러스터 관리',  icon: Server },
  '/versions':           { defaultLabel: '버전 / 설정',     icon: GitCommit },
  '/bulk-exec':          { defaultLabel: '노드 일괄 실행', icon: Terminal },
  '/etcdctl':            { defaultLabel: 'etcdctl 콘솔',   icon: Database },
  '/batch-jobs':         { defaultLabel: 'Batch Jobs',     icon: ListTree },
  '/mc':                 { defaultLabel: 'mc 클라이언트',  icon: HardDrive },
  '/kernel-params':      { defaultLabel: '커널 파라미터',  icon: Cpu },
  '/infra-topology':     { defaultLabel: '인프라 토폴로지', icon: Network },
  '/node-specs':         { defaultLabel: '노드 서버스펙',  icon: ClipboardCheck },
  '/links':              { defaultLabel: '클러스터 링크',  icon: Link2 },
  '/node-labels':        { defaultLabel: '노드 라벨',      icon: Tags },
  '/node-images':        { defaultLabel: '노드 이미지',    icon: Boxes },
  '/cidr':               { defaultLabel: 'CIDR 계산기',    icon: Calculator },
  '/incident-analysis':  { defaultLabel: 'K8s 로그 (분석·실시간)', icon: Zap },
  '/packet-flow':        { defaultLabel: '패킷 흐름 분석', icon: Route },
  '/cilium-trace':       { defaultLabel: 'Cilium BPF Trace', icon: Waves },
  '/service-topology':   { defaultLabel: '서비스 토폴로지', icon: Workflow },
  '/ontology':           { defaultLabel: '온톨로지 그래프', icon: Share2 },
  '/trends':             { defaultLabel: '기술 동향',      icon: Rss },
  '/work-guides':        { defaultLabel: '표준 작업 가이드', icon: BookMarked },
  '/commands':           { defaultLabel: '주요 명령어',     icon: TerminalSquare },
  '/ops-notes':          { defaultLabel: '운영 노트보드',   icon: Layers },
  '/wbs':                { defaultLabel: 'WBS 작업흐름',   icon: BarChart3 },
  '/mindmap':            { defaultLabel: '마인드맵',       icon: Map },
  '/workflow':           { defaultLabel: '워크플로우',     icon: GitFork },
  '/settings':           { defaultLabel: 'Settings',       icon: Settings },
};

// 사이드바 레일에 표시되는 그룹들
export type GroupId = 'cluster' | 'server' | 'network' | 'storage' | 'services' | 'devops' | 'collab' | 'knowledge' | 'system';
export const GROUPS: Array<{ id: GroupId; label: string; icon: ComponentType<{ className?: string }>; paths: string[]; modes: ('work' | 'platform')[] }> = [
  { id: 'cluster',   label: '클러스터',   icon: Layers,    paths: ['/cluster-overview', '/k8s-manage', '/k8s-allocation', '/ops-checks', '/incident-analysis', '/daily-check/review', '/daily-check/settings', '/pod-bottleneck', '/versions', '/bulk-exec', '/etcdctl', '/cluster-manage'], modes: ['platform'] },
  { id: 'server',    label: '서버/인프라', icon: Server,    paths: ['/node-specs', '/node-labels', '/node-images', '/kernel-params', '/infra-topology'], modes: ['platform'] },
  { id: 'network',   label: '네트워크',   icon: Network,   paths: ['/cilium-trace', '/service-topology', '/packet-flow', '/cidr', '/links'], modes: ['platform'] },
  { id: 'storage',   label: '스토리지',   icon: Database,  paths: ['/mc'], modes: ['platform'] },
  { id: 'services',  label: '서비스/앱',  icon: Package,   paths: ['/lake-services', '/coroot'], modes: ['platform'] },
  { id: 'devops',    label: 'DevOps',     icon: GitBranch, paths: ['/playbooks', '/batch-jobs', '/commands'], modes: ['platform'] },
  { id: 'collab',    label: '협업',       icon: Users,     paths: ['/tasks-mgmt', '/todo-today', '/sprints', '/members', '/workflow', '/wbs'], modes: ['work'] },
  { id: 'knowledge', label: '지식/분석',  icon: BookOpen,  paths: ['/docs', '/knowledge', '/ops-notes', '/mindmap', '/ontology', '/trends', '/work-guides'], modes: ['work'] },
  { id: 'system',    label: '시스템',     icon: Settings,  paths: ['/settings'], modes: ['work', 'platform'] },
];

export const DEFAULT_TITLE = 'PEP';
