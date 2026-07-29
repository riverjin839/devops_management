import type { ComponentType } from 'react';
import {
  LayoutDashboard, BookOpen, ListTodo, Sparkles, Settings, Server,
  CalendarCheck2, Link2, Tags, Calculator, GitFork, BookMarked, Layers, Boxes,
  Map, BarChart3, Network, Zap, Route, Share2, Rss, Users, GitCommit, Terminal, Database, Cpu, HardDrive,
  ClipboardCheck, ListTree, Waves, TerminalSquare, Library, Home, Workflow,
  ShieldCheck, Activity, Package, GitBranch, ScrollText, Rocket, ShipWheel, Gauge, Bell, BellRing, Dog,
  TrendingUp, FileSpreadsheet, Palmtree, FileText,
} from 'lucide-react';

// ── Nav registry ──────────────────────────────────────────────────────────────
// 사이드바(Sidebar)와 Settings 의 "화면 UI 설정" 탭(NavMenuManager / PageStyleManager)이
// 공유하는 정적 네비게이션 정의. 컴포넌트 파일에 두면 react-refresh 가 경고하므로 분리.
// `/services` (통합 지식/SOP) 는 사이드바 "PEP 서비스" 그룹의 진입점 — 아래 GROUPS 참고.
export const NAV_MAP: Record<string, { defaultLabel: string; icon: ComponentType<{ className?: string }>; iconColor?: string; iconSize?: string }> = {
  '/':                   { defaultLabel: '홈 (Today)',     icon: Home },
  // Your Island — 사용자 커스텀 화면. GROUPS 에는 넣지 않는다(그룹 레일이 아니라
  // 사이드바 최상단 독립 버튼). NAV_MAP 에는 라벨 오버라이드/화면 UI 설정 대상이 되도록 등록.
  '/island':             { defaultLabel: 'Your Island',    icon: Palmtree },
  '/cluster-overview':   { defaultLabel: '클러스터 현황',  icon: LayoutDashboard },
  '/k8s-manage':         { defaultLabel: 'K8S 상세 관리',  icon: ShipWheel, iconColor: 'text-orange-500', iconSize: 'w-5 h-5' },
  '/k8s-allocation':     { defaultLabel: 'K8S 자원 관리',  icon: Gauge, iconColor: 'text-orange-500', iconSize: 'w-5 h-5' },
  '/k9s':                { defaultLabel: 'k9s 콘솔',        icon: Dog, iconColor: 'text-orange-500', iconSize: 'w-5 h-5' },
  '/cluster-trends':     { defaultLabel: '클러스터 추이',  icon: TrendingUp, iconColor: 'text-cyan-500', iconSize: 'w-5 h-5' },
  '/ops-checks':         { defaultLabel: '운영 점검',       icon: ShieldCheck },
  '/k8s-logs':           { defaultLabel: '파드 로그',       icon: ScrollText },
  '/daily-check/review': { defaultLabel: '점검 결과 리뷰',  icon: ClipboardCheck },
  '/daily-check/settings':{ defaultLabel: '점검 항목 관리',  icon: Sparkles },
  '/lake-services':      { defaultLabel: 'LAKE 서비스',     icon: Database },
  '/pod-bottleneck':     { defaultLabel: 'Pod 병목 진단',   icon: Activity },
  '/docs':               { defaultLabel: '지식 허브 홈',    icon: Library },
  '/services':           { defaultLabel: 'PEP 서비스',      icon: Package },
  '/pep-services':       { defaultLabel: 'PEP 서비스 (LAKE, 구)', icon: Package },
  '/app-services':       { defaultLabel: 'APP 서비스',      icon: Boxes },
  '/playbooks':          { defaultLabel: 'Playbooks',      icon: BookOpen },
  '/tasks-mgmt':         { defaultLabel: '업무 관리',      icon: ListTodo },
  '/todo-today':         { defaultLabel: 'Work To Do',     icon: CalendarCheck2 },
  '/sprints':            { defaultLabel: '스프린트',        icon: Rocket },
  '/members':            { defaultLabel: '멤버별 업무',    icon: Users },
  '/cluster-manage':     { defaultLabel: '클러스터 관리',  icon: Server },
  '/versions':           { defaultLabel: '버전 / 설정',     icon: GitCommit },
  '/bulk-exec':          { defaultLabel: '노드 일괄 실행', icon: Terminal },
  '/node-ssh':           { defaultLabel: '노드 SSH 터미널', icon: TerminalSquare, iconColor: 'text-sky-500' },
  '/etcdctl':            { defaultLabel: 'etcdctl 콘솔',   icon: Database },
  '/batch-jobs':         { defaultLabel: 'Batch Jobs',     icon: ListTree },
  '/mc':                 { defaultLabel: 'mc 클라이언트',  icon: HardDrive },
  '/isilon-nfs':         { defaultLabel: 'NFS 모니터링',   icon: HardDrive, iconColor: 'text-sky-500' },
  '/kernel-params':      { defaultLabel: '커널 파라미터',  icon: Cpu },
  '/infra-topology':     { defaultLabel: '인프라 토폴로지', icon: Network },
  '/node-specs':         { defaultLabel: '노드 서버스펙',  icon: ClipboardCheck },
  '/links':              { defaultLabel: '클러스터 링크',  icon: Link2 },
  '/node-labels':        { defaultLabel: 'K8S 노드 라벨',   icon: Tags },
  '/node-images':        { defaultLabel: 'K8S 노드 이미지', icon: Boxes },
  '/cidr':               { defaultLabel: 'CIDR 계산기',    icon: Calculator },
  '/k8s-events':         { defaultLabel: 'K8s 실시간 이벤트', icon: Bell, iconColor: 'text-orange-500' },
  '/observability':      { defaultLabel: 'Observability',   icon: Activity, iconColor: 'text-emerald-500' },
  '/alerts':             { defaultLabel: '알람 인박스',      icon: BellRing, iconColor: 'text-red-500' },
  '/incident-analysis':  { defaultLabel: 'K8s 로그 (분석·실시간)', icon: Zap },
  '/packet-flow':        { defaultLabel: '패킷 흐름 분석', icon: Route },
  '/cilium-trace':       { defaultLabel: 'Cilium BPF Trace', icon: Waves },
  '/service-topology':   { defaultLabel: '서비스 토폴로지', icon: Workflow },
  '/service-architecture': { defaultLabel: '서비스 아키텍처', icon: Boxes },
  '/architecture':       { defaultLabel: '서비스 모듈 관계도', icon: GitBranch },
  '/ontology':           { defaultLabel: '온톨로지 그래프', icon: Share2 },
  '/trends':             { defaultLabel: '기술 동향',      icon: Rss },
  '/work-guides':        { defaultLabel: '표준 작업 가이드', icon: BookMarked },
  '/commands':           { defaultLabel: '주요 명령어',     icon: TerminalSquare },
  '/ops-notes':          { defaultLabel: '운영 노트보드',   icon: Layers },
  '/wbs':                { defaultLabel: 'WBS 작업흐름',   icon: BarChart3 },
  '/mindmap':            { defaultLabel: '마인드맵',       icon: Map },
  '/workflow':           { defaultLabel: '워크플로우',     icon: GitFork },
  '/settings':           { defaultLabel: 'Settings',       icon: Settings },
  '/jira-import':        { defaultLabel: 'Jira Excel 가져오기', icon: FileSpreadsheet },
  '/weekly-report':      { defaultLabel: '주간보고', icon: FileText },
};

// 사이드바 레일에 표시되는 그룹들
export type GroupId = 'cluster' | 'server' | 'network' | 'storage' | 'services' | 'devops' | 'collab' | 'pep-services' | 'app-services' | 'system';
export const GROUPS: Array<{ id: GroupId; label: string; icon: ComponentType<{ className?: string }>; paths: string[]; modes: ('work' | 'platform')[] }> = [
  { id: 'cluster',   label: '클러스터',   icon: Layers,    paths: ['/cluster-overview', '/k8s-manage', '/k8s-allocation', '/k9s', '/cluster-trends', '/node-labels', '/node-images', '/ops-checks', '/observability', '/alerts', '/k8s-events', '/incident-analysis', '/daily-check/review', '/daily-check/settings', '/pod-bottleneck', '/versions', '/bulk-exec', '/node-ssh', '/etcdctl', '/cluster-manage'], modes: ['platform'] },
  { id: 'server',    label: '서버/인프라', icon: Server,    paths: ['/node-specs', '/kernel-params', '/infra-topology'], modes: ['platform'] },
  { id: 'network',   label: '네트워크',   icon: Network,   paths: ['/cilium-trace', '/service-topology', '/service-architecture', '/architecture', '/packet-flow', '/cidr', '/links'], modes: ['platform'] },
  { id: 'storage',   label: '스토리지',   icon: Database,  paths: ['/mc', '/isilon-nfs'], modes: ['platform'] },
  // /coroot 는 COROOT APM 통합 전체 제거로 더 이상 존재하지 않는 라우트 — 재추가하지 않음.
  { id: 'services',  label: '서비스/앱',  icon: Package,   paths: ['/lake-services'], modes: ['platform'] },
  { id: 'devops',    label: 'DevOps',     icon: GitBranch, paths: ['/playbooks', '/batch-jobs', '/commands'], modes: ['platform'] },
  { id: 'collab',    label: '협업',       icon: Users,     paths: ['/tasks-mgmt', '/todo-today', '/sprints', '/members', '/workflow', '/wbs', '/jira-import', '/weekly-report'], modes: ['work'] },
  // "PEP 서비스" — Settings → "관리 서비스" 탭 → "PEP 서비스" 서브탭(LakeServiceType domain='pep')에 등록된 서비스
  // 카탈로그의 진입점(/services, ServicesCatalogPage). 서비스 클릭 시 노트(작업계획서/업무소개/
  // 이슈대응/구축작업)와 연관 업무를 보여주는 /services/:service(ServiceHubPage)로 이동한다.
  // 과거 LakeService 기반 페이지(/pep-services)는 사이드바에서 빠지고 직접 URL 접근으로만
  // 남는다(/docs, /lake-services 와 동일 패턴) — 데이터/라우트 자체는 그대로 유지.
  { id: 'pep-services', label: 'PEP 서비스', icon: Package, paths: ['/services'], modes: ['work'] },
  { id: 'app-services', label: 'APP 서비스', icon: Boxes,   paths: ['/app-services'], modes: ['work'] },
  { id: 'system',    label: '시스템',     icon: Settings,  paths: ['/settings'], modes: ['work', 'platform'] },
];

export const DEFAULT_TITLE = 'PEP';
