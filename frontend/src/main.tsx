import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
// 자체 호스팅 웹폰트 — CDN 의존 없이 번들에 포함(폐쇄망 배포 안전). 실제 다운로드는
// 해당 font-family 를 쓰는 요소가 있을 때만 발생(@font-face 는 선언만으로 로드되지 않음).
import '@fontsource-variable/outfit';
import '@fontsource-variable/geist';
import { bootLocalPrefsSync } from './lib/localPrefsSync';

// 다른 기기에서 바꾼 화면 설정(그룹 접힘·보기 모드 등)을 앱을 불러오기 **전에** localStorage 에 깐다 —
// store·화면이 모듈 로드 때 그 값을 읽기 때문이다. 서버가 늦으면 1.5초 뒤 이 기기 설정으로 그냥 뜬다.
async function start() {
  await bootLocalPrefsSync().catch(() => undefined);
  await import('./stores/themeStore'); // initialise theme before first render
  // R-6 i18n — boot 동기화가 깐 `pep.locale` 을 읽어야 하므로 그 뒤에 초기화한다(정적 import 금지).
  await import('./i18n');
  const [{ default: App }, { ErrorBoundary }] = await Promise.all([
    import('./App'),
    import('./components/ErrorBoundary'),
  ]);
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

void start();
