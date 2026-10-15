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
 * @param opts.pathFor 클러스터 id 가 경로 가운데에 오는 라우트(예: `/versions/:id/graph`)의 경로 생성기.
 *   없으면 `${basePath}/${id}`.
 * @param opts.local true 면 URL 을 건드리지 않고 로컬 state 로 동작한다 — 허브 탭 안에 다른 화면을
 *   그대로 마운트한 경우(예: 지식 허브의 온톨로지 탭)처럼 이동하면 탭을 벗어나는 곳에서 쓴다.
 */
export function useClusterRouteParam(
  basePath: string,
  clusters: Cluster[],
  opts: { pathFor?: (id: string) => string; local?: boolean } = {},
): ClusterRouteParam {
  const { clusterId: routeClusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const islandEmbedded = useIsIslandEmbedded();
  const embedded = islandEmbedded || !!opts.local;
  const { pathFor } = opts;
  const [localClusterId, setLocalClusterId] = useState('');

  const clusterId = embedded ? localClusterId : routeClusterId;

  useEffect(() => {
    if (clusterId || clusters.length === 0) return;
    if (embedded) setLocalClusterId(clusters[0].id);
    else navigate(pathFor ? pathFor(clusters[0].id) : `${basePath}/${clusters[0].id}`, { replace: true });
  }, [clusterId, clusters, embedded, basePath, pathFor, navigate]);

  const selectCluster = useCallback((id: string | null) => {
    if (!id) return;
    if (embedded) setLocalClusterId(id);
    else navigate(pathFor ? pathFor(id) : `${basePath}/${id}`);
  }, [embedded, basePath, pathFor, navigate]);

  return { clusterId, selectCluster };
}
