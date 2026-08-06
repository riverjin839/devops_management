import type { Terminal } from '@xterm/xterm';

/**
 * 웹 터미널(xterm.js)에 Ctrl+C 복사 / Ctrl+V 붙여넣기를 붙인다 — 모든 SSH·exec 터미널 공용.
 *
 * **왜 필요한가**: xterm.js 기본 동작에는 복사/붙여넣기가 없다. keydown 이
 * `Ctrl+<A-Z>` → 제어문자로 매핑된 뒤 `preventDefault()` 되기 때문에
 *   - `Ctrl+C` → `\x03`(SIGINT) 만 나가고 선택 영역은 복사되지 않는다.
 *   - `Ctrl+V` → `\x16`(^V) 이 셸로 나가고 브라우저 기본 붙여넣기가 취소된다.
 * 그래서 운영자가 명령을 복사해 붙여넣지 못한다.
 *
 * **어떻게 고치는가**: `attachCustomKeyEventHandler` 가 `false` 를 반환하면 xterm 은
 * `preventDefault()` **전에** 즉시 빠져나온다(`CoreBrowserTerminal._keyDown` 첫 줄).
 * 즉 브라우저 기본 동작이 그대로 살아나고, xterm 이 이미 등록해 둔 리스너가 받아준다:
 *   - `copy`  → 터미널 선택 텍스트를 `clipboardData` 에 채운다.
 *   - `paste` → helper textarea 의 붙여넣기 내용을 stdin 으로 흘린다(bracketed paste 포함).
 *
 * 덕분에 `navigator.clipboard` 를 쓰지 않는다 — 이 API 는 보안 컨텍스트(HTTPS/localhost)
 * 전용이라, NodePort(`http://<node>:30080`) 로 접속하는 폐쇄망 환경에서는 아예 없다.
 * 브라우저 기본 동작에 위임하는 이 방식은 HTTP 에서도 그대로 동작한다.
 */

/** macOS 는 복사/붙여넣기가 Cmd 조합이고 Ctrl+C 는 항상 SIGINT 여야 한다. */
function isMac(): boolean {
  // userAgentData 우선, 없으면 legacy platform (Safari/구버전 대응).
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || navigator.platform || '';
  return /mac|iphone|ipad/i.test(platform);
}

export function attachClipboardShortcuts(term: Terminal): void {
  const mac = isMac();

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || ev.altKey) return true;
    // 복사/붙여넣기 조합키: macOS 는 Cmd, 그 외는 Ctrl.
    const mod = mac ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && !ev.metaKey;
    if (!mod) return true;

    const key = ev.key.toLowerCase();

    if (key === 'c') {
      // 선택 영역이 있을 때만 복사로 가로챈다. 선택이 없으면 그대로 통과시켜
      // SIGINT(^C) 가 나가야 한다 — 실행 중인 명령을 끊는 건 터미널의 기본 기능이다.
      // (macOS 는 Cmd+C 만 여기 오므로 Ctrl+C 는 항상 SIGINT.)
      if (!term.hasSelection()) return true;
      // 선택을 지우는 건 브라우저 copy 이벤트가 선택 텍스트를 읽어간 **뒤**여야 한다.
      // 여기서 동기적으로 지우면 xterm 의 copy 리스너가 빈 선택을 보고 아무것도 복사하지
      // 않는다. 선택을 남겨두면 다음 Ctrl+C 도 복사로 먹혀 SIGINT 를 못 보내므로
      // (운영 중 "Ctrl+C 가 안 먹는다") 복사 직후 해제한다.
      setTimeout(() => term.clearSelection(), 0);
      return false; // preventDefault 없이 빠져나감 → 브라우저 기본 복사 진행
    }

    if (key === 'v') {
      // shift 조합(Ctrl+Shift+V)은 xterm 이 제어문자로 바꾸지 않아 원래도 동작한다.
      return false; // 브라우저 기본 붙여넣기 → xterm 의 textarea paste 리스너가 처리
    }

    return true;
  });
}

/** 헤더/툴팁에 노출할 단축키 안내 — 화면마다 문구가 갈리지 않게 여기서 고정한다. */
export function clipboardHintText(): string {
  return isMac()
    ? '복사: 드래그로 선택 후 ⌘C · 붙여넣기: ⌘V (Ctrl+C 는 SIGINT)'
    : '복사: 드래그로 선택 후 Ctrl+C · 붙여넣기: Ctrl+V (선택이 없으면 Ctrl+C 는 SIGINT)';
}
