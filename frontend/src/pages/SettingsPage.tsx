import { useEffect, useId, useState } from 'react';
import { Settings as SettingsIcon, Server, Pencil, Trash2, Plus, Globe, ShieldCheck, Clock, AlertTriangle, Loader2, Eye, MonitorDot, Wifi, WifiOff, HelpCircle, UserPlus, UserCheck, Check, X as XIcon, Bug, HardDrive, BookOpen } from 'lucide-react';
import { BackupRestorePanel } from '@/components/settings/BackupRestorePanel';
import { OperationLevelsManager } from '@/components/settings/OperationLevelsManager';
import { ServiceCatalogManager } from '@/components/settings/ServiceCatalogManager';
import { DEBUG_PAGES, useDebugStore } from '@/stores/debugStore';
import { useClusters, useUpdateCluster, useDeleteCluster } from '@/hooks/useCluster';
import { useAssignees, useUpdateAssignees } from '@/hooks/useAssignees';
import { clustersApi, managementServersApi } from '@/services/api';
import { useClusterStore } from '@/stores/clusterStore';
import { AddClusterModal, KubeconfigEditModal } from '@/components/dashboard';
import { Cluster, ManagementServer, ManagementServerCreate, Assignee } from '@/types';
import { getStatusIcon, formatDateTime, formatApiError } from '@/lib/utils';
import { useToast, ResizeGrip, DoubleScrollX, ClusterIconPicker } from '@/components/common';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useColumnWidths } from '@/hooks/useColumnWidths';

// ── Edit Cluster Modal ──────────────────────────────────────────────────────

function EditClusterModal({
  isOpen,
  onClose,
  cluster,
}: {
  isOpen: boolean;
  onClose: () => void;
  cluster: Cluster | null;
}) {
  const [name, setName] = useState('');
  const [apiEndpoint, setApiEndpoint] = useState('');
  const [kubeconfigPath, setKubeconfigPath] = useState('');
  const [error, setError] = useState('');

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const updateCluster = useUpdateCluster();

  useEffect(() => {
    if (cluster) {
      setName(cluster.name);
      setApiEndpoint(cluster.apiEndpoint);
      setKubeconfigPath(cluster.kubeconfigPath ?? '');
    }
    setError('');
  }, [cluster, isOpen]);

  if (!isOpen || !cluster) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !apiEndpoint.trim()) {
      setError('클러스터 이름과 API Endpoint는 필수입니다.');
      return;
    }
    setError('');
    try {
      await updateCluster.mutateAsync({
        id: cluster.id,
        data: {
          name: name.trim(),
          apiEndpoint: apiEndpoint.trim(),
          kubeconfigPath: kubeconfigPath.trim() || undefined,
        },
      });
      onClose();
    } catch (err: unknown) {
      setError(formatApiError(err, '수정에 실패했습니다.'));
    }
  };

  const inputClass =
    'w-full px-3 py-2.5 bg-secondary border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-2xl mx-4 p-8 max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold tracking-tight mb-1">클러스터 수정</h2>
        <p className="text-sm text-muted-foreground mb-6">이름·API Endpoint·kubeconfig 경로만 변경됩니다. 자세한 설정은 클러스터 관리 페이지에서 가능합니다.</p>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor={f('name')} className="block text-sm font-medium text-muted-foreground mb-1.5">클러스터 이름 *</label>
            <input
              id={f('name')}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={updateCluster.isPending}
              className={inputClass}
              required
            />
          </div>
          <div>
            <label htmlFor={f('endpoint')} className="block text-sm font-medium text-muted-foreground mb-1.5">API Endpoint *</label>
            <input
              id={f('endpoint')}
              type="text"
              value={apiEndpoint}
              onChange={(e) => setApiEndpoint(e.target.value)}
              disabled={updateCluster.isPending}
              className={inputClass}
              required
            />
          </div>
          <div>
            <label htmlFor={f('kubeconfig')} className="block text-sm font-medium text-muted-foreground mb-1.5">
              Kubeconfig 파일 경로
              <span className="ml-1 text-xs text-muted-foreground/60">(내용 변경은 Kubeconfig 버튼 이용)</span>
            </label>
            <input
              id={f('kubeconfig')}
              type="text"
              value={kubeconfigPath}
              onChange={(e) => setKubeconfigPath(e.target.value)}
              disabled={updateCluster.isPending}
              placeholder="/root/.kube/config"
              className={inputClass}
            />
          </div>
          {error && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={updateCluster.isPending}
              className="px-4 py-2.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors disabled:opacity-40"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={updateCluster.isPending}
              className="px-5 py-2.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
            >
              {updateCluster.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              저장
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Management Server Modal ─────────────────────────────────────────────────

const SERVER_TYPE_OPTIONS = [
  { value: 'jump_host', label: 'Jump Host' },
  { value: 'bastion', label: 'Bastion' },
  { value: 'admin', label: '관리 서버' },
  { value: 'monitoring', label: '모니터링' },
  { value: 'cicd', label: 'CI/CD' },
];

function ManagementServerModal({
  isOpen,
  onClose,
  server,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  server: ManagementServer | null;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ManagementServerCreate>({
    name: '',
    host: '',
    port: 22,
    username: '',
    serverType: 'jump_host',
    description: '',
    region: '',
    tags: '',
    osInfo: '',
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  useEffect(() => {
    if (isOpen) {
      if (server) {
        setForm({
          name: server.name,
          host: server.host,
          port: server.port,
          username: server.username ?? '',
          serverType: server.serverType,
          description: server.description ?? '',
          region: server.region ?? '',
          tags: server.tags ?? '',
          osInfo: server.osInfo ?? '',
        });
      } else {
        setForm({ name: '', host: '', port: 22, username: '', serverType: 'jump_host', description: '', region: '', tags: '', osInfo: '' });
      }
      setError('');
    }
  }, [isOpen, server]);

  if (!isOpen) return null;

  const set = (k: keyof ManagementServerCreate, v: string | number) =>
    setForm((prev) => ({ ...prev, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !form.host.trim()) {
      setError('서버 이름과 호스트(IP)는 필수입니다.');
      return;
    }
    setError('');
    setSaving(true);
    try {
      if (server) {
        await managementServersApi.update(server.id, form);
      } else {
        await managementServersApi.create(form);
      }
      onSaved();
      onClose();
    } catch (err: unknown) {
      setError(formatApiError(err, '저장에 실패했습니다.'));
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2.5 bg-secondary border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-3xl mx-4 p-8 max-h-[90vh] overflow-y-auto">
        <h2 className="text-2xl font-bold tracking-tight mb-1">{server ? '관리서버 수정' : '관리서버 추가'}</h2>
        <p className="text-sm text-muted-foreground mb-6">SSH 접속 정보와 라벨 / 카테고리만 등록되며, 비밀번호 / 키는 DB 에 저장하지 않습니다.</p>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label htmlFor={f('name')} className="block text-sm font-medium text-muted-foreground mb-1.5">서버 이름 *</label>
              <input id={f('name')} type="text" value={form.name} onChange={(e) => set('name', e.target.value)} disabled={saving} className={inputClass} placeholder="bastion-prod-01" required />
            </div>
            <div>
              <label htmlFor={f('host')} className="block text-sm font-medium text-muted-foreground mb-1.5">호스트 / IP *</label>
              <input id={f('host')} type="text" value={form.host} onChange={(e) => set('host', e.target.value)} disabled={saving} className={inputClass} placeholder="10.0.0.1" required />
            </div>
            <div>
              <label htmlFor={f('port')} className="block text-sm font-medium text-muted-foreground mb-1.5">포트</label>
              <input id={f('port')} type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} disabled={saving} className={inputClass} min={1} max={65535} />
            </div>
            <div>
              <label htmlFor={f('username')} className="block text-sm font-medium text-muted-foreground mb-1.5">사용자명</label>
              <input id={f('username')} type="text" value={form.username} onChange={(e) => set('username', e.target.value)} disabled={saving} className={inputClass} placeholder="root" />
            </div>
            <div>
              <label htmlFor={f('serverType')} className="block text-sm font-medium text-muted-foreground mb-1.5">서버 유형</label>
              <select id={f('serverType')} value={form.serverType} onChange={(e) => set('serverType', e.target.value)} disabled={saving} className={inputClass}>
                {SERVER_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={f('region')} className="block text-sm font-medium text-muted-foreground mb-1.5">지역</label>
              <input id={f('region')} type="text" value={form.region} onChange={(e) => set('region', e.target.value)} disabled={saving} className={inputClass} placeholder="KR-Seoul" />
            </div>
            <div>
              <label htmlFor={f('osInfo')} className="block text-sm font-medium text-muted-foreground mb-1.5">OS 정보</label>
              <input id={f('osInfo')} type="text" value={form.osInfo} onChange={(e) => set('osInfo', e.target.value)} disabled={saving} className={inputClass} placeholder="Ubuntu 22.04" />
            </div>
            <div className="col-span-2">
              <label htmlFor={f('tags')} className="block text-sm font-medium text-muted-foreground mb-1.5">태그 <span className="text-xs opacity-60">(쉼표 구분)</span></label>
              <input id={f('tags')} type="text" value={form.tags} onChange={(e) => set('tags', e.target.value)} disabled={saving} className={inputClass} placeholder="prod,infra,network" />
            </div>
            <div className="col-span-2">
              <label htmlFor={f('desc')} className="block text-sm font-medium text-muted-foreground mb-1.5">설명</label>
              <textarea id={f('desc')} value={form.description} onChange={(e) => set('description', e.target.value)} disabled={saving} rows={2} className={inputClass + ' resize-none'} placeholder="서버 용도 및 설명" />
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2.5 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors disabled:opacity-40">취소</button>
            <button type="submit" disabled={saving} className="px-5 py-2.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              저장
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Server Status Badge ─────────────────────────────────────────────────────

function ServerStatusBadge({ status }: { status: string }) {
  if (status === 'online') return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
      <Wifi className="w-3 h-3" /> online
    </span>
  );
  if (status === 'offline') return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">
      <WifiOff className="w-3 h-3" /> offline
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground border border-border">
      <HelpCircle className="w-3 h-3" /> unknown
    </span>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export function SettingsPage() {
  // Cluster state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editCluster, setEditCluster] = useState<Cluster | null>(null);
  const [kubeconfigCluster, setKubeconfigCluster] = useState<Cluster | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, { ok: boolean; detail: string }>>({});
  // 클러스터 아이콘 picker — 행의 아이콘 버튼 클릭 시 anchor 좌표 보존.
  const [iconPickerCluster, setIconPickerCluster] = useState<Cluster | null>(null);
  const [iconPickerAnchor, setIconPickerAnchor] = useState<DOMRect | null>(null);
  const updateClusterMut = useUpdateCluster();

  // Assignee management state
  const { data: assignees = [] } = useAssignees();
  const updateAssignees = useUpdateAssignees();
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Assignee>({ name: '' });
  const [showAddRow, setShowAddRow] = useState(false);
  const [addForm, setAddForm] = useState<Assignee>({ name: '' });

  const assigneeColW = useColumnWidths('settings-assignee-table', {
    defaults: { empId: 100, name: 140, email: 220, ip: 150, primaryRole: 200, secondaryRole: 200, actions: 90 },
    min: 60, max: 600,
  });

  const handleSaveAssignee = (idx: number) => {
    if (!editForm.name.trim()) return;
    const updated = assignees.map((a, i) => (i === idx ? { ...editForm, name: editForm.name.trim() } : a));
    updateAssignees.mutate(updated);
    setEditingIdx(null);
  };

  const handleAddAssignee = () => {
    if (!addForm.name.trim()) return;
    if (assignees.some(a => (a.name || '') === addForm.name.trim())) return;
    updateAssignees.mutate([...assignees, { ...addForm, name: addForm.name.trim() }]);
    setAddForm({ name: '' });
    setShowAddRow(false);
  };

  const handleDeleteAssignee = (idx: number) => {
    updateAssignees.mutate(assignees.filter((_, i) => i !== idx));
    if (editingIdx === idx) setEditingIdx(null);
  };

  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditForm({ ...assignees[idx] });
    setShowAddRow(false);
  };

  // Management server state
  const [showServerModal, setShowServerModal] = useState(false);
  const [editServer, setEditServer] = useState<ManagementServer | null>(null);
  const [pingingId, setPingingId] = useState<string | null>(null);
  const [pingResults, setPingResults] = useState<Record<string, { ok: boolean; detail: string }>>({});

  const { clusters } = useClusterStore();
  useClusters();

  const queryClient = useQueryClient();

  // Management servers query
  const { data: serversData, refetch: refetchServers } = useQuery({
    queryKey: ['management-servers'],
    queryFn: () => managementServersApi.getAll(),
  });
  const servers: ManagementServer[] = serversData?.data?.data ?? [];

  const deleteServerMutation = useMutation({
    mutationFn: (id: string) => managementServersApi.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['management-servers'] }),
  });

  const deleteCluster = useDeleteCluster();
  const toast = useToast();

  const handleDelete = async (cluster: Cluster) => {
    if (
      !confirm(
        `클러스터 "${cluster.name}"을(를) 삭제하시겠습니까?\n관련 Addon, CheckLog, Playbook이 모두 삭제됩니다.`
      )
    )
      return;

    setDeletingId(cluster.id);
    try {
      await deleteCluster.mutateAsync(cluster.id);
      toast.success('클러스터 삭제됨', cluster.name);
    } catch (err: unknown) {
      toast.error('삭제 실패', formatApiError(err));
    } finally {
      setDeletingId(null);
    }
  };

  const handleVerify = async (cluster: Cluster) => {
    setVerifyingId(cluster.id);
    try {
      const res = await clustersApi.verify(cluster.id);
      const data = res.data;
      const summary = data.results
        .map((r) => {
          const detailStr = typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail ?? '');
          const label = r.check === 'api_server' ? 'API서버' : r.check === 'kubeconfig_auth' ? '인증' : '노드조회';
          const mark = r.ok === null ? '건너뜀' : r.ok ? '✓' : '✗';
          return `${label}: ${mark} ${detailStr}`;
        })
        .join(' | ');
      setVerifyResults((prev) => ({ ...prev, [cluster.id]: { ok: data.ok, detail: summary } }));
    } catch {
      setVerifyResults((prev) => ({ ...prev, [cluster.id]: { ok: false, detail: '연결 확인 실패' } }));
    } finally {
      setVerifyingId(null);
    }
  };

  const handlePing = async (server: ManagementServer) => {
    setPingingId(server.id);
    try {
      const res = await managementServersApi.ping(server.id);
      const d = res.data;
      const rawDetail = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail ?? '');
      const detail = d.latency_ms != null ? `${d.latency_ms}ms — ${rawDetail}` : rawDetail;
      setPingResults((prev) => ({ ...prev, [server.id]: { ok: d.ok, detail } }));
      await refetchServers();
    } catch {
      setPingResults((prev) => ({ ...prev, [server.id]: { ok: false, detail: '핑 요청 실패' } }));
    } finally {
      setPingingId(null);
    }
  };

  const handleDeleteServer = async (server: ManagementServer) => {
    if (!confirm(`관리서버 "${server.name}"을(를) 삭제하시겠습니까?`)) return;
    try {
      await deleteServerMutation.mutateAsync(server.id);
      toast.success('관리서버 삭제됨', server.name);
    } catch (err: unknown) {
      toast.error('삭제 실패', formatApiError(err));
    }
  };

  const statusCounts = {
    healthy: clusters.filter((c) => c.status === 'healthy').length,
    warning: clusters.filter((c) => c.status === 'warning').length,
    critical: clusters.filter((c) => c.status === 'critical').length,
  };

  const serverTypeLabelMap: Record<string, string> = {
    jump_host: 'Jump Host',
    bastion: 'Bastion',
    admin: '관리',
    monitoring: '모니터링',
    cicd: 'CI/CD',
  };

  type TabId = 'cluster' | 'server' | 'assignee' | 'operations' | 'service' | 'debug' | 'backup';
  const [activeTab, setActiveTab] = useState<TabId>('cluster');

  // Debug 설정
  const debugEnabled = useDebugStore((s) => s.enabled);
  const debugToggle  = useDebugStore((s) => s.toggle);
  const debugEventsCount = useDebugStore((s) => s.events.length);
  const debugActiveCount = Object.values(debugEnabled).filter(Boolean).length;

  const TABS: { id: TabId; label: string; icon: JSX.Element; count: number }[] = [
    { id: 'cluster', label: '클러스터', icon: <Server className="w-4 h-4" />, count: clusters.length },
    { id: 'server', label: '관리서버', icon: <MonitorDot className="w-4 h-4" />, count: servers.length },
    { id: 'assignee', label: '담당자', icon: <UserCheck className="w-4 h-4" />, count: assignees.length },
    { id: 'operations', label: '운영레벨', icon: <ShieldCheck className="w-4 h-4" />, count: 0 },
    { id: 'service', label: '서비스', icon: <BookOpen className="w-4 h-4" />, count: 0 },
    { id: 'debug', label: 'Debug', icon: <Bug className="w-4 h-4" />, count: debugActiveCount },
    { id: 'backup', label: '백업 / 복구', icon: <HardDrive className="w-4 h-4" />, count: 0 },
  ];

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-[1200px] mx-auto px-8 py-8">
        {/* Page Header + Tabs */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <SettingsIcon className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">Settings</h1>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-1 mb-6 bg-secondary/50 rounded-xl p-1 w-fit">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-card text-foreground shadow-sm border border-border'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.icon}
              {tab.label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                activeTab === tab.id ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
              }`}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        {/* Cluster Tab: Summary Cards */}
        {activeTab === 'cluster' && <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
              <Server className="w-4 h-4" />
              전체 클러스터
            </div>
            <p className="text-2xl font-bold">{clusters.length}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 text-emerald-400 text-sm mb-1">
              <ShieldCheck className="w-4 h-4" />
              Healthy
            </div>
            <p className="text-2xl font-bold text-emerald-400">{statusCounts.healthy}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 text-amber-400 text-sm mb-1">
              <Clock className="w-4 h-4" />
              Warning
            </div>
            <p className="text-2xl font-bold text-amber-400">{statusCounts.warning}</p>
          </div>
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center gap-2 text-red-400 text-sm mb-1">
              <Globe className="w-4 h-4" />
              Critical
            </div>
            <p className="text-2xl font-bold text-red-400">{statusCounts.critical}</p>
          </div>
        </div>}

        {/* 운영레벨 관리 — 별도 탭 */}
        {activeTab === 'operations' && (
          <div className="mb-8">
            <OperationLevelsManager />
          </div>
        )}

        {/* 서비스 카탈로그 — 통합지식 사이드바와 task/issue tag 의 출처 */}
        {activeTab === 'service' && (
          <div className="mb-8">
            <ServiceCatalogManager />
          </div>
        )}

        {/* Cluster List */}
        {activeTab === 'cluster' && <div className="bg-card border border-border rounded-xl mb-8">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <h2 className="font-semibold">등록된 클러스터</h2>
            <button
              onClick={() => setShowAddModal(true)}
              className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              클러스터 추가
            </button>
          </div>

          {clusters.length === 0 ? (
            <div className="text-center py-16">
              <Server className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
              <p className="text-muted-foreground mb-4">등록된 클러스터가 없습니다.</p>
              <button
                onClick={() => setShowAddModal(true)}
                className="px-4 py-2 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors"
              >
                + 첫 번째 클러스터 등록
              </button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {clusters.map((cluster) => {
                const resolved = resolveClusterIcon(cluster.icon);
                return (
                <div
                  key={cluster.id}
                  className="px-6 py-4 flex items-center gap-4 hover:bg-muted/20 transition-colors"
                >
                  {/* 아이콘 버튼 — 클릭 시 picker 노출. 미설정이면 status emoji 표시. */}
                  <button
                    type="button"
                    onClick={(e) => {
                      setIconPickerAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                      setIconPickerCluster(cluster);
                    }}
                    className="flex items-center justify-center w-10 h-10 rounded-lg border border-border bg-card hover:bg-secondary hover:ring-2 hover:ring-primary/30 transition-all flex-shrink-0"
                    title={cluster.icon ? '아이콘 변경' : '아이콘 설정 (lucide / 이모지 / 이미지 업로드)'}
                    aria-label="클러스터 아이콘 설정"
                  >
                    {resolved?.kind === 'image' ? (
                      <img src={resolved.value} alt="" className="w-7 h-7 rounded object-cover" />
                    ) : resolved?.kind === 'lucide' ? (
                      <resolved.Component className="w-5 h-5 text-foreground/80" />
                    ) : resolved?.kind === 'text' ? (
                      <span className="text-xl leading-none">{resolved.value}</span>
                    ) : (
                      <span className="text-xl leading-none" aria-hidden>
                        {getStatusIcon(cluster.status)}
                      </span>
                    )}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">{cluster.name}</span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full border ${
                          cluster.status === 'healthy'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            : cluster.status === 'warning'
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                            : cluster.status === 'critical'
                            ? 'bg-red-500/10 text-red-400 border-red-500/30'
                            : 'bg-slate-500/10 text-slate-400 border-slate-500/30'
                        }`}
                      >
                        {cluster.status === 'healthy'
                          ? '정상'
                          : cluster.status === 'warning'
                          ? '경고'
                          : cluster.status === 'critical'
                          ? '위험'
                          : '미연결'}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground flex items-center gap-4">
                      <span className="font-mono">{cluster.apiEndpoint}</span>
                      {cluster.kubeconfigPath && (
                        <span className="text-xs">kubeconfig: {cluster.kubeconfigPath}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      등록일: {formatDateTime(cluster.createdAt)}
                      {cluster.updatedAt !== cluster.createdAt && (
                        <span className="ml-4">수정일: {formatDateTime(cluster.updatedAt)}</span>
                      )}
                    </div>
                    {verifyResults[cluster.id] && (
                      <div className={`text-xs mt-1 px-2 py-1 rounded ${
                        verifyResults[cluster.id].ok
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-red-500/10 text-red-400'
                      }`}>
                        {verifyResults[cluster.id].ok ? '✓ 연결 정상' : '✗ 연결 이상'} — {verifyResults[cluster.id].detail}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleVerify(cluster)}
                      disabled={verifyingId === cluster.id}
                      className="p-2 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-primary disabled:opacity-40"
                      title="연결 확인"
                    >
                      {verifyingId === cluster.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="w-4 h-4" />
                      )}
                    </button>
                    <button
                      onClick={() => setKubeconfigCluster(cluster)}
                      className="p-2 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground"
                      title="Kubeconfig 확인/수정"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setEditCluster(cluster)}
                      className="p-2 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground"
                      title="수정"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(cluster)}
                      disabled={deletingId === cluster.id}
                      className="p-2 hover:bg-red-500/10 rounded-md transition-colors text-muted-foreground hover:text-red-400 disabled:opacity-40"
                      title="삭제"
                    >
                      {deletingId === cluster.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
                );
              })}
            </div>
          )}

          {/* 클러스터 아이콘 picker — 클러스터 관리 페이지에서 이동됨 */}
          {iconPickerCluster && (
            <ClusterIconPicker
              clusterName={iconPickerCluster.name}
              value={iconPickerCluster.icon}
              anchorRect={iconPickerAnchor}
              onChange={(next) => {
                updateClusterMut.mutate({ id: iconPickerCluster.id, data: { icon: next } });
              }}
              onClose={() => {
                setIconPickerCluster(null);
                setIconPickerAnchor(null);
              }}
            />
          )}
        </div>}

        {/* Management Server List */}
        {activeTab === 'server' && <div className="bg-card border border-border rounded-xl">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MonitorDot className="w-4 h-4 text-primary" />
              <h2 className="font-semibold">관리서버</h2>
              <span className="text-xs text-muted-foreground ml-1">Jump Host / Bastion / 관리 서버</span>
            </div>
            <button
              onClick={() => { setEditServer(null); setShowServerModal(true); }}
              className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              관리서버 추가
            </button>
          </div>

          {servers.length === 0 ? (
            <div className="text-center py-12">
              <MonitorDot className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-muted-foreground text-sm mb-4">등록된 관리서버가 없습니다.</p>
              <button
                onClick={() => { setEditServer(null); setShowServerModal(true); }}
                className="px-4 py-2 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors"
              >
                + 첫 번째 관리서버 등록
              </button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {servers.map((server) => (
                <div key={server.id} className="px-6 py-4 flex items-start gap-4 hover:bg-muted/20 transition-colors">
                  <div className="mt-0.5">
                    <MonitorDot className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-medium">{server.name}</span>
                      <ServerStatusBadge status={server.status} />
                      <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                        {serverTypeLabelMap[server.serverType] ?? server.serverType}
                      </span>
                      {server.region && (
                        <span className="text-xs text-muted-foreground">{server.region}</span>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground font-mono">
                      {server.host}:{server.port}
                      {server.username && <span className="text-xs ml-3 font-sans">user: {server.username}</span>}
                      {server.osInfo && <span className="text-xs ml-3 font-sans">{server.osInfo}</span>}
                    </div>
                    {server.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">{server.description}</p>
                    )}
                    {server.tags && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {server.tags.split(',').map((t) => t.trim()).filter(Boolean).map((tag) => (
                          <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">{tag}</span>
                        ))}
                      </div>
                    )}
                    <div className="text-xs text-muted-foreground mt-1">
                      등록일: {formatDateTime(server.createdAt)}
                      {server.lastChecked && <span className="ml-4">마지막 확인: {formatDateTime(server.lastChecked)}</span>}
                    </div>
                    {pingResults[server.id] && (
                      <div className={`text-xs mt-1 px-2 py-1 rounded ${
                        pingResults[server.id].ok ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                      }`}>
                        {pingResults[server.id].ok ? '✓ 연결 확인됨' : '✗ 연결 실패'} — {pingResults[server.id].detail}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => handlePing(server)}
                      disabled={pingingId === server.id}
                      className="p-2 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-primary disabled:opacity-40"
                      title="연결 확인 (Ping)"
                    >
                      {pingingId === server.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => { setEditServer(server); setShowServerModal(true); }}
                      className="p-2 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground"
                      title="수정"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteServer(server)}
                      disabled={deleteServerMutation.isPending}
                      className="p-2 hover:bg-red-500/10 rounded-md transition-colors text-muted-foreground hover:text-red-400 disabled:opacity-40"
                      title="삭제"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>}

        {/* Assignee Management */}
        {activeTab === 'assignee' && <div className="bg-card border border-border rounded-xl">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-primary" />
              <h2 className="font-semibold">담당자 관리</h2>
              <span className="text-xs text-muted-foreground ml-1">작업/이슈 등록 시 자동완성 · 행 클릭으로 바로 수정</span>
            </div>
            <button
              onClick={() => { setShowAddRow(true); setEditingIdx(null); setAddForm({ name: '' }); }}
              className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
            >
              <UserPlus className="w-4 h-4" />
              담당자 추가
            </button>
          </div>

          <DoubleScrollX>
            <table className="text-sm" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
              <colgroup>
                {(['empId', 'name', 'email', 'ip', 'primaryRole', 'secondaryRole', 'actions'] as const).map((k) => (
                  <col key={k} style={{ width: `${assigneeColW.getWidth(k)}px` }} />
                ))}
              </colgroup>
              <thead>
                <tr className="bg-secondary/40 border-b border-border text-xs text-muted-foreground">
                  <th className="relative text-left px-4 py-3 font-medium">사번
                    <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('empId', e)} onDoubleClick={() => assigneeColW.autoFit('empId')} />
                  </th>
                  <th className="relative text-left px-4 py-3 font-medium">이름 *
                    <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('name', e)} onDoubleClick={() => assigneeColW.autoFit('name')} />
                  </th>
                  <th className="relative text-left px-4 py-3 font-medium">이메일
                    <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('email', e)} onDoubleClick={() => assigneeColW.autoFit('email')} />
                  </th>
                  <th className="relative text-left px-4 py-3 font-medium">IP 주소
                    <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('ip', e)} onDoubleClick={() => assigneeColW.autoFit('ip')} />
                  </th>
                  <th className="relative text-left px-4 py-3 font-medium">정 담당역할
                    <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('primaryRole', e)} onDoubleClick={() => assigneeColW.autoFit('primaryRole')} />
                  </th>
                  <th className="relative text-left px-4 py-3 font-medium">부담당 역할
                    <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('secondaryRole', e)} onDoubleClick={() => assigneeColW.autoFit('secondaryRole')} />
                  </th>
                  <th className="relative px-3 py-3">
                    <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('actions', e)} onDoubleClick={() => assigneeColW.autoFit('actions')} />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {assignees.map((a, idx) => {
                  const isEditing = editingIdx === idx;
                  const cellInput = (field: keyof Assignee, placeholder: string, required?: boolean) => (
                    <input
                      type="text"
                      value={(editForm[field] as string) ?? ''}
                      onChange={(e) => setEditForm((f) => ({ ...f, [field]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAssignee(idx); if (e.key === 'Escape') setEditingIdx(null); }}
                      placeholder={placeholder}
                      required={required}
                      className="w-full px-2 py-1 bg-background border border-primary/40 rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                      autoFocus={field === 'name'}
                    />
                  );
                  return (
                    <tr
                      key={idx}
                      onClick={() => !isEditing && startEdit(idx)}
                      className={`transition-colors ${isEditing ? 'bg-primary/5' : 'hover:bg-muted/30 cursor-pointer'}`}
                    >
                      <td className="px-4 py-2.5">
                        {isEditing ? cellInput('employeeId', 'EMP001') : (
                          <span className="text-muted-foreground font-mono text-xs">{a.employeeId || '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {isEditing ? cellInput('name', '이름', true) : (
                          <div className="flex items-center gap-2">
                            <span className="w-7 h-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-xs font-bold flex-shrink-0">
                              {(a.name || '?').charAt(0).toUpperCase()}
                            </span>
                            <span className="font-medium">{a.name || '(이름없음)'}</span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {isEditing ? cellInput('email', 'user@company.com') : (
                          <span className="text-muted-foreground">{a.email || '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {isEditing ? cellInput('ip', '10.0.0.1') : (
                          <span className="font-mono text-xs text-muted-foreground">{a.ip || '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {isEditing ? cellInput('primaryRole', 'Backend Engineer') : (
                          a.primaryRole
                            ? <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">{a.primaryRole}</span>
                            : <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {isEditing ? cellInput('secondaryRole', 'DevOps') : (
                          a.secondaryRole
                            ? <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">{a.secondaryRole}</span>
                            : <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {isEditing ? (
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button onClick={() => handleSaveAssignee(idx)} disabled={!editForm.name.trim()} title="저장"
                              className="p-1.5 rounded bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-40">
                              <Check className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setEditingIdx(null)} title="취소"
                              className="p-1.5 rounded hover:bg-secondary text-muted-foreground transition-colors">
                              <XIcon className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                            <button onClick={() => handleDeleteAssignee(idx)} title="삭제"
                              className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {/* Add new row */}
                {showAddRow && (
                  <tr className="bg-emerald-500/5 border-t-2 border-emerald-500/30">
                    {(['employeeId', 'name', 'email', 'ip', 'primaryRole', 'secondaryRole'] as (keyof Assignee)[]).map((field) => (
                      <td key={field} className="px-4 py-2.5">
                        <input
                          type="text"
                          value={(addForm[field] as string) ?? ''}
                          onChange={(e) => setAddForm((f) => ({ ...f, [field]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleAddAssignee(); if (e.key === 'Escape') setShowAddRow(false); }}
                          placeholder={field === 'employeeId' ? 'EMP001' : field === 'name' ? '이름 *' : field === 'email' ? 'user@co.kr' : field === 'ip' ? '10.0.0.1' : field === 'primaryRole' ? '정 담당역할' : '부담당 역할'}
                          autoFocus={field === 'name'}
                          className="w-full px-2 py-1 bg-background border border-emerald-500/40 rounded text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                        />
                      </td>
                    ))}
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1">
                        <button onClick={handleAddAssignee} disabled={!addForm.name.trim()} title="추가"
                          className="p-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 transition-colors disabled:opacity-40">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setShowAddRow(false)} title="취소"
                          className="p-1.5 rounded hover:bg-secondary text-muted-foreground transition-colors">
                          <XIcon className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )}

                {assignees.length === 0 && !showAddRow && (
                  <tr>
                    <td colSpan={7} className="text-center py-10 text-muted-foreground text-sm">
                      등록된 담당자가 없습니다. "담당자 추가" 버튼을 클릭하세요.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </DoubleScrollX>
        </div>}

        {/* Debug 탭: 대시보드 별 상세 로그 토글 */}
        {activeTab === 'debug' && (
          <div className="bg-card border border-border rounded-xl p-6 space-y-5">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0">
                <Bug className="w-5 h-5 text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold text-base">Debug 모드</h2>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  각 대시보드의 상세 실행 로그를 표시합니다. "전역"을 켜면 모든 API 호출
                  (요청/응답/에러)이 debug 패널에 기록되며, 개별 페이지 토글을 켜면 해당
                  페이지에 로그 패널이 나타납니다. 현재 {debugEventsCount}개 이벤트가
                  버퍼에 있습니다.
                </p>
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {DEBUG_PAGES.map((p) => {
                  const on = !!debugEnabled[p.key];
                  return (
                    <label key={p.key}
                      className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                        on ? 'border-amber-500/40 bg-amber-500/5' : 'border-border hover:bg-muted/30'
                      }`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {p.label}
                          {p.key === 'global' && (
                            <span className="ml-1.5 text-[10px] text-muted-foreground font-normal">
                              (axios interceptor)
                            </span>
                          )}
                        </p>
                        <p className="text-[11px] text-muted-foreground font-mono">{p.key}</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => debugToggle(p.key)}
                        aria-label={p.label}
                        className="w-4 h-4 accent-amber-500"
                      />
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-border pt-4 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">팁</p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>"전역" 만 켜도 브라우저 콘솔에 모든 API 호출이 기록됩니다.</li>
                <li>페이지 토글만 켜면 해당 페이지에 DebugLogPanel 이 상단에 표시됩니다.</li>
                <li>설정은 브라우저 localStorage 에 저장되며 새로고침 후에도 유지됩니다.</li>
              </ul>
            </div>
          </div>
        )}

        {/* Backup / Restore 탭 */}
        {activeTab === 'backup' && <BackupRestorePanel />}
      </main>

      {/* Add Cluster Modal */}
      <AddClusterModal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
      />

      {/* Edit Cluster Modal */}
      <EditClusterModal
        isOpen={!!editCluster}
        onClose={() => setEditCluster(null)}
        cluster={editCluster}
      />

      {/* Kubeconfig View / Edit Modal */}
      {kubeconfigCluster && (
        <KubeconfigEditModal
          clusterId={kubeconfigCluster.id}
          clusterName={kubeconfigCluster.name}
          isOpen={!!kubeconfigCluster}
          onClose={() => setKubeconfigCluster(null)}
        />
      )}

      {/* Management Server Add / Edit Modal */}
      <ManagementServerModal
        isOpen={showServerModal}
        onClose={() => { setShowServerModal(false); setEditServer(null); }}
        server={editServer}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['management-servers'] })}
      />
    </div>
  );
}
