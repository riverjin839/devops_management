// 클러스터 아이콘을 뷰어의 현재 UI 테마에 맞춰 매번 다시 렌더하는 훅.
// cluster.iconConfig 가 있으면(아이콘 빌더로 만든 아이콘) 그 레시피 + 현재 활성 테마 +
// 운영레벨 목록으로 SVG 를 즉석에서 다시 빌드한다(테마 동기화). 바탕·글자색은 활성 테마
// 토큰을 읽으므로 theme/accent 가 바뀌면 다시 계산한다. colorMode 가 'custom' 이면
// customHex 가 운영타입 바 색으로 항상 우선한다. iconConfig 가 없으면(lucide/emoji/업로드/구버전
// 아이콘) 기존처럼 icon 문자열을 그대로 정적으로 해석한다.
//
// monogramFallback: 아이콘이 전혀 없는 클러스터를 이름 이니셜 타일로 그린다
// (사이드바 레일 · /cluster-manage 표 · 설정 클러스터 탭). 미지정 여부는 호출부가 툴팁으로 알린다.

import { useMemo } from 'react';
import type { Cluster } from '@/types';
import { resolveClusterIcon, type ResolvedClusterIcon } from '@/lib/clusterIcons';
import {
  buildClusterIconSvg, svgToDataUrl, suggestInitials, suggestAttribute,
} from '@/lib/clusterIconBuilder';
import { resolveIconSeed } from '@/lib/clusterIconTheme';
import { useOperationLevels, levelColor, levelCustomHex } from './useOperationLevels';
import { useThemeStore } from '@/stores/themeStore';

export function useClusterIconSrc(
  cluster: (Pick<Cluster, 'icon' | 'iconConfig'> & Partial<Pick<Cluster, 'name' | 'operationLevel'>>) | null | undefined,
  options?: { monogramFallback?: boolean },
): ResolvedClusterIcon {
  const { data: levels } = useOperationLevels();
  const theme = useThemeStore((s) => s.theme);
  const accent = useThemeStore((s) => s.accent);
  const monogram = !!options?.monogramFallback;

  return useMemo(() => {
    const config = cluster?.iconConfig;
    if (!config) {
      const resolved = resolveClusterIcon(cluster?.icon);
      if (resolved || !monogram || !cluster?.name) return resolved;
      const level = cluster.operationLevel ?? undefined;
      const svg = buildClusterIconSvg({
        workName: suggestInitials(cluster.name),
        attribute: suggestAttribute(cluster.name),
        regionAbbr: '',
        colorToken: levelColor(levels, level),
        customHex: levelCustomHex(levels, level),
      });
      return { kind: 'image', value: svgToDataUrl(svg) };
    }
    const { colorToken, customHex } = resolveIconSeed(config, levels, theme);
    const svg = buildClusterIconSvg({
      workName: config.workName,
      attribute: config.attribute,
      regionAbbr: config.regionAbbr,
      colorToken,
      customHex,
      shape: config.shape,
    });
    return { kind: 'image', value: svgToDataUrl(svg) };
    // theme/accent 는 buildClusterIconSvg 가 읽는 CSS 토큰의 변화 신호라 deps 에 둔다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster?.icon, cluster?.iconConfig, cluster?.name, cluster?.operationLevel, monogram, levels, theme, accent]);
}
