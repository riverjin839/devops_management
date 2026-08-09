// Status types
export type Status = 'healthy' | 'warning' | 'critical' | 'pending';

/** 아이콘 빌더 레시피 — 클러스터 아이콘을 뷰어의 현재 UI 테마로 다시 렌더하기 위한 입력값.
 *  `colorMode: 'theme'` 면 뷰어의 활성 테마(색상 패턴과 일치하면 그 팔레트, 아니면 운영타입
 *  색상)를 매번 따라간다. `colorMode: 'custom'` 이면 `customHex` 가 테마와 무관하게 항상
 *  우선한다(사용자가 배색 패턴 스와치를 직접 골랐을 때). `lib/clusterIconTheme.ts` 참고. */
export interface ClusterIconConfig {
  workName: string;
  attribute: string;
  regionAbbr: string;
  shape: 'square' | 'circle';
  watermark: boolean;
  /** 운영타입 value — 색상 폴백(colorMode 무관하게 colorToken 소스) + 향후 재편집 시 복원용. */
  level: string;
  colorMode: 'theme' | 'custom';
  /** colorMode === 'custom' 일 때만 의미 있음. */
  customHex?: string | null;
}

// Cluster
export interface Cluster {
  id: string;
  name: string;
  /** 사용자 지정 정렬 순번 (작을수록 위). 기본 1000, 10 간격 권장. */
  seq: number;
  apiEndpoint: string;
  kubeconfigPath: string;
  status: Status;
  // 클러스터 관리 메타데이터
  region?: string;
  operationLevel?: string;
  maxPod?: number;
  ciliumConfig?: string;
  // INTERNAL_IP — 우선순위: 자동수집 nodeIps > 수동입력 internalIps(IP 리스트 정규식) > fallback supernet cidr.
  // cidr 은 CIDR Calculator 의 클러스터 겹침 검사에도 계속 사용됨.
  cidr?: string;
  /** IP 리스트 정규식 (예: "10.0.1.[5-7,10]\n10.0.2.[1-3]") — nodeIps 미수집 시 표시용 */
  internalIps?: string;
  firstHost?: string;
  lastHost?: string;
  // Pod CIDR
  podCidr?: string;
  podFirstHost?: string;
  podLastHost?: string;
  // Service CIDR
  svcCidr?: string;
  svcFirstHost?: string;
  svcLastHost?: string;
  // NIC (bond0, bond1)
  bond0Ip?: string;
  bond0Mac?: string;
  bond1Ip?: string;
  bond1Mac?: string;
  description?: string;
  nodeCount?: number;
  hostname?: string;
  bgpEnabled?: boolean;
  asNumber?: string;
  // 자동 수집 확장
  k8sVersion?: string;
  ciliumVersion?: string;
  nodeIps?: string;   // JSON 문자열: [{name, ip, master}]
  // 사용자 정의 컬럼 값 (ClusterCustomField.key → value)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customValues?: Record<string, any> | null;
  // 사이드바 표시용 사용자 지정 아이콘 — lucide-react 컴포넌트 이름 (예: "Server") 또는 emoji 1자
  // 또는 (아이콘 빌더로 만든 경우) 렌더된 SVG data URL 스냅샷. null/empty 면 status 기반
  // 기본 아이콘으로 fallback. icon_config 가 있으면 프론트가 이 값 대신 매번 다시 렌더한다.
  icon?: string | null;
  // 아이콘 빌더 레시피 — 있으면 뷰어의 현재 UI 테마로 아이콘을 다시 렌더한다(테마 동기화).
  // useClusterIconSrc() 참고.
  iconConfig?: ClusterIconConfig | null;
  // Cluster Trends — per-cluster Prometheus URL 오버라이드 / 토글.
  prometheusUrl?: string | null;
  prometheusEnabled?: boolean;
  // Observability 대시보드 — Alertmanager URL + 수집 모드(pull=직접조회 / push=수집기 스냅샷).
  alertmanagerUrl?: string | null;
  observabilityMode?: 'pull' | 'push' | null;
  observabilityEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Cluster 커스텀 컬럼 (Confluence 스타일 table customization) ─────────
export type ClusterCustomFieldType = 'text' | 'number' | 'date' | 'checkbox' | 'select';

export interface ClusterCustomField {
  id: string;
  key: string;
  label: string;
  dataType: ClusterCustomFieldType;
  options?: string[] | null;
  description?: string | null;
  sortOrder: number;
  width?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClusterCustomFieldCreate {
  key: string;
  label: string;
  dataType?: ClusterCustomFieldType;
  options?: string[];
  description?: string;
  sortOrder?: number;
  width?: number;
}

export type ClusterCustomFieldUpdate = Partial<Omit<ClusterCustomFieldCreate, 'key'>>;

export type WorkItemCustomFieldType = 'text' | 'number' | 'date' | 'checkbox' | 'select';
export interface WorkItemCustomField {
  id: string;
  key: string;
  label: string;
  dataType: WorkItemCustomFieldType;
  options?: string[] | null;
  description?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
export interface WorkItemCustomFieldCreate {
  key: string;
  label: string;
  dataType?: WorkItemCustomFieldType;
  options?: string[];
  description?: string;
  sortOrder?: number;
}
export type WorkItemCustomFieldUpdate = Partial<Omit<WorkItemCustomFieldCreate, 'key'>>;

export interface ClusterCustomValuesUpdate {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: Record<string, any>;
}

// 값 해제(빈 입력)를 서버에 반영하려면 `undefined` 가 아니라 `null` 을 보내야 한다 —
// `undefined` 키는 JSON 직렬화에서 사라지고, 백엔드가 `model_dump(exclude_unset=True)`
// 로 갱신하므로 "미전송 = 기존 값 유지"가 되어 영영 지워지지 않는다. (DESIGN.md D-031)
export interface ClusterManageUpdate {
  region?: string | null;
  operationLevel?: string | null;
  maxPod?: number | null;
  ciliumConfig?: string | null;
  cidr?: string | null;
  internalIps?: string | null;
  firstHost?: string | null;
  lastHost?: string | null;
  podCidr?: string | null;
  podFirstHost?: string | null;
  podLastHost?: string | null;
  svcCidr?: string | null;
  svcFirstHost?: string | null;
  svcLastHost?: string | null;
  bond0Ip?: string | null;
  bond0Mac?: string | null;
  bond1Ip?: string | null;
  bond1Mac?: string | null;
  description?: string | null;
  nodeCount?: number | null;
  hostname?: string | null;
  bgpEnabled?: boolean;
  asNumber?: string | null;
  icon?: string | null;
  iconConfig?: ClusterIconConfig | null;
  prometheusUrl?: string | null;
  prometheusEnabled?: boolean;
  alertmanagerUrl?: string | null;
  observabilityMode?: 'pull' | 'push' | null;
  observabilityEnabled?: boolean;
}

// ── Cluster Trends (per-node 메트릭 추이) ──────────────────────────────
export type TrendMetricKey = 'cpu' | 'memory' | 'disk' | 'diskio' | 'network' | 'networkerr';
export type TrendRange = '30m' | '1h' | '6h' | '24h' | '7d';

// NOTE: 이름 충돌 회피 — daily-check 추이용 `TrendPoint`(checkedAt/status/...) 가
// 이 파일 하단에 이미 존재한다. 같은 이름의 interface 두 개는 TS 선언 병합으로
// 엉뚱하게 합쳐지므로, per-node 메트릭 포인트는 `TrendDataPoint` 로 둔다.
export interface TrendDataPoint {
  t: number;            // UNIX epoch seconds
  v: number | null;
}
export interface TrendSeries {
  node: string;
  points: TrendDataPoint[];
}
export interface TrendMetricBlock {
  unit: string;
  series: TrendSeries[];
}
export interface ClusterTrendsResponse {
  range: TrendRange;
  step: string;
  status: 'ok' | 'error' | 'offline';
  error?: string | null;
  dropped: string[];    // 상한 초과로 제외된 노드명
  metrics: Partial<Record<TrendMetricKey, TrendMetricBlock>>;
}

// Addon
export interface Addon {
  id: string;
  clusterId: string;
  name: string;
  type: string;
  icon: string;
  description: string;
  status: Status;
  responseTime?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: Record<string, any>;
  lastCheck: string;
}

// K8s 실시간 이벤트 (kubewatch 웹훅 수신)
export type K8sEventSeverity = 'info' | 'warning' | 'critical';

export interface K8sEvent {
  id: string;
  clusterId?: string | null;
  eventType: string;
  resourceKind: string;
  resourceName: string;
  namespace?: string | null;
  reason?: string | null;
  message?: string | null;
  severity: K8sEventSeverity;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw?: Record<string, any> | null;
  receivedAt: string;
  analysisId?: string | null;
  analysisStatus?: 'queued' | 'running' | 'done' | 'failed' | 'skipped' | null;
}

export interface K8sEventListResponse {
  data: K8sEvent[];
  total: number;
}

// Check Log
export interface CheckLog {
  id: string;
  clusterId: string;
  clusterName: string;
  addonId?: string;
  addonName?: string;
  status: Status;
  message: string;
  checkedAt: string;
}

// Summary Stats
export interface SummaryStats {
  totalClusters: number;
  healthy: number;
  warning: number;
  critical: number;
}

// API Response types
export interface ApiResponse<T> {
  data: T;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// Addon Config (for easy add/remove)
export interface AddonConfig {
  name: string;
  type: string;
  icon: string;
  description: string;
  checkPlaybook: string;
}

// Playbook
export interface Playbook {
  id: string;
  clusterId: string;
  name: string;
  description?: string;
  // 신: DB 에 저장된 Playbook 파일 / Inventory 참조
  playbookFileId?: string | null;
  inventoryId?: string | null;
  playbookFileName?: string | null;
  inventoryName?: string | null;
  // 구: 호스트 경로 직접 지정 (호환 유지)
  playbookPath?: string | null;
  inventoryPath?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraVars?: Record<string, any>;
  tags?: string;
  status: string;  // healthy | warning | critical | unknown | running
  showOnDashboard: boolean;
  lastRunAt?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastResult?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface AnsiblePlaybookFile {
  id: string;
  name: string;
  description?: string | null;
  content: string;
  tags?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnsibleInventory {
  id: string;
  clusterId: string;
  name: string;
  description?: string | null;
  content: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookRunResult {
  id: string;
  status: string;
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stats?: Record<string, any>;
  durationMs: number;
}

/** Playbook 실행 시 휘발성으로 전달되는 SSH 자격증명 — 서버에 저장되지 않음. */
export interface PlaybookSshCreds {
  ssh_username?: string;
  ssh_password?: string;
  ssh_private_key?: string;
  ssh_port?: number;
  become?: boolean;
  become_password?: string;
}

// AI Agent
export interface AgentChatRequest {
  query: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context?: Record<string, any>;
}

export interface AgentChatResponse {
  status: 'ok' | 'offline';
  answer: string;
  model: string;
  conversationId?: string | null;
  citations?: RagCitation[];
  requests?: AgentInfoRequest[];
}

/** RAG 근거 인용 — 백엔드 rag_service.Citation */
export interface RagCitation {
  title: string;
  sourceType: 'work_guide' | 'work_item' | 'ops_note' | 'ontology_event';
  refId: string;
  route: string;
  snippet: string;
  similarity: number;
}

/** AI 의 추가 정보 요청 (운영자가 제공 — 자율 실행 아님) */
export interface AgentInfoRequest {
  kind: 'github_code' | 'troubleshooting_history' | 'logs' | 'config';
  detail: string;
}

export interface AgentConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMessageOut {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: RagCitation[];
  requests: AgentInfoRequest[];
  model: string | null;
  createdAt: string;
}

export interface AgentHealthResponse {
  status: 'online' | 'offline';
  detail?: string;
}

// PromQL Metric Card
export interface MetricCard {
  id: string;
  title: string;
  description?: string;
  icon: string;
  promql: string;
  unit: string;
  displayType: 'value' | 'gauge' | 'list';
  category: string;
  thresholds?: string;  // "warning:70,critical:90"
  grafanaPanelUrl?: string;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Projects ──────────────────────────────────────────────────────────────────
export type ProjectStatus = 'active' | 'completed' | 'paused';

export interface Project {
  id: string;
  name: string;
  description?: string;
  goal?: string;
  color: string;
  startDate?: string;
  endDate?: string;
  status: ProjectStatus;
  totalItems: number;
  doneItems: number;
  achievementRate: number;
  assignees: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectCreate {
  name: string;
  description?: string;
  goal?: string;
  color?: string;
  startDate?: string;
  endDate?: string;
  status?: ProjectStatus;
}

export interface ProjectUpdate extends Partial<ProjectCreate> {}

export interface ProjectListResponse {
  data: Project[];
  total: number;
}

// ── Sprint (반복/iteration) ────────────────────────────────────────────────
export type SprintStatus = 'planning' | 'active' | 'completed';

export interface Sprint {
  id: string;
  name: string;
  goal?: string;
  jiraNo?: string;
  confluenceLink?: string;
  startDate: string;
  endDate: string;
  status: SprintStatus;
  totalItems: number;
  doneItems: number;
  achievementRate: number;
  totalEffortHours: number;
  assignees: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SprintCreate {
  name: string;
  goal?: string;
  jiraNo?: string;
  confluenceLink?: string;
  startDate: string;
  endDate: string;
  status?: SprintStatus;
}

export interface SprintUpdate extends Partial<SprintCreate> {}

export interface SprintListResponse {
  data: Sprint[];
  total: number;
}

// Work Item Board — 업무 통합 모델. 선택 가능한 유형(라벨)은 이슈 대응(issue)/회의(meeting)/
// 운영 대응(task)/기타(etc) 4종 — 값은 하위 호환을 위해 유지, 라벨만 workItemKanbanUtils.ts
// WORK_ITEM_TYPE_CONFIG 에서 재정의했다. training(구 "교육")은 과거 데이터 호환용으로만 남음.
export type WorkItemType = 'task' | 'issue' | 'meeting' | 'training' | 'etc' | 'build_response';
export type KanbanStatus = 'backlog' | 'todo' | 'in_progress' | 'review_test' | 'done';
export type WorkItemModule = 'k8s' | 'keycloak' | 'nexus' | 'cilium' | 'argocd' | 'jenkins' | 'backend' | 'frontend' | 'monitoring' | 'infra';
export type WorkItemTypeLabel = 'feature' | 'bug' | 'chore' | 'docs' | 'security';

export interface WorkItem {
  id: string;
  /** 업무 유형 디스크리미네이터 (task/issue/meeting/training/etc). 생성 시 결정, 변경 불가. */
  type: WorkItemType;
  assignee: string;
  primaryAssignee: string;
  secondaryAssignee?: string;
  clusterId?: string;
  clusterName?: string;
  /** 다중 대상 클러스터 — 같은 업무를 여러 클러스터에서 수행할 때. clusterId 는 대표(첫 번째). */
  clusterIds?: string[];
  clusterNames?: string[];
  /** 소속 프로젝트 ID (nullable). */
  projectId?: string;
  /** 소속 스프린트 ID (nullable). */
  sprintId?: string;
  /** 짧은 제목 (선택). 미설정 시 content 텍스트를 제목으로 표시. */
  title?: string;
  /** 분류/도메인 라벨. issue 의 issue_area / task 의 task_category 통합. */
  category: string;
  /** 본문 (rich HTML). issue 의 issue_content / task 의 task_content 통합. */
  content: string;
  /** 조치 내용 / 작업 결과. issue 의 action_content / task 의 result_content 통합. */
  resolution?: string;
  /** Issue 전용 상세 설명. task 에서는 보통 미사용. */
  detailContent?: string;
  /** 시작/발생/예정 일시. issue 의 occurred_at / task 의 scheduled_at 통합. */
  startedAt: string;
  /** 종료/해결/완료 일시. issue 의 resolved_at / task 의 completed_at 통합. */
  closedAt?: string;
  /** 마감일 — Jira 연동 업무는 duedate 동기화(가져올 때마다 갱신), 미연동 업무는 직접 편집. */
  dueDate?: string | null;
  remarks?: string;
  /** 통합지식 service tag — PEP 서비스 타입(LakeServiceType domain='pep') 의 slug 와 매칭. */
  service?: string;
  /** Phase B — service 하위 component (예: k8s→api-server). serviceCatalog.ts 의
   *  COMPONENT_BY_SERVICE 추천 enum + 직접 입력 escape hatch. service 없을 때 null. */
  component?: string;
  /** Confluence 문서 링크 (운영 페이지) */
  confluenceUrl?: string;
  /** 연결된 Confluence 페이지 ID — 프로비저닝/연동으로만 세팅되는 읽기 전용(동기화 대상 식별용). */
  confluencePageId?: string | null;
  /** 마지막으로 PEP → Confluence 반영(동기화)한 시각. */
  confluenceSyncedAt?: string | null;
  /** Jira 이슈의 원격 링크에서 찾은 Confluence 페이지 전체 목록(복수) — confluenceUrl(단일,
   *  대표)과 별개. Jira 동기화로만 채워지는 읽기 전용. */
  confluenceLinks?: { url: string; title?: string }[] | null;
  priority: 'high' | 'medium' | 'low';
  kanbanStatus: KanbanStatus;
  module?: WorkItemModule;
  typeLabel?: WorkItemTypeLabel;
  effortHours?: number;
  doneCondition?: string;
  parentId?: string;
  /** 연결된 다른 work item (예: bug 작업이 참조하는 issue) — 기존 task.issue_id 의 후속. */
  relatedWorkItemId?: string;
  subtasks?: WorkItem[];
  /** 등록자(생성자) username — 담당자가 아니어도 본인이 등록한 항목은 수정/삭제 가능. 구버전 데이터는 null. */
  createdBy?: string;
  /** 사용자 정의 필드 값 {fieldKey: value} */
  customValues?: Record<string, unknown> | null;
  /** 공통업무(파트 회의 등, 특정 개인 담당자 업무가 아님) — true 면 모든 사용자의 개인 일정(Work To Do)에 표시. */
  allAttendees?: boolean;
  /** Jira 연동 — 가져온 이슈 linkage (없으면 일반 work item). */
  jiraIssueKey?: string | null;
  jiraUrl?: string | null;
  jiraStatus?: string | null;
  jiraSyncedAt?: string | null;
  jiraWatchers?: string[] | null;
  /** Jira 원본 항목 — 게시판 표를 Jira 와 같은 축으로 보여주기 위한 읽기 전용 필드.
   *  task = Epic, sub task = Epic 아래 이슈 매핑 기준. */
  jiraIssueType?: string | null;
  /** status.statusCategory.key — new | indeterminate | done (상태 배지 색 기준). */
  jiraStatusCategory?: string | null;
  jiraEpic?: string | null;
  jiraEpicKey?: string | null;
  jiraEpicSummary?: string | null;
  jiraParentKey?: string | null;
  jiraParentSummary?: string | null;
  jiraComponents?: string[] | null;
  jiraLabels?: string[] | null;
  /** 프로비저닝(Jira+Confluence 동시 생성) 마지막 시도 결과 — null 이면 시도한 적
   *  없음(가져오기/수동 등록 등). 'partial' 이면 한쪽만 생성돼 재시도가 필요하다. */
  provisionStatus?: 'ok' | 'partial' | 'error' | null;
  provisionJiraError?: string | null;
  provisionConfluenceError?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Jira 연동 ──────────────────────────────────────────────────────────────────
export interface JiraConfig {
  baseUrl: string;
  enabled: boolean;
  verifyTls: boolean;
  defaultProjectKey?: string | null;
  /** 같은 IdP 로 SSO 연동되는 Confluence Base URL — 설정 시 SSO 로그인이 두 세션을 한 번에 캡처. */
  confluenceBaseUrl?: string;
  /** IdP 로그인 페이지 URL (선택) — 자동 탐색 실패 시 SSO 로그인의 진입점으로 사용. */
  ssoLoginUrl?: string;
  /** IdP 로그인 폼의 계정 필드명 (선택) — 자동 추정이 빗나갈 때 지정 (예: empnum). */
  ssoUsernameField?: string;
  /** Jira Epic Link 커스텀 필드 ID (예: customfield_10008) — 진척률의 Epic 축. */
  jiraEpicField?: string;
}

/** SSO 진단 — 백엔드(파드)가 각 진입 경로에서 실제로 본 페이지 요약. */
export interface SsoDiagnoseEntry {
  product: string;
  url: string;
  finalUrl: string;
  httpStatus?: number | null;
  contentType: string;
  title: string;
  forms: number;
  passwordInputs: number;
  /** 이 페이지에서 계정을 채울 필드명. */
  usernameField?: string;
  /** 자격을 base64 로 보내야 하는 폼인지 (OpenAM `encoded=true`). */
  wantsBase64?: boolean;
  /** 로그인 폼 action / 전체 필드(name:type) / 로드 스크립트 / 클라이언트 암호화 흔적. */
  loginFormAction?: string;
  loginFields?: string[];
  scripts?: string[];
  cryptoHints?: string[];
  inputNames: string[];
  /** 폼의 hidden 상태값 (예: OpenAM `encoded=true`). */
  hiddenFields?: Record<string, string>;
  clientRedirect: string;
  wwwAuthenticate: string;
  error: string;
}

export interface SsoDiagnoseResult {
  ok: boolean;
  detail: string;
  entries: SsoDiagnoseEntry[];
  /** 이 파드가 대상으로 나갈 때의 출발지 IP/호스트명 (SSO 가 클라이언트 IP 를 검사할 때 필요). */
  podHostname?: string;
  podSourceIp?: string;
}

// 인증 방식: 'pat'(PAT → Bearer) | 'cookie'(수동 붙여넣은 세션 쿠키) | 'sso'(SSO 자동 캡처 쿠키).
export type JiraAuthType = 'pat' | 'cookie' | 'sso';

export interface JiraSsoLoginResult {
  ok: boolean;
  detail: string;
  jiraAccount?: string | null;
  displayName?: string | null;
  /** Confluence 동시 로그인 결과 — null/undefined 면 Confluence 미설정(시도 안 함). */
  confluenceOk?: boolean | null;
  confluenceDetail?: string;
}

export interface JiraCredentialStatus {
  configured: boolean;
  authType: JiraAuthType;
  jiraAccount?: string | null;
  lastVerifiedAt?: string | null;
  /** 파드 내 SSO 폼 자동 로그인용 로그인 정보 저장 여부 (원클릭 재로그인 가능). */
  hasSsoLogin?: boolean;
  /** SSO 로그인이 캡처한 Confluence 세션 저장 여부. */
  hasConfluence?: boolean;
}

/** 파드 내 SSO 폼 자동 로그인 요청 — 생략 시 서버측 브라우저(헤디드) 경로. */
export interface JiraSsoLoginRequest {
  username?: string;
  password?: string;
  saveLogin?: boolean;
  useSaved?: boolean;
}

export interface JiraTestResult {
  ok: boolean;
  detail: string;
  displayName?: string | null;
}

export interface JiraImportRequest {
  scope: 'me' | 'project' | 'jql' | 'filter';
  projectKey?: string;
  jql?: string;
  /** scope='filter' 조건 — 비운 항목은 무시되고 나머지가 AND 로 묶인다. */
  labels?: string[];
  components?: string[];
  statuses?: string[];
  assignee?: string;
  updatedSinceDays?: number | null;
  /** 미리보기에서 고른 Jira 키만 반영 (비우면 전체). */
  onlyKeys?: string[];
  dryRun?: boolean;
}

export interface JiraFieldChange {
  field: string;
  label: string;
  old: string;
  new: string;
}

export interface JiraImportItemPreview {
  jiraKey: string;
  title: string;
  kanbanStatus: string;
  action: 'create' | 'update' | 'unchanged';
  /** 재가져오기 시 바뀌는 필드 목록 (확인 팝업용). */
  changes?: JiraFieldChange[];
}

// ── PEP → Jira 생성/삭제 ──────────────────────────────────────────────────────
export interface JiraCreateRequest {
  workItemId?: string;
  projectKey?: string;
  summary?: string;
  description?: string;
  issueType?: string;
  priority?: string;
  labels?: string[];
  components?: string[];
}

export interface JiraCreateResult {
  status: 'ok' | 'error' | 'offline';
  detail: string;
  jiraKey?: string | null;
  jiraUrl?: string | null;
  linkedWorkItemId?: string | null;
}

export interface JiraDeleteResult {
  status: 'ok' | 'error' | 'offline';
  detail: string;
  unlinkedWorkItemId?: string | null;
}

// ── 연결 복구 (해제 / 갈아끼우기 / 고아 점검) ──────────────────────────────────
// Jira 이슈를 직접 지웠거나 잘못된 프로젝트에 만들었을 때, PEP 에 남은 죽은 링크를
// 화면에서 정리하기 위한 타입들. Jira 쪽은 건드리지 않는다.
export interface JiraUnlinkRequest {
  /** true 면 업무 행 자체도 삭제 (권한은 업무 삭제와 동일 규칙). */
  deleteWorkItem?: boolean;
}

export interface JiraUnlinkResult {
  status: 'ok' | 'error';
  detail: string;
  workItemId?: string | null;
  workItemDeleted: boolean;
}

export interface JiraRelinkRequest {
  /** 이슈 키(DL-42) 또는 브라우저 URL(.../browse/DL-42). */
  keyOrUrl: string;
}

export interface JiraRelinkResult {
  status: 'ok' | 'error' | 'offline' | 'missing';
  detail: string;
  jiraKey?: string | null;
  jiraUrl?: string | null;
}

export interface JiraMissingLink {
  workItemId: string;
  jiraKey: string;
  title: string;
  detail: string;
}

export interface JiraVerifyLinksResult {
  status: 'ok' | 'error' | 'offline';
  detail: string;
  checked: number;
  missing: JiraMissingLink[];
  truncated: boolean;
}

// ── 주간보고 ──────────────────────────────────────────────────────────────────
export interface WeeklySummary {
  total: number;
  inProgress: number;
  done: number;
  delayed: number;
  note: string;
}

export interface WeeklyDetailRow {
  component: string;
  /** task = Jira Epic, subTask = 그 Epic 아래 이슈(현재 행). */
  task: string;
  epicKey?: string;
  epicName?: string;
  epicUrl?: string;
  subTask: string;
  start: string;
  due: string;
  closed: string;
  status: string;
  issue: string;
  note: string;
  jiraKey: string;
  jiraUrl: string;
}

export interface WeeklyOwnerRow {
  task: string;
  assignee: string;
  mainWork: string;
  issueSummary: string;
}

export interface WeeklyProgressRow {
  category: string;
  epic: string;
  epicKey?: string;
  epicName?: string;
  epicUrl?: string;
  plannedRate: number;
  actualRate: number;
  achievementRate: number;
  doneCount: number;
  inProgressCount: number;
  totalCount: number;
}

export interface WeeklyReport {
  periodStart: string;
  periodEnd: string;
  title: string;
  summary: WeeklySummary;
  progress: WeeklyProgressRow[];
  details: WeeklyDetailRow[];
  owners: WeeklyOwnerRow[];
}

export interface WeeklyReportRequest {
  weekOf?: string;
  projectFilter?: string;
}

export interface WeeklyPublishRequest extends WeeklyReportRequest {
  spaceKey?: string;
  parentPageId?: string;
  title?: string;
}

export interface WeeklyPublishResult {
  status: 'ok' | 'error' | 'offline';
  detail: string;
  action: string;
  pageUrl?: string | null;
  pageId?: string | null;
}

export interface WeeklyReportSettings {
  /** Jira WBS/간트 차트 링크 — 진척률 표 위에 노출. */
  ganttUrl: string;
  spaceKey: string;
  parentPageId: string;
  titleTemplate: string;
  autoEnabled: boolean;
  autoCron: string;
  projectFilter: string;
}

export interface JiraImportResult {
  /** missing — 연결된 이슈를 Jira 에서 찾을 수 없음(삭제됐거나 권한 없음). 자동 정리하지
   *  않고 화면에서 연결 해제/변경을 고르게 한다. */
  status: 'ok' | 'offline' | 'error' | 'missing';
  /** 실제로 Jira 에 보낸 JQL — 조건 반영 여부를 화면에서 확인. */
  appliedJql?: string;
  imported: number;
  updated: number;
  skipped: number;
  total: number;
  truncated: boolean;
  dryRun: boolean;
  detail: string;
  errors: string[];
  items: JiraImportItemPreview[];
}

// Jira 에서 추출한 Excel(.xlsx) 가져오기 — 미리보기(저장 없음) + "저장" 시 업무 관리
// 게시판(work_items)에 매핑 저장(jiraApi.importSaveToBoard, 응답은 JiraImportResult 재사용).
export interface JiraExcelRow {
  key: string;
  jiraUrl?: string | null;
  summary: string;
  issueType: string;
  status: string;
  assigneeRaw: string;
  assigneeName?: string | null;
  assigneeMatched: boolean;
  created: string;
  resolved: string;
  dueDate: string;
  environment: string;
  description: string;
}

export interface JiraExcelImportResult {
  status: 'ok' | 'error';
  detail: string;
  total: number;
  matched: number;
  rows: JiraExcelRow[];
}

export interface JiraPushRequest {
  comment?: string;
  force?: boolean;
  pushFields?: boolean;   // 제목/설명/우선순위 반영 여부 (기본 true)
}

export interface JiraPushResult {
  status: 'ok' | 'conflict' | 'error' | 'offline' | 'not_linked';
  detail: string;
  transitioned: boolean;
  commentAdded: boolean;
  fieldsUpdated: string[];   // 실제 반영된 필드명 (summary/description/priority)
  fieldErrors: string[];     // 반영 실패 사유
  jiraStatus?: string | null;
  availableTransitions: string[];
}

// ── Confluence 연동 (업무 관리 게시판, "Jira 가져오기"와 동일한 검색→선택→반영 패턴) ──────
export interface ConfluenceSearchItem {
  id: string;
  title: string;
  type?: string;
  spaceKey?: string;
  url: string;
  updated?: string;
}

export interface ConfluenceSearchResult {
  status: 'ok' | 'offline' | 'error';
  detail: string;
  total: number;
  items: ConfluenceSearchItem[];
}

export interface ConfluenceLinkRequest {
  pageId: string;
  title: string;
  url: string;
}

export interface ConfluenceSyncResult {
  status: 'ok' | 'error' | 'offline' | 'not_linked';
  detail: string;
  confluenceUrl?: string | null;
  syncedAt?: string | null;
}

export interface WorkItemComment {
  id: string;
  workItemId: string;
  author?: string;
  authorName?: string;
  body: string;
  createdAt: string;
}

export interface WorkItemActivity {
  id: string;
  action: string;
  actor: string;
  // 백엔드 details(JSONB) — 응답 인터셉터가 camelCase 로 변환(changedFields, from, to 등)
  details?: Record<string, unknown> | null;
  createdAt: string;
}

export interface UserNotification {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  link?: string | null;
  workItemId?: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface WorkItemListResponse {
  data: WorkItem[];
  total: number;
}

export interface WorkItemStatusResponse {
  data: WorkItem;
  wipWarning: boolean;
}

export interface WorkItemCreate {
  type: WorkItemType;
  assignee: string;
  primaryAssignee: string;
  secondaryAssignee?: string;
  clusterId?: string;
  clusterName?: string;
  clusterIds?: string[];
  customValues?: Record<string, unknown> | null;
  projectId?: string;
  sprintId?: string | null;
  title?: string;
  category: string;
  content: string;
  resolution?: string;
  detailContent?: string;
  startedAt: string;
  closedAt?: string | null;
  dueDate?: string | null;
  remarks?: string;
  service?: string;
  component?: string;
  /** null 을 명시적으로 보내면 링크 해제 (백엔드는 exclude_unset 이라 undefined 는 무변경). */
  confluenceUrl?: string | null;
  jiraUrl?: string;
  priority?: string;
  kanbanStatus?: KanbanStatus;
  module?: WorkItemModule;
  typeLabel?: WorkItemTypeLabel;
  effortHours?: number;
  doneCondition?: string;
  parentId?: string;
  relatedWorkItemId?: string;
  /** 공통업무(파트 회의 등, 특정 개인 담당자 업무가 아님) — true 면 모든 사용자의 개인 일정(Work To Do)에 표시. */
  allAttendees?: boolean;
}

export interface WorkItemUpdate extends Partial<Omit<WorkItemCreate, 'type'>> {}

/** 업무의 날짜별 시간 블록 — startedAt~closedAt 기간 안의 실제 작업 시간대. */
export interface WorkItemTimeBlock {
  id: string;
  workItemId: string;
  blockDate: string;     // YYYY-MM-DD (로컬 날짜)
  startMinute: number;   // 자정 기준 분 (0..1439)
  endMinute: number;     // 자정 기준 분 (> startMinute, ..1440)
  note?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MetricQueryResult {
  cardId: string;
  status: 'ok' | 'error' | 'offline';
  value?: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  labels?: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  results?: Array<Record<string, any>> | null;
  error?: string | null;
}

export interface MetricSparklinePoint {
  ts: number;
  value: number;
}

export interface MetricSparklineResult {
  cardId: string;
  status: 'ok' | 'error' | 'offline';
  points: MetricSparklinePoint[];
  error?: string | null;
}

// ── Cluster Items (현황 관리 대시보드 '아이템' 카드) ─────────────────────
export type ClusterItemSource = 'manual' | 'auto' | 'ai';
export type ClusterItemCardSize = 'sm' | 'md' | 'lg';

export interface ClusterItem {
  id: string;
  clusterId: string;
  itemType: string;            // 'node_count' | (확장)
  title: string;
  icon?: string | null;
  description?: string | null;
  tier: 'basic' | 'advanced';
  isBuiltin: boolean;
  sourceMode: ClusterItemSource;
  autoEnabled: boolean;
  scheduleHour: number;
  scheduleMinute: number;
  cardSize: ClusterItemCardSize;
  unit?: string | null;
  sortOrder: number;
  enabled: boolean;
  currentValue?: number | null;
  currentText?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resultDetail?: Record<string, any> | null;
  resultStatus?: 'healthy' | 'warning' | 'critical' | 'info' | null;
  lastStatus?: 'ok' | 'error' | 'pending' | null;
  lastError?: string | null;
  lastCheckedAt?: string | null;
  lastSource?: ClusterItemSource | null;
  previousValue?: number | null;
  previousText?: string | null;
  lastChangedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// '아이템 추가' 선택지 메타데이터 (GET /cluster-item-types)
export interface ClusterItemType {
  itemType: string;
  label: string;
  icon: string;
  unit: string;
  description: string;
  valueKind: 'number' | 'text';
  defaultSource: ClusterItemSource;
  defaultScheduleHour: number;
  builtin: boolean;
  supportedSources: ClusterItemSource[];
}

export interface UiSettings {
  appTitle: string;
  navLabels: Record<string, string>;
  /** 홈(좌상단) 버튼 아이콘 커스터마이즈 (모드별). 값 형식은 cluster icon 과 동일
   *  (lucide 이름 / 이모지 / base64 data URL). null/undefined 면 기본값(업무=ListTodo, 플랫폼=☸). */
  homeIcons?: HomeIcons;
  /** 페이지(라우트)별 화면 스타일 오버라이드. 키 '__default__' 는 전 페이지 공통 기본값,
   *  그 외는 라우트 경로('/path'). 설정된 필드만 적용되고 나머지는 default→테마 폴백. */
  pageStyles?: Record<string, PageStyle>;
}

/** 페이지별 화면 스타일 오버라이드 — 모든 필드 optional. */
export interface PageStyle {
  /** CSS font-family 값 (예: 'Georgia, serif'). 미지정이면 테마 기본 폰트. */
  fontFamily?: string;
  /** 본문 영역 확대 배율 (0.8~1.5). 1/미지정이면 기본 크기. */
  fontScale?: number;
  /** 글자색 hex (#RRGGBB). */
  textColor?: string;
  /** 배경색 hex (#RRGGBB). */
  bgColor?: string;
}

export interface HomeIcons {
  work?: string | null;
  platform?: string | null;
}

export interface OperationLevelItem {
  value: string;
  label: string;
  /** tailwind 컬러 키 — red/amber/emerald/sky/slate/purple/blue/yellow/pink/cyan/violet/orange/muted.
   *  customHex 가 있으면 fallback 으로만 쓰인다. */
  color: string;
  /** 클러스터 카드/행 앞에 표시될 이모지 1자. 비어있으면 EMOJI_OPTIONS 의 fallback 사용. */
  icon?: string;
  /** 프리셋 13색 대신 임의의 hex(#RRGGBB) 를 시드로 bg/ring/band/text 톤을 자동 산출할 때 지정. */
  customHex?: string | null;
}

// Workflow Board — 큰 작업을 단계별로 시각화하는 기획 게시판.
// (실행엔진이 아니라 진행 추적용. 상태는 todo/in-progress/blocked/done/skipped.)
export type WorkflowStepType = 'trigger' | 'action' | 'condition' | 'wait' | 'notification';
export type WorkflowStepStatus = 'todo' | 'in-progress' | 'blocked' | 'done' | 'skipped';

export interface WorkflowStep {
  id: string;
  workflowId: string;
  title: string;
  description?: string;
  completed: boolean;
  stepType: WorkflowStepType;
  status: WorkflowStepStatus;
  posX: number;
  posY: number;
  orderIndex: number;
  referenceType?: string;  // cluster / playbook / issue / task / work_guide / metric_card
  referenceId?: string;    // 참조 항목의 UUID
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEdge {
  id: string;
  workflowId: string;
  sourceStepId: string;
  targetStepId: string;
  createdAt: string;
}

export interface Workflow {
  id: string;
  title: string;
  description?: string;
  /** 관련 Confluence 문서 링크 (선택) */
  confluenceUrl?: string;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowListResponse {
  data: Workflow[];
}

export interface WorkflowCreate {
  title: string;
  description?: string;
  confluenceUrl?: string;
}

export interface WorkflowUpdate {
  title?: string;
  description?: string;
  confluenceUrl?: string;
}

export interface WorkflowStepCreate {
  title: string;
  description?: string;
  completed?: boolean;
  stepType?: WorkflowStepType;
  status?: WorkflowStepStatus;
  posX?: number;
  posY?: number;
  orderIndex?: number;
  referenceType?: string;
  referenceId?: string;
}

export interface WorkflowStepUpdate {
  title?: string;
  description?: string;
  completed?: boolean;
  stepType?: WorkflowStepType;
  status?: WorkflowStepStatus;
  posX?: number;
  posY?: number;
  orderIndex?: number;
  referenceType?: string;
  referenceId?: string;
}

export interface WorkflowEdgeCreate {
  sourceStepId: string;
  targetStepId: string;
}

// Work Guide Board (Confluence-style)
export interface WorkGuide {
  id: string;
  parentId?: string | null;
  title: string;
  content?: string;
  category?: string;   // 배포 / 트러블슈팅 / 모니터링 / 보안 / 기타
  priority: string;    // high / medium / low
  tags?: string;       // 쉼표 구분
  status: string;      // draft / active / archived
  author?: string;
  sortOrder: number;
  /** Confluence 문서 링크 */
  confluenceUrl?: string;
  /** 최초 생성 출처 — pep | confluence */
  source?: string;
  /** 연결된 Confluence 페이지 ID (import/export 매칭 키) */
  confluencePageId?: string | null;
  confluenceSpaceKey?: string | null;
  /** 마지막 동기화 시점의 Confluence 페이지 버전 */
  confluenceVersion?: number | null;
  confluenceSyncedAt?: string | null;
  /** synced(동일) / modified(PEP 수정 후 미게시) / error(동기화 실패) — 미연결이면 null */
  confluenceSyncStatus?: 'synced' | 'modified' | 'error' | null;
  confluenceSyncError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkGuideCreate {
  title: string;
  content?: string;
  category?: string;
  priority?: string;
  tags?: string;
  status?: string;
  author?: string;
  parentId?: string | null;
  sortOrder?: number;
  confluenceUrl?: string;
}

export interface WorkGuideUpdate extends Partial<WorkGuideCreate> {}

export interface WorkGuideListResponse {
  data: WorkGuide[];
}

// ── Confluence 문서 가져오기/내보내기 (routers/confluence.py) ──
export interface ConfluenceDocSearchRequest {
  cql?: string;
  spaceKey?: string;
  text?: string;
  /** 문서 제목만 좁혀 검색 — text(제목+본문 통합 검색)와 별개 축. */
  title?: string;
  /** 상위 페이지 ID(Confluence ancestor) — 특정 트리 하위만 검색 범위로 좁힌다. */
  ancestorId?: string;
  /** 기여자 조건 — me: 본인(기본값) · user: contributor 값 사용(콤마로 여러 명) · any: 조건 없음 */
  contributorMode?: 'me' | 'user' | 'any';
  contributor?: string;
  labels?: string[];
  updatedSinceDays?: number;
  limit?: number;
}

export interface ConfluenceDocSearchItem {
  id: string;
  title: string;
  spaceKey: string;
  url: string;
  updated: string;
  /** 이미 work_guides 에 연결된 페이지인지 */
  linked: boolean;
  linkedGuideId?: string | null;
}

export interface ConfluenceDocSearchResult {
  status: string;
  detail: string;
  total: number;
  items: ConfluenceDocSearchItem[];
}

export interface ConfluenceDocImportRequest {
  pageIds: string[];
  dryRun?: boolean;
  onlyPageIds?: string[];
  parentGuideId?: string | null;
  category?: string;
  guideStatus?: string;
  inlineImages?: boolean;
}

export interface ConfluenceDocFieldChange {
  field: string;
  old?: string | null;
  new?: string | null;
}

export interface ConfluenceDocImportPreview {
  pageId: string;
  title: string;
  spaceKey: string;
  version?: number | null;
  action: 'create' | 'update' | 'unchanged' | 'error';
  detail: string;
  warnings: string[];
  changes: ConfluenceDocFieldChange[];
}

export interface ConfluenceDocImportResult {
  status: string;
  detail: string;
  dryRun: boolean;
  imported: number;
  updated: number;
  skipped: number;
  errors: string[];
  warnings: string[];
  items: ConfluenceDocImportPreview[];
}

export interface ConfluenceDocExportRequest {
  spaceKey?: string;
  parentPageId?: string;
  title?: string;
}

export interface ConfluenceDocExportResult {
  status: string;
  detail: string;
  action: string;
  pageId?: string | null;
  pageUrl?: string | null;
  version?: number | null;
  warnings: string[];
}

export interface ConfluenceDocPullResult {
  status: string;
  detail: string;
  guideId?: string | null;
  version?: number | null;
  warnings: string[];
}

export interface ConfluenceDocsSettings {
  spaceKey: string;
  parentPageId: string;
  defaultCategory: string;
  titlePrefix: string;
}

export interface GuideSearchItem {
  id: string;
  title: string;
  category?: string | null;
  status: string;
  author?: string | null;
  source: string;
  confluenceUrl?: string | null;
  updatedAt: string;
  /** 시맨틱 검색일 때만 존재 (0~1) */
  similarity?: number | null;
  snippet: string;
}

export interface GuideSearchResult {
  items: GuideSearchItem[];
  /** false = 시맨틱 미준비(Ollama/pgvector) — ILIKE 폴백 결과 */
  embeddingAvailable: boolean;
}

export interface ClusterLink {
  id: string;
  label: string;
  url: string;
  description?: string;
}

export interface ClusterLinkGroup {
  clusterId: string;
  clusterName: string;
  links: ClusterLink[];
}

export interface ClusterLinksPayload {
  commonLinks: ClusterLink[];
  clusterGroups: ClusterLinkGroup[];
}

// Ops Notes (업무 게시판)
export type OpsNoteColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';

export interface OpsNote {
  id: string;
  service: string;
  title: string;
  content?: string;
  backContent?: string;
  color: OpsNoteColor;
  author?: string;
  pinned: boolean;
  /** Confluence 문서 링크 */
  confluenceUrl?: string;
  /** DL(Data Lake 등) 참고 링크 */
  dlUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpsNoteCreate {
  service: string;
  title: string;
  content?: string;
  backContent?: string;
  color: OpsNoteColor;
  author?: string;
  pinned?: boolean;
  confluenceUrl?: string;
  dlUrl?: string;
}

export interface OpsNoteUpdate extends Partial<OpsNoteCreate> {}

export interface OpsNoteListResponse {
  data: OpsNote[];
  total: number;
}

// ── 사용자 VOC 게시판 ────────────────────────────────────────────────────────
export type VocCategory = '문의' | '개선' | '불만' | '제안';
export type VocStatus = '접수' | '검토중' | '완료';

export interface VocPost {
  id: string;
  title: string;
  content?: string;
  category: VocCategory;
  status: VocStatus;
  author?: string;
  createdBy?: string;
  adminReply?: string | null;
  adminReplyBy?: string | null;
  adminReplyAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VocCreate {
  title: string;
  content?: string;
  category: VocCategory;
}

export interface VocUpdate {
  title?: string;
  content?: string;
  category?: VocCategory;
}

export interface VocReply {
  adminReply?: string;
  status?: VocStatus;
}

export interface VocListResponse {
  data: VocPost[];
  total: number;
}

// Mind Map
export interface MindMapNode {
  id: string;
  mindmapId: string;
  parentId?: string | null;
  label: string;
  note?: string;
  color?: string;
  x?: number;
  y?: number;
  collapsed: boolean;
  sortOrder: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface MindMap {
  id: string;
  title: string;
  description?: string;
  /** 관련 Confluence 문서 링크 (선택) */
  confluenceUrl?: string;
  nodes: MindMapNode[];
  createdAt: string;
  updatedAt: string;
}

export interface MindMapListItem {
  id: string;
  title: string;
  description?: string;
  confluenceUrl?: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MindMapCreate {
  title: string;
  description?: string;
  confluenceUrl?: string;
}

export interface MindMapUpdate {
  title?: string;
  description?: string;
  confluenceUrl?: string;
}

export interface MindMapNodeCreate {
  mindmapId: string;
  parentId?: string | null;
  label: string;
  note?: string;
  color?: string;
  x?: number;
  y?: number;
  collapsed?: boolean;
  sortOrder?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>;
}

// 기능별 접근 제어 — { "<라우트 경로>": { roles, users, enabled? } }
export interface FeatureAccessRule {
  roles: string[];
  users: string[];   // username 또는 display_name
  /** false 면 admin 외 전체 차단(roles/users 무관, 최우선). 미설정/true = 기본 열림. */
  enabled?: boolean;
}
export type FeatureAccessMap = Record<string, FeatureAccessRule>;

// Assignee (담당자)
export interface Assignee {
  name: string;
  employeeId?: string;
  email?: string;
  ip?: string;
  seatLocation?: string;
  primaryRole?: string;
  secondaryRole?: string;
}

/** 본인이 직접 수정할 수 있는 담당자 필드 (이름/사번은 admin 전용이라 제외). */
export type SelfAssigneePatch = Pick<Assignee, 'email' | 'ip' | 'seatLocation' | 'primaryRole' | 'secondaryRole'>;

// Management Server
export interface ManagementServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  serverType: string;  // jump_host / admin / monitoring / cicd / bastion
  description?: string;
  status: string;      // online / offline / unknown
  region?: string;
  tags?: string;
  osInfo?: string;
  lastChecked?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManagementServerCreate {
  name: string;
  host: string;
  port?: number;
  username?: string;
  serverType?: string;
  description?: string;
  region?: string;
  tags?: string;
  osInfo?: string;
}

export interface ManagementServerUpdate extends Partial<ManagementServerCreate> {}

export interface ManagementServerListResponse {
  data: ManagementServer[];
}

// ── Isilon NFS 모니터링 ──────────────────────────────────────────────────────
export interface IsilonServer {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  description?: string;
  status?: string;        // online / offline / unknown
  isDefault: boolean;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  lastChecked?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface IsilonServerCreate {
  name: string;
  host: string;
  port?: number;
  username?: string;
  description?: string;
  isDefault?: boolean;
  savedPassword?: string;
  savedPrivateKey?: string;
}

export interface IsilonServerUpdate extends Partial<IsilonServerCreate> {
  clearSavedPassword?: boolean;
  clearSavedPrivateKey?: boolean;
}

export type IsilonCommandSection =
  | 'exports' | 'nfs_settings' | 'quotas' | 'clients' | 'node_health' | 'custom';

export interface IsilonCommand {
  id: string;
  serverId?: string | null;   // null = 글로벌 기본
  key: string;
  label: string;
  section: IsilonCommandSection;
  command: string;
  parseMode: 'json' | 'text';
  timeoutSeconds: number;
  enabled: boolean;
  showOnOverview: boolean;
  sortOrder: number;
  isBuiltin: boolean;
}

export interface IsilonCommandCreate {
  serverId?: string | null;
  key: string;
  label: string;
  section?: IsilonCommandSection;
  command: string;
  parseMode?: 'json' | 'text';
  timeoutSeconds?: number;
  enabled?: boolean;
  showOnOverview?: boolean;
  sortOrder?: number;
}

export interface IsilonCommandUpdate {
  label?: string;
  section?: IsilonCommandSection;
  command?: string;
  parseMode?: 'json' | 'text';
  timeoutSeconds?: number;
  enabled?: boolean;
  showOnOverview?: boolean;
  sortOrder?: number;
}

export interface IsilonCommandResult {
  key: string;
  label: string;
  section: IsilonCommandSection;
  command: string;
  parseMode: 'json' | 'text';
  showOnOverview: boolean;
  ok: boolean;
  exitCode?: number | null;
  parsed?: unknown;
  raw?: string;
  error?: string | null;
  durationMs: number;
}

export interface IsilonK8sNfsPv {
  pv: string;
  server?: string | null;
  path: string;
  pvc?: string | null;
  phase?: string | null;
}

export interface IsilonNfsOverview {
  configured: boolean;
  message?: string;
  server?: { id: string; name: string; host: string };
  collectedAt?: string;
  fromCache?: boolean;
  connectionOk?: boolean;
  connectionError?: string | null;
  results?: IsilonCommandResult[];
  errors?: string[];
  k8sNfsPvs?: IsilonK8sNfsPv[];
}

/** mc 클라이언트 패턴 — 등록된 isi 명령 중 선택한 것만 온디맨드 실행한 결과(캐시 미사용). */
export interface IsilonRunResponse {
  server?: { id: string; name: string; host: string };
  executedAt?: string;
  connectionOk?: boolean;
  connectionError?: string | null;
  results?: IsilonCommandResult[];
  /** 등록/활성화되지 않아 실행에서 제외된 요청 키 */
  skippedKeys?: string[];
  k8sNfsPvs?: IsilonK8sNfsPv[];
}

export interface IsilonTestResult {
  ok: boolean;
  status: string;
  detail: string;
  durationMs: number;
}

// Infrastructure Nodes (물리 서버 노드)
export type InfraNodeRole = 'master' | 'worker' | 'storage' | 'infra';

export interface InfraNode {
  id: string;
  clusterId: string;
  hostname: string;
  rackName?: string;
  ipAddress?: string;
  role: InfraNodeRole;
  cpuCores?: number;
  ramGb?: number;
  diskGb?: number;
  osInfo?: string;
  switchName?: string;
  notes?: string;
  autoSynced: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface InfraNodeCreate {
  clusterId: string;
  hostname: string;
  rackName?: string;
  ipAddress?: string;
  role?: InfraNodeRole;
  cpuCores?: number;
  ramGb?: number;
  diskGb?: number;
  osInfo?: string;
  switchName?: string;
  notes?: string;
}

export interface InfraNodeUpdate extends Partial<Omit<InfraNodeCreate, 'clusterId'>> {
  version: number;
}

export interface InfraNodeListResponse {
  data: InfraNode[];
  total: number;
}

/** 노드 추가 검증(node_health) — 노드별 체크리스트 1건. (백엔드 details.nodes[i], camelCase) */
export interface NodeHealthEntry {
  node: string;
  ready: boolean;
  pressure: string[];
  taints: string[];
  allocatableOk: boolean;
  allocatable: { cpu?: string | null; memory?: string | null };
  networking: {
    cni: boolean;
    cniFamily: string | null;
    kubeProxy: boolean;
    present: string[];
    missing: string[];
  };
  ok: boolean;
}

/** 노드 추가 검증 결과 (per-node 검증 / sync 직후 자동검증 공용). */
export interface NodeVerifyResult {
  hostname: string;
  status: 'healthy' | 'warning' | 'critical' | 'pending' | 'error';
  message: string;
  ok: boolean;
  nodeId?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details: { nodes?: NodeHealthEntry[]; found?: boolean; scope?: string } & Record<string, any>;
  steps?: DeepCheckExecStep[];
  stepPlan?: DeepCheckStepPlanItem[];
  durationMs?: number;
}

export interface InfraSyncResult {
  success: boolean;
  created: number;
  updated: number;
  failed: number;
  retryCount: number;
  partialFailure: boolean;
  errors: string[];
  total: number;
  verifications?: NodeVerifyResult[];
  verifiedTruncated?: boolean;
}


export type TopologyTargetType = 'service' | 'pod';

export interface TopologyTraceRequest {
  clusterId: string;
  namespace: string;
  targetType: TopologyTargetType;
  targetName: string;
}

export interface TopologyTraceHop {
  entityType: string;
  entityId: string;
  name: string;
  interface?: string;
  latencyMs?: number;
  errorCount?: number;
}

export interface TopologyTraceResponse {
  clusterId: string;
  namespace: string;
  targetType: TopologyTargetType;
  targetName: string;
  hops: TopologyTraceHop[];
}

export type PacketProtocol = 'http' | 'https' | 'grpc' | 'tcp';

export interface PacketFlowRequest {
  clusterId: string;
  host: string;
  path?: string;
  protocol?: PacketProtocol;
}

export interface PacketFlowResponse {
  clusterId: string;
  host: string;
  path: string;
  protocol: string;
  hops: TopologyTraceHop[];
}

// ── Packet Flow v2 (정책 해석 + E-W 지원) ────────────────────────────────
export type PacketDirection = 'north-south' | 'east-west';
export type HopVerdict = 'allow' | 'deny' | 'warn' | 'info';

export interface HopPolicy {
  kind: string;             // "CiliumNetworkPolicy" | "CiliumClusterwideNetworkPolicy" | "NetworkPolicy"
  name: string;
  direction: 'ingress' | 'egress';
  summary: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  selectorLabels?: Record<string, any>;
}

export interface HopRef {
  kind: string;
  name: string;
  link?: string;
}

export interface TopologyTraceHopV2 {
  entityType: string;
  entityId: string;
  name: string;
  interface?: string | null;
  latencyMs?: number | null;
  errorCount?: number | null;
  verdict: HopVerdict;
  notes: string[];
  policies: HopPolicy[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  identity?: Record<string, any> | null;
  refs: HopRef[];
}

export interface PacketFlowRequestV2 {
  clusterId: string;
  direction: PacketDirection;
  source: string;
  destination: string;
  protocol?: 'tcp' | 'udp' | 'http' | 'https' | 'grpc';
  port?: number;
  path?: string;
}

export interface PacketFlowResponseV2 {
  clusterId: string;
  direction: PacketDirection;
  source: string;
  destination: string;
  protocol: string;
  port?: number | null;
  path: string;
  hops: TopologyTraceHopV2[];
}

// ── Hubble flows ────────────────────────────────────────────────────────
export interface HubbleFlowsRequest {
  clusterId: string;
  fromPod?: string;
  toPod?: string;
  fromNamespace?: string;
  toNamespace?: string;
  toService?: string;
  protocol?: string;
  verdict?: string;
  sinceSeconds?: number;
  limit?: number;
  hubbleNamespace?: string;
  hubbleService?: string;
  hubblePort?: number;
}

export interface HubbleFlow {
  time?: string | null;
  verdict?: string | null;
  dropReason?: string | null;
  source: { namespace?: string | null; podName?: string | null; identity?: number | null; labels?: string[]; ip?: string | null };
  destination: { namespace?: string | null; podName?: string | null; identity?: number | null; labels?: string[]; ip?: string | null };
  l4: { protocol?: string; sourcePort?: number; destinationPort?: number; flags?: Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  l7?: Record<string, any> | null;
  trafficDirection: string;
  summary: string;
}

export interface HubbleFlowsResponse {
  clusterId: string;
  flows: HubbleFlow[];
  count: number;
  error?: string | null;
  executed?: string | null;
}

// ── etcd systemd 수집 ──────────────────────────────────────────────────
export interface EtcdSystemdCollectRequest {
  hosts: string[];
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  useSudo?: boolean;
  connectTimeout?: number;
  /** systemd unit 이름 (기본 etcd) — 백엔드가 systemctl show {unit} 에 사용 */
  unit?: string;
  envFiles?: string[];
  parallelism?: number;
  chunkSize?: number;
  chunkPauseMs?: number;
}

export interface EtcdSystemdPerHost {
  host: string;
  status: string;
  version?: string | null;
  activeState?: string | null;
  mainPid?: number | null;
  fragmentPath?: string | null;
  execStart?: string | null;
  endpointHealth?: string | null;
  error?: string | null;
  raw?: Record<string, string> | null;
  /** 실행-로그 규칙 — per-host 원본 stdout/stderr/exit code (axios 인터셉터가 camelCase 로 변환해 도착) */
  rawStdout?: string | null;
  rawStderr?: string | null;
  exitCode?: number | null;
}

export interface EtcdSystemdCollectResponse {
  clusterId: string;
  stored: boolean;
  changed: number;
  hosts: EtcdSystemdPerHost[];
  componentKey?: string;
  errors: string[];
}

// ── kubeadm 인증서 만료 수집 (Ops Checks cert_expiry 의 snapshot 경로용) ────────
export interface KubeadmCertsCollectRequest {
  hosts: string[];
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  useSudo?: boolean;
  connectTimeout?: number;
}

export interface KubeadmCertsPerHost {
  host: string;
  stored?: boolean;
  error?: string | null;
  /** 실행-로그 규칙 — per-host 원본 stdout/stderr/exit code (axios 인터셉터가 camelCase 로 변환해 도착) */
  rawStdout?: string | null;
  rawStderr?: string | null;
  exitCode?: number | null;
}

export interface KubeadmCertsCollectResponse {
  clusterId: string;
  changed: number;
  hosts: KubeadmCertsPerHost[];
  errors: string[];
}

// ── kernel params / etcdctl config 수집 ─────────────────────────────
export interface KernelParamsCollectRequest {
  hosts: string[];
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  useSudo?: boolean;
  connectTimeout?: number;
  params?: string[];
  defaultPrefixes?: string[];
  parallelism?: number;
  chunkSize?: number;
  chunkPauseMs?: number;
}

export interface KernelParamsPerHost {
  host: string;
  status: string;
  paramCount?: number;
  stored?: boolean;
  error?: string | null;
  /** 실행-로그 규칙 — per-host 원본 stdout/stderr/exit code (axios 인터셉터가 camelCase 로 변환해 도착) */
  rawStdout?: string | null;
  rawStderr?: string | null;
  exitCode?: number | null;
}

export interface KernelParamsCollectResponse {
  clusterId: string;
  changed: number;
  hosts: KernelParamsPerHost[];
  errors: string[];
}

// ── kubelet config 수집 (SSH) ────────────────────────────────────────────

export interface KubeletConfigCollectRequest {
  hosts: string[];
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  useSudo?: boolean;
  connectTimeout?: number;
  fallbackPaths?: string[];
  maxContentBytes?: number;
  parallelism?: number;
  chunkSize?: number;
  chunkPauseMs?: number;
}

export interface KubeletConfigPerHost {
  host: string;
  status: string;
  configFile?: string | null;
  configContent?: string | null;
  psCmdline?: string | null;
  kubeconfig?: string | null;
  containerRuntimeEndpoint?: string | null;
  nodeIp?: string | null;
  cgroupDriver?: string | null;
  /** 각 필드의 출처 (`ps -ef:--config`, `fallback path probe`, `file:/path`) */
  sources?: Record<string, string> | null;
  stored?: boolean;
  error?: string | null;
  /** 실행-로그 규칙 — per-host 원본 stdout/stderr/exit code (axios 인터셉터가 camelCase 로 변환해 도착) */
  rawStdout?: string | null;
  rawStderr?: string | null;
  exitCode?: number | null;
}

export interface KubeletConfigCollectResponse {
  clusterId: string;
  changed: number;
  hosts: KubeletConfigPerHost[];
  componentKey: string;
  errors: string[];
}

export interface EtcdctlConfigCollectRequest {
  hosts: string[];
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  useSudo?: boolean;
  connectTimeout?: number;
  envFiles?: string[];
  queryEndpointStatus?: boolean;
  etcdctlPath?: string;
  sourceEnvFile?: string | null;
}

export interface EtcdctlConfigPerHost {
  host: string;
  envFile?: string | null;
  hasEndpointStatus: boolean;
  stored?: boolean;
  error?: string | null;
}

export interface EtcdctlConfigCollectResponse {
  clusterId: string;
  changed: number;
  hosts: EtcdctlConfigPerHost[];
  errors: string[];
}

// ── 노드 NIC 수집 (bond0/bond1 + public/private IP) ────────────────────
export interface NodeNicsCollectRequest {
  hosts: string[];
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  useSudo?: boolean;
  connectTimeout?: number;
  skipIfacePatterns?: string[];
  parallelism?: number;
  chunkSize?: number;
  chunkPauseMs?: number;
}

export interface NicAddrInfo {
  ip: string;
  prefixlen?: number | null;
  scope?: string | null;
}

export interface NicInterface {
  name: string;
  mac?: string | null;
  mtu?: number | null;
  operstate?: string | null;
  addrs: NicAddrInfo[];
  linkKind?: string | null;
}

export interface NicAllIp {
  iface: string;
  ip: string;
  prefix?: number | null;
  mac?: string | null;
  mtu?: number | null;
  operstate?: string | null;
  scope: 'public' | 'private' | 'linklocal' | 'unknown';
}

export interface NodeNicsPerHost {
  host: string;
  status: string;
  interfaces?: NicInterface[];
  allIps?: NicAllIp[];
  error?: string | null;
  // 진단·실행 로그용 — 백엔드는 snake_case(raw_stdout)로 보내지만 axios 응답 인터셉터가
  // 모든 키를 camelCase 로 바꾸므로 여기 키도 camelCase 여야 실제 값이 잡힌다.
  // (이전 snake_case 선언은 런타임에 항상 undefined 였던 버그)
  rawStdout?: string | null;
  rawStderr?: string | null;
  exitCode?: number | null;
}

export interface NodeNicsCollectResponse {
  clusterId: string;
  changed: number;
  hosts: NodeNicsPerHost[];
  errors: string[];
}

// ── 주요 명령어 / 파라미터 모음 (지식 허브 작업 기준) ───────────────────────
export type CommandImportance = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface CommandEntry {
  id: string;
  category?: string | null;
  command: string;
  description?: string | null;
  caution?: string | null;
  importance: CommandImportance;
  examples?: string | null;
  tags?: string | null;
  pinned: boolean;
  sortOrder: number;
  author?: string | null;
  /** 관련 Confluence 문서 링크 (선택) */
  confluenceUrl?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandEntryCreate {
  category?: string;
  command: string;
  description?: string;
  caution?: string;
  importance?: CommandImportance;
  examples?: string;
  tags?: string;
  pinned?: boolean;
  sortOrder?: number;
  author?: string;
  confluenceUrl?: string;
}

// ── 노드 일괄 실행(bulk-exec) 재사용 — 사용자별 저장 스크립트 ──────────────
export type ScriptLanguage = 'bash' | 'python';

export interface SavedScript {
  id: string;
  name: string;
  language: ScriptLanguage;
  content: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SavedScriptCreate {
  name: string;
  language: ScriptLanguage;
  content: string;
  description?: string;
}

export interface SavedScriptUpdate {
  name?: string;
  language?: ScriptLanguage;
  content?: string;
  description?: string;
}

// ── MinIO / AIStor 수집 응답 ──────────────────────────────────────────
export interface MinioCollectTenantSummary {
  namespace: string | null;
  name: string | null;
  image: string | null;
  version: string | null;
  totalServers: number;
  totalDrives: number;
  drivesPerSet: number;
  ecParity: number;
  ecDataShards: number;
  currentState: string | null;
  healthStatus: string | null;
  drivesOnline: number | null;
  drivesOffline: number | null;
}

export interface MinioCollectDirectPVSummary {
  totalDrives: number;
  readyDrives: number;
  totalCapacity: number;
  nodeCount: number;
}

export interface MinioCollectOperatorSummary {
  namespace: string | null;
  name: string | null;
  image: string | null;
  version: string | null;
}

export interface MinioCollectResponse {
  clusterId: string;
  changed: number;
  warnings: string[];
  summary: {
    operator: MinioCollectOperatorSummary | null;
    tenants: MinioCollectTenantSummary[];
    directpv: MinioCollectDirectPVSummary | null;
  };
  collectedAt: string;
}

// ── 노드 서버스펙 관리 대장 ────────────────────────────────────────────
export type NodeSpecStatus = 'active' | 'spare' | 'maintenance' | 'decommission';

export interface NodeServerSpec {
  id: string;
  clusterId?: string | null;
  clusterName?: string | null;
  hostname: string;
  nodeName?: string | null;
  role?: string | null;
  status: NodeSpecStatus | string;
  // 네트워크
  internalIp?: string | null;
  externalIp?: string | null;
  bmcIp?: string | null;
  bond0Ip?: string | null;
  bond0Mac?: string | null;
  bond0Speed?: string | null;
  bond1Ip?: string | null;
  bond1Mac?: string | null;
  bond1Speed?: string | null;
  // 하드웨어
  vendor?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  cpuModel?: string | null;
  cpuSockets?: number | null;
  cpuCores?: number | null;
  cpuThreads?: number | null;
  memoryGb?: number | null;
  memoryModules?: string | null;
  diskTotalGb?: number | null;
  nonOsDiskGb?: number | null;
  diskType?: string | null;
  diskCount?: number | null;
  raidConfig?: string | null;
  gpuModel?: string | null;
  gpuCount?: number | null;
  isSsd?: boolean | null;
  isVm?: boolean | null;
  // 위치
  datacenter?: string | null;
  room?: string | null;
  rack?: string | null;
  rackUnit?: string | null;
  // 소프트웨어
  osImage?: string | null;
  kernelVersion?: string | null;
  kubeletVersion?: string | null;
  containerRuntime?: string | null;
  // 자산/계약
  assetTag?: string | null;
  purchaseDate?: string | null;
  warrantyEnd?: string | null;
  owner?: string | null;
  currentUsage?: string | null;
  purchasePurpose?: string | null;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

// CSV 업로드 — 한 행 (hostname 만 필수, 나머지는 optional)
export type NodeSpecCsvRow = Partial<Omit<NodeServerSpec, 'id' | 'createdAt' | 'updatedAt' | 'clusterName'>> & {
  hostname: string;
};

export interface NodeSpecCsvUploadRequest {
  rows: NodeSpecCsvRow[];
  dryRun?: boolean;
  matchClusterScope?: boolean;
  ignoreEmptyOnUpdate?: boolean;
}

export interface NodeSpecCsvDiff {
  rowIndex: number;
  hostname: string;
  action: 'insert' | 'update' | 'skip' | 'error';
  existingId?: string | null;
  changes: Record<string, { old: unknown; new: unknown }>;
  error?: string | null;
}

export interface NodeSpecCsvPreviewResponse {
  dryRun: boolean;
  insertCount: number;
  updateCount: number;
  skipCount: number;
  errorCount: number;
  diffs: NodeSpecCsvDiff[];
}

export interface NodeSpecCsvApplyResponse {
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
  items: NodeServerSpec[];
}

export type NodeServerSpecCreate = Omit<NodeServerSpec, 'id' | 'createdAt' | 'updatedAt' | 'clusterName'>;
export type NodeServerSpecUpdate = Partial<NodeServerSpecCreate>;

export interface NodeServerSpecListResponse {
  data: NodeServerSpec[];
  total: number;
}

export interface NodeSpecImportRequest {
  upsert?: boolean;
  overwriteUserFields?: boolean;
}

export interface NodeSpecImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
  items: NodeServerSpec[];
}

export interface NodeSpecHostFactsCollectRequest {
  hosts: string[];
  username?: string;
  password?: string;
  privateKey?: string;
  port?: number;
  useSudo?: boolean;
  connectTimeout?: number;
  execTimeout?: number;
  parallelism?: number;
  chunkSize?: number;
  chunkPauseMs?: number;
  upsert?: boolean;
}

export interface NodeSpecHostFactsItem {
  host: string;
  status: string;
  message?: string | null;
  specId?: string | null;
  hostname?: string | null;
  bond0Ip?: string | null;
  bond1Ip?: string | null;
  diskCount?: number | null;
  diskTotalGb?: number | null;
  nonOsDiskGb?: number | null;
  diskType?: string | null;
  isSsd?: boolean | null;
  isVm?: boolean | null;
}

export interface NodeSpecHostFactsCollectResponse {
  clusterId: string;
  updated: number;
  inserted: number;
  skipped: number;
  errors: string[];
  items: NodeSpecHostFactsItem[];
}

// ── tcpdump ────────────────────────────────────────────────────────────
export interface TcpdumpCaptureRequest {
  clusterId?: string;
  host: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  interface: string;
  bpfFilter?: string;
  durationSec?: number;
  packetCount?: number;
  useSudo?: boolean;
  connectTimeout?: number;
}

export interface TcpdumpPacketRow {
  timestamp: string;
  src?: string | null;
  dst?: string | null;
  proto?: string | null;
  flags?: string | null;
  length?: number | null;
  summary: string;
}

export interface TcpdumpCaptureResponse {
  host: string;
  status: string;
  executed: string;
  exitCode?: number | null;
  durationMs: number;
  packets: TcpdumpPacketRow[];
  stderr: string;
  raw: string;
  error?: string | null;
}

export interface TcpdumpInterfacesRequest {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  connectTimeout?: number;
}

export interface TcpdumpInterfacesResponse {
  host: string;
  interfaces: string[];
}

// Ontology Graph
export type OntologyEntityType =
  | 'node' | 'hardware' | 'os' | 'kernel_param' | 'network'
  | 'k8s_component' | 'cilium_component' | 'workload' | 'service' | 'config_item';

export interface OntologyEntity {
  id: string;
  clusterId: string;
  entityType: OntologyEntityType;
  name: string;
  externalId?: string;
  version?: string;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OntologyRelationship {
  id: string;
  clusterId: string;
  sourceEntityId: string;
  relationType: string;
  targetEntityId: string;
  weight: number;
  relationMetadata: Record<string, unknown>;
  createdAt: string;
}

export interface OntologyGraph {
  clusterId: string;
  entities: OntologyEntity[];
  relationships: OntologyRelationship[];
}

export interface ImpactPath {
  path: string[];
  pathNames: string[];
  pathRelations: string[];
  score: number;
}

export interface OntologyImpactRequest {
  clusterId: string;
  configEntityId: string;
  category: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description?: string;
  evidence?: Record<string, unknown>;
  maxDepth?: number;
}

export interface OntologyImpactResponse {
  eventId: string;
  blastRadiusScore: number;
  impactedEntities: OntologyEntity[];
  impactPaths: ImpactPath[];
}

// Incident Analysis
export interface KubeEvent {
  reason: string;
  message: string;
  count: number;
  firstTime: string;
  lastTime: string;
  type?: string;
}

export interface IncidentAnalysisRequest {
  podName: string;
  namespace: string;
  timestamp: string;
  events: KubeEvent[];
  currentLogs: string;
  previousLogs?: string;
  describeOutput: string;
  relatedWorkload?: {
    kind: string;
    name: string;
    status: string;
  };
  argocdStatus?: {
    app: string;
    syncStatus: string;
    lastSyncAt: string;
  };
}

export interface IncidentAnalysisResult {
  severity: 'critical' | 'warning' | 'info';
  rootCause: string;
  suggestedActions: string[];
  relatedRunbooks: string[];
  confidence: number;
  analyzedBy: 'claude' | 'local_llm' | 'rule_based';
  analyzedAt: string;
}

export interface IncidentAnalysisResponse {
  status: 'ok' | 'error';
  result?: IncidentAnalysisResult;
  error?: string;
}

export interface AnalyzerHealthResponse {
  backend: string;
  available: boolean;
}

// Cluster → Namespace → Pod 드릴다운 (장애 분석용)
export interface AnalyzeNamespaceItem {
  name: string;
  podCount?: number | null;
  hasUnhealthy: boolean;
}

// ── Service Topology ────────────────────────────────────────────────────────
export interface TopoNodeMetricAxis {
  usage?: number | null;
  request?: number | null;
  limit?: number | null;
}
export interface TopoNodeMetrics {
  cpu: TopoNodeMetricAxis;
  mem: TopoNodeMetricAxis;
}
export interface TopoNode {
  id: string;
  kind: string;
  name: string;
  namespace: string;
  status: string;        // healthy | warning | critical
  podCount: number;
  readyCount: number;
  restartCount: number;
  ghost: boolean;
  ageSeconds?: number | null;
  detail?: string | null;
  nodeType?: string | null;  // external 노드용 (database|api|queue|other)
  externalId?: string | null;  // external 노드의 DB id (삭제용)
  metrics: TopoNodeMetrics;
}
export type TopoEdgeType =
  | 'owns' | 'routes' | 'exposes' | 'uses_config' | 'uses_secret'
  | 'mounts_pvc' | 'manual' | 'traffic';
export interface TopoEdge {
  id: string;
  source: string;
  target: string;
  type: TopoEdgeType | string;
  label: string;
  detail: string;
  manualId?: string | null;
}
export interface TopologyGraphResponse {
  clusterId: string;
  namespace: string;
  nodes: TopoNode[];
  edges: TopoEdge[];
  metricsStatus: string;  // ok | offline | unknown
  truncated: boolean;
  warnings: string[];
  generatedAt: string;
}
/** 전 네임스페이스 클러스터 토폴로지(요약/상세) + 백그라운드 진행 메타. */
export interface ClusterTopologyResponse extends AllocSnapshotMeta {
  clusterId: string;
  mode: 'summary' | 'detail';
  nodes: TopoNode[];          // 요약은 kind="Namespace"
  edges: TopoEdge[];
  metricsStatus: string;
  truncated: boolean;
  summaryRecommended: boolean;
  namespaceCount: number;
  warnings: string[];
  generatedAt: string;
}
export interface TopologyTrafficEdge {
  source: string;
  target: string;
  flowCount: number;
  droppedCount: number;
  protocols: string[];
  ports: number[];
}
export interface TopologyTrafficResponse {
  clusterId: string;
  namespace: string;
  status: 'ok' | 'unavailable' | 'error';
  source?: string | null;   // hubble | conntrack
  reason?: string | null;
  edges: TopologyTrafficEdge[];
  generatedAt: string;
}
export interface ServiceTopologyLink {
  id: string;
  clusterId: string;
  namespace: string;
  sourceKind: string;
  sourceName: string;
  targetKind: string;
  targetName: string;
  linkType: string;   // depends_on | calls | reads | writes | custom
  label?: string | null;
  note?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ServiceTopologyExternalNode {
  id: string;
  clusterId: string;
  namespace: string;
  name: string;
  nodeType: string;   // database | api | queue | other
  note?: string | null;
  createdAt: string;
}

// ── Service Architecture Docs (서비스 모듈별 아키텍처/플로우 문서) ───────────
export type ArchViewType = 'architecture' | 'flow';

export interface ArchGraphNode {
  id: string;
  kind: string;
  name: string;
  namespace?: string | null;
  status: string;              // healthy | warning | critical
  detail?: string | null;
  stale: boolean;              // 클러스터에서 사라진 노드 (ghost 렌더)
  staleSince?: string | null;
}
export interface ArchGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;                // routes | exposes | owns | mounts_pvc ...
  label: string;
}
export interface ArchGraph {
  nodes: ArchGraphNode[];
  edges: ArchGraphEdge[];
  warnings: string[];
  truncated: boolean;
}
export interface ArchTrafficEdge {
  source: string;
  target: string;
  flowCount: number;
  droppedCount: number;
  protocols: string[];
  ports: number[];
}
export interface ArchManualNode {
  id: string;
  nodeId: string;              // "manual:{uuid}" — 그래프 identity
  label: string;
  kind: string;                // external | database | queue | api | user | custom
  description?: string | null;
  style?: Record<string, unknown> | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ArchManualEdge {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: string;            // flow | depends | calls | custom
  label?: string | null;
  description?: string | null;
  view: ArchViewType | 'both';
  sortOrder: number;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ArchLlmComponent {
  nodeId: string;
  role: string;
}
export interface ArchLlmFlowStep {
  order: number;
  source: string;
  target: string;
  description: string;
}
export interface ArchLlmContent {
  summary: string;
  components: ArchLlmComponent[];
  flowSteps: ArchLlmFlowStep[];
  model?: string;
  generatedAt?: string;
  rawFallback?: boolean;
}
export interface ArchDrift {
  added?: string[];
  removed?: string[];
  changed?: string[];
  detectedAt?: string;
}
export interface ArchDoc {
  id: string;
  serviceId: string;
  clusterId: string;
  namespace: string;
  autoGraph?: ArchGraph | null;
  trafficEdges: ArchTrafficEdge[];
  llmContent?: ArchLlmContent | null;
  // 뷰별 노드 배치 — node_id 키는 대문자/구분자를 포함하지만 언더스코어가 없어
  // axios 키 변환(snake→camel)의 영향을 받지 않는다.
  layout: Partial<Record<ArchViewType, Record<string, { x: number; y: number }>>>;
  annotations: Record<string, string>;   // node_id → 메모 ("__doc__" = 문서 메모)
  summaryOverride?: string | null;
  sourceHash?: string | null;
  drift?: ArchDrift | null;
  lastSyncedAt?: string | null;
  lastSyncStatus: 'pending' | 'ok' | 'partial' | 'failed';
  syncError?: string | null;
  autoSyncEnabled: boolean;
  llmStatus: 'none' | 'pending' | 'ok' | 'offline' | 'failed';
  manualNodes: ArchManualNode[];
  manualEdges: ArchManualEdge[];
  updatedAt: string;
}
export interface ArchDocSummary {
  serviceId: string;
  serviceName: string;
  serviceType: string;
  clusterId: string;
  namespace?: string | null;
  hasDoc: boolean;
  lastSyncedAt?: string | null;
  lastSyncStatus: string;
  llmStatus: string;
  autoSyncEnabled: boolean;
  driftCounts?: Record<string, number> | null;
}
export interface ArchDocSchedule {
  enabled: boolean;
  cron: string;
  lastRunAt?: string | null;
}

export interface AnalyzeNamespacesResponse {
  clusterId: string;
  clusterName: string;
  namespaces: AnalyzeNamespaceItem[];
}

export interface AnalyzePodItem {
  name: string;
  namespace: string;
  phase: string;
  ready: string;
  restartCount: number;
  node?: string | null;
  ageSeconds?: number | null;
  hasIssue: boolean;
  issueReason?: string | null;
}

export interface AnalyzePodsResponse {
  clusterId: string;
  clusterName: string;
  namespace: string;
  pods: AnalyzePodItem[];
}

export interface AnalyzeIncidentContext {
  clusterId: string;
  clusterName: string;
  podName: string;
  namespace: string;
  timestamp: string;
  events: KubeEvent[];
  currentLogs: string;
  previousLogs?: string | null;
  describeOutput: string;
}

// Trend Digest
export type TrendCategory = 'k8s' | 'cilium' | 'linux' | 'cncf' | string;
export type TrendItemType = 'release' | 'blog' | 'news';

export interface TrendSource {
  id: string;
  name: string;
  sourceType: 'github_release' | 'rss';
  url: string;
  category: TrendCategory;
  enabled: boolean;
  lastStatus?: 'ok' | 'error' | 'empty' | null;
  lastMessage?: string | null;
  lastItemCount?: number;
  lastCollectedAt?: string | null;
}

export interface TrendSourceCreate {
  name: string;
  sourceType: 'github_release' | 'rss';
  url: string;
  category: string;
  enabled?: boolean;
}

export interface TrendItem {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  summaryKo?: string;
  version?: string;
  itemType: TrendItemType;
  sourceName: string;
  category: TrendCategory;
}

export interface TrendDigest {
  id: string;
  digestDate: string;
  overallSummaryKo?: string;
  itemCount: number;
  status: 'pending' | 'collecting' | 'summarizing' | 'done' | 'failed';
  errorMessage?: string;
}

export interface MindMapNodeUpdate {
  label?: string;
  note?: string;
  color?: string;
  x?: number;
  y?: number;
  collapsed?: boolean;
  sortOrder?: number;
  parentId?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: Record<string, any>;
}

// ─── Deep Check / Super Pod / 알림 ─────────────────────────────────────

export type DeepCheckType =
  | 'cert_expiry'
  | 'etcd_defrag'
  | 'cni_flow'
  | 'pvc_health'
  | 'image_pull'
  | 'audit_rbac'
  | string;

export interface DeepCheckFieldSpec {
  name: string;
  type: 'int' | 'float' | 'string' | 'boolean' | 'list' | string;
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: any;
  help?: string | null;
}

export interface DeepCheckTypeSchema {
  checkType: DeepCheckType;
  displayName: string;
  description: string;
  category?: string;
  thresholdFields: DeepCheckFieldSpec[];
  paramFields: DeepCheckFieldSpec[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultThresholds: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultParams: Record<string, any>;
  /** false = admin 이 인스턴스를 직접 만드는 커스텀(템플릿형) 타입 */
  seedDefault?: boolean;
}

export interface DeepCheckDefinition {
  id: string;
  clusterId?: string | null;
  checkType: DeepCheckType;
  name: string;
  description?: string | null;
  enabled: boolean;
  scheduleCron?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  thresholds?: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any> | null;
  sortOrder: number;
  lastRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
  // with_status=true 조회 시에만 채워지는 최근 실행 요약
  lastStatus?: Status | null;
  lastCheckedAt?: string | null;
  lastMessage?: string | null;
  lastDurationMs?: number | null;
}

export type DeepCheckDefinitionInput = Omit<
  DeepCheckDefinition,
  | 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt'
  | 'lastStatus' | 'lastCheckedAt' | 'lastMessage' | 'lastDurationMs'
>;

export interface DeepCheckDefinitionResults {
  total: number;
  results: DeepCheckResult[];
}

export interface DeepCheckPreviewInput {
  checkType: DeepCheckType;
  clusterId?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  thresholds?: Record<string, any> | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any> | null;
}

export interface DeepCheckResult {
  id: string;
  clusterId: string;
  dailyCheckLogId?: string | null;
  definitionId?: string | null;
  checkType: DeepCheckType;
  status: Status;
  message?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details?: Record<string, any> | null;
  durationMs: number;
  checkedAt: string;
}

// Deep check 실행 단계(로그 + 2D 애니메이션)
export interface DeepCheckExecStep {
  id: string;
  label: string;
  status: 'running' | 'success' | 'failed' | 'skipped';
  detail?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metrics?: Record<string, any>;
  startedMs?: number;
  durationMs?: number;
}
export interface DeepCheckStepPlanItem { id: string; label: string }

export interface DeepCheckTestResult {
  definitionId?: string;
  checkType: DeepCheckType;
  status: Status;
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details?: Record<string, any> | null;
  durationMs: number;
  persistedResultId?: string;
  steps?: DeepCheckExecStep[];
  stepPlan?: DeepCheckStepPlanItem[];
}

export interface DiffSummary {
  available: boolean;
  previousLogId?: string;
  previousCheckedAt?: string | null;
  errorsAdded?: string[];
  errorsRemoved?: string[];
  warningsAdded?: string[];
  warningsRemoved?: string[];
  statusChanged?: boolean;
  previousStatus?: string | null;
  currentStatus?: string | null;
  readyNodesDelta?: number;
}

export interface TrendPoint {
  checkedAt: string | null;
  status: string;
  errors: number;
  warnings: number;
  readyNodes: number;
  totalNodes: number;
}

export interface TrendSummary {
  days: number;
  available: boolean;
  totals?: Record<string, number>;
  points: TrendPoint[];
}

export interface DailyCheckTrend {
  clusterId: string;
  days: number;
  points: Array<{
    id: string;
    checkedAt: string | null;
    overallStatus: string;
    scheduleType?: string | null;
    readyNodes: number;
    totalNodes: number;
    errors: number;
    warnings: number;
  }>;
  totals: Record<string, number>;
}

export interface DeepCheckReview {
  dailyCheckLogId: string;
  clusterId: string;
  overallStatus: Status;
  aiSummary?: string | null;
  aiRemediation?: string | null;
  aiDiff?: DiffSummary | null;
  aiTrend?: TrendSummary | null;
  aiStatus?: string | null;
  aiGeneratedAt?: string | null;
  deepResults: DeepCheckResult[];
}

export type NotificationChannelType = 'slack' | 'email' | 'webhook' | 'k8s_event';

export interface NotificationChannel {
  id: string;
  name: string;
  channelType: NotificationChannelType;
  enabled: boolean;
  clusterId?: string | null;
  minSeverity: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: Record<string, any> | null;
  createdAt: string;
  updatedAt: string;
}

export type NotificationChannelInput = Omit<
  NotificationChannel,
  'id' | 'createdAt' | 'updatedAt'
>;

export interface NotificationLogEntry {
  id: string;
  channelId?: string | null;
  dailyCheckLogId?: string | null;
  status: string;
  subject?: string | null;
  body?: string | null;
  error?: string | null;
  sentAt: string;
}

// ── Auth & RBAC ────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface AuthUserDetail {
  id: string;
  username: string;
  role: UserRole;
  displayName?: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  actorUserId?: string | null;
  actorUsername: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  status: 'success' | 'failure' | string;
  ip?: string | null;
  userAgent?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details?: Record<string, any> | null;
  createdAt: string;
}

export interface AuditLogListResponse {
  items: AuditLog[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── 릴리즈 노트 (CHANGELOG.md 파싱, backend/app/routers/release_notes.py) ──────
export interface ReleaseNoteItem {
  summary: string;
  detail: string;
}

export interface ReleaseNoteSection {
  name: string;
  items: ReleaseNoteItem[];
}

export interface ReleaseNoteEntry {
  version: string;
  date: string;
  summary: string;
  itemCount: number;
  sections: ReleaseNoteSection[];
}

export interface ReleaseNotesResponse {
  entries: ReleaseNoteEntry[];
}

// ─── LAKE Service Monitoring (lake-service-monitoring PDCA) ──────
export type LakeServiceType =
  | 'airflow' | 'spark' | 'iceberg' | 'trino'
  | 'starrocks' | 'jupyterlab' | 'superset' | 'polaris';
export type LakeServiceCategory = 'catalog' | 'runtime' | 'analytics';
export type LakeStatus = 'healthy' | 'warning' | 'critical' | 'pending';

export interface LakeServiceTypeInfo {
  serviceType: string;
  label: string;
  category: string;
  defaultPath: string;
  description?: string;
}

// lake-service-type-management PDCA — DB-driven type 카탈로그 (CRUD)
export interface LakeServiceTypeRow {
  id: string;
  serviceType: string;
  label: string;
  category: string;
  defaultPath: string;
  description?: string | null;
  icon?: string | null;
  /** 카드/뱃지 색상 토큰 (예: 'sky', 'emerald'). 비어있으면 slate. */
  color?: string | null;
  isBuiltin: boolean;
  enabled: boolean;
  sortOrder: number;
  /** PEP 서비스 / APP 서비스 사이드바 2단 네비게이션용 — 도메인 + 상위 카테고리 FK */
  domain: string;
  categoryId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LakeServiceTypeInput {
  serviceType: string;
  label: string;
  category?: string;
  defaultPath?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  enabled?: boolean;
  sortOrder?: number;
  domain?: string;
  categoryId?: string | null;
}

export interface LakeServiceTypeUpdate {
  label?: string;
  category?: string;
  defaultPath?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  enabled?: boolean;
  sortOrder?: number;
  domain?: string;
  categoryId?: string | null;
}

// ─── PEP/APP 서비스 상위 카테고리 (service-category-catalog) ──────
export type ServiceDomain = 'pep' | 'app';

export interface ServiceCategory {
  id: string;
  domain: ServiceDomain;
  key: string;
  label: string;
  icon?: string | null;
  isBuiltin: boolean;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceCategoryInput {
  domain: ServiceDomain;
  key: string;
  label: string;
  icon?: string | null;
  enabled?: boolean;
  sortOrder?: number;
}

export interface ServiceCategoryUpdate {
  label?: string;
  icon?: string | null;
  enabled?: boolean;
  sortOrder?: number;
}

export interface ServiceCategoryListResponse {
  data: ServiceCategory[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface LakeServiceTypeListResponseRows {
  data: LakeServiceTypeRow[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface LakeService {
  id: string;
  clusterId: string;
  serviceType: string;
  name: string;
  category: string;
  domain: ServiceDomain;
  endpointUrl: string;
  namespace?: string | null;
  enabled: boolean;
  tlsVerify: boolean;
  status: LakeStatus;
  lastCheckedAt?: string | null;
  lastMessage?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface LakeServiceInput {
  clusterId: string;
  /** builtin(8종) + 운영자가 등록한 custom slug 모두 허용 — 실제 검증은 서버가 DB 조회로 수행. */
  serviceType: string;
  name: string;
  endpointUrl: string;
  namespace?: string | null;
  enabled?: boolean;
  tlsVerify?: boolean;
  meta?: Record<string, unknown> | null;
}

export interface LakeServiceUpdate {
  name?: string;
  endpointUrl?: string;
  namespace?: string | null;
  enabled?: boolean;
  tlsVerify?: boolean;
  meta?: Record<string, unknown> | null;
}

export interface LakeServiceListResponse {
  data: LakeService[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface LakeServiceCheck {
  id: string;
  serviceId: string;
  status: LakeStatus;
  responseTimeMs?: number | null;
  message?: string | null;
  details?: Record<string, unknown> | null;
  triggeredBy: string;
  triggeredByUser?: string | null;
  checkedAt: string;
}

export interface LakeServiceCheckListResponse {
  data: LakeServiceCheck[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

// ─── Pod-to-Pod Bottleneck Analyzer (pod-bottleneck-analyzer PDCA) ──
export type BottleneckProbeKey = 'tcp_state' | 'tcp_perf' | 'dns_latency' | 'endpoints';
export type BottleneckStatus = 'healthy' | 'warning' | 'critical' | 'pending';

export interface ProbeManualFallback {
  command: string;
  reason: string;
}

export interface ProbeResultOut {
  status: BottleneckStatus;
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details: Record<string, any>;
  manualFallback?: ProbeManualFallback | null;
  recommendation?: string | null;
}

export interface BottleneckRunInput {
  clusterId: string;
  namespace: string;
  sourcePod: string;
  destPod: string;
  destService?: string | null;
  probes?: BottleneckProbeKey[] | null;
}

export interface BottleneckRun {
  id: string;
  clusterId: string;
  namespace: string;
  sourcePod: string;
  destPod: string;
  destService?: string | null;
  overallStatus: BottleneckStatus;
  // 4 Probe 결과 통합 dict. probes[probeKey] = ProbeResultOut
  probes: Partial<Record<BottleneckProbeKey, ProbeResultOut>>;
  triggeredByUser?: string | null;
  durationMs?: number | null;
  createdAt: string;
}

export interface BottleneckRunListResponse {
  data: BottleneckRun[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface BottleneckProbeCatalogEntry {
  probeKey: string;
  label: string;
  axis: string;
  needsExec: boolean;
  fallbackCmd?: string | null;
  description?: string | null;
}

// ── 운영 점검(Ops Checks) 통합 콘솔 ──────────────────────────────────────────
/** 점검 소스 — deep_check / addon / batch_job / playbook */
export type OpsCheckSource = 'deep_check' | 'addon' | 'batch_job' | 'playbook';
/** 도메인 카테고리 — 콘솔 그룹핑/필터용 */
export type OpsCheckCategory = 'os' | 'k8s' | 'storage' | 'network' | 'app';

export interface OpsCheckCatalogItem {
  source: OpsCheckSource;
  itemRefId: string;
  name?: string | null;
  checkType?: string | null;
  category: OpsCheckCategory | string;
  requiresCredentials: boolean;
  /** false = 등록만 되고 비활성(cron 미실행) — 콘솔에서 수동 실행은 가능 */
  enabled?: boolean;
  lastStatus?: string | null;
  lastRunAt?: string | null;
}

export interface OpsCheckRunItem {
  id: string;
  source: OpsCheckSource;
  itemRefId: string;
  checkType?: string | null;
  name?: string | null;
  /** 실행 진행 상태 */
  status: 'queued' | 'running' | 'done' | 'error';
  /** 점검 판정 결과 */
  resultStatus?: 'healthy' | 'warning' | 'critical' | 'pending' | null;
  message?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details?: Record<string, any> | null;
  durationMs: number;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface OpsCheckRun {
  id: string;
  clusterId: string;
  status: 'pending' | 'running' | 'done' | 'cancelled';
  trigger: string;
  triggeredBy?: string | null;
  total: number;
  okCount: number;
  warnCount: number;
  critCount: number;
  errorCount: number;
  createdAt: string;
  finishedAt?: string | null;
}

export interface OpsCheckRunRequestItem {
  source: OpsCheckSource;
  itemRefId: string;
  checkType?: string | null;
  name?: string | null;
}

// ── K8s 읽기전용 리소스 탐색기 (OpenLens P1) ────────────────────────────────
export interface K8sResourceRow {
  name: string;
  namespace?: string | null;
  summary: string;
  cols?: Record<string, string>;
  ageSeconds?: number | null;
}
export interface K8sColumnDef { key: string; label: string }
export interface K8sResourceListResponse {
  kind: string;
  columns?: K8sColumnDef[];
  count: number;
  truncated: boolean;
  items: K8sResourceRow[];
}
export interface K8sResourceYaml {
  kind: string;
  namespace: string;
  name: string;
  yaml: string;
}

// ── K8s 상세 관리 (Lens 식) — 쓰기 액션 / CRD / Helm ─────────────────────────
export interface K8sResourceCapability {
  scalable: boolean;
  restartable: boolean;
  deletable: boolean;
  editable: boolean;
  namespaced: boolean;
}
export interface K8sCapabilitiesResponse {
  capabilities: Record<string, K8sResourceCapability>;
}
export interface K8sWriteResult {
  ok: boolean;
  kind?: string;
  namespace?: string;
  name?: string;
  replicas?: number;
  restartedAt?: string;
}
export interface K8sDrainResult {
  ok: boolean;
  node: string;
  evicted: string[];
  skipped: { pod: string; reason: string }[];
  errors: { pod: string; error: string }[];
}
export interface K8sCrdPrinterColumn {
  name: string;
  jsonPath: string;
  type?: string | null;     // string | integer | date | ...
  priority?: number | null; // >0 은 wide 전용 → 목록에서 숨김
}
export interface K8sCrdInfo {
  name: string;
  group: string;
  kind: string;
  plural: string;
  scope: string; // Namespaced | Cluster
  versions: string[];
  version: string;
  ageSeconds?: number | null;
  printerColumns?: K8sCrdPrinterColumn[];
}
export interface K8sCrdListResponse {
  count: number;
  items: K8sCrdInfo[];
}
export interface HelmRelease {
  name: string;
  namespace: string;
  revision: string | number;
  status: string;
  chart: string;
  appVersion?: string;
  updated?: string;
}
export interface HelmReleaseListResponse {
  count: number;
  items: HelmRelease[];
}
export interface HelmHistoryItem {
  revision: string | number;
  status: string;
  chart: string;
  appVersion?: string;
  updated?: string;
  description?: string;
}

// 구조화 상세(요약 탭) — 백엔드가 생성
export interface ResourceDetailKVItem { k: string; v: string }
export interface ResourceDetailSection {
  title: string;
  type: 'kv' | 'list' | 'text';
  items?: ResourceDetailKVItem[] | string[];
  text?: string;
}
// K8sResourceYaml 응답에 sections 가 함께 옴(선택)
export interface K8sResourceDetail {
  kind: string;
  namespace: string;
  name: string;
  yaml: string;
  sections?: ResourceDetailSection[];
}

// Nodes (rich)
export interface K8sNodeRichRow {
  name: string;
  roles: string[];
  version?: string | null;
  taints: number;
  conditions: string[];
  cpuCapacity?: string | null;
  memCapacity?: string | null;
  cpuUsage?: string | null;
  memUsage?: string | null;
  unschedulable: boolean;
  ageSeconds?: number | null;
}
export interface K8sNodesResponse {
  count: number;
  items: K8sNodeRichRow[];
  metricsAvailable: boolean;
}

// 종류 가용성 (nav 동적 숨김)
export interface KindAvailabilityInfo { available: boolean; present: boolean; count: number | null; truncated: boolean }
export interface KindAvailabilityResponse { kinds: Record<string, KindAvailabilityInfo> }

// Pods (rich) — Lens 식 컬럼
export type K8sCellColor = 'green' | 'amber' | 'red' | 'gray';
export interface K8sPodContainerCell { name: string; color: K8sCellColor; state: string; reason?: string | null }
export interface K8sPodRichRow {
  name: string;
  namespace?: string | null;
  containers: K8sPodContainerCell[];
  ready: string;
  restarts: number;
  controlledBy?: string | null;
  node?: string | null;
  qos?: string | null;
  phase: string;
  statusColor: K8sCellColor;
  ageSeconds?: number | null;
  cpuUsage?: string | null;      // metrics-server 즉시값 (없으면 null)
  memUsage?: string | null;
  warningCount?: number;         // 최근 Warning 이벤트 수
  warningReason?: string | null; // 최신 Warning reason
}
export interface K8sPodsResponse {
  count: number;
  truncated: boolean;
  items: K8sPodRichRow[];
  metricsAvailable?: boolean;
}

// Pods 요약 (K8s 상세 관리 개요 카드 — 용량/상태별 카운트)
export interface K8sPodsSummaryCapacity {
  allocatablePods: number;            // 전체 노드 allocatable.pods 합계
  schedulableAllocatablePods: number; // Ready & !unschedulable 노드 합계
  schedulableFreeSlots: number;       // 스케줄 가능 노드의 남은 슬롯
  nodesTotal: number;
  nodesSchedulable: number;
}
export interface K8sPodsSummaryResponse {
  totalPods: number;
  statusCounts: Record<string, number>; // running/pending/error/succeeded/failed/unknown
  capacity: K8sPodsSummaryCapacity;
}

// 파드 컨테이너 목록 (로그/터미널 셀렉터)
export interface K8sPodContainerInfo {
  name: string;
  init: boolean;
  state?: string | null; // running | waiting | terminated
  restartCount: number;
}
export interface K8sPodContainersResponse {
  containers: K8sPodContainerInfo[];
  defaultContainer?: string | null;
}

// 리소스 관련 이벤트 (상세 드로어 이벤트 탭)
export interface K8sRelatedEvent {
  type?: string | null;   // Normal | Warning
  reason?: string | null;
  message?: string | null;
  count?: number | null;
  source?: string | null;
  firstTimestamp?: string | null;
  lastTimestamp?: string | null;
}
export interface K8sRelatedEventsResponse { count: number; items: K8sRelatedEvent[] }

// ── K8s 자원 관리 (allocation: request vs 사용량 slack) ───────────────────────
// CPU 는 millicores(int), MEM 은 bytes(int). *Display 는 사람이 읽는 문자열.
export interface AllocNodeRow {
  name: string;
  roles: string[];
  unschedulable: boolean;
  podCount: number;
  podsAllocatable: number;   // 노드 max-pods(allocatable pods, 보통 110). 0=미상
  cpuAllocM: number;
  memAllocB: number;
  cpuCapacityM: number;
  memCapacityB: number;
  cpuUsageM: number | null;
  memUsageB: number | null;
  cpuReqM: number;
  memReqB: number;
  cpuLimM: number;
  memLimB: number;
  cpuSlackM: number;
  memSlackB: number;
  cpuAllocDisplay: string;
  memAllocDisplay: string;
  cpuUsageDisplay: string | null;
  memUsageDisplay: string | null;
  cpuReqDisplay: string;
  memReqDisplay: string;
  cpuLimDisplay: string;
  memLimDisplay: string;
}
/** 백그라운드 전수 집계 진행 메타 — 큰 클러스터에서 폴링/진행률 표시용. */
export interface AllocSnapshotMeta {
  status?: 'computing' | 'ready' | 'error';
  progress?: number | null;   // 0..1, null = 불확정
  processed?: number;
  total?: number | null;
  stale?: boolean;
  partial?: boolean;          // 부분(누적) 결과 여부
}
export interface AllocNodesResponse extends AllocSnapshotMeta { count: number; items: AllocNodeRow[]; metricsAvailable: boolean; partial?: boolean }
/** 단일 노드 즉시 재계산(개별 REFRESH) 응답. */
export interface AllocNodeRefreshResponse { item: AllocNodeRow; metricsAvailable: boolean }
/** 단일 네임스페이스 즉시 재계산(개별 REFRESH) 응답. */
export interface AllocNamespaceRefreshResponse { item: AllocNamespaceRow; metricsAvailable: boolean }

export interface AllocSummary {
  nodeCount: number;
  namespaceCount: number;
  podCount: number;
  cpuAllocM: number;
  memAllocB: number;
  cpuReqM: number;
  memReqB: number;
  cpuLimM: number;
  memLimB: number;
  cpuUsageM: number | null;
  memUsageB: number | null;
  noRequestPods: number;
}

export interface AllocNamespaceRow {
  namespace: string;
  podCount: number;
  workloadCount: number;
  noRequestPods: number;
  cpuReqM: number;
  memReqB: number;
  cpuLimM: number;
  memLimB: number;
  cpuUsageM: number | null;
  memUsageB: number | null;
  cpuReqDisplay: string;
  memReqDisplay: string;
  cpuUsageDisplay: string | null;
  memUsageDisplay: string | null;
}
export interface AllocNamespacesResponse extends AllocSnapshotMeta {
  count: number;
  items: AllocNamespaceRow[];
  summary: AllocSummary;
  metricsAvailable: boolean;
  podUsageSkipped: boolean;
  partial?: boolean;
}

export interface AllocWorkloadRow {
  namespace: string;
  kind: string;
  name: string;
  podCount: number;
  noRequestPods: number;
  cpuReqM: number;
  memReqB: number;
  cpuLimM: number;
  memLimB: number;
  cpuUsageM: number | null;
  memUsageB: number | null;
}
export interface AllocWorkloadsResponse { count: number; items: AllocWorkloadRow[]; metricsAvailable: boolean }

export interface AllocContainerCell {
  name: string;
  cpuReqM: number;
  memReqB: number;
  cpuLimM: number;
  memLimB: number;
  cpuUsageM: number | null;
  memUsageB: number | null;
  hasRequests: boolean;
}
export interface AllocPodRow {
  name: string;
  namespace: string;
  node: string | null;
  qos: string | null;
  phase: string;
  containers: AllocContainerCell[];
  cpuReqM: number;
  memReqB: number;
  cpuLimM: number;
  memLimB: number;
  cpuUsageM: number | null;
  memUsageB: number | null;
}
export interface AllocPodsResponse { count: number; items: AllocPodRow[]; metricsAvailable: boolean }

// ── 일일점검 리뷰: 리소스 수 추세 체크리스트 ──────────────────────────────────
export type MetricTrendDir = 'up' | 'down' | 'flat';
export interface MetricTrendRow {
  itemKey: string;
  label: string;
  resourceKind: string;
  today: number | null;
  yesterday: number | null;
  d7: number | null;
  d14: number | null;
  d28: number | null;
  delta: number | null;
  trend: MetricTrendDir;
  truncated: boolean;
  isChecked: boolean;
  checkedBy?: string | null;
  checkedAt?: string | null;
  note?: string | null;
}
export interface MetricTrendResponse {
  clusterId: string;
  date: string;
  latestCollectedAt: string | null;
  latestSnapshotId: string | null;
  items: MetricTrendRow[];
}
export interface MetricChecklistItemT {
  id: string;
  clusterId: string | null;
  itemKey: string;
  label: string;
  resourceKind: string;
  enabled: boolean;
  sortOrder: number;
  params: Record<string, unknown>;
}

// ── 이모지 공감(리액션) — ops_note / work_item_comment / work_guide 공통 ──────────
export type ReactionTargetType = 'ops_note' | 'work_item_comment' | 'work_guide' | 'work_item' | 'voc_post';

// 백엔드 REACTION_EMOJIS 와 동일 순서로 유지.
export const REACTION_EMOJIS = ['👍', '❤️', '🎉', '✅', '👀', '🙏', '🔥', '😄'] as const;

export interface ReactionGroup {
  emoji: string;
  count: number;
  reacted: boolean;   // 현재 사용자가 눌렀는지
  users: string[];    // 누른 사람 표시이름(툴팁용)
}

export interface ReactionSummary {
  targetType: ReactionTargetType;
  targetId: string;
  total: number;
  groups: ReactionGroup[];
}

// ── mc client presets (personal custom + admin shared) ──────────────────────
export interface McPresetItem {
  key: string;
  label: string;
  args: string;
}

export type McPresetSource = 'builtin' | 'shared' | 'personal';

export interface McEffectivePreset extends McPresetItem {
  source: McPresetSource;
  customized: boolean;
}

export interface McPersonalPresets {
  custom: McPresetItem[];
  overrides: Record<string, McPresetItem>;
  hidden: string[];
}

// ── terminal / log Appearance ───────────────────────────────────────────────
export interface TerminalPalette {
  bg: string;
  fg: string;
  red: string;
  green: string;
  amber: string;
  sky: string;
  purple: string;
  cyan: string;
  muted: string;
}

export interface TerminalTemplate {
  id: string;
  name: string;
  group: string;
  palette: TerminalPalette;
}

export interface TerminalProfile {
  templateId: string;
  fontSize: number;
  fontFamily: string;
  colors: Partial<TerminalPalette>;
}

export type TerminalMode = 'auto' | 'dev' | 'ops';
export type TerminalEnv = 'dev' | 'ops';

export interface TerminalAppearance {
  mode: TerminalMode;
  profiles: Record<TerminalEnv, TerminalProfile>;
  customTemplates: TerminalTemplate[];
}

export interface TerminalAppearanceResponse {
  appearance: TerminalAppearance;
  shared: TerminalTemplate[];
}

// ── 점검 매트릭스 (플랫폼 현황 — 행: 점검 항목, 열: 클러스터) ──────────────
export type CheckMatrixSourceType = 'core_bundle' | 'deep_check' | 'addon' | 'manual';

export interface CheckMatrixItem {
  id: string;
  name: string;
  description?: string | null;
  unit?: string | null;
  sourceType: CheckMatrixSourceType;
  sourceRef?: string | null;
  /** 영역 구분 (k8s | network | storage | os | app | 자유 문자열) */
  category?: string | null;
  /** 행 배경 색 — 차트 토큰 프리셋 키('chart-1'..'chart-8'), null = 무색 */
  color?: string | null;
  /** true = 시스템 항목(core_bundle) — 삭제 불가, Cluster.status 산정에 사용 */
  isSystem: boolean;
  /** false = 그리드에서 숨김(자동 실행은 계속됨) */
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type CheckMatrixItemInput = Omit<
  CheckMatrixItem,
  'id' | 'isSystem' | 'sortOrder' | 'createdAt' | 'updatedAt'
>;

export interface CheckMatrixCell {
  status: Status | null;
  value: number | null;
  message?: string | null;
  checkedAt: string | null;
  cronExpr: string | null;
  scheduleEnabled: boolean;
  hasResult: boolean;
}

export interface CheckMatrixGridCluster {
  id: string;
  name: string;
  checkCronExpr: string | null;
  /** 저장된 cron 을 지우지 않고 켜고 끄는 스위치 — false 면 cron 이 있어도 실행되지 않는다. */
  checkCronEnabled: boolean;
}

export interface CheckMatrixGrid {
  items: CheckMatrixItem[];
  clusters: CheckMatrixGridCluster[];
  /** cells[itemId][clusterId] */
  cells: Record<string, Record<string, CheckMatrixCell>>;
}

export interface CheckMatrixHistoryPoint {
  checkedAt: string;
  status: Status;
  value: number | null;
}

export interface CheckMatrixHistoryChange {
  checkedAt: string;
  status: Status;
  message?: string | null;
}

export interface CheckMatrixHistory {
  points: CheckMatrixHistoryPoint[];
  changes: CheckMatrixHistoryChange[];
}

export interface CheckMatrixSettings {
  retentionDays: number;
}

/** 런북 명령 1건 — 실제로 대상 클러스터에 나가는 호출. */
export interface CheckMatrixRunbookCommand {
  /** kubectl = 서브프로세스 · k8s_api = python SDK · http = 직접 호출 · ssh · db = PEP DB 전용 */
  kind: 'kubectl' | 'k8s_api' | 'http' | 'ssh' | 'db';
  command: string;
  description: string;
  /** false = 대상에 변경을 일으킬 수 있는 명령 */
  readonly: boolean;
}

/**
 * 런북에 표시할 설정값 1건.
 *
 * dict 가 아니라 `{name, value}` 리스트인 이유 — api.ts 응답 인터셉터가 모든 JSON **키**를
 * camelCase 로 바꾸기 때문이다. 파라미터 이름(`label_selector` 등)은 운영자가 Ops Checks
 * 화면에서 그대로 입력해야 하는 값이라 변환되면 안 되므로, 백엔드가 이름을 값 자리에 담아 보낸다.
 */
export interface CheckMatrixRunbookInput {
  group: string;
  name: string;
  value: string;
}

/** 소스 설정 편집 폼용 필드 명세 — deep check spec 의 threshold/param 필드. */
export interface CheckMatrixFieldSpec {
  group: 'thresholds' | 'params';
  name: string;
  type: 'int' | 'float' | 'string' | 'boolean' | 'list';
  label: string;
  help?: string | null;
}

/** 소스 설정 저장 요청 1건 — 값은 문자열로 보내고 서버가 타입을 강제한다(빈 값 = 기본값 복귀). */
export interface CheckMatrixSourceConfigEntry {
  group: string;
  name: string;
  value: string;
}

/** 셀(항목 × 클러스터)의 실행 계획 — "이 점검이 내 클러스터에서 무슨 일을 하는가". */
export interface CheckMatrixRunbook {
  itemId: string;
  itemName: string;
  clusterId: string;
  clusterName: string;
  sourceType: CheckMatrixSourceType;
  sourceRef?: string | null;
  /** 이 클러스터에서 해석된 실제 실행 대상(정의/애드온). 없으면 null */
  target?: string | null;
  runnable: boolean;
  blockedReason?: string | null;
  /** deep_check: 해석된 점검 정의 id — 소스 설정 편집 대상 */
  definitionId?: string | null;
  /** 'global' 이면 설정 수정이 모든 클러스터에 적용됨 (UI 경고 필요) */
  definitionScope?: 'cluster' | 'global' | null;
  /** addon: 해석된 애드온 인스턴스 id */
  addonId?: string | null;
  /** 이 화면에서 params/thresholds(또는 addon config) 수정 가능 여부 */
  configEditable: boolean;
  /** 편집 폼 라벨/타입/도움말 (deep_check 만) */
  fieldSpecs: CheckMatrixFieldSpec[];
  steps: DeepCheckStepPlanItem[];
  commands: CheckMatrixRunbookCommand[];
  inputs: CheckMatrixRunbookInput[];
  notes: string[];
  kubectlPrefix?: string | null;
}

export type CheckMatrixTrigger =
  | 'cron' | 'manual_cell' | 'manual_cluster' | 'manual_item' | 'manual_entry';
export type CheckMatrixRunState = 'queued' | 'running' | 'success' | 'failed' | 'skipped';

/** 실제로 실행된 명령 1건 — 런북(설계)과 대조하는 실측값. */
export interface CheckMatrixExecutedCommand {
  kind: string;
  command: string;
  exitCode?: number | null;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
}

/** 수행 로그 1건. 목록 응답에는 상세(steps/commands/runbook)가 빠져 있다. */
export interface CheckMatrixRun {
  id: string;
  batchId?: string | null;
  itemId: string;
  clusterId: string;
  itemName?: string | null;
  clusterName?: string | null;
  trigger: CheckMatrixTrigger;
  triggeredBy?: string | null;
  runState: CheckMatrixRunState;
  status?: Status | null;
  value?: number | null;
  message?: string | null;
  error?: string | null;
  durationMs?: number | null;
  queuedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface CheckMatrixRunDetail extends CheckMatrixRun {
  steps: DeepCheckExecStep[];
  stepPlan: DeepCheckStepPlanItem[];
  commands: CheckMatrixExecutedCommand[];
  runbook?: CheckMatrixRunbook | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details: Record<string, any>;
}

export interface CheckMatrixRunList {
  total: number;
  limit: number;
  offset: number;
  runs: CheckMatrixRun[];
}

/** 일괄 수행(클러스터 열 / 항목 행) 큐잉 결과. */
export interface CheckMatrixBatchResult {
  batchId: string;
  total: number;
  queued: number;
  errors: string[];
  runIds: string[];
}

// ── 스키마 점검 (모델 vs 실제 DB 드리프트) ──────────────────────────────────
/** 드리프트 1건. repairable=false 면 자동 복구 대상이 아니라 사람이 판단해야 한다. */
export interface SchemaDriftIssue {
  /** missing_table = 테이블 없음 · missing_column = 컬럼 없음 · not_null_drift = 레거시 NOT NULL ·
   *  orphan_not_null_column = 모델에 없는 DB 전용 컬럼이 NOT NULL+기본값 없음(모든 저장 실패) */
  kind: 'missing_table' | 'missing_column' | 'not_null_drift' | 'orphan_not_null_column' | 'inspect_failed';
  table: string;
  column?: string | null;
  detail: string;
  repairable: boolean;
}

/** 부팅 시 자동 복구(NOT NULL 완화)가 실제로 돌았는지 — 로그 없이 확인하기 위한 것. */
export interface SchemaBootRepair {
  ran: boolean;
  /** 감지된 대상 ("table.column") */
  detected?: string[];
  /** 실제로 완화된 건수 */
  relaxed?: number;
  /** 락 경합 등으로 실패한 항목 */
  failures?: { target: string; error: string }[];
}

export interface SchemaHealthReport {
  healthy: boolean;
  checkedTables: number;
  checkedColumns: number;
  issueCount: number;
  issues: SchemaDriftIssue[];
  bootRepair?: SchemaBootRepair;
}

export interface SchemaRepairAction extends SchemaDriftIssue {
  sql?: string;
  executed?: boolean;
  reason?: string;
  error?: string;
}

export interface SchemaRepairResult {
  dryRun: boolean;
  detected: number;
  applied: SchemaRepairAction[];
  skipped: SchemaRepairAction[];
  errors: SchemaRepairAction[];
  /** 복구 후 남은 드리프트 수. dryRun 이면 null. */
  remaining: number | null;
}

// ── Your Island — 사용자 커스텀 화면 ────────────────────────────────────────
/** 아일랜드 패널 배치 방식. tabs = 상단 pill 탭바, sidebar = 좌측 아이콘 레일. */
export type IslandLayoutMode = 'tabs' | 'sidebar';

/** 아일랜드 패널 1개 — 기존 라우트 경로를 가리키고, 해당 페이지를 그대로 임베드한다. */
export interface IslandPanel {
  /** 아일랜드 내 고유 키. 같은 화면을 중복 추가할 수 있어 path 와 별개로 둔다. */
  key: string;
  /** NAV_MAP 키 = 라우트 경로 (예: '/ops-checks'). */
  path: string;
  /** 사용자 지정 라벨. null 이면 navLabels/NAV_MAP 기본 라벨. */
  label?: string | null;
  /** 사용자 지정 아이콘(lucide 이름). null 이면 NAV_MAP 아이콘. */
  icon?: string | null;
}

export interface Island {
  id: string;
  ownerId: string;
  ownerName?: string | null;
  name: string;
  icon?: string | null;
  description?: string | null;
  layoutMode: IslandLayoutMode;
  panels: IslandPanel[];
  isShared: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface IslandListResponse {
  /** 내가 소유한 아일랜드 (sortOrder 순). */
  data: Island[];
  /** 남이 공유한 아일랜드 — 읽기 전용, 복제만 가능. */
  shared: Island[];
  total: number;
}

export interface IslandCreatePayload {
  name: string;
  icon?: string | null;
  description?: string | null;
  layoutMode?: IslandLayoutMode;
  panels?: IslandPanel[];
  isShared?: boolean;
}


// ── 업무 등록 시 Jira + Confluence 동시 생성 (프로비저닝) ────────────────────────
export interface JiraIssueLookupItem {
  key: string;
  summary: string;
}

export interface JiraIssueLookupResult {
  status: 'ok' | 'offline' | 'error';
  detail: string;
  items: JiraIssueLookupItem[];
}

export interface ProvisionDefaults {
  jiraEnabled: boolean;
  confluenceEnabled: boolean;
  projectKey: string;
  issueType: string;
  priority: string;
  labels: string[];
  components: string[];
  summary: string;
  description: string;
  spaceKey: string;
  parentPageId: string;
  pageTitle: string;
  reporter: string;
  detail: string;
  /** Jira 계층 — epicKey = Epic Link, parentKey = Sub-task 의 상위 이슈. */
  epicKey: string;
  parentKey: string;
  /** Confluence 문서 기여자(Contributor) 기본값 — 로그인 사용자 자신. */
  contributor: string;
  /** 기본값 출처 — 'user' 면 지난번 내가 쓴 조건을 불러온 것. */
  presetSource: 'none' | 'settings' | 'user';
}

export interface ProvisionRequest {
  workItemId: string;
  createJira?: boolean;
  createConfluence?: boolean;
  projectKey?: string;
  issueType?: string;
  priority?: string;
  labels?: string[];
  components?: string[];
  summary?: string;
  description?: string;
  epicKey?: string;
  parentKey?: string;
  spaceKey?: string;
  /** 제목 검색 없이 기존 문서를 직접 지정 — 지정하면 이 문서를 그대로 갱신한다. */
  pageId?: string;
  parentPageId?: string;
  pageTitle?: string;
  pageBody?: string;
  /** Confluence 문서에 붙일 라벨 — Jira 쪽 labels 와 별개(문서 전용). */
  confluenceLabels?: string[];
  /** 문서 기여자 표시명 — 비우면 로그인 사용자 자신으로 채워진다. */
  contributor?: string;
  /** 이번에 쓴 기준 조건을 내 기본값으로 저장할지 (다음 등록에서 자동 채움). */
  rememberPreset?: boolean;
}

export interface ProvisionResult {
  status: 'ok' | 'partial' | 'error' | 'offline';
  detail: string;
  jiraKey?: string | null;
  jiraUrl?: string | null;
  jiraDetail: string;
  confluencePageId?: string | null;
  confluenceUrl?: string | null;
  confluenceDetail: string;
  /** 실패 원인이 내 인증(토큰/세션) 문제인지 — true 면 재시도 전에 연결 설정을
   *  고칠 수 있는 카드를 보여준다(빈 필드 같은 입력값 문제와 구분). */
  jiraAuthIssue: boolean;
  confluenceAuthIssue: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Observability (관측 스택 지표 대시보드) + 인시던트 알람 인박스
// ─────────────────────────────────────────────────────────────────────────────

/** 라벨 1쌍. 백엔드가 dict 대신 배열로 주는 이유는 axios 인터셉터의
 *  snake_case→camelCase 변환이 Prometheus 라벨명(`job_name` 등)을 훼손하기 때문이다. */
export interface LabelPair {
  k: string;
  v: string;
}

export type ObservabilityModuleStatus = 'active' | 'planned';
export type MetricState = 'ok' | 'warning' | 'critical' | 'unknown';
export type FetchStatus = 'ok' | 'error' | 'offline';
export type DataSource = 'live' | 'snapshot' | 'offline';

export interface ObservabilityModule {
  id: string;
  key: string;
  label: string;
  description?: string | null;
  icon?: string | null;
  status: ObservabilityModuleStatus;
  enabled: boolean;
  sortOrder: number;
  metricCount: number;
}

export interface ObservabilityMetric {
  id: string;
  moduleKey: string;
  key: string;
  label: string;
  category: string;
  promql: string;
  unit: string;
  displayType: string;
  thresholds?: string | null;
  invert: boolean;
  help?: string | null;
  docUrl?: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface ObservabilityMetricInput {
  moduleKey: string;
  key: string;
  label: string;
  category: string;
  promql: string;
  unit: string;
  displayType: string;
  thresholds?: string | null;
  invert: boolean;
  help?: string | null;
  docUrl?: string | null;
  sortOrder: number;
  enabled: boolean;
}

export interface ObservabilityMetricValue {
  metricId: string;
  key: string;
  label: string;
  category: string;
  unit: string;
  displayType: string;
  thresholds?: string | null;
  invert: boolean;
  help?: string | null;
  docUrl?: string | null;
  promql: string;
  state: MetricState;
  value?: number | null;
  labels: LabelPair[];
  seriesCount: number;
  status: FetchStatus;
  error?: string | null;
}

export interface ObservabilityMetricValuesResponse {
  module: string;
  clusterId?: string | null;
  source: DataSource;
  collectedAt?: string | null;
  detail?: string | null;
  data: ObservabilityMetricValue[];
}

export interface PromRule {
  group: string;
  file?: string | null;
  name: string;
  type: string;
  state?: string | null;
  severity?: string | null;
  duration?: number | null;
  query: string;
  health?: string | null;
  lastError?: string | null;
  evaluationTime?: number | null;
  lastEvaluation?: string | null;
  activeAlerts: number;
  labels: LabelPair[];
  annotations: LabelPair[];
}

export interface PromTarget {
  job: string;
  instance: string;
  health: string;
  scrapePool?: string | null;
  scrapeUrl?: string | null;
  lastScrape?: string | null;
  lastScrapeDuration?: number | null;
  lastError?: string | null;
  labels: LabelPair[];
}

export interface PromActiveAlert {
  alertname: string;
  state: string;
  severity?: string | null;
  namespace?: string | null;
  resource?: string | null;
  summary?: string | null;
  activeAt?: string | null;
  value?: string | null;
  origin: string;
  labels: LabelPair[];
  annotations: LabelPair[];
}

export interface PromViewResponse {
  clusterId?: string | null;
  source: DataSource;
  collectedAt?: string | null;
  detail?: string | null;
  rules: PromRule[];
  targets: PromTarget[];
  alerts: PromActiveAlert[];
}

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'firing' | 'resolved';

export interface AlertEvent {
  id: string;
  clusterId?: string | null;
  clusterName?: string | null;
  source: string;
  fingerprint: string;
  alertname: string;
  severity: AlertSeverity;
  severitySource: string;
  status: AlertStatus;
  namespace?: string | null;
  resource?: string | null;
  summary?: string | null;
  description?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  generatorUrl?: string | null;
  occurrences: number;
  notifyCount: number;
  suppressedCount: number;
  lastNotifiedAt?: string | null;
  acked: boolean;
  ackBy?: string | null;
  ackAt?: string | null;
  receivedAt: string;
  labels: LabelPair[];
  annotations: LabelPair[];
  rawJson?: string | null;
  analysisId?: string | null;
  analysisStatus?: 'queued' | 'running' | 'done' | 'failed' | 'skipped' | null;
}

export interface AlertEventListResponse {
  data: AlertEvent[];
  total: number;
}

export interface AlertStats {
  firing: number;
  resolved: number;
  critical: number;
  warning: number;
  info: number;
  unacked: number;
  total: number;
}

export type AlertNotifyMode = 'all' | 'users' | 'none';
export type AlertDedupMode = 'first_only' | 'summarize';

export interface AlertNotifyRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  clusterId?: string | null;
  moduleKey?: string | null;
  alertnamePattern?: string | null;
  namespacePattern?: string | null;
  labelMatchers: LabelPair[];
  severityMin?: AlertSeverity | null;
  notifyMode: AlertNotifyMode;
  recipients: string[];
  severityOverride?: AlertSeverity | null;
  channelIds: string[];
  dedupWindowSec: number;
  dedupMode: AlertDedupMode;
}

export type AlertNotifyRuleInput = Omit<AlertNotifyRule, 'id'>;

export interface AlertSettings {
  defaultNotifyMode: AlertNotifyMode;
  defaultRecipients: string[];
  defaultSeverityMin: AlertSeverity;
  dedupWindowSec: number;
  dedupMode: AlertDedupMode;
  retentionDays: number;
}

// ── LLM 게이트웨이 설정 (Settings → AI/LLM) ───────────────────────────
// 주의: axios 인터셉터가 응답 키를 snake→camel 로 변환하므로 여기 타입은 camelCase.
// routing 의 purpose 키도 응답에서는 camelCase 가 된다 (요청 시 자동 역변환).

export type LlmProviderType = 'ollama' | 'openai_compat';

/** camelCase purpose 키 (백엔드 snake_case 와 인터셉터로 상호 변환됨) */
export type LlmPurpose =
  | 'chat'
  | 'incidentAnalysis'
  | 'reviewSummary'
  | 'archDoc'
  | 'trends'
  | 'embedding';

export interface LlmProfile {
  name: string;
  provider: LlmProviderType;
  baseUrl: string;
  model: string;
  /** "credential:<name>" | "env:<VAR>" | "" — 키 원문은 절대 오가지 않는다 */
  apiKeyRef: string;
  timeoutSeconds: number;
  maxConcurrency: number;
  enabled: boolean;
}

export interface LlmRoute {
  primary: string;
  fallback: string | null;
}

export interface LlmSettings {
  language: 'ko' | 'en';
  analyzerBackend: 'claude' | 'local_llm' | 'rule_based';
  embeddingModel: string;
  profiles: LlmProfile[];
  routing: Record<string, LlmRoute>;
}

export interface LlmHealthEntry {
  profile: string;
  provider: LlmProviderType;
  enabled: boolean;
  baseUrl: string;
  status: 'online' | 'offline';
  model: string;
  detail: string;
  latencyMs: number;
}

export interface LlmTestResult {
  status: string;
  latencyMs: number;
  model: string;
  answerPreview: string;
  error: string | null;
}

export interface LlmCredentialSummary {
  name: string;
  hint: string;
  createdAt: string | null;
}

export interface LlmUsageBucket {
  profile: string;
  purpose: string;
  bucket: string; // YYYYMMDDHH (UTC)
  count: number;
  errors: number;
  avgLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
}

// ── 알람 AI 자동 분석 (Phase 2) ───────────────────────────────────────

export interface LlmAnalysisScopeRule {
  id: string;
  priority: number;
  enabled: boolean;
  sources: Array<'alert' | 'k8s_event'>;
  clusterId: string | null;
  namespacePattern: string;
  alertnamePattern: string;
  severityMin: 'info' | 'warning' | 'critical';
  maxPerHour: number;
  notifyAnalysis: boolean;
  includeLogs: boolean;
}

export interface LlmAnalysisScope {
  enabled: boolean;
  debounceSeconds: number;
  globalMaxPerHour: number;
  rules: LlmAnalysisScopeRule[];
}

export interface AlertIncidentAnalysis {
  id: string;
  alertEventId: string | null;
  k8sEventId: string | null;
  clusterId: string | null;
  namespace: string | null;
  resource: string | null;
  trigger: 'alert' | 'k8s_event' | 'manual';
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  severity: string | null;
  rootCause: string | null;
  suggestedActions: string[];
  relatedRunbooks: string[];
  confidence: number | null;
  citations: RagCitation[];
  analyzedBy: string | null;
  matchedRuleId: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

// ── 홈/네비게이션 개인화 (user_settings 의 home_prefs 키) ─────────────────────
export interface HomePrefs {
  defaultHomeTab?: 'work' | 'platform' | null;
  pinnedPaths: string[];
}

export type HomePrefsUpdate = Partial<HomePrefs>;
