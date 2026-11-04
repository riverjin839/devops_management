import { create } from 'zustand';

/**
 * 화면 밀도(글자 크기·줄간격) — 사용자 설정.
 * - `compact`     : 예전 값(본문 보조 12px / 본문 14px). 큰 모니터에서 한 화면에 많이 보고 싶을 때.
 * - `default`     : **기본값** — 보조 13px / 본문 14.5px. 한글은 같은 크기에서 라틴보다 작아 보여 12px 보다 한 단계 키웠다.
 * - `comfortable` : 보조 14px / 본문 16px. 장시간 작업·저시력·빔프로젝터.
 *
 * `<html data-density>` 가 index.css 의 `--fs-xs`/`--fs-sm` 를 바꾸고, Tailwind `text-xs`/`text-sm` 만 그 변수를 따른다.
 * localStorage(`k8s:density`)는 첫 화면 캐시이자 기기 간 동기화 대상이다 — `k8s:` 접두사 키는
 * `lib/localPrefsSync.ts` 가 사용자 설정(`local_prefs`)으로 서버와 맞추므로 백엔드 변경이 필요 없다.
 */
export type Density = 'compact' | 'default' | 'comfortable';
export const DENSITIES: readonly Density[] = ['compact', 'default', 'comfortable'];
export const DEFAULT_DENSITY: Density = 'default';

const DENSITY_KEY = 'k8s:density';

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function applyDensity(density: Density) {
  const root = document.documentElement;
  // 기본값은 속성을 두지 않는다(index.css :root 가 기본) — 테마의 data-accent 와 같은 규칙.
  if (density === DEFAULT_DENSITY) root.removeAttribute('data-density');
  else root.setAttribute('data-density', density);
  safeSet(DENSITY_KEY, density);
}

function resolveInitial(): Density {
  const stored = safeGet(DENSITY_KEY);
  return stored && (DENSITIES as readonly string[]).includes(stored) ? (stored as Density) : DEFAULT_DENSITY;
}

// 첫 렌더 전에 적용(깜빡임 방지) — main.tsx 가 themeStore 와 함께 불러온다.
const _initial = resolveInitial();
applyDensity(_initial);

interface DensityState {
  density: Density;
  setDensity: (density: Density) => void;
}

export const useDensityStore = create<DensityState>((set) => ({
  density: _initial,
  setDensity: (density) => {
    applyDensity(density);
    set({ density });
  },
}));
