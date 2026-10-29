/**
 * K8s 접근 권한 (`/k8s-rbac`)
 *
 * 개발자가 자기 LOCAL 의 kubectl 로 클러스터에 붙어 **배포하고 로그를 보는** 데 필요한
 * ServiceAccount · 권한 · 바인딩 · kubeconfig 한 세트를 만들고 편집·회수하는 화면.
 * 배포는 보통 자기 네임스페이스 기준이지만 다른 네임스페이스도 필요할 때가 있어서,
 * 발급 마법사가 주 네임스페이스 + 추가 네임스페이스를 함께 받는다.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, Link2, Shield, ShieldCheck, Wand2 } from 'lucide-react';
import { ClusterSidebar, SelectClusterEmptyState, PageShell, SegTabs, SwitchToggle } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import {
  AccessReviewPanel,
  BindingPanel,
  IssuedCredentialCard,
  ProvisionConsole,
  ProvisionWizard,
  RolePanel,
  ServiceAccountPanel,
  type RbacRoleFocusRequest,
} from '@/components/k8s-rbac';
import { useClusters } from '@/hooks/useCluster';
import { useLogPref } from '@/hooks/useLogPref';
import { useUrlParams, pickParam } from '@/hooks/useUrlParams';
import { useK8sHub } from '@/lib/k8sHub';
import { useRbacCredentialStore } from '@/stores/rbacCredentialStore';
import {
  useProvisionStream,
  useRbacBindings,
  useRbacClusterRoles,
  useRbacNamespaces,
  useRbacPresets,
  useRbacRoles,
  useRbacServiceAccounts,
} from '@/hooks/useK8sRbac';
import type {
  RbacBinding,
  RbacBindingSummary,
  RbacNamespace,
  RbacRole,
  RbacServiceAccount,
} from '@/types';

// 쿼리 data 가 없을 때의 안정된 빈 배열 — 렌더마다 새 [] 를 만들면 하위 useMemo 가 매번 다시 돈다.
const EMPTY_LIST_NS: RbacNamespace[] = [];
const EMPTY_LIST_SA: RbacServiceAccount[] = [];
const EMPTY_LIST_ROLE: RbacRole[] = [];
const EMPTY_LIST_BINDING: RbacBinding[] = [];

type TabKey = 'wizard' | 'sa' | 'roles' | 'bindings' | 'review';

// 탭 이름은 카드 제목과 같은 말을 쓴다(ServiceAccount 는 K8s 오브젝트 이름 그대로).
const TABS: { key: TabKey; label: string; icon: typeof Wand2 }[] = [
  { key: 'wizard', label: '액세스 발급', icon: Wand2 },
  { key: 'sa', label: 'ServiceAccount', icon: KeyRound },
  { key: 'roles', label: '롤', icon: Shield },
  { key: 'bindings', label: '바인딩', icon: Link2 },
  { key: 'review', label: '권한 점검', icon: ShieldCheck },
];
const TAB_OPTIONS = TABS.map(({ key, label, icon: Icon }) =>
  [key, <><Icon className="w-3.5 h-3.5" aria-hidden="true" />{label}</>] as const);

export function K8sRbacPage() {
  const { data: clusters = [] } = useClusters();
  // 클러스터 선택·탭은 URL 쿼리에 둔다(D-029) — 새로고침·링크 공유에도 같은 화면이 열린다.
  const [urlParams, setUrlParams] = useUrlParams({ cluster: '', tab: 'wizard' });
  // K8s 클러스터 허브(D-240) 안에서는 허브가 고른 클러스터가 우선이다(`?cluster=` 는 단독·아일랜드용).
  const hub = useK8sHub();
  const selectedClusterId = hub ? hub.clusterId : (urlParams.cluster || null);
  const setSelectedClusterId = (id: string | null) => setUrlParams({ cluster: id ?? '' });
  const tab = pickParam<TabKey>(urlParams.tab, TABS.map((t) => t.key), 'wizard');
  const setTab = (k: TabKey) => setUrlParams({ tab: k });
  const [includeSystem, setIncludeSystem] = useState(false);
  // 발급 마법사 실행 로그(ProvisionConsole)를 펼쳐 볼지 — 로그는 항상 수집하고 표시 여부만
  // 사용자가 정한다(화면별 localStorage). 권한 점검 탭은 패널 자체의 표준 실행 로그를 쓴다.
  const [showLogs, setShowLogs] = useLogPref('k8s-rbac-provision');
  // ServiceAccount 탭의 "연결된 권한" 클릭 → Role/ClusterRole 탭으로 이동해 그 롤을 연다.
  const [roleFocus, setRoleFocus] = useState<RbacRoleFocusRequest | null>(null);
  const clusterId = selectedClusterId ?? clusters[0]?.id ?? '';
  const cluster = useMemo(() => clusters.find((c) => c.id === clusterId), [clusters, clusterId]);
  const clusterName = cluster?.name ?? clusterId;

  const { data: catalog } = useRbacPresets(clusterId);
  // 조회 실패(kubeconfig 오류·API 미도달·RBAC 403)를 "없다" 로 보이지 않도록 isError/error 를
  // 패널까지 넘긴다(D-139) — "SA 가 없다" 오판은 중복 발급·권한 과다 부여로 이어진다.
  const nsQ = useRbacNamespaces(clusterId);
  const saQ = useRbacServiceAccounts(clusterId);
  const rolesQ = useRbacRoles(clusterId);
  const clusterRolesQ = useRbacClusterRoles(clusterId, includeSystem);
  const bindingsQ = useRbacBindings(clusterId, undefined, includeSystem);
  const namespaces = nsQ.data ?? EMPTY_LIST_NS;
  const serviceAccounts = saQ.data ?? EMPTY_LIST_SA;
  const roles = rolesQ.data ?? EMPTY_LIST_ROLE;
  const clusterRoles = clusterRolesQ.data ?? EMPTY_LIST_ROLE;
  const bindings = bindingsQ.data ?? EMPTY_LIST_BINDING;
  const rolesError = rolesQ.isError ? rolesQ.error : clusterRolesQ.isError ? clusterRolesQ.error : null;

  const stream = useProvisionStream(clusterId);

  // 마법사가 발급한 kubeconfig 는 메모리 스토어로 옮긴다 — 뷰·클러스터를 옮겨 화면이 다시
  // 마운트돼도 운영자가 닫기 전까지 남는다(재발급과 같은 카드 `IssuedCredentialCard`).
  const setCredential = useRbacCredentialStore((s) => s.set);
  const issuedResult = stream.result;
  // 결과 1건은 한 번만 옮긴다 — 운영자가 닫은 뒤나 다른 클러스터로 바꾼 뒤에 같은 결과가 다시
  // (다른 클러스터 이름으로) 들어가지 않게. 결과는 그 순간의 클러스터에서 발급된 것이다.
  const storedResult = useRef<typeof issuedResult>(null);
  useEffect(() => {
    if (!issuedResult?.kubeconfig || issuedResult.dryRun || !clusterId) return;
    if (storedResult.current === issuedResult) return;
    storedResult.current = issuedResult;
    setCredential({
      clusterId,
      clusterName,
      namespace: issuedResult.namespace,
      serviceAccount: issuedResult.serviceAccount,
      kubeconfig: issuedResult.kubeconfig,
      expiresAt: issuedResult.tokenExpiresAt,
      source: 'wizard',
      issuedAt: Date.now(),
    });
    // clusterName 은 표시용 — 이름만 바뀌었다고 다시 넣지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issuedResult, clusterId, setCredential]);

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
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => setSelectedClusterId(id)}
          iconOnly
        />

        <div className="flex-1 min-w-0 space-y-3">
          <PageHeader
            icon={Shield}
            title="K8s 접근 권한"
            titleExtra={
              <span className="text-sm text-muted-foreground">
                — <span className="font-medium text-foreground">{cluster?.name ?? '—'}</span>
                {namespaces.length > 0 && (
                  <span className="ml-2">네임스페이스 {namespaces.length}</span>
                )}
              </span>
            }
          />

          <div className="flex items-center gap-3 flex-wrap">
            <SegTabs mode="tabs" size="md" label="K8s 접근 권한 보기" value={tab} onChange={setTab} options={TAB_OPTIONS} />
            {tab === 'wizard' && (
              <div className="ml-auto">
                <SwitchToggle
                  checked={showLogs}
                  onChange={setShowLogs}
                  label="로그 보기"
                  title={showLogs ? '실행 로그 접기' : '실행 로그 펼치기'}
                />
              </div>
            )}
          </div>

          {clusterId && <IssuedCredentialCard clusterId={clusterId} />}

          {!clusterId ? (
            <SelectClusterEmptyState />
          ) : (<>
            {/* 발급 마법사와 롤 편집은 탭을 옮겨도 입력이 남도록 마운트를 유지하고 숨기기만 한다
                (SA 탭에서 확인하고 돌아왔을 때 기본 프리셋으로 다시 시작하면 더 넓은 권한을 발급하기 쉽다). */}
            <div role="tabpanel" aria-label="액세스 발급"
              className={tab === 'wizard' ? 'grid grid-cols-1 xl:grid-cols-2 gap-3 items-start' : 'hidden'}>
              <ProvisionWizard
                clusterId={clusterId}
                catalog={catalog}
                namespaces={namespaces}
                namespacesLoading={nsQ.isLoading}
                namespacesError={nsQ.isError ? nsQ.error : null}
                onRetryNamespaces={() => { void nsQ.refetch(); }}
                running={stream.running}
                onRun={stream.start}
              />
              <div className="xl:sticky xl:top-3">
                <ProvisionConsole stream={stream} showLogs={showLogs} />
              </div>
            </div>
            <div role="tabpanel" aria-label="롤" className={tab === 'roles' ? '' : 'hidden'}>
              <RolePanel
                clusterId={clusterId}
                roles={roles}
                clusterRoles={clusterRoles}
                bindings={bindings}
                includeSystem={includeSystem}
                onIncludeSystemChange={setIncludeSystem}
                isLoading={rolesQ.isLoading || clusterRolesQ.isLoading}
                error={rolesError}
                onRetry={() => { void rolesQ.refetch(); void clusterRolesQ.refetch(); }}
                focusRequest={roleFocus}
              />
            </div>
            {tab === 'sa' ? (
              <div role="tabpanel" aria-label="ServiceAccount">
                <ServiceAccountPanel
                  clusterId={clusterId}
                  clusterName={clusterName}
                  serviceAccounts={serviceAccounts}
                  namespaces={namespaces}
                  isLoading={saQ.isLoading}
                  error={saQ.isError ? saQ.error : null}
                  onRetry={() => { void saQ.refetch(); }}
                  onSelectRole={handleSelectRole}
                  bindings={bindings}
                  roles={roles}
                  clusterRoles={clusterRoles}
                />
              </div>
            ) : tab === 'bindings' ? (
              <div role="tabpanel" aria-label="바인딩">
                <BindingPanel
                  clusterId={clusterId}
                  bindings={bindings}
                  roles={roles}
                  clusterRoles={clusterRoles}
                  serviceAccounts={serviceAccounts}
                  namespaces={namespaces}
                  includeSystem={includeSystem}
                  onIncludeSystemChange={setIncludeSystem}
                  isLoading={bindingsQ.isLoading}
                  error={bindingsQ.isError ? bindingsQ.error : null}
                  onRetry={() => { void bindingsQ.refetch(); }}
                />
              </div>
            ) : tab === 'review' ? (
              <div role="tabpanel" aria-label="권한 점검">
                <AccessReviewPanel clusterId={clusterId} serviceAccounts={serviceAccounts} />
              </div>
            ) : null}
          </>)}
        </div>
      </PageShell>
    </div>
  );
}

export default K8sRbacPage;
