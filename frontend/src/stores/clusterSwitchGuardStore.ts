import { create } from 'zustand';
import { useEffect, useRef } from 'react';

/**
 * K8s 허브 클러스터 전환 가드(D-244).
 *
 * 허브의 클러스터 목록(사이드바 "K8s 클러스터" flyout · 헤더 「클러스터 전환」 — 둘 다 `K8sClusterFlyoutBody`)은
 * 링크로 바로 이동하므로, 열린 SSH 세션이 있는 화면(k9s·노드 SSH)이 이동 전에 끼어들 길이 없다.
 * 그런 화면이 가드를 등록하면 목록은 이동 전에 가드를 부르고, 가드가 `true`(= 화면이 확인 창을 띄워 직접 처리)를
 * 돌려주면 이동을 멈춘다. 확인하면 화면이 스스로 세션을 정리하고 허브 `selectCluster` 로 이동한다.
 * 화면 하나만 마운트되므로 가드는 하나다.
 */
type ClusterSwitchGuard = (targetClusterId: string) => boolean;

interface ClusterSwitchGuardState {
  guard: ClusterSwitchGuard | null;
  setGuard: (g: ClusterSwitchGuard | null) => void;
}

export const useClusterSwitchGuardStore = create<ClusterSwitchGuardState>((set) => ({
  guard: null,
  setGuard: (guard) => set({ guard }),
}));

/**
 * 마운트 동안 가드를 등록한다. `intercept` 는 렌더마다 최신 값으로 바뀌어도 되고(ref 로 읽는다),
 * `enabled` 가 false 면 등록하지 않는다(허브 밖 렌더 등).
 */
export function useClusterSwitchGuard(intercept: ClusterSwitchGuard, enabled: boolean) {
  const ref = useRef(intercept);
  ref.current = intercept;
  const setGuard = useClusterSwitchGuardStore((s) => s.setGuard);
  useEffect(() => {
    if (!enabled) return;
    const g: ClusterSwitchGuard = (id) => ref.current(id);
    setGuard(g);
    return () => {
      if (useClusterSwitchGuardStore.getState().guard === g) setGuard(null);
    };
  }, [enabled, setGuard]);
}
