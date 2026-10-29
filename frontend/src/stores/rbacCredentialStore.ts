import { create } from 'zustand';

/**
 * `/k8s-rbac` 에서 방금 발급한 kubeconfig — 클러스터마다 마지막 1건.
 *
 * 토큰은 다시 볼 수 없어서, 허브의 다른 뷰나 다른 클러스터로 옮겼다 돌아와도(화면이 다시
 * 마운트돼도) 운영자가 직접 닫기 전까지는 남아 있어야 한다. 그래서 컴포넌트 state 가 아니라
 * 이 스토어에 둔다. **메모리에만 둔다** — localStorage 등에 쓰면 비밀값이 디스크에 남는다.
 * 새로고침·창 닫기로는 사라지며, 그 전에 브라우저 이탈 확인을 띄운다(`IssuedCredentialCard`).
 */
export interface IssuedCredential {
  clusterId: string;
  clusterName: string;
  namespace: string;
  serviceAccount: string;
  kubeconfig: string;
  /** null = 만료 없는 Secret 토큰. */
  expiresAt: string | null;
  /** 어디서 발급했는지 — 카드 제목에 쓴다. */
  source: 'wizard' | 'reissue';
  issuedAt: number;
}

interface RbacCredentialState {
  byCluster: Record<string, IssuedCredential>;
  set: (c: IssuedCredential) => void;
  clear: (clusterId: string) => void;
}

export const useRbacCredentialStore = create<RbacCredentialState>((set) => ({
  byCluster: {},
  set: (c) => set((s) => ({ byCluster: { ...s.byCluster, [c.clusterId]: c } })),
  clear: (clusterId) =>
    set((s) => {
      const next = { ...s.byCluster };
      delete next[clusterId];
      return { byCluster: next };
    }),
}));
