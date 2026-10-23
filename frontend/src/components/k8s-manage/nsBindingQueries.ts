// NS 대시보드 — 이 NS 를 subject 로 묶는 바인딩 조회 정의. 인벤토리(개수)와 NsBindingsPanel(목록)이
// 같은 쿼리 키를 써서 한 번만 조회한다(컴포넌트 파일 밖에 둬야 fast refresh 규칙을 지킨다).
import { k8sResourcesApi } from '@/services/api';
import type { K8sResourceListResponse } from '@/types';

/** `cluster` = ClusterRoleBinding, `external` = 다른 NS 에 있는 RoleBinding. */
export type NsBindingScope = 'cluster' | 'external';

export const NS_BINDING_QUERY: Record<NsBindingScope, (clusterId: string, ns: string) => {
  queryKey: readonly unknown[]; queryFn: () => Promise<K8sResourceListResponse>;
}> = {
  cluster: (clusterId, ns) => ({
    queryKey: ['k8s-mng-ns-crb', clusterId, ns],
    queryFn: async () => (await k8sResourcesApi.nsClusterRoleBindings(clusterId, ns)).data,
  }),
  external: (clusterId, ns) => ({
    queryKey: ['k8s-mng-ns-ext-rb', clusterId, ns],
    queryFn: async () => (await k8sResourcesApi.nsExternalRoleBindings(clusterId, ns)).data,
  }),
};
