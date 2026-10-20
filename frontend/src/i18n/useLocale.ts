import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useHomePrefs, useUpdateHomePrefs } from '@/hooks/useHomePrefs';
import { applyLocale, asLocale, DEFAULT_LOCALE, type Locale } from './index';

/**
 * 서버 → 화면 로케일 동기화 — 로그인 셸(Sidebar)에서 한 번 호출한다.
 *
 * 서버 `home_prefs.locale` 이 있으면 그 값이 이긴다(다른 기기에서 바꾼 언어가 다음 조회 때 따라옴).
 * 서버 값이 없으면(아직 고른 적 없는 계정) 아무것도 올리지 않는다 — 기본 ko 를 매 계정에 써 넣을 이유가 없고,
 * 이 기기 캐시(`pep.locale`)를 그대로 쓴다. 저장 실패 시 낙관적 갱신이 되돌려지며 화면도 서버 값으로 돌아간다.
 */
export function useLocaleSync() {
  const { data: prefs } = useHomePrefs();
  const serverLocale = asLocale(prefs?.locale);
  useEffect(() => {
    if (serverLocale) applyLocale(serverLocale);
  }, [serverLocale]);
}

/** 현재 로케일 + 바꾸기(즉시 반영 + 서버 저장). */
export function useLocale(): { locale: Locale; changeLocale: (locale: Locale) => void } {
  const { i18n } = useTranslation();
  const { mutate } = useUpdateHomePrefs();
  const locale = asLocale(i18n.resolvedLanguage ?? i18n.language) ?? DEFAULT_LOCALE;
  const changeLocale = useCallback(
    (next: Locale) => {
      applyLocale(next);
      mutate({ locale: next });
    },
    [mutate],
  );
  return { locale, changeLocale };
}
