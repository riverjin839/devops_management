import type { ComponentType } from 'react';
import {
  BookOpen, ListTodo, Sparkles, Settings, Server,
  CalendarCheck2, Link2, Tags, Calculator, GitFork, BookMarked, Layers, Boxes,
  Map, BarChart3, Network, Zap, Route, Share2, Rss, Users, GitCommit, Terminal, Database, Cpu, HardDrive,
  ClipboardCheck, ListTree, Waves, TerminalSquare, Library, Home, Workflow,
  ShieldCheck, Activity, GitBranch, ScrollText, Rocket, ShipWheel, Gauge, Bell, BellRing, Dog,
  TrendingUp, FileSpreadsheet, Palmtree, FileText, FileCode2, LayoutGrid, KeyRound, ArrowRightLeft,
} from 'lucide-react';
import type { NavGroupDescKey, NavGroupKey, NavPageKey } from '@/i18n/resources/ko';

// ── Nav registry ──────────────────────────────────────────────────────────────
// 사이드바(Sidebar)와 Settings 의 "화면 UI 설정" 탭(NavMenuManager / PageStyleManager)이
// 공유하는 정적 네비게이션 정의. 컴포넌트 파일에 두면 react-refresh 가 경고하므로 분리.
//
// R-6 i18n — `labelKey` 는 `nav.page.*` 번역 키(i18n/resources/ko.ts 가 원천, 없는 키면 tsc 실패).
// `defaultLabel` 은 한국어 기본 라벨로 **그대로 유지**한다: 커맨드 팔레트 검색·Settings 메뉴 편집·
// 아일랜드 피커·앱 카탈로그가 아직 이 값을 직접 쓴다. 셸(사이드바·상단바)의 표시 라벨은
// `i18n/useNavLabel` 이 [관리자 커스텀 라벨 → labelKey 번역] 순으로 고른다.
export interface NavMapEntry {
  labelKey: NavPageKey;
  defaultLabel: string;
  icon: ComponentType<{ className?: string }>;
  iconColor?: string;
  iconSize?: string;
}
export const NAV_MAP: Record<string, NavMapEntry> = {
  '/':                   { labelKey: 'home', defaultLabel: '홈',            icon: Home },
  // Your Island — 사용자 커스텀 화면. GROUPS 에는 넣지 않는다(그룹 레일이 아니라
  // 사이드바 최상단 독립 버튼). NAV_MAP 에는 라벨 오버라이드/화면 UI 설정 대상이 되도록 등록.
  '/island':             { labelKey: 'island', defaultLabel: '나의 아일랜드', icon: Palmtree },
  // K8s 클러스터 허브 — per-cluster K8s 화면(상세·상세 관리·자원·추이·관측·이벤트·로그·분석·점검 리뷰)을
  // 클러스터 레일 하나 + 탭으로 모은 화면(`/k8s/:clusterId/:view`). 아래 흡수된 leaf 경로들은 허브 뷰로
  // redirect 되지만 NAV_MAP 에 남겨 접근 제어·라벨 오버라이드·아일랜드 패널·leaf 단위 설치(바로가기)를 유지한다.
  '/k8s':                { labelKey: 'k8sHub', defaultLabel: 'K8s 클러스터',   icon: ShipWheel, iconSize: 'w-5 h-5' },
  '/k8s-manage':         { labelKey: 'k8sManage', defaultLabel: 'K8s 상세 관리',  icon: Boxes, iconSize: 'w-5 h-5' },
  '/k8s-allocation':     { labelKey: 'k8sAllocation', defaultLabel: 'K8s 자원 관리',  icon: Gauge, iconSize: 'w-5 h-5' },
  '/k9s':                { labelKey: 'k9s', defaultLabel: 'k9s 콘솔',        icon: Dog, iconSize: 'w-5 h-5' },
  '/cluster-trends':     { labelKey: 'clusterTrends', defaultLabel: '클러스터 추이',  icon: TrendingUp, iconSize: 'w-5 h-5' },
  '/clusters':           { labelKey: 'clusters', defaultLabel: '클러스터 상세',    icon: LayoutGrid },
  '/ops-checks':         { labelKey: 'opsChecks', defaultLabel: '운영 점검',       icon: ShieldCheck },
  '/k8s-logs':           { labelKey: 'k8sLogs', defaultLabel: '파드 로그',       icon: ScrollText },
  '/daily-check/review': { labelKey: 'dailyCheckReview', defaultLabel: '점검 결과 리뷰',  icon: ClipboardCheck },
  '/daily-check/settings':{ labelKey: 'dailyCheckSettings', defaultLabel: '점검 항목 관리',  icon: Sparkles },
  '/lake-services':      { labelKey: 'lakeServices', defaultLabel: 'LAKE 서비스',     icon: Database },
  '/pod-bottleneck':     { labelKey: 'podBottleneck', defaultLabel: '파드 병목 진단',   icon: Activity },
  '/docs':               { labelKey: 'docs', defaultLabel: '지식 허브 홈',    icon: Library },
  '/playbooks':          { labelKey: 'playbooks', defaultLabel: '플레이북',        icon: BookOpen },
  '/tasks-mgmt':         { labelKey: 'tasksMgmt', defaultLabel: '업무 관리',      icon: ListTodo },
  '/todo-today':         { labelKey: 'todoToday', defaultLabel: '오늘 할 일',     icon: CalendarCheck2 },
  '/sprints':            { labelKey: 'sprints', defaultLabel: '스프린트',        icon: Rocket },
  '/members':            { labelKey: 'members', defaultLabel: '멤버별 업무',    icon: Users },
  '/cluster-manage':     { labelKey: 'clusterManage', defaultLabel: '클러스터 관리',  icon: Server },
  '/versions':           { labelKey: 'versions', defaultLabel: '버전 / 설정',     icon: GitCommit },
  '/bulk-exec':          { labelKey: 'bulkExec', defaultLabel: '노드 일괄 실행', icon: Terminal },
  '/node-ssh':           { labelKey: 'nodeSsh', defaultLabel: '노드 SSH 터미널', icon: TerminalSquare },
  '/etcdctl':            { labelKey: 'etcdctl', defaultLabel: 'etcdctl 콘솔',   icon: Database },
  '/batch-jobs':         { labelKey: 'batchJobs', defaultLabel: '배치잡',          icon: ListTree },
  '/mc':                 { labelKey: 'mc', defaultLabel: 'mc 클라이언트',  icon: HardDrive },
  '/isilon-nfs':         { labelKey: 'isilonNfs', defaultLabel: 'NFS 모니터링',   icon: HardDrive },
  '/kernel-params':      { labelKey: 'kernelParams', defaultLabel: '커널 파라미터',  icon: Cpu },
  '/infra-topology':     { labelKey: 'infraTopology', defaultLabel: '인프라 토폴로지', icon: Network },
  '/node-specs':         { labelKey: 'nodeSpecs', defaultLabel: '노드 서버스펙',  icon: ClipboardCheck },
  '/links':              { labelKey: 'links', defaultLabel: '클러스터 링크',  icon: Link2 },
  '/node-labels':        { labelKey: 'nodeLabels', defaultLabel: 'K8s 노드 라벨',   icon: Tags },
  '/k8s-rbac':           { labelKey: 'k8sRbac', defaultLabel: 'K8s 접근 권한',  icon: KeyRound },
  '/ns-migration':       { labelKey: 'nsMigration', defaultLabel: 'NS 마이그레이션', icon: ArrowRightLeft },
  '/node-images':        { labelKey: 'nodeImages', defaultLabel: 'K8s 노드 이미지', icon: Boxes },
  '/cidr':               { labelKey: 'cidr', defaultLabel: 'CIDR 계산기',    icon: Calculator },
  '/k8s-events':         { labelKey: 'k8sEvents', defaultLabel: 'K8s 실시간 이벤트', icon: Bell },
  '/observability':      { labelKey: 'observability', defaultLabel: '관측 지표',       icon: Activity },
  '/alerts':             { labelKey: 'alerts', defaultLabel: '알람 인박스',      icon: BellRing },
  '/incident-analysis':  { labelKey: 'incidentAnalysis', defaultLabel: 'K8s 로그 (분석·실시간)', icon: Zap },
  '/packet-flow':        { labelKey: 'packetFlow', defaultLabel: '패킷 흐름 분석', icon: Route },
  '/cilium-trace':       { labelKey: 'ciliumTrace', defaultLabel: 'Cilium BPF 추적', icon: Waves },
  '/service-topology':   { labelKey: 'serviceTopology', defaultLabel: '서비스 토폴로지', icon: Workflow },
  '/service-architecture': { labelKey: 'serviceArchitecture', defaultLabel: '서비스 아키텍처', icon: Boxes },
  '/architecture':       { labelKey: 'architecture', defaultLabel: '서비스 모듈 관계도', icon: GitBranch },
  '/ontology':           { labelKey: 'ontology', defaultLabel: '온톨로지 그래프', icon: Share2 },
  '/trends':             { labelKey: 'trends', defaultLabel: '기술 동향',      icon: Rss },
  '/work-guides':        { labelKey: 'workGuides', defaultLabel: '표준 작업 가이드', icon: BookMarked },
  '/commands':           { labelKey: 'commands', defaultLabel: '주요 명령어',     icon: TerminalSquare },
  '/scripts':            { labelKey: 'scripts', defaultLabel: '스크립트 라이브러리', icon: FileCode2 },
  '/ops-notes':          { labelKey: 'opsNotes', defaultLabel: '운영 노트보드',   icon: Layers },
  '/wbs':                { labelKey: 'wbs', defaultLabel: 'WBS 작업흐름',   icon: BarChart3 },
  '/mindmap':            { labelKey: 'mindmap', defaultLabel: '마인드맵',       icon: Map },
  '/workflow':           { labelKey: 'workflow', defaultLabel: '워크플로',       icon: GitFork },
  '/settings':           { labelKey: 'settings', defaultLabel: '설정',           icon: Settings },
  '/jira-import':        { labelKey: 'jiraImport', defaultLabel: 'Jira Excel 가져오기', icon: FileSpreadsheet },
  '/weekly-report':      { labelKey: 'weeklyReport', defaultLabel: '주간보고', icon: FileText },
  '/documents':          { labelKey: 'documents', defaultLabel: '문서 관리',      icon: FileText },
};

// 사이드바 레일에 표시되는 그룹들
export type GroupId =
  | 'k8s' | 'observe' | 'inspect' | 'operate' | 'configure'
  | 'topology' | 'automate' | 'collab' | 'documents' | 'system';
/**
 * `domain` — 예전엔 홈 모드(work/platform)가 이 값으로 사이드바 그룹 자체를 게이팅했다
 * (D-054). 지금은 게이팅에 쓰지 않고 **배치 위치 결정**에만 쓴다: `platform` → 좌측
 * 사이드바 레일, `work` → 전역 상단바(AppTopBar), `system` → 레일 하단 개인 존(admin 전용).
 * 모든 그룹이 항상 어딘가에 보이므로 반대 도메인 화면이 "사라지는" 일이 없다.
 */
export interface NavGroup {
  id: GroupId;
  label: string;
  /** `nav.group.*` 번역 키 — 그룹 id 와 같다(`GroupId` 가 키 목록과 어긋나면 tsc 실패). */
  labelKey: NavGroupKey;
  icon: ComponentType<{ className?: string }>;
  paths: string[];
  domain: 'work' | 'platform' | 'system';
  /** 카탈로그(앱 추가)·설정 화면에 섹션 설명으로 보이는 한 줄. */
  description?: string;
  /** `nav.groupDesc.*` 번역 키 — description 이 있는 그룹만. */
  descriptionKey?: NavGroupDescKey;
  /** `danger` — 클러스터/노드에 명령을 보내는 화면 묶음. 카탈로그에서 경고 톤으로 구분한다. */
  tone?: 'danger';
}

/**
 * P1 메뉴 재편(2026-09) — 23개가 몰려 있던 '클러스터' 그룹을 하는 일 기준으로 나눴다.
 * D-133 재편(2026-10) — 앞 4그룹은 작업 유형("클러스터 · 관측"…), 뒤 3그룹은 도메인(인프라/네트워크/DevOps)
 * 으로 같은 깊이에서 분류 축이 섞여 있었다. 플랫폼 그룹을 **하는 일 한 축**으로 통일했다:
 * 관측(읽기) / 점검·진단(확인·추적) / 운영 조작(명령 전송, danger) / 구성·자산(등록·자원·권한·스펙) /
 * 토폴로지(구조 지도) / 자동화·도구. 업무·지식 그룹은 리프("업무 관리"·"문서 관리")와 이름이 겹치지 않게 바꿨다.
 * 설치 단위는 leaf path 라 그룹 id 를 바꿔도 사용자가 설치해 둔 레일 아이콘·라벨·페이지 스타일은 그대로다.
 */
export const GROUPS: NavGroup[] = [
  // K8s 클러스터 허브(2026-10-22, D-240) — 클러스터 하나를 고르고 보는 K8s 화면을 `/k8s` 한 화면으로 모았다.
  // 첫 항목이 허브, 나머지는 허브 뷰로 redirect 되는 옛 leaf(설치하면 그 뷰로 바로 가는 바로가기).
  { id: 'k8s',       label: 'K8s 클러스터', labelKey: 'k8s', descriptionKey: 'k8s', icon: ShipWheel, description: '클러스터 하나를 골라 상세·리소스·자원·관측·로그·점검을 한 화면에서', domain: 'platform',
    paths: ['/k8s', '/clusters', '/k8s-manage', '/k8s-allocation', '/cluster-trends', '/observability', '/k8s-events', '/k8s-logs', '/incident-analysis', '/daily-check/review'] },
  { id: 'observe',   label: '관측', labelKey: 'observe', descriptionKey: 'observe', icon: Activity,    description: '상태를 본다 — 읽기 전용', domain: 'platform',
    paths: ['/alerts', '/isilon-nfs', '/lake-services'] },
  // '/ops-checks'(운영 점검 콘솔, 레거시)는 사이드바에서 뺐다 — 같은 패널을 종합 상태까지 포함해
  // 보여주는 '/clusters/:id' 로 대체됐다(App.tsx 주석). 라우트·NAV_MAP 은 북마크/아일랜드 패널
  // 호환으로 유지(D-129).
  { id: 'inspect',   label: '점검·진단', labelKey: 'inspect', descriptionKey: 'inspect', icon: ShieldCheck, description: '상태를 확인·기록하고 원인을 추적한다', domain: 'platform',
    paths: ['/daily-check/settings', '/pod-bottleneck', '/cilium-trace', '/packet-flow', '/versions'] },
  { id: 'operate',   label: '운영 조작', labelKey: 'operate', descriptionKey: 'operate', icon: Terminal,    description: '클러스터·노드·스토리지에 명령을 보낸다 — 실행 전 대상을 확인할 것', domain: 'platform', tone: 'danger',
    paths: ['/ns-migration', '/k9s', '/bulk-exec', '/node-ssh', '/etcdctl', '/mc', '/kernel-params'] },
  { id: 'configure', label: '구성·자산', labelKey: 'configure', descriptionKey: 'configure', icon: Layers,      description: '클러스터 등록·자원·권한·노드 자산을 관리한다', domain: 'platform',
    paths: ['/cluster-manage', '/k8s-rbac', '/node-labels', '/node-images', '/node-specs', '/links'] },
  { id: 'topology',  label: '토폴로지', labelKey: 'topology', descriptionKey: 'topology', icon: Network,     description: '인프라·서비스 구조를 지도로 본다', domain: 'platform',
    paths: ['/infra-topology', '/service-topology', '/service-architecture', '/architecture'] },
  // '/batch-jobs' 는 사이드바 진입점에서 뺐다 — 홈 화면 "플랫폼 현황" 탭의 서브탭으로
  // 병합됐다(NAV_MAP 항목은 접근 제어/라벨 커스터마이징/Island 패널을 위해 유지).
  { id: 'automate',  label: '자동화·도구', labelKey: 'automate', descriptionKey: 'automate', icon: GitBranch,  description: '플레이북·스크립트·명령어·계산기', domain: 'platform',
    paths: ['/playbooks', '/scripts', '/commands', '/cidr'] },
  { id: 'collab',    label: '업무', labelKey: 'collab', icon: Users,     paths: ['/tasks-mgmt', '/todo-today', '/sprints', '/members', '/workflow', '/wbs', '/weekly-report', '/jira-import'], domain: 'work' },
  // "지식·문서" — /documents(Confluence 가져오기/내보내기 대시보드)가 진입점. 2026-07 사이드바
  // 개편 때 그룹을 잃고 URL 전용으로 남았던 지식 화면들(/work-guides, /docs, /ops-notes,
  // /mindmap, /ontology, /trends)을 이 그룹으로 복귀시킨다.
  { id: 'documents', label: '지식·문서', labelKey: 'documents', icon: Library,   paths: ['/documents', '/work-guides', '/docs', '/ops-notes', '/mindmap', '/ontology', '/trends'], domain: 'work' },
  { id: 'system',    label: '시스템', labelKey: 'system', icon: Settings,  paths: ['/settings'], domain: 'system' },
];

export const DEFAULT_TITLE = 'PEP';
