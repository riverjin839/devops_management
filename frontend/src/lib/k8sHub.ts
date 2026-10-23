import { createContext, useContext } from 'react';

/**
 * K8s 클러스터 허브(`/k8s/:clusterId/:view`) 안에 임베드된 화면임을 알려주는 컨텍스트.
 *
 * 허브는 클러스터 레일(`ClusterSidebar`)과 `<h1>`·`<main>` 을 하나만 그리고, 기존 per-cluster
 * 화면(`K8sManagePage`·`K8sAllocationPage`…)을 서브뷰로 **그대로 마운트**한다. 그 화면들은
 * 저마다 레일·헤더·`PageShell` 을 렌더하므로, 이 컨텍스트가 있으면
 * - `useClusterRouteParam()` 은 URL 이동 대신 허브의 clusterId/selectCluster 를 돌려주고,
 * - `ClusterSidebar` 는 아무것도 그리지 않으며,
 * - `PageShell` 은 `div` + 패딩 없음, `PageHeader` 는 h2 로 내려간다.
 * 덕분에 화면 쪽 코드를 고치지 않고 허브에 담을 수 있다(지식 허브·아일랜드 임베드와 같은 발상 —
 * `lib/islandEmbed.ts`). 페이지를 import 하지 않는다(순환 방지).
 */
export interface K8sHubEmbed {
  /** 허브가 고른 클러스터 id. */
  clusterId: string;
  /** 허브 레일에서 클러스터를 바꾼다 — 현재 뷰·쿼리를 유지한 채 URL 만 바꾼다. */
  selectCluster: (id: string | null) => void;
}

export const K8sHubContext = createContext<K8sHubEmbed | null>(null);

/** 허브 안이면 임베드 정보, 아니면 null. */
export function useK8sHub(): K8sHubEmbed | null {
  return useContext(K8sHubContext);
}
