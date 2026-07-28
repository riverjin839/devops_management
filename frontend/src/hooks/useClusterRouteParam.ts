import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useIsIslandEmbedded } from '@/lib/islandEmbed';
import type { Cluster } from '@/types';

interface ClusterRouteParam {
  /** 현재 선택된 클러스터 id ('' = 아직 없음). */
  clusterId: string;
  /** 클러스터 선택 — 일반 라우트에서는 URL 이동, 아일랜드 임베드에서는 로컬 state. */
  selectCluster: (id: string | null) => void;
}

/**
 * `/<base>/:clusterId` 형태로 클러스터 선택을 URL 에 담는 페이지들의 공통 훅.
 *
 * - **일반 라우트**: 기존 동작 그대로 — 파라미터가 없으면 첫 클러스터로 replace 이동.
 * - **아일랜드 패널 임베드**: URL 을 건드리지 않는다. 이동하면 앱 전체가 아일랜드 밖으로
 *   나가버리기 때문. 대신 로컬 state 로 같은 선택 UX 를 제공한다.
 *
 * @param basePath 라우트 접두사 (예: '/ops-checks')
 * @param clusters 선택 대상 목록 — 비어 있으면 아무것도 하지 않는다.
 */
export function useClusterRouteParam(basePath: string, clusters: Cluster[]): ClusterRouteParam {
  const { clusterId: routeClusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const embedded = useIsIslandEmbedded();
  const [localClusterId, setLocalClusterId] = useState('');

  const clusterId = embedded ? localClusterId : routeClusterId;

  useEffect(() => {
    if (clusterId || clusters.length === 0) return;
    if (embedded) setLocalClusterId(clusters[0].id);
    else navigate(`${basePath}/${clusters[0].id}`, { replace: true });
  }, [clusterId, clusters, embedded, basePath, navigate]);

  const selectCluster = useCallback((id: string | null) => {
    if (!id) return;
    if (embedded) setLocalClusterId(id);
    else navigate(`${basePath}/${id}`);
  }, [embedded, basePath, navigate]);

  return { clusterId, selectCluster };
}
