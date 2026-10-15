import { useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Settings as SettingsIcon, Server, Pencil, Trash2, Plus, Globe, ShieldCheck, AlertTriangle, Loader2, Eye, MonitorDot, Wifi, WifiOff, HelpCircle, UserCheck, Bug, HardDrive, DatabaseZap, Boxes, Layers, Lock, Home, Palette, FileSearch, Wand2, Bot, Ticket, Users, CheckCircle2, XCircle, Check, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { BackupRestorePanel } from '@/components/settings/BackupRestorePanel';
import { TenantManager } from '@/components/settings/TenantManager';
import { SchemaHealthPanel } from '@/components/settings/SchemaHealthPanel';
import { FeatureAccessManager } from '@/components/settings/FeatureAccessManager';
import { ClusterViewerMaskSetting } from '@/components/settings/ClusterViewerMaskSetting';
import { ClusterEndpointAllowlistSetting } from '@/components/settings/ClusterEndpointAllowlistSetting';
import { JiraIntegrationPanel } from '@/components/settings/JiraIntegrationPanel';
import { ServiceNowIntegrationPanel } from '@/components/settings/ServiceNowIntegrationPanel';
import { OperationLevelsManager } from '@/components/settings/OperationLevelsManager';
import { LakeServiceTypeManager } from '@/components/settings/LakeServiceTypeManager';
import { ServiceCategoryManager } from '@/components/settings/ServiceCategoryManager';
import { NavMenuManager } from '@/components/settings/NavMenuManager';
import { DefaultAppsManager } from '@/components/settings/DefaultAppsManager';
import { PageStyleManager } from '@/components/settings/PageStyleManager';
import { ThemeGallery } from '@/components/settings/ThemeGallery';
import { TerminalAppearanceSettings } from '@/components/settings/TerminalAppearanceSettings';
import { AssigneeManager } from '@/components/settings/AssigneeManager';
import { AuditLogManager } from '@/components/settings/AuditLogManager';
import { LlmSettingsTab } from '@/components/settings/LlmSettingsTab';
import { DEBUG_PAGES, useDebugStore } from '@/stores/debugStore';
import { useClusters, useUpdateCluster, useDeleteCluster } from '@/hooks/useCluster';
import { useAssignees } from '@/hooks/useAssignees';
import { useUiSettings, useUpdateUiSettings } from '@/hooks/useUiSettings';
import { managementServersApi } from '@/services/api';
import { useClusterStore } from '@/stores/clusterStore';
import { AddClusterModal, KubeconfigEditModal } from '@/components/dashboard';
import { Cluster, ManagementServer, ManagementServerCreate, ServiceDomain } from '@/types';
import { formatDateTime, formatApiError, cn } from '@/lib/utils';
import { StatusDot, statusToVariant } from '@/components/common/StatusBadge';
import { useHomeStore } from '@/stores/homeStore';
import { useHomePrefs, useUpdateHomePrefs } from '@/hooks/useHomePrefs';
import { useToast, ClusterIconPicker, useModalA11y, EmptyState, PageHeader, PageShell, RunLogPanel, ConfirmDialog } from '@/components/common';
import { verifyClusterLogged } from '@/components/cluster-manage';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import {
  buildClusterIconSvg, svgToDataUrl, suggestInitials, suggestRegionAbbr,
  suggestAttribute,
} from '@/lib/clusterIconBuilder';
import { useOperationLevels, levelColor, levelCustomHex } from '@/hooks/useOperationLevels';
import { useClusterIconSrc } from '@/hooks/useClusterIconSrc';
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

  const dialogRef = useModalA11y(isOpen, onClose);

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
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={f('title')} className="relative bg-card border border-border rounded-md shadow-2xl w-full max-w-2xl mx-4 p-8 max-h-[90vh] overflow-y-auto">
        <h2 id={f('title')} className="text-2xl font-bold tracking-tight mb-1">클러스터 수정</h2>
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
              <span className="ml-1 text-sm text-muted-foreground">(내용 변경은 Kubeconfig 버튼 이용)</span>
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
            <div className="flex items-start gap-2 px-3 py-2.5 bg-status-critical/10 border border-status-critical/20 rounded-lg text-sm text-status-critical">
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

  const dialogRef = useModalA11y(isOpen, onClose);

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
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={f('title')} className="relative bg-card border border-border rounded-md shadow-2xl w-full max-w-3xl mx-4 p-8 max-h-[90vh] overflow-y-auto">
        <h2 id={f('title')} className="text-2xl font-bold tracking-tight mb-1">{server ? '관리서버 수정' : '관리서버 추가'}</h2>
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
            <div className="flex items-start gap-2 px-3 py-2.5 bg-status-critical/10 border border-status-critical/20 rounded-lg text-sm text-status-critical">
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
    <span className="inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
      <Wifi className="w-3 h-3" /> 온라인
    </span>
  );
  if (status === 'offline') return (
    <span className="inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full bg-status-critical/10 text-status-critical border border-status-critical/30">
      <WifiOff className="w-3 h-3" /> 오프라인
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full bg-muted/50 text-muted-foreground border border-border">
      <HelpCircle className="w-3 h-3" /> 미확인
    </span>
  );
}

/** 클러스터 목록 행의 아이콘 버튼 — `useClusterIconSrc` 훅을 써야 해서(테마 동기화)
 *  `clusters.map()` 콜백 안에서 직접 훅을 호출할 수 없어 별도 컴포넌트로 분리했다. */
function ClusterIconButton({ cluster, onClick }: { cluster: Cluster; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  const resolved = useClusterIconSrc(cluster);
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center w-10 h-10 rounded-lg border border-border bg-card hover:bg-secondary hover:border-primary/40 transition-colors flex-shrink-0"
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
        <StatusDot variant={statusToVariant(cluster.status)} className="w-2.5 h-2.5" />
      )}
    </button>
  );
}

// ── 설정 메뉴 구성 (D-130) ──────────────────────────────────────────────────
// 탭 id 는 외부 딥링크(`/settings?tab=…` — App.tsx `/settings/users`→assignee,
// ClusterManagePage → cluster)가 쓰므로 바꾸지 않는다. 그룹·순서·라벨만 여기서 정한다.

type TabId = 'cluster' | 'server' | 'assignee' | 'operations' | 'mgmt-service' | 'access' | 'tenant' | 'debug' | 'backup' | 'jira' | 'servicenow' | 'screen-ui' | 'audit-log' | 'schema' | 'ai-llm';

const TAB_GROUPS: { label: string; tabs: { id: TabId; label: string; icon: LucideIcon }[] }[] = [
  {
    label: '클러스터·서버',
    tabs: [
      { id: 'cluster', label: '클러스터', icon: Server },
      { id: 'server', label: '관리서버', icon: MonitorDot },
      { id: 'operations', label: '운영레벨', icon: Layers },
      { id: 'mgmt-service', label: '관리 서비스', icon: Boxes },
    ],
  },
  {
    label: '사용자·접근',
    tabs: [
      { id: 'assignee', label: '시스템 담당자', icon: UserCheck },
      { id: 'access', label: '접근 제어', icon: Lock },
      { id: 'tenant', label: '테넌트', icon: Users },
    ],
  },
  {
    label: '연동',
    tabs: [
      { id: 'jira', label: 'Jira 연동', icon: Globe },
      { id: 'servicenow', label: 'ServiceNow 연동', icon: Ticket },
      { id: 'ai-llm', label: 'AI·LLM', icon: Bot },
    ],
  },
  {
    label: '시스템',
    tabs: [
      { id: 'screen-ui', label: '화면 UI 설정', icon: Palette },
      { id: 'backup', label: '백업 / 복구', icon: HardDrive },
      { id: 'audit-log', label: '감사 로그', icon: FileSearch },
      { id: 'schema', label: '스키마 점검', icon: DatabaseZap },
      { id: 'debug', label: '디버그', icon: Bug },
    ],
  },
];

const TAB_IDS = new Set<string>(TAB_GROUPS.flatMap((g) => g.tabs.map((t) => t.id)));

// 레거시 딥링크 호환: 최상위 "서비스"(service) 탭과 "서비스 카테고리"(service-categories)
// 탭은 "관리 서비스"(mgmt-service) 로 통합됐다 → 둘 다 mgmt-service 로 리다이렉트.
const LEGACY_MGMT_TABS = ['service', 'service-categories'];

/** `?tab=` 값 → 유효한 탭. 레거시 값은 mgmt-service, 알 수 없는 값·미지정은 cluster. */
function resolveTab(raw: string | null): TabId {
  if (raw && LEGACY_MGMT_TABS.includes(raw)) return 'mgmt-service';
  if (raw && TAB_IDS.has(raw)) return raw as TabId;
  return 'cluster';
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
  // 기본 홈 탭 — 서버 저장(user_settings.home_prefs), 기기/브라우저를 넘어 따라온다.
  const { data: homePrefs } = useHomePrefs();
  const updateHomePrefs = useUpdateHomePrefs();
  // Cluster state
  const [showAddModal, setShowAddModal] = useState(false);
  const [editCluster, setEditCluster] = useState<Cluster | null>(null);
  const [kubeconfigCluster, setKubeconfigCluster] = useState<Cluster | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Record<string, {
    ok: boolean;
    status?: string;
    statusReason?: string | null;
    checks: { check: string; ok: boolean | null; detail: string }[];
  }>>({});
  // 클러스터 아이콘 picker — 행의 아이콘 버튼 클릭 시 anchor 좌표 보존.
  const [iconPickerCluster, setIconPickerCluster] = useState<Cluster | null>(null);
  const [iconPickerAnchor, setIconPickerAnchor] = useState<DOMRect | null>(null);
  const updateClusterMut = useUpdateCluster();
  const { data: opLevels } = useOperationLevels();
  const [bulkGenBusy, setBulkGenBusy] = useState(false);
  const [bulkIconConfirmOpen, setBulkIconConfirmOpen] = useState(false);
  // 실행 로그 — 클러스터 탭(연결 확인·아이콘 일괄 생성)과 관리서버 탭(Ping)이 각자 하나씩(D-135).
  const clusterRunLog = useRunLog();
  const [showClusterLog, setShowClusterLog] = useLogPref('settings-cluster');
  const serverRunLog = useRunLog();
  const [showServerLog, setShowServerLog] = useLogPref('settings-server');

  // 홈 버튼 아이콘 커스터마이즈 (업무/플랫폼 모드별).
  const { data: uiSettings } = useUiSettings();
  const updateUiSettings = useUpdateUiSettings();
  const [homeIconPickerOpen, setHomeIconPickerOpen] = useState(false);
  const [homeIconAnchor, setHomeIconAnchor] = useState<DOMRect | null>(null);

  // 홈 버튼은 이제 work/platform 구분 없이 하나뿐이다(모드 폐지) — `homeIcons` 스키마는
  // 하위 호환을 위해 그대로 두되 두 키에 항상 같은 값을 함께 저장한다.
  const saveHomeIcon = (next: string | null) => {
    updateUiSettings.mutate({ homeIcons: { work: next, platform: next } });
  };

  const renderHomeIconPreview = (iconStr?: string | null) => {
    const resolved = resolveClusterIcon(iconStr);
    if (resolved?.kind === 'lucide') { const IconC = resolved.Component; return <IconC className="w-5 h-5" />; }
    if (resolved?.kind === 'image') return <img src={resolved.value} alt="" className="w-6 h-6 object-contain rounded-sm" />;
    if (resolved?.kind === 'text') return <span className="text-base leading-none">{resolved.value}</span>;
    return <Home className="w-5 h-5" />;
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
        `클러스터 "${cluster.name}"을(를) 삭제하시겠습니까?\n` +
          '점검 결과·이벤트·스냅샷·Addon·Playbook·배치잡 등 이 클러스터에 속한 데이터가 모두 삭제됩니다.\n' +
          '업무(Work Item)와 서비스 카탈로그는 삭제되지 않고 클러스터 연결만 해제됩니다.'
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

  // 연결 확인 — SSE(/verify/stream)로 단계(API server → kubeconfig 인증 → kubectl)를 실행 로그에 실시간으로 남기고,
  // 끝나면 체크별 결과를 행 아래 인라인으로도 보존한다(클러스터 관리 화면과 같은 verifyClusterLogged).
  const handleVerify = async (cluster: Cluster) => {
    setVerifyingId(cluster.id);
    try {
      const r = await verifyClusterLogged(clusterRunLog, cluster);
      if (r.ok) {
        const data = r.data;
        // 체크별 결과를 그대로 보존 — "healthz OK / kubeconfig 없음" 같은 모순을
        // 한 줄 요약으로 뭉개지 않고 행 단위로 보여주기 위함.
        setVerifyResults((prev) => ({
          ...prev,
          [cluster.id]: {
            ok: data.ok,
            status: data.status,
            statusReason: data.statusReason,
            checks: (data.results ?? []).map((c) => ({
              check: c.check,
              ok: c.ok,
              detail: typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail ?? ''),
            })),
          },
        }));
      } else if (!r.aborted) {
        const reason = r.error instanceof Error ? r.error.message : formatApiError(r.error);
        setVerifyResults((prev) => ({
          ...prev,
          [cluster.id]: { ok: false, checks: [{ check: 'api_server', ok: false, detail: `연결 확인 실패 — ${reason}` }] },
        }));
      }
    } finally {
      setVerifyingId(null);
      // 서버가 cluster.status 를 갱신했을 수 있으니 목록을 다시 읽는다.
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
    }
  };

  /** 아이콘이 비어있는 클러스터에 빌더 아이콘(이니셜+환경색+지역) 일괄 생성.
   *  이미 아이콘이 설정된 클러스터는 절대 덮어쓰지 않는다. */
  const iconTargets = clusters.filter((c) => !c.icon);
  const handleBulkGenerateIcons = () => {
    if (iconTargets.length === 0) {
      toast.info('대상 없음', '모든 클러스터에 이미 아이콘이 설정되어 있습니다.');
      return;
    }
    setBulkIconConfirmOpen(true);
  };

  // 클러스터마다 PUT /clusters/{id} 를 클라이언트에서 순회한다 — 대상별 단계 칩·결과 줄을 남기고
  // 한 클러스터 실패가 나머지를 멈추지 않는다(실패 클러스터명·사유가 로그에 남는다).
  const executeBulkGenerateIcons = async () => {
    setBulkIconConfirmOpen(false);
    const targets = clusters.filter((c) => !c.icon);
    if (targets.length === 0) return;
    setBulkGenBusy(true);
    const r = await runLogged(clusterRunLog, {
      title: '아이콘 일괄 생성',
      first: `아이콘이 없는 클러스터 ${targets.length}개에 빌더 아이콘 생성 — 기존 아이콘은 변경하지 않음`,
      heartbeatMs: 0,
      fn: async () => {
        let ok = 0;
        let fail = 0;
        for (const c of targets) {
          clusterRunLog.setStep(c.id, c.name, 'running');
          try {
            const workName = suggestInitials(c.name);
            const attribute = suggestAttribute(c.name);
            const regionAbbr = suggestRegionAbbr(c.region);
            const level = c.operationLevel ?? '';
            const svg = buildClusterIconSvg({
              workName,
              attribute,
              regionAbbr,
              colorToken: levelColor(opLevels, level),
              customHex: levelCustomHex(opLevels, level),
            });
            // colorMode: 'theme' — 뷰어의 활성 테마에 맞춰 색이 매번 다시 계산된다(테마 동기화).
            // icon 은 최초 저장 시점 스냅샷(iconConfig 미지원 소비처를 위한 폴백)일 뿐이다.
            await updateClusterMut.mutateAsync({
              id: c.id,
              data: {
                icon: svgToDataUrl(svg),
                iconConfig: { workName, attribute, regionAbbr, shape: 'square', watermark: true, level, colorMode: 'theme' },
              },
            });
            ok++;
            clusterRunLog.setStep(c.id, c.name, 'done');
            clusterRunLog.log('info', `${c.name} 생성 완료 — ${workName}${attribute ? ` · ${attribute}` : ''}${regionAbbr ? ` · ${regionAbbr}` : ''}`);
          } catch (e) {
            fail++;
            clusterRunLog.setStep(c.id, c.name, 'failed');
            clusterRunLog.log('error', `${c.name} 실패 — ${formatApiError(e)}`);
          }
        }
        return { ok, fail };
      },
      summarize: (res): RunLogEntry[] => [[res.fail ? 'warn' : 'info', `성공 ${res.ok} · 실패 ${res.fail} · 대상 ${targets.length}`]],
    });
    setBulkGenBusy(false);
    if (!r.ok) {
      toast.error('아이콘 일괄 생성 실패', formatApiError(r.error));
      return;
    }
    if (r.data.fail === 0) toast.success('아이콘 일괄 생성됨', `${r.data.ok}개 생성`);
    else toast.warning('아이콘 일괄 생성 부분 완료', `${r.data.ok}개 성공 · ${r.data.fail}개 실패 — 사유는 실행 로그`);
  };

  const handlePing = async (server: ManagementServer) => {
    setPingingId(server.id);
    // 응답은 axios 인터셉터가 camelCase 로 바꾼다(서버 latency_ms → latencyMs).
    const latencyOf = (d: { latencyMs?: number | null }) => d.latencyMs ?? null;
    const detailOf = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
    try {
      const r = await runLogged(serverRunLog, {
        title: `연결 확인 — ${server.name}`,
        first: `${server.name} (${server.host}:${server.port}) 연결 확인 요청`,
        fn: () => managementServersApi.ping(server.id).then((res) => res.data),
        summarize: (d): RunLogEntry[] => {
          const latency = latencyOf(d);
          return [[
            d.ok ? 'info' : 'error',
            `${server.name} ${d.ok ? '연결 확인됨' : '연결 실패'}${latency != null ? ` · 지연 ${latency}ms` : ''} — ${detailOf(d.detail)}`,
          ]];
        },
      });
      if (r.ok) {
        const d = r.data;
        const latency = latencyOf(d);
        const rawDetail = detailOf(d.detail);
        const detail = latency != null ? `${latency}ms — ${rawDetail}` : rawDetail;
        setPingResults((prev) => ({ ...prev, [server.id]: { ok: d.ok, detail } }));
        await refetchServers();
      } else {
        setPingResults((prev) => ({ ...prev, [server.id]: { ok: false, detail: `핑 요청 실패 — ${formatApiError(r.error)}` } }));
      }
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

  const serverTypeLabelMap: Record<string, string> = {
    jump_host: 'Jump Host',
    bastion: 'Bastion',
    admin: '관리',
    monitoring: '모니터링',
    cicd: 'CI/CD',
  };

  // 활성 탭은 URL(`?tab=`)이 원천 — 새로고침·링크 공유·뒤로가기에서 같은 탭이 열린다.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const setActiveTab = (tab: TabId) => setSearchParams({ tab }, { replace: true });
  // "관리 서비스" 탭 내부 서브탭 — PEP 서비스 / APP 서비스 도메인 구분. 각 서브탭은
  // 해당 도메인의 카테고리 + 서비스 타입을 한 화면에서 관리한다.
  const [mgmtDomain, setMgmtDomain] = useState<ServiceDomain>('pep');
  // 디버그 설정
  const debugEnabled = useDebugStore((s) => s.enabled);
  const debugToggle  = useDebugStore((s) => s.toggle);
  const debugEventsCount = useDebugStore((s) => s.events.length);
  const debugActiveCount = Object.values(debugEnabled).filter(Boolean).length;

  const { data: assignees = [] } = useAssignees();

  // 카운트는 실제 값이 있는 메뉴만 — 0 이면 숨긴다(D-130).
  const TAB_COUNTS: Partial<Record<TabId, number>> = {
    cluster: clusters.length,
    server: servers.length,
    assignee: assignees.length,
    debug: debugActiveCount,
  };

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="hub">
        <PageHeader className="mb-6" icon={SettingsIcon} title="설정" />

        <div className="flex flex-col md:flex-row gap-6 md:gap-8">
        {/* 설정 메뉴 — 4그룹 세로 목록, 좁은 화면에서는 위쪽 가로 스크롤 목록 */}
        <nav
          aria-label="설정 메뉴"
          className="md:w-48 shrink-0 flex md:flex-col gap-4 md:gap-5 overflow-x-auto md:overflow-visible pb-1 md:pb-0 md:sticky md:top-4 md:self-start"
        >
          {TAB_GROUPS.map((group) => (
            <div key={group.label} className="flex md:flex-col items-center md:items-stretch gap-0.5 shrink-0">
              <p className="px-2.5 md:pb-1 text-xs font-medium text-muted-foreground whitespace-nowrap">{group.label}</p>
              {group.tabs.map((tab) => {
                const active = activeTab === tab.id;
                const count = TAB_COUNTS[tab.id] ?? 0;
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 px-2.5 py-1.5 rounded-xl text-sm text-left whitespace-nowrap transition-colors',
                      active
                        ? 'bg-secondary text-foreground font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60',
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" aria-hidden />
                    <span className="flex-1">{tab.label}</span>
                    {count > 0 && (
                      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="flex-1 min-w-0">
        {/* ── 화면 UI 설정 탭 ── */}
        {activeTab === 'screen-ui' && (
        <div className="space-y-6 mb-6">
        {/* 홈 화면 설정 */}
        <MacCard title="홈 화면 설정" description="PEP 홈 페이지 표시 옵션" bodyPadding="p-0">
          {/* 홈 버튼 아이콘 커스터마이즈 — 좌측 상단 홈 버튼(홈으로 이동 전용, 모드 폐지) */}
          <div className="px-4 py-3 flex items-center justify-between">
            <div>
              <p className="text-sm">홈 아이콘</p>
              <p className="text-xs text-muted-foreground">좌측 상단 홈 버튼 (기본: 홈 아이콘)</p>
            </div>
            <button
              type="button"
              onClick={(e) => {
                setHomeIconPickerOpen(true);
                setHomeIconAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
              }}
              className="flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-lg border border-border bg-secondary hover:bg-secondary/70 transition-colors"
              title="클릭하여 아이콘 변경"
            >
              <span className="w-7 h-7 rounded-md bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0">
                {renderHomeIconPreview(uiSettings?.homeIcons?.work)}
              </span>
              <span className="text-sm text-muted-foreground">변경</span>
              <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>

          {/* 기본 홈 탭 — 로그인 시 홈(/) 에서 처음 보여줄 탭. user_settings.home_prefs 에 저장돼
              기기/브라우저를 넘어 따라온다(D-056 연장). */}
          <div className="px-4 py-3 flex items-center justify-between border-t border-border">
            <div>
              <p className="text-sm">기본 홈 탭</p>
              <p className="text-xs text-muted-foreground">로그인 시 홈 화면에서 먼저 보여줄 탭</p>
            </div>
            <div className="flex items-center rounded-lg border border-border overflow-hidden text-sm">
              {([
                { key: 'work' as const, label: '업무 현황' },
                { key: 'platform' as const, label: '플랫폼 현황' },
              ]).map(({ key, label }, idx) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => updateHomePrefs.mutate({ defaultHomeTab: key })}
                  aria-pressed={homePrefs?.defaultHomeTab === key}
                  className={cn(
                    'px-2.5 py-1.5 transition-colors',
                    idx > 0 && 'border-l border-border',
                    homePrefs?.defaultHomeTab === key
                      ? 'bg-primary text-primary-foreground'
                      : 'hover:bg-secondary text-muted-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

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

          {/* 테마 갤러리 — 10종을 한 화면에서 비교·선택 (D-072) */}
          <ThemeGallery />

          {/* 메뉴 이름 편집 (사이드바에서 이동) */}
          <NavMenuManager />

          {/* 사이드바·상단바 조직 기본 앱 구성 — 개인화 안 한 계정에 적용 */}
          <DefaultAppsManager />

          {/* 페이지별 화면 스타일 — 폰트/크기/글자색/배경색 */}
          <PageStyleManager />

          {/* 터미널/로그 화면 색상 — mc 등 모든 로그 출력 화면 Appearance */}
          <TerminalAppearanceSettings />
        </div>
        )}

        {/* 홈 아이콘 picker */}
        {homeIconPickerOpen && (
          <ClusterIconPicker
            title="홈 아이콘"
            value={uiSettings?.homeIcons?.work ?? null}
            anchorRect={homeIconAnchor}
            onChange={(next) => saveHomeIcon(next)}
            onClose={() => {
              setHomeIconPickerOpen(false);
              setHomeIconAnchor(null);
            }}
          />
        )}

        {/* 운영레벨 관리 — 별도 탭 */}
        {activeTab === 'operations' && (
          <div className="mb-8">
            <OperationLevelsManager />
          </div>
        )}

        {/* 관리 서비스 — PEP 서비스 / APP 서비스 도메인 서브탭 2개. 각 서브탭 안에서 해당
            도메인의 상위 카테고리와 서비스 타입을 함께 관리한다. 구 "서비스 카테고리" 최상위
            탭과 구 "서비스 카탈로그" 서브탭(ui_settings.serviceCatalog)이 여기로 통합됐다 —
            /services 지식 카탈로그와 업무 태그도 PEP 서비스 타입의 아이콘/색상을 쓴다. */}
        {activeTab === 'mgmt-service' && (
          <div className="mb-8 space-y-4">
            <div className="inline-flex items-center gap-1 rounded-xl border border-border bg-muted/30 p-1">
              {([
                { id: 'pep', label: 'PEP 서비스' },
                { id: 'app', label: 'APP 서비스' },
              ] as const).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setMgmtDomain(v.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    mgmtDomain === v.id ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <ServiceCategoryManager domain={mgmtDomain} />
            <LakeServiceTypeManager domain={mgmtDomain} />
          </div>
        )}

        {/* Cluster List */}
        {activeTab === 'cluster' && <MacCard
          rootClassName="mb-8"
          bodyPadding="p-0"
          title="등록된 클러스터"
          icon={Server}
          titleExtra={clusters.length > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{clusters.length}개</span> : undefined}
          actions={
            <>
              <button
                type="button"
                onClick={handleBulkGenerateIcons}
                disabled={bulkGenBusy}
                title="아이콘이 비어있는 클러스터에 이니셜+환경색+지역 조합 아이콘을 자동 생성 (기존 아이콘은 유지)"
                className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {bulkGenBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                아이콘 일괄 생성
              </button>
              <button
                type="button"
                onClick={() => setShowAddModal(true)}
                className="px-3 py-1.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                클러스터 추가
              </button>
            </>
          }
        >

          {(clusterRunLog.running || clusterRunLog.lines.length > 0) && (
            <div className="px-4 py-3 border-b border-border">
              <RunLogPanel run={clusterRunLog} show={showClusterLog} onShowChange={setShowClusterLog} maxHeight="max-h-56" />
            </div>
          )}

          {clusters.length === 0 ? (
            <EmptyState
              icon={Server}
              title="등록된 클러스터가 없습니다."
              description="클러스터를 등록하면 점검·운영 화면에서 바로 쓸 수 있습니다."
              action={{ label: '첫 번째 클러스터 등록', onClick: () => setShowAddModal(true) }}
            />
          ) : (
            <div className="divide-y divide-border">
              {clusters.map((cluster) => {
                return (
                <div
                  key={cluster.id}
                  className="px-4 py-4 flex items-center gap-4 hover:bg-muted/20 transition-colors"
                >
                  {/* 아이콘 버튼 — 클릭 시 picker 노출. 미설정이면 status emoji 표시.
                      아이콘 빌더로 만든 아이콘(iconConfig 있음)은 현재 테마로 매번 다시 렌더된다. */}
                  <ClusterIconButton
                    cluster={cluster}
                    onClick={(e) => {
                      setIconPickerAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                      setIconPickerCluster(cluster);
                    }}
                  />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium">{cluster.name}</span>
                      <span
                        className={`text-sm px-2 py-0.5 rounded-full border ${
                          cluster.status === 'healthy'
                            ? 'bg-secondary text-muted-foreground border-border'
                            : cluster.status === 'warning'
                            ? 'bg-status-warning/10 text-status-warning border-status-warning/30'
                            : cluster.status === 'critical'
                            ? 'bg-status-critical/10 text-status-critical border-status-critical/30'
                            : 'bg-status-unknown/10 text-status-unknown border-status-unknown/30'
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
                    {verifyResults[cluster.id] && (() => {
                      const vr = verifyResults[cluster.id];
                      const tone = vr.ok
                        ? 'bg-status-healthy/10 text-status-healthy'
                        : vr.status === 'warning'
                          ? 'bg-status-warning/10 text-status-warning'
                          : 'bg-status-critical/10 text-status-critical';
                      const headline = vr.ok
                        ? '연결 정상'
                        : vr.status === 'warning'
                          ? '부분 이상 — API 는 도달하지만 kubeconfig 기반 기능(배치잡/점검)이 실패할 상태'
                          : '연결 이상';
                      const HeadIcon = vr.ok ? CheckCircle2 : vr.status === 'warning' ? AlertTriangle : XCircle;
                      const CHECK_LABEL: Record<string, string> = {
                        api_server: 'API 서버 (/healthz)',
                        kubeconfig_auth: 'kubeconfig 인증',
                        kubectl_nodes: 'kubectl 노드 조회',
                      };
                      return (
                        <div className={`text-sm mt-1 px-2 py-1.5 rounded ${tone}`}>
                          <div className="font-medium flex items-center gap-1.5"><HeadIcon className="w-3.5 h-3.5 flex-shrink-0" />{headline}</div>
                          <ul className="mt-1 space-y-0.5">
                            {vr.checks.map((c) => (
                              <li key={c.check} className="flex items-start gap-1.5 text-xs">
                                <span className="flex-shrink-0 mt-0.5">
                                  {c.ok === true ? <Check className="w-3 h-3" aria-label="통과" /> : c.ok === false ? <X className="w-3 h-3" aria-label="실패" /> : '—'}
                                </span>
                                <span className="flex-shrink-0 font-medium">{CHECK_LABEL[c.check] ?? c.check}</span>
                                <span className="min-w-0 opacity-80 break-all">{c.detail}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      );
                    })()}
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
                      className="p-2 hover:bg-status-critical/10 rounded-md transition-colors text-muted-foreground hover:text-status-critical disabled:opacity-40"
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
                iconConfig: iconPickerCluster.iconConfig,
              }}
              onChange={(next, iconConfig) => {
                updateClusterMut.mutate({ id: iconPickerCluster.id, data: { icon: next, iconConfig: iconConfig ?? null } });
              }}
              onClose={() => {
                setIconPickerCluster(null);
                setIconPickerAnchor(null);
              }}
            />
          )}
        </MacCard>}

        {/* 아이콘 일괄 생성 확인 — 대상·범위를 보여주고 실행(진행·실패 사유는 위 실행 로그) */}
        <ConfirmDialog
          open={bulkIconConfirmOpen}
          title="아이콘 일괄 생성"
          description={`아이콘이 없는 클러스터 ${iconTargets.length}개에 빌더 아이콘(이니셜+환경색+지역)을 자동 생성합니다.`}
          confirmLabel={`${iconTargets.length}개 생성`}
          onConfirm={executeBulkGenerateIcons}
          onCancel={() => setBulkIconConfirmOpen(false)}
        >
          <div className="space-y-1 text-muted-foreground">
            <p>기존에 설정된 아이콘은 변경되지 않습니다.</p>
            <p className="text-xs">
              대상: {iconTargets.slice(0, 8).map((c) => c.name).join(', ')}
              {iconTargets.length > 8 && ` 외 ${iconTargets.length - 8}개`}
            </p>
          </div>
        </ConfirmDialog>

        {/* Management Server List */}
        {activeTab === 'server' && <MacCard
          bodyPadding="p-0"
          title="관리서버"
          icon={MonitorDot}
          titleExtra={servers.length > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{servers.length}대</span> : undefined}
          description="Jump Host · Bastion · 관리 서버"
          actions={
            <button
              type="button"
              onClick={() => { setEditServer(null); setShowServerModal(true); }}
              className="px-3 py-1.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              관리서버 추가
            </button>
          }
        >

          {(serverRunLog.running || serverRunLog.lines.length > 0) && (
            <div className="px-4 py-3 border-b border-border">
              <RunLogPanel run={serverRunLog} show={showServerLog} onShowChange={setShowServerLog} maxHeight="max-h-56" />
            </div>
          )}

          {servers.length === 0 ? (
            <EmptyState
              icon={MonitorDot}
              title="등록된 관리서버가 없습니다."
              description="관리서버를 등록하면 연결 상태를 확인하고 원격 작업에 사용할 수 있습니다."
              action={{ label: '첫 번째 관리서버 등록', variant: 'secondary', onClick: () => { setEditServer(null); setShowServerModal(true); } }}
            />
          ) : (
            <div className="divide-y divide-border">
              {servers.map((server) => (
                <div key={server.id} className="px-4 py-4 flex items-start gap-4 hover:bg-muted/20 transition-colors">
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
                      <div className={`text-sm mt-1 px-2 py-1 rounded flex items-center gap-1.5 ${
                        pingResults[server.id].ok ? 'bg-status-healthy/10 text-status-healthy' : 'bg-status-critical/10 text-status-critical'
                      }`}>
                        {pingResults[server.id].ok
                          ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                          : <XCircle className="w-3.5 h-3.5 flex-shrink-0" />}
                        <span>{pingResults[server.id].ok ? '연결 확인됨' : '연결 실패'} — {pingResults[server.id].detail}</span>
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
                      className="p-2 hover:bg-status-critical/10 rounded-md transition-colors text-muted-foreground hover:text-status-critical disabled:opacity-40"
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

        {/* 시스템 담당자 — 담당자 명부와 로그인 계정이 users 테이블 한 곳에 합쳐져 있어
            (모델 docstring 참고) 더 이상 서브탭으로 나눌 필요가 없다. 구 사이드바 독립
            "사용자 관리" 페이지도 여기로 통합됐다. */}
        {activeTab === 'assignee' && <AssigneeManager />}

        {/* 디버그 탭: 대시보드 별 상세 로그 토글 */}
        {activeTab === 'debug' && (
          <MacCard title="디버그 모드" icon={Bug} bodyPadding="p-5" className="space-y-5">
            <p className="text-sm text-muted-foreground leading-relaxed">
              각 대시보드의 상세 실행 로그를 표시합니다. "전역"을 켜면 모든 API 호출
              (요청/응답/오류)이 디버그 패널에 기록되며, 개별 페이지 토글을 켜면 해당
              페이지에 로그 패널이 나타납니다. 현재 <span className="tabular-nums">{debugEventsCount}</span>개 이벤트가
              버퍼에 있습니다.
            </p>

            <div className="border-t border-border pt-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {DEBUG_PAGES.map((p) => {
                  const on = !!debugEnabled[p.key];
                  return (
                    <label key={p.key}
                      className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                        on ? 'border-status-warning/40 bg-status-warning/5' : 'border-border hover:bg-muted/30'
                      }`}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {p.label}
                          {p.key === 'global' && (
                            <span className="ml-1.5 text-xs text-muted-foreground font-normal">
                              (모든 API 요청)
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
                        className="w-4 h-4 accent-status-warning"
                      />
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-border pt-4 text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">디버그 사용 팁</p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>"전역" 만 켜도 브라우저 콘솔에 모든 API 호출이 기록됩니다.</li>
                <li>페이지 토글만 켜면 해당 페이지 상단에 디버그 로그 패널이 표시됩니다.</li>
                <li>설정은 이 브라우저에 저장되며 새로고침 후에도 유지됩니다.</li>
              </ul>
            </div>
          </MacCard>
        )}

        {/* 접근 제어 탭 — 기능 접근 권한 · viewer 네트워크 정보 마스킹 · API 엔드포인트 허용 대역 */}
        {activeTab === 'access' && (
          <div className="space-y-4">
            <FeatureAccessManager />
            <ClusterViewerMaskSetting />
            <ClusterEndpointAllowlistSetting />
          </div>
        )}
        {activeTab === 'tenant' && <TenantManager />}

        {activeTab === 'backup' && <BackupRestorePanel />}
        {activeTab === 'schema' && <SchemaHealthPanel />}
        {activeTab === 'ai-llm' && <LlmSettingsTab />}

        {activeTab === 'jira' && <JiraIntegrationPanel />}
        {activeTab === 'servicenow' && <ServiceNowIntegrationPanel />}

        {activeTab === 'audit-log' && <AuditLogManager />}
        </div>
        </div>
      </PageShell>

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
