// 클러스터 아이콘을 뷰어의 현재 UI 테마에 맞춰 매번 다시 렌더하는 훅.
// cluster.iconConfig 가 있으면(아이콘 빌더로 만든 아이콘) 그 레시피 + 현재 활성 테마 +
// 운영레벨 목록으로 SVG 를 즉석에서 다시 빌드한다(테마 동기화). colorMode 가 'custom' 이면
// customHex 가 테마와 무관하게 항상 우선한다. iconConfig 가 없으면(lucide/emoji/업로드/구버전
// 아이콘) 기존처럼 icon 문자열을 그대로 정적으로 해석한다 — 동작 변화 없음.

import { useMemo } from 'react';
import type { Cluster } from '@/types';
import { resolveClusterIcon, type ResolvedClusterIcon } from '@/lib/clusterIcons';
import { buildClusterIconSvg, svgToDataUrl } from '@/lib/clusterIconBuilder';
import { resolveIconSeed } from '@/lib/clusterIconTheme';
import { useOperationLevels } from './useOperationLevels';
import { useThemeStore } from '@/stores/themeStore';

export function useClusterIconSrc(
  cluster: Pick<Cluster, 'icon' | 'iconConfig'> | null | undefined,
): ResolvedClusterIcon {
  const { data: levels } = useOperationLevels();
  const theme = useThemeStore((s) => s.theme);

  return useMemo(() => {
    const config = cluster?.iconConfig;
    if (!config) return resolveClusterIcon(cluster?.icon);
    const { colorToken, customHex } = resolveIconSeed(config, levels, theme);
    const svg = buildClusterIconSvg({
      workName: config.workName,
      attribute: config.attribute,
      regionAbbr: config.regionAbbr,
      colorToken,
      customHex,
      k8sWatermark: config.watermark,
      shape: config.shape,
    });
    return { kind: 'image', value: svgToDataUrl(svg) };
  }, [cluster?.icon, cluster?.iconConfig, levels, theme]);
}
