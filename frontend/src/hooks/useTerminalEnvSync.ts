import { useEffect } from 'react';
import { useTerminalEnvStore } from '@/stores/terminalEnvStore';
import { envForOperationLevel } from '@/lib/terminalThemes';
import type { Cluster } from '@/types';

/**
 * 콘솔형 페이지(로그/실행 결과를 LogViewer 로 보여주는 화면) 공용 —
 * 선택된 클러스터의 운영등급을 터미널 Appearance 의 활성 환경(dev/ops)으로 동기화한다.
 * 'auto' 모드의 LogViewer 가 이 값으로 개발/운영 프로파일을 자동 선택한다.
 *
 * - 단일 선택: 해당 클러스터의 운영등급.
 * - 다중 선택(배열, 빈 배열 = 전체): 대상 중 **하나라도 운영이면 ops** (안전 우선).
 * - 선택 없음: null (전역 기본).
 * - 페이지 이탈 시 null 로 초기화해 다른 화면에 stale 환경이 남지 않게 한다.
 */
export function useTerminalEnvSync(
  clusters: Cluster[],
  selected: string | string[] | null | undefined,
) {
  const setCurrentEnv = useTerminalEnvStore((s) => s.setCurrentEnv);

  useEffect(() => {
    let targets: Cluster[];
    if (Array.isArray(selected)) {
      targets = selected.length === 0 ? clusters : clusters.filter((c) => selected.includes(c.id));
    } else {
      targets = selected ? clusters.filter((c) => c.id === selected) : [];
    }
    if (targets.length === 0) {
      setCurrentEnv(null);
      return;
    }
    const anyOps = targets.some((c) => envForOperationLevel(c.operationLevel) === 'ops');
    setCurrentEnv(anyOps ? 'ops' : 'dev');
  }, [clusters, selected, setCurrentEnv]);

  useEffect(() => () => setCurrentEnv(null), [setCurrentEnv]);
}
