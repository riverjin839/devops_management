// 아이콘 빌더 레시피(ClusterIconConfig) + 뷰어의 현재 상태(활성 테마, 운영레벨 목록)로부터
// buildClusterIconSvg() 에 넘길 colorToken/customHex 를 계산한다.
//
// 우선순위: colorMode === 'custom' (사용자가 배색 패턴 스와치를 직접 골랐을 때) > 활성 테마가
// COLOR_PATTERNS 와 이름이 일치할 때 그 팔레트의 대표색 > 운영타입(level)에 설정된 색상.
// 즉 "커스텀이 항상 우선, 아니면 테마에 동기화, 그것도 없으면 운영타입 색상" 순서다.

import type { ClusterIconConfig, OperationLevelItem } from '@/types';
import type { Theme } from '@/stores/themeStore';
import { COLOR_PATTERNS } from './colorPatterns';
import { levelColor, levelCustomHex } from '@/hooks/useOperationLevels';

export interface ResolvedIconSeed {
  colorToken: string;
  customHex?: string | null;
}

/** 활성 테마 이름 → 매칭되는 배색 패턴의 대표(시드) 색상. 매칭 없으면 undefined
 *  (default/comfort/light/dark/system 처럼 큐레이션 패턴이 없는 테마). */
export function themePatternSeedHex(theme: Theme): string | undefined {
  return COLOR_PATTERNS.find((p) => p.key === theme)?.colors[0];
}

export function resolveIconSeed(
  config: ClusterIconConfig,
  levels: OperationLevelItem[] | undefined,
  activeTheme: Theme,
): ResolvedIconSeed {
  const colorToken = levelColor(levels, config.level || undefined);
  if (config.colorMode === 'custom' && config.customHex) {
    return { colorToken, customHex: config.customHex };
  }
  const themeHex = themePatternSeedHex(activeTheme);
  if (themeHex) {
    return { colorToken, customHex: themeHex };
  }
  return { colorToken, customHex: levelCustomHex(levels, config.level || undefined) };
}
