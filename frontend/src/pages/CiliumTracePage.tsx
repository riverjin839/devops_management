import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { createPortal } from 'react-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Filter,
  Info,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Save,
  Square,
  Terminal,
  Trash2,
  Waves,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useClusters } from '@/hooks/useCluster';
import { useK8sHub } from '@/lib/k8sHub';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { useClusterStore } from '@/stores/clusterStore';
import { ClusterSidebar, ConfirmDialog, LogViewer, SearchableSelect, EmptyState, ErrorState, SelectClusterEmptyState, LoadingState, Skeleton, PageShell, RunLogPanel, useToast } from '@/components/common';
import { useRunLog, runLogged, consoleRunLines, type RunLog, type RunLogHandle } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { formatApiError } from '@/lib/utils';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import { classifyCiliumCommand, ciliumRulesFromLabels, CILIUM_READONLY_LABELS } from '@/lib/ciliumCommand';
import { getAuthToken } from '@/stores/authStore';
import api from '@/services/api';
import { useCommands, useCreateCommand } from '@/hooks/useCommands';
import { useAnalyzeNamespaces, useAnalyzePods } from '@/hooks/useIncidentAnalysis';

// ── Types (kept inline; this is the only consumer) ──────────────────────────
interface CiliumStatus {
  clusterId: string;
  ciliumInstalled: boolean;
  hubbleRelayInstalled: boolean;
  /** hubble-relay 확인 자체가 실패한 사유(RBAC 거부 등) — 있으면 "미설치"로 보지 않는다. */
  hubbleRelayError?: string | null;
  agentCount: number;
  ciliumVersion?: string | null;
  namespace: string;
  error?: string | null;
}
interface CiliumAgent {
  podName: string;
  namespace: string;
  nodeName?: string | null;
  nodeIp?: string | null;
  ready: boolean;
}
interface CiliumAgentsResponse {
  clusterId: string;
  agents: CiliumAgent[];
  error?: string | null;
}

/** SearchableSelect 옵션 라벨 — podName + node 로 호스트 번호 검색이 되게. */
function agentLabel(a: CiliumAgent): string {
  return `${a.podName}${a.nodeName ? ` · ${a.nodeName}` : ''}${a.ready ? '' : ' (준비 안 됨)'}`;
}
type BpfKind =
  | 'endpoint' | 'lb' | 'nat' | 'ct' | 'tunnel'
  | 'policy' | 'fs' | 'metrics' | 'ipcache' | 'node';

interface BpfInspectResponse {
  clusterId: string;
  kind: string;
  podName: string;
  raw: string;
  /** JSON 으로 파싱되면 서버가 원본을 싣지 않는다 — 원본은 download 로 받는다. */
  rawOmitted?: boolean;
  rawSize?: number;
  parsed?: Record<string, unknown>[] | Record<string, unknown> | null;
  isJson: boolean;
  error?: string | null;
  executed?: string | null;
}

const BPF_KINDS: { id: BpfKind; label: string; desc: string }[] = [
  { id: 'endpoint', label: 'Endpoints',    desc: 'cilium-dbg bpf endpoint list' },
  { id: 'lb',       label: 'LB / Services', desc: 'bpf lb list' },
  { id: 'nat',      label: 'NAT',          desc: 'bpf nat list' },
  { id: 'ct',       label: 'Conntrack',    desc: 'bpf ct list global' },
  { id: 'tunnel',   label: 'Tunnels',      desc: 'bpf tunnel list' },
  { id: 'ipcache',  label: 'IP Cache',     desc: 'bpf ipcache list' },
  { id: 'node',     label: 'Nodes',        desc: 'bpf node list' },
  { id: 'metrics',  label: 'Metrics',      desc: 'bpf metrics list' },
  { id: 'fs',       label: 'BPF FS',       desc: 'bpf fs show' },
  { id: 'policy',   label: 'Policy (per-EP)', desc: 'bpf policy get <id>' },
];

// ── API helpers ─────────────────────────────────────────────────────────────
const ciliumApi = {
  status: (clusterId: string) =>
    api.get<CiliumStatus>(`/cilium/${clusterId}/status`).then((r) => r.data),
  agents: (clusterId: string) =>
    api.get<CiliumAgentsResponse>(`/cilium/${clusterId}/agents`).then((r) => r.data),
  bpfInspect: (clusterId: string, body: { kind: BpfKind; podName?: string; namespace?: string; endpointId?: string }, signal?: AbortSignal) =>
    api.post<BpfInspectResponse>(`/cilium/${clusterId}/bpf-inspect`, {
      cluster_id: clusterId,
      kind: body.kind,
      pod_name: body.podName,
      namespace: body.namespace ?? 'kube-system',
      endpoint_id: body.endpointId,
    }, { signal }).then((r) => r.data),
  // BPF 맵 원본 파일 — 서버가 흘려보낸다(조회 응답에는 JSON 원본이 실리지 않음).
  bpfDownload: (clusterId: string, body: { kind: BpfKind; podName?: string; endpointId?: string; format: 'json' | 'text' }, signal?: AbortSignal) =>
    api.post<Blob>(`/cilium/${clusterId}/bpf-inspect/download`, {
      cluster_id: clusterId,
      kind: body.kind,
      pod_name: body.podName,
      namespace: 'kube-system',
      endpoint_id: body.endpointId,
      format: body.format,
    }, { responseType: 'blob', timeout: 5 * 60_000, signal }).then((r) => r.data),
  // 직접 명령 읽기 전용 허용 목록(서버 원천) — 목록 밖은 admin 만 실행(정책 2).
  execAllowlist: (clusterId: string) =>
    api.get<{ clusterId: string; commands: string[]; adminOnlyOutside: boolean }>(`/cilium/${clusterId}/exec-command/allowlist`).then((r) => r.data),
  execCommand: (clusterId: string, body: { podName?: string; namespace?: string; commandArgs: string; timeout?: number }, signal?: AbortSignal) =>
    api.post<CiliumExecResponse>(`/cilium/${clusterId}/exec-command`, {
      pod_name: body.podName,
      namespace: body.namespace ?? 'kube-system',
      command_args: body.commandArgs,
      timeout: body.timeout ?? 30,
    }, { timeout: ((body.timeout ?? 30) + 30) * 1000, signal }).then((r) => r.data),
};

interface CiliumExecResponse {
  clusterId: string;
  podName: string;
  commandArgs: string;
  raw: string;
  exitCode: number | null;
  error: string | null;
  executed: string | null;
  durationMs: number;
}

// ── SSE stream helper (fetch-based, supports Authorization header) ──────────
interface SseStreamHandle {
  abort: () => void;
}

/**
 * 서버가 스트림을 닫으면(agent 파드 재시작·`kubectl exec` 종료·프록시 타임아웃) `onDone` 을 부른다 —
 * 예전엔 종료 콜백이 없어 화면이 멈춘 스트림을 "실행 중"으로 보여줬다(D-174 ②).
 * 사용자가 `abort()` 로 끊은 경우에는 어떤 콜백도 부르지 않는다.
 */
function startSseStream(
  url: string,
  onLine: (line: string) => void,
  onError: (err: string) => void,
  onDone: () => void,
): SseStreamHandle {
  const ac = new AbortController();
  const token = getAuthToken();
  fetch(url, {
    signal: ac.signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
    .then(async (resp) => {
      if (!resp.ok) {
        // 거절 사유(403 권한·테넌트, 404 클러스터 등)를 서버 detail 그대로 보여준다.
        let detail = '';
        try {
          const body = await resp.json();
          if (typeof body?.detail === 'string') detail = body.detail;
        } catch { /* 본문이 JSON 이 아니면 상태 코드만 */ }
        onError(`서버 오류 ${resp.status}${detail ? ` — ${detail}` : ''}`);
        return;
      }
      if (!resp.body) {
        onError('스트림 본문이 비어있습니다.');
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) { done = true; break; }
        const value = chunk.value;
        buf += decoder.decode(value, { stream: true });
        // SSE event 구분: "\n\n"
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const ln of block.split('\n')) {
            if (ln.startsWith('data:')) onLine(ln.slice(5).trimStart());
          }
        }
      }
      if (!ac.signal.aborted) onDone();
    })
    .catch((e) => {
      if (ac.signal.aborted) return;
      onError(e instanceof Error ? e.message : String(e));
    });
  return { abort: () => ac.abort() };
}

// ── Page ────────────────────────────────────────────────────────────────────

type TabId = 'bpf' | 'exec' | 'monitor' | 'hubble';
/** 탭 → 패널. BPF 맵 조회와 직접 명령은 같은 에이전트 선택을 공유하므로 한 패널(한 컴포넌트)에서 모드만 바꾼다. */
type PanelId = 'dbg' | 'monitor' | 'hubble';
const panelOf = (t: TabId): PanelId => (t === 'bpf' || t === 'exec' ? 'dbg' : t);

const TABS: { id: TabId; label: string; icon: typeof Database }[] = [
  { id: 'bpf',     label: 'BPF 맵 조회',  icon: Database },
  { id: 'exec',    label: '직접 명령',    icon: Terminal },
  { id: 'monitor', label: 'Cilium 모니터', icon: Activity },
  { id: 'hubble',  label: 'Hubble 흐름',  icon: Waves },
];

/** 실행 로그(모든 탭 공유) — 화면의 중심(DESIGN_SYSTEM §12.6.1). */
interface LogProps {
  runLog: RunLog;
  showLog: boolean;
  setShowLog: (v: boolean) => void;
}

export function CiliumTracePage() {
  const clustersQ = useClusters();
  const { clusters } = useClusterStore();
  const [localClusterId, setSelectedClusterId] = useState<string | null>(null);
  // K8s 클러스터 허브(D-240 3단계) 안에서는 허브가 고른 클러스터가 우선. 단독·아일랜드에선 로컬 선택.
  const hub = useK8sHub();
  const selectedClusterId = hub ? hub.clusterId : localClusterId;
  useEffect(() => {
    if (hub || localClusterId || clusters.length === 0) return;
    setSelectedClusterId(clusters[0].id);
  }, [hub, clusters, localClusterId]);
  // 선택 클러스터 운영등급 → 터미널 Appearance(개발/운영) 자동 적용.
  useTerminalEnvSync(clusters, selectedClusterId);
  const [tab, setTab] = useState<TabId>('bpf');
  // 한 번 연 패널은 탭을 옮겨도 마운트 상태로 둔다 — 모드별 결과·진행 중 스트림이 탭 전환으로 사라지지 않게(§12.6.1-3).
  const [visited, setVisited] = useState<Set<PanelId>>(() => new Set<PanelId>(['dbg']));
  const selectTab = (t: TabId) => {
    setTab(t);
    setVisited((prev) => (prev.has(panelOf(t)) ? prev : new Set(prev).add(panelOf(t))));
  };

  const cid = selectedClusterId ?? '';
  const pid = useId();
  const tabDomId = (t: TabId) => `${pid}-tab-${t}`;
  const panelDomId = (p: PanelId) => `${pid}-panel-${p}`;

  const statusQ = useQuery({
    queryKey: ['cilium', 'status', cid],
    queryFn: () => ciliumApi.status(cid),
    enabled: !!cid,
    staleTime: 30_000,
  });
  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = statusQ;
  const agentsQ = useQuery({
    queryKey: ['cilium', 'agents', cid],
    queryFn: () => ciliumApi.agents(cid),
    enabled: !!cid,
    staleTime: 30_000,
  });

  const agents = agentsQ.data?.agents ?? [];
  // 에이전트 목록 실패(요청 실패 또는 서버가 돌려준 error)는 "agent 없음"이 아니라 사유로 보여준다(D-173).
  const agentsError: unknown = agentsQ.isError
    ? agentsQ.error
    : agentsQ.data?.error ? new Error(agentsQ.data.error) : null;
  const agentsState: AgentsState = {
    agents,
    error: agentsError,
    retry: () => { void agentsQ.refetch(); },
  };

  // 실행 수명주기 로그 — BPF 조회·직접 명령·프리셋 저장·내보내기·두 스트림이 함께 쓴다(동시 실행은 [제목] 으로 구분).
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('cilium-bpf');
  const logProps: LogProps = { runLog, showLog, setShowLog };

  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
    selectTab(next);
    document.getElementById(tabDomId(next))?.focus();
  };

  const activePanel = panelOf(tab);
  const hubbleStatusError = statusQ.isError ? statusQ.error : status?.error ? new Error(status.error) : null;

  return (
    <div className="app-min-h-screen bg-background flex">
      <ClusterSidebar
        clusters={clusters}
        selectedId={selectedClusterId}
        onSelect={setSelectedClusterId}
        allowAll={false}
        iconOnly
      />
      <PageShell density="console" className="space-y-3">
        {/* Header */}
        <PageHeader
          icon={Waves}
          title="Cilium BPF 추적"
          description="BPF 맵 조회 · 직접 명령 · Cilium 모니터 · Hubble 흐름"
          actions={
            <button
              type="button"
              onClick={() => refetchStatus()}
              disabled={statusLoading || !cid}
              className="px-3 py-1.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`} aria-hidden />
              상태 새로고침
            </button>
          }
        />

        {/* Status strip */}
        {cid && (
          <StatusStrip
            status={status}
            loading={statusLoading}
            error={statusQ.isError ? statusQ.error : null}
            onRetry={() => { void refetchStatus(); }}
            agentCount={agents.length}
          />
        )}

        {/* Tabs */}
        <div role="tablist" aria-label="Cilium 추적 도구" className="flex items-center gap-0.5 bg-secondary rounded-xl p-0.5 w-fit max-w-full overflow-x-auto">
          {TABS.map((t) => {
            const Icon = t.icon;
            const selected = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={tabDomId(t.id)}
                aria-selected={selected}
                aria-controls={panelDomId(panelOf(t.id))}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(t.id)}
                onKeyDown={onTabKey}
                className={`px-3.5 py-1.5 text-sm font-medium rounded-xl flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                  selected ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="w-3.5 h-3.5" aria-hidden />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Tab body — 클러스터를 바꾸면 key 로 탭 상태를 새로 만든다: 이전 클러스터의 에이전트 파드·
            스트림·결과가 새 클러스터 경로로 이어지지 않게(스트림은 언마운트 정리에서 끊긴다). */}
        {clustersQ.isError && clusters.length === 0 ? (
          <ErrorState
            error={clustersQ.error}
            title="클러스터 목록을 불러오지 못했습니다"
            onRetry={() => { void clustersQ.refetch(); }}
          />
        ) : !cid ? (
          <SelectClusterEmptyState />
        ) : (
          <>
            <div role="tabpanel" id={panelDomId('dbg')} aria-labelledby={tabDomId(tab === 'exec' ? 'exec' : 'bpf')} hidden={activePanel !== 'dbg'}>
              <CiliumDbgTab key={cid} mode={tab === 'exec' ? 'exec' : 'bpf'} clusterId={cid} agentsState={agentsState} {...logProps} />
            </div>
            <div role="tabpanel" id={panelDomId('monitor')} aria-labelledby={tabDomId('monitor')} hidden={activePanel !== 'monitor'}>
              {visited.has('monitor') && <MonitorTab key={cid} clusterId={cid} agentsState={agentsState} {...logProps} />}
            </div>
            <div role="tabpanel" id={panelDomId('hubble')} aria-labelledby={tabDomId('hubble')} hidden={activePanel !== 'hubble'}>
              {visited.has('hubble') && (
                <HubbleTab
                  key={cid}
                  clusterId={cid}
                  statusLoading={statusLoading}
                  statusError={hubbleStatusError}
                  onRetryStatus={() => { void refetchStatus(); }}
                  hubbleInstalled={status?.hubbleRelayError ? undefined : status?.hubbleRelayInstalled}
                  {...logProps}
                />
              )}
            </div>
          </>
        )}
      </PageShell>
    </div>
  );
}

// ── 로그 중심 콘솔 공용 부품 (DESIGN_SYSTEM §12.6.1) ─────────────────────────

/** 좌(320px 제어)/우(실행 로그 3 + 결과 2) — 높이는 뷰포트에 고정, 스크롤은 카드 내부 한 번. */
const CONSOLE_GRID = 'grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-3 lg:h-[calc(100vh-var(--topbar-h)-10rem)] lg:min-h-[480px]';
const INPUT = 'w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50';
const LABEL = 'block text-sm text-muted-foreground mb-1';
const RUN_BTN = 'w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const SUB_BTN = 'flex-1 px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50';

/** 좌측 제어 카드 — 본문은 스크롤, 실행 바는 하단 고정(스크롤과 무관하게 항상 보인다). */
function ControlCard({ titleExtra, runBar, children }: { titleExtra?: React.ReactNode; runBar: React.ReactNode; children: React.ReactNode }) {
  return (
    <MacCard title="제어" titleExtra={titleExtra} rootClassName="min-w-0 flex flex-col lg:min-h-0" bodyPadding="p-0" className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
      <div className="border-t border-border p-3 space-y-2">{runBar}</div>
    </MacCard>
  );
}

/** 우측 열 — 상단 실행 로그(중심, 실행 전에도 대기 상태로 존재) + 하단 결과. */
function RightColumn({ runLog, showLog, setShowLog, idleHint, children }: LogProps & { idleHint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 min-h-0 flex flex-col gap-3">
      <div className="flex flex-col min-h-[240px] lg:min-h-0 flex-[3]">
        <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} fill idleHint={idleHint} />
      </div>
      <div className="flex flex-col min-h-[200px] lg:min-h-0 flex-[2]">{children}</div>
    </div>
  );
}

/** 실행 전 결과 자리 — 같은 위치에 플레이스홀더로 존재해 결과가 나와도 레이아웃이 흔들리지 않는다. */
function ResultPlaceholder({ icon, title, description }: { icon: typeof Database; title: string; description: string }) {
  return (
    <div className="min-w-0 flex-1 flex items-center justify-center min-h-[120px] rounded-md border border-border">
      <EmptyState compact icon={icon} title={title} description={description} />
    </div>
  );
}

/** 실행 바 위 오류 한 곳(§12.6.1-4) — 같은 내용은 실행 로그에도 error 줄로 남는다. */
function RunAlert({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div role="alert" className="px-3 py-2 text-sm rounded-md bg-status-critical/10 text-status-critical border border-status-critical/30 flex items-start gap-2 break-all">
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

function StopButton({ onClick, label = '중지' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} className={`${RUN_BTN} bg-secondary hover:bg-secondary/80 text-foreground border border-border`}>
      <Square className="w-4 h-4 fill-current" aria-hidden />
      {label}
    </button>
  );
}

/** 권한 부족(403)만 토스트 — 그 밖의 실패는 실행 로그 error 줄 + 실행 바 alert 로 모은다(§12.6.1-4). */
function toastForbidden(toast: ReturnType<typeof useToast>, title: string, error: unknown) {
  const st = (error as { response?: { status?: number } } | null)?.response?.status;
  if (st === 403) toast.error(`${title} — 권한이 없습니다`, formatApiError(error));
}

/** 접히는 "대상 에이전트" 섹션 — 자주 안 바꾸는 값이라 접어 두고 요약 한 줄만 보인다. */
function AgentSection({ podName, setPodName, agentsState, disabled }: {
  podName: string;
  setPodName: (v: string) => void;
  agentsState: AgentsState;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sid = useId();
  const a = agentsState.agents.find((x) => x.podName === podName);
  const summary = podName ? (a?.nodeName ?? podName) : '에이전트 미선택';
  return (
    <section className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`${sid}-body`}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-left hover:bg-secondary/50"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
        대상 에이전트
        <span className="ml-auto text-xs font-mono font-normal text-muted-foreground truncate" title={a ? agentLabel(a) : undefined}>
          {summary}
        </span>
      </button>
      {open && (
        <div id={`${sid}-body`} className="px-4 pb-4">
          <label htmlFor={`${sid}-pod`} className={LABEL}>에이전트 파드</label>
          <SearchableSelect
            id={`${sid}-pod`}
            value={podName}
            onChange={setPodName}
            options={agentsState.agents}
            getKey={(x) => x.podName}
            getLabel={agentLabel}
            placeholder="에이전트 파드 검색 (호스트 번호 등)"
            emptyText={agentsState.error ? '목록을 불러오지 못했습니다' : '에이전트 파드가 없습니다'}
            clearable={false}
            disabled={disabled}
            menuPortal
            className="w-full"
          />
          <p className="mt-1 text-xs text-muted-foreground">선택한 노드의 cilium-agent 파드에서 명령·스트림이 실행됩니다.</p>
        </div>
      )}
      {agentsState.error != null && (
        <div className="px-4 pb-3">
          <AgentsError state={agentsState} />
        </div>
      )}
    </section>
  );
}

// ── Status strip ────────────────────────────────────────────────────────────

interface StatusStripProps {
  status?: CiliumStatus;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  agentCount: number;
}

/**
 * 상태 줄 — 콘솔 화면이라 KPI 타일 행이 아니라 한 줄 정의 목록(§12.12-2, D-179 ④).
 * 정상 값은 중립색, 미설치·미가용만 `status-warning`. 조회 실패는 줄을 숨기지 않고 사유를 보여준다(D-173).
 */
function StatusStrip({ status, loading, error, onRetry, agentCount }: StatusStripProps) {
  if (loading) {
    return <Skeleton className="block w-full h-6 rounded-md" />;
  }
  if (error) {
    return <ErrorState compact error={error} title="Cilium 상태를 불러오지 못했습니다" onRetry={onRetry} />;
  }
  if (!status) return null;
  if (status.error) {
    return (
      <ErrorState
        compact
        error={new Error(status.error)}
        title="Cilium 상태 점검 중 문제가 발생했습니다"
        onRetry={onRetry}
      />
    );
  }
  const warn = 'text-status-warning';
  const items: { label: string; value: string; hint?: string; bad?: boolean }[] = [
    {
      label: 'Cilium',
      value: status.ciliumInstalled ? '설치됨' : '미설치',
      hint: status.ciliumVersion ?? undefined,
      bad: !status.ciliumInstalled,
    },
    { label: '에이전트 파드', value: String(agentCount), hint: status.namespace },
    {
      label: 'Hubble Relay',
      value: status.hubbleRelayError ? '확인 실패' : status.hubbleRelayInstalled ? '활성' : '없음 (설치 필요)',
      hint: status.hubbleRelayError ? status.hubbleRelayError : status.hubbleRelayInstalled ? 'svc/hubble-relay' : undefined,
      bad: !status.hubbleRelayInstalled,
    },
    {
      label: '추적 가용성',
      value: status.ciliumInstalled ? (status.hubbleRelayInstalled ? 'BPF + Hubble' : 'BPF 만') : '미가용',
      bad: !status.ciliumInstalled,
    },
  ];
  return (
    <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5 min-w-0">
          <dt className="text-muted-foreground">{it.label}</dt>
          <dd className={`font-medium ${it.bad ? warn : 'text-foreground'}`}>
            {it.value}
            {it.hint && <span className="ml-1 text-xs font-normal text-muted-foreground font-mono">{it.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── Tab 1·2: BPF 맵 조회 / 직접 명령 (cilium-dbg) ─────────────────────────────

interface AgentsState {
  agents: CiliumAgent[];
  /** 목록 조회 실패 또는 서버가 돌려준 error — null 이면 정상. */
  error: unknown;
  retry: () => void;
}

/** 에이전트 선택 아래 실패 사유 — select 는 비워 두고 "agent 없음"으로 오인하지 않게 한다(D-173). */
function AgentsError({ state }: { state: AgentsState }) {
  if (!state.error) return null;
  return (
    <ErrorState compact error={state.error} title="에이전트 파드 목록을 불러오지 못했습니다" onRetry={state.retry} />
  );
}

function CiliumDbgTab({ mode, clusterId, agentsState, runLog, showLog, setShowLog }: LogProps & {
  mode: 'bpf' | 'exec';
  clusterId: string;
  agentsState: AgentsState;
}) {
  const agents = agentsState.agents;
  const readyAgents = agents.filter((a) => a.ready);
  const toast = useToast();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const [kind, setKind] = useState<BpfKind>('endpoint');
  const [podName, setPodName] = useState<string>('');
  const [endpointId, setEndpointId] = useState<string>('');
  // 결과는 모드별로 보관한다 — 직접 명령 탭을 보고 와도 BPF 조회 결과가 남는다(§12.6.1-3).
  const [data, setData] = useState<BpfInspectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 직접 명령은 operate 권한(서버 require_operator) — viewer 에게 입력은 보이고 실행만 비활성(§12.9, D-172).
  // 읽기 전용 allowlist 밖 명령은 서버가 admin 만 허용한다(D-171 ④) — 화면도 같은 판정으로 안내·확인한다.
  const { canOperate, role, withHint, ariaWithHint } = useCanOperate(clusterId);
  const isAdmin = role === 'admin';

  // ad-hoc 직접 명령 + 프리셋
  const [adhoc, setAdhoc] = useState('');
  const [adhocRes, setAdhocRes] = useState<CiliumExecResponse | null>(null);
  const [adhocErr, setAdhocErr] = useState<string | null>(null);
  const [adhocRan, setAdhocRan] = useState<{ cmd: string; pod: string } | null>(null);
  const [adhocBusy, setAdhocBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 판정 규칙은 서버 allowlist 응답을 우선 쓰고, 실패·로딩 중에는 같은 내용의 로컬 목록으로 폴백한다.
  const allowlistQ = useQuery({
    queryKey: ['cilium', 'exec-allowlist', clusterId],
    queryFn: () => ciliumApi.execAllowlist(clusterId),
    enabled: !!clusterId,
    staleTime: 10 * 60_000,
  });
  const allowLabels = allowlistQ.data?.commands?.length ? allowlistQ.data.commands : CILIUM_READONLY_LABELS;
  const rules = useMemo(() => ciliumRulesFromLabels(allowlistQ.data?.commands), [allowlistQ.data]);
  const verdict = useMemo(() => classifyCiliumCommand(adhoc, rules), [adhoc, rules]);
  const { data: presetsResp } = useCommands({ category: 'cilium' });
  const createCmd = useCreateCommand();
  const presets = presetsResp?.data ?? [];

  // 실행 중지 — 요청별 AbortController(조회·직접 명령·내보내기).
  const bpfAbort = useRef<AbortController | null>(null);
  const execAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { bpfAbort.current?.abort(); execAbort.current?.abort(); }, []);

  const agentDesc = (name: string) => {
    const a = agents.find((x) => x.podName === name);
    return a ? agentLabel(a) : (name || '기본 에이전트');
  };

  const runAdhoc = useCallback(async () => {
    const v = classifyCiliumCommand(adhoc, rules);
    if (!clusterId || !v.args) return;
    const ac = new AbortController();
    execAbort.current = ac;
    setAdhocBusy(true); setAdhocErr(null);
    const r = await runLogged(runLog, {
      title: 'cilium-dbg 직접 명령',
      first: `${agentDesc(podName)} 에서 cilium-dbg ${v.args} 실행 요청${v.readOnly ? ' (조회 명령)' : ` — ${v.reason ?? '목록 밖 명령'} · admin 확인 후 실행`}`,
      fn: () => ciliumApi.execCommand(clusterId, { commandArgs: v.args, podName: podName || undefined }, ac.signal),
      summarize: (res) => [
        ...consoleRunLines({ host: res.podName, exitCode: res.exitCode, durationMs: res.durationMs, error: res.error }),
        ['info', `출력 ${res.raw ? res.raw.split('\n').filter((l) => l.trim()).length : 0}줄 — 본문은 결과 패널`],
      ],
    });
    if (r.ok) {
      setAdhocRan({ cmd: v.args, pod: podName });
      setAdhocRes(r.data);
      if (r.data.error) setAdhocErr(r.data.error);
    } else if (!r.aborted) {
      setAdhocErr(formatApiError(r.error));
      toastForbidden(toast, 'cilium-dbg 직접 명령', r.error);
    }
    execAbort.current = null;
    setAdhocBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runLog 함수들은 안정적, agentDesc 는 agents 로 결정
  }, [clusterId, adhoc, podName, agents, rules]);

  // 실행 버튼·Enter 공통 진입 — 조회 명령은 확인 없이 바로, 목록 밖 명령만 danger 확인창(§12.6.1-1).
  const adhocBlockedReason = !canOperate
    ? withHint('')
    : !verdict.args
      ? '실행할 명령을 입력하세요'
      : !verdict.readOnly && !isAdmin
        ? `읽기 전용 목록 밖 명령은 admin 만 실행할 수 있습니다 (${verdict.reason ?? verdict.subcommand})`
        : undefined;
  const requestRun = () => {
    if (adhocBusy || adhocBlockedReason) return;
    if (verdict.readOnly) void runAdhoc();
    else setConfirmOpen(true);
  };

  const savePreset = useCallback(async () => {
    const cmd = adhoc.trim();
    if (!cmd) return;
    const desc = window.prompt('프리셋 설명(라벨)을 입력하세요', cmd);
    if (desc == null) return;
    const full = cmd.startsWith('cilium-dbg') ? cmd : `cilium-dbg ${cmd}`;
    const r = await runLogged(runLog, {
      title: '프리셋 저장',
      first: `주요 명령어(category=cilium)에 "${desc || cmd}" — ${full} 저장 요청`,
      heartbeatMs: 0,
      fn: () => createCmd.mutateAsync({
        category: 'cilium',
        command: full,
        description: desc || cmd,
        importance: 'medium',
        tags: 'cilium,bpf',
      }),
      summarize: () => [['info', '프리셋 저장 완료 — 저장된 프리셋 목록에서 고를 수 있습니다']],
    });
    if (!r.ok && !r.aborted) toastForbidden(toast, '프리셋 저장', r.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runLog 함수들은 안정적
  }, [adhoc, createCmd]);

  useEffect(() => {
    if (!podName && readyAgents.length > 0) setPodName(readyAgents[0].podName);
  }, [readyAgents, podName]);

  const canQuery = !loading && !(kind === 'policy' && !endpointId);
  const run = useCallback(async () => {
    if (!clusterId) return;
    const ac = new AbortController();
    bpfAbort.current = ac;
    setLoading(true); setError(null);
    const spec = BPF_KINDS.find((k) => k.id === kind);
    const what = kind === 'policy' ? `bpf policy get ${endpointId}` : (spec?.desc ?? kind);
    const r = await runLogged(runLog, {
      title: `BPF 맵 조회 · ${spec?.label ?? kind}`,
      first: `${agentDesc(podName)} 에서 ${what} 실행 요청 (조회 전용)`,
      fn: () => ciliumApi.bpfInspect(clusterId, {
        kind,
        podName: podName || undefined,
        endpointId: kind === 'policy' ? (endpointId || undefined) : undefined,
      }, ac.signal),
      summarize: (res) => {
        const rows = res.isJson && Array.isArray(res.parsed) ? `${res.parsed.length}행(JSON)` : `${res.raw ? res.raw.split('\n').filter((l) => l.trim()).length : 0}줄(텍스트)`;
        const omitted = res.rawOmitted ? ` · 원본 ${Math.round((res.rawSize ?? 0) / 1024).toLocaleString()}KB 는 내보내기로 받음` : '';
        return [
          ['info', `${res.podName} · ${res.kind} · 결과 ${rows}${omitted}${res.executed ? ` · ${res.executed}` : ''}`],
          ...(res.error ? [['error', `오류 — ${res.error}`] as ['error', string]] : []),
        ];
      },
    });
    if (r.ok) {
      setData(r.data);
      if (r.data.error) setError(r.data.error);
    } else if (!r.aborted) {
      setError(formatApiError(r.error));
      toastForbidden(toast, 'BPF 맵 조회', r.error);
    }
    bpfAbort.current = null;
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runLog 함수들은 안정적, agentDesc 는 agents 로 결정
  }, [clusterId, kind, podName, endpointId, agents]);
  const requestQuery = () => { if (canQuery) void run(); };

  const saveBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [downloading, setDownloading] = useState(false);
  const downloadRaw = useCallback(async () => {
    if (!data || !clusterId) return;
    // 텍스트 결과는 이미 받은 원본을 그대로 저장한다.
    if (!data.rawOmitted) {
      if (data.raw) saveBlob(new Blob([data.raw], { type: 'text/plain' }), `cilium-bpf-${data.kind}-${Date.now()}.txt`);
      return;
    }
    // JSON 결과는 서버가 원본을 흘려보내 준다(조회 응답에는 원본을 싣지 않아 워커 메모리를 아낀다).
    const kb = Math.round((data.rawSize ?? 0) / 1024);
    const ac = new AbortController();
    bpfAbort.current = ac;
    setDownloading(true);
    const r = await runLogged(runLog, {
      title: `BPF 원본 내보내기 · ${data.kind}`,
      first: `${agentDesc(data.podName)} 에서 원본 JSON(약 ${kb.toLocaleString()}KB) 다운로드 요청 — 서버가 흘려보냄`,
      fn: () => ciliumApi.bpfDownload(clusterId, {
        kind: data.kind as BpfKind,
        podName: data.podName || undefined,
        endpointId: data.kind === 'policy' ? (endpointId || undefined) : undefined,
        format: 'json',
      }, ac.signal),
      summarize: (blob) => [['info', `받은 크기 ${Math.round(blob.size / 1024).toLocaleString()}KB — 파일로 저장`]],
    });
    if (r.ok) saveBlob(r.data, `cilium-bpf-${data.kind}-${Date.now()}.json`);
    else if (!r.aborted) {
      setError(formatApiError(r.error));
      toastForbidden(toast, 'BPF 원본 내보내기', r.error);
    }
    bpfAbort.current = null;
    setDownloading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runLog 함수들은 안정적, agentDesc 는 agents 로 결정
  }, [data, clusterId, endpointId, agents]);

  const runTitle = adhocBlockedReason ?? (verdict.readOnly ? '조회 명령 실행' : '실행 전 확인창이 열립니다');
  const runAria = !canOperate
    ? ariaWithHint('직접 명령 실행')
    : adhocBlockedReason ? `직접 명령 실행 — ${adhocBlockedReason}` : '직접 명령 실행';

  const isExec = mode === 'exec';
  const busy = isExec ? adhocBusy : (loading || downloading);
  const kindSpec = BPF_KINDS.find((k) => k.id === kind);

  const runBar = (
    <>
      <RunAlert message={isExec ? adhocErr : error} />
      {busy ? (
        <StopButton onClick={() => (isExec ? execAbort : bpfAbort).current?.abort()} />
      ) : isExec ? (
        <button
          type="button"
          onClick={requestRun}
          disabled={!!adhocBlockedReason}
          title={runTitle}
          aria-label={runAria}
          className={`${RUN_BTN} ${
            verdict.args && !verdict.readOnly
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : 'bg-primary hover:bg-primary/90 text-primary-foreground'
          }`}
        >
          <Play className="w-4 h-4" aria-hidden />직접 명령 실행
        </button>
      ) : (
        <button
          type="button"
          onClick={requestQuery}
          disabled={!canQuery}
          title={kind === 'policy' && !endpointId ? 'endpoint ID 를 입력하세요' : '조회 명령 — 확인 없이 바로 실행됩니다'}
          className={`${RUN_BTN} bg-primary hover:bg-primary/90 text-primary-foreground`}
        >
          <Play className="w-4 h-4" aria-hidden />BPF 맵 조회
        </button>
      )}
      <p className="text-center text-xs text-muted-foreground">
        {isExec ? (
          <><kbd className="px-1 rounded border border-border bg-secondary">Enter</kbd> 로도 실행</>
        ) : (
          <>조회 전용 — 확인 없이 바로 실행됩니다</>
        )}
      </p>
    </>
  );

  return (
    <div className={CONSOLE_GRID}>
      <ControlCard runBar={runBar}>
        <AgentSection podName={podName} setPodName={setPodName} agentsState={agentsState} />

        {!isExec ? (
          <div className="px-4 py-3 space-y-3">
            <div>
              <label htmlFor={f('kind')} className={LABEL}>조회할 BPF 맵</label>
              <select
                id={f('kind')}
                value={kind}
                onChange={(e) => setKind(e.target.value as BpfKind)}
                aria-describedby={f('kindDesc')}
                className={INPUT}
              >
                {BPF_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>{k.label}</option>
                ))}
              </select>
              <p id={f('kindDesc')} className="mt-1 text-xs text-muted-foreground font-mono">{kindSpec?.desc}</p>
            </div>
            {kind === 'policy' && (
              <div>
                <label htmlFor={f('epId')} className={LABEL}>endpoint ID</label>
                <input
                  id={f('epId')}
                  value={endpointId}
                  onChange={(e) => setEndpointId(e.target.value)}
                  onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); requestQuery(); } }}
                  placeholder="예: 1234"
                  className={`${INPUT} font-mono`}
                />
                <p className="mt-1 text-xs text-muted-foreground">정책을 조회할 endpoint 의 ID — Endpoints 맵에서 확인할 수 있습니다.</p>
              </div>
            )}
          </div>
        ) : (
          <div className="px-4 py-3 space-y-3">
            {presets.length > 0 && (
              <div>
                <label htmlFor={f('preset')} className={LABEL}>저장된 프리셋</label>
                <select
                  id={f('preset')}
                  value=""
                  onChange={(e) => { if (e.target.value) setAdhoc(e.target.value); }}
                  disabled={!canOperate}
                  title={withHint('저장된 프리셋을 입력란에 채웁니다')}
                  className={INPUT}
                >
                  <option value="">프리셋 선택…</option>
                  {presets.map((p) => {
                    const args = (p.command || '').replace(/^cilium-dbg\s+/, '');
                    const risky = !classifyCiliumCommand(args, rules).readOnly;
                    return (
                      <option key={p.id} value={args}>
                        {p.description || p.command}{risky ? ' (변경 명령)' : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
            <div>
              <label htmlFor={f('adhoc')} className={`${LABEL} flex items-center gap-1`}>
                <Terminal className="w-3 h-3" aria-hidden />
                cilium-dbg 하위 명령
              </label>
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-mono text-muted-foreground" aria-hidden>cilium-dbg</span>
                <input
                  id={f('adhoc')}
                  value={adhoc}
                  onChange={(e) => setAdhoc(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                    e.preventDefault();
                    requestRun();
                  }}
                  disabled={!canOperate}
                  placeholder="예: status --verbose"
                  aria-describedby={`${f('verdict')} ${f('adhocHelp')}`}
                  title={withHint('cilium-dbg 뒤에 붙일 하위 명령')}
                  className={`${INPUT} flex-1 min-w-0 font-mono`}
                />
              </div>
              <p
                id={f('verdict')}
                aria-live="polite"
                className={`mt-1.5 text-xs flex items-start gap-1.5 ${!verdict.args || verdict.readOnly ? 'text-muted-foreground' : 'text-status-critical'}`}
              >
                {verdict.args && (
                  <>
                    <span className="shrink-0 rounded-full border border-current px-2 font-semibold">
                      {verdict.readOnly ? '조회 명령' : '변경 명령'}
                    </span>
                    <span>
                      {verdict.readOnly
                        ? '확인 없이 바로 실행됩니다.'
                        : `${verdict.reason ?? '읽기 전용 목록 밖 명령'} — ${isAdmin
                          ? '실행 전에 확인합니다.'
                          : 'admin 만 실행할 수 있습니다. 조회 명령으로 바꾸거나 admin 에게 요청하세요.'}`}
                    </span>
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={savePreset}
                disabled={!adhoc.trim() || !canOperate}
                className={`${SUB_BTN} mt-2 w-full`}
                title={withHint('현재 명령을 프리셋으로 저장(주요 명령어 · category=cilium)')}
                aria-label={ariaWithHint('프리셋 저장')}
              >
                <Save className="w-3.5 h-3.5" aria-hidden /> 프리셋 저장
              </button>
            </div>
            <p id={f('adhocHelp')} className="text-xs text-muted-foreground">
              선택한 에이전트 파드에서 <code>cilium-dbg &lt;입력&gt;</code> 을 실행합니다(operator 이상). 읽기 전용 허용 목록의 조회 명령은 바로 실행되고,
              그 밖의 명령은 admin 만 확인창을 거쳐 실행할 수 있습니다. 임의 바이너리는 실행할 수 없고, 실행은 감사 로그에 기록됩니다.
            </p>
            <details className="group text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none list-none flex items-center gap-1.5 hover:text-foreground">
                <ChevronRight className="w-3.5 h-3.5 group-open:rotate-90 transition-transform" aria-hidden />
                읽기 전용 허용 목록 ({allowLabels.length}개)
              </summary>
              <p className="mt-1 font-mono leading-relaxed break-words">{allowLabels.join(' · ')}</p>
            </details>
          </div>
        )}
      </ControlCard>

      <RightColumn
        runLog={runLog}
        showLog={showLog}
        setShowLog={setShowLog}
        idleHint="조회·실행하면 요청·대상 파드·응답 요약이 여기에 실시간으로 쌓입니다."
      >
        {!isExec ? (
          !data ? (
            <ResultPlaceholder
              icon={Database}
              title={loading ? 'cilium-dbg 실행 중…' : '조회한 BPF 맵이 없습니다.'}
              description="대상 BPF 맵을 고르고 'BPF 맵 조회'를 누르면 결과가 여기에 표시됩니다."
            />
          ) : (
            <MacCard
              title="조회 결과"
              titleExtra={<span className="text-sm font-mono text-muted-foreground truncate">{data.kind} · {data.podName}</span>}
              actions={(data.raw || data.rawOmitted) ? (
                <button
                  type="button"
                  onClick={downloadRaw}
                  disabled={busy}
                  className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden /> 내보내기
                </button>
              ) : undefined}
              rootClassName="min-w-0 flex flex-col flex-1 min-h-0"
              bodyPadding="p-0"
              className="flex-1 min-h-0 overflow-auto"
            >
              {data.isJson && Array.isArray(data.parsed) ? (
                <BpfJsonTable rows={data.parsed} />
              ) : (data.raw || data.parsed) ? (
                <div className="p-3">
                  {/* 객체 형태 JSON 은 서버가 원본을 빼고 보내므로 파싱본을 펼쳐 보여 준다. */}
                  <LogViewer text={data.raw || JSON.stringify(data.parsed, null, 2)} maxHeight="max-h-none" />
                </div>
              ) : (
                <EmptyState compact title="출력이 없습니다." description="선택한 맵이 아무것도 돌려주지 않았습니다." />
              )}
            </MacCard>
          )
        ) : !adhocRes || !adhocRan ? (
          <ResultPlaceholder
            icon={Terminal}
            title={adhocBusy ? 'cilium-dbg 실행 중…' : '아직 실행 결과가 없습니다.'}
            description="cilium-dbg 하위 명령을 실행하면 출력이 여기에 표시됩니다."
          />
        ) : (
          <MacCard
            title="실행 결과"
            titleExtra={
              <span className="flex items-center gap-3 flex-wrap min-w-0 text-sm text-muted-foreground">
                <code className="font-mono truncate" title={`cilium-dbg ${adhocRan.cmd}`}>cilium-dbg {adhocRan.cmd}</code>
                {adhocRan.pod && <span className="font-mono truncate">{adhocRan.pod}</span>}
                {adhocRes.exitCode != null && <span className="font-mono">exit {adhocRes.exitCode}</span>}
                <span className="tabular-nums">{adhocRes.durationMs}ms</span>
              </span>
            }
            actions={
              <button
                type="button"
                onClick={() => { setAdhocRan(null); setAdhocRes(null); setAdhocErr(null); }}
                disabled={adhocBusy}
                aria-label="직접 명령 결과 닫기"
                title="직접 명령 결과 닫기"
                className="p-1 rounded-xl hover:bg-secondary disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" aria-hidden />
              </button>
            }
            rootClassName="min-w-0 flex flex-col flex-1 min-h-0"
            bodyPadding="p-3"
            className="flex-1 min-h-0 overflow-auto"
          >
            <LogViewer text={adhocRes.raw || '(출력 없음)'} maxHeight="max-h-none" />
          </MacCard>
        )}
      </RightColumn>

      <ConfirmDialog
        open={confirmOpen}
        danger
        title="쓰기·삭제 가능 cilium-dbg 명령 실행"
        description="읽기 전용 목록 밖 명령입니다. CNI 상태를 바꾸거나 되돌릴 수 없을 수 있습니다."
        confirmLabel="실행"
        busy={adhocBusy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); void runAdhoc(); }}
      >
        <dl className="space-y-1 text-sm">
          <div className="flex gap-2"><dt className="text-muted-foreground w-20 flex-shrink-0">대상 파드</dt><dd className="font-mono break-all">{agentDesc(podName)}</dd></div>
          <div className="flex gap-2"><dt className="text-muted-foreground w-20 flex-shrink-0">명령</dt><dd className="font-mono break-all">cilium-dbg {verdict.args}</dd></div>
          <div className="flex gap-2"><dt className="text-muted-foreground w-20 flex-shrink-0">사유</dt><dd className="text-status-critical">{verdict.reason ?? '읽기 전용 목록 밖 명령'}</dd></div>
        </dl>
      </ConfirmDialog>
    </div>
  );
}

function BpfJsonTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows.slice(0, 50)) Object.keys(r).forEach((k) => set.add(k));
    return Array.from(set);
  }, [rows]);
  if (rows.length === 0) {
    return <EmptyState compact title="결과가 비어 있습니다." description="선택한 맵에 항목이 없습니다. 다른 맵이나 에이전트를 골라 다시 조회하세요." />;
  }
  // 스크롤은 결과 카드 본문 한 겹 — 표 자체에는 max-h 를 걸지 않는다(§12.6.1). 머리행은 카드 본문 기준 sticky.
  return (
    <table className="text-sm w-full border-collapse">
      <thead className="sticky top-0 bg-card">
        <tr>
          {cols.map((c) => (
            <th key={c} className="text-left px-3 py-2 border-b border-border font-medium text-xs text-muted-foreground whitespace-nowrap">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className={i % 2 === 0 ? 'bg-background' : 'bg-secondary/15'}>
            {cols.map((c) => (
              <td key={c} className="px-3 py-1.5 border-b border-border/40 align-top max-w-[320px]">
                <span className="block truncate font-mono text-xs" title={String(r[c] ?? '')}>
                  {formatCell(r[c])}
                </span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ── Tab 2: Cilium Monitor stream ─────────────────────────────────────────────

const MONITOR_TYPES = ['drop', 'trace', 'capture', 'debug', 'recorder', 'agent', 'l7'] as const;
type MonitorType = typeof MONITOR_TYPES[number];

interface MonitorEvent {
  ts: number;
  raw: string;
  kind?: string;
  parsed?: Record<string, unknown>;
}

/** 서버가 스트림을 닫았을 때 목록 끝에 붙는 안내 줄(D-174 ②). */
const STREAM_ENDED_NOTE = '스트림이 종료됐습니다(서버) — 다시 시작하세요';

/** 스트림 수명주기 알림 — 실행 로그에 남기려고 쓴다(첫 이벤트·서버 종료·오류). */
interface StreamLifecycle {
  onFirst?: () => void;
  onError?: (err: string, received: number) => void;
  onEnd?: (received: number) => void;
}

/**
 * Monitor·Hubble 공용 SSE 스트림 상태 — 80ms 묶음 반영(화면 폭주 방지) + 일시정지 + 서버 종료 감지.
 *
 * D-174 ① 일시정지는 `pausedRef` 로 읽는다 — 예전엔 flush 타이머가 `start()` 시점의 `paused`(=false)를
 * 클로저로 잡아 눌러도 화면이 계속 흘렀다. 일시정지 중 들어온 이벤트는 버퍼(상한 `cap`)에 모였다가
 * 재개 시 반영된다. D-174 ② 서버 종료·오류·사용자 중단 모두 같은 `finish()` 로 타이머를 정리하고
 * "실행 중" 상태를 해제한다.
 */
function useBufferedSseStream<T>(cap: number, makeNote: (text: string) => T) {
  const [events, setEvents] = useState<T[]>([]);
  const [running, setRunning] = useState(false);
  const [paused, setPausedState] = useState(false);
  const [ended, setEnded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pausedRef = useRef(false);
  const handleRef = useRef<SseStreamHandle | null>(null);
  const buffer = useRef<T[]>([]);
  const timer = useRef<number | null>(null);
  const gen = useRef(0);
  /** 이번 스트림에서 받은 이벤트 수(상한으로 잘린 것 포함) — 실행 로그 요약용. */
  const received = useRef(0);

  const setPaused = (v: boolean) => { pausedRef.current = v; setPausedState(v); };
  const clearTimer = () => {
    if (timer.current != null) window.clearInterval(timer.current);
    timer.current = null;
  };
  const flush = (force: boolean) => {
    if ((!force && pausedRef.current) || buffer.current.length === 0) return;
    const chunk = buffer.current;
    buffer.current = [];
    setEvents((prev) => {
      const next = [...prev, ...chunk];
      return next.length > cap ? next.slice(next.length - cap) : next;
    });
  };
  const finish = () => {
    clearTimer();
    handleRef.current = null;
    setRunning(false);
    setPaused(false);
  };

  // 화면 이탈 시 스트림·타이머 정리
  useEffect(() => () => {
    gen.current += 1;
    handleRef.current?.abort();
    if (timer.current != null) window.clearInterval(timer.current);
  }, []);

  const start = (url: string, toEvent: (line: string) => T, life: StreamLifecycle = {}) => {
    handleRef.current?.abort();
    clearTimer();
    const my = ++gen.current;
    buffer.current = [];
    received.current = 0;
    setEvents([]);
    setErr(null);
    setEnded(false);
    setRunning(true);
    setPaused(false);
    handleRef.current = startSseStream(
      url,
      (line) => {
        if (my !== gen.current) return;
        received.current += 1;
        if (received.current === 1) life.onFirst?.();
        buffer.current.push(toEvent(line));
        if (buffer.current.length > cap) buffer.current.splice(0, buffer.current.length - cap);
      },
      (e) => {
        if (my !== gen.current) return;
        flush(true);
        finish();
        setErr(e);
        life.onError?.(e, received.current);
      },
      () => {
        if (my !== gen.current) return;
        buffer.current.push(makeNote(STREAM_ENDED_NOTE));
        flush(true);
        finish();
        setEnded(true);
        life.onEnd?.(received.current);
      },
    );
    timer.current = window.setInterval(() => flush(false), 80);
  };

  /** 사용자 중지 — 받은 이벤트 수를 돌려준다. */
  const stop = (): number => {
    gen.current += 1;
    handleRef.current?.abort();
    flush(true);
    finish();
    return received.current;
  };

  const clear = () => { setEvents([]); buffer.current = []; };
  const togglePause = () => setPaused(!pausedRef.current);

  return { events, running, paused, ended, err, start, stop, clear, togglePause };
}

/**
 * 스트림 1건을 실행 로그에 잇는다 — 시작 요청·첫 이벤트·서버 종료·오류·사용자 중지를 한 실행으로 기록.
 * 이벤트 본문은 결과 패널(실시간 이벤트/흐름)에 쌓이고, 실행 로그에는 수명주기만 남긴다.
 */
function useStreamRunLog(runLog: RunLog) {
  const handle = useRef<RunLogHandle | null>(null);
  // 언마운트(클러스터 전환) 시 스트림이 끊기므로 실행도 끝낸다.
  useEffect(() => () => {
    handle.current?.log('warn', '화면 전환으로 스트림 종료');
    handle.current?.end();
    handle.current = null;
  }, []);
  const begin = (title: string, first: string): StreamLifecycle => {
    handle.current?.end();
    const h = runLog.begin(title, first);
    handle.current = h;
    const t0 = performance.now();
    const secs = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
    return {
      onFirst: () => h.log('info', `첫 이벤트 수신 (${secs()}) — 이벤트 본문은 결과 패널`),
      onError: (e, n) => { h.log('error', `스트림 오류 — ${e} (수신 ${n}건, ${secs()})`); h.end(); if (handle.current === h) handle.current = null; },
      onEnd: (n) => { h.log('warn', `${STREAM_ENDED_NOTE} (수신 ${n}건, ${secs()})`); h.end(); if (handle.current === h) handle.current = null; },
    };
  };
  const stopped = (n: number) => {
    const h = handle.current;
    if (!h) return;
    h.log('info', `사용자가 스트림을 중지했습니다 — 수신 ${n}건`);
    h.end();
    handle.current = null;
  };
  const note = (level: 'info' | 'warn', msg: string) => handle.current?.log(level, msg);
  return { begin, stopped, note };
}

/** 스트림 카드 제목 옆 상태 — 실행 중도 중립색 아이콘(§12.12-3, D-179 ③). */
function StreamIndicator({ running, paused, ended, count }: { running: boolean; paused: boolean; ended: boolean; count: number }) {
  const label = running ? (paused ? '일시정지' : '수신 중') : ended ? '서버 종료' : '중지됨';
  return (
    <span className="text-xs text-muted-foreground tabular-nums inline-flex items-center gap-1" aria-live="polite">
      {running && !paused ? <Radio className="w-3 h-3" aria-hidden /> : running ? <Pause className="w-3 h-3" aria-hidden /> : null}
      {label} · {count}건
    </span>
  );
}

/** 스트림 실행 바 — 시작 ↔ 중지(전폭) + 일시정지·비우기. */
function StreamRunBar({ running, paused, canClear, startLabel, onStart, onStop, onTogglePause, onClear, error }: {
  running: boolean;
  paused: boolean;
  canClear: boolean;
  startLabel: string;
  onStart: () => void;
  onStop: () => void;
  onTogglePause: () => void;
  onClear: () => void;
  error: string | null;
}) {
  return (
    <>
      <RunAlert message={error} />
      {running ? (
        <StopButton onClick={onStop} />
      ) : (
        <button type="button" onClick={onStart} className={`${RUN_BTN} bg-primary hover:bg-primary/90 text-primary-foreground`}>
          <Play className="w-4 h-4" aria-hidden /> {startLabel}
        </button>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={onTogglePause} disabled={!running} aria-pressed={paused} className={SUB_BTN}>
          {paused ? <Play className="w-3.5 h-3.5" aria-hidden /> : <Pause className="w-3.5 h-3.5" aria-hidden />}
          {paused ? '재개' : '일시정지'}
        </button>
        <button type="button" onClick={onClear} disabled={!canClear} className={SUB_BTN}>
          <Trash2 className="w-3.5 h-3.5" aria-hidden /> 비우기
        </button>
      </div>
      <p className="text-center text-xs text-muted-foreground">조회 전용 스트림 — 확인 없이 바로 시작됩니다</p>
    </>
  );
}

function MonitorTab({ clusterId, agentsState, runLog, showLog, setShowLog }: LogProps & { clusterId: string; agentsState: AgentsState }) {
  const agents = agentsState.agents;
  const readyAgents = agents.filter((a) => a.ready);
  const fid = useId();
  const [podName, setPodName] = useState<string>('');
  const [types, setTypes] = useState<Set<MonitorType>>(new Set(['drop', 'trace']));
  const [relatedTo, setRelatedTo] = useState<string>('');
  const [startErr, setStartErr] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const stream = useBufferedSseStream<MonitorEvent>(1000, (text) => ({ ts: Date.now(), raw: text, kind: 'meta' }));
  const { events, running, paused, ended } = stream;
  const slog = useStreamRunLog(runLog);

  useEffect(() => {
    if (!podName && readyAgents.length > 0) setPodName(readyAgents[0].podName);
  }, [readyAgents, podName]);

  const start = () => {
    if (!podName) { setStartErr('에이전트 파드를 선택하세요.'); return; }
    setStartErr(null);
    const params = new URLSearchParams({
      pod_name: podName,
      ...(types.size > 0 ? { types: Array.from(types).join(',') } : {}),
      ...(relatedTo ? { related_to: relatedTo } : {}),
    });
    const a = agents.find((x) => x.podName === podName);
    const life = slog.begin(
      'Cilium 모니터 스트림',
      `${a ? agentLabel(a) : podName} 에서 모니터 스트림 시작 요청 — 유형 ${types.size > 0 ? Array.from(types).join(',') : '전체'}${relatedTo ? ` · related-to ${relatedTo}` : ''}`,
    );
    stream.start(`/api/v1/cilium/${clusterId}/monitor/stream?${params.toString()}`, (line) => {
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(line); } catch { /* keep raw */ }
      const kind = (parsed && typeof parsed.kind === 'string') ? (parsed.kind as string) : undefined;
      return { ts: Date.now(), raw: line, kind, parsed };
    }, life);
  };

  const filtered = useMemo(() => {
    if (!filterText.trim()) return events;
    const q = filterText.toLowerCase();
    return events.filter((e) => e.raw.toLowerCase().includes(q));
  }, [events, filterText]);

  const typeSummary = types.size === 0 ? '모든 유형' : Array.from(types).join(', ');

  return (
    <div className={CONSOLE_GRID}>
      <ControlCard
        titleExtra={<StreamIndicator running={running} paused={paused} ended={ended} count={events.length} />}
        runBar={
          <StreamRunBar
            running={running}
            paused={paused}
            canClear={events.length > 0}
            startLabel="모니터 시작"
            onStart={start}
            onStop={() => slog.stopped(stream.stop())}
            onTogglePause={() => { slog.note('info', paused ? '화면 반영 재개' : '화면 반영 일시정지 — 수신은 계속됩니다'); stream.togglePause(); }}
            onClear={stream.clear}
            error={startErr ?? stream.err}
          />
        }
      >
        <AgentSection podName={podName} setPodName={setPodName} agentsState={agentsState} disabled={running} />
        <div className="px-4 py-3 space-y-3">
          <div>
            <p className={LABEL}>이벤트 유형</p>
            <TypeFilter types={types} setTypes={setTypes} disabled={running} />
            <p className="mt-1 text-xs text-muted-foreground">선택: {typeSummary}</p>
          </div>
          <div>
            <label htmlFor={`${fid}-related`} className={LABEL}>related-to (endpoint ID)</label>
            <input
              id={`${fid}-related`}
              value={relatedTo}
              onChange={(e) => setRelatedTo(e.target.value)}
              disabled={running}
              placeholder="예: 1234"
              className={`${INPUT} font-mono`}
            />
            <p className="mt-1 text-xs text-muted-foreground">비우면 모든 endpoint 의 이벤트를 받습니다. 실행 중에는 바꿀 수 없습니다.</p>
          </div>
        </div>
      </ControlCard>

      <RightColumn
        runLog={runLog}
        showLog={showLog}
        setShowLog={setShowLog}
        idleHint="모니터를 시작하면 접속·첫 이벤트·종료가 여기에 실시간으로 쌓입니다."
      >
        <MacCard
          title="실시간 이벤트"
          actions={
            <div className="flex items-center gap-2">
              <Filter className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
              <input
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                placeholder="텍스트로 필터링…"
                aria-label="이벤트 텍스트 필터"
                className="w-48 text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          }
          rootClassName="min-w-0 flex flex-col flex-1 min-h-0"
          bodyPadding="p-0"
          className="flex flex-col flex-1 min-h-0"
        >
          <EventList events={filtered} />
        </MacCard>
      </RightColumn>
    </div>
  );
}

function TypeFilter({ types, setTypes, disabled }: { types: Set<MonitorType>; setTypes: (s: Set<MonitorType>) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const label = types.size === 0 ? '모든 유형' : Array.from(types).join(', ');
  const popId = useId();

  // 드롭다운 열릴 때 버튼 위치 측정 — 부모 MacCard 의 overflow:hidden 회피용 portal.
  useEffect(() => {
    if (!open) { setPos(null); return; }
    const update = () => {
      const el = buttonRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, left: rect.left });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // 외부 클릭·Esc 로 닫기 — Esc 는 버튼으로 포커스를 돌려 키보드 사용자가 길을 잃지 않게 한다(D-178).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={`이벤트 유형 필터 — ${label}`}
        className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50 flex items-center gap-1.5 w-full"
      >
        <Filter className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
        <span className="truncate">{label}</span>
        <ChevronDown className="w-3 h-3 text-muted-foreground" aria-hidden />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          id={popId}
          role="group"
          aria-label="이벤트 유형"
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 w-56 bg-card border border-border rounded-md shadow-card p-2 space-y-1"
        >
          {MONITOR_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm px-2 py-1 rounded-md hover:bg-secondary cursor-pointer">
              <input
                type="checkbox"
                className="accent-primary"
                checked={types.has(t)}
                onChange={(e) => {
                  const next = new Set(types);
                  if (e.target.checked) next.add(t); else next.delete(t);
                  setTypes(next);
                }}
              />
              {t}
            </label>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

function EventList({ events }: { events: MonitorEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  // 자동 스크롤
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length]);

  if (events.length === 0) {
    return (
      <EmptyState compact title="이벤트가 없습니다." description="모니터 시작을 누르거나 잠시 기다려 주세요." />
    );
  }
  // 스크롤은 결과 카드 안 이 목록 한 겹 — 바깥에 max-h 를 또 걸지 않는다(§12.6.1).
  return (
    <div ref={ref} className="flex-1 min-h-0 overflow-auto font-mono text-xs leading-snug bg-background">
      {events.map((e, i) => (
        <div
          key={i}
          className={`px-3 py-1.5 border-b border-border/30 hover:bg-secondary/30 ${
            e.kind === 'error' ? 'text-status-critical' : e.kind === 'meta' ? 'text-muted-foreground' : ''
          }`}
        >
          <span className="text-muted-foreground mr-2">{new Date(e.ts).toLocaleTimeString()}</span>
          <span className="break-all">{prettyEvent(e)}</span>
        </div>
      ))}
    </div>
  );
}

function prettyEvent(e: MonitorEvent): string {
  if (!e.parsed) return e.raw;
  const p = e.parsed as Record<string, unknown>;
  if (e.kind === 'meta') return `[meta] ${String(p.executed ?? e.raw)}`;
  if (e.kind === 'error') return `[error] ${String(p.data ?? e.raw)}`;
  // cilium monitor json 의 흔한 필드 요약
  const verdict = p.Verdict ?? p.verdict;
  const reason = p.reason ?? p.Reason ?? p.dropReason;
  const src = p.source ?? p.Source;
  const dst = p.destination ?? p.Destination;
  const summary = p.summary ?? p.Summary;
  const parts: string[] = [];
  if (verdict) parts.push(String(verdict));
  if (reason) parts.push(`reason=${String(reason)}`);
  if (src) parts.push(`src=${shortDesc(src)}`);
  if (dst) parts.push(`dst=${shortDesc(dst)}`);
  if (summary) parts.push(String(summary));
  return parts.length > 0 ? parts.join(' · ') : e.raw;
}

function shortDesc(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.podName ?? o.pod_name ?? o.namespace ?? o.identity ?? JSON.stringify(o));
  }
  return String(v);
}

// ── Tab 3: Hubble flow stream ───────────────────────────────────────────────

interface HubbleFlowEvent {
  ts: number;
  raw: string;
  parsed?: Record<string, unknown>;
  /** 스트림 안내 줄(서버 종료 등) — flow 가 아니다. */
  note?: string;
}

// Hubble flow 필터 자동완성용 정적 enum.
const HUBBLE_PROTOCOLS = ['tcp', 'udp', 'http', 'dns', 'icmp', 'sctp', 'kafka', 'grpc'] as const;
const HUBBLE_VERDICTS = ['FORWARDED', 'DROPPED', 'AUDIT', 'ERROR', 'REDIRECTED', 'TRACED'] as const;

interface HubbleTabProps {
  clusterId: string;
  statusLoading: boolean;
  /** 상태 조회 실패(요청 실패 또는 서버 error) — 미설치로 오인하지 않도록 따로 받는다(D-173). */
  statusError: unknown;
  onRetryStatus: () => void;
  /** 상태 조회 성공 시에만 boolean. */
  hubbleInstalled?: boolean;
}

function HubbleTab({ clusterId, statusLoading, statusError, onRetryStatus, hubbleInstalled, runLog, showLog, setShowLog }: HubbleTabProps & LogProps) {
  const [filters, setFilters] = useState({
    fromPod: '',
    toPod: '',
    fromNamespace: '',
    toNamespace: '',
    protocol: '',
    verdict: '',
  });
  const fid = useId();
  const stream = useBufferedSseStream<HubbleFlowEvent>(1500, (text) => ({ ts: Date.now(), raw: text, note: text }));
  const { events, running, paused, ended } = stream;
  const slog = useStreamRunLog(runLog);

  // 클러스터 namespace 목록 — datalist 소스.
  const { data: nsData } = useAnalyzeNamespaces(clusterId);
  // 입력된 from/to namespace 의 pod 목록 — datalist 소스.
  const { data: fromPodsData } = useAnalyzePods(clusterId, filters.fromNamespace);
  const { data: toPodsData } = useAnalyzePods(clusterId, filters.toNamespace);

  // 실시간 flow 이벤트에서 관측된 namespace/pod 누적 — autocomplete 보조.
  const [seenNs, setSeenNs] = useState<Set<string>>(new Set());
  const [seenPods, setSeenPods] = useState<Set<string>>(new Set());

  // 들어오는 events 마다 flow.source/destination 의 namespace, pod_name 추출.
  useEffect(() => {
    if (events.length === 0) return;
    const ns = new Set(seenNs);
    const pods = new Set(seenPods);
    let nsChanged = false;
    let podsChanged = false;
    for (const ev of events) {
      const flow = (ev.parsed as Record<string, unknown> | undefined)?.flow as Record<string, unknown> | undefined;
      const candidates: Array<Record<string, unknown> | undefined> = [
        flow?.source as Record<string, unknown> | undefined,
        flow?.destination as Record<string, unknown> | undefined,
      ];
      for (const ep of candidates) {
        if (!ep) continue;
        const epNs = typeof ep.namespace === 'string' ? ep.namespace : undefined;
        const epPod = typeof ep.pod_name === 'string' ? ep.pod_name : undefined;
        if (epNs && !ns.has(epNs)) { ns.add(epNs); nsChanged = true; }
        if (epNs && epPod) {
          const key = `${epNs}/${epPod}`;
          if (!pods.has(key)) { pods.add(key); podsChanged = true; }
        }
      }
    }
    if (nsChanged) setSeenNs(ns);
    if (podsChanged) setSeenPods(pods);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // ── datalist 데이터 합치기 ───────────────────────────────────────────────
  const namespaceOptions = useMemo(() => {
    const set = new Set<string>(seenNs);
    for (const n of nsData?.namespaces ?? []) set.add(n.name);
    return Array.from(set).sort();
  }, [nsData, seenNs]);

  const fromPodOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of fromPodsData?.pods ?? []) set.add(`${p.namespace}/${p.name}`);
    for (const k of seenPods) {
      if (!filters.fromNamespace || k.startsWith(`${filters.fromNamespace}/`)) set.add(k);
    }
    return Array.from(set).sort();
  }, [fromPodsData, seenPods, filters.fromNamespace]);

  const toPodOptions = useMemo(() => {
    const set = new Set<string>();
    for (const p of toPodsData?.pods ?? []) set.add(`${p.namespace}/${p.name}`);
    for (const k of seenPods) {
      if (!filters.toNamespace || k.startsWith(`${filters.toNamespace}/`)) set.add(k);
    }
    return Array.from(set).sort();
  }, [toPodsData, seenPods, filters.toNamespace]);

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (filters.fromNamespace) parts.push(`from-namespace=${filters.fromNamespace}`);
    if (filters.fromPod)       parts.push(`from-pod=${filters.fromPod}`);
    if (filters.toNamespace)   parts.push(`to-namespace=${filters.toNamespace}`);
    if (filters.toPod)         parts.push(`to-pod=${filters.toPod}`);
    if (filters.protocol)      parts.push(`protocol=${filters.protocol}`);
    if (filters.verdict)       parts.push(`verdict=${filters.verdict}`);
    return parts.length > 0 ? parts.join(' ') : '필터 없음(전체 흐름)';
  }, [filters]);

  const start = () => {
    const params = new URLSearchParams();
    if (filters.fromPod)       params.set('from_pod', filters.fromPod);
    if (filters.toPod)         params.set('to_pod', filters.toPod);
    if (filters.fromNamespace) params.set('from_namespace', filters.fromNamespace);
    if (filters.toNamespace)   params.set('to_namespace', filters.toNamespace);
    if (filters.protocol)      params.set('protocol', filters.protocol);
    if (filters.verdict)       params.set('verdict', filters.verdict);

    const life = slog.begin('Hubble 흐름 스트림', `hubble-relay 에 흐름 관찰(follow) 스트림 시작 요청 — ${filterSummary}`);
    stream.start(`/api/v1/cilium/${clusterId}/hubble/stream?${params.toString()}`, (line) => {
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(line); } catch { /* raw */ }
      return { ts: Date.now(), raw: line, parsed };
    }, life);
  };

  const verdictCounts = useMemo(() => {
    const c = { FORWARDED: 0, DROPPED: 0, AUDIT: 0, OTHER: 0 };
    for (const e of events) {
      if (e.note) continue;
      const v = (e.parsed as Record<string, unknown> | undefined)?.flow as Record<string, unknown> | undefined;
      const verdict = String((v ?? e.parsed ?? {})?.verdict ?? '');
      if (verdict in c) c[verdict as keyof typeof c]++;
      else if (verdict) c.OTHER++;
    }
    return c;
  }, [events]);
  const flowCount = events.filter((e) => !e.note).length;

  // 분기 순서: 상태 로딩 → 상태 조회 실패(ErrorState) → 조회 성공 + 미설치일 때만 설치 안내(D-173).
  if (statusLoading) {
    return <LoadingState label="Hubble Relay 상태 확인 중…" />;
  }
  if (statusError) {
    return (
      <ErrorState
        error={statusError}
        title="Hubble Relay 상태를 확인하지 못했습니다"
        onRetry={onRetryStatus}
      />
    );
  }
  if (hubbleInstalled === false) {
    return (
      <EmptyState
        icon={Info}
        title="Hubble Relay 가 설치되어 있지 않습니다."
        description="상태 조회 결과 hubble-relay 서비스가 없습니다. 아래 명령 또는 helm 으로 hubble-relay 를 배포하면 흐름을 볼 수 있습니다."
      >
        <code className="mt-3 px-1.5 py-0.5 rounded-md bg-secondary text-sm">cilium hubble enable --ui</code>
      </EmptyState>
    );
  }

  const filterInputs: { key: keyof typeof filters; placeholder: string; label: string; list: string }[] = [
    { key: 'fromNamespace', placeholder: 'from-namespace', label: '출발 네임스페이스', list: `${fid}-ns` },
    { key: 'fromPod', placeholder: 'ns/이름', label: '출발 파드', list: `${fid}-from-pod` },
    { key: 'toNamespace', placeholder: 'to-namespace', label: '목적 네임스페이스', list: `${fid}-ns` },
    { key: 'toPod', placeholder: 'ns/이름', label: '목적 파드', list: `${fid}-to-pod` },
    { key: 'protocol', placeholder: 'tcp/udp/http/dns', label: '프로토콜', list: `${fid}-protocol` },
    { key: 'verdict', placeholder: 'FORWARDED/DROPPED', label: '판정 (verdict)', list: `${fid}-verdict` },
  ];

  return (
    <div className={CONSOLE_GRID}>
      <ControlCard
        titleExtra={<StreamIndicator running={running} paused={paused} ended={ended} count={flowCount} />}
        runBar={
          <StreamRunBar
            running={running}
            paused={paused}
            canClear={events.length > 0}
            startLabel="스트림 시작"
            onStart={start}
            onStop={() => slog.stopped(stream.stop())}
            onTogglePause={() => { slog.note('info', paused ? '화면 반영 재개' : '화면 반영 일시정지 — 수신은 계속됩니다'); stream.togglePause(); }}
            onClear={stream.clear}
            error={stream.err}
          />
        }
      >
        <div className="px-4 py-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {filterInputs.map((fi) => (
              <div key={fi.key} className="min-w-0">
                <label htmlFor={`${fid}-${fi.key}`} className={LABEL}>{fi.label}</label>
                <input
                  id={`${fid}-${fi.key}`}
                  value={filters[fi.key]}
                  onChange={(e) => setFilters((s) => ({ ...s, [fi.key]: e.target.value }))}
                  disabled={running}
                  placeholder={fi.placeholder}
                  list={fi.list}
                  className={`${INPUT} px-2.5`}
                />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">빈 칸은 조건에서 빠집니다. 실행 중에는 바꿀 수 없습니다 — 중지 후 고쳐 다시 시작하세요.</p>

          {/* 자동완성 데이터 — namespace / pod 는 API + 관측, protocol / verdict 는 정적 enum */}
          <datalist id={`${fid}-ns`}>
            {namespaceOptions.map((n) => <option key={n} value={n} aria-label={n} />)}
          </datalist>
          <datalist id={`${fid}-from-pod`}>
            {fromPodOptions.map((p) => <option key={p} value={p} aria-label={p} />)}
          </datalist>
          <datalist id={`${fid}-to-pod`}>
            {toPodOptions.map((p) => <option key={p} value={p} aria-label={p} />)}
          </datalist>
          <datalist id={`${fid}-protocol`}>
            {HUBBLE_PROTOCOLS.map((p) => <option key={p} value={p} aria-label={p} />)}
          </datalist>
          <datalist id={`${fid}-verdict`}>
            {HUBBLE_VERDICTS.map((v) => <option key={v} value={v} aria-label={v} />)}
          </datalist>
        </div>
      </ControlCard>

      <RightColumn
        runLog={runLog}
        showLog={showLog}
        setShowLog={setShowLog}
        idleHint="스트림을 시작하면 접속·첫 흐름·종료가 여기에 실시간으로 쌓입니다."
      >
        <MacCard
          title="Hubble 흐름"
          titleExtra={
            <span className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
              <span className="inline-flex items-center gap-1" title="FORWARDED">
                <CheckCircle2 className="w-3 h-3" aria-hidden /> <span className="sr-only">FORWARDED</span>{verdictCounts.FORWARDED}
              </span>
              <span className={`inline-flex items-center gap-1 ${verdictCounts.DROPPED > 0 ? 'text-status-critical' : ''}`} title="DROPPED">
                <X className="w-3 h-3" aria-hidden /> <span className="sr-only">DROPPED</span>{verdictCounts.DROPPED}
              </span>
            </span>
          }
          rootClassName="min-w-0 flex flex-col flex-1 min-h-0"
          bodyPadding="p-0"
          className="flex flex-col flex-1 min-h-0"
        >
          <FlowList events={events} />
        </MacCard>
      </RightColumn>
    </div>
  );
}

function FlowList({ events }: { events: HubbleFlowEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length]);
  if (events.length === 0) {
    return (
      <EmptyState compact title="흐름이 아직 없습니다." description="스트림 시작을 눌러 Hubble 흐름 관찰(follow)을 시작하세요." />
    );
  }
  // 스크롤은 결과 카드 안 이 목록 한 겹 — 바깥에 max-h 를 또 걸지 않는다(§12.6.1).
  return (
    <div ref={ref} className="flex-1 min-h-0 overflow-auto divide-y divide-border/40">
      {events.map((e, i) => {
        if (e.note) {
          return (
            <div key={i} className="px-3 py-1.5 text-xs text-muted-foreground flex items-center gap-2">
              <span className="font-mono tabular-nums">{new Date(e.ts).toLocaleTimeString()}</span>
              <Info className="w-3 h-3" aria-hidden />
              <span>{e.note}</span>
            </div>
          );
        }
        const flow = ((e.parsed?.flow as Record<string, unknown>) ?? e.parsed ?? {}) as Record<string, unknown>;
        const verdict = String(flow.verdict ?? '');
        const verdictClr =
          verdict === 'DROPPED' ? 'text-status-critical'
          : verdict === 'AUDIT' ? 'text-status-warning' : 'text-muted-foreground';
        const summary = String(flow.Summary ?? flow.summary ?? '');
        const src = flow.source as Record<string, unknown> | undefined;
        const dst = flow.destination as Record<string, unknown> | undefined;
        const srcLabel = `${(src?.namespace as string) ?? '?'}/${(src?.pod_name as string) ?? '?'}`;
        const dstLabel = `${(dst?.namespace as string) ?? '?'}/${(dst?.pod_name as string) ?? '?'}`;
        const dropReason = flow.drop_reason_desc ?? flow.drop_reason;
        return (
          <div key={i} className="px-3 py-1.5 hover:bg-secondary/30 text-xs font-mono">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-muted-foreground tabular-nums">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={`font-bold ${verdictClr}`}>{verdict || '?'}</span>
              {dropReason ? (
                <span className="text-status-critical">[{String(dropReason)}]</span>
              ) : null}
              <span className="text-foreground">{srcLabel}</span>
              <span className="text-muted-foreground" aria-hidden>→</span>
              <span className="text-foreground">{dstLabel}</span>
            </div>
            {summary && <div className="text-muted-foreground truncate pl-1">{summary}</div>}
          </div>
        );
      })}
    </div>
  );
}
