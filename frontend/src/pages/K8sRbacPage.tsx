/**
 * K8S 접근 권한 (`/k8s-rbac`)
 *
 * 개발자가 자기 LOCAL 의 kubectl 로 클러스터에 붙어 **배포하고 로그를 보는** 데 필요한
 * ServiceAccount · 권한 · 바인딩 · kubeconfig 한 세트를 만들고 편집·회수하는 화면.
 * 배포는 보통 자기 네임스페이스 기준이지만 다른 네임스페이스도 필요할 때가 있어서,
 * 발급 마법사가 주 네임스페이스 + 추가 네임스페이스를 함께 받는다.
 */
import { useMemo, useState } from 'react';
import { KeyRound, Link2, Shield, ShieldCheck, Wand2 } from 'lucide-react';
import { ClusterSidebar } from '@/components/common';
import {
  AccessReviewPanel,
  BindingPanel,
  ProvisionConsole,
  ProvisionWizard,
  RolePanel,
  ServiceAccountPanel,
  type RbacRoleFocusRequest,
} from '@/components/k8s-rbac';
import { useClusters } from '@/hooks/useCluster';
import {
  useProvisionStream,
  useRbacBindings,
  useRbacClusterRoles,
  useRbacNamespaces,
  useRbacPresets,
  useRbacRoles,
  useRbacServiceAccounts,
} from '@/hooks/useK8sRbac';
import type { RbacBindingSummary } from '@/types';

type TabKey = 'wizard' | 'sa' | 'roles' | 'bindings' | 'review';

const TABS: { key: TabKey; label: string; icon: typeof Wand2 }[] = [
  { key: 'wizard', label: '액세스 발급', icon: Wand2 },
  { key: 'sa', label: 'ServiceAccount', icon: KeyRound },
  { key: 'roles', label: 'Role / ClusterRole', icon: Shield },
  { key: 'bindings', label: 'Binding', icon: Link2 },
  { key: 'review', label: '권한 점검', icon: ShieldCheck },
];

export function K8sRbacPage() {
  const { data: clusters = [] } = useClusters();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('wizard');
  const [includeSystem, setIncludeSystem] = useState(false);
  // 실행 로그를 펼쳐 볼지 — 로그는 항상 수집하고 표시 여부만 사용자가 정한다.
  const [showLogs, setShowLogs] = useState(true);
  // ServiceAccount 탭의 "연결된 권한" 클릭 → Role/ClusterRole 탭으로 이동해 그 롤을 연다.
  const [roleFocus, setRoleFocus] = useState<RbacRoleFocusRequest | null>(null);

  const clusterId = selectedClusterId ?? clusters[0]?.id ?? '';
  const cluster = useMemo(() => clusters.find((c) => c.id === clusterId), [clusters, clusterId]);

  const { data: catalog } = useRbacPresets(clusterId);
  const { data: namespaces = [] } = useRbacNamespaces(clusterId);
  const { data: serviceAccounts = [], isLoading: saLoading } = useRbacServiceAccounts(clusterId);
  const { data: roles = [], isLoading: rolesLoading } = useRbacRoles(clusterId);
  const { data: clusterRoles = [] } = useRbacClusterRoles(clusterId, includeSystem);
  const { data: bindings = [], isLoading: bindingsLoading } = useRbacBindings(
    clusterId,
    undefined,
    includeSystem,
  );

  const stream = useProvisionStream(clusterId);

  // ClusterRole 은 롤 자체가 클러스터 스코프라 namespace 를 null 로 찾아야 하고, Role 은
  // 바인딩과 같은 네임스페이스에 있어야 한다는 K8s 규칙을 그대로 따른다. 참조 대상이
  // 빌트인(system:*, view/edit/cluster-admin 등)이라 지금 목록에 없을 수도 있어 —
  // includeSystem 이 꺼진 채면 미리 켜서 RolePanel 이 재조회 없이 바로 찾게 한다.
  const handleSelectRole = (b: RbacBindingSummary) => {
    const scope: 'namespace' | 'cluster' = b.roleKind === 'ClusterRole' ? 'cluster' : 'namespace';
    const namespace = scope === 'cluster' ? null : b.namespace;
    if (scope === 'cluster' && !includeSystem && !clusterRoles.some((r) => r.name === b.roleName)) {
      setIncludeSystem(true);
    }
    setRoleFocus({ scope, namespace, name: b.roleName, token: Date.now() });
    setTab('roles');
  };

  return (
    <div className="app-min-h-screen bg-background">
      <main className="pr-3 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => setSelectedClusterId(id)}
          iconOnly
        />

        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Shield className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold">K8S 접근 권한</h1>
            <span className="text-sm text-muted-foreground">
              — <span className="font-medium text-foreground">{cluster?.name ?? '-'}</span>
              {namespaces.length > 0 && (
                <span className="ml-2">네임스페이스 {namespaces.length}</span>
              )}
            </span>
            <div className="flex-1" />
            <button
              type="button"
              role="switch"
              aria-checked={showLogs}
              onClick={() => setShowLogs(!showLogs)}
              title={showLogs ? '실행 로그 접기' : '실행 로그 펼치기'}
              aria-label="실행 로그 보기 전환"
              className="inline-flex items-center gap-2 text-sm text-foreground"
            >
              <span
                className={`w-9 h-5 shrink-0 rounded-full border relative transition-colors ${
                  showLogs ? 'bg-primary border-primary' : 'bg-secondary border-border'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-card shadow-sm transition-transform ${
                    showLogs ? 'translate-x-4' : ''
                  }`}
                />
              </span>
              로그 보기
            </button>
          </div>

          <div className="flex gap-1 flex-wrap border-b border-border" role="tablist">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                title={label}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-t-lg border-b-2 -mb-px ${
                  tab === key
                    ? 'border-primary text-primary font-semibold'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>

          {!clusterId ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              왼쪽에서 클러스터를 고르세요.
            </div>
          ) : tab === 'wizard' ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
              <ProvisionWizard
                catalog={catalog}
                namespaces={namespaces}
                running={stream.running}
                onRun={stream.start}
              />
              <div className="xl:sticky xl:top-3">
                <ProvisionConsole stream={stream} showLogs={showLogs} />
              </div>
            </div>
          ) : tab === 'sa' ? (
            <ServiceAccountPanel
              clusterId={clusterId}
              serviceAccounts={serviceAccounts}
              namespaces={namespaces}
              isLoading={saLoading}
              onSelectRole={handleSelectRole}
            />
          ) : tab === 'roles' ? (
            <RolePanel
              clusterId={clusterId}
              roles={roles}
              clusterRoles={clusterRoles}
              bindings={bindings}
              includeSystem={includeSystem}
              onIncludeSystemChange={setIncludeSystem}
              isLoading={rolesLoading}
              focusRequest={roleFocus}
            />
          ) : tab === 'bindings' ? (
            <BindingPanel
              clusterId={clusterId}
              bindings={bindings}
              roles={roles}
              clusterRoles={clusterRoles}
              serviceAccounts={serviceAccounts}
              namespaces={namespaces}
              includeSystem={includeSystem}
              onIncludeSystemChange={setIncludeSystem}
              isLoading={bindingsLoading}
            />
          ) : (
            <AccessReviewPanel
              clusterId={clusterId}
              serviceAccounts={serviceAccounts}
              showLogs={showLogs}
            />
          )}
        </div>
      </main>
    </div>
  );
}

export default K8sRbacPage;
