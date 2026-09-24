import type { ComponentType } from 'react';
import {
  LayoutDashboard, BookOpen, ListTodo, Sparkles, Settings, Server,
  CalendarCheck2, Link2, Tags, Calculator, GitFork, BookMarked, Layers, Boxes,
  Map, BarChart3, Network, Zap, Route, Share2, Rss, Users, GitCommit, Terminal, Database, Cpu, HardDrive,
  ClipboardCheck, ListTree, Waves, TerminalSquare, Library, Home, Workflow,
  ShieldCheck, Activity, GitBranch, ScrollText, Rocket, ShipWheel, Gauge, Bell, BellRing, Dog,
  TrendingUp, FileSpreadsheet, Palmtree, FileText, FileCode2, LayoutGrid, KeyRound,
} from 'lucide-react';

// ── Nav registry ──────────────────────────────────────────────────────────────
// 사이드바(Sidebar)와 Settings 의 "화면 UI 설정" 탭(NavMenuManager / PageStyleManager)이
// 공유하는 정적 네비게이션 정의. 컴포넌트 파일에 두면 react-refresh 가 경고하므로 분리.
export const NAV_MAP: Record<string, { defaultLabel: string; icon: ComponentType<{ className?: string }>; iconColor?: string; iconSize?: string }> = {
  '/':                   { defaultLabel: '홈',            icon: Home },
  // Your Island — 사용자 커스텀 화면. GROUPS 에는 넣지 않는다(그룹 레일이 아니라
  // 사이드바 최상단 독립 버튼). NAV_MAP 에는 라벨 오버라이드/화면 UI 설정 대상이 되도록 등록.
  '/island':             { defaultLabel: '나의 아일랜드', icon: Palmtree },
  '/cluster-overview':   { defaultLabel: '클러스터 현황',  icon: LayoutDashboard },
  '/k8s-manage':         { defaultLabel: 'K8s 상세 관리',  icon: ShipWheel, iconColor: 'text-orange-500', iconSize: 'w-5 h-5' },
  '/k8s-allocation':     { defaultLabel: 'K8s 자원 관리',  icon: Gauge, iconColor: 'text-orange-500', iconSize: 'w-5 h-5' },
  '/k9s':                { defaultLabel: 'k9s 콘솔',        icon: Dog, iconColor: 'text-orange-500', iconSize: 'w-5 h-5' },
  '/cluster-trends':     { defaultLabel: '클러스터 추이',  icon: TrendingUp, iconColor: 'text-cyan-500', iconSize: 'w-5 h-5' },
  '/clusters':           { defaultLabel: '클러스터 상세',    icon: LayoutGrid },
  '/ops-checks':         { defaultLabel: '운영 점검',       icon: ShieldCheck },
  '/k8s-logs':           { defaultLabel: '파드 로그',       icon: ScrollText },
  '/daily-check/review': { defaultLabel: '점검 결과 리뷰',  icon: ClipboardCheck },
  '/daily-check/settings':{ defaultLabel: '점검 항목 관리',  icon: Sparkles },
  '/lake-services':      { defaultLabel: 'LAKE 서비스',     icon: Database },
  '/pod-bottleneck':     { defaultLabel: 'Pod 병목 진단',   icon: Activity },
  '/docs':               { defaultLabel: '지식 허브 홈',    icon: Library },
  '/playbooks':          { defaultLabel: '플레이북',        icon: BookOpen },
  '/tasks-mgmt':         { defaultLabel: '업무 관리',      icon: ListTodo },
  '/todo-today':         { defaultLabel: '오늘 할 일',     icon: CalendarCheck2 },
  '/sprints':            { defaultLabel: '스프린트',        icon: Rocket },
  '/members':            { defaultLabel: '멤버별 업무',    icon: Users },
  '/cluster-manage':     { defaultLabel: '클러스터 관리',  icon: Server },
  '/versions':           { defaultLabel: '버전 / 설정',     icon: GitCommit },
  '/bulk-exec':          { defaultLabel: '노드 일괄 실행', icon: Terminal },
  '/node-ssh':           { defaultLabel: '노드 SSH 터미널', icon: TerminalSquare, iconColor: 'text-status-info' },
  '/etcdctl':            { defaultLabel: 'etcdctl 콘솔',   icon: Database },
  '/batch-jobs':         { defaultLabel: '배치잡',          icon: ListTree },
  '/mc':                 { defaultLabel: 'mc 클라이언트',  icon: HardDrive },
  '/isilon-nfs':         { defaultLabel: 'NFS 모니터링',   icon: HardDrive, iconColor: 'text-status-info' },
  '/kernel-params':      { defaultLabel: '커널 파라미터',  icon: Cpu },
  '/infra-topology':     { defaultLabel: '인프라 토폴로지', icon: Network },
  '/node-specs':         { defaultLabel: '노드 서버스펙',  icon: ClipboardCheck },
  '/links':              { defaultLabel: '클러스터 링크',  icon: Link2 },
  '/node-labels':        { defaultLabel: 'K8s 노드 라벨',   icon: Tags },
  '/k8s-rbac':           { defaultLabel: 'K8S 접근 권한',  icon: KeyRound },
  '/node-images':        { defaultLabel: 'K8s 노드 이미지', icon: Boxes },
  '/cidr':               { defaultLabel: 'CIDR 계산기',    icon: Calculator },
  '/k8s-events':         { defaultLabel: 'K8s 실시간 이벤트', icon: Bell, iconColor: 'text-orange-500' },
  '/observability':      { defaultLabel: '관측 지표',       icon: Activity, iconColor: 'text-status-healthy' },
  '/alerts':             { defaultLabel: '알람 인박스',      icon: BellRing, iconColor: 'text-status-critical' },
  '/incident-analysis':  { defaultLabel: 'K8s 로그 (분석·실시간)', icon: Zap },
  '/packet-flow':        { defaultLabel: '패킷 흐름 분석', icon: Route },
  '/cilium-trace':       { defaultLabel: 'Cilium BPF 추적', icon: Waves },
  '/service-topology':   { defaultLabel: '서비스 토폴로지', icon: Workflow },
  '/service-architecture': { defaultLabel: '서비스 아키텍처', icon: Boxes },
  '/architecture':       { defaultLabel: '서비스 모듈 관계도', icon: GitBranch },
  '/ontology':           { defaultLabel: '온톨로지 그래프', icon: Share2 },
  '/trends':             { defaultLabel: '기술 동향',      icon: Rss },
  '/work-guides':        { defaultLabel: '표준 작업 가이드', icon: BookMarked },
  '/commands':           { defaultLabel: '주요 명령어',     icon: TerminalSquare },
  '/scripts':            { defaultLabel: '스크립트 라이브러리', icon: FileCode2 },
  '/ops-notes':          { defaultLabel: '운영 노트보드',   icon: Layers },
  '/wbs':                { defaultLabel: 'WBS 작업흐름',   icon: BarChart3 },
  '/mindmap':            { defaultLabel: '마인드맵',       icon: Map },
  '/workflow':           { defaultLabel: '워크플로우',     icon: GitFork },
  '/settings':           { defaultLabel: '설정',           icon: Settings },
  '/jira-import':        { defaultLabel: 'Jira Excel 가져오기', icon: FileSpreadsheet },
  '/weekly-report':      { defaultLabel: '주간보고', icon: FileText },
  '/documents':          { defaultLabel: '문서 관리',      icon: FileText },
};

// 사이드바 레일에 표시되는 그룹들
export type GroupId =
  | 'observe' | 'inspect' | 'operate' | 'configure'
  | 'infra' | 'network' | 'devops' | 'collab' | 'documents' | 'system';
/**
 * `domain` — 예전엔 홈 모드(work/platform)가 이 값으로 사이드바 그룹 자체를 게이팅했다
 * (D-054). 지금은 게이팅에 쓰지 않고 **배치 위치 결정**에만 쓴다: `platform` → 좌측
 * 사이드바 레일, `work` → 전역 상단바(AppTopBar), `system` → 레일 하단 개인 존(admin 전용).
 * 모든 그룹이 항상 어딘가에 보이므로 반대 도메인 화면이 "사라지는" 일이 없다.
 */
export interface NavGroup {
  id: GroupId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  paths: string[];
  domain: 'work' | 'platform' | 'system';
  /** 카탈로그(앱 추가)·설정 화면에 섹션 설명으로 보이는 한 줄. */
  description?: string;
  /** `danger` — 클러스터/노드에 명령을 보내는 화면 묶음. 카탈로그에서 경고 톤으로 구분한다. */
  tone?: 'danger';
}

/**
 * P1 메뉴 재편(2026-09) — 23개가 몰려 있던 '클러스터' 그룹을 하는 일 기준으로 나눴다.
 * 관측(읽기) / 점검(확인·기록) / 운영 조작(명령 전송, danger) / 구성(등록·자원·권한).
 * 서버/인프라·스토리지·서비스/앱(1~3개짜리)은 '인프라' 하나로 합쳤다.
 * 설치 단위는 leaf path 라 그룹 id 를 바꿔도 사용자가 설치해 둔 레일 아이콘은 그대로다.
 */
export const GROUPS: NavGroup[] = [
  { id: 'observe',   label: '클러스터 · 관측',     icon: Activity,    description: '상태를 본다 — 읽기 전용', domain: 'platform',
    paths: ['/cluster-overview', '/cluster-trends', '/observability', '/alerts', '/k8s-events', '/k8s-logs', '/incident-analysis'] },
  { id: 'inspect',   label: '클러스터 · 점검',     icon: ShieldCheck, description: '상태를 확인하고 기록한다', domain: 'platform',
    paths: ['/ops-checks', '/daily-check/review', '/daily-check/settings', '/pod-bottleneck', '/versions'] },
  { id: 'operate',   label: '클러스터 · 운영 조작', icon: Terminal,    description: '클러스터·노드에 명령을 보낸다 — 실행 전 대상을 확인할 것', domain: 'platform', tone: 'danger',
    paths: ['/k8s-manage', '/k9s', '/bulk-exec', '/node-ssh', '/etcdctl'] },
  { id: 'configure', label: '클러스터 · 구성',     icon: Layers,      description: '클러스터 등록·자원·권한을 관리한다', domain: 'platform',
    paths: ['/clusters', '/cluster-manage', '/k8s-allocation', '/k8s-rbac', '/node-labels', '/node-images'] },
  // 서버/인프라(3) + 스토리지(2) + 서비스/앱(1) 통합. /coroot 는 COROOT APM 통합 제거로 없는 라우트 — 재추가하지 않음.
  { id: 'infra',     label: '인프라',     icon: Server,    domain: 'platform',
    paths: ['/node-specs', '/kernel-params', '/infra-topology', '/mc', '/isilon-nfs', '/lake-services'] },
  { id: 'network',   label: '네트워크',   icon: Network,   paths: ['/cilium-trace', '/service-topology', '/service-architecture', '/architecture', '/packet-flow', '/cidr', '/links'], domain: 'platform' },
  // '/batch-jobs' 는 사이드바 진입점에서 뺐다 — 홈 화면 "플랫폼 현황" 탭의 서브탭으로
  // 병합됐다(NAV_MAP 항목은 접근 제어/라벨 커스터마이징/Island 패널을 위해 유지).
  { id: 'devops',    label: 'DevOps',     icon: GitBranch, paths: ['/playbooks', '/commands', '/scripts'], domain: 'platform' },
  { id: 'collab',    label: '업무 관리',  icon: Users,     paths: ['/tasks-mgmt', '/todo-today', '/sprints', '/members', '/workflow', '/wbs', '/weekly-report', '/jira-import'], domain: 'work' },
  // "문서 관리" — /documents(Confluence 가져오기/내보내기 대시보드)가 진입점. 2026-07 사이드바
  // 개편 때 그룹을 잃고 URL 전용으로 남았던 지식 화면들(/work-guides, /docs, /ops-notes,
  // /mindmap, /ontology, /trends)을 이 그룹으로 복귀시킨다.
  { id: 'documents', label: '문서 관리',  icon: Library,   paths: ['/documents', '/work-guides', '/docs', '/ops-notes', '/mindmap', '/ontology', '/trends'], domain: 'work' },
  { id: 'system',    label: '시스템',     icon: Settings,  paths: ['/settings'], domain: 'system' },
];

export const DEFAULT_TITLE = 'PEP';
