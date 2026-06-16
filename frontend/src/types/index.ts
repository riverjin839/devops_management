// Status types
export type Status = 'healthy' | 'warning' | 'critical' | 'pending';

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
  // 사이드바 표시용 사용자 지정 아이콘 — lucide-react 컴포넌트 이름 (예: "Server") 또는 emoji 1자.
  // null/empty 면 status 기반 기본 아이콘으로 fallback.
  icon?: string | null;
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

export interface ClusterManageUpdate {
  region?: string;
  operationLevel?: string;
  maxPod?: number;
  ciliumConfig?: string;
  cidr?: string;
  internalIps?: string;
  firstHost?: string;
  lastHost?: string;
  podCidr?: string;
  podFirstHost?: string;
  podLastHost?: string;
  svcCidr?: string;
  svcFirstHost?: string;
  svcLastHost?: string;
  bond0Ip?: string;
  bond0Mac?: string;
  bond1Ip?: string;
  bond1Mac?: string;
  description?: string;
  nodeCount?: number;
  hostname?: string;
  bgpEnabled?: boolean;
  asNumber?: string;
  icon?: string | null;
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
  startDate: string;
  endDate: string;
  status?: SprintStatus;
}

export interface SprintUpdate extends Partial<SprintCreate> {}

export interface SprintListResponse {
  data: Sprint[];
  total: number;
}

// Work Item Board — 업무 통합 모델 (작업/이슈/회의/교육/기타)
export type WorkItemType = 'task' | 'issue' | 'meeting' | 'training' | 'etc';
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
  remarks?: string;
  /** 통합지식 service tag — ui_settings.serviceCatalog 의 slug 와 매칭. */
  service?: string;
  /** Phase B — service 하위 component (예: k8s→api-server). serviceCatalog.ts 의
   *  COMPONENT_BY_SERVICE 추천 enum + 직접 입력 escape hatch. service 없을 때 null. */
  component?: string;
  /** Confluence 문서 링크 (운영 페이지) */
  confluenceUrl?: string;
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
  /** 전체 참석(회의 등) — true 면 모든 사용자의 개인 일정(Work To Do)에 표시. */
  allAttendees?: boolean;
  /** Jira 연동 — 가져온 이슈 linkage (없으면 일반 work item). */
  jiraIssueKey?: string | null;
  jiraUrl?: string | null;
  jiraStatus?: string | null;
  jiraSyncedAt?: string | null;
  jiraWatchers?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

// ── Jira 연동 ──────────────────────────────────────────────────────────────────
export interface JiraConfig {
  baseUrl: string;
  enabled: boolean;
  verifyTls: boolean;
  defaultProjectKey?: string | null;
}

export interface JiraCredentialStatus {
  configured: boolean;
  jiraAccount?: string | null;
  lastVerifiedAt?: string | null;
}

export interface JiraTestResult {
  ok: boolean;
  detail: string;
  displayName?: string | null;
}

export interface JiraImportRequest {
  scope: 'me' | 'project' | 'jql';
  projectKey?: string;
  jql?: string;
  dryRun?: boolean;
}

export interface JiraImportItemPreview {
  jiraKey: string;
  title: string;
  kanbanStatus: string;
  action: 'create' | 'update';
}

export interface JiraImportResult {
  status: 'ok' | 'offline' | 'error';
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

export interface JiraPushRequest {
  comment?: string;
  force?: boolean;
}

export interface JiraPushResult {
  status: 'ok' | 'conflict' | 'error' | 'offline' | 'not_linked';
  detail: string;
  transitioned: boolean;
  commentAdded: boolean;
  jiraStatus?: string | null;
  availableTransitions: string[];
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
  remarks?: string;
  service?: string;
  component?: string;
  confluenceUrl?: string;
  jiraUrl?: string;
  priority?: string;
  kanbanStatus?: KanbanStatus;
  module?: WorkItemModule;
  typeLabel?: WorkItemTypeLabel;
  effortHours?: number;
  doneCondition?: string;
  parentId?: string;
  relatedWorkItemId?: string;
  /** 전체 참석(회의 등) — true 면 모든 사용자의 개인 일정(Work To Do)에 표시. */
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

export interface UiSettings {
  appTitle: string;
  navLabels: Record<string, string>;
  /** 통합지식 메뉴와 task/issue tag 에 노출되는 서비스 카탈로그.
   *  null/undefined 면 프론트의 SERVICE_CATALOG 기본값으로 폴백. */
  serviceCatalog?: ServiceCatalogEntry[];
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

/** Settings 의 '서비스' 탭에서 사용자 정의되는 서비스 한 항목.
 *  ⚠ 별도의 ServiceCatalogItem (요약 카운트용) 과 혼동 주의 — 이 타입은 사이드바·태그용. */
export interface ServiceCatalogEntry {
  /** URL slug 및 service_entries.service 와 매칭되는 키 (예: 'k8s', 'keycloak'). */
  slug: string;
  /** 사이드바·드롭다운에 표시될 한글 라벨. */
  label: string;
  /** lucide-react 아이콘 이름 (예: 'Box', 'Key'). 비어있으면 BookOpen. */
  icon?: string;
  /** 카드/뱃지 색상 토큰 (예: 'sky', 'emerald'). */
  color?: string;
  /** 짧은 설명 (모달/툴팁용). */
  description?: string;
  /** 정렬 우선순위 (작을수록 위). */
  sortOrder?: number;
}

export interface OperationLevelItem {
  value: string;
  label: string;
  /** tailwind 컬러 키 — red/amber/emerald/sky/slate/purple/blue/yellow/pink/cyan/violet/orange/muted */
  color: string;
  /** 클러스터 카드/행 앞에 표시될 이모지 1자. 비어있으면 EMOJI_OPTIONS 의 fallback 사용. */
  icon?: string;
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
}

export interface OpsNoteUpdate extends Partial<OpsNoteCreate> {}

export interface OpsNoteListResponse {
  data: OpsNote[];
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

// 기능별 접근 제어 — { "<feature>": { roles, users } }
export interface FeatureAccessRule {
  roles: string[];
  users: string[];   // username 또는 display_name
}
export type FeatureAccessMap = Record<string, FeatureAccessRule>;

// Assignee (담당자)
export interface Assignee {
  name: string;
  employeeId?: string;
  email?: string;
  ip?: string;
  primaryRole?: string;
  secondaryRole?: string;
}

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

export interface InfraSyncResult {
  success: boolean;
  created: number;
  updated: number;
  failed: number;
  retryCount: number;
  partialFailure: boolean;
  errors: string[];
  total: number;
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
}

export interface EtcdSystemdCollectResponse {
  clusterId: string;
  stored: boolean;
  changed: number;
  hosts: EtcdSystemdPerHost[];
  componentKey?: string;
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
  link_kind?: string | null;
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
  all_ips?: NicAllIp[];
  error?: string | null;
  // 진단용 — status=ok 인데 interfaces 가 0개거나 status=error 일 때 백엔드가 채움.
  // 'ip -j' 미지원 / 권한 부족 / 출력 비어있음 진단에 사용.
  raw_stdout?: string | null;
  raw_stderr?: string | null;
  exit_code?: number | null;
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

// ── Service Entries (서비스별 히스토리/지식관리) ─────────────────
export type ServiceEntryKind = 'note' | 'guide' | 'troubleshoot' | 'history' | 'link';

export interface ServiceEntry {
  id: string;
  service: string;
  clusterId?: string | null;
  clusterName?: string | null;
  kind: ServiceEntryKind;
  title: string;
  content: string;
  url?: string | null;
  severity?: string | null;
  occurredAt?: string | null;
  tags?: string[] | null;
  pinned: boolean;
  author?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta?: Record<string, any> | null;
  createdAt: string;
  updatedAt: string;
}

export type ServiceEntryCreate = Omit<ServiceEntry, 'id' | 'createdAt' | 'updatedAt' | 'clusterName'>;
export type ServiceEntryUpdate = Partial<Omit<ServiceEntryCreate, 'service'>>;

export interface ServiceCatalogItem {
  service: string;
  total: number;
  byKind: Record<string, number>;
  lastUpdated?: string | null;
}
export interface ServiceCatalogResponse { services: ServiceCatalogItem[] }
export interface ServiceEntryListResponse { data: ServiceEntry[]; total: number }

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
  thresholdFields: DeepCheckFieldSpec[];
  paramFields: DeepCheckFieldSpec[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultThresholds: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultParams: Record<string, any>;
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
  createdAt: string;
  updatedAt: string;
}

export type DeepCheckDefinitionInput = Omit<
  DeepCheckDefinition,
  'id' | 'createdAt' | 'updatedAt'
>;

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
  definitionId: string;
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
  isBuiltin: boolean;
  enabled: boolean;
  sortOrder: number;
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
  enabled?: boolean;
  sortOrder?: number;
}

export interface LakeServiceTypeUpdate {
  label?: string;
  category?: string;
  defaultPath?: string;
  description?: string | null;
  icon?: string | null;
  enabled?: boolean;
  sortOrder?: number;
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
  serviceType: LakeServiceType;
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
export interface K8sCrdInfo {
  name: string;
  group: string;
  kind: string;
  plural: string;
  scope: string; // Namespaced | Cluster
  versions: string[];
  version: string;
  ageSeconds?: number | null;
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
}
export interface K8sPodsResponse { count: number; truncated: boolean; items: K8sPodRichRow[] }

// ── K8s 자원 관리 (allocation: request vs 사용량 slack) ───────────────────────
// CPU 는 millicores(int), MEM 은 bytes(int). *Display 는 사람이 읽는 문자열.
export interface AllocNodeRow {
  name: string;
  roles: string[];
  unschedulable: boolean;
  podCount: number;
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
export interface AllocNodesResponse { count: number; items: AllocNodeRow[]; metricsAvailable: boolean }

export interface AllocSummary {
  nodeCount: number;
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
export interface AllocNamespacesResponse {
  count: number;
  items: AllocNamespaceRow[];
  summary: AllocSummary;
  metricsAvailable: boolean;
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
export type ReactionTargetType = 'ops_note' | 'work_item_comment' | 'work_guide';

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
