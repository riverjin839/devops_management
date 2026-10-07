import { useId, useMemo, useRef, useState } from 'react';
import {
  Network, Plus, RefreshCw, Server, Cpu, Database, HardDrive,
  Trash2, Pencil, X, ChevronDown, AlertTriangle, Loader2, Tag, Activity, ShieldCheck,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useCanOperate } from '@/hooks/useCanOperate';
import { formatApiError } from '@/lib/utils';
import {
  useInfraNodes,
  useCreateInfraNode,
  useUpdateInfraNode,
  useDeleteInfraNode,
  useSyncInfraNodes,
  useVerifyInfraNode,
} from '@/hooks/useInfraNodes';
import { NodeVerifyModal } from '@/components/infra/NodeVerifyModal';
import { ClusterSidebar, RunLogPanel, useModalA11y } from '@/components/common';
import { useRunLog, type RunLogLevel } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { MacCard } from '@/components/ui/MacCard';
import { topologyTraceApi } from '@/services/api';
import type {
  InfraNode,
  InfraNodeCreate,
  InfraNodeRole,
  InfraSyncResult,
  NodeVerifyResult,
  TopologyTargetType,
  TopologyTraceResponse,
} from '@/types';

// ── Role 메타 ────────────────────────────────────────────────────────────────
const ROLE_META: Record<InfraNodeRole, { label: string; color: string; bg: string; dot: string }> = {
  master:  { label: 'Master',  color: 'text-chart-1',    bg: 'bg-chart-1/10 border-chart-1/30',     dot: 'bg-chart-1'    },
  worker:  { label: 'Worker',  color: 'text-status-healthy', bg: 'bg-status-healthy/10 border-status-healthy/30', dot: 'bg-status-healthy' },
  storage: { label: 'Storage', color: 'text-status-warning',  bg: 'bg-status-warning/10 border-status-warning/30',  dot: 'bg-status-warning'  },
  infra:   { label: 'Infra',   color: 'text-chart-4',    bg: 'bg-chart-4/10 border-chart-4/30',     dot: 'bg-chart-4'    },
};

const ROLES: InfraNodeRole[] = ['master', 'worker', 'storage', 'infra'];

// ── 유틸 ────────────────────────────────────────────────────────────────────
function extractError(e: unknown): string {
  // 낙관적 락 충돌(409)은 detail 이 문자열이 아니라 {message, expected_version, …} 객체다 — 그대로 렌더하면
  // React 가 "Objects are not valid as a React child" 로 화면 전체를 죽인다(D-086). 영어 원문 대신 안내 문구로.
  const err = e as { response?: { status?: number; data?: { detail?: unknown } } };
  const detail = err?.response?.data?.detail;
  if (err?.response?.status === 409 && detail && typeof detail === 'object' && 'expected_version' in detail) {
    return '다른 사용자가 먼저 이 노드를 수정했습니다 — 화면을 새로고침한 뒤 다시 시도하세요.';
  }
  return formatApiError(e, '알 수 없는 오류');
}

// ── 노드 카드 ────────────────────────────────────────────────────────────────
interface NodeCardProps {
  node: InfraNode;
  onEdit: (n: InfraNode) => void;
  onDelete: (n: InfraNode) => void;
  onVerify: (n: InfraNode) => void;
  /** D-087 — 서버가 operator 이상을 요구하는 동작(검증·편집·삭제)의 활성 조건과 비활성 사유. */
  canOperate: boolean;
  withHint: (title: string) => string;
}

function NodeCard({ node, onEdit, onDelete, onVerify, canOperate, withHint }: NodeCardProps) {
  const meta = ROLE_META[node.role];
  return (
    <div className="bg-card border border-border rounded-md p-3 flex flex-col gap-2 hover:border-primary/40 transition-colors group">
      {/* 헤더 */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} />
          <span className="text-sm font-medium text-foreground truncate" title={node.hostname}>
            {node.hostname}
          </span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity flex-shrink-0">
          <button
            onClick={() => onVerify(node)}
            disabled={!canOperate}
            title={withHint('노드 추가 검증')}
            aria-label={withHint('노드 추가 검증')}
            className="p-1 rounded-xl hover:bg-status-healthy/10 text-muted-foreground hover:text-status-healthy transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ShieldCheck className="w-3 h-3" />
          </button>
          <button
            onClick={() => onEdit(node)}
            disabled={!canOperate}
            title={withHint('노드 편집')}
            className="p-1 rounded-xl hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={withHint('노드 편집')}
          >
            <Pencil className="w-3 h-3" />
          </button>
          <button
            onClick={() => onDelete(node)}
            disabled={!canOperate}
            title={withHint('노드 삭제')}
            className="p-1 rounded-xl hover:bg-status-critical/10 text-muted-foreground hover:text-status-critical transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label={withHint('노드 삭제')}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Role 배지 */}
      <span className={`inline-flex items-center self-start px-2 py-0.5 rounded-md text-sm font-medium border ${meta.bg} ${meta.color}`}>
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
        <span className="inline-flex items-center gap-1 self-start px-1.5 py-0.5 rounded-md text-sm bg-status-info/10 border border-status-info/20 text-status-info">
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
  cpuCores: null,
  ramGb: null,
  diskGb: null,
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
  const dialogRef = useModalA11y(true, onClose);

  const [form, setForm] = useState<InfraNodeCreate>(() => {
    if (initial) {
      return {
        clusterId: initial.clusterId,
        hostname: initial.hostname,
        rackName: initial.rackName ?? '',
        ipAddress: initial.ipAddress ?? '',
        role: initial.role,
        cpuCores: initial.cpuCores ?? null,
        ramGb: initial.ramGb ?? null,
        diskGb: initial.diskGb ?? null,
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
    // D-100 — 비운 값은 "삭제"로 보낸다. 숫자를 undefined 로 두면 JSON 에서 빠져 서버 부분 수정이
    // 기존 값을 유지했고, 빈 문자열은 그대로 저장돼 이름 없는 랙/스위치 그룹을 만들었다.
    const blank = (v?: string | null) => (v && v.trim() ? v.trim() : null);
    const payload: InfraNodeCreate = {
      ...form,
      hostname: form.hostname.trim(),
      rackName: blank(form.rackName),
      ipAddress: blank(form.ipAddress),
      osInfo: blank(form.osInfo),
      switchName: blank(form.switchName),
      notes: blank(form.notes),
      cpuCores: form.cpuCores ?? null,
      ramGb: form.ramGb ?? null,
      diskGb: form.diskGb ?? null,
    };
    try {
      if (isEdit && initial) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { clusterId, ...updateData } = payload;
        await updateNode.mutateAsync({ id: initial.id, data: { ...updateData, version: initial.version } });
      } else {
        await createNode.mutateAsync(payload);
      }
      onClose();
    } catch (e) {
      setError(extractError(e));
    }
  }

  const isPending = createNode.isPending || updateNode.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={f('title')} className="bg-card border border-border rounded-xl shadow-card w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 id={f('title')} className="text-base font-semibold text-foreground">
            {isEdit ? '노드 수정' : '노드 추가'}
          </h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded-xl hover:bg-muted text-muted-foreground" title="닫기" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          {!isEdit && clusterMeta && (
            <div className="text-xs text-muted-foreground bg-muted/40 border border-border rounded-md px-3 py-2">
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
              className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                className="w-full appearance-none bg-background border border-border rounded-xl px-3 py-2 text-sm pr-8 focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label htmlFor={f('ip')} className="block text-sm font-medium text-muted-foreground mb-1">관리 IP</label>
              <input
                id={f('ip')}
                value={form.ipAddress ?? ''}
                onChange={e => set('ipAddress', e.target.value)}
                placeholder="192.168.1.10"
                className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                onChange={e => set('cpuCores', e.target.value ? Number(e.target.value) : null)}
                placeholder="32"
                className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label htmlFor={f('ram')} className="block text-sm font-medium text-muted-foreground mb-1">RAM (GB)</label>
              <input
                id={f('ram')}
                type="number" min={1}
                value={form.ramGb ?? ''}
                onChange={e => set('ramGb', e.target.value ? Number(e.target.value) : null)}
                placeholder="128"
                className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label htmlFor={f('disk')} className="block text-sm font-medium text-muted-foreground mb-1">Disk (GB)</label>
              <input
                id={f('disk')}
                type="number" min={1}
                value={form.diskGb ?? ''}
                onChange={e => set('diskGb', e.target.value ? Number(e.target.value) : null)}
                placeholder="960"
                className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
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
                className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <label htmlFor={f('os')} className="block text-sm font-medium text-muted-foreground mb-1">OS 정보</label>
              <input
                id={f('os')}
                value={form.osInfo ?? ''}
                onChange={e => set('osInfo', e.target.value)}
                placeholder="Ubuntu 22.04"
                className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
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
              className="w-full bg-background border border-border rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-status-critical text-sm bg-status-critical/10 border border-status-critical/20 rounded-md px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button" onClick={onClose}
              className="px-4 py-2 text-sm rounded-xl border border-border hover:bg-muted text-muted-foreground transition-colors"
            >
              취소
            </button>
            <button
              type="submit" disabled={isPending}
              className="px-4 py-2 text-sm rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2"
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
  error?: string;
}

function DeleteConfirm({ node, onConfirm, onCancel, isPending, error }: DeleteConfirmProps) {
  const dialogRef = useModalA11y(true, onCancel);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="노드 삭제 확인" className="bg-card border border-border rounded-xl shadow-card w-full max-w-sm p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-full bg-status-critical/10">
            <AlertTriangle className="w-5 h-5 text-status-critical" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">노드 삭제</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              <span className="font-medium text-foreground">{node.hostname}</span>을 삭제하시겠습니까?
            </p>
          </div>
        </div>
        {error && (
          <div role="alert" className="flex items-start gap-2 text-sm text-status-critical bg-status-critical/10 border border-status-critical/20 rounded-md px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />{error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-xl border border-border hover:bg-muted text-muted-foreground"
          >
            취소
          </button>
          <button
            onClick={onConfirm} disabled={isPending}
            className="px-4 py-2 text-sm rounded-xl bg-status-critical hover:bg-status-critical/90 text-white disabled:opacity-50 flex items-center gap-2"
          >
            {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            삭제
          </button>
        </div>
      </div>
    </div>
  );
}

// 검증 결과 상태 → 로그 레벨
function verifyLevel(status: NodeVerifyResult['status']): RunLogLevel {
  return status === 'critical' || status === 'error' ? 'error' : status === 'healthy' ? 'info' : 'warn';
}

const elapsed = (t0: number) => `${Math.round(performance.now() - t0)}ms`;

// ── 메인 페이지 ──────────────────────────────────────────────────────────────
export function InfraTopologyPage() {
  const { data: clusters = [], isLoading: clustersLoading } = useClusters();
  const [selectedClusterId, setSelectedClusterId] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<InfraNode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InfraNode | null>(null);
  const [syncError, setSyncError] = useState('');
  const [syncResult, setSyncResult] = useState<InfraSyncResult | null>(null);
  const [deleteError, setDeleteError] = useState('');
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
  // 응답이 늦게 와도 그사이 클러스터를 바꿨다면 버린다 — 다른 클러스터 결과를 현재 것으로 오독(D-094).
  const activeClusterRef = useRef(activeClusterId);
  activeClusterRef.current = activeClusterId;
  const activeCluster = clusters.find(c => c.id === activeClusterId);
  const { canOperate, withHint } = useCanOperate(activeClusterId);

  const { data: nodesResp, isLoading: nodesLoading, isError: nodesError, error: nodesErr, refetch: refetchNodes } = useInfraNodes(
    activeClusterId ? { clusterId: activeClusterId } : undefined,
  );
  const nodes = useMemo<InfraNode[]>(() => nodesResp?.data ?? [], [nodesResp]);

  const deleteNode = useDeleteInfraNode();
  const syncNodes = useSyncInfraNodes();
  const verifyNode = useVerifyInfraNode();
  // D-089 — 실행 버튼(K8s 동기화·노드 검증·Trace)마다 단계·결과를 시각과 함께 남기고, 펼쳐 볼지는 "로그 보기" 로 정한다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('infra-topology');

  function logVerify(r: NodeVerifyResult, prefix = '') {
    runLog.log(verifyLevel(r.status), `${prefix}${r.hostname}: ${r.status} — ${r.message}`);
    for (const st of r.steps ?? []) {
      const lvl: RunLogLevel = st.status === 'failed' ? 'error' : st.status === 'skipped' ? 'warn' : 'info';
      const dur = st.durationMs != null ? ` · ${st.durationMs}ms` : '';
      runLog.log(lvl, `${prefix}  - ${st.label}: ${st.status}${dur}${st.detail ? ` — ${st.detail}` : ''}`);
    }
  }

  async function handleVerify(n: InfraNode) {
    setVerifyResult(null);
    setVerifyOpen(true);
    const t0 = performance.now();
    runLog.begin('노드 검증', `${n.hostname} 검증 요청 (SSH/API 점검)`);
    try {
      const res = await verifyNode.mutateAsync(n.id);
      setVerifyResult(res);
      logVerify(res);
      runLog.log(res.ok ? 'info' : 'warn', `검증 ${res.ok ? '통과' : '미통과'} · ${elapsed(t0)}`);
    } catch (e) {
      const msg = extractError(e);
      setVerifyResult({
        hostname: n.hostname, status: 'error', ok: false,
        message: msg, details: {},
      });
      runLog.log('error', `검증 실패 · ${elapsed(t0)} — ${msg}`);
    } finally {
      runLog.end();
    }
  }

  // 스위치 → 랙 → 노드 계층형 그룹핑 (네트워크 레벨부터)
  const switches = useMemo(() => {
    const rolePriority: Record<InfraNodeRole, number> = { master: 0, infra: 1, storage: 2, worker: 3 };
    // 1차: switch 별
    const swMap = new Map<string, InfraNode[]>();
    for (const n of nodes) {
      const sw = n.switchName || '(스위치 미지정)';
      if (!swMap.has(sw)) swMap.set(sw, []);
      swMap.get(sw)!.push(n);
    }
    return Array.from(swMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sw, swNodes]) => {
        // 2차: rack 별
        const rackMap = new Map<string, InfraNode[]>();
        for (const n of swNodes) {
          const rack = n.rackName || '(랙 미지정)';
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

  // D-094 — 클러스터를 바꾸면 이전 클러스터의 동기화·Trace 결과를 지운다.
  function selectCluster(id: string) {
    if (id === activeClusterId) return;
    setSelectedClusterId(id);
    setSyncError('');
    setSyncResult(null);
    setSyncSummary(null);
    setTraceResult(null);
    setTraceError('');
    setTraceNamespace('default');
    setTraceTargetName('');
    runLog.clear();
  }

  async function handleSync() {
    if (!activeClusterId) return;
    const requestedFor = activeClusterId;
    setSyncError('');
    setSyncSummary(null);
    setSyncResult(null);
    const t0 = performance.now();
    runLog.begin('K8s 동기화', `${activeCluster?.name ?? requestedFor} — kubectl get nodes 로 노드 정보 수집 요청`);
    try {
      const res = await syncNodes.mutateAsync(activeClusterId);
      if (activeClusterRef.current !== requestedFor) return;
      // 생성/갱신/실패 요약 — 신규 노드가 0개여도 "동기화가 됐다"는 피드백을 남긴다(D-088)
      setSyncResult(res);
      // 신규 노드 자동 검증 결과(있으면) 요약 배너로 노출
      setSyncSummary(res.verifications && res.verifications.length ? res.verifications : null);
      runLog.log(res.failed > 0 ? 'warn' : 'info',
        `수집 완료 · ${elapsed(t0)} — 총 ${res.total} · 생성 ${res.created} · 갱신 ${res.updated} · 실패 ${res.failed}`
        + (res.retryCount ? ` · kubectl 재시도 ${res.retryCount}회` : ''));
      for (const err of res.errors ?? []) runLog.log('error', `오류: ${err}`);
      for (const v of res.verifications ?? []) logVerify(v, '[신규 노드 검증] ');
      if (res.verifiedTruncated) runLog.log('warn', '신규 노드가 많아 일부만 자동 검증했다 — 나머지는 노드 카드의 검증 버튼으로 실행');
    } catch (e) {
      if (activeClusterRef.current !== requestedFor) return;
      const msg = extractError(e);
      setSyncError(msg);
      runLog.log('error', `동기화 실패 · ${elapsed(t0)} — ${msg}`);
    } finally {
      runLog.end();
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return;
    setDeleteError('');
    try {
      await deleteNode.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (e) {
      // 실패해도 모달을 닫지 않고 사유를 보여준다 — 예전엔 조용히 닫혀 삭제가 성공한 것처럼 보였다(D-088)
      setDeleteError(extractError(e));
    }
  }

  async function handleTrace() {
    if (!activeClusterId || !traceTargetName.trim() || !traceNamespace.trim()) return;
    const requestedFor = activeClusterId;
    setTraceError('');
    setTraceLoading(true);
    const t0 = performance.now();
    runLog.begin('Trace', `${traceNamespace.trim()}/${traceTargetType} ${traceTargetName.trim()} → 스위치 경로 추적 요청`);
    try {
      const res = await topologyTraceApi.trace({
        clusterId: activeClusterId,
        namespace: traceNamespace.trim(),
        targetType: traceTargetType,
        targetName: traceTargetName.trim(),
      });
      if (activeClusterRef.current !== requestedFor) return;
      setTraceResult(res.data);
      const hops = res.data.hops ?? [];
      runLog.log(hops.length ? 'info' : 'warn', `추적 완료 · ${elapsed(t0)} — hop ${hops.length}개`);
      hops.forEach((h, i) => {
        const extra = [
          h.interface ? `if ${h.interface}` : '',
          h.latencyMs != null ? `${h.latencyMs}ms` : '',
          h.errorCount ? `errors ${h.errorCount}` : '',
        ].filter(Boolean).join(' · ');
        runLog.log(h.errorCount ? 'warn' : 'info', `  #${i + 1} ${h.entityType} ${h.name}${extra ? ` (${extra})` : ''}`);
      });
    } catch (e) {
      if (activeClusterRef.current !== requestedFor) return;
      const msg = extractError(e);
      setTraceResult(null);
      setTraceError(msg);
      runLog.log('error', `추적 실패 · ${elapsed(t0)} — ${msg}`);
    } finally {
      setTraceLoading(false);
      runLog.end();
    }
  }

  return (
    <div className="app-min-h-screen bg-background">
      <main className="pr-3 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={activeClusterId || null}
          onSelect={(id) => selectCluster(id ?? '')}
          iconOnly
        />

        <div className="flex-1 min-w-0 px-5">

        {/* 헤더 */}
        <div className="flex items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-md bg-primary/10">
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
              disabled={!activeClusterId || syncNodes.isPending || !canOperate}
              title={withHint('K8s 노드 정보를 동기화')}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-xl border border-border hover:bg-muted text-muted-foreground disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncNodes.isPending ? 'animate-spin' : ''}`} />
              K8s 동기화
            </button>
            <button
              onClick={() => { setEditTarget(null); setModalOpen(true); }}
              disabled={!activeClusterId || !canOperate}
              title={withHint('노드 추가')}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              노드 추가
            </button>
          </div>
        </div>

        <div className="mb-4 empty:mb-0">
          <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} />
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
              <div className="flex items-center gap-2 text-status-critical text-sm bg-status-critical/10 border border-status-critical/20 rounded-md px-3 py-2 mb-4">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{syncError}
                <button type="button" onClick={() => setSyncError('')} className="ml-auto" title="오류 메시지 닫기" aria-label="오류 메시지 닫기"><X className="w-3 h-3" /></button>
              </div>
            )}

            {/* 동기화 결과 요약 (생성/갱신/실패 + 오류 목록) */}
            {syncResult && (
              <div
                role="status"
                className={`text-sm bg-card border rounded-md px-3 py-2 mb-4 ${
                  syncResult.failed > 0 || syncResult.partialFailure ? 'border-status-warning/40' : 'border-border'
                }`}
              >
                <div className="flex items-center gap-2">
                  {syncResult.failed > 0 || syncResult.partialFailure
                    ? <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 text-status-warning" />
                    : <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0 text-status-healthy" />}
                  <span>
                    동기화 {syncResult.failed > 0 || syncResult.partialFailure ? '부분 완료' : '완료'} —
                    생성 {syncResult.created} · 갱신 {syncResult.updated} · 실패 {syncResult.failed} (총 {syncResult.total})
                    {syncResult.retryCount > 0 && ` · 재시도 ${syncResult.retryCount}회`}
                  </span>
                  <button onClick={() => setSyncResult(null)} className="ml-auto text-muted-foreground" aria-label="동기화 결과 닫기" title="동기화 결과 닫기"><X className="w-3 h-3" /></button>
                </div>
                {syncResult.errors.length > 0 && (
                  <ul className="mt-1.5 ml-5 list-disc text-xs text-status-warning space-y-0.5">
                    {syncResult.errors.slice(0, 5).map((m, i) => <li key={i}>{m}</li>)}
                    {syncResult.errors.length > 5 && <li>… 외 {syncResult.errors.length - 5}건</li>}
                  </ul>
                )}
                {syncResult.verifiedTruncated && (
                  <p className="mt-1 ml-5 text-xs text-muted-foreground">신규 노드가 많아 자동 검증은 일부만 수행했습니다.</p>
                )}
              </div>
            )}

            {/* sync 직후 신규 노드 검증 요약 */}
            {syncSummary && (
              <div className="flex items-center gap-2 text-sm bg-card border border-border rounded-md px-3 py-2 mb-4">
                <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0 text-status-healthy" />
                <span>
                  신규 노드 {syncSummary.length}개 검증 — 정상 {syncSummary.filter(v => v.ok).length},{' '}
                  이상 {syncSummary.filter(v => !v.ok).length}
                </span>
                {syncSummary.filter(v => !v.ok).map(v => (
                  <button
                    key={v.hostname}
                    onClick={() => { setVerifyResult(v); setVerifyOpen(true); }}
                    className="px-1.5 py-0.5 rounded-xl text-xs bg-status-critical/10 border border-status-critical/20 text-status-critical hover:bg-status-critical/20"
                  >
                    {v.hostname}
                  </button>
                ))}
                <button onClick={() => setSyncSummary(null)} className="ml-auto text-muted-foreground" aria-label="검증 요약 닫기"><X className="w-3 h-3" /></button>
              </div>
            )}

            {/* 요약 통계 */}
            {activeCluster && (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 mb-6">
                <div className="col-span-2 sm:col-span-4 lg:col-span-1 bg-card border border-border rounded-md p-4 flex flex-col gap-1">
                  <p className="text-sm text-muted-foreground">전체 노드</p>
                  <p className="text-2xl font-bold text-foreground">{nodes.length}</p>
                  <p className="text-sm text-muted-foreground">{activeCluster.name}</p>
                </div>
                {ROLES.map(role => {
                  const meta = ROLE_META[role];
                  return (
                    <div key={role} className="bg-card border border-border rounded-md p-4 flex flex-col gap-1">
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
              <MacCard title="Pod/Service → Switch Trace" rootClassName="mb-6">
                {/* <form> 이라 Enter 로 실행되고, 각 입력에 라벨이 붙는다(D-095) */}
                <form
                  onSubmit={(e) => { e.preventDefault(); void handleTrace(); }}
                  className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3 items-end"
                >
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Namespace
                    <input
                      value={traceNamespace}
                      onChange={e => setTraceNamespace(e.target.value)}
                      placeholder="namespace"
                      className="bg-background border border-border rounded-xl px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    대상 종류
                    <select
                      value={traceTargetType}
                      onChange={e => setTraceTargetType(e.target.value as TopologyTargetType)}
                      className="bg-background border border-border rounded-xl px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                      <option value="service">service</option>
                      <option value="pod">pod</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    대상 이름
                    <input
                      value={traceTargetName}
                      onChange={e => setTraceTargetName(e.target.value)}
                      placeholder={traceTargetType === 'service' ? 'service-name' : 'pod-name'}
                      className="bg-background border border-border rounded-xl px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={traceLoading || !traceTargetName.trim() || !traceNamespace.trim()}
                    className="px-3 py-2 text-sm rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                  >
                    {traceLoading && <Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
                    {traceLoading ? <span role="status">추적 중…</span> : 'Trace 실행'}
                  </button>
                </form>

                {traceError && (
                  <div className="flex items-center gap-2 text-status-critical text-sm bg-status-critical/10 border border-status-critical/20 rounded-md px-3 py-2 mb-3">
                    <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{traceError}
                  </div>
                )}

                {traceResult && (
                  <div className="flex flex-col gap-2">
                    {traceBottleneck && (
                      <div className="flex items-center gap-2 text-status-warning text-sm bg-status-warning/10 border border-status-warning/30 rounded-md px-3 py-2">
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
                          <div className="px-2.5 py-1.5 rounded-md border border-border bg-background text-sm">
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
              </MacCard>
            )}

            {/* 토폴로지 본문 */}
            {nodesLoading ? (
              <div className="flex items-center justify-center py-20 text-muted-foreground">
                <Loader2 className="w-6 h-6 animate-spin" />
              </div>
            ) : nodesError && !nodesResp ? (
              <div role="alert" className="flex flex-col items-center justify-center py-16 gap-3 border border-status-critical/30 bg-status-critical/5 rounded-md text-status-critical">
                <AlertTriangle className="w-8 h-8" />
                <p className="text-sm">노드 목록을 불러오지 못했습니다 — {extractError(nodesErr)}</p>
                <button
                  onClick={() => refetchNodes()}
                  className="px-3 py-1.5 text-sm rounded-xl border border-border bg-card text-foreground hover:bg-muted"
                >
                  다시 시도
                </button>
              </div>
            ) : nodes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground border border-dashed border-border rounded-xl">
                <Server className="w-10 h-10 opacity-30" />
                <p className="text-sm">이 클러스터에 노드가 없습니다.</p>
                <button
                  onClick={() => { setEditTarget(null); setModalOpen(true); }}
                  disabled={!canOperate}
                  title={withHint('첫 노드 추가')}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="w-3.5 h-3.5" />첫 노드 추가
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                {switches.map(({ switchName, nodeCount, racks: swRacks }) => (
                  <section
                    key={switchName}
                    className="rounded-xl border border-status-info/30 bg-status-info/[0.03] overflow-hidden"
                  >
                    {/* 스위치 헤더 (L2/L3) */}
                    <header className="flex items-center gap-2 px-4 py-2.5 bg-status-info/10 border-b border-status-info/20">
                      <Network className="w-4 h-4 text-status-info flex-shrink-0" />
                      <span className="text-sm font-semibold text-status-info">{switchName}</span>
                      <span className="text-xs font-mono text-status-info/70">ToR / Leaf</span>
                      <span className="ml-auto text-sm text-muted-foreground">
                        {swRacks.length}개 랙 · {nodeCount}개 노드
                      </span>
                    </header>

                    {/* 아래: 해당 스위치에 물린 랙 + 노드 */}
                    <div className="flex gap-4 overflow-x-auto p-4">
                      {swRacks.map(({ rack, nodes: rackNodes }) => (
                        <div key={`${switchName}::${rack}`} className="flex-shrink-0 w-56 flex flex-col gap-2">
                          {/* 랙 헤더 */}
                          <div className="flex items-center gap-2 px-2 py-1.5 bg-muted/50 rounded-md border border-border">
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
                                onDelete={n => { setDeleteError(''); setDeleteTarget(n); }}
                                onVerify={handleVerify}
                                canOperate={canOperate}
                                withHint={withHint}
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
          // D-100 — 클러스터 정보 자동입력은 첫 노드에만. 매번 채우면 두 번째 노드부터 hostname 중복(409)·메모 복제.
          clusterMeta={nodes.length === 0 ? activeCluster : null}
          initial={editTarget}
          onClose={() => { setModalOpen(false); setEditTarget(null); }}
        />
      )}

      {/* 삭제 확인 */}
      {deleteTarget && (
        <DeleteConfirm
          node={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => { setDeleteTarget(null); setDeleteError(''); }}
          isPending={deleteNode.isPending}
          error={deleteError}
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
