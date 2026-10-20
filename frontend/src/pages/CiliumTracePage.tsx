import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { createPortal } from 'react-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  Filter,
  Info,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Waves,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useClusters } from '@/hooks/useCluster';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { useClusterStore } from '@/stores/clusterStore';
import { ClusterSidebar, ConfirmDialog, LogViewer, SearchableSelect, EmptyState, ErrorState, SelectClusterEmptyState, LoadingState, Skeleton, PageShell, RunLogPanel } from '@/components/common';
import { useRunLog, runLogged, consoleRunLines } from '@/hooks/useRunLog';
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
  bpfInspect: (clusterId: string, body: { kind: BpfKind; podName?: string; namespace?: string; endpointId?: string }) =>
    api.post<BpfInspectResponse>(`/cilium/${clusterId}/bpf-inspect`, {
      cluster_id: clusterId,
      kind: body.kind,
      pod_name: body.podName,
      namespace: body.namespace ?? 'kube-system',
      endpoint_id: body.endpointId,
    }).then((r) => r.data),
  // BPF 맵 원본 파일 — 서버가 흘려보낸다(조회 응답에는 JSON 원본이 실리지 않음).
  bpfDownload: (clusterId: string, body: { kind: BpfKind; podName?: string; endpointId?: string; format: 'json' | 'text' }) =>
    api.post<Blob>(`/cilium/${clusterId}/bpf-inspect/download`, {
      cluster_id: clusterId,
      kind: body.kind,
      pod_name: body.podName,
      namespace: 'kube-system',
      endpoint_id: body.endpointId,
      format: body.format,
    }, { responseType: 'blob', timeout: 5 * 60_000 }).then((r) => r.data),
  // 직접 명령 읽기 전용 허용 목록(서버 원천) — 목록 밖은 admin 만 실행(정책 2).
  execAllowlist: (clusterId: string) =>
    api.get<{ clusterId: string; commands: string[]; adminOnlyOutside: boolean }>(`/cilium/${clusterId}/exec-command/allowlist`).then((r) => r.data),
  execCommand: (clusterId: string, body: { podName?: string; namespace?: string; commandArgs: string; timeout?: number }) =>
    api.post<CiliumExecResponse>(`/cilium/${clusterId}/exec-command`, {
      pod_name: body.podName,
      namespace: body.namespace ?? 'kube-system',
      command_args: body.commandArgs,
      timeout: body.timeout ?? 30,
    }).then((r) => r.data),
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

type TabId = 'bpf' | 'monitor' | 'hubble';

const TABS: { id: TabId; label: string; icon: typeof Database }[] = [
  { id: 'bpf',     label: 'BPF 맵 조회',  icon: Database },
  { id: 'monitor', label: 'Cilium 모니터', icon: Activity },
  { id: 'hubble',  label: 'Hubble 흐름',  icon: Waves },
];

export function CiliumTracePage() {
  const clustersQ = useClusters();
  const { clusters } = useClusterStore();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedClusterId && clusters.length > 0) setSelectedClusterId(clusters[0].id);
  }, [clusters, selectedClusterId]);
  // 선택 클러스터 운영등급 → 터미널 Appearance(개발/운영) 자동 적용.
  useTerminalEnvSync(clusters, selectedClusterId);
  const [tab, setTab] = useState<TabId>('bpf');

  const cid = selectedClusterId ?? '';

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

  const tabRefs = useRef<Record<TabId, HTMLButtonElement | null>>({ bpf: null, monitor: null, hubble: null });
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].id;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="app-min-h-screen bg-background flex">
      <ClusterSidebar
        clusters={clusters}
        selectedId={selectedClusterId}
        onSelect={setSelectedClusterId}
        allowAll={false}
        iconOnly
      />
      <PageShell density="console" className="space-y-4">
        {/* Header */}
        <PageHeader
          icon={Waves}
          title="Cilium BPF 추적"
          description="BPF 맵 조회 · Cilium 모니터 · Hubble 흐름"
          actions={
            <button
              onClick={() => refetchStatus()}
              disabled={statusLoading || !cid}
              className="px-3 py-1.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
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
        <div role="tablist" aria-label="Cilium 추적 도구" className="flex items-center gap-0.5 bg-secondary rounded-xl p-0.5 w-fit">
          {TABS.map((t) => {
            const Icon = t.icon;
            const selected = tab === t.id;
            return (
              <button
                key={t.id}
                ref={(el) => { tabRefs.current[t.id] = el; }}
                type="button"
                role="tab"
                id={`cilium-tab-${t.id}`}
                aria-selected={selected}
                aria-controls="cilium-tabpanel"
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={onTabKey}
                className={`px-3.5 py-1.5 text-sm font-medium rounded-xl flex items-center gap-1.5 transition-colors ${
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
            스트림이 새 클러스터 경로로 이어지지 않게(스트림은 언마운트 정리에서 끊긴다). */}
        <div role="tabpanel" id="cilium-tabpanel" aria-labelledby={`cilium-tab-${tab}`}>
          {clustersQ.isError && clusters.length === 0 ? (
            <ErrorState
              error={clustersQ.error}
              title="클러스터 목록을 불러오지 못했습니다"
              onRetry={() => { void clustersQ.refetch(); }}
            />
          ) : !cid ? (
            <SelectClusterEmptyState />
          ) : tab === 'bpf' ? (
            <BpfInspectorTab key={cid} clusterId={cid} agentsState={agentsState} />
          ) : tab === 'monitor' ? (
            <MonitorTab key={cid} clusterId={cid} agentsState={agentsState} />
          ) : (
            <HubbleTab
              key={cid}
              clusterId={cid}
              statusLoading={statusLoading}
              statusError={statusQ.isError ? statusQ.error : status?.error ? new Error(status.error) : null}
              onRetryStatus={() => { void refetchStatus(); }}
              hubbleInstalled={status?.hubbleRelayError ? undefined : status?.hubbleRelayInstalled}
            />
          )}
        </div>
      </PageShell>
    </div>
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

// ── Tab 1: BPF Inspector ────────────────────────────────────────────────────

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

const inputCls = 'text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60';

function BpfInspectorTab({ clusterId, agentsState }: { clusterId: string; agentsState: AgentsState }) {
  const agents = agentsState.agents;
  const readyAgents = agents.filter((a) => a.ready);
  const [kind, setKind] = useState<BpfKind>('endpoint');
  const [podName, setPodName] = useState<string>('');
  const [endpointId, setEndpointId] = useState<string>('');
  const [data, setData] = useState<BpfInspectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 직접 명령은 operate 권한(서버 require_operator) — viewer 에게 카드는 보이고 입력·실행만 비활성(§12.9, D-172).
  // 읽기 전용 allowlist 밖 명령은 서버가 admin 만 허용한다(D-171 ④) — 화면도 같은 판정으로 안내·확인한다.
  const { canOperate, role, withHint, ariaWithHint } = useCanOperate(clusterId);
  const isAdmin = role === 'admin';

  // ad-hoc 직접 명령 + 프리셋
  const [adhoc, setAdhoc] = useState('');
  const [adhocOut, setAdhocOut] = useState<string | null>(null);
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

  // 실행 수명주기 로그(BPF 조회·직접 명령·프리셋 저장 공유) — 출력 본문은 결과 카드/LogViewer.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('cilium-bpf');
  const agentDesc = (name: string) => {
    const a = agents.find((x) => x.podName === name);
    return a ? agentLabel(a) : (name || '기본 에이전트');
  };

  const runAdhoc = useCallback(async () => {
    const v = classifyCiliumCommand(adhoc, rules);
    if (!clusterId || !v.args) return;
    setAdhocBusy(true); setAdhocErr(null); setAdhocOut(null);
    setAdhocRan({ cmd: v.args, pod: podName });
    const r = await runLogged(runLog, {
      title: 'cilium-dbg 직접 명령',
      first: `${agentDesc(podName)} 에서 cilium-dbg ${v.args} 실행 요청${v.readOnly ? ' (조회 명령)' : ` — ${v.reason ?? '목록 밖 명령'} · admin 확인 후 실행`}`,
      fn: () => ciliumApi.execCommand(clusterId, { commandArgs: v.args, podName: podName || undefined }),
      summarize: (res) => [
        ...consoleRunLines({ host: res.podName, exitCode: res.exitCode, durationMs: res.durationMs, error: res.error }),
        ['info', `출력 ${res.raw ? res.raw.split('\n').filter((l) => l.trim()).length : 0}줄 — 본문은 우측 결과 카드`],
      ],
    });
    if (r.ok) {
      setAdhocOut(r.data.raw || '(출력 없음)');
      if (r.data.error) setAdhocErr(r.data.error);
    } else if (!r.aborted) {
      setAdhocErr(formatApiError(r.error));
    }
    setAdhocBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runLog 함수들은 안정적, agentDesc 는 agents 로 결정
  }, [clusterId, adhoc, podName, agents, rules]);

  // 실행 버튼·Enter 공통 진입 — 조회 명령은 바로, 목록 밖 명령은 danger 확인창(Enter 는 확인창 열기).
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
    await runLogged(runLog, {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runLog 함수들은 안정적
  }, [adhoc, createCmd]);

  useEffect(() => {
    if (!podName && readyAgents.length > 0) setPodName(readyAgents[0].podName);
  }, [readyAgents, podName]);

  const run = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true); setError(null);
    const spec = BPF_KINDS.find((k) => k.id === kind);
    const what = kind === 'policy' ? `bpf policy get ${endpointId}` : (spec?.desc ?? kind);
    const r = await runLogged(runLog, {
      title: `BPF 맵 조회 · ${spec?.label ?? kind}`,
      first: `${agentDesc(podName)} 에서 ${what} 실행 요청`,
      fn: () => ciliumApi.bpfInspect(clusterId, {
        kind,
        podName: podName || undefined,
        endpointId: kind === 'policy' ? (endpointId || undefined) : undefined,
      }),
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
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runLog 함수들은 안정적, agentDesc 는 agents 로 결정
  }, [clusterId, kind, podName, endpointId, agents]);

  const saveBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadRaw = useCallback(async () => {
    if (!data || !clusterId) return;
    // 텍스트 결과는 이미 받은 원본을 그대로 저장한다.
    if (!data.rawOmitted) {
      if (data.raw) saveBlob(new Blob([data.raw], { type: 'text/plain' }), `cilium-bpf-${data.kind}-${Date.now()}.txt`);
      return;
    }
    // JSON 결과는 서버가 원본을 흘려보내 준다(조회 응답에는 원본을 싣지 않아 워커 메모리를 아낀다).
    const kb = Math.round((data.rawSize ?? 0) / 1024);
    const r = await runLogged(runLog, {
      title: `BPF 원본 내보내기 · ${data.kind}`,
      first: `${agentDesc(data.podName)} 에서 원본 JSON(약 ${kb.toLocaleString()}KB) 다운로드 요청 — 서버가 흘려보냄`,
      fn: () => ciliumApi.bpfDownload(clusterId, {
        kind: data.kind as BpfKind,
        podName: data.podName || undefined,
        endpointId: data.kind === 'policy' ? (endpointId || undefined) : undefined,
        format: 'json',
      }),
      summarize: (blob) => [['info', `받은 크기 ${Math.round(blob.size / 1024).toLocaleString()}KB — 파일로 저장`]],
    });
    if (r.ok) saveBlob(r.data, `cilium-bpf-${data.kind}-${Date.now()}.json`);
    else if (!r.aborted) setError(formatApiError(r.error));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runLog 함수들은 안정적, agentDesc 는 agents 로 결정
  }, [data, clusterId, endpointId, agents]);

  const runTitle = adhocBlockedReason ?? (verdict.readOnly ? '조회 명령 실행' : '실행 전 확인창이 열립니다');
  const runAria = !canOperate
    ? ariaWithHint('직접 명령 실행')
    : adhocBlockedReason ? `직접 명령 실행 — ${adhocBlockedReason}` : '직접 명령 실행';

  return (
    // MC 클라이언트와 동일한 좌(컨트롤)/우(결과) 배치 — 결과 카드는 실행 전에도 같은
    // 자리(우측)에 플레이스홀더로 고정되어 결과가 나와도 레이아웃이 흔들리지 않는다.
    <div className="grid grid-cols-1 lg:grid-cols-10 gap-4 items-start">
      <div className="lg:col-span-4 min-w-0 space-y-4">
      {/* 조회 컨트롤 — 콘솔 좌측 컨트롤 카드(제목 + 폼) */}
      <MacCard
        title="BPF 맵 조회"
        description={BPF_KINDS.find((k) => k.id === kind)?.desc}
        bodyPadding="p-3"
      >
        <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as BpfKind)}
              aria-label="조회할 BPF 맵"
              className={inputCls}
            >
              {BPF_KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
            <SearchableSelect
              value={podName}
              onChange={setPodName}
              options={agents}
              getKey={(a) => a.podName}
              getLabel={agentLabel}
              placeholder="에이전트 파드 검색 (호스트 번호 등)"
              emptyText={agentsState.error ? '목록을 불러오지 못했습니다' : '에이전트 파드가 없습니다'}
              clearable={false}
              menuPortal
              className="w-[280px]"
            />
          </div>
          {kind === 'policy' && (
            <input
              value={endpointId}
              onChange={(e) => setEndpointId(e.target.value)}
              placeholder="endpoint ID"
              aria-label="정책을 조회할 endpoint ID"
              className={`${inputCls} w-32`}
            />
          )}
          <button
            onClick={run}
            disabled={loading || (kind === 'policy' && !endpointId)}
            className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50 shadow-card"
          >
            <Play className="w-3.5 h-3.5" />
            {loading ? '조회 중…' : '조회'}
          </button>
          {(data?.raw || data?.rawOmitted) && (
            <button
              onClick={downloadRaw}
              className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" /> 내보내기
            </button>
          )}
        </div>
        <AgentsError state={agentsState} />
        </div>
      </MacCard>

      {/* 직접 명령(ad-hoc) — 목록에 없는 cilium-dbg 명령 실행 + 프리셋 저장.
          viewer 에게도 렌더하고 입력·실행만 비활성(§12.9 "숨기지 않고 비활성", D-172). */}
      <MacCard title="직접 명령 (cilium-dbg)" bodyPadding="p-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {presets.length > 0 && (
              <select
                value=""
                onChange={(e) => { if (e.target.value) setAdhoc(e.target.value); }}
                disabled={!canOperate}
                aria-label="저장된 cilium-dbg 프리셋"
                title={withHint('저장된 프리셋을 입력란에 채웁니다')}
                className={`${inputCls} max-w-[280px]`}
              >
                <option value="">저장된 프리셋…</option>
                {presets.map((p) => (
                  <option key={p.id} value={(p.command || '').replace(/^cilium-dbg\s+/, '')}>
                    {p.description || p.command}
                  </option>
                ))}
              </select>
            )}
            <span className="text-sm font-mono text-muted-foreground" aria-hidden>cilium-dbg</span>
            <input
              value={adhoc}
              onChange={(e) => setAdhoc(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                requestRun();
              }}
              disabled={!canOperate}
              placeholder="예: status --verbose  ·  bpf endpoint list  ·  endpoint list -o json"
              aria-label={ariaWithHint('cilium-dbg 하위 명령')}
              aria-describedby="cilium-adhoc-help"
              title={withHint('cilium-dbg 뒤에 붙일 하위 명령')}
              className={`flex-1 min-w-[220px] font-mono ${inputCls}`}
            />
            <button
              onClick={requestRun}
              disabled={adhocBusy || !!adhocBlockedReason}
              title={runTitle}
              aria-label={runAria}
              className={`px-3.5 py-1.5 text-sm font-semibold rounded-xl flex items-center gap-1.5 disabled:opacity-50 shadow-card ${
                verdict.args && !verdict.readOnly
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : 'bg-primary hover:bg-primary/90 text-primary-foreground'
              }`}
            >
              <Play className="w-3.5 h-3.5" aria-hidden />{adhocBusy ? '실행 중…' : '실행'}
            </button>
            <button
              onClick={savePreset}
              disabled={!adhoc.trim() || !canOperate}
              className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl flex items-center gap-1.5 disabled:opacity-50"
              title={withHint('현재 명령을 프리셋으로 저장(주요 명령어 · category=cilium)')}
              aria-label={ariaWithHint('프리셋 저장')}
            >
              <Save className="w-3.5 h-3.5" aria-hidden /> 프리셋 저장
            </button>
          </div>
          {verdict.args && !verdict.readOnly && (
            <p className="text-xs text-status-warning flex items-start gap-1.5" role="status">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-px" aria-hidden />
              <span>
                {verdict.reason ?? '읽기 전용 목록 밖 명령'} — {isAdmin
                  ? '실행 전 확인창을 거칩니다.'
                  : 'admin 만 실행할 수 있습니다. 조회 명령으로 바꾸거나 admin 에게 요청하세요.'}
              </span>
            </p>
          )}
          <p id="cilium-adhoc-help" className="text-xs text-muted-foreground">
            선택한 에이전트 파드에서 <code>cilium-dbg &lt;입력&gt;</code> 을 실행합니다(operator 이상). 읽기 전용 허용 목록의 조회 명령은 바로 실행되고,
            그 밖의 명령은 admin 만 확인창을 거쳐 실행할 수 있습니다. 임의 바이너리는 실행할 수 없고, 실행은 감사 로그에 기록됩니다.
          </p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none hover:text-foreground">읽기 전용 허용 목록 ({allowLabels.length}개)</summary>
            <p className="mt-1 font-mono leading-relaxed break-words">{allowLabels.join(' · ')}</p>
          </details>
        </div>
      </MacCard>
      </div>

      {/* Result — 우측 고정 (실행 전엔 플레이스홀더), 위에 실행 수명주기 로그 */}
      <div className="lg:col-span-6 min-w-0 flex flex-col gap-3">
      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
      <MacCard
        title={data ? `결과 · ${data.kind} · ${data.podName}` : '결과'}
        rootClassName="min-w-0"
        bodyPadding="p-0"
        className="overflow-hidden"
      >
        {/* 직접 명령 결과 — 좌측 컨트롤 아래가 아니라 우측 결과 카드 안 섹션(§12.6, D-175 ②) */}
        {adhocRan && (adhocBusy || adhocOut != null || adhocErr) && (
          <section aria-label="직접 명령 결과" className="border-b border-border">
            <div className="px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">직접 명령</span>
              <code className="font-mono truncate" title={`cilium-dbg ${adhocRan.cmd}`}>cilium-dbg {adhocRan.cmd}</code>
              {adhocRan.pod && <span className="truncate">· {adhocRan.pod}</span>}
              <button
                type="button"
                onClick={() => { setAdhocRan(null); setAdhocOut(null); setAdhocErr(null); }}
                disabled={adhocBusy}
                aria-label="직접 명령 결과 닫기"
                title="직접 명령 결과 닫기"
                className="ml-auto p-1 rounded-xl hover:bg-secondary disabled:opacity-50"
              >
                <X className="w-3.5 h-3.5" aria-hidden />
              </button>
            </div>
            {adhocErr && (
              <div className="px-4 py-2 bg-status-critical/10 text-sm text-status-critical flex items-start gap-2" role="alert">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden />
                <span className="break-all">{adhocErr}</span>
              </div>
            )}
            {adhocBusy && <LoadingState compact label="cilium-dbg 실행 중…" />}
            {adhocOut != null && (
              <div className="p-3">
                <LogViewer text={adhocOut} maxHeight="max-h-[40vh]" />
              </div>
            )}
          </section>
        )}
        {error && (
          <div className="px-4 py-3 border-b border-border bg-status-critical/10 text-sm text-status-critical flex items-center gap-2" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />
            <span className="break-all">{error}</span>
          </div>
        )}
        {!data && !loading && !adhocRan && (
          <EmptyState
            icon={Database}
            title="조회한 BPF 맵이 없습니다."
            description="대상 BPF 맵을 선택하고 '조회'를 누르면 cilium-dbg 결과가 여기에 표시됩니다."
          />
        )}
        {loading && (
          <LoadingState label="cilium-dbg 실행 중…" />
        )}
        {data && data.isJson && Array.isArray(data.parsed) && (
          <BpfJsonTable rows={data.parsed} />
        )}
        {data && (!data.isJson || !Array.isArray(data.parsed)) && (data.raw || data.parsed) && (
          <div className="p-3">
            {/* 객체 형태 JSON 은 서버가 원본을 빼고 보내므로 파싱본을 펼쳐 보여 준다. */}
            <LogViewer
              text={data.raw || JSON.stringify(data.parsed, null, 2)}
              maxHeight="max-h-[60vh] lg:max-h-[calc(100vh-340px)]"
            />
          </div>
        )}
      </MacCard>
      </div>

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
  return (
    <div className="overflow-auto max-h-[60vh] lg:max-h-[calc(100vh-300px)]">
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
    </div>
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

  const start = (url: string, toEvent: (line: string) => T) => {
    handleRef.current?.abort();
    clearTimer();
    const my = ++gen.current;
    buffer.current = [];
    setEvents([]);
    setErr(null);
    setEnded(false);
    setRunning(true);
    setPaused(false);
    handleRef.current = startSseStream(
      url,
      (line) => {
        if (my !== gen.current) return;
        buffer.current.push(toEvent(line));
        if (buffer.current.length > cap) buffer.current.splice(0, buffer.current.length - cap);
      },
      (e) => {
        if (my !== gen.current) return;
        flush(true);
        finish();
        setErr(e);
      },
      () => {
        if (my !== gen.current) return;
        buffer.current.push(makeNote(STREAM_ENDED_NOTE));
        flush(true);
        finish();
        setEnded(true);
      },
    );
    timer.current = window.setInterval(() => flush(false), 80);
  };

  const stop = () => {
    gen.current += 1;
    handleRef.current?.abort();
    flush(true);
    finish();
  };

  const clear = () => { setEvents([]); buffer.current = []; };
  const togglePause = () => setPaused(!pausedRef.current);

  return { events, running, paused, ended, err, start, stop, clear, togglePause };
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

function StreamError({ err }: { err: string | null }) {
  if (!err) return null;
  return (
    <p role="alert" className="text-sm text-status-critical flex items-start gap-2 break-all">
      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden /> {err}
    </p>
  );
}

function MonitorTab({ clusterId, agentsState }: { clusterId: string; agentsState: AgentsState }) {
  const agents = agentsState.agents;
  const readyAgents = agents.filter((a) => a.ready);
  const [podName, setPodName] = useState<string>('');
  const [types, setTypes] = useState<Set<MonitorType>>(new Set(['drop', 'trace']));
  const [relatedTo, setRelatedTo] = useState<string>('');
  const [startErr, setStartErr] = useState<string | null>(null);
  const [filterText, setFilterText] = useState('');
  const stream = useBufferedSseStream<MonitorEvent>(1000, (text) => ({ ts: Date.now(), raw: text, kind: 'meta' }));
  const { events, running, paused, ended } = stream;

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
    stream.start(`/api/v1/cilium/${clusterId}/monitor/stream?${params.toString()}`, (line) => {
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(line); } catch { /* keep raw */ }
      const kind = (parsed && typeof parsed.kind === 'string') ? (parsed.kind as string) : undefined;
      return { ts: Date.now(), raw: line, kind, parsed };
    });
  };

  const filtered = useMemo(() => {
    if (!filterText.trim()) return events;
    const q = filterText.toLowerCase();
    return events.filter((e) => e.raw.toLowerCase().includes(q));
  }, [events, filterText]);

  return (
    // 좌(컨트롤)/우(로그) 고정 배치 — 스트림 로그 카드가 컨트롤 아래가 아닌 우측 같은
    // 라인에 나와 세로 공간을 온전히 쓴다 (MC 클라이언트 콘솔과 동일 패턴).
    <div className="grid grid-cols-1 lg:grid-cols-10 gap-4 items-start">
      <div className="lg:col-span-4 min-w-0 space-y-4">
      <MacCard
        title="모니터 스트림"
        titleExtra={<StreamIndicator running={running} paused={paused} ended={ended} count={events.length} />}
        bodyPadding="p-3"
      >
        <div className="space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
            <SearchableSelect
              value={podName}
              onChange={setPodName}
              options={agents}
              getKey={(a) => a.podName}
              getLabel={agentLabel}
              placeholder="에이전트 파드 검색 (호스트 번호 등)"
              emptyText={agentsState.error ? '목록을 불러오지 못했습니다' : '에이전트 파드가 없습니다'}
              clearable={false}
              disabled={running}
              menuPortal
              className="w-[280px]"
            />
          </div>
          <TypeFilter types={types} setTypes={setTypes} disabled={running} />
          <input
            value={relatedTo}
            onChange={(e) => setRelatedTo(e.target.value)}
            disabled={running}
            placeholder="related-to (endpoint ID)"
            aria-label="related-to — 이 endpoint ID 와 관련된 이벤트만"
            className={`${inputCls} w-44`}
          />
          {!running ? (
            <button
              onClick={start}
              className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1.5 shadow-card"
            >
              <Play className="w-3.5 h-3.5" aria-hidden /> 시작
            </button>
          ) : (
            <button
              onClick={stream.stop}
              className="px-3.5 py-1.5 text-sm font-semibold bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-xl transition-colors flex items-center gap-1.5"
            >
              <X className="w-3.5 h-3.5" aria-hidden /> 중단
            </button>
          )}
          <button
            onClick={stream.togglePause}
            disabled={!running}
            aria-pressed={paused}
            className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            {paused ? <Play className="w-3.5 h-3.5" aria-hidden /> : <Pause className="w-3.5 h-3.5" aria-hidden />}
            {paused ? '재개' : '일시정지'}
          </button>
          <button
            onClick={stream.clear}
            disabled={events.length === 0}
            className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden /> 비우기
          </button>
        </div>
        <AgentsError state={agentsState} />
        <StreamError err={startErr ?? stream.err} />
        </div>
      </MacCard>
      </div>

      <MacCard
        title="실시간 이벤트"
        rootClassName="lg:col-span-6 min-w-0"
        bodyPadding="p-0"
        className="overflow-hidden"
        actions={
          <div className="flex items-center gap-2">
            <Filter className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
            <input
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="텍스트로 필터링…"
              aria-label="이벤트 텍스트 필터"
              className="w-56 text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        }
      >
        <EventList events={filtered} />
      </MacCard>
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
        className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60 flex items-center gap-1.5 max-w-[260px]"
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
      <EmptyState title="이벤트가 없습니다." description="시작 버튼을 누르거나 잠시 기다려 주세요." />
    );
  }
  return (
    <div ref={ref} className="overflow-auto max-h-[60vh] lg:max-h-[calc(100vh-360px)] font-mono text-xs leading-snug bg-background">
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

function HubbleTab({ clusterId, statusLoading, statusError, onRetryStatus, hubbleInstalled }: HubbleTabProps) {
  const [filters, setFilters] = useState({
    fromPod: '',
    toPod: '',
    fromNamespace: '',
    toNamespace: '',
    protocol: '',
    verdict: '',
  });
  const stream = useBufferedSseStream<HubbleFlowEvent>(1500, (text) => ({ ts: Date.now(), raw: text, note: text }));
  const { events, running, paused, ended } = stream;

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

  const start = () => {
    const params = new URLSearchParams();
    if (filters.fromPod)       params.set('from_pod', filters.fromPod);
    if (filters.toPod)         params.set('to_pod', filters.toPod);
    if (filters.fromNamespace) params.set('from_namespace', filters.fromNamespace);
    if (filters.toNamespace)   params.set('to_namespace', filters.toNamespace);
    if (filters.protocol)      params.set('protocol', filters.protocol);
    if (filters.verdict)       params.set('verdict', filters.verdict);

    stream.start(`/api/v1/cilium/${clusterId}/hubble/stream?${params.toString()}`, (line) => {
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(line); } catch { /* raw */ }
      return { ts: Date.now(), raw: line, parsed };
    });
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
    { key: 'fromNamespace', placeholder: 'from-namespace', label: '출발 네임스페이스', list: 'hubble-ns-list' },
    { key: 'fromPod', placeholder: 'from-pod (ns/name)', label: '출발 파드 (ns/이름)', list: 'hubble-from-pod-list' },
    { key: 'protocol', placeholder: 'protocol (tcp/udp/http/dns)', label: '프로토콜', list: 'hubble-protocol-list' },
    { key: 'toNamespace', placeholder: 'to-namespace', label: '목적 네임스페이스', list: 'hubble-ns-list' },
    { key: 'toPod', placeholder: 'to-pod (ns/name)', label: '목적 파드 (ns/이름)', list: 'hubble-to-pod-list' },
    { key: 'verdict', placeholder: 'verdict (FORWARDED/DROPPED)', label: '판정 (verdict)', list: 'hubble-verdict-list' },
  ];

  return (
    // 좌(필터/컨트롤)/우(flow 로그) 고정 배치 — MC 클라이언트 콘솔과 동일 패턴.
    <div className="grid grid-cols-1 lg:grid-cols-10 gap-4 items-start">
      <div className="lg:col-span-4 min-w-0 space-y-4">
      <MacCard
        title="Hubble 필터"
        titleExtra={<StreamIndicator running={running} paused={paused} ended={ended} count={flowCount} />}
        bodyPadding="p-3"
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-2 gap-2 mb-2">
          {filterInputs.map((fi) => (
            <input
              key={fi.key}
              value={filters[fi.key]}
              onChange={(e) => setFilters((s) => ({ ...s, [fi.key]: e.target.value }))}
              disabled={running}
              placeholder={fi.placeholder}
              aria-label={fi.label}
              list={fi.list}
              className={inputCls}
            />
          ))}
        </div>

        {/* 자동완성 데이터 — namespace / pod 는 API + 관측, protocol / verdict 는 정적 enum */}
        <datalist id="hubble-ns-list">
          {namespaceOptions.map((n) => <option key={n} value={n} aria-label={n} />)}
        </datalist>
        <datalist id="hubble-from-pod-list">
          {fromPodOptions.map((p) => <option key={p} value={p} aria-label={p} />)}
        </datalist>
        <datalist id="hubble-to-pod-list">
          {toPodOptions.map((p) => <option key={p} value={p} aria-label={p} />)}
        </datalist>
        <datalist id="hubble-protocol-list">
          {HUBBLE_PROTOCOLS.map((p) => <option key={p} value={p} aria-label={p} />)}
        </datalist>
        <datalist id="hubble-verdict-list">
          {HUBBLE_VERDICTS.map((v) => <option key={v} value={v} aria-label={v} />)}
        </datalist>
        <div className="flex items-center gap-2 flex-wrap pt-1">
          {!running ? (
            <button
              onClick={start}
              className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1.5 shadow-card"
            >
              <Play className="w-3.5 h-3.5" aria-hidden /> 스트림 시작
            </button>
          ) : (
            <button
              onClick={stream.stop}
              className="px-3.5 py-1.5 text-sm font-semibold bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-xl transition-colors flex items-center gap-1.5"
            >
              <X className="w-3.5 h-3.5" aria-hidden /> 중단
            </button>
          )}
          <button
            onClick={stream.togglePause}
            disabled={!running}
            aria-pressed={paused}
            className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            {paused ? <Play className="w-3.5 h-3.5" aria-hidden /> : <Pause className="w-3.5 h-3.5" aria-hidden />}
            {paused ? '재개' : '일시정지'}
          </button>
          <button
            onClick={stream.clear}
            disabled={events.length === 0}
            className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden /> 비우기
          </button>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 text-muted-foreground" title="FORWARDED">
              <CheckCircle2 className="w-3 h-3" aria-hidden /> <span className="sr-only">FORWARDED</span>{verdictCounts.FORWARDED}
            </span>
            <span className={`inline-flex items-center gap-1 ${verdictCounts.DROPPED > 0 ? 'text-status-critical' : 'text-muted-foreground'}`} title="DROPPED">
              <X className="w-3 h-3" aria-hidden /> <span className="sr-only">DROPPED</span>{verdictCounts.DROPPED}
            </span>
          </div>
        </div>
        <div className="mt-2">
          <StreamError err={stream.err} />
        </div>
      </MacCard>
      </div>

      <MacCard title="Hubble 흐름" rootClassName="lg:col-span-6 min-w-0" bodyPadding="p-0" className="overflow-hidden">
        <FlowList events={events} />
      </MacCard>
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
      <EmptyState title="흐름이 아직 없습니다." description="스트림 시작을 눌러 hubble observe --follow 를 시작하세요." />
    );
  }
  return (
    <div ref={ref} className="overflow-auto max-h-[60vh] lg:max-h-[calc(100vh-360px)] divide-y divide-border/40">
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
