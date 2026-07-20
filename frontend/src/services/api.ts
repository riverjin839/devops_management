import axios, { type InternalAxiosRequestConfig } from 'axios';
import { Cluster, Addon, CheckLog, SummaryStats, ApiResponse, PaginatedResponse, Playbook, PlaybookRunResult, PlaybookSshCreds, AgentChatRequest, AgentChatResponse, AgentHealthResponse, MetricCard, MetricQueryResult, ClusterItem, WorkItem, WorkItemType, WorkItemListResponse, WorkItemCreate, WorkItemUpdate, WorkItemStatusResponse, KanbanStatus, UiSettings, ClusterLinksPayload, WorkGuide, WorkGuideCreate, WorkGuideUpdate, WorkGuideListResponse, OpsNote, OpsNoteCreate, OpsNoteUpdate, OpsNoteListResponse, MindMap, MindMapListItem, MindMapCreate, MindMapUpdate, MindMapNode, MindMapNodeCreate, MindMapNodeUpdate, ManagementServer, ManagementServerCreate, ManagementServerUpdate, ManagementServerListResponse, TopologyTraceRequest, TopologyTraceResponse, TrendDigest, TrendItem, TrendSource, ClusterTrendsResponse, ReleaseNotesResponse, CheckMatrixItem, CheckMatrixItemInput, CheckMatrixGrid, CheckMatrixHistory, CheckMatrixSettings } from '@/types';
import { isDebugEnabled, useDebugStore } from '@/stores/debugStore';
import { getAuthToken, clearAuthSession, type AuthUser } from '@/stores/authStore';

// snake_case → camelCase 변환 (Backend는 snake_case, Frontend는 camelCase)
function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

// camelCase → snake_case 변환 (Frontend → Backend 요청 시)
function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function convertKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(convertKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([key, value]) => [
        toCamelCase(key),
        convertKeys(value),
      ])
    );
  }
  return obj;
}

function convertKeysToSnake(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(convertKeysToSnake);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([key, value]) => [
        toSnakeCase(key),
        convertKeysToSnake(value),
      ])
    );
  }
  return obj;
}

const api = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor - camelCase → snake_case 자동 변환 + debug 로깅
type DebugConfig = InternalAxiosRequestConfig & { __debugStart?: number };
api.interceptors.request.use(
  (config) => {
    // Attach JWT if present. Skip the snake_case conversion for the login
    // payload (it goes to /auth/login, body is already snake_case keys).
    const token = getAuthToken();
    if (token) {
      config.headers.set('Authorization', `Bearer ${token}`);
    }
    // FormData/Blob/File 은 own-enumerable 프로퍼티가 없어 convertKeysToSnake 가
    // 빈 객체({})로 뭉개버린다 — multipart 업로드(backup import 등)가 깨지므로 건너뛴다.
    if (config.data && typeof config.data === 'object'
      && !(config.data instanceof FormData) && !(config.data instanceof Blob)) {
      config.data = convertKeysToSnake(config.data);
    }
    if (isDebugEnabled('global')) {
      (config as DebugConfig).__debugStart = performance.now();
      useDebugStore.getState().pushEvent({
        kind: 'request',
        method: config.method?.toUpperCase(),
        url: config.url,
        payload: config.data,
      });
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor - snake_case → camelCase 자동 변환 + debug 로깅
api.interceptors.response.use(
  (response) => {
    if (response.data && typeof response.data === 'object' && !(response.data instanceof Blob)) {
      response.data = convertKeys(response.data);
    }
    if (isDebugEnabled('global')) {
      const start = (response.config as DebugConfig).__debugStart;
      useDebugStore.getState().pushEvent({
        kind: 'response',
        method: response.config.method?.toUpperCase(),
        url: response.config.url,
        status: response.status,
        durationMs: start ? Math.round(performance.now() - start) : undefined,
      });
    }
    return response;
  },
  (error) => {
    // 401 from any endpoint other than the login itself means the token is
    // missing/expired/invalid — drop the session so AuthGate routes back to
    // the login screen. Login's own 401 (bad credentials) is left for the
    // form to display.
    const url: string | undefined = error?.config?.url;
    if (error?.response?.status === 401 && !url?.endsWith('/auth/login')) {
      clearAuthSession();
    }
    if (isDebugEnabled('global')) {
      const start = (error?.config as DebugConfig | undefined)?.__debugStart;
      const rawDetail = error?.response?.data?.detail;
      const detailStr = typeof rawDetail === 'string'
        ? rawDetail
        : rawDetail !== undefined && rawDetail !== null
          ? JSON.stringify(rawDetail)
          : undefined;
      useDebugStore.getState().pushEvent({
        kind: 'error',
        method: error?.config?.method?.toUpperCase(),
        url: error?.config?.url,
        status: error?.response?.status,
        durationMs: start ? Math.round(performance.now() - start) : undefined,
        message: detailStr ?? (typeof error?.message === 'string' ? error.message : String(error?.message ?? '')),
      });
    }
    console.error('API Error:', error.response?.data || error.message);
    return Promise.reject(error);
  }
);

// ── Auth API ──────────────────────────────────────────────────────────────
// Response keys are camelCase post-interceptor; request keys are camelCase
// here and auto-converted to snake_case by the request interceptor.
export interface LoginResponse { accessToken: string; tokenType: string; user: AuthUser }

export type UserRoleApi = 'admin' | 'operator' | 'viewer';

export const authApi = {
  login: (username: string, password: string) =>
    api.post<LoginResponse>('/auth/login', { username, password }),
  me: () => api.get<AuthUser>('/auth/me'),
  changeMyPassword: (currentPassword: string, newPassword: string) =>
    api.post<AuthUser>('/auth/me/password', { currentPassword, newPassword }),
  listUsers: () => api.get<AuthUser[]>('/auth/users'),
  createUser: (payload: { username: string; password: string; role: UserRoleApi; displayName?: string }) =>
    api.post<AuthUser>('/auth/users', payload),
  deleteUser: (id: string) => api.delete(`/auth/users/${id}`),
  updateUserRole: (id: string, role: UserRoleApi) =>
    api.put<AuthUser>(`/auth/users/${id}/role`, { role }),
  resetPassword: (id: string, newPassword: string) =>
    api.post<AuthUser>(`/auth/users/${id}/password`, { newPassword }),
};

// ── Audit logs API ────────────────────────────────────────────────────────
export interface AuditLogQuery {
  page?: number;
  pageSize?: number;
  action?: string;
  actorUsername?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export const auditLogsApi = {
  list: (params: AuditLogQuery = {}) => {
    // Manual snake_case for query params so axios doesn't double-convert.
    const q: Record<string, string | number> = {};
    if (params.page) q.page = params.page;
    if (params.pageSize) q.page_size = params.pageSize;
    if (params.action) q.action = params.action;
    if (params.actorUsername) q.actor_username = params.actorUsername;
    if (params.status) q.status = params.status;
    if (params.dateFrom) q.date_from = params.dateFrom;
    if (params.dateTo) q.date_to = params.dateTo;
    return api.get<import('@/types').AuditLogListResponse>('/audit-logs', { params: q });
  },
};

export const releaseNotesApi = {
  list: () => api.get<ReleaseNotesResponse>('/release-notes'),
};

// Clusters API
export const clustersApi = {
  getAll: () => api.get<ApiResponse<Cluster[]>>('/clusters'),
  getById: (id: string) => api.get<ApiResponse<Cluster>>(`/clusters/${id}`),
  create: (data: Partial<Cluster> & { kubeconfigContent?: string; skipConnectivityCheck?: boolean }) =>
    api.post<ApiResponse<Cluster>>('/clusters', data),
  update: (id: string, data: Partial<Cluster>) => api.put<ApiResponse<Cluster>>(`/clusters/${id}`, data),
  delete: (id: string) => api.delete(`/clusters/${id}`),
  reorder: (clusterIds: string[]) =>
    api.post<{ updated: number }>('/clusters/reorder', { clusterIds }),
  getKubeconfig: (id: string) =>
    api.get<{ content: string; path: string }>(`/clusters/${id}/kubeconfig`),
  updateKubeconfig: (id: string, content: string) =>
    api.put<{ content: string; path: string }>(`/clusters/${id}/kubeconfig`, { content }),
  verify: (id: string) =>
    api.post<{ ok: boolean; cluster_name: string; results: { check: string; ok: boolean | null; detail: string }[] }>(`/clusters/${id}/verify`),
  autoUpdate: (id: string, opts?: { dryRun?: boolean; signal?: AbortSignal }) =>
    api.post<{
      clusterId: string;
      clusterName: string;
      dryRun?: boolean;
      updated?: Record<string, unknown>;
      current?: Record<string, unknown>;
      proposed?: Record<string, unknown>;
      diff?: { field: string; current: unknown; proposed: unknown; changed: boolean }[];
      warnings: string[];
    }>(`/clusters/${id}/auto-update`, undefined, {
      params: opts?.dryRun ? { dry_run: 'true' } : undefined,
      signal: opts?.signal,
    }),
  getCiliumConfig: (id: string) =>
    api.get<{ live: string | null; stored: string | null; source: string; error: string | null }>(`/clusters/${id}/cilium-config`),
  updateCustomValues: (id: string, values: Record<string, unknown>) =>
    api.put<{ clusterId: string; customValues: Record<string, unknown> }>(
      `/clusters/${id}/custom-values`, { values },
    ),
};

// 백업 / 복구
export interface BackupMetaTable { name: string; rows: number; isLog: boolean }
export interface BackupMetaResponse { version: string; totalRows: number; tables: BackupMetaTable[]; logTables: string[] }
export interface BackupImportTableDiff {
  name: string; incoming: number; existing: number;
  insertCount: number; updateCount: number; unchangedCount: number; deleteCandidates: number;
}
export interface BackupImportDiff {
  version?: string | null; createdAt?: string | null;
  backupOptions: Record<string, unknown>;
  totalIncoming: number; totalExisting: number;
  tables: BackupImportTableDiff[];
}
export interface BackupImportResponse {
  dryRun: boolean; mode: 'merge' | 'replace';
  inserted: number; updated: number; deleted: number;
  errors: string[]; diff: BackupImportDiff;
}

export const backupApi = {
  meta: () => api.get<BackupMetaResponse>('/backup/meta'),
  // export → blob
  exportDownload: (includeLogs = false, includeSensitive = false) =>
    api.get('/backup/export', {
      params: { include_logs: includeLogs, include_sensitive: includeSensitive },
      responseType: 'blob',
    }),
  importPreview: (file: File, mode: 'merge' | 'replace', includeLogs: boolean) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', mode);
    fd.append('include_logs', String(includeLogs));
    return api.post<BackupImportResponse>('/backup/import/preview', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 5 * 60_000,   // 대용량 파싱 고려 5분
    });
  },
  importApply: (file: File, mode: 'merge' | 'replace', includeLogs: boolean, confirm: boolean) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', mode);
    fd.append('include_logs', String(includeLogs));
    fd.append('confirm', String(confirm));
    return api.post<BackupImportResponse>('/backup/import', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 10 * 60_000,
    });
  },
};

// Cluster 커스텀 컬럼 (Confluence 스타일)
export const clusterCustomFieldsApi = {
  list: () =>
    api.get<{ data: import('@/types').ClusterCustomField[] }>('/cluster-custom-fields'),
  create: (data: import('@/types').ClusterCustomFieldCreate) =>
    api.post<import('@/types').ClusterCustomField>('/cluster-custom-fields', data),
  update: (id: string, data: import('@/types').ClusterCustomFieldUpdate) =>
    api.put<import('@/types').ClusterCustomField>(`/cluster-custom-fields/${id}`, data),
  delete: (id: string) =>
    api.delete(`/cluster-custom-fields/${id}`),
};

// Work item 커스텀 필드
export const workItemCustomFieldsApi = {
  list: () =>
    api.get<{ data: import('@/types').WorkItemCustomField[] }>('/work-item-custom-fields'),
  create: (data: import('@/types').WorkItemCustomFieldCreate) =>
    api.post<import('@/types').WorkItemCustomField>('/work-item-custom-fields', data),
  update: (id: string, data: import('@/types').WorkItemCustomFieldUpdate) =>
    api.put<import('@/types').WorkItemCustomField>(`/work-item-custom-fields/${id}`, data),
  delete: (id: string) =>
    api.delete(`/work-item-custom-fields/${id}`),
};

// Versions API — 클러스터 컴포넌트 버전/설정 스냅샷 수집 & 히스토리
export interface ComponentSnapshot {
  id: string;
  component: string;
  category: string | null;
  version: string | null;
  data: Record<string, unknown>;
  contentHash?: string;
  collectedAt: string;
}

export interface VersionGraphNode {
  id: string;
  label: string;
  type: 'cluster' | 'category' | 'component' | 'flag';
  category?: string;
  version?: string | null;
  value?: string;
  collectedAt?: string;
}

export interface VersionGraphEdge {
  source: string;
  target: string;
  type: 'contains' | 'param' | 'configures' | 'replaces';
}

export const versionsApi = {
  collect: (clusterId: string, signal?: AbortSignal) =>
    api.post<{ clusterId: string; changed: number; errors: string[]; collectedAt: string }>(
      `/clusters/${clusterId}/collect-versions`, undefined, { signal },
    ),
  collectEtcdSystemd: (clusterId: string, payload: import('@/types').EtcdSystemdCollectRequest, signal?: AbortSignal) => {
    const n = payload.hosts.length;
    const parallel = payload.parallelism ?? 10;
    const perHost = ((payload.connectTimeout ?? 8) + 25) * 1000;
    const est = Math.ceil(n / parallel) * perHost + 10_000;
    const timeout = Math.max(60_000, Math.min(est, 30 * 60_000));
    return api.post<import('@/types').EtcdSystemdCollectResponse>(
      `/clusters/${clusterId}/collect-etcd-systemd`, payload, { signal, timeout },
    );
  },
  collectKernelParams: (
    clusterId: string,
    payload: import('@/types').KernelParamsCollectRequest,
    signal?: AbortSignal,
  ) => {
    const n = payload.hosts.length;
    const parallel = payload.parallelism ?? 10;
    const perHost = ((payload.connectTimeout ?? 8) + 20) * 1000;
    const est = Math.ceil(n / parallel) * perHost + 10_000;
    const timeout = Math.max(60_000, Math.min(est, 30 * 60_000));
    return api.post<import('@/types').KernelParamsCollectResponse>(
      `/clusters/${clusterId}/collect-kernel-params`, payload, { signal, timeout },
    );
  },
  collectEtcdctlConfig: (
    clusterId: string,
    payload: import('@/types').EtcdctlConfigCollectRequest,
    signal?: AbortSignal,
  ) => {
    const n = payload.hosts.length;
    const perHost = ((payload.connectTimeout ?? 8) + 20) * 1000;
    const est = Math.ceil(n / 10) * perHost + 10_000;
    const timeout = Math.max(60_000, Math.min(est, 30 * 60_000));
    return api.post<import('@/types').EtcdctlConfigCollectResponse>(
      `/clusters/${clusterId}/collect-etcdctl-config`, payload, { signal, timeout },
    );
  },
  collectNodeNics: (
    clusterId: string,
    payload: import('@/types').NodeNicsCollectRequest,
    signal?: AbortSignal,
  ) => {
    const n = payload.hosts.length;
    const parallel = payload.parallelism ?? 10;
    const perHost = ((payload.connectTimeout ?? 8) + 18) * 1000;
    const est = Math.ceil(n / parallel) * perHost + 10_000;
    const timeout = Math.max(60_000, Math.min(est, 30 * 60_000));
    return api.post<import('@/types').NodeNicsCollectResponse>(
      `/clusters/${clusterId}/collect-node-nics`, payload, { signal, timeout },
    );
  },
  collectMinio: (clusterId: string, signal?: AbortSignal) =>
    api.post<import('@/types').MinioCollectResponse>(
      `/clusters/${clusterId}/collect-minio`, undefined, { signal, timeout: 120_000 },
    ),
  collectKubeletConfig: (
    clusterId: string,
    payload: import('@/types').KubeletConfigCollectRequest,
    signal?: AbortSignal,
  ) => {
    const n = payload.hosts.length;
    const parallel = payload.parallelism ?? 10;
    const perHost = ((payload.connectTimeout ?? 8) + 20) * 1000;
    const est = Math.ceil(n / parallel) * perHost + 10_000;
    const timeout = Math.max(60_000, Math.min(est, 30 * 60_000));
    return api.post<import('@/types').KubeletConfigCollectResponse>(
      `/clusters/${clusterId}/collect-kubelet-config`, payload, { signal, timeout },
    );
  },
  /** 현재 스냅샷 CSV 내보내기. detail 로 컬럼 풍부도 조절. */
  exportCsv: (
    clusterId: string,
    opts: { detail?: 'summary' | 'full' | 'none'; categories?: string[]; components?: string[] } = {},
    signal?: AbortSignal,
  ) => {
    const q = new URLSearchParams();
    if (opts.detail) q.set('detail', opts.detail);
    if (opts.categories?.length) q.set('categories', opts.categories.join(','));
    if (opts.components?.length) q.set('components', opts.components.join(','));
    return api.get<Blob>(
      `/clusters/${clusterId}/versions/export.csv?${q.toString()}`,
      { signal, responseType: 'blob' },
    );
  },
  current: (clusterId: string) =>
    api.get<{ clusterId: string; components: ComponentSnapshot[] }>(
      `/clusters/${clusterId}/versions/current`,
    ),
  history: (clusterId: string, component?: string, limit = 200) => {
    const q = new URLSearchParams();
    if (component) q.set('component', component);
    q.set('limit', String(limit));
    return api.get<{ clusterId: string; component: string | null; snapshots: ComponentSnapshot[] }>(
      `/clusters/${clusterId}/versions/history?${q.toString()}`,
    );
  },
  diff: (clusterId: string, fromId: string, toId: string) =>
    api.get<{
      from: { id: string; component: string; version: string | null; collectedAt: string };
      to: { id: string; component: string; version: string | null; collectedAt: string };
      versionChanged: boolean;
      changes: { key: string; from: unknown; to: unknown }[];
    }>(`/clusters/${clusterId}/versions/diff?from=${fromId}&to=${toId}`),
  graph: (clusterId: string) =>
    api.get<{
      clusterId: string;
      clusterName: string;
      nodes: VersionGraphNode[];
      edges: VersionGraphEdge[];
    }>(`/clusters/${clusterId}/versions/graph`),
};

// Bulk SSH/SCP API
export interface NodeSummary {
  name: string;
  internalIp?: string | null;
  externalIp?: string | null;
  roles: string[];
  ready: boolean;
  os?: string | null;
  kubeletVersion?: string | null;
}

export interface BulkExecResultItem {
  host: string;
  /** 사용자가 선택한 노드 이름 (있으면 host 대신 이 값을 화면에 표시) */
  name?: string | null;
  clusterId?: string | null;
  clusterName?: string | null;
  status: 'ok' | 'error' | 'timeout' | 'auth_error' | 'connect_error';
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string | null;
}

export interface BulkExecResponse {
  action: 'ssh' | 'scp';
  mode: 'sequential' | 'parallel';
  total: number;
  okCount: number;
  errorCount: number;
  totalDurationMs: number;
  results: BulkExecResultItem[];
}

export interface BulkExecRequest {
  clusterId?: string;
  action: 'ssh' | 'scp';
  targets: {
    host: string;
    username?: string;
    port?: number;
    /** 표시용 노드 이름 — 결과 테이블에 그대로 echo back 됨 */
    name?: string;
    clusterId?: string;
    clusterName?: string;
  }[];
  username: string;
  port: number;
  password?: string;
  privateKey?: string;
  command?: string;
  scpContent?: string;
  scpRemotePath?: string;
  mode: 'sequential' | 'parallel';
  parallelism: number;
  connectTimeout: number;
  execTimeout: number;
  /** 청크 단위 병렬 실행 — 대규모 배치에서 메모리/베스천 부담 완화 */
  chunkSize?: number;
  chunkPauseMs?: number;
}

export const bulkExecApi = {
  nodeList: (clusterId: string) =>
    api.get<{ clusterId: string; clusterName: string; nodes: NodeSummary[] }>(
      `/clusters/${clusterId}/node-list`,
    ),
  run: (payload: BulkExecRequest, signal?: AbortSignal) => {
    // 대규모 호스트 실행 시간 추정: 청크 수 × (exec_timeout+connect_timeout+pause) + 여유.
    // 기본 30초 timeout 은 100+ 호스트에서 바로 끊겨 에러가 됨.
    const n = payload.targets?.length ?? 0;
    const chunk = (payload as { chunkSize?: number }).chunkSize ?? 30;
    const perChunk = (payload.connectTimeout + payload.execTimeout) * 1000 + 500;
    const estimate = Math.ceil(n / chunk) * perChunk + 10_000;
    const timeout = Math.max(60_000, Math.min(estimate, 30 * 60_000));   // 1분~30분 범위
    return api.post<BulkExecResponse>('/bulk-exec/run', payload, { signal, timeout });
  },
};

// etcdctl API
export interface EtcdMasterCandidate {
  name: string;
  internalIp?: string | null;
  externalIp?: string | null;
}

export interface EtcdPreset {
  key: string;
  label: string;
  args: string;
}

export interface EtcdCtlRunResponse {
  host: string;
  status: 'ok' | 'error' | 'timeout' | 'auth_error' | 'connect_error';
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string | null;
  executedCommand: string;
}

export interface EtcdCtlRunRequest {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  args: string;
  envFile: string;
  useEnv: boolean;
  extraEnv?: Record<string, string>;
  etcdctlPath: string;
  timeout: number;
}

export interface EtcdLogsRequest {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  unit: string;
  tail: number;
  since?: string;
  grep?: string;
}

export interface McPreset {
  key: string;
  label: string;
  args: string;
}

export interface McRunRequest {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  args: string;
  alias: string;
  mcPath: string;
  extraEnv?: Record<string, string>;
  timeout: number;
}

export const mcApi = {
  presets: (clusterId: string) =>
    api.get<{ presets: import('@/types').McEffectivePreset[] }>(`/clusters/${clusterId}/mc/presets`),
  run: (clusterId: string, payload: McRunRequest, signal?: AbortSignal) =>
    api.post<EtcdCtlRunResponse>(`/clusters/${clusterId}/mc/run`, payload, { signal }),
  getPersonalPresets: () =>
    api.get<import('@/types').McPersonalPresets>('/mc/presets/personal'),
  savePersonalPresets: (payload: import('@/types').McPersonalPresets) =>
    api.put<import('@/types').McPersonalPresets>('/mc/presets/personal', payload),
  getSharedPresets: () =>
    api.get<{ presets: McPreset[] }>('/mc/presets/shared'),
  saveSharedPresets: (presets: McPreset[]) =>
    api.put<{ presets: McPreset[] }>('/mc/presets/shared', { presets }),
};

// ── Terminal / log Appearance API ───────────────────────────────────────────
export const terminalAppearanceApi = {
  get: () =>
    api.get<import('@/types').TerminalAppearanceResponse>('/terminal-appearance'),
  save: (appearance: import('@/types').TerminalAppearance) =>
    api.put<import('@/types').TerminalAppearanceResponse>('/terminal-appearance', { appearance }),
  getShared: () =>
    api.get<{ templates: import('@/types').TerminalTemplate[] }>('/terminal-appearance/shared'),
  saveShared: (templates: import('@/types').TerminalTemplate[]) =>
    api.put<{ templates: import('@/types').TerminalTemplate[] }>('/terminal-appearance/shared', { templates }),
};

export const etcdctlApi = {
  presets: (clusterId: string) =>
    api.get<{ presets: EtcdPreset[] }>(`/clusters/${clusterId}/etcdctl/presets`),
  masters: (clusterId: string) =>
    api.get<{ clusterId: string; clusterName: string; candidates: EtcdMasterCandidate[] }>(
      `/clusters/${clusterId}/etcdctl/master-candidates`,
    ),
  run: (clusterId: string, payload: EtcdCtlRunRequest, signal?: AbortSignal) =>
    api.post<EtcdCtlRunResponse>(`/clusters/${clusterId}/etcdctl/run`, payload, { signal }),
  logs: (clusterId: string, payload: EtcdLogsRequest, signal?: AbortSignal) =>
    api.post<EtcdCtlRunResponse>(`/clusters/${clusterId}/etcdctl/logs`, payload, { signal }),
};

// Health API
export const healthApi = {
  runCheck: (clusterId: string) => api.post<ApiResponse<void>>(`/health/check/${clusterId}`),
  runAddonCheck: (clusterId: string, addonId: string) =>
    api.post<ApiResponse<void>>(`/health/check/${clusterId}/addons/${addonId}`),
  getStatus: (clusterId: string) => api.get<ApiResponse<Cluster>>(`/health/status/${clusterId}`),
  getAddons: (clusterId: string) => api.get<ApiResponse<Addon[]>>(`/health/addons/${clusterId}`),
  getSummary: () => api.get<ApiResponse<SummaryStats>>('/health/summary'),
  exportReport: (clusterId?: string, fmt: 'md' | 'csv' = 'md') =>
    api.get('/health/report', {
      params: { ...(clusterId ? { cluster_id: clusterId } : {}), fmt },
      responseType: 'blob',
    }),
  createAddon: (data: Partial<Addon>) => api.post<ApiResponse<Addon>>('/health/addons', data),
  updateAddon: (addonId: string, data: Partial<Addon>) => api.put<ApiResponse<Addon>>(`/health/addons/${addonId}`, data),
  deleteAddon: (addonId: string) => api.delete(`/health/addons/${addonId}`),
};

// History API
export const historyApi = {
  getLogs: (clusterId?: string, page = 1, pageSize = 20) =>
    api.get<PaginatedResponse<CheckLog>>('/history', {
      params: { clusterId, page, pageSize },
    }),
  exportCsv: (clusterId: string) =>
    api.get(`/history/${clusterId}/export`, { responseType: 'blob' }),
};

// Playbooks API
export const playbooksApi = {
  getAll: (clusterId?: string) =>
    api.get<ApiResponse<Playbook[]>>('/playbooks', {
      params: clusterId ? { clusterId } : {},
    }),
  getById: (id: string) => api.get<ApiResponse<Playbook>>(`/playbooks/${id}`),
  create: (data: Partial<Playbook>) => api.post<ApiResponse<Playbook>>('/playbooks', data),
  update: (id: string, data: Partial<Playbook>) =>
    api.put<ApiResponse<Playbook>>(`/playbooks/${id}`, data),
  delete: (id: string) => api.delete(`/playbooks/${id}`),
  run: (id: string, creds?: PlaybookSshCreds) =>
    api.post<PlaybookRunResult>(`/playbooks/${id}/run`, creds ?? {}),
  toggleDashboard: (id: string) => api.patch<ApiResponse<Playbook>>(`/playbooks/${id}/dashboard`),
  getDashboard: (clusterId: string) => api.get<ApiResponse<Playbook[]>>(`/playbooks/dashboard/${clusterId}`),
  exportReport: (clusterId?: string) =>
    api.get('/playbooks/report', {
      params: clusterId ? { cluster_id: clusterId } : {},
      responseType: 'blob',
    }),
};

// Ansible Playbook 파일 / Inventory — DB 자체 관리 (path 입력 대체)
export const ansibleAssetsApi = {
  // Playbook YAML files (공용 — 클러스터 무관)
  listFiles: () =>
    api.get<import('@/types').AnsiblePlaybookFile[]>('/playbook-files'),
  getFile: (id: string) =>
    api.get<import('@/types').AnsiblePlaybookFile>(`/playbook-files/${id}`),
  createFile: (data: { name: string; description?: string; content: string; tags?: string }) =>
    api.post<import('@/types').AnsiblePlaybookFile>('/playbook-files', data),
  updateFile: (id: string, data: Partial<{ name: string; description: string; content: string; tags: string }>) =>
    api.put<import('@/types').AnsiblePlaybookFile>(`/playbook-files/${id}`, data),
  deleteFile: (id: string) => api.delete(`/playbook-files/${id}`),

  // Inventories (per-cluster, multiple)
  listInventories: (clusterId?: string) =>
    api.get<import('@/types').AnsibleInventory[]>('/playbook-inventories', {
      params: clusterId ? { cluster_id: clusterId } : {},
    }),
  getInventory: (id: string) =>
    api.get<import('@/types').AnsibleInventory>(`/playbook-inventories/${id}`),
  createInventory: (data: {
    clusterId: string; name: string; description?: string; content: string; isDefault?: boolean;
  }) => api.post<import('@/types').AnsibleInventory>('/playbook-inventories', data),
  updateInventory: (id: string, data: Partial<{ name: string; description: string; content: string; isDefault: boolean }>) =>
    api.put<import('@/types').AnsibleInventory>(`/playbook-inventories/${id}`, data),
  deleteInventory: (id: string) => api.delete(`/playbook-inventories/${id}`),
};

// Agent API (AI Mode — fail-safe)
export const agentApi = {
  chat: (data: AgentChatRequest) =>
    api.post<AgentChatResponse>('/agent/chat', data, { timeout: 120000 }),
  health: () =>
    api.get<AgentHealthResponse>('/agent/health', { timeout: 5000 }),
};

// PromQL Metric Cards API
export const promqlApi = {
  getCards: (category?: string) =>
    api.get<{ data: MetricCard[] }>('/promql/cards', {
      params: category ? { category } : {},
    }),
  getCard: (id: string) => api.get<MetricCard>(`/promql/cards/${id}`),
  createCard: (data: Partial<MetricCard>) =>
    api.post<MetricCard>('/promql/cards', data),
  updateCard: (id: string, data: Partial<MetricCard>) =>
    api.put<MetricCard>(`/promql/cards/${id}`, data),
  deleteCard: (id: string) => api.delete(`/promql/cards/${id}`),
  queryCard: (id: string) =>
    api.get<MetricQueryResult>(`/promql/query/${id}`),
  queryAll: () =>
    api.get<MetricQueryResult[]>('/promql/query/all'),
  testQuery: (promql: string) =>
    api.post<MetricQueryResult>('/promql/query/test', { promql }),
  health: () =>
    api.get<{ status: string; detail?: string }>('/promql/health', { timeout: 5000 }),
};

// Cluster Items — 현황 관리 대시보드의 '아이템' 카드 (클러스터별)
export const clusterItemsApi = {
  types: () =>
    api.get<{ data: import('@/types').ClusterItemType[] }>('/cluster-item-types'),
  list: (clusterId: string) =>
    api.get<{ data: ClusterItem[] }>(`/clusters/${clusterId}/items`),
  create: (clusterId: string, data: Partial<ClusterItem>) =>
    api.post<ClusterItem>(`/clusters/${clusterId}/items`, data),
  update: (itemId: string, data: Partial<ClusterItem>) =>
    api.put<ClusterItem>(`/cluster-items/${itemId}`, data),
  remove: (itemId: string) => api.delete(`/cluster-items/${itemId}`),
  run: (itemId: string) =>
    // AI(LLM) 아이템은 응답이 길 수 있어 넉넉히 잡는다.
    api.post<ClusterItem>(`/cluster-items/${itemId}/run`, undefined, { timeout: 130000 }),
};

// Work Items API — 이슈와 작업 통합. type 필터로 둘을 구분.
export interface WorkItemFilters {
  type?: WorkItemType;
  clusterId?: string;
  assignee?: string;
  category?: string;
  priority?: string;
  kanbanStatus?: string;
  module?: string;
  startedFrom?: string;
  startedTo?: string;
  closed?: boolean;
  allAttendees?: boolean;
  sprintId?: string;
  limit?: number;
}

export const projectsApi = {
  getAll: (status?: string) =>
    api.get<import('@/types').ProjectListResponse>('/projects', { params: status ? { status } : undefined }),
  get: (id: string) =>
    api.get<import('@/types').Project>(`/projects/${id}`),
  create: (data: import('@/types').ProjectCreate) =>
    api.post<import('@/types').Project>('/projects', data),
  update: (id: string, data: import('@/types').ProjectUpdate) =>
    api.put<import('@/types').Project>(`/projects/${id}`, data),
  delete: (id: string) =>
    api.delete(`/projects/${id}`),
};

export const sprintsApi = {
  getAll: (status?: string) =>
    api.get<import('@/types').SprintListResponse>('/sprints', { params: status ? { status } : undefined }),
  getCurrent: () =>
    api.get<import('@/types').Sprint | null>('/sprints/current'),
  get: (id: string) =>
    api.get<import('@/types').Sprint>(`/sprints/${id}`),
  create: (data: import('@/types').SprintCreate) =>
    api.post<import('@/types').Sprint>('/sprints', data),
  update: (id: string, data: import('@/types').SprintUpdate) =>
    api.put<import('@/types').Sprint>(`/sprints/${id}`, data),
  carryOver: (id: string, to: string) =>
    api.post<import('@/types').Sprint>(`/sprints/${id}/carry-over`, undefined, { params: { to } }),
  delete: (id: string) =>
    api.delete(`/sprints/${id}`),
};

export const workItemsApi = {
  getAll: (params?: WorkItemFilters) =>
    api.get<WorkItemListResponse>('/work-items', {
      params: params
        ? Object.fromEntries(
            Object.entries(params)
              .filter(([, v]) => v !== undefined && v !== '')
              .map(([k, v]) => [toSnakeCase(k), v])
          )
        : undefined,
    }),
  getById: (id: string) => api.get<WorkItem>(`/work-items/${id}`),
  create: (data: WorkItemCreate) => api.post<WorkItem>('/work-items', data),
  update: (id: string, data: WorkItemUpdate) => api.put<WorkItem>(`/work-items/${id}`, data),
  patchStatus: (id: string, kanbanStatus: KanbanStatus) =>
    api.patch<WorkItemStatusResponse>(`/work-items/${id}/status`, { kanban_status: kanbanStatus }),
  delete: (id: string) => api.delete(`/work-items/${id}`),
  listComments: (id: string) =>
    api.get<import('@/types').WorkItemComment[]>(`/work-items/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<import('@/types').WorkItemComment>(`/work-items/${id}/comments`, { body }),
  deleteComment: (commentId: string) =>
    api.delete(`/work-items/comments/${commentId}`),
  listActivities: (id: string) =>
    api.get<import('@/types').WorkItemActivity[]>(`/work-items/${id}/activities`),
  exportCsv: (params?: Omit<WorkItemFilters, 'closed'>) =>
    api.get('/work-items/export/csv', {
      params: params
        ? Object.fromEntries(
            Object.entries(params)
              .filter(([, v]) => v !== undefined && v !== '')
              .map(([k, v]) => [toSnakeCase(k), v])
          )
        : undefined,
      responseType: 'blob',
    }),
  // 날짜별 시간 블록 (time blocks)
  listTimeBlocksRange: (start: string, end: string) =>
    api.get<import('@/types').WorkItemTimeBlock[]>('/work-items/time-blocks/range', { params: { start, end } }),
  listTimeBlocks: (itemId: string) =>
    api.get<import('@/types').WorkItemTimeBlock[]>(`/work-items/${itemId}/time-blocks`),
  createTimeBlock: (itemId: string, data: { blockDate: string; startMinute: number; endMinute: number; note?: string | null }) =>
    api.post<import('@/types').WorkItemTimeBlock>(`/work-items/${itemId}/time-blocks`, data),
  updateTimeBlock: (blockId: string, data: { blockDate?: string; startMinute?: number; endMinute?: number; note?: string | null }) =>
    api.patch<import('@/types').WorkItemTimeBlock>(`/work-items/time-blocks/${blockId}`, data),
  deleteTimeBlock: (blockId: string) => api.delete(`/work-items/time-blocks/${blockId}`),
};

// Jira 연동 — 공통 설정(관리자) + 사용자별 PAT + 가져오기.
export const jiraApi = {
  getConfig: () => api.get<import('@/types').JiraConfig>('/jira/config'),
  updateConfig: (data: Partial<import('@/types').JiraConfig>) =>
    api.put<import('@/types').JiraConfig>('/jira/config', data),
  getCredential: () => api.get<import('@/types').JiraCredentialStatus>('/jira/credential'),
  saveCredential: (token: string, authType: import('@/types').JiraAuthType = 'pat', jiraAccount?: string) =>
    api.put<import('@/types').JiraCredentialStatus>('/jira/credential', { token, authType, jiraAccount }),
  deleteCredential: () => api.delete('/jira/credential'),
  test: () => api.post<import('@/types').JiraTestResult>('/jira/test'),
  // SSO 자동 로그인 — 백엔드가 브라우저를 띄워 로그인 완료를 기다리므로 타임아웃을 길게(4분).
  ssoLogin: () => api.post<import('@/types').JiraSsoLoginResult>('/jira/sso/login', undefined, { timeout: 4 * 60_000 }),
  import: (data: import('@/types').JiraImportRequest) =>
    api.post<import('@/types').JiraImportResult>('/jira/import', data),
  importExcel: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api.post<import('@/types').JiraExcelImportResult>('/jira/import/excel', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 2 * 60_000,
    });
  },
  importPaste: (text: string) =>
    api.post<import('@/types').JiraExcelImportResult>('/jira/import/paste', { text }, {
      timeout: 2 * 60_000,
    }),
  importSaveToBoard: (rows: import('@/types').JiraExcelRow[]) =>
    api.post<import('@/types').JiraImportResult>('/jira/import/excel/save', { rows }, {
      timeout: 2 * 60_000,
    }),
  push: (itemId: string, data: import('@/types').JiraPushRequest) =>
    api.post<import('@/types').JiraPushResult>(`/jira/push/${itemId}`, data),
};

// Today work items summary — task + issue 모두 대상 (백엔드 동일).
// primary_assignee 와 secondary_assignee 둘 다 그룹 키로 등록되므로 같은 아이템이
// 두 사람의 그룹에 중복 노출될 수 있다 (협업자 가시성용).
export interface TodayTaskGroup {
  assignee: string;
  todayTasks: WorkItem[];
  inProgressTasks: WorkItem[];
  overdueTasks?: WorkItem[];
}

export interface TodayTasksSummary {
  date: string;
  totalToday: number;
  totalInProgress: number;
  groups: TodayTaskGroup[];
}

export const todayWorkItemsApi = {
  getSummary: (date?: string) =>
    api.get<TodayTasksSummary>('/work-items/today/summary', { params: date ? { date } : {} }),
};

export const uiSettingsApi = {
  get: () => api.get<UiSettings>('/ui-settings'),
  update: (data: Partial<UiSettings>) => api.put<UiSettings>('/ui-settings', data),
  getClusterLinks: () => api.get<{ data: ClusterLinksPayload }>('/ui-settings/cluster-links'),
  updateClusterLinks: (data: ClusterLinksPayload) => api.put<{ data: ClusterLinksPayload }>('/ui-settings/cluster-links', data),
  getOperationLevels: () =>
    api.get<{ levels: import('@/types').OperationLevelItem[] }>('/ui-settings/operation-levels'),
  updateOperationLevels: (levels: import('@/types').OperationLevelItem[]) =>
    api.put<{ levels: import('@/types').OperationLevelItem[] }>('/ui-settings/operation-levels', { levels }),
  getFeatureAccess: () =>
    api.get<{ data: import('@/types').FeatureAccessMap }>('/ui-settings/feature-access'),
  updateFeatureAccess: (access: import('@/types').FeatureAccessMap) =>
    api.put<{ data: import('@/types').FeatureAccessMap }>('/ui-settings/feature-access', { access }),
};

export const nodeLabelsApi = {
  getNodes: (clusterId: string) =>
    api.get(`/clusters/${clusterId}/nodes`),
  patchNodeLabels: (
    clusterId: string,
    nodeName: string,
    payload: { add: Record<string, string>; remove: string[] }
  ) =>
    api.patch(
      `/clusters/${clusterId}/nodes/${encodeURIComponent(nodeName)}/labels`,
      payload
    ),
};

export const nodeImagesApi = {
  getNodeImages: (clusterId: string) =>
    api.get(`/clusters/${clusterId}/node-images`),
  exportCsv: (clusterId: string, sort: 'default' | 'size' | 'lines' = 'default') =>
    api.get<Blob>(`/clusters/${clusterId}/node-images/export.csv?sort=${sort}`, {
      responseType: 'blob',
    }),
};

export const clusterTrendsApi = {
  // per-node 메트릭 추이. metrics/nodes 는 콤마 구분 문자열로 전달.
  get: (
    clusterId: string,
    params: { range: string; metrics: string[]; nodes: string[] }
  ) =>
    api.get<ClusterTrendsResponse>(`/k8s/${clusterId}/trends`, {
      params: {
        range: params.range,
        metrics: params.metrics.join(','),
        nodes: params.nodes.join(','),
      },
      timeout: 60_000,
    }),
};


// Workflows API
export const workflowsApi = {
  getAll: () => api.get<{ data: import('@/types').Workflow[] }>('/workflows'),
  getById: (id: string) => api.get<import('@/types').Workflow>(`/workflows/${id}`),
  create: (data: import('@/types').WorkflowCreate) => api.post<import('@/types').Workflow>('/workflows', data),
  update: (id: string, data: import('@/types').WorkflowUpdate) => api.put<import('@/types').Workflow>(`/workflows/${id}`, data),
  delete: (id: string) => api.delete(`/workflows/${id}`),
  createStep: (workflowId: string, data: import('@/types').WorkflowStepCreate) =>
    api.post<import('@/types').WorkflowStep>(`/workflows/${workflowId}/steps`, data),
  updateStep: (workflowId: string, stepId: string, data: import('@/types').WorkflowStepUpdate) =>
    api.put<import('@/types').WorkflowStep>(`/workflows/${workflowId}/steps/${stepId}`, data),
  deleteStep: (workflowId: string, stepId: string) =>
    api.delete(`/workflows/${workflowId}/steps/${stepId}`),
  createEdge: (workflowId: string, data: import('@/types').WorkflowEdgeCreate) =>
    api.post<import('@/types').WorkflowEdge>(`/workflows/${workflowId}/edges`, data),
  deleteEdge: (workflowId: string, edgeId: string) =>
    api.delete(`/workflows/${workflowId}/edges/${edgeId}`),
};

// Work Guides API
export const workGuidesApi = {
  getAll: (params?: { category?: string; status?: string; priority?: string }) =>
    api.get<WorkGuideListResponse>('/work-guides', {
      params: params
        ? Object.fromEntries(
            Object.entries(params)
              .filter(([, v]) => v !== undefined && v !== '')
              .map(([k, v]) => [toSnakeCase(k === 'status' ? 'guide_status' : k), v])
          )
        : undefined,
    }),
  getById: (id: string) => api.get<WorkGuide>(`/work-guides/${id}`),
  create: (data: WorkGuideCreate) => api.post<WorkGuide>('/work-guides', data),
  update: (id: string, data: WorkGuideUpdate) => api.put<WorkGuide>(`/work-guides/${id}`, data),
  delete: (id: string) => api.delete(`/work-guides/${id}`),
};

// Commands API (지식 허브 - 주요 명령어/파라미터 모음)
export const commandsApi = {
  list: (params?: { category?: string; importance?: string; q?: string }) =>
    api.get<{ data: import('@/types').CommandEntry[]; total: number }>('/commands', {
      params: params
        ? Object.fromEntries(
            Object.entries(params).filter(([, v]) => v !== undefined && v !== ''),
          )
        : undefined,
    }),
  get: (id: string) => api.get<import('@/types').CommandEntry>(`/commands/${id}`),
  create: (data: import('@/types').CommandEntryCreate) =>
    api.post<import('@/types').CommandEntry>('/commands', data),
  update: (id: string, data: Partial<import('@/types').CommandEntryCreate>) =>
    api.put<import('@/types').CommandEntry>(`/commands/${id}`, data),
  delete: (id: string) => api.delete(`/commands/${id}`),
};

// Ops Notes API (업무 게시판)
export const opsNotesApi = {
  getAll: (service?: string) =>
    api.get<OpsNoteListResponse>('/ops-notes', {
      params: service ? { service } : undefined,
    }),
  getById: (id: string) => api.get<OpsNote>(`/ops-notes/${id}`),
  create: (data: OpsNoteCreate) => api.post<OpsNote>('/ops-notes', data),
  update: (id: string, data: OpsNoteUpdate) => api.put<OpsNote>(`/ops-notes/${id}`, data),
  delete: (id: string) => api.delete(`/ops-notes/${id}`),
};

// Mind Map API
export const mindmapApi = {
  list: () => api.get<MindMapListItem[]>('/mindmaps/'),
  get: (id: string) => api.get<MindMap>(`/mindmaps/${id}`),
  create: (data: MindMapCreate) => api.post<MindMap>('/mindmaps/', data),
  update: (id: string, data: MindMapUpdate) => api.put<MindMap>(`/mindmaps/${id}`, data),
  delete: (id: string) => api.delete(`/mindmaps/${id}`),
  // nodes
  createNode: (mapId: string, data: MindMapNodeCreate) =>
    api.post<MindMapNode>(`/mindmaps/${mapId}/nodes`, data),
  updateNode: (mapId: string, nodeId: string, data: MindMapNodeUpdate) =>
    api.put<MindMapNode>(`/mindmaps/${mapId}/nodes/${nodeId}`, data),
  deleteNode: (mapId: string, nodeId: string) =>
    api.delete(`/mindmaps/${mapId}/nodes/${nodeId}`),
  bulkUpdatePositions: (mapId: string, updates: { id: string; x: number; y: number }[]) =>
    api.patch<MindMapNode[]>(`/mindmaps/${mapId}/nodes/positions`, updates),
};

// Management Servers API
export const managementServersApi = {
  getAll: (serverType?: string) =>
    api.get<ManagementServerListResponse>('/management-servers', {
      params: serverType ? { server_type: serverType } : {},
    }),
  getById: (id: string) => api.get<ManagementServer>(`/management-servers/${id}`),
  create: (data: ManagementServerCreate) => api.post<ManagementServer>('/management-servers', data),
  update: (id: string, data: ManagementServerUpdate) =>
    api.put<ManagementServer>(`/management-servers/${id}`, data),
  delete: (id: string) => api.delete(`/management-servers/${id}`),
  ping: (id: string) =>
    api.post<{ ok: boolean; host: string; port: number; latency_ms: number | null; detail: string }>(
      `/management-servers/${id}/ping`
    ),
};

// Isilon NFS 모니터링 API
export const isilonNfsApi = {
  servers: {
    getAll: () => api.get<import('@/types').IsilonServer[]>('/isilon-nfs/servers'),
    create: (data: import('@/types').IsilonServerCreate) =>
      api.post<import('@/types').IsilonServer>('/isilon-nfs/servers', data),
    update: (id: string, data: import('@/types').IsilonServerUpdate) =>
      api.put<import('@/types').IsilonServer>(`/isilon-nfs/servers/${id}`, data),
    delete: (id: string) => api.delete(`/isilon-nfs/servers/${id}`),
    test: (id: string) =>
      api.post<import('@/types').IsilonTestResult>(`/isilon-nfs/servers/${id}/test`),
  },
  commands: {
    getAll: (serverId?: string) =>
      api.get<import('@/types').IsilonCommand[]>('/isilon-nfs/commands', {
        params: serverId ? { server_id: serverId } : {},
      }),
    create: (data: import('@/types').IsilonCommandCreate) =>
      api.post<import('@/types').IsilonCommand>('/isilon-nfs/commands', data),
    update: (id: string, data: import('@/types').IsilonCommandUpdate) =>
      api.put<import('@/types').IsilonCommand>(`/isilon-nfs/commands/${id}`, data),
    delete: (id: string) => api.delete(`/isilon-nfs/commands/${id}`),
  },
  getOverview: (serverId?: string, force = false) =>
    api.get<import('@/types').IsilonNfsOverview>('/isilon-nfs/overview', {
      params: { ...(serverId ? { server_id: serverId } : {}), force },
    }),
};

// Infra Nodes API (물리 서버 노드)
export const infraNodesApi = {
  getAll: (params?: { clusterId?: string; rackName?: string }) =>
    api.get<import('@/types').InfraNodeListResponse>('/infra-nodes', { params, headers: { 'X-API-Scopes': 'infra_topology.read' } }),
  getById: (id: string) => api.get<import('@/types').InfraNode>(`/infra-nodes/${id}`, { headers: { 'X-API-Scopes': 'infra_topology.read' } }),
  create: (data: import('@/types').InfraNodeCreate) =>
    api.post<import('@/types').InfraNode>('/infra-nodes', data, { headers: { 'X-API-Scopes': 'infra_topology.edit' } }),
  update: (id: string, data: import('@/types').InfraNodeUpdate) =>
    api.put<import('@/types').InfraNode>(`/infra-nodes/${id}`, data, { headers: { 'X-API-Scopes': 'infra_topology.edit' } }),
  delete: (id: string) => api.delete(`/infra-nodes/${id}`, { headers: { 'X-API-Scopes': 'infra_topology.force_fix' } }),
  sync: (clusterId: string) =>
    api.post<import('@/types').InfraSyncResult>(`/infra-nodes/sync/${clusterId}`, undefined, { headers: { 'X-API-Scopes': 'infra_topology.sync' } }),
  verify: (id: string) =>
    api.post<import('@/types').NodeVerifyResult>(`/infra-nodes/${id}/verify`, undefined, { headers: { 'X-API-Scopes': 'infra_topology.sync' } }),
};

// Node Server Spec (자산 관리 대장)
export const nodeSpecsApi = {
  list: (params?: { clusterId?: string; status?: string; role?: string; search?: string }, signal?: AbortSignal) =>
    api.get<import('@/types').NodeServerSpecListResponse>('/node-specs', {
      params: params
        ? {
            cluster_id: params.clusterId,
            status: params.status,
            role: params.role,
            search: params.search,
          }
        : undefined,
      signal,
    }),
  getById: (id: string) =>
    api.get<import('@/types').NodeServerSpec>(`/node-specs/${id}`),
  create: (data: import('@/types').NodeServerSpecCreate) =>
    api.post<import('@/types').NodeServerSpec>('/node-specs', data),
  update: (id: string, data: import('@/types').NodeServerSpecUpdate) =>
    api.put<import('@/types').NodeServerSpec>(`/node-specs/${id}`, data),
  delete: (id: string) =>
    api.delete(`/node-specs/${id}`),
  importFromCluster: (
    clusterId: string,
    payload: import('@/types').NodeSpecImportRequest = {},
    signal?: AbortSignal,
  ) =>
    api.post<import('@/types').NodeSpecImportResult>(`/node-specs/import/${clusterId}`, payload, { signal }),
  collectHostFacts: (
    clusterId: string,
    payload: import('@/types').NodeSpecHostFactsCollectRequest,
    signal?: AbortSignal,
  ) =>
    api.post<import('@/types').NodeSpecHostFactsCollectResponse>(`/node-specs/collect-host-facts/${clusterId}`, payload, { signal, timeout: 180000 }),
  csvPreview: (
    payload: import('@/types').NodeSpecCsvUploadRequest,
    signal?: AbortSignal,
  ) =>
    api.post<import('@/types').NodeSpecCsvPreviewResponse>('/node-specs/csv/preview', payload, { signal }),
  csvApply: (
    payload: import('@/types').NodeSpecCsvUploadRequest,
    signal?: AbortSignal,
  ) =>
    api.post<import('@/types').NodeSpecCsvApplyResponse>('/node-specs/csv/apply', payload, { signal }),
};


// Topology Trace API
export const topologyTraceApi = {
  trace: (payload: TopologyTraceRequest) =>
    api.post<TopologyTraceResponse>('/topology-trace', payload),
  packetFlow: (payload: import('@/types').PacketFlowRequest) =>
    api.post<import('@/types').PacketFlowResponse>('/topology-trace/packet-flow', payload),
  packetFlowV2: (payload: import('@/types').PacketFlowRequestV2, signal?: AbortSignal) =>
    api.post<import('@/types').PacketFlowResponseV2>('/topology-trace/packet-flow-v2', payload, { signal }),
  hubbleFlows: (payload: import('@/types').HubbleFlowsRequest, signal?: AbortSignal) =>
    api.post<import('@/types').HubbleFlowsResponse>('/topology-trace/hubble-flows', payload, { signal }),
  tcpdumpRun: (payload: import('@/types').TcpdumpCaptureRequest, signal?: AbortSignal) =>
    api.post<import('@/types').TcpdumpCaptureResponse>('/topology-trace/tcpdump', payload, { signal }),
  tcpdumpInterfaces: (payload: import('@/types').TcpdumpInterfacesRequest, signal?: AbortSignal) =>
    api.post<import('@/types').TcpdumpInterfacesResponse>('/topology-trace/tcpdump/interfaces', payload, { signal }),
};

// Assignees API (담당자 관리)
export const assigneesApi = {
  getAll: () => api.get<{ data: import('@/types').Assignee[] }>('/ui-settings/assignees'),
  update: (assignees: import('@/types').Assignee[]) =>
    api.put<{ data: import('@/types').Assignee[] }>('/ui-settings/assignees', { assignees }),
};

// Ontology API
export const ontologyApi = {
  getGraph: (clusterId: string) =>
    api.get<import('@/types').OntologyGraph>(`/ontology/graph/${clusterId}`),
  createEntity: (data: {
    clusterId: string; entityType: string; name: string;
    externalId?: string; version?: string; properties?: Record<string, unknown>;
  }) => api.post<import('@/types').OntologyEntity>('/ontology/entities', data),
  createRelationship: (data: {
    clusterId: string; sourceEntityId: string; relationType: string;
    targetEntityId: string; weight?: number; relationMetadata?: Record<string, unknown>;
  }) => api.post<import('@/types').OntologyRelationship>('/ontology/relationships', data),
  analyzeImpact: (data: import('@/types').OntologyImpactRequest) =>
    api.post<import('@/types').OntologyImpactResponse>('/ontology/impact', data),
};

// Incident Analysis API
export const analyzeApi = {
  analyze: (data: import('@/types').IncidentAnalysisRequest) =>
    api.post<import('@/types').IncidentAnalysisResponse>('/analyze/incident', data),
  health: () =>
    api.get<import('@/types').AnalyzerHealthResponse>('/analyze/health'),
  listNamespaces: (
    clusterId: string,
    onlyWithIssues = false,
    withCounts = false,
    namespacePattern = '',
    podPattern = '',
  ) =>
    api.get<import('@/types').AnalyzeNamespacesResponse>(
      `/analyze/clusters/${clusterId}/namespaces`,
      {
        params: {
          only_with_issues: onlyWithIssues,
          with_counts: withCounts,
          namespace_pattern: namespacePattern,
          pod_pattern: podPattern,
        },
        // 거대 클러스터에서 with_counts/only_with_issues 일 때만 무거우므로 그 경우만 긴 타임아웃.
        timeout: (onlyWithIssues || withCounts) ? 150_000 : 30_000,
      },
    ),
  listPods: (clusterId: string, namespace: string, onlyWithIssues = false) =>
    api.get<import('@/types').AnalyzePodsResponse>(
      `/analyze/clusters/${clusterId}/namespaces/${namespace}/pods`,
      { params: { only_with_issues: onlyWithIssues }, timeout: 120_000 },
    ),
  fetchContext: (clusterId: string, namespace: string, podName: string, tailLines = 200) =>
    api.get<import('@/types').AnalyzeIncidentContext>(
      `/analyze/clusters/${clusterId}/namespaces/${namespace}/pods/${podName}/context`,
      { params: { tail_lines: tailLines } },
    ),
  /** 파드 컨테이너(+init) 목록 — 로그/터미널 셀렉터용. */
  podContainers: (clusterId: string, namespace: string, podName: string) =>
    api.get<import('@/types').K8sPodContainersResponse>(
      `/analyze/clusters/${clusterId}/namespaces/${namespace}/pods/${podName}/containers`,
    ),
};

// Service Topology API — 자동 그래프 + 수동 연계 + 실트래픽
export const serviceTopologyApi = {
  getClusterGraph: (
    clusterId: string,
    opts?: { mode?: 'summary' | 'detail'; includePods?: boolean; withMetrics?: boolean },
  ) =>
    api.get<import('@/types').ClusterTopologyResponse>(
      `/service-topology/${clusterId}/cluster-graph`,
      {
        params: {
          mode: opts?.mode ?? 'summary',
          include_pods: opts?.includePods ?? false,
          with_metrics: opts?.withMetrics ?? false,
        },
        timeout: 120_000,
      },
    ),
  getGraph: (
    clusterId: string,
    namespace: string,
    opts?: { includePods?: boolean; includeOrphans?: boolean; withMetrics?: boolean },
  ) =>
    api.get<import('@/types').TopologyGraphResponse>(
      `/service-topology/${clusterId}/graph`,
      {
        params: {
          namespace,
          include_pods: opts?.includePods ?? false,
          include_orphans: opts?.includeOrphans ?? false,
          with_metrics: opts?.withMetrics ?? true,
        },
        timeout: 60_000,
      },
    ),
  getTraffic: (
    clusterId: string,
    namespace: string,
    opts?: { sinceSeconds?: number; limit?: number },
  ) =>
    api.get<import('@/types').TopologyTrafficResponse>(
      `/service-topology/${clusterId}/traffic`,
      {
        params: {
          namespace,
          since_seconds: opts?.sinceSeconds ?? 60,
          limit: opts?.limit ?? 2000,
        },
        timeout: 60_000,
      },
    ),
  listLinks: (clusterId: string, namespace?: string) =>
    api.get<import('@/types').ServiceTopologyLink[]>(
      `/service-topology/${clusterId}/links`,
      { params: namespace ? { namespace } : {} },
    ),
  createLink: (clusterId: string, data: {
    namespace: string; sourceKind: string; sourceName: string;
    targetKind: string; targetName: string; linkType: string;
    label?: string | null; note?: string | null;
  }) => api.post<import('@/types').ServiceTopologyLink>(`/service-topology/${clusterId}/links`, data),
  updateLink: (linkId: string, data: { linkType?: string; label?: string | null; note?: string | null }) =>
    api.patch<import('@/types').ServiceTopologyLink>(`/service-topology/links/${linkId}`, data),
  deleteLink: (linkId: string) => api.delete(`/service-topology/links/${linkId}`),
  createExternalNode: (clusterId: string, data: {
    namespace: string; name: string; nodeType: string; note?: string | null;
  }) => api.post<import('@/types').ServiceTopologyExternalNode>(`/service-topology/${clusterId}/external-nodes`, data),
  deleteExternalNode: (nodeId: string) => api.delete(`/service-topology/external-nodes/${nodeId}`),
};

// K8s Events API (kubewatch 웹훅 수신 이벤트 조회)
export const k8sEventsApi = {
  list: (params?: {
    clusterId?: string;
    severity?: string;
    resourceKind?: string;
    limit?: number;
    offset?: number;
  }) => api.get<import('@/types').K8sEventListResponse>('/events/', { params }),
  get: (id: string) => api.get<import('@/types').K8sEvent>(`/events/${id}`),
  delete: (id: string) => api.delete(`/events/${id}`),
};

// Trend Digest API
export const trendsApi = {
  triggerCollect: (targetDate?: string, lookbackDays?: number) =>
    api.post<TrendDigest>('/trends/collect', undefined, {
      params: {
        ...(targetDate ? { target_date: targetDate } : {}),
        ...(lookbackDays ? { lookback_days: lookbackDays } : {}),
      },
    }),
  listDigests: (limit = 30) =>
    api.get<TrendDigest[]>('/trends/digests', { params: { limit } }),
  getDigest: (date: string) =>
    api.get<TrendDigest>(`/trends/digests/${date}`),
  listItems: (date: string, category?: string, itemType?: string) =>
    api.get<TrendItem[]>(`/trends/items/${date}`, {
      params: { ...(category && { category }), ...(itemType && { item_type: itemType }) },
    }),
  listSources: () => api.get<TrendSource[]>('/trends/sources'),
  toggleSource: (id: string, enabled: boolean) =>
    api.patch<TrendSource>(`/trends/sources/${id}`, { enabled }),
  createSource: (data: {
    name: string; sourceType: 'github_release' | 'rss'; url: string; category: string; enabled?: boolean;
  }) => api.post<TrendSource>('/trends/sources', data),
  updateSource: (id: string, data: Partial<{
    name: string; sourceType: 'github_release' | 'rss'; url: string; category: string; enabled: boolean;
  }>) => api.put<TrendSource>(`/trends/sources/${id}`, data),
  deleteSource: (id: string) => api.delete(`/trends/sources/${id}`),
};

// LAKE Service Monitoring — lake-service-monitoring PDCA
import type {
  LakeService as _LakeService,
  LakeServiceInput as _LakeServiceInput,
  LakeServiceUpdate as _LakeServiceUpdate,
  LakeServiceListResponse as _LakeServiceListResponse,
  LakeServiceCheck as _LakeServiceCheck,
  LakeServiceCheckListResponse as _LakeServiceCheckListResponse,
  LakeServiceTypeInfo as _LakeServiceTypeInfo,
} from '@/types';

export const lakeServicesApi = {
  listTypes: () => api.get<_LakeServiceTypeInfo[]>('/lake-services/types'),
  list: (params?: {
    clusterId?: string;
    serviceType?: string;
    category?: string;
    enabled?: boolean;
    domain?: string;
    categoryId?: string;
    offset?: number;
    limit?: number;
  }) => api.get<_LakeServiceListResponse>('/lake-services', { params }),
  get: (id: string) => api.get<_LakeService>(`/lake-services/${id}`),
  listChecks: (id: string, params?: { offset?: number; limit?: number }) =>
    api.get<_LakeServiceCheckListResponse>(`/lake-services/${id}/checks`, { params }),
  create: (data: _LakeServiceInput) => api.post<_LakeService>('/lake-services', data),
  update: (id: string, data: _LakeServiceUpdate) =>
    api.put<_LakeService>(`/lake-services/${id}`, data),
  remove: (id: string) => api.delete(`/lake-services/${id}`),
  runCheck: (id: string) => api.post<_LakeServiceCheck>(`/lake-services/${id}/check`),
};

// LAKE service type 카탈로그 (lake-service-type-management PDCA)
import type {
  LakeServiceTypeRow as _LakeServiceTypeRow,
  LakeServiceTypeInput as _LakeServiceTypeInput,
  LakeServiceTypeUpdate as _LakeServiceTypeUpdate,
  LakeServiceTypeListResponseRows as _LakeServiceTypeListResponseRows,
} from '@/types';

export const lakeServiceTypesApi = {
  list: (params?: { enabled?: boolean; domain?: string; offset?: number; limit?: number }) =>
    api.get<_LakeServiceTypeListResponseRows>('/lake-service-types', { params }),
  get: (id: string) => api.get<_LakeServiceTypeRow>(`/lake-service-types/${id}`),
  create: (data: _LakeServiceTypeInput) =>
    api.post<_LakeServiceTypeRow>('/lake-service-types', data),
  update: (id: string, data: _LakeServiceTypeUpdate) =>
    api.put<_LakeServiceTypeRow>(`/lake-service-types/${id}`, data),
  toggleEnabled: (id: string, enabled: boolean) =>
    api.patch<_LakeServiceTypeRow>(`/lake-service-types/${id}/enabled`, { enabled }),
  remove: (id: string) => api.delete(`/lake-service-types/${id}`),
};

// PEP/APP 서비스 상위 카테고리 (service-category-catalog PDCA)
import type {
  ServiceCategory as _ServiceCategory,
  ServiceCategoryInput as _ServiceCategoryInput,
  ServiceCategoryUpdate as _ServiceCategoryUpdate,
  ServiceCategoryListResponse as _ServiceCategoryListResponse,
} from '@/types';

export const serviceCategoriesApi = {
  list: (params?: { domain?: string; enabled?: boolean; offset?: number; limit?: number }) =>
    api.get<_ServiceCategoryListResponse>('/service-categories', { params }),
  get: (id: string) => api.get<_ServiceCategory>(`/service-categories/${id}`),
  create: (data: _ServiceCategoryInput) =>
    api.post<_ServiceCategory>('/service-categories', data),
  update: (id: string, data: _ServiceCategoryUpdate) =>
    api.put<_ServiceCategory>(`/service-categories/${id}`, data),
  remove: (id: string) => api.delete(`/service-categories/${id}`),
};

// Pod-to-pod bottleneck analyzer — pod-bottleneck-analyzer PDCA
import type {
  BottleneckRun as _BottleneckRun,
  BottleneckRunInput as _BottleneckRunInput,
  BottleneckRunListResponse as _BottleneckRunListResponse,
  BottleneckProbeCatalogEntry as _BottleneckProbeCatalogEntry,
} from '@/types';

export const podBottleneckApi = {
  listProbes: () => api.get<_BottleneckProbeCatalogEntry[]>('/pod-bottleneck/probes'),
  listRuns: (params?: {
    clusterId?: string;
    namespace?: string;
    sourcePod?: string;
    destPod?: string;
    offset?: number;
    limit?: number;
  }) => api.get<_BottleneckRunListResponse>('/pod-bottleneck/runs', { params }),
  getRun: (id: string) => api.get<_BottleneckRun>(`/pod-bottleneck/runs/${id}`),
  runAnalysis: (data: _BottleneckRunInput) =>
    api.post<_BottleneckRun>('/pod-bottleneck/run', data),
  deleteRun: (id: string) => api.delete(`/pod-bottleneck/runs/${id}`),
};

// 서비스별 히스토리·지식관리
export const serviceEntriesApi = {
  catalog: (clusterId?: string) =>
    api.get<import('@/types').ServiceCatalogResponse>('/services/catalog', {
      params: clusterId ? { cluster_id: clusterId } : undefined,
    }),
  list: (service: string, params?: { clusterId?: string; kind?: string; search?: string; tag?: string }) =>
    api.get<import('@/types').ServiceEntryListResponse>(`/services/${service}/entries`, {
      params: params ? {
        cluster_id: params.clusterId,
        kind: params.kind,
        search: params.search,
        tag: params.tag,
      } : undefined,
    }),
  get: (id: string) => api.get<import('@/types').ServiceEntry>(`/service-entries/${id}`),
  create: (data: import('@/types').ServiceEntryCreate) =>
    api.post<import('@/types').ServiceEntry>('/service-entries', data),
  update: (id: string, data: import('@/types').ServiceEntryUpdate) =>
    api.put<import('@/types').ServiceEntry>(`/service-entries/${id}`, data),
  delete: (id: string) => api.delete(`/service-entries/${id}`),
};

// Batch Jobs API
export interface BatchJobTypeDescriptor {
  jobType: string;
  label: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paramSchema: Record<string, { type: string; label?: string; default?: any; help?: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultParams: Record<string, any>;
}

export interface BatchJob {
  id: string;
  clusterId: string;
  name: string;
  description?: string | null;
  jobType: string;
  defaultHost?: string | null;
  defaultPort: number;
  defaultUsername: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any> | null;
  cron?: string | null;
  enabled: boolean;
  lastStatus: string;
  lastRunAt?: string | null;
  lastScheduleCheckAt?: string | null;
  lastScheduleNote?: string | null;
  createdAt: string;
  updatedAt: string;
  hasSavedPassword: boolean;
  hasSavedPrivateKey: boolean;
}

export interface BatchJobCreate {
  clusterId: string;
  name: string;
  description?: string;
  jobType: string;
  defaultHost?: string;
  defaultPort?: number;
  defaultUsername?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any>;
  cron?: string;
  enabled?: boolean;
  // Plaintext on the way in; backend encrypts before persisting.
  savedPassword?: string;
  savedPrivateKey?: string;
}

export interface BatchJobUpdate {
  name?: string;
  description?: string;
  defaultHost?: string;
  defaultPort?: number;
  defaultUsername?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any>;
  cron?: string;
  enabled?: boolean;
  savedPassword?: string;
  savedPrivateKey?: string;
  clearSavedPassword?: boolean;
  clearSavedPrivateKey?: boolean;
}

export interface BatchJobRunRequest {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paramOverride?: Record<string, any>;
  timeout?: number;
}

export interface BatchJobRun {
  id: string;
  jobId: string;
  status: string;
  trigger: string;
  host?: string | null;
  executedCommand?: string | null;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  error?: string | null;
  durationMs: number;
  startedAt: string;
  finishedAt?: string | null;
}

export interface BatchJobTestConnectionRequest {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  timeout?: number;
}

export interface BatchJobTestConnectionResponse {
  status: 'ok' | 'auth_error' | 'connect_error' | 'timeout' | 'error';
  latencyMs: number;
  host: string;
  port: number;
  username: string;
  usedSavedPassword: boolean;
  usedSavedPrivateKey: boolean;
  error?: string | null;
}

export const batchJobsApi = {
  listTypes: () =>
    api.get<{ data: BatchJobTypeDescriptor[] }>('/batch-jobs/types'),
  list: (params?: { clusterId?: string; jobType?: string }) =>
    api.get<{ data: BatchJob[] }>('/batch-jobs', { params }),
  get: (id: string) => api.get<BatchJob>(`/batch-jobs/${id}`),
  create: (data: BatchJobCreate) => api.post<BatchJob>('/batch-jobs', data),
  update: (id: string, data: BatchJobUpdate) => api.put<BatchJob>(`/batch-jobs/${id}`, data),
  delete: (id: string) => api.delete(`/batch-jobs/${id}`),
  run: (id: string, payload: BatchJobRunRequest, signal?: AbortSignal) =>
    api.post<BatchJobRun>(`/batch-jobs/${id}/run`, payload, { signal, timeout: 600000 }),
  bulkRun: (jobIds: string[]) =>
    api.post<{ queued: number; skipped: number; results: { jobId: string; queued: boolean; reason?: string | null }[] }>(
      '/batch-jobs/bulk-run', { jobIds },
    ),
  listRuns: (id: string, limit = 50) =>
    api.get<{ data: BatchJobRun[] }>(`/batch-jobs/${id}/runs`, { params: { limit } }),
  testConnection: (id: string, payload: BatchJobTestConnectionRequest) =>
    api.post<BatchJobTestConnectionResponse>(`/batch-jobs/${id}/test-connection`, payload, {
      timeout: 60000,
    }),
};

// ─── Deep Check / Daily Check Review / Notifications ─────────────────

import type {
  DeepCheckDefinition,
  DeepCheckDefinitionInput,
  DeepCheckResult,
  DeepCheckReview,
  DeepCheckTestResult,
  DeepCheckTypeSchema,
  DailyCheckTrend,
  NotificationChannel,
  NotificationChannelInput,
  NotificationLogEntry,
  OpsCheckCatalogItem,
  OpsCheckRun,
  OpsCheckRunItem,
  OpsCheckRunRequestItem,
} from '@/types';

// Daily check (DailyChecker) — Deep check 와 다른 파이프라인. 회차 picker / 최신 로그 조회 /
// 수동 실행 공통 사용. 응답 카멜 변환은 axios 인터셉터가 처리.
export interface DailyCheckLogLite {
  id: string;
  clusterId: string;
  checkedAt: string;
  overallStatus: string;
  scheduleType: string;
}

export const dailyCheckApi = {
  latestLog: (clusterId: string) =>
    api.get<DailyCheckLogLite>(`/daily-check/results/${clusterId}/latest`),
  listLogs: (clusterId: string, params?: { limit?: number; offset?: number }) =>
    api.get<DailyCheckLogLite[]>(`/daily-check/results/${clusterId}`, { params }),
  runNow: (clusterId: string) =>
    api.post<DailyCheckLogLite>(`/daily-check/run/${clusterId}`),
  getSummary: () => api.get('/daily-check/summary'),
};

export const deepCheckApi = {
  listResults: (clusterId: string, params?: { limit?: number; offset?: number }) =>
    api.get<DeepCheckResult[]>(`/deep-check/results/${clusterId}`, { params }),
  latestResults: (clusterId: string) =>
    api.get<DeepCheckResult[]>(`/deep-check/results/${clusterId}/latest`),
  review: (dailyCheckLogId: string) =>
    api.get<DeepCheckReview>(`/deep-check/review/${dailyCheckLogId}`),
  regenerateReview: (dailyCheckLogId: string) =>
    api.post<DeepCheckReview>(`/deep-check/review/${dailyCheckLogId}/regenerate`),
  trend: (clusterId: string, days = 7) =>
    api.get<DailyCheckTrend>(`/deep-check/trend/${clusterId}`, { params: { days } }),
  runNow: (clusterId: string) =>
    api.post<{ status: string; checksRun: number }>(`/deep-check/run/${clusterId}`),
};

export const deepCheckDefinitionsApi = {
  listCheckTypes: () => api.get<DeepCheckTypeSchema[]>('/deep-check/check-types'),
  list: (params?: { clusterId?: string; includeGlobal?: boolean }) =>
    api.get<DeepCheckDefinition[]>('/deep-check/definitions', { params }),
  get: (id: string) => api.get<DeepCheckDefinition>(`/deep-check/definitions/${id}`),
  create: (data: DeepCheckDefinitionInput) =>
    api.post<DeepCheckDefinition>('/deep-check/definitions', data),
  update: (id: string, data: DeepCheckDefinitionInput) =>
    api.put<DeepCheckDefinition>(`/deep-check/definitions/${id}`, data),
  remove: (id: string) => api.delete(`/deep-check/definitions/${id}`),
  test: (id: string, clusterId?: string) =>
    api.post<DeepCheckTestResult>(
      `/deep-check/definitions/${id}/test`,
      undefined,
      { params: clusterId ? { cluster_id: clusterId } : undefined },
    ),
};

export const checkMatrixApi = {
  listItems: () => api.get<CheckMatrixItem[]>('/check-matrix/items'),
  createItem: (data: CheckMatrixItemInput) =>
    api.post<CheckMatrixItem>('/check-matrix/items', data),
  updateItem: (id: string, data: CheckMatrixItemInput) =>
    api.put<CheckMatrixItem>(`/check-matrix/items/${id}`, data),
  removeItem: (id: string) => api.delete(`/check-matrix/items/${id}`),
  reorderItems: (itemIds: string[]) =>
    api.post('/check-matrix/items/reorder', { itemIds }),
  getGrid: () => api.get<CheckMatrixGrid>('/check-matrix/grid'),
  getCellHistory: (itemId: string, clusterId: string, days = 30) =>
    api.get<CheckMatrixHistory>(`/check-matrix/cell/${itemId}/${clusterId}/history`, { params: { days } }),
  postManualEntry: (
    itemId: string,
    clusterId: string,
    data: { status: string; value?: number | null; message?: string | null },
  ) => api.post(`/check-matrix/cell/${itemId}/${clusterId}/manual-entry`, data),
  putSchedule: (itemId: string, clusterId: string, data: { cronExpr: string | null; enabled: boolean }) =>
    api.put(`/check-matrix/schedule/${itemId}/${clusterId}`, data),
  putClusterCron: (clusterId: string, checkCronExpr: string | null) =>
    api.put(`/check-matrix/clusters/${clusterId}/cron`, { checkCronExpr }),
  getSettings: () => api.get<CheckMatrixSettings>('/check-matrix/settings'),
  putSettings: (retentionDays: number) =>
    api.put<CheckMatrixSettings>('/check-matrix/settings', { retentionDays }),
};

export const notificationsApi = {
  list: () => api.get<NotificationChannel[]>('/notifications/channels'),
  create: (data: NotificationChannelInput) =>
    api.post<NotificationChannel>('/notifications/channels', data),
  update: (id: string, data: NotificationChannelInput) =>
    api.put<NotificationChannel>(`/notifications/channels/${id}`, data),
  remove: (id: string) => api.delete(`/notifications/channels/${id}`),
  test: (id: string) => api.post<NotificationLogEntry>(`/notifications/test/${id}`),
  log: (limit = 50) =>
    api.get<NotificationLogEntry[]>('/notifications/log', { params: { limit } }),
  // 개인 인앱 알림 (알림 종)
  listMy: (limit = 30) =>
    api.get<{ data: import('@/types').UserNotification[]; unread: number }>('/notifications/my', { params: { limit } }),
  markRead: (id: string) => api.post(`/notifications/my/${id}/read`),
  markAllRead: () => api.post('/notifications/my/read-all'),
};

export const opsCheckApi = {
  catalog: (clusterId: string) =>
    api.get<OpsCheckCatalogItem[]>(`/ops-checks/catalog/${clusterId}`),
  run: (clusterId: string, items: OpsCheckRunRequestItem[]) =>
    api.post<OpsCheckRun>('/ops-checks/run', { clusterId, items }),
  listRuns: (clusterId?: string, limit = 20) =>
    api.get<OpsCheckRun[]>('/ops-checks/runs', { params: { cluster_id: clusterId, limit } }),
  getRun: (runId: string) => api.get<OpsCheckRun>(`/ops-checks/runs/${runId}`),
  getRunItems: (runId: string) =>
    api.get<OpsCheckRunItem[]>(`/ops-checks/runs/${runId}/items`),
  itemHistory: (source: string, itemRefId: string, limit = 20) =>
    api.get<OpsCheckRunItem[]>(`/ops-checks/items/${source}/${itemRefId}/history`, { params: { limit } }),
};

export const k8sResourcesApi = {
  kinds: (clusterId: string) =>
    api.get<{ kinds: string[] }>(`/k8s/${clusterId}/resources/kinds`),
  list: (clusterId: string, kind: string, namespace?: string) =>
    api.get<import('@/types').K8sResourceListResponse>(
      `/k8s/${clusterId}/resources/${kind}`,
      { params: namespace ? { namespace } : undefined, timeout: 120_000 },
    ),
  yaml: (clusterId: string, kind: string, namespace: string, name: string) =>
    api.get<import('@/types').K8sResourceDetail>(
      `/k8s/${clusterId}/resources/${kind}/${namespace || '-'}/${name}/yaml`,
    ),
  resourceEvents: (clusterId: string, kind: string, namespace: string, name: string) =>
    api.get<import('@/types').K8sRelatedEventsResponse>(
      `/k8s/${clusterId}/resources/${kind}/${namespace || '-'}/${name}/events`,
    ),
  // ── 쓰기 액션 (require_operator + 감사 로그) ───────────────────────────────
  capabilities: (clusterId: string) =>
    api.get<import('@/types').K8sCapabilitiesResponse>(`/k8s/${clusterId}/resources-capabilities`),
  kindAvailability: (clusterId: string) =>
    api.get<import('@/types').KindAvailabilityResponse>(`/k8s/${clusterId}/kind-availability`, { timeout: 60_000 }),
  richNodes: (clusterId: string) =>
    api.get<import('@/types').K8sNodesResponse>(`/k8s/${clusterId}/nodes`, { timeout: 60_000 }),
  richPods: (clusterId: string, namespace?: string) =>
    api.get<import('@/types').K8sPodsResponse>(`/k8s/${clusterId}/pods`, { params: namespace ? { namespace } : undefined, timeout: 120_000 }),
  scale: (clusterId: string, kind: string, namespace: string, name: string, replicas: number) =>
    api.post<import('@/types').K8sWriteResult>(
      `/k8s/${clusterId}/resources/${kind}/${namespace || '-'}/${name}/scale`,
      { replicas },
    ),
  restart: (clusterId: string, kind: string, namespace: string, name: string) =>
    api.post<import('@/types').K8sWriteResult>(
      `/k8s/${clusterId}/resources/${kind}/${namespace || '-'}/${name}/restart`,
    ),
  remove: (clusterId: string, kind: string, namespace: string, name: string) =>
    api.delete<import('@/types').K8sWriteResult>(
      `/k8s/${clusterId}/resources/${kind}/${namespace || '-'}/${name}`,
    ),
  apply: (clusterId: string, kind: string, namespace: string, name: string, yaml: string) =>
    api.put<import('@/types').K8sWriteResult>(
      `/k8s/${clusterId}/resources/${kind}/${namespace || '-'}/${name}/yaml`,
      { yaml },
    ),
  cordon: (clusterId: string, name: string, unschedulable: boolean) =>
    api.post<import('@/types').K8sWriteResult>(
      `/k8s/${clusterId}/nodes/${name}/cordon`,
      { unschedulable },
    ),
  drain: (clusterId: string, name: string) =>
    api.post<import('@/types').K8sDrainResult>(`/k8s/${clusterId}/nodes/${name}/drain`, {}, { timeout: 120_000 }),
  // ── CRD (Custom Resources) ────────────────────────────────────────────────
  crds: (clusterId: string) =>
    api.get<import('@/types').K8sCrdListResponse>(`/k8s/${clusterId}/crds`),
  crdObjects: (clusterId: string, group: string, version: string, plural: string, namespace?: string) =>
    api.get<import('@/types').K8sResourceListResponse>(
      `/k8s/${clusterId}/crds/${group}/${version}/${plural}`,
      { params: namespace ? { namespace } : undefined, timeout: 60_000 },
    ),
  crdObjectYaml: (clusterId: string, group: string, version: string, plural: string, namespace: string, name: string) =>
    api.get<import('@/types').K8sResourceYaml>(
      `/k8s/${clusterId}/crds/${group}/${version}/${plural}/${namespace || '-'}/${name}/yaml`,
    ),
};

// ── K8s 자원 관리 (allocation: request vs 사용량 slack) ──────────────────────
export const k8sAllocationApi = {
  nodes: (clusterId: string, refresh = false) =>
    api.get<import('@/types').AllocNodesResponse>(
      `/k8s/${clusterId}/allocation/nodes`,
      { params: refresh ? { refresh: true } : undefined, timeout: 120_000 },
    ),
  node: (clusterId: string, node: string) =>
    api.get<import('@/types').AllocNodeRefreshResponse>(
      `/k8s/${clusterId}/allocation/nodes/${encodeURIComponent(node)}`,
      { timeout: 30_000 },
    ),
  namespaces: (clusterId: string, refresh = false) =>
    api.get<import('@/types').AllocNamespacesResponse>(
      `/k8s/${clusterId}/allocation/namespaces`,
      { params: refresh ? { refresh: true } : undefined, timeout: 120_000 },
    ),
  namespace: (clusterId: string, namespace: string) =>
    api.get<import('@/types').AllocNamespaceRefreshResponse>(
      `/k8s/${clusterId}/allocation/namespaces/${encodeURIComponent(namespace)}`,
      { timeout: 30_000 },
    ),
  workloads: (clusterId: string, namespace: string) =>
    api.get<import('@/types').AllocWorkloadsResponse>(
      `/k8s/${clusterId}/allocation/namespaces/${namespace}/workloads`,
      { timeout: 120_000 },
    ),
  pods: (clusterId: string, namespace: string, kind: string, name: string) =>
    api.get<import('@/types').AllocPodsResponse>(
      `/k8s/${clusterId}/allocation/namespaces/${namespace}/workloads/${kind}/${name}/pods`,
      { timeout: 120_000 },
    ),
};

// ── Helm 릴리스 뷰어 (읽기 전용) ─────────────────────────────────────────────
export const k8sHelmApi = {
  releases: (clusterId: string, namespace?: string) =>
    api.get<import('@/types').HelmReleaseListResponse>(
      `/k8s/${clusterId}/helm/releases`,
      { params: namespace ? { namespace } : undefined, timeout: 60_000 },
    ),
  history: (clusterId: string, namespace: string, name: string) =>
    api.get<{ count: number; items: import('@/types').HelmHistoryItem[] }>(
      `/k8s/${clusterId}/helm/releases/${namespace}/${name}/history`,
    ),
  values: (clusterId: string, namespace: string, name: string) =>
    api.get<{ name: string; namespace: string; yaml: string }>(
      `/k8s/${clusterId}/helm/releases/${namespace}/${name}/values`,
    ),
};

// ── 스트리밍 URL 헬퍼 (인증 fetch / WebSocket 에서 사용) ──────────────────────
export const k8sStreamUrls = {
  /** 클러스터 이벤트 SSE — Authorization 헤더 fetch 로 소비. */
  events: (clusterId: string, namespace?: string) => {
    const qs = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return `/api/v1/analyze/clusters/${clusterId}/events/stream${qs}`;
  },
  /** 파드 로그 SSE 스트림 — Authorization 헤더 fetch 로 소비. */
  logsStream: (
    clusterId: string, namespace: string, pod: string,
    opts: { container?: string; tailLines?: number; follow?: boolean; previous?: boolean; timestamps?: boolean },
  ) => {
    const p = new URLSearchParams({
      tail_lines: String(opts.tailLines ?? 200),
      follow: String(opts.follow ?? true),
      previous: String(opts.previous ?? false),
      timestamps: String(opts.timestamps ?? true),
    });
    if (opts.container) p.set('container', opts.container);
    return `/api/v1/analyze/clusters/${clusterId}/namespaces/${namespace}/pods/${pod}/logs/stream?${p.toString()}`;
  },
  /** 파드 로그 전체 다운로드 (non-follow) — Authorization fetch → blob. */
  logsDownload: (clusterId: string, namespace: string, pod: string, container?: string, previous = false) => {
    const p = new URLSearchParams({ previous: String(previous) });
    if (container) p.set('container', container);
    return `/api/v1/analyze/clusters/${clusterId}/namespaces/${namespace}/pods/${pod}/logs/download?${p.toString()}`;
  },
  /** Pod exec WebSocket — 토큰은 query param 으로 전달(WS 는 헤더 불가). */
  exec: (clusterId: string, namespace: string, pod: string, container: string | undefined, token: string | null, command = '/bin/sh') => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const p = new URLSearchParams({ namespace, pod, command });
    if (container) p.set('container', container);
    if (token) p.set('token', token);
    return `${proto}://${window.location.host}/api/v1/k8s/${clusterId}/exec?${p.toString()}`;
  },
};

// ── 일일점검 리뷰: 리소스 수 추세 체크리스트 ──────────────────────────────────
export const metricTrendApi = {
  get: (clusterId: string, date?: string) =>
    api.get<import('@/types').MetricTrendResponse>(`/metric-trend/${clusterId}`, { params: date ? { date } : undefined }),
  snapshot: (clusterId: string) =>
    api.post<{ ok: boolean; queued: boolean; taskId: string }>(
      `/metric-trend/${clusterId}/snapshot`, {}, { timeout: 30_000 }),
  check: (clusterId: string, itemKey: string, isChecked: boolean, date?: string, note?: string) =>
    api.put(`/metric-trend/${clusterId}/check`, { itemKey, isChecked, date, note }),
  editSnapshot: (snapshotId: string, counts: Record<string, number>) =>
    api.put(`/metric-trend/snapshots/${snapshotId}`, { counts }),
  listItems: (clusterId?: string) =>
    api.get<{ items: import('@/types').MetricChecklistItemT[] }>(`/metric-trend/items/all`, { params: clusterId ? { cluster_id: clusterId } : undefined }),
  createItem: (body: Partial<import('@/types').MetricChecklistItemT>) =>
    api.post<import('@/types').MetricChecklistItemT>(`/metric-trend/items`, body),
  updateItem: (id: string, body: Partial<import('@/types').MetricChecklistItemT>) =>
    api.put<import('@/types').MetricChecklistItemT>(`/metric-trend/items/${id}`, body),
  deleteItem: (id: string) => api.delete(`/metric-trend/items/${id}`),
  getSchedule: () =>
    api.get<{ enabled: boolean; cron: string; lastRunAt: string | null; nextRun: string | null }>(`/metric-trend/schedule`),
  setSchedule: (enabled: boolean, cron: string) =>
    api.put<{ enabled: boolean; cron: string; nextRun: string | null }>(`/metric-trend/schedule`, { enabled, cron }),
};

// ── Reactions API (이모지 공감 — ops_note / work_item_comment / work_guide 공통) ──
export const reactionsApi = {
  get: (targetType: string, targetId: string) =>
    api.get<import('@/types').ReactionSummary>('/reactions', {
      params: { target_type: targetType, target_id: targetId },
    }),
  toggle: (targetType: string, targetId: string, emoji: string) =>
    api.post<import('@/types').ReactionSummary>('/reactions/toggle', { targetType, targetId, emoji }),
  batch: (targetType: string, targetIds: string[]) =>
    api.get<Record<string, import('@/types').ReactionSummary>>('/reactions/batch', {
      params: { target_type: targetType, target_ids: targetIds.join(',') },
    }),
};

export default api;
