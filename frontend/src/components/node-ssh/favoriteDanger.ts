import { judgeCommand } from '@/lib/dangerCommand';
import type { SshFavorite } from '@/types';

/**
 * 즐겨찾기가 변경 명령인가. 손대지 않은 기본 명령(옛 커널 파라미터 콘솔 프리셋)은 전부 조회 전용으로
 * 검증된 것이라(D-171) 셸 판정기의 보수적 판정(`for` 루프 등)과 무관하게 조회로 본다.
 */
export function favoriteIsDanger(f: Pick<SshFavorite, 'command' | 'presetKey' | 'modified'>): boolean {
  if (f.presetKey && !f.modified) return false;
  return !judgeCommand(f.command, 'shell').readOnly;
}
