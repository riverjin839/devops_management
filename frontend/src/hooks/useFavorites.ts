import { useHomePrefs, useUpdateHomePrefs } from './useHomePrefs';

/** 즐겨찾기 경로 — 서버 저장(user_settings.home_prefs.pinnedPaths), 기기를 넘어 따라온다. */
export function useFavorites() {
  const { data } = useHomePrefs();
  const update = useUpdateHomePrefs();
  const pinnedPaths = data?.pinnedPaths ?? [];

  const isPinned = (path: string) => pinnedPaths.includes(path);

  const togglePin = (path: string) => {
    const next = isPinned(path)
      ? pinnedPaths.filter((p) => p !== path)
      : [...pinnedPaths, path];
    update.mutate({ pinnedPaths: next });
  };

  return { pinnedPaths, isPinned, togglePin };
}
