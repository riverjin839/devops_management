import { createContext, useContext } from 'react';

/**
 * 현재 컴포넌트가 Your Island 패널 안에 임베드되어 렌더되는지 알려준다.
 *
 * 클러스터 선택형 페이지들은 `/ops-checks/:clusterId` 처럼 **선택 상태를 URL 에 담고**,
 * 파라미터가 없으면 마운트 시 첫 클러스터로 `navigate(..., {replace:true})` 한다. 아일랜드는
 * `/island/:islandId` 라우트라 그 파라미터가 없으므로, 임베드된 페이지가 그대로 동작하면
 * **앱 전체를 자기 라우트로 끌고 나가** 아일랜드에서 튕겨나간다(클러스터가 1개 이상일 때만
 * 재현되는 버그였다).
 *
 * 그래서 임베드 여부를 컨텍스트로 알려주고, `useClusterRouteParam()` 이 임베드 상태에서는
 * URL 대신 로컬 state 로 클러스터를 고르게 한다. 컴포넌트를 export 하지 않아
 * `react-refresh/only-export-components` 에 걸리지 않는다 — Provider 는 호출 측에서
 * `<IslandEmbedContext.Provider>` 로 직접 쓴다.
 */
export const IslandEmbedContext = createContext(false);

export function useIsIslandEmbedded(): boolean {
  return useContext(IslandEmbedContext);
}
