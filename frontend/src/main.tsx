import React from 'react';
import ReactDOM from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import App from './App';
import './index.css';
import './stores/themeStore'; // initialise theme before first render
// 자체 호스팅 웹폰트 — CDN 의존 없이 번들에 포함(폐쇄망 배포 안전). 실제 다운로드는
// 해당 font-family 를 쓰는 요소가 있을 때만 발생(@font-face 는 선언만으로 로드되지 않음).
import '@fontsource-variable/outfit';
import '@fontsource-variable/geist';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
