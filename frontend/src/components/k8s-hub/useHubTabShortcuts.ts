import { useEffect, useRef } from 'react';

/** 글자를 입력 중인 요소(입력창·터미널 포함)인지 — 이때는 `[` `]` 를 그대로 입력하게 둔다. */
function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * 허브 화면 단축키 — `[` 이전 화면, `]` 다음 화면.
 * 브라우저 기본 단축키(Ctrl+Tab·Ctrl+숫자·Alt+←/→)나 앱의 Ctrl+K 와 겹치지 않고, Tab 키(포커스 이동)는 건드리지 않는다.
 * 입력 중이거나 모달이 열려 있거나 수정키가 눌려 있으면 동작하지 않는다. 처음/끝에서는 순환하지 않는다.
 *
 * @param ids 이동 순서대로 나열한 화면 id (접근 제어를 통과한 것만)
 * @param activeId 현재 화면 id
 * @param go 화면 이동
 */
export function useHubTabShortcuts(ids: readonly string[], activeId: string, go: (id: string) => void) {
  const ref = useRef({ ids, activeId, go });
  ref.current = { ids, activeId, go };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' && e.key !== ']') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.repeat) return;
      if (isTyping(e.target)) return;
      // 닫힌 사이드 패널(`SidePane`)은 aria-hidden 으로 DOM 에 남아 있다 — 그것까지 세면 단축키가 늘 꺼진다(D-246 에서 수정).
      if (document.querySelector('[role="dialog"]:not([aria-hidden="true"]), [role="alertdialog"]:not([aria-hidden="true"])')) return;
      const { ids: list, activeId: cur, go: navigate } = ref.current;
      const i = list.indexOf(cur);
      if (i < 0) return;
      const next = list[i + (e.key === ']' ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      navigate(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
