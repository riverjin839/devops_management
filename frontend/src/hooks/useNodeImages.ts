import { useQuery } from '@tanstack/react-query';
import { nodeImagesApi } from '@/services/api';

// services/api.ts 의 response interceptor 가 snake_case → camelCase 로 자동 변환하므로
// 프론트엔드 타입은 camelCase 로 정의해야 한다. (이전엔 snake_case 였고, 그 결과
// `imageCount`/`totalSizeBytes`/`sizeBytes` 가 undefined 로 읽혀 표시되지 않았음.)
export interface NodeImageEntry {
  names: string[];
  sizeBytes: number;
}

export interface NodeImagesInfo {
  node: string;
  role: string;
  status: string;
  imageCount: number;
  totalSizeBytes: number;
  /** 노드 라벨 — 라벨 기준 카드 그룹핑/필터링용 */
  labels: Record<string, string>;
  images: NodeImageEntry[];
}

/** 백그라운드 스냅샷 진행 상태 — 자원관리/노드이미지 공용 envelope. */
export interface SnapshotMeta {
  status: 'computing' | 'ready' | 'error';
  progress: number | null;   // 0..1, null = 불확정(스피너)
  processed: number;
  total: number | null;
  stale: boolean;
}

export interface NodeImagesResult extends SnapshotMeta {
  nodes: NodeImagesInfo[];
}

export const nodeImageKeys = {
  list: (clusterId: string) => ['node-images', clusterId] as const,
};

export function useNodeImageList(clusterId: string) {
  return useQuery<NodeImagesResult>({
    queryKey: nodeImageKeys.list(clusterId),
    queryFn: async () => {
      const { data } = await nodeImagesApi.getNodeImages(clusterId);
      return {
        nodes: (data.data ?? []) as NodeImagesInfo[],
        status: data.status ?? 'ready',
        progress: data.progress ?? null,
        processed: data.processed ?? 0,
        total: data.total ?? null,
        stale: data.stale ?? false,
      };
    },
    enabled: !!clusterId,
    // 집계 중이면 1.5s 마다 폴링, 완료되면 60s 주기 자동 새로고침.
    refetchInterval: (query) =>
      query.state.data?.status === 'computing' ? 1500 : 60000,
  });
}
