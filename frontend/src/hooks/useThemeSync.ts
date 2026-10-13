import { useEffect, useRef } from 'react';
import { useHomePrefs, useUpdateHomePrefs } from './useHomePrefs';
import { ACCENTS, THEMES, useThemeStore, type Accent, type Theme } from '@/stores/themeStore';

function asTheme(v: unknown): Theme | null {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v) ? (v as Theme) : null;
}
function asAccent(v: unknown): Accent | null {
  return typeof v === 'string' && (ACCENTS as readonly string[]).includes(v) ? (v as Accent) : null;
}

/**
 * 바탕 테마·강조색을 서버(`home_prefs.theme`/`accent`)와 맞춘다 — 다른 PC·브라우저에서 로그인해도
 * 같은 테마로 보이게. localStorage(`k8s:theme`/`k8s:accent`)는 첫 화면을 깜빡임 없이 그리는 캐시로만
 * 남고(themeStore 가 모듈 로드 때 읽음), 로그인 후 서버 값이 오면 서버가 이긴다.
 *
 * - 서버 → 화면: 서버 값이 이 앱이 아는 테마이고 화면과 다르면 화면에 적용한다(다른 기기에서 바꾼 값이
 *   다음 조회 때 따라옴). 모르는 테마(더 새 버전에서 저장)는 무시한다.
 * - 화면 → 서버: 사용자가 테마를 바꾸면 저장한다. 서버에 아직 값이 없으면(이 기능 이전 계정) 지금 화면 값을
 *   한 번 올려 둔다 — 기존에 고른 테마가 기본값으로 덮이지 않게.
 *
 * 서버 값을 화면에 적용하면 화면 값도 "바뀐" 것이 되지만, 그때는 서버 값과 같아 다시 올리지 않는다.
 */
export function useThemeSync() {
  const { data: prefs } = useHomePrefs();
  const update = useUpdateHomePrefs();
  const { mutate } = update;
  const theme = useThemeStore((s) => s.theme);
  const accent = useThemeStore((s) => s.accent);
  const serverTheme = prefs?.theme;
  const serverAccent = prefs?.accent;
  const loaded = prefs !== undefined;

  // 서버 → 화면 (+ 서버가 비어 있으면 현재 값 채택)
  useEffect(() => {
    if (!loaded) return;
    const store = useThemeStore.getState();
    const st = asTheme(serverTheme);
    const sa = asAccent(serverAccent);
    if (st && st !== store.theme) store.setTheme(st);
    if (sa && sa !== store.accent) store.setAccent(sa);
    if (serverTheme == null || serverAccent == null) {
      const cur = useThemeStore.getState();
      mutate({ theme: st ?? cur.theme, accent: sa ?? cur.accent });
    }
  }, [loaded, serverTheme, serverAccent, mutate]);

  // 화면 → 서버 — 화면 값이 **바뀐 순간**에만(사용자가 테마 메뉴·갤러리에서 고름). 로드 직후엔 올리지
  // 않으므로 서버에 이 앱이 모르는 더 새 테마가 있어도 덮어쓰지 않는다.
  const prev = useRef({ theme, accent });
  useEffect(() => {
    const changed = prev.current.theme !== theme || prev.current.accent !== accent;
    prev.current = { theme, accent };
    if (!changed || !loaded) return;
    if (theme !== serverTheme || accent !== serverAccent) mutate({ theme, accent });
  }, [theme, accent, loaded, serverTheme, serverAccent, mutate]);
}
