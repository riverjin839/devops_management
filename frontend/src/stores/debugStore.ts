import { create } from 'zustand';

// 대시보드/페이지 별 debug 플래그 + 최근 API 이벤트 링 버퍼.
//
// 사용: 특정 페이지에서 `useDebugStore((s) => s.enabled[pageKey])` 로 활성 여부 확인,
// DebugLogPanel 을 렌더. axios 인터셉터가 요청/응답을 `pushEvent` 로 밀어넣는다.

const STORAGE_KEY = 'k8s:debug-flags-v1';

/** 페이지 식별자 — Settings 의 Debug 탭에 표시되는 순서 */
export const DEBUG_PAGES = [
  { key: 'dashboard',      label: '메인 대시보드' },
  { key: 'cluster-manage', label: '클러스터 관리' },
  { key: 'node-specs',     label: '노드 서버스펙 대장' },
  { key: 'packet-flow',    label: '패킷 흐름' },
  { key: 'versions',       label: '버전/설정' },
  { key: 'bulk-exec',      label: '노드 일괄 실행' },
  { key: 'etcdctl',        label: 'etcdctl' },
  { key: 'mc',             label: 'mc client' },
  { key: 'kernel-params',  label: '커널 파라미터' },
  { key: 'node-labels',    label: '노드 라벨' },
  { key: 'service-topology', label: '서비스 토폴로지' },
  { key: 'members',        label: '멤버 / 업무' },
  { key: 'services',       label: '서비스 지식관리' },
  { key: 'global',         label: '전역 (모든 API 호출)' },
] as const;

export type DebugPageKey = typeof DEBUG_PAGES[number]['key'];

export interface DebugEvent {
  id: string;
  ts: number;
  kind: 'request' | 'response' | 'error' | 'info';
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  message?: string;
  payload?: unknown;
}

const MAX_EVENTS = 200;

function loadFlags(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, boolean>;
    return {};
  } catch {
    return {};
  }
}

function saveFlags(flags: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  } catch { /* 저장 실패 무시 */ }
}

interface DebugState {
  enabled: Record<string, boolean>;
  events: DebugEvent[];
  toggle: (key: DebugPageKey) => void;
  setEnabled: (key: DebugPageKey, value: boolean) => void;
  clearEvents: () => void;
  pushEvent: (evt: Omit<DebugEvent, 'id' | 'ts'>) => void;
  isAnyEnabled: () => boolean;
}

export const useDebugStore = create<DebugState>()((set, get) => ({
  enabled: loadFlags(),
  events: [],
  toggle: (key) => set((s) => {
    const next = { ...s.enabled, [key]: !s.enabled[key] };
    saveFlags(next);
    return { enabled: next };
  }),
  setEnabled: (key, value) => set((s) => {
    const next = { ...s.enabled, [key]: value };
    saveFlags(next);
    return { enabled: next };
  }),
  clearEvents: () => set({ events: [] }),
  pushEvent: (evt) => set((s) => {
    const next: DebugEvent = {
      ...evt,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: Date.now(),
    };
    const arr = [next, ...s.events];
    if (arr.length > MAX_EVENTS) arr.length = MAX_EVENTS;
    return { events: arr };
  }),
  isAnyEnabled: () => Object.values(get().enabled).some(Boolean),
}));

/** 비 React 영역(axios 인터셉터)에서 flag 조회용 */
export function isDebugEnabled(key: DebugPageKey | 'global'): boolean {
  return Boolean(useDebugStore.getState().enabled[key]);
}
