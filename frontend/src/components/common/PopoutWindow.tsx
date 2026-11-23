// 로그 새 창(팝업) — 자식을 브라우저 우측 상단에 띄운 별도 창으로 portal 한다.
// 같은 React 트리라 실시간 로그(state 갱신)가 그대로 따라가고, 테마·스타일은 열 때 복사 + 변경을 계속 동기화한다.
// 팝업이 차단되면 onBlocked 로 알려 호출 측이 화면 안 표시로 폴백한다.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** 창 이름(같은 이름이면 같은 창을 재사용). */
  name: string;
  title: string;
  width?: number;
  height?: number;
  /** 사용자가 창을 닫았을 때. */
  onClose: () => void;
  /** 팝업 차단 등으로 창을 열지 못했을 때. */
  onBlocked?: () => void;
  /** 값이 바뀌면 이미 열린 창을 앞으로 가져온다. */
  focusKey?: number;
  children: React.ReactNode;
}

// 동시에 여러 로그 창이 열리면 같은 자리에 겹치지 않게 조금씩 비켜 놓는다.
let openSlots = 0;

function cloneStyles(src: Document, dst: Document) {
  src.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((n) => appendStyle(n, dst));
}

function appendStyle(n: Node, dst: Document) {
  if (n instanceof HTMLLinkElement && n.rel === 'stylesheet') {
    const l = dst.createElement('link');
    l.rel = 'stylesheet';
    l.href = n.href; // 절대 URL — about:blank 창에서도 풀린다
    dst.head.appendChild(l);
  } else if (n instanceof HTMLStyleElement) {
    const s = dst.createElement('style');
    s.textContent = n.textContent;
    dst.head.appendChild(s);
  }
}

/** <html> 의 테마 클래스·data-accent 등 속성을 팝업에 그대로 옮긴다. */
function syncRoot(src: HTMLElement, dst: HTMLElement) {
  for (const a of Array.from(dst.attributes)) if (!src.hasAttribute(a.name)) dst.removeAttribute(a.name);
  for (const a of Array.from(src.attributes)) dst.setAttribute(a.name, a.value);
}

export function PopoutWindow({
  name, title, width = 760, height = 640, onClose, onBlocked, focusKey, children,
}: Props) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const winRef = useRef<Window | null>(null);
  const cbRef = useRef({ onClose, onBlocked, title });
  useEffect(() => { cbRef.current = { onClose, onBlocked, title }; });

  useEffect(() => {
    const slot = openSlots++;
    const offset = (slot % 6) * 32;
    // 현재 브라우저 창의 우측 상단 기준(멀티 모니터에서도 앱 창 옆에 뜬다).
    const left = Math.max(0, window.screenX + window.outerWidth - width - 24 - offset);
    const top = Math.max(0, window.screenY + 72 + offset);
    const win = window.open(
      '', `pep-log-${name}`,
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
    );
    if (!win) {
      openSlots = Math.max(0, openSlots - 1);
      cbRef.current.onBlocked?.();
      return;
    }
    winRef.current = win;
    const doc = win.document;
    doc.head.replaceChildren();
    doc.body.replaceChildren();
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    doc.head.appendChild(meta);
    doc.title = cbRef.current.title;
    cloneStyles(document, doc);
    syncRoot(document.documentElement, doc.documentElement);
    doc.body.className = 'bg-background text-foreground antialiased';
    const el = doc.createElement('div');
    el.className = 'h-screen flex flex-col gap-2 p-2 min-h-0';
    doc.body.appendChild(el);

    // 테마 전환·새로 로드된 청크 CSS 를 따라간다.
    const rootObs = new MutationObserver(() => syncRoot(document.documentElement, doc.documentElement));
    rootObs.observe(document.documentElement, { attributes: true });
    const headObs = new MutationObserver((muts) => {
      for (const m of muts) m.addedNodes.forEach((n) => appendStyle(n, doc));
    });
    headObs.observe(document.head, { childList: true });

    const poll = window.setInterval(() => {
      if (win.closed) {
        window.clearInterval(poll);
        cbRef.current.onClose();
      }
    }, 500);
    const closeWithParent = () => win.close();
    window.addEventListener('beforeunload', closeWithParent);
    setContainer(el);

    return () => {
      rootObs.disconnect();
      headObs.disconnect();
      window.clearInterval(poll);
      window.removeEventListener('beforeunload', closeWithParent);
      openSlots = Math.max(0, openSlots - 1);
      winRef.current = null;
      setContainer(null);
      if (!win.closed) win.close();
    };
  }, [name, width, height]);

  useEffect(() => {
    if (winRef.current && !winRef.current.closed) winRef.current.document.title = title;
  }, [title]);

  useEffect(() => {
    if (focusKey !== undefined && winRef.current && !winRef.current.closed) winRef.current.focus();
  }, [focusKey]);

  return container ? createPortal(children, container) : null;
}
