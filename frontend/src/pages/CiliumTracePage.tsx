import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronDown,
  Database,
  Download,
  Filter,
  Pause,
  Play,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Waves,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { ClusterSidebar, SearchableSelect } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { RoleGate } from '@/components/auth/RoleGate';
import { getAuthToken } from '@/stores/authStore';
import api from '@/services/api';
import { useCommands, useCreateCommand } from '@/hooks/useCommands';
import { useAnalyzeNamespaces, useAnalyzePods } from '@/hooks/useIncidentAnalysis';

// ── Types (kept inline; this is the only consumer) ──────────────────────────
interface CiliumStatus {
  clusterId: string;
  ciliumInstalled: boolean;
  hubbleRelayInstalled: boolean;
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
  return `${a.podName}${a.nodeName ? ` · ${a.nodeName}` : ''}${a.ready ? '' : ' (NotReady)'}`;
}
type BpfKind =
  | 'endpoint' | 'lb' | 'nat' | 'ct' | 'tunnel'
  | 'policy' | 'fs' | 'metrics' | 'ipcache' | 'node';

interface BpfInspectResponse {
  clusterId: string;
  kind: string;
  podName: string;
  raw: string;
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

function startSseStream(
  url: string,
  onLine: (line: string) => void,
  onError: (err: string) => void,
): SseStreamHandle {
  const ac = new AbortController();
  const token = getAuthToken();
  fetch(url, {
    signal: ac.signal,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
    .then(async (resp) => {
      if (!resp.ok) {
        onError(`서버 오류 ${resp.status}`);
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
    })
    .catch((e) => {
      if (ac.signal.aborted) return;
      onError(e instanceof Error ? e.message : String(e));
    });
  return { abort: () => ac.abort() };
}

// ── Page ────────────────────────────────────────────────────────────────────

type TabId = 'bpf' | 'monitor' | 'hubble';

export function CiliumTracePage() {
  useClusters();
  const { clusters } = useClusterStore();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedClusterId && clusters.length > 0) setSelectedClusterId(clusters[0].id);
  }, [clusters, selectedClusterId]);
  const [tab, setTab] = useState<TabId>('bpf');

  const cid = selectedClusterId ?? '';

  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useQuery({
    queryKey: ['cilium', 'status', cid],
    queryFn: () => ciliumApi.status(cid),
    enabled: !!cid,
    staleTime: 30_000,
  });
  const { data: agentsResp } = useQuery({
    queryKey: ['cilium', 'agents', cid],
    queryFn: () => ciliumApi.agents(cid),
    enabled: !!cid,
    staleTime: 30_000,
  });

  const agents = agentsResp?.agents ?? [];

  return (
    <div className="min-h-screen bg-background flex">
      <ClusterSidebar
        clusters={clusters}
        selectedId={selectedClusterId}
        onSelect={setSelectedClusterId}
        allowAll={false}
        iconOnly
      />
      <main className="flex-1 min-w-0 px-4 lg:px-6 py-5 space-y-4 max-w-[1700px]">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Waves className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold leading-tight">Cilium BPF Trace</h1>
              <p className="text-sm text-muted-foreground">BPF 맵 인스펙터 · cilium monitor · Hubble flow</p>
            </div>
          </div>
          <button
            onClick={() => refetchStatus()}
            disabled={statusLoading || !cid}
            className="px-3 py-1.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
            상태 새로고침
          </button>
        </div>

        {/* Status strip */}
        <StatusStrip status={status} loading={statusLoading} agentCount={agents.length} />

        {/* Tabs */}
        <div className="flex items-center gap-0.5 bg-secondary rounded-xl p-0.5 w-fit">
          {([
            { id: 'bpf' as const,     label: 'BPF Inspector', icon: <Database className="w-3.5 h-3.5" /> },
            { id: 'monitor' as const, label: 'Cilium Monitor', icon: <Activity className="w-3.5 h-3.5" /> },
            { id: 'hubble' as const,  label: 'Hubble Flows',   icon: <Waves className="w-3.5 h-3.5" /> },
          ]).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3.5 py-1.5 text-sm font-medium rounded-lg flex items-center gap-1.5 transition-colors ${
                tab === t.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab body */}
        {!cid ? (
          <MacCard bodyPadding="p-10">
            <div className="text-center text-sm text-muted-foreground">왼쪽에서 클러스터를 선택하세요.</div>
          </MacCard>
        ) : tab === 'bpf' ? (
          <BpfInspectorTab clusterId={cid} agents={agents} />
        ) : tab === 'monitor' ? (
          <MonitorTab clusterId={cid} agents={agents} />
        ) : (
          <HubbleTab clusterId={cid} hubbleInstalled={status?.hubbleRelayInstalled ?? false} />
        )}
      </main>
    </div>
  );
}

// ── Status strip ────────────────────────────────────────────────────────────

interface StatusStripProps { status?: CiliumStatus; loading: boolean; agentCount: number }

function StatusStrip({ status, loading, agentCount }: StatusStripProps) {
  if (loading) {
    return <div className="h-20 rounded-2xl bg-secondary/40 animate-pulse" />;
  }
  if (!status) {
    return null;
  }
  if (status.error) {
    return (
      <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold">상태 점검 중 문제가 발생했습니다.</p>
          <p className="text-sm text-muted-foreground">{status.error}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <StatusCell
        icon={<Boxes className="w-4 h-4" />}
        label="Cilium"
        value={status.ciliumInstalled ? '설치됨' : '미설치'}
        accent={status.ciliumInstalled ? 'text-emerald-500' : 'text-muted-foreground'}
        hint={status.ciliumVersion ?? undefined}
      />
      <StatusCell
        icon={<Server className="w-4 h-4" />}
        label="Agent Pods"
        value={agentCount}
        accent="text-primary"
        hint={`${status.namespace}`}
      />
      <StatusCell
        icon={<Waves className="w-4 h-4" />}
        label="Hubble Relay"
        value={status.hubbleRelayInstalled ? '활성' : '없음'}
        accent={status.hubbleRelayInstalled ? 'text-emerald-500' : 'text-muted-foreground'}
        hint={status.hubbleRelayInstalled ? 'svc/hubble-relay' : 'install required'}
      />
      <StatusCell
        icon={<Activity className="w-4 h-4" />}
        label="Trace 가용성"
        value={
          status.ciliumInstalled
            ? (status.hubbleRelayInstalled ? 'BPF + Hubble' : 'BPF only')
            : '미가용'
        }
        accent={status.ciliumInstalled ? 'text-foreground' : 'text-muted-foreground'}
      />
    </div>
  );
}

interface StatusCellProps { icon: React.ReactNode; label: string; value: string | number; accent?: string; hint?: string }
function StatusCell({ icon, label, value, accent = 'text-foreground', hint }: StatusCellProps) {
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-xl bg-secondary flex items-center justify-center ${accent}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-base font-bold leading-tight ${accent}`}>{value}</p>
        {hint && <p className="text-xs text-muted-foreground truncate">{hint}</p>}
      </div>
    </div>
  );
}

// ── Tab 1: BPF Inspector ────────────────────────────────────────────────────

function BpfInspectorTab({ clusterId, agents }: { clusterId: string; agents: CiliumAgent[] }) {
  const readyAgents = agents.filter((a) => a.ready);
  const [kind, setKind] = useState<BpfKind>('endpoint');
  const [podName, setPodName] = useState<string>('');
  const [endpointId, setEndpointId] = useState<string>('');
  const [data, setData] = useState<BpfInspectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ad-hoc 직접 명령 + 프리셋
  const [adhoc, setAdhoc] = useState('');
  const [adhocOut, setAdhocOut] = useState<string | null>(null);
  const [adhocErr, setAdhocErr] = useState<string | null>(null);
  const [adhocBusy, setAdhocBusy] = useState(false);
  const { data: presetsResp } = useCommands({ category: 'cilium' });
  const createCmd = useCreateCommand();
  const presets = presetsResp?.data ?? [];

  const runAdhoc = useCallback(async () => {
    if (!clusterId || !adhoc.trim()) return;
    setAdhocBusy(true); setAdhocErr(null); setAdhocOut(null);
    try {
      const res = await ciliumApi.execCommand(clusterId, { commandArgs: adhoc.trim(), podName: podName || undefined });
      setAdhocOut(res.raw || '(출력 없음)');
      if (res.error) setAdhocErr(res.error);
    } catch (e) {
      setAdhocErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAdhocBusy(false);
    }
  }, [clusterId, adhoc, podName]);

  const savePreset = useCallback(async () => {
    const cmd = adhoc.trim();
    if (!cmd) return;
    const desc = window.prompt('프리셋 설명(라벨)을 입력하세요', cmd);
    if (desc == null) return;
    try {
      await createCmd.mutateAsync({
        category: 'cilium',
        command: cmd.startsWith('cilium-dbg') ? cmd : `cilium-dbg ${cmd}`,
        description: desc || cmd,
        importance: 'medium',
        tags: 'cilium,bpf',
      });
      window.alert('프리셋으로 저장했습니다.');
    } catch (e) {
      window.alert(`저장 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [adhoc, createCmd]);

  useEffect(() => {
    if (!podName && readyAgents.length > 0) setPodName(readyAgents[0].podName);
  }, [readyAgents, podName]);

  const run = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true); setError(null);
    try {
      const res = await ciliumApi.bpfInspect(clusterId, {
        kind,
        podName: podName || undefined,
        endpointId: kind === 'policy' ? (endpointId || undefined) : undefined,
      });
      setData(res);
      if (res.error) setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [clusterId, kind, podName, endpointId]);

  const downloadRaw = () => {
    if (!data?.raw) return;
    const blob = new Blob([data.raw], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cilium-bpf-${kind}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    // MC 클라이언트와 동일한 좌(컨트롤)/우(결과) 배치 — 결과 카드는 실행 전에도 같은
    // 자리(우측)에 플레이스홀더로 고정되어 결과가 나와도 레이아웃이 흔들리지 않는다.
    <div className="grid grid-cols-1 lg:grid-cols-10 gap-4 items-start">
      <div className="lg:col-span-4 min-w-0 space-y-4">
      {/* Toolbar */}
      <MacCard bodyPadding="p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5 text-muted-foreground" />
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as BpfKind)}
              className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {BPF_KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5 text-muted-foreground" />
            <SearchableSelect
              value={podName}
              onChange={setPodName}
              options={agents}
              getKey={(a) => a.podName}
              getLabel={agentLabel}
              placeholder="agent pod 검색 (호스트 번호 등)"
              emptyText="agent 없음"
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
              className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 w-32"
            />
          )}
          <button
            onClick={run}
            disabled={loading || (kind === 'policy' && !endpointId)}
            className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50 mac-shadow"
          >
            <Play className="w-3.5 h-3.5" />
            {loading ? '조회 중…' : '조회'}
          </button>
          {data?.raw && (
            <button
              onClick={downloadRaw}
              className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" /> 내보내기
            </button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {BPF_KINDS.find((k) => k.id === kind)?.desc}
          </span>
        </div>
      </MacCard>

      {/* 직접 명령(ad-hoc) — 목록에 없는 cilium-dbg 명령 실행 + 프리셋 저장 */}
      <RoleGate allow={['admin', 'operator']}>
        <MacCard title="직접 명령 (cilium-dbg)" bodyPadding="p-3">
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              {presets.length > 0 && (
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) setAdhoc(e.target.value); }}
                  className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 max-w-[280px]"
                >
                  <option value="">저장된 프리셋…</option>
                  {presets.map((p) => (
                    <option key={p.id} value={(p.command || '').replace(/^cilium-dbg\s+/, '')}>
                      {p.description || p.command}
                    </option>
                  ))}
                </select>
              )}
              <span className="text-sm font-mono text-muted-foreground">cilium-dbg</span>
              <input
                value={adhoc}
                onChange={(e) => setAdhoc(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runAdhoc(); }}
                placeholder="예: ipam status  ·  bpf endpoint list  ·  status --verbose"
                className="flex-1 min-w-[220px] text-sm font-mono bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <button
                onClick={runAdhoc}
                disabled={adhocBusy || !adhoc.trim()}
                className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl flex items-center gap-1.5 disabled:opacity-50 mac-shadow"
              >
                <Play className="w-3.5 h-3.5" />{adhocBusy ? '실행 중…' : '실행'}
              </button>
              <button
                onClick={savePreset}
                disabled={!adhoc.trim()}
                className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl flex items-center gap-1.5 disabled:opacity-50"
                title="현재 명령을 프리셋으로 저장(주요 명령어 · category=cilium)"
              >
                <Save className="w-3.5 h-3.5" /> 프리셋 저장
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              선택한 agent pod 에서 <code>cilium-dbg &lt;입력&gt;</code> 실행(operator). 임의 바이너리 불가, 실행은 감사 로그에 기록됩니다.
            </p>
            {adhocErr && (
              <div className="px-3 py-2 rounded-lg bg-amber-500/10 text-sm text-amber-700 dark:text-amber-300 break-all">{adhocErr}</div>
            )}
            {adhocOut != null && (
              <pre className="rounded-xl border border-border bg-background p-3 text-xs font-mono whitespace-pre-wrap break-all max-h-[40vh] overflow-auto">{adhocOut}</pre>
            )}
          </div>
        </MacCard>
      </RoleGate>
      </div>

      {/* Result — 우측 고정 (실행 전엔 플레이스홀더) */}
      <MacCard
        title={data ? `결과 · ${data.kind} · ${data.podName}` : '결과'}
        rootClassName="lg:col-span-6 min-w-0"
        bodyPadding="p-0"
        className="overflow-hidden"
      >
        {error && (
          <div className="px-4 py-3 border-b border-border bg-amber-500/10 text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
        {!data && !loading && (
          <div className="text-center py-16 text-sm text-muted-foreground">
            대상 BPF 맵을 선택하고 <kbd className="mx-1 px-1.5 py-0.5 rounded bg-secondary border border-border text-xs">조회</kbd> 를 누르세요.
          </div>
        )}
        {loading && (
          <div className="text-center py-16 text-sm text-muted-foreground flex items-center justify-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" /> cilium-dbg 실행 중…
          </div>
        )}
        {data && data.isJson && Array.isArray(data.parsed) && (
          <BpfJsonTable rows={data.parsed} />
        )}
        {data && (!data.isJson || !Array.isArray(data.parsed)) && data.raw && (
          <pre className="text-xs leading-snug font-mono px-4 py-3 overflow-auto max-h-[60vh] lg:max-h-[calc(100vh-300px)] whitespace-pre-wrap break-all bg-background">
            {data.raw}
          </pre>
        )}
      </MacCard>
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
    return <div className="text-center py-12 text-sm text-muted-foreground">결과가 비어있습니다.</div>;
  }
  return (
    <div className="overflow-auto max-h-[60vh] lg:max-h-[calc(100vh-300px)]">
      <table className="text-sm w-full border-collapse">
        <thead className="sticky top-0 bg-card">
          <tr>
            {cols.map((c) => (
              <th key={c} className="text-left px-3 py-2 border-b border-border font-semibold uppercase tracking-wide text-xs text-muted-foreground whitespace-nowrap">
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

function MonitorTab({ clusterId, agents }: { clusterId: string; agents: CiliumAgent[] }) {
  const readyAgents = agents.filter((a) => a.ready);
  const [podName, setPodName] = useState<string>('');
  const [types, setTypes] = useState<Set<MonitorType>>(new Set(['drop', 'trace']));
  const [relatedTo, setRelatedTo] = useState<string>('');
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [filterText, setFilterText] = useState('');
  const handleRef = useRef<SseStreamHandle | null>(null);
  const eventBuffer = useRef<MonitorEvent[]>([]);
  const flushTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!podName && readyAgents.length > 0) setPodName(readyAgents[0].podName);
  }, [readyAgents, podName]);

  // 모든 stream 종료
  useEffect(() => {
    return () => {
      handleRef.current?.abort();
      if (flushTimer.current) window.clearInterval(flushTimer.current);
    };
  }, []);

  const start = () => {
    if (!podName) { setErr('agent pod 가 필요합니다.'); return; }
    handleRef.current?.abort();
    setEvents([]);
    setErr(null);
    setRunning(true);
    setPaused(false);

    const params = new URLSearchParams({
      pod_name: podName,
      ...(types.size > 0 ? { types: Array.from(types).join(',') } : {}),
      ...(relatedTo ? { related_to: relatedTo } : {}),
    });
    const url = `/api/v1/cilium/${clusterId}/monitor/stream?${params.toString()}`;

    handleRef.current = startSseStream(
      url,
      (line) => {
        let parsed: Record<string, unknown> | undefined;
        try { parsed = JSON.parse(line); } catch { /* keep raw */ }
        const kind = (parsed && typeof parsed.kind === 'string') ? (parsed.kind as string) : undefined;
        eventBuffer.current.push({ ts: Date.now(), raw: line, kind, parsed });
      },
      (e) => {
        setErr(e);
        setRunning(false);
      },
    );

    // 60ms throttled flush — UI 가 폭주 안 하도록
    if (flushTimer.current) window.clearInterval(flushTimer.current);
    flushTimer.current = window.setInterval(() => {
      if (paused || eventBuffer.current.length === 0) return;
      setEvents((prev) => {
        const next = [...prev, ...eventBuffer.current];
        eventBuffer.current = [];
        return next.length > 1000 ? next.slice(next.length - 1000) : next;
      });
    }, 80);
  };

  const stop = () => {
    handleRef.current?.abort();
    handleRef.current = null;
    setRunning(false);
  };

  const clear = () => { setEvents([]); eventBuffer.current = []; };

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
      <MacCard bodyPadding="p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5 text-muted-foreground" />
            <SearchableSelect
              value={podName}
              onChange={setPodName}
              options={agents}
              getKey={(a) => a.podName}
              getLabel={agentLabel}
              placeholder="agent pod 검색 (호스트 번호 등)"
              emptyText="agent 없음"
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
            placeholder="related-to (endpoint id)"
            className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 w-44 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
          {!running ? (
            <button
              onClick={start}
              className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1.5 mac-shadow"
            >
              <Play className="w-3.5 h-3.5" /> 시작
            </button>
          ) : (
            <button
              onClick={stop}
              className="px-3.5 py-1.5 text-sm font-semibold bg-red-500 hover:bg-red-600 text-white rounded-xl transition-colors flex items-center gap-1.5"
            >
              <X className="w-3.5 h-3.5" /> 중단
            </button>
          )}
          <button
            onClick={() => setPaused((p) => !p)}
            disabled={!running}
            className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            {paused ? '재개' : '일시정지'}
          </button>
          <button
            onClick={clear}
            disabled={events.length === 0}
            className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" /> 비우기
          </button>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            <span className={running ? 'text-emerald-500' : ''}>●</span> {events.length}건
          </span>
        </div>
      </MacCard>

      {err && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" /> {err}
        </div>
      )}
      </div>

      <MacCard
        title="실시간 이벤트"
        rootClassName="lg:col-span-6 min-w-0"
        bodyPadding="p-0"
        className="overflow-hidden"
      >
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="텍스트로 필터링…"
            className="flex-1 text-sm bg-background border border-border rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
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
  const label = types.size === 0 ? '모든 type' : Array.from(types).join(', ');

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

  // 외부 클릭 시 닫기
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60 flex items-center gap-1.5 max-w-[260px]"
      >
        <Filter className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="truncate">{label}</span>
        <ChevronDown className="w-3 h-3 text-muted-foreground" />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-50 w-56 bg-card border border-border rounded-xl mac-shadow p-2 space-y-1"
        >
          {MONITOR_TYPES.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-secondary cursor-pointer">
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
      <div className="py-16 text-center text-sm text-muted-foreground">
        이벤트가 없습니다. 시작 버튼을 누르거나 잠시 기다려 주세요.
      </div>
    );
  }
  return (
    <div ref={ref} className="overflow-auto max-h-[60vh] lg:max-h-[calc(100vh-360px)] font-mono text-xs leading-snug bg-background">
      {events.map((e, i) => (
        <div
          key={i}
          className={`px-3 py-1.5 border-b border-border/30 hover:bg-secondary/30 ${
            e.kind === 'error' ? 'text-red-500' : e.kind === 'meta' ? 'text-muted-foreground' : ''
          }`}
        >
          <span className="text-muted-foreground/70 mr-2">{new Date(e.ts).toLocaleTimeString()}</span>
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
}

// Hubble flow 필터 자동완성용 정적 enum.
const HUBBLE_PROTOCOLS = ['tcp', 'udp', 'http', 'dns', 'icmp', 'sctp', 'kafka', 'grpc'] as const;
const HUBBLE_VERDICTS = ['FORWARDED', 'DROPPED', 'AUDIT', 'ERROR', 'REDIRECTED', 'TRACED'] as const;

function HubbleTab({ clusterId, hubbleInstalled }: { clusterId: string; hubbleInstalled: boolean }) {
  const [filters, setFilters] = useState({
    fromPod: '',
    toPod: '',
    fromNamespace: '',
    toNamespace: '',
    protocol: '',
    verdict: '',
  });
  const [events, setEvents] = useState<HubbleFlowEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const handleRef = useRef<SseStreamHandle | null>(null);
  const buffer = useRef<HubbleFlowEvent[]>([]);
  const flushTimer = useRef<number | null>(null);

  // 클러스터 namespace 목록 — datalist 소스.
  const { data: nsData } = useAnalyzeNamespaces(clusterId);
  // 입력된 from/to namespace 의 pod 목록 — datalist 소스.
  const { data: fromPodsData } = useAnalyzePods(clusterId, filters.fromNamespace);
  const { data: toPodsData } = useAnalyzePods(clusterId, filters.toNamespace);

  // 실시간 flow 이벤트에서 관측된 namespace/pod 누적 — autocomplete 보조.
  const [seenNs, setSeenNs] = useState<Set<string>>(new Set());
  const [seenPods, setSeenPods] = useState<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      handleRef.current?.abort();
      if (flushTimer.current) window.clearInterval(flushTimer.current);
    };
  }, []);

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
    handleRef.current?.abort();
    setEvents([]);
    setErr(null);
    setRunning(true);
    setPaused(false);

    const params = new URLSearchParams();
    if (filters.fromPod)       params.set('from_pod', filters.fromPod);
    if (filters.toPod)         params.set('to_pod', filters.toPod);
    if (filters.fromNamespace) params.set('from_namespace', filters.fromNamespace);
    if (filters.toNamespace)   params.set('to_namespace', filters.toNamespace);
    if (filters.protocol)      params.set('protocol', filters.protocol);
    if (filters.verdict)       params.set('verdict', filters.verdict);

    const url = `/api/v1/cilium/${clusterId}/hubble/stream?${params.toString()}`;

    handleRef.current = startSseStream(
      url,
      (line) => {
        let parsed: Record<string, unknown> | undefined;
        try { parsed = JSON.parse(line); } catch { /* raw */ }
        buffer.current.push({ ts: Date.now(), raw: line, parsed });
      },
      (e) => { setErr(e); setRunning(false); },
    );

    if (flushTimer.current) window.clearInterval(flushTimer.current);
    flushTimer.current = window.setInterval(() => {
      if (paused || buffer.current.length === 0) return;
      setEvents((prev) => {
        const next = [...prev, ...buffer.current];
        buffer.current = [];
        return next.length > 1500 ? next.slice(next.length - 1500) : next;
      });
    }, 80);
  };

  const stop = () => { handleRef.current?.abort(); handleRef.current = null; setRunning(false); };
  const clear = () => { setEvents([]); buffer.current = []; };

  const verdictCounts = useMemo(() => {
    const c = { FORWARDED: 0, DROPPED: 0, AUDIT: 0, OTHER: 0 };
    for (const e of events) {
      const v = (e.parsed as Record<string, unknown> | undefined)?.flow as Record<string, unknown> | undefined;
      const verdict = String((v ?? e.parsed ?? {})?.verdict ?? '');
      if (verdict in c) c[verdict as keyof typeof c]++;
      else if (verdict) c.OTHER++;
    }
    return c;
  }, [events]);

  if (!hubbleInstalled) {
    return (
      <MacCard bodyPadding="p-8">
        <div className="text-center space-y-2">
          <AlertTriangle className="w-10 h-10 mx-auto text-amber-500" />
          <p className="text-sm font-semibold">Hubble Relay 가 설치되어 있지 않습니다.</p>
          <p className="text-sm text-muted-foreground">
            <code className="px-1 py-0.5 rounded bg-secondary">cilium hubble enable --ui</code> 또는 helm 으로 hubble-relay 를 배포해 주세요.
          </p>
        </div>
      </MacCard>
    );
  }

  return (
    // 좌(필터/컨트롤)/우(flow 로그) 고정 배치 — MC 클라이언트 콘솔과 동일 패턴.
    <div className="grid grid-cols-1 lg:grid-cols-10 gap-4 items-start">
      <div className="lg:col-span-4 min-w-0 space-y-4">
      <MacCard bodyPadding="p-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-2 gap-2 mb-2">
          <input
            value={filters.fromNamespace}
            onChange={(e) => setFilters((s) => ({ ...s, fromNamespace: e.target.value }))}
            disabled={running}
            placeholder="from-namespace"
            list="hubble-ns-list"
            className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
          <input
            value={filters.fromPod}
            onChange={(e) => setFilters((s) => ({ ...s, fromPod: e.target.value }))}
            disabled={running}
            placeholder="from-pod (ns/name)"
            list="hubble-from-pod-list"
            className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
          <input
            value={filters.protocol}
            onChange={(e) => setFilters((s) => ({ ...s, protocol: e.target.value }))}
            disabled={running}
            placeholder="protocol (tcp/udp/http/dns)"
            list="hubble-protocol-list"
            className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
          <input
            value={filters.toNamespace}
            onChange={(e) => setFilters((s) => ({ ...s, toNamespace: e.target.value }))}
            disabled={running}
            placeholder="to-namespace"
            list="hubble-ns-list"
            className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
          <input
            value={filters.toPod}
            onChange={(e) => setFilters((s) => ({ ...s, toPod: e.target.value }))}
            disabled={running}
            placeholder="to-pod (ns/name)"
            list="hubble-to-pod-list"
            className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
          <input
            value={filters.verdict}
            onChange={(e) => setFilters((s) => ({ ...s, verdict: e.target.value }))}
            disabled={running}
            placeholder="verdict (FORWARDED/DROPPED)"
            list="hubble-verdict-list"
            className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
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
              className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1.5 mac-shadow"
            >
              <Play className="w-3.5 h-3.5" /> 스트림 시작
            </button>
          ) : (
            <button
              onClick={stop}
              className="px-3.5 py-1.5 text-sm font-semibold bg-red-500 hover:bg-red-600 text-white rounded-xl transition-colors flex items-center gap-1.5"
            >
              <X className="w-3.5 h-3.5" /> 중단
            </button>
          )}
          <button
            onClick={() => setPaused((p) => !p)}
            disabled={!running}
            className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            {paused ? '재개' : '일시정지'}
          </button>
          <button
            onClick={clear}
            disabled={events.length === 0}
            className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" /> 비우기
          </button>
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1 text-emerald-500">
              <CheckCircle2 className="w-3 h-3" /> {verdictCounts.FORWARDED}
            </span>
            <span className="inline-flex items-center gap-1 text-red-500">
              <X className="w-3 h-3" /> {verdictCounts.DROPPED}
            </span>
            <span>전체 {events.length}</span>
          </div>
        </div>
      </MacCard>

      {err && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" /> {err}
        </div>
      )}
      </div>

      <MacCard title="Hubble flows" rootClassName="lg:col-span-6 min-w-0" bodyPadding="p-0" className="overflow-hidden">
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
      <div className="py-16 text-center text-sm text-muted-foreground">
        flow 가 아직 없습니다. 시작 버튼을 눌러 hubble observe --follow 를 시작하세요.
      </div>
    );
  }
  return (
    <div ref={ref} className="overflow-auto max-h-[60vh] lg:max-h-[calc(100vh-360px)] divide-y divide-border/40">
      {events.map((e, i) => {
        const flow = ((e.parsed?.flow as Record<string, unknown>) ?? e.parsed ?? {}) as Record<string, unknown>;
        const verdict = String(flow.verdict ?? '');
        const verdictClr =
          verdict === 'FORWARDED' ? 'text-emerald-500'
          : verdict === 'DROPPED' ? 'text-red-500'
          : verdict === 'AUDIT' ? 'text-amber-500' : 'text-muted-foreground';
        const summary = String(flow.Summary ?? flow.summary ?? '');
        const src = flow.source as Record<string, unknown> | undefined;
        const dst = flow.destination as Record<string, unknown> | undefined;
        const srcLabel = `${(src?.namespace as string) ?? '?'}/${(src?.pod_name as string) ?? '?'}`;
        const dstLabel = `${(dst?.namespace as string) ?? '?'}/${(dst?.pod_name as string) ?? '?'}`;
        const dropReason = flow.drop_reason_desc ?? flow.drop_reason;
        return (
          <div key={i} className="px-3 py-1.5 hover:bg-secondary/30 text-xs font-mono">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-muted-foreground/70 tabular-nums">{new Date(e.ts).toLocaleTimeString()}</span>
              <span className={`font-bold ${verdictClr}`}>{verdict || '?'}</span>
              {dropReason ? (
                <span className="text-red-500">[{String(dropReason)}]</span>
              ) : null}
              <span className="text-foreground">{srcLabel}</span>
              <span className="text-muted-foreground">→</span>
              <span className="text-foreground">{dstLabel}</span>
            </div>
            {summary && <div className="text-muted-foreground truncate pl-1">{summary}</div>}
          </div>
        );
      })}
    </div>
  );
}
