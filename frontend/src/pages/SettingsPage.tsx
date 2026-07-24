import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings as SettingsIcon, Server, Pencil, Trash2, Plus, Globe, ShieldCheck, Clock, AlertTriangle, Loader2, Eye, MonitorDot, Wifi, WifiOff, HelpCircle, UserCheck, Bug, HardDrive, BookOpen, Database, ListTodo, Palette, FileSearch, Wand2, Boxes } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { BackupRestorePanel } from '@/components/settings/BackupRestorePanel';
import { FeatureAccessManager } from '@/components/settings/FeatureAccessManager';
import { JiraIntegrationPanel } from '@/components/settings/JiraIntegrationPanel';
import { OperationLevelsManager } from '@/components/settings/OperationLevelsManager';
import { ServiceCatalogManager } from '@/components/settings/ServiceCatalogManager';
import { LakeServiceTypeManager } from '@/components/settings/LakeServiceTypeManager';
import { ServiceCategoryManager } from '@/components/settings/ServiceCategoryManager';
import { NavMenuManager } from '@/components/settings/NavMenuManager';
import { PageStyleManager } from '@/components/settings/PageStyleManager';
import { TerminalAppearanceSettings } from '@/components/settings/TerminalAppearanceSettings';
import { AssigneeManager } from '@/components/settings/AssigneeManager';
import { AuditLogManager } from '@/components/settings/AuditLogManager';
import { DEBUG_PAGES, useDebugStore } from '@/stores/debugStore';
import { useClusters, useUpdateCluster, useDeleteCluster } from '@/hooks/useCluster';
import { useAssignees } from '@/hooks/useAssignees';
import { useUiSettings, useUpdateUiSettings } from '@/hooks/useUiSettings';
import { clustersApi, managementServersApi } from '@/services/api';
import { useClusterStore } from '@/stores/clusterStore';
import { AddClusterModal, KubeconfigEditModal } from '@/components/dashboard';
import { Cluster, ManagementServer, ManagementServerCreate } from '@/types';
import { getStatusIcon, formatDateTime, formatApiError } from '@/lib/utils';
import { useHomeStore } from '@/stores/homeStore';
import { useToast, ClusterIconPicker } from '@/components/common';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import {
  buildClusterIconSvg, svgToDataUrl, suggestInitials, suggestRegionAbbr,
  suggestAttribute, suggestOpTypeLabel,
} from '@/lib/clusterIconBuilder';
import { useOperationLevels, levelColor, levelLabel, levelCustomHex } from '@/hooks/useOperationLevels';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

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
              <span className="ml-1 text-sm text-muted-foreground/60">(내용 변경은 Kubeconfig 버튼 이용)</span>
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
              <label htmlFor={f('tags')} className="block text-sm font-medium text-muted-foreground mb-1.5">태그 <span className="text-sm opacity-60">(쉼표 구분)</span></label>
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
    <span className="inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
      <Wifi className="w-3 h-3" /> online
    </span>
  );
  if (status === 'offline') return (
    <span className="inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">
      <WifiOff className="w-3 h-3" /> offline
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground border border-border">
      <HelpCircle className="w-3 h-3" /> unknown
    </span>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────

export function SettingsPage() {
  const toast = useToast();
  // 업무 현황 스케줄 배경 (흰색/크림) — 사용자별 설정.
  const scheduleBg = useHomeStore((s) => s.scheduleBg);
  const setScheduleBg = useHomeStore((s) => s.setScheduleBg);
  const weeklyBarOpacity = useHomeStore((s) => s.weeklyBarOpacity);
  const setWeeklyBarOpacity = useHomeStore((s) => s.setWeeklyBarOpacity);
  const weeklyBarTextColor = useHomeStore((s) => s.weeklyBarTextColor);
  const setWeeklyBarTextColor = useHomeStore((s) => s.setWeeklyBarTextColor);
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
  const { data: opLevels } = useOperationLevels();
  const [bulkGenBusy, setBulkGenBusy] = useState(false);

  // 홈 버튼 아이콘 커스터마이즈 (업무/플랫폼 모드별).
  const { data: uiSettings } = useUiSettings();
  const updateUiSettings = useUpdateUiSettings();
  const [homeIconPickerMode, setHomeIconPickerMode] = useState<null | 'work' | 'platform'>(null);
  const [homeIconAnchor, setHomeIconAnchor] = useState<DOMRect | null>(null);

  const saveHomeIcon = (target: 'work' | 'platform', next: string | null) => {
    // work/platform 전체를 항상 함께 전송해 다른 모드 값이 초기화되지 않도록.
    updateUiSettings.mutate({
      homeIcons: {
        work: target === 'work' ? next : (uiSettings?.homeIcons?.work ?? null),
        platform: target === 'platform' ? next : (uiSettings?.homeIcons?.platform ?? null),
      },
    });
  };

  const renderHomeIconPreview = (target: 'work' | 'platform', iconStr?: string | null) => {
    const resolved = resolveClusterIcon(iconStr);
    if (resolved?.kind === 'lucide') { const IconC = resolved.Component; return <IconC className="w-5 h-5" />; }
    if (resolved?.kind === 'image') return <img src={resolved.value} alt="" className="w-6 h-6 object-contain rounded-sm" />;
    if (resolved?.kind === 'text') return <span className="text-base leading-none">{resolved.value}</span>;
    // 미설정 → 기본값 (업무=ListTodo, 플랫폼=☸)
    return target === 'platform'
      ? <span className="text-base leading-none">☸</span>
      : <ListTodo className="w-5 h-5" />;
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

  /** 아이콘이 비어있는 클러스터에 빌더 아이콘(이니셜+환경색+지역) 일괄 생성.
   *  이미 아이콘이 설정된 클러스터는 절대 덮어쓰지 않는다. */
  const handleBulkGenerateIcons = async () => {
    const targets = clusters.filter((c) => !c.icon);
    if (targets.length === 0) {
      toast.info('대상 없음', '모든 클러스터에 이미 아이콘이 설정되어 있습니다.');
      return;
    }
    if (!window.confirm(`아이콘이 없는 클러스터 ${targets.length}개에 빌더 아이콘(이니셜+환경색+지역)을 자동 생성할까요?\n(기존에 설정된 아이콘은 변경되지 않습니다)`)) {
      return;
    }
    setBulkGenBusy(true);
    let ok = 0;
    let fail = 0;
    for (const c of targets) {
      try {
        const svg = buildClusterIconSvg({
          workName: suggestInitials(c.name),
          opTypeLabel: suggestOpTypeLabel(levelLabel(opLevels, c.operationLevel)),
          attribute: suggestAttribute(c.name),
          regionAbbr: suggestRegionAbbr(c.region),
          colorToken: levelColor(opLevels, c.operationLevel),
          customHex: levelCustomHex(opLevels, c.operationLevel),
        });
        await updateClusterMut.mutateAsync({ id: c.id, data: { icon: svgToDataUrl(svg) } });
        ok++;
      } catch {
        fail++;
      }
    }
    setBulkGenBusy(false);
    if (fail === 0) toast.success('아이콘 일괄 생성 완료', `${ok}개 생성`);
    else toast.warning('아이콘 일괄 생성 부분 완료', `${ok}개 성공 · ${fail}개 실패`);
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

  type TabId = 'cluster' | 'server' | 'assignee' | 'operations' | 'service' | 'mgmt-service' | 'service-categories' | 'access' | 'debug' | 'backup' | 'jira' | 'screen-ui' | 'audit-log';
  const [searchParams] = useSearchParams();
  const initialTab = (searchParams.get('tab') as TabId | null);
  const [activeTab, setActiveTab] = useState<TabId>(initialTab ?? 'cluster');

  // Debug 설정
  const debugEnabled = useDebugStore((s) => s.enabled);
  const debugToggle  = useDebugStore((s) => s.toggle);
  const debugEventsCount = useDebugStore((s) => s.events.length);
  const debugActiveCount = Object.values(debugEnabled).filter(Boolean).length;

  const { data: assignees = [] } = useAssignees();

  const TABS: { id: TabId; label: string; icon: JSX.Element; count: number }[] = [
    { id: 'cluster', label: '클러스터', icon: <Server className="w-4 h-4" />, count: clusters.length },
    { id: 'server', label: '관리서버', icon: <MonitorDot className="w-4 h-4" />, count: servers.length },
    { id: 'assignee', label: '담당자', icon: <UserCheck className="w-4 h-4" />, count: assignees.length },
    { id: 'operations', label: '운영레벨', icon: <ShieldCheck className="w-4 h-4" />, count: 0 },
    { id: 'service', label: 'PEP 서비스', icon: <BookOpen className="w-4 h-4" />, count: 0 },
    { id: 'mgmt-service', label: '관리 서비스', icon: <Database className="w-4 h-4" />, count: 0 },
    { id: 'service-categories', label: '서비스 카테고리', icon: <Boxes className="w-4 h-4" />, count: 0 },
    { id: 'screen-ui', label: '화면 UI 설정', icon: <Palette className="w-4 h-4" />, count: 0 },
    { id: 'access', label: '접근 제어', icon: <ShieldCheck className="w-4 h-4" />, count: 0 },
    { id: 'jira', label: '연동 (Jira)', icon: <Globe className="w-4 h-4" />, count: 0 },
    { id: 'debug', label: 'Debug', icon: <Bug className="w-4 h-4" />, count: debugActiveCount },
    { id: 'backup', label: '백업 / 복구', icon: <HardDrive className="w-4 h-4" />, count: 0 },
    { id: 'audit-log', label: '감사 로그', icon: <FileSearch className="w-4 h-4" />, count: 0 },
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
              <span className={`text-sm px-1.5 py-0.5 rounded-full ${
                activeTab === tab.id ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
              }`}>
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        {/* ── 화면 UI 설정 탭 ── */}
        {activeTab === 'screen-ui' && (
        <div className="space-y-6 mb-6">
        {/* 홈 화면 설정 */}
        <MacCard title="홈 화면 설정" bodyPadding="p-0">
          <p className="px-4 py-2 text-xs text-muted-foreground border-b border-border">PEP 홈 페이지 표시 옵션</p>
          <div className="px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm">업무 모드에서 클러스터 필터 표시</p>
              <p className="text-xs text-muted-foreground">업무 현황을 특정 클러스터로 필터링</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-1.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground rounded">
                추후 지원
              </span>
              <button
                type="button"
                disabled
                className="relative w-9 h-5 rounded-full bg-muted border border-border opacity-50 cursor-not-allowed"
                aria-label="추후 지원 예정"
              >
                <span className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform" />
              </button>
            </div>
          </div>

          {/* 홈 버튼 아이콘 커스터마이즈 — 좌측 상단 홈 버튼(업무/플랫폼 모드 전환) */}
          {([
            { mode: 'work' as const, label: '업무 현황 홈 아이콘', hint: '좌측 상단 홈 버튼 · 업무 모드 (기본: 목록 아이콘)' },
            { mode: 'platform' as const, label: '플랫폼 현황 홈 아이콘', hint: '좌측 상단 홈 버튼 · 플랫폼 모드 (기본: ☸ 톱니)' },
          ]).map(({ mode, label, hint }) => (
            <div key={mode} className="px-4 py-3 flex items-center justify-between border-t border-border">
              <div>
                <p className="text-sm">{label}</p>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  setHomeIconPickerMode(mode);
                  setHomeIconAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                }}
                className="flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-lg border border-border bg-secondary hover:bg-secondary/70 transition-colors"
                title="클릭하여 아이콘 변경"
              >
                <span className="w-7 h-7 rounded-md bg-gradient-to-br from-primary to-sky-700 text-white flex items-center justify-center flex-shrink-0">
                  {renderHomeIconPreview(mode, uiSettings?.homeIcons?.[mode])}
                </span>
                <span className="text-sm text-muted-foreground">변경</span>
                <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          ))}

          {/* 스케줄 배경 — 당일 스케줄 · 담당자별 진행현황 패널 배경 (흰색/크림) */}
          <div className="px-4 py-3 flex items-center justify-between border-t border-border">
            <div>
              <p className="text-sm">스케줄 배경색</p>
              <p className="text-xs text-muted-foreground">업무 현황의 당일 스케줄 · 담당자별 진행현황 패널 배경 (다크 모드 제외)</p>
            </div>
            <div className="flex items-center rounded-lg border border-border overflow-hidden text-sm">
              {([
                { key: 'white' as const, label: '흰색', swatch: '#ffffff' },
                { key: 'cream' as const, label: '크림', swatch: '#FBF7EE' },
              ]).map(({ key, label, swatch }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setScheduleBg(key)}
                  aria-pressed={scheduleBg === key}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 transition-colors ${key === 'cream' ? 'border-l border-border' : ''} ${
                    scheduleBg === key ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'
                  }`}
                >
                  <span className="w-3 h-3 rounded-full border border-border/70" style={{ backgroundColor: swatch }} />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 담당자별 진행 현황(주간) 스윔레인 상태 막대 — 배경 투명도 + 글자색 */}
          <div className="px-4 py-3 flex items-center justify-between border-t border-border">
            <div>
              <p className="text-sm">담당자별 진행 현황(주간) 막대 투명도</p>
              <p className="text-xs text-muted-foreground">스윔레인 상태 막대(완료/진행중/검토/Todo/Backlog)의 배경 색 투명도</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                value={weeklyBarOpacity}
                onChange={(e) => setWeeklyBarOpacity(Number(e.target.value))}
                aria-label="주간 스윔레인 막대 투명도"
                className="w-32 accent-primary"
              />
              <span className="w-10 text-xs text-muted-foreground text-right font-mono">{weeklyBarOpacity}%</span>
            </div>
          </div>
          <div className="px-4 py-3 flex items-center justify-between border-t border-border">
            <div>
              <p className="text-sm">위 막대 안 글자색</p>
              <p className="text-xs text-muted-foreground">막대 배경이 연해지면 기본 흰 글씨가 묻힐 수 있어 직접 지정 가능</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={weeklyBarTextColor}
                onChange={(e) => setWeeklyBarTextColor(e.target.value)}
                aria-label="주간 스윔레인 막대 글자색"
                className="w-9 h-7 rounded-md border border-border cursor-pointer bg-transparent p-0.5"
              />
              <span className="text-xs text-muted-foreground font-mono">{weeklyBarTextColor}</span>
              <button
                type="button"
                onClick={() => setWeeklyBarTextColor('#ffffff')}
                className="text-xs text-primary hover:underline"
              >
                기본값
              </button>
            </div>
          </div>
        </MacCard>

          {/* 메뉴 이름 편집 (사이드바에서 이동) */}
          <NavMenuManager />

          {/* 페이지별 화면 스타일 — 폰트/크기/글자색/배경색 */}
          <PageStyleManager />

          {/* 터미널/로그 화면 색상 — mc 등 모든 로그 출력 화면 Appearance */}
          <TerminalAppearanceSettings />
        </div>
        )}

        {/* 홈 아이콘 picker — 탭과 무관하게 동작 */}
        {homeIconPickerMode && (
          <ClusterIconPicker
            title={homeIconPickerMode === 'work' ? '업무 현황 홈 아이콘' : '플랫폼 현황 홈 아이콘'}
            value={uiSettings?.homeIcons?.[homeIconPickerMode] ?? null}
            anchorRect={homeIconAnchor}
            onChange={(next) => saveHomeIcon(homeIconPickerMode, next)}
            onClose={() => {
              setHomeIconPickerMode(null);
              setHomeIconAnchor(null);
            }}
          />
        )}

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

        {/* 관리 서비스(LAKE 서비스 타입) 카탈로그 — lake-service-type-management PDCA.
            Settings 탭명은 "관리 서비스" — "LAKE" 는 PEP 서비스에 일반적인 개념이 아니라 탭 라벨에서 제외. */}
        {activeTab === 'mgmt-service' && (
          <div className="mb-8">
            <LakeServiceTypeManager />
          </div>
        )}

        {/* PEP/APP 서비스 상위 카테고리 — service-category-catalog PDCA */}
        {activeTab === 'service-categories' && (
          <div className="mb-8">
            <ServiceCategoryManager />
          </div>
        )}

        {/* Cluster List */}
        {activeTab === 'cluster' && <MacCard rootClassName="mb-8" bodyPadding="p-0">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-semibold">등록된 클러스터</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={handleBulkGenerateIcons}
                disabled={bulkGenBusy}
                title="아이콘이 비어있는 클러스터에 이니셜+환경색+지역 조합 아이콘을 자동 생성 (기존 아이콘은 유지)"
                className="px-3 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {bulkGenBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                아이콘 일괄 생성
              </button>
              <button
                onClick={() => setShowAddModal(true)}
                className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                클러스터 추가
              </button>
            </div>
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
                        className={`text-sm px-2 py-0.5 rounded-full border ${
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
                        <span className="text-sm">kubeconfig: {cluster.kubeconfigPath}</span>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      등록일: {formatDateTime(cluster.createdAt)}
                      {cluster.updatedAt !== cluster.createdAt && (
                        <span className="ml-4">수정일: {formatDateTime(cluster.updatedAt)}</span>
                      )}
                    </div>
                    {verifyResults[cluster.id] && (
                      <div className={`text-sm mt-1 px-2 py-1 rounded ${
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
                      aria-label="연결 확인"
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
                      aria-label="Kubeconfig 확인/수정"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setEditCluster(cluster)}
                      className="p-2 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground"
                      title="수정"
                      aria-label="수정"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(cluster)}
                      disabled={deletingId === cluster.id}
                      className="p-2 hover:bg-red-500/10 rounded-md transition-colors text-muted-foreground hover:text-red-400 disabled:opacity-40"
                      title="삭제"
                      aria-label="삭제"
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
              builderContext={{
                name: iconPickerCluster.name,
                region: iconPickerCluster.region,
                operationLevel: iconPickerCluster.operationLevel,
              }}
              onChange={(next) => {
                updateClusterMut.mutate({ id: iconPickerCluster.id, data: { icon: next } });
              }}
              onClose={() => {
                setIconPickerCluster(null);
                setIconPickerAnchor(null);
              }}
            />
          )}
        </MacCard>}

        {/* Management Server List */}
        {activeTab === 'server' && <MacCard bodyPadding="p-0">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MonitorDot className="w-4 h-4 text-primary" />
              <h2 className="font-semibold">관리서버</h2>
              <span className="text-sm text-muted-foreground ml-1">Jump Host / Bastion / 관리 서버</span>
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
                      <span className="text-sm px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                        {serverTypeLabelMap[server.serverType] ?? server.serverType}
                      </span>
                      {server.region && (
                        <span className="text-sm text-muted-foreground">{server.region}</span>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground font-mono">
                      {server.host}:{server.port}
                      {server.username && <span className="text-sm ml-3 font-sans">user: {server.username}</span>}
                      {server.osInfo && <span className="text-sm ml-3 font-sans">{server.osInfo}</span>}
                    </div>
                    {server.description && (
                      <p className="text-sm text-muted-foreground mt-0.5">{server.description}</p>
                    )}
                    {server.tags && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {server.tags.split(',').map((t) => t.trim()).filter(Boolean).map((tag) => (
                          <span key={tag} className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">{tag}</span>
                        ))}
                      </div>
                    )}
                    <div className="text-sm text-muted-foreground mt-1">
                      등록일: {formatDateTime(server.createdAt)}
                      {server.lastChecked && <span className="ml-4">마지막 확인: {formatDateTime(server.lastChecked)}</span>}
                    </div>
                    {pingResults[server.id] && (
                      <div className={`text-sm mt-1 px-2 py-1 rounded ${
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
                      aria-label="연결 확인 (Ping)"
                    >
                      {pingingId === server.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
                    </button>
                    <button
                      onClick={() => { setEditServer(server); setShowServerModal(true); }}
                      className="p-2 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground"
                      title="수정"
                      aria-label="수정"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDeleteServer(server)}
                      disabled={deleteServerMutation.isPending}
                      className="p-2 hover:bg-red-500/10 rounded-md transition-colors text-muted-foreground hover:text-red-400 disabled:opacity-40"
                      title="삭제"
                      aria-label="삭제"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </MacCard>}

        {/* 담당자 관리 */}
        {activeTab === 'assignee' && <AssigneeManager />}

        {/* Debug 탭: 대시보드 별 상세 로그 토글 */}
        {activeTab === 'debug' && (
          <MacCard title="Debug 모드" bodyPadding="p-6" className="space-y-5">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0">
                <Bug className="w-5 h-5 text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-muted-foreground leading-relaxed">
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
                            <span className="ml-1.5 text-xs text-muted-foreground font-normal">
                              (axios interceptor)
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground font-mono">{p.key}</p>
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

            <div className="border-t border-border pt-4 text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">팁</p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>"전역" 만 켜도 브라우저 콘솔에 모든 API 호출이 기록됩니다.</li>
                <li>페이지 토글만 켜면 해당 페이지에 DebugLogPanel 이 상단에 표시됩니다.</li>
                <li>설정은 브라우저 localStorage 에 저장되며 새로고침 후에도 유지됩니다.</li>
              </ul>
            </div>
          </MacCard>
        )}

        {/* Backup / Restore 탭 */}
        {activeTab === 'access' && <FeatureAccessManager />}

        {activeTab === 'backup' && <BackupRestorePanel />}

        {activeTab === 'jira' && <JiraIntegrationPanel />}

        {activeTab === 'audit-log' && <AuditLogManager />}
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
