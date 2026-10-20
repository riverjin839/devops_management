import 'i18next';
import type { ko } from './resources/ko';

// t('...') 키를 컴파일 타임에 검사한다 — 없는 키를 쓰면 tsc 가 실패한다(ko.ts 가 키의 원천).
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof ko };
  }
}
