import { useId, useMemo, useState } from 'react';
import {
  Network, Plus, RefreshCw, Server, Cpu, Database, HardDrive,
  Trash2, Pencil, X, ChevronDown, AlertTriangle, Loader2, Tag, GitBranch, Activity, ShieldCheck,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import {
  useInfraNodes,
  useCreateInfraNode,
  useUpdateInfraNode,
  useDeleteInfraNode,
  useSyncInfraNodes,
  useVerifyInfraNode,
} from '@/hooks/useInfraNodes';
import { NodeVerifyModal } from '@/components/infra/NodeVerifyModal';
import { ClusterSidebar } from '@/components/common';
import { topologyTraceApi } from '@/services/api';
import type {
  InfraNode,
  InfraNodeCreate,
  InfraNodeRole,
  NodeVerifyResult,
  TopologyTargetType,
  TopologyTraceResponse,
} from '@/types';

// ── Role 메타 ────────────────────────────────────────────────────────────────
const ROLE_META: Record<InfraNodeRole, { label: string; color: string; bg: string; dot: string }> = {
  master:  { label: 'Master',  color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-500/30',   dot: 'bg-blue-400'   },
  worker:  { label: 'Worker',  color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30', dot: 'bg-emerald-400' },
  storage: { label: 'Storage', color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/30',  dot: 'bg-amber-400'  },
  infra:   { label: 'Infra',   color: 'text-purple-400', bg: 'bg-purple-500/10 border-purple-500/30', dot: 'bg-purple-400' },
};

const ROLES: InfraNodeRole[] = ['master', 'worker', 'storage', 'infra'];

// ── 유틸 ────────────────────────────────────────────────────────────────────
function extractError(e: unknown): string {
  const err = e as { response?: { data?: { detail?: string } }; message?: string };
  return err?.response?.data?.detail ?? err?.message ?? '알 수 없는 오류';
}

// ── 노드 카드 ────────────────────────────────────────────────────────────────
interface NodeCardProps {
  node: InfraNode;
  onEdit: (n: InfraNode) => void;
  onDelete: (n: InfraNode) => void;
  onVerify: (n: InfraNode) => void;
}

function NodeCard({ node, onEdit, onDelete, onVerify }: NodeCardProps) {
  const meta = ROLE_META[node.role];
  return (
    <div className="bg-card border border-border rounded-lg p-3 flex flex-col gap-2 hover:border-primary/40 transition-colors group">
      {/* 헤더 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} />
          <span className="text-sm font-medium text-foreground truncate" title={node.hostname}>
            {node.hostname}
          </span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
          <button
            onClick={() => onVerify(node)}
            title="노드 추가 검증"
            className="p-1 rounded hover:bg-emerald-500/10 text-muted-foreground hover:text-emerald-500 transition-colors"
          >
            <ShieldCheck className="w-3 h-3" />
          </button>
          <button
            onClick={() => onEdit(node)}
            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <Pencil className="w-3 h-3" />
          </button>
          <button
            onClick={() => onDelete(node)}
            className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Role 배지 */}
      <span className={`inline-flex items-center self-start px-2 py-0.5 rounded text-sm font-medium border ${meta.bg} ${meta.color}`}>
        {meta.label}
      </span>

      {/* IP */}
      {node.ipAddress && (
        <p className="text-sm text-muted-foreground font-mono">{node.ipAddress}</p>
      )}

      {/* 스펙 */}
      {(node.cpuCores || node.ramGb || node.diskGb) && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {node.cpuCores && (
            <span className="flex items-center gap-1">
              <Cpu className="w-3 h-3" />{node.cpuCores}c
            </span>
          )}
          {node.ramGb && (
            <span className="flex items-center gap-1">
              <Database className="w-3 h-3" />{node.ramGb}G
            </span>
          )}
          {node.diskGb && (
            <span className="flex items-center gap-1">
              <HardDrive className="w-3 h-3" />{node.diskGb}G
            </span>
          )}
        </div>
      )}

      {/* 스위치 */}
      {node.switchName && (
        <p className="text-sm text-muted-foreground truncate">
          <span className="opacity-60">SW: </span>{node.switchName}
        </p>
      )}

      {/* OS */}
      {node.osInfo && (
        <p className="text-sm text-muted-foreground truncate" title={node.osInfo}>
          {node.osInfo}
        </p>
      )}

      {/* Auto-synced 배지 */}
      {node.autoSynced && (
        <span className="inline-flex items-center gap-1 self-start px-1.5 py-0.5 rounded text-sm bg-sky-500/10 border border-sky-500/20 text-sky-400">
          <RefreshCw className="w-2.5 h-2.5" />K8s 동기화
        </span>
      )}
    </div>
  );
}

// ── 노드 추가/수정 모달 ───────────────────────────────────────────────────────
interface NodeModalProps {
  clusterId: string;
  clusterMeta?: { hostname?: string; firstHost?: string; description?: string; name?: string } | null;
  initial?: InfraNode | null;
  onClose: () => void;
}

const EMPTY_FORM: InfraNodeCreate = {
  clusterId: '',
  hostname: '',
  rackName: '',
  ipAddress: '',
  role: 'worker',
  cpuCores: undefined,
  ramGb: undefined,
  diskGb: undefined,
  osInfo: '',
  switchName: '',
  notes: '',
};

function NodeModal({ clusterId, clusterMeta, initial, onClose }: NodeModalProps) {
  const isEdit = !!initial;
  const createNode = useCreateInfraNode();
  const updateNode = useUpdateInfraNode();

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [form, setForm] = useState<InfraNodeCreate>(() => {
    if (initial) {
      return {
        clusterId: initial.clusterId,
        hostname: initial.hostname,
        rackName: initial.rackName ?? '',
        ipAddress: initial.ipAddress ?? '',
        role: initial.role,
        cpuCores: initial.cpuCores ?? undefined,
        ramGb: initial.ramGb ?? undefined,
        diskGb: initial.diskGb ?? undefined,
        osInfo: initial.osInfo ?? '',
        switchName: initial.switchName ?? '',
        notes: initial.notes ?? '',
      };
    }
    return {
      ...EMPTY_FORM,
      clusterId,
      hostname: clusterMeta?.hostname || '',
      ipAddress: clusterMeta?.firstHost || '',
      notes: clusterMeta?.description ? `[cluster:${clusterMeta.name}] ${clusterMeta.description}` : '',
    };
  });

  const [error, setError] = useState('');

  function set<K extends keyof InfraNodeCreate>(key: K, val: InfraNodeCreate[K]) {
    setForm(f => ({ ...f, [key]: val }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!form.hostname.trim()) { setError('호스트명은 필수입니다.'); return; }
    try {
      if (isEdit && initial) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { clusterId, ...updateData } = form;
        await updateNode.mutateAsync({ id: initial.id, data: { ...updateData, version: initial.version } });
      } else {
        await createNode.mutateAsync(form);
      }
      onClose();
    } catch (e) {
      setError(extractError(e));
    }
  }

  const isPending = createNode.isPending || updateNode.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">
            {isEdit ? '노드 수정' : '노드 추가'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          {!isEdit && clusterMeta && (
            <div className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2">
              클러스터 관리정보 기반 자동입력: hostname / first_host / description
            </div>
          )}
          {/* 호스트명 */}
          <div>
            <label htmlFor={f('hostname')} className="block text-sm font-medium text-muted-foreground mb-1">호스트명 *</label>
            <input
              id={f('hostname')}
              value={form.hostname}
              onChange={e => set('hostname', e.target.value)}
              placeholder="node-01"
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {/* Role */}
          <div>
            <label htmlFor={f('role')} className="block text-sm font-medium text-muted-foreground mb-1">역할</label>
            <div className="relative">
              <select
                id={f('role')}
                value={form.role}
                onChange={e => set('role', e.target.value as InfraNodeRole)}
                className="w-full appearance-none bg-background border border-border rounded-lg px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                {ROLES.map(r => (
                  <option key={r} value={r}>{ROLE_META[r].label}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            </div>
          </div>

          {/* 랙 / IP */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={f('rack')} className="block text-sm font-medium text-muted-foreground mb-1">랙 이름</label>
              <input
                id={f('rack')}
                value={form.rackName ?? ''}
                onChange={e => set('rackName', e.target.value)}
                placeholder="Rack-A1"
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label htmlFor={f('ip')} className="block text-sm font-medium text-muted-foreground mb-1">관리 IP</label>
              <input
                id={f('ip')}
                value={form.ipAddress ?? ''}
                onChange={e => set('ipAddress', e.target.value)}
                placeholder="192.168.1.10"
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>

          {/* CPU / RAM / Disk */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor={f('cpu')} className="block text-sm font-medium text-muted-foreground mb-1">CPU (코어)</label>
              <input
                id={f('cpu')}
                type="number" min={1}
                value={form.cpuCores ?? ''}
                onChange={e => set('cpuCores', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="32"
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label htmlFor={f('ram')} className="block text-sm font-medium text-muted-foreground mb-1">RAM (GB)</label>
              <input
                id={f('ram')}
                type="number" min={1}
                value={form.ramGb ?? ''}
                onChange={e => set('ramGb', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="128"
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label htmlFor={f('disk')} className="block text-sm font-medium text-muted-foreground mb-1">Disk (GB)</label>
              <input
                id={f('disk')}
                type="number" min={1}
                value={form.diskGb ?? ''}
                onChange={e => set('diskGb', e.target.value ? Number(e.target.value) : undefined)}
                placeholder="960"
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>

          {/* 스위치 / OS */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={f('switch')} className="block text-sm font-medium text-muted-foreground mb-1">연결 스위치</label>
              <input
                id={f('switch')}
                value={form.switchName ?? ''}
                onChange={e => set('switchName', e.target.value)}
                placeholder="SW-Core-01"
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label htmlFor={f('os')} className="block text-sm font-medium text-muted-foreground mb-1">OS 정보</label>
              <input
                id={f('os')}
                value={form.osInfo ?? ''}
                onChange={e => set('osInfo', e.target.value)}
                placeholder="Ubuntu 22.04"
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>

          {/* 메모 */}
          <div>
            <label htmlFor={f('notes')} className="block text-sm font-medium text-muted-foreground mb-1">메모</label>
            <textarea
              id={f('notes')}
              value={form.notes ?? ''}
              onChange={e => set('notes', e.target.value)}
              rows={2}
              placeholder="참고 사항..."
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button" onClick={onClose}
              className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted text-muted-foreground transition-colors"
            >
              취소
            </button>
            <button
              type="submit" disabled={isPending}
              className="px-4 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
            >
              {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {isEdit ? '저장' : '추가'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── 삭제 확인 모달 ───────────────────────────────────────────────────────────
interface DeleteConfirmProps {
  node: InfraNode;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}

function DeleteConfirm({ node, onConfirm, onCancel, isPending }: DeleteConfirmProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="bg-card border border-border rounded-xl shadow-2xl w-full max-w-sm p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-full bg-red-500/10">
            <AlertTriangle className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">노드 삭제</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              <span className="font-medium text-foreground">{node.hostname}</span>을 삭제하시겠습니까?
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-muted text-muted-foreground"
          >
            취소
          </button>
          <button
            onClick={onConfirm} disabled={isPending}
            className="px-4 py-2 text-sm rounded-lg bg-red-500 hover:bg-red-600 text-white disabled:opacity-50 flex items-center gap-2"
          >
            {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            삭제
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────
export function InfraTopologyPage() {
  const { data: clusters = [], isLoading: clustersLoading } = useClusters();
  const [selectedClusterId, setSelectedClusterId] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<InfraNode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InfraNode | null>(null);
  const [syncError, setSyncError] = useState('');
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyResult, setVerifyResult] = useState<NodeVerifyResult | null>(null);
  const [syncSummary, setSyncSummary] = useState<NodeVerifyResult[] | null>(null);
  const [traceNamespace, setTraceNamespace] = useState('default');
  const [traceTargetType, setTraceTargetType] = useState<TopologyTargetType>('service');
  const [traceTargetName, setTraceTargetName] = useState('');
  const [traceResult, setTraceResult] = useState<TopologyTraceResponse | null>(null);
  const [traceError, setTraceError] = useState('');
  const [traceLoading, setTraceLoading] = useState(false);

  const activeClusterId = selectedClusterId || clusters[0]?.id || '';
  const activeCluster = clusters.find(c => c.id === activeClusterId);

  const { data: nodesResp, isLoading: nodesLoading } = useInfraNodes(
    activeClusterId ? { clusterId: activeClusterId } : undefined,
  );
  const nodes = useMemo<InfraNode[]>(() => nodesResp?.data ?? [], [nodesResp]);

  const deleteNode = useDeleteInfraNode();
  const syncNodes = useSyncInfraNodes();
  const verifyNode = useVerifyInfraNode();

  async function handleVerify(n: InfraNode) {
    setVerifyResult(null);
    setVerifyOpen(true);
    try {
      const res = await verifyNode.mutateAsync(n.id);
      setVerifyResult(res);
    } catch (e) {
      setVerifyResult({
        hostname: n.hostname, status: 'error', ok: false,
        message: extractError(e), details: {},
      });
    }
  }

  // 스위치 → 랙 → 노드 계층형 그룹핑 (네트워크 레벨부터)
  const switches = useMemo(() => {
    const rolePriority: Record<InfraNodeRole, number> = { master: 0, infra: 1, storage: 2, worker: 3 };
    // 1차: switch 별
    const swMap = new Map<string, InfraNode[]>();
    for (const n of nodes) {
      const sw = n.switchName ?? '(스위치 미지정)';
      if (!swMap.has(sw)) swMap.set(sw, []);
      swMap.get(sw)!.push(n);
    }
    return Array.from(swMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sw, swNodes]) => {
        // 2차: rack 별
        const rackMap = new Map<string, InfraNode[]>();
        for (const n of swNodes) {
          const rack = n.rackName ?? '(랙 미지정)';
          if (!rackMap.has(rack)) rackMap.set(rack, []);
          rackMap.get(rack)!.push(n);
        }
        const racks = Array.from(rackMap.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([rack, rackNodes]) => ({
            rack,
            nodes: [...rackNodes].sort((a, b) =>
              (rolePriority[a.role] ?? 9) - (rolePriority[b.role] ?? 9) || a.hostname.localeCompare(b.hostname),
            ),
          }));
        return { switchName: sw, nodeCount: swNodes.length, racks };
      });
  }, [nodes]);

  // 요약 통계
  const stats = useMemo(() => {
    const counts: Record<InfraNodeRole, number> = { master: 0, worker: 0, storage: 0, infra: 0 };
    for (const n of nodes) counts[n.role] = (counts[n.role] ?? 0) + 1;
    return counts;
  }, [nodes]);

  const traceBottleneck = useMemo(() => {
    if (!traceResult?.hops?.length) return null;
    return traceResult.hops.reduce((acc, hop) => {
      const latency = hop.latencyMs ?? 0;
      const errors = hop.errorCount ?? 0;
      const score = latency + (errors * 10);
      if (!acc || score > acc.score) {
        return { hop, score };
      }
      return acc;
    }, null as { hop: TopologyTraceResponse['hops'][number]; score: number } | null);
  }, [traceResult]);

  async function handleSync() {
    if (!activeClusterId) return;
    setSyncError('');
    setSyncSummary(null);
    try {
      const res = await syncNodes.mutateAsync(activeClusterId);
      // 신규 노드 자동 검증 결과(있으면) 요약 배너로 노출
      setSyncSummary(res.verifications && res.verifications.length ? res.verifications : null);
    } catch (e) {
      setSyncError(extractError(e));
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    try {
      await deleteNode.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch {
      setDeleteTarget(null);
    }
  }

  async function handleTrace() {
    if (!activeClusterId || !traceTargetName.trim() || !traceNamespace.trim()) return;
    setTraceError('');
    setTraceLoading(true);
    try {
      const res = await topologyTraceApi.trace({
        clusterId: activeClusterId,
        namespace: traceNamespace.trim(),
        targetType: traceTargetType,
        targetName: traceTargetName.trim(),
      });
      setTraceResult(res.data);
    } catch (e) {
      setTraceResult(null);
      setTraceError(extractError(e));
    } finally {
      setTraceLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="pr-3 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={activeClusterId || null}
          onSelect={(id) => setSelectedClusterId(id ?? '')}
          iconOnly
        />

        <div className="flex-1 min-w-0 px-5">

        {/* 헤더 */}
        <div className="flex items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Network className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">인프라 토폴로지</h1>
              <p className="text-sm text-muted-foreground mt-0.5">클러스터별 물리 노드 구성 시각화</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={!activeClusterId || syncNodes.isPending}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-muted text-muted-foreground disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncNodes.isPending ? 'animate-spin' : ''}`} />
              K8s 동기화
            </button>
            <button
              onClick={() => { setEditTarget(null); setModalOpen(true); }}
              disabled={!activeClusterId}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              노드 추가
            </button>
          </div>
        </div>

        {clustersLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm mb-6">
            <Loader2 className="w-4 h-4 animate-spin" />로딩 중...
          </div>
        ) : clusters.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Server className="w-10 h-10 opacity-30 mb-3" />
            <p className="text-sm">등록된 클러스터가 없습니다.</p>
          </div>
        ) : (
          <>

            {/* 동기화 오류 */}
            {syncError && (
              <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-4">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{syncError}
                <button onClick={() => setSyncError('')} className="ml-auto"><X className="w-3 h-3" /></button>
              </div>
            )}

            {/* sync 직후 신규 노드 검증 요약 */}
            {syncSummary && (
              <div className="flex items-center gap-2 text-sm bg-card border border-border rounded-lg px-3 py-2 mb-4">
                <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0 text-emerald-500" />
                <span>
                  신규 노드 {syncSummary.length}개 검증 — 정상 {syncSummary.filter(v => v.ok).length},{' '}
                  이상 {syncSummary.filter(v => !v.ok).length}
                </span>
                {syncSummary.filter(v => !v.ok).map(v => (
                  <button
                    key={v.hostname}
                    onClick={() => { setVerifyResult(v); setVerifyOpen(true); }}
                    className="px-1.5 py-0.5 rounded text-xs bg-red-500/10 border border-red-500/20 text-red-500 hover:bg-red-500/20"
                  >
                    {v.hostname}
                  </button>
                ))}
                <button onClick={() => setSyncSummary(null)} className="ml-auto text-muted-foreground"><X className="w-3 h-3" /></button>
              </div>
            )}

            {/* 요약 통계 */}
            {activeCluster && (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 mb-6">
                <div className="col-span-2 sm:col-span-4 lg:col-span-1 bg-card border border-border rounded-lg p-4 flex flex-col gap-1">
                  <p className="text-sm text-muted-foreground">전체 노드</p>
                  <p className="text-2xl font-bold text-foreground">{nodes.length}</p>
                  <p className="text-sm text-muted-foreground">{activeCluster.name}</p>
                </div>
                {ROLES.map(role => {
                  const meta = ROLE_META[role];
                  return (
                    <div key={role} className="bg-card border border-border rounded-lg p-4 flex flex-col gap-1">
                      <p className="text-sm text-muted-foreground">{meta.label}</p>
                      <p className={`text-2xl font-bold ${meta.color}`}>{stats[role]}</p>
                      <div className="flex items-center gap-1">
                        <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                        <span className="text-sm text-muted-foreground">노드</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Trace 패널 */}
            {activeCluster && (
              <div className="bg-card border border-border rounded-xl p-4 mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <GitBranch className="w-4 h-4 text-primary" />
                  <h2 className="text-sm font-semibold text-foreground">Pod/Service → Switch Trace</h2>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3">
                  <input
                    value={traceNamespace}
                    onChange={e => setTraceNamespace(e.target.value)}
                    placeholder="namespace"
                    className="bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <select
                    value={traceTargetType}
                    onChange={e => setTraceTargetType(e.target.value as TopologyTargetType)}
                    className="bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="service">service</option>
                    <option value="pod">pod</option>
                  </select>
                  <input
                    value={traceTargetName}
                    onChange={e => setTraceTargetName(e.target.value)}
                    placeholder={traceTargetType === 'service' ? 'service-name' : 'pod-name'}
                    className="bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <button
                    onClick={handleTrace}
                    disabled={traceLoading || !traceTargetName.trim() || !traceNamespace.trim()}
                    className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                  >
                    {traceLoading && <Loader2 className="w-3 h-3 animate-spin" />}
                    Trace 실행
                  </button>
                </div>

                {traceError && (
                  <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{traceError}
                  </div>
                )}

                {traceResult && (
                  <div className="flex flex-col gap-2">
                    {traceBottleneck && (
                      <div className="flex items-center gap-2 text-amber-300 text-sm bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
                        <Activity className="w-3.5 h-3.5" />
                        병목 의심 홉: <span className="font-semibold">{traceBottleneck.hop.name}</span>
                        <span className="opacity-80">
                          (latency: {traceBottleneck.hop.latencyMs ?? '-'}ms, errors: {traceBottleneck.hop.errorCount ?? 0})
                        </span>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {traceResult.hops.map((hop, idx) => (
                        <div key={`${hop.entityId}-${idx}`} className="inline-flex items-center gap-2">
                          <div className="px-2.5 py-1.5 rounded-lg border border-border bg-background text-sm">
                            <span className="text-muted-foreground">{hop.entityType}</span>
                            <span className="mx-1">·</span>
                            <span className="font-medium text-foreground">{hop.name}</span>
                            {(hop.latencyMs !== undefined || hop.errorCount !== undefined) && (
                              <span className="ml-1 text-muted-foreground">
                                ({hop.latencyMs ?? '-'}ms / err {hop.errorCount ?? 0})
                              </span>
                            )}
                          </div>
                          {idx < traceResult.hops.length - 1 && (
                            <span className="text-muted-foreground text-sm">→</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 토폴로지 본문 */}
            {nodesLoading ? (
              <div className="flex items-center justify-center py-20 text-muted-foreground">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : nodes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground border border-dashed border-border rounded-xl">
                <Server className="w-10 h-10 opacity-30" />
                <p className="text-sm">이 클러스터에 노드가 없습니다.</p>
                <button
                  onClick={() => { setEditTarget(null); setModalOpen(true); }}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Plus className="w-3.5 h-3.5" />첫 노드 추가
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                {switches.map(({ switchName, nodeCount, racks: swRacks }) => (
                  <section
                    key={switchName}
                    className="rounded-xl border border-sky-500/30 bg-sky-500/[0.03] overflow-hidden"
                  >
                    {/* 스위치 헤더 (L2/L3) */}
                    <header className="flex items-center gap-2 px-4 py-2.5 bg-sky-500/10 border-b border-sky-500/20">
                      <Network className="w-4 h-4 text-sky-400 flex-shrink-0" />
                      <span className="text-sm font-semibold text-sky-300">{switchName}</span>
                      <span className="text-xs font-mono text-sky-400/70">ToR / Leaf</span>
                      <span className="ml-auto text-sm text-muted-foreground">
                        {swRacks.length}개 랙 · {nodeCount}개 노드
                      </span>
                    </header>

                    {/* 아래: 해당 스위치에 물린 랙 + 노드 */}
                    <div className="flex gap-4 overflow-x-auto p-4">
                      {swRacks.map(({ rack, nodes: rackNodes }) => (
                        <div key={`${switchName}::${rack}`} className="flex-shrink-0 w-56 flex flex-col gap-2">
                          {/* 랙 헤더 */}
                          <div className="flex items-center gap-2 px-2 py-1.5 bg-muted/50 rounded-lg border border-border">
                            <Tag className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="text-sm font-semibold text-foreground truncate">{rack}</span>
                            <span className="ml-auto text-sm text-muted-foreground flex-shrink-0">
                              {rackNodes.length}
                            </span>
                          </div>
                          {/* 노드 카드들 */}
                          <div className="flex flex-col gap-2">
                            {rackNodes.map(node => (
                              <NodeCard
                                key={node.id}
                                node={node}
                                onEdit={n => { setEditTarget(n); setModalOpen(true); }}
                                onDelete={n => setDeleteTarget(n)}
                                onVerify={handleVerify}
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
        </div>
      </main>

      {/* 추가/수정 모달 */}
      {modalOpen && activeClusterId && (
        <NodeModal
          clusterId={activeClusterId}
          clusterMeta={activeCluster}
          initial={editTarget}
          onClose={() => { setModalOpen(false); setEditTarget(null); }}
        />
      )}

      {/* 삭제 확인 */}
      {deleteTarget && (
        <DeleteConfirm
          node={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
          isPending={deleteNode.isPending}
        />
      )}

      {/* 노드 추가 검증 */}
      {verifyOpen && (
        <NodeVerifyModal
          result={verifyResult}
          loading={verifyNode.isPending && !verifyResult}
          onClose={() => { setVerifyOpen(false); setVerifyResult(null); }}
        />
      )}
    </div>
  );
}
