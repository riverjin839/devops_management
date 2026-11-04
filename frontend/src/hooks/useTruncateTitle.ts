import { useEffect } from 'react';

/**
 * 말줄임(`truncate`·`line-clamp`)으로 잘린 글자의 전체 값을 `title` 로 채운다 — 앱 전체 안전망.
 * 말줄임은 데이터 손실이라(특히 끝에서 갈리는 이름), 손이 닿는 순간 잘린 요소에 전체 텍스트를 붙인다.
 * 이미 `title` 이 있으면 건드리지 않고, 잘리지 않았으면 아무것도 하지 않는다. 이벤트 위임 1개라 비용이 거의 없다.
 */
export function useTruncateTitle() {
  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      let el = e.target instanceof HTMLElement ? e.target : null;
      // 자식(아이콘·span)에 올려도 잘린 조상을 찾는다 — 4단계까지.
      for (let i = 0; el && i < 4; i += 1, el = el.parentElement) {
        if (el.hasAttribute('title') || el.hasAttribute('data-no-auto-title')) return;
        const cs = getComputedStyle(el);
        const clipped =
          (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) ||
          (cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && el.scrollHeight > el.clientHeight + 1);
        if (clipped) {
          const text = el.textContent?.trim();
          if (text) el.setAttribute('title', text);
          return;
        }
      }
    };
    document.addEventListener('mouseover', onOver, { passive: true });
    return () => document.removeEventListener('mouseover', onOver);
  }, []);
}
