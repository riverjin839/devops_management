import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { nsPrefsApi } from '@/services/api';
import { getAuthToken } from '@/stores/authStore';
import type { NsPrefs } from '@/types';

/**
 * NS 선택 기억 — 계정·클러스터별 "마지막 선택"과 "최근 선택 NS(기본 3개)".
 *
 * NS 가 천 개 단위인 클러스터에서 탭을 옮기거나 재로그인할 때마다 NS 를 다시 고르는 시간을 줄인다.
 * 원천은 서버(`/me/ns-prefs`)이고, 이 훅이 TanStack Query 캐시를 화면 간 공유 저장소로 쓴다 —
 * 같은 클러스터의 허브 탭들은 같은 캐시 항목을 읽으므로 탭을 옮겨도 선택이 따라온다.
 * 서버 규칙(services/ns_prefs.py apply_update)과 같은 방식으로 캐시를 먼저 갱신(낙관적)하고,
 * 저장은 클러스터별로 모아 한 번에 보낸다(체크박스를 연달아 눌러도 요청이 폭주하지 않게).
 */
export const nsPrefsKeys = { all: ['nsPrefs'] as const };

const EMPTY: string[] = [];
const DEFAULT_RECENT_LIMIT = 3;
const SAVE_DELAY_MS = 400;

/** 서버 `apply_update` 와 같은 규칙: 새로 추가된 NS 만 최근 목록 맨 앞으로 올린다. */
export function applyNsSelection(prev: NsPrefs | undefined, clusterId: string, selected: string[]): NsPrefs {
  const base: NsPrefs = prev ?? { recentLimit: DEFAULT_RECENT_LIMIT, clusters: [] };
  const entry = base.clusters.find((c) => c.clusterId === clusterId);
  const before = new Set(entry?.selected ?? []);
  const added = selected.filter((n) => !before.has(n));
  const recent: string[] = [];
  for (const n of [...added].reverse().concat(entry?.recent ?? [])) {
    if (!recent.includes(n)) recent.push(n);
  }
  const next = { clusterId, selected, recent: recent.slice(0, base.recentLimit) };
  return {
    ...base,
    clusters: entry ? base.clusters.map((c) => (c.clusterId === clusterId ? next : c)) : [...base.clusters, next],
  };
}

/** 공유 캐시 조회 — 로그인 전에는 호출하지 않고, 실패(구버전 서버 등)해도 화면은 "전체"로 동작한다. */
export function useNsPrefsQuery() {
  return useQuery({
    queryKey: nsPrefsKeys.all,
    queryFn: async (): Promise<NsPrefs> => (await nsPrefsApi.get()).data,
    enabled: !!getAuthToken(),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

// 클러스터별 저장 대기 — 모듈 수준이라 화면이 먼저 사라져도(탭 전환) 대기 중 저장은 그대로 나간다.
const pendingSaves = new Map<string, { timer: ReturnType<typeof setTimeout>; selected: string[] }>();

function scheduleSave(qc: QueryClient, clusterId: string, selected: string[]) {
  const prev = pendingSaves.get(clusterId);
  if (prev) clearTimeout(prev.timer);
  const timer = setTimeout(() => {
    const latest = pendingSaves.get(clusterId)?.selected ?? selected;
    pendingSaves.delete(clusterId);
    nsPrefsApi.update({ clusterId, selected: latest }).catch(() => {
      // 저장 실패는 조용히 서버 값으로 되돌린다 — 선택 자체는 이 세션 화면에서 이미 동작했다.
      void qc.invalidateQueries({ queryKey: nsPrefsKeys.all });
    });
  }, SAVE_DELAY_MS);
  pendingSaves.set(clusterId, { timer, selected });
}

export interface NsSelection {
  /** 서버에서 읽어 오기 전에는 false — 이때 NS 목록을 "전체"로 조회하지 않도록 화면이 기다린다. */
  ready: boolean;
  /** 이 클러스터의 마지막 선택(비어 있으면 전체 네임스페이스). 캐시 참조라 렌더 간 안정적이다. */
  selected: string[];
  /** 최근 선택 NS(최신이 앞, 기본 3개). */
  recent: string[];
  setSelected: (next: string[]) => void;
  setSelectedSet: (next: Set<string>) => void;
}

export function useNsSelection(clusterId: string): NsSelection {
  const qc = useQueryClient();
  const q = useNsPrefsQuery();
  const entry = q.data?.clusters.find((c) => c.clusterId === clusterId);
  const selected = entry?.selected ?? EMPTY;
  const recent = entry?.recent ?? EMPTY;
  const ready = !!clusterId && !q.isLoading;

  const setSelected = useCallback((next: string[]) => {
    if (!clusterId) return;
    const current = qc.getQueryData<NsPrefs>(nsPrefsKeys.all)?.clusters.find((c) => c.clusterId === clusterId)?.selected ?? EMPTY;
    if (current.length === next.length && current.every((n, i) => n === next[i])) return;
    qc.setQueryData<NsPrefs>(nsPrefsKeys.all, (prev) => applyNsSelection(prev, clusterId, next));
    scheduleSave(qc, clusterId, next);
  }, [qc, clusterId]);

  const setSelectedSet = useCallback((next: Set<string>) => setSelected([...next]), [setSelected]);

  return useMemo(
    () => ({ ready, selected, recent, setSelected, setSelectedSet }),
    [ready, selected, recent, setSelected, setSelectedSet],
  );
}

/** 읽기 전용 — 최근 선택 NS 칩처럼 선택을 바꾸지 않는 곳에서 쓴다. */
export function useNsRecent(clusterId: string): string[] {
  const q = useNsPrefsQuery();
  return q.data?.clusters.find((c) => c.clusterId === clusterId)?.recent ?? EMPTY;
}
