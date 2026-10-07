// "로그 보기" 선택 — 화면(key)별로 localStorage 에 기억한다(D-089, RunLogPanel 과 함께 쓴다).
// 저장소가 막혀 있으면(사파리 프라이빗 등) 기본값으로 동작한다.
import { useCallback, useEffect, useState } from 'react';

const storageKey = (key: string) => `pep.runlog.${key}.show`;

export function useLogPref(key: string, defaultShow = true): [boolean, (v: boolean) => void] {
  const [show, setShow] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey(key));
      return v === null ? defaultShow : v === '1';
    } catch {
      return defaultShow;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey(key), show ? '1' : '0'); } catch { /* ignore */ }
  }, [key, show]);
  const set = useCallback((v: boolean) => setShow(v), []);
  return [show, set];
}
