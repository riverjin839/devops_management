import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ko } from './resources/ko';
import { en } from './resources/en';

/**
 * R-6 i18n 2단계 — react-i18next 초기화 + 표시 언어(로케일) 도우미.
 *
 * 로케일 원천 우선순위: 서버 `home_prefs.locale`(기기·브라우저를 넘어 따라옴, `useLocaleSync` 가 맞춘다)
 * → localStorage `pep.locale`(첫 화면을 깜빡임 없이 그리는 캐시) → 기본 `ko`.
 *
 * `pep.locale` 은 개인 키(`lib/personalStorage.ts` 의 `pep.` 접두)라 공용 PC 에서 계정을 바꾸면 같이
 * 바뀌어 끼워지고, `lib/localPrefsSync.ts` 로도 올라가 새 기기에서 앱을 그리기 **전에** 깔린다
 * (main.tsx 가 boot 동기화 뒤에 이 모듈을 불러오는 이유). 그 경로가 늦거나 막혀도 로그인 후 서버
 * `home_prefs.locale` 이 이긴다.
 */

export const LOCALES = ['ko', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ko';
export const LOCALE_STORAGE_KEY = 'pep.locale';
/** 언어 선택 메뉴 표기 — 각 언어의 자기 이름(endonym)이라 번역하지 않는다. */
export const LOCALE_NATIVE_NAME: Record<Locale, string> = { ko: '한국어', en: 'English' };

export function asLocale(v: unknown): Locale | null {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v) ? (v as Locale) : null;
}

function readCachedLocale(): Locale {
  try {
    return asLocale(localStorage.getItem(LOCALE_STORAGE_KEY)) ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function applyDocumentLang(lng: string) {
  document.documentElement.lang = asLocale(lng) ?? DEFAULT_LOCALE;
}

/** 지금 화면에 적용된 로케일. */
export function currentLocale(): Locale {
  return asLocale(i18n.resolvedLanguage ?? i18n.language) ?? DEFAULT_LOCALE;
}

/** 화면에 즉시 적용 + 캐시. 서버 저장은 호출부(`useLocaleSync().changeLocale`)가 한다. */
export function applyLocale(locale: Locale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch { /* 저장소 접근 불가 — 이번 세션에만 적용 */ }
  if (currentLocale() !== locale) void i18n.changeLanguage(locale);
}

void i18n.use(initReactI18next).init({
  resources: { ko: { translation: ko }, en: { translation: en } },
  lng: readCachedLocale(),
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: LOCALES,
  // 리소스가 번들에 들어 있으므로 동기 초기화 — 첫 렌더 전에 번역이 준비된다.
  initAsync: false,
  // React 가 이미 이스케이프한다.
  interpolation: { escapeValue: false },
  returnNull: false,
});

i18n.on('languageChanged', applyDocumentLang);
applyDocumentLang(i18n.language);

export default i18n;
