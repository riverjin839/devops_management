import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, X, Maximize2, Minimize2, ExternalLink, Clipboard, Timer } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useXtermTheme } from '@/hooks/useTerminalAppearance';
import { attachClipboardShortcuts, clipboardHintText } from '@/lib/terminalClipboard';
import { ConfirmDialog } from '@/components/common';

export type SshTerminalStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface SshTerminalWindowProps {
  /** 헤더 좌측 라벨 (예: `k9s`, `ssh`). */
  label: string;
  /** 라벨 색상 클래스 — 콘솔별 구분용. */
  labelClassName?: string;
  /** 헤더 부제 — 보통 `user@host:port` + 옵션 요약. */
  subtitle: string;
  /** 접속 대상 표기(`user@host:port`) — 창 `aria-label`·종료 확인 문구에 쓴다. 없으면 subtitle. */
  target?: string;
  /**
   * 접속할 WebSocket URL (인증 토큰 포함). 바뀌면 재연결한다. 함수면 (재)연결할 때마다 호출해
   * 그 시점의 토큰으로 URL 을 만든다 — 세션 재발급(R-7) 뒤 재연결이 옛 토큰으로 4401 나지 않게.
   */
  url: string | (() => string);
  /**
   * `onopen` 직후 1회 전송할 init 프레임의 화면별 필드.
   * `type`/`cols`/`rows` 는 이 컴포넌트가 채우므로 넣지 않는다.
   */
  init: Record<string, unknown>;
  onClose: () => void;
  /** 주어지면 헤더에 "새 창으로 빼기" 버튼 노출 (별도 브라우저 창으로 세션 이동). */
  onPopOut?: () => void;
  /** 뷰포트 전체를 채운다 (팝업 창 전용). true 면 pop-out/전체화면 버튼은 숨긴다. */
  fill?: boolean;
  /** WebSocket close code → 안내 문구. 미지정 코드는 공통 기본 문구를 쓴다. */
  closeNotes?: Record<number, string>;
  /** 연결 상태 변화 알림 — 페이지가 "열린 세션" 여부로 클러스터 전환 확인을 띄울 때 쓴다. */
  onStatusChange?: (status: SshTerminalStatus) => void;
  /** 서버 세션 상한(초) — `services/ssh_pty.py` `MAX_SESSION_SECONDS` 와 같다. 연장은 없다. */
  maxSessionSeconds?: number;
}

/** 서버 PTY 세션 상한(1시간, 정책 9) — 마지막 5분은 경고한다. */
export const SSH_SESSION_MAX_SECONDS = 60 * 60;
const SESSION_WARN_SECONDS = 5 * 60;

// 4401 = 토큰 만료·무효 전용, 4402 = 역할·클러스터 실행 권한 부족(정책 10, D-172).
const DEFAULT_CLOSE_NOTES: Record<number, string> = {
  4401: '[세션이 만료됐습니다 — 다시 로그인하세요]',
  4402: '[권한이 없습니다 — 이 클러스터의 실행 권한 또는 operator 이상 권한이 필요합니다]',
  4403: '[이 터미널 기능이 비활성화되어 있습니다]',
  4404: '[대상을 찾을 수 없습니다]',
  4413: '[이 클러스터에 실행 권한이 없습니다 — 테넌트 바인딩 확인]',
  1008: '[접속 정보 오류]',
};

const STATUS_LABEL: Record<SshTerminalStatus, string> = {
  connecting: '연결 중…',
  open: '연결됨',
  closed: '끊김',
  error: '오류',
};

function formatRemaining(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * SSH 웹 터미널 창 — 모든 SSH 콘솔(k9s 콘솔 · 노드 SSH 터미널)이 공유하는 base 툴.
 *
 * xterm.js ↔ WebSocket 브리지와 창 크롬(재연결/새 창으로 빼기/전체화면/종료, 드래그
 * 이동, 우하단 리사이즈)을 담당하고, 무엇을 실행할지는 `init` 프레임으로 위임한다.
 * 백엔드 대응 유틸은 `backend/app/services/ssh_pty.py`.
 *
 * 토큰은 WS query param 으로(`url`), SSH 자격증명은 accept 직후 **init 프레임**(JSON)
 * 으로 전달한다(비밀번호가 URL/로그에 남지 않도록). 이후 입력/리사이즈는 stdin/resize
 * 프레임으로 보낸다. 색·글꼴은 Settings → 터미널 Appearance 의 활성 프로파일을 따른다.
 */
export function SshTerminalWindow({
  label, labelClassName = '', subtitle, target, url, init,
  onClose, onPopOut, fill, closeNotes, onStatusChange,
  maxSessionSeconds = SSH_SESSION_MAX_SECONDS,
}: SshTerminalWindowProps) {
  const [status, setStatus] = useState<SshTerminalStatus>('connecting');
  // 세션 시작 시각(WS open) — 서버 상한까지 남은 시간을 헤더에 보여준다(D-177).
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [confirmClose, setConfirmClose] = useState(false);
  const warnedRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  // 플로팅 창 위치 (fill/전체화면이 아닌 기본 모드) — 헤더 드래그로 이동한다.
  const [pos, setPos] = useState(() => ({
    x: Math.max(16, Math.round((window.innerWidth - 1000) / 2)),
    y: Math.max(16, Math.round(window.innerHeight * 0.12)),
  }));
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const initRef = useRef(init);
  initRef.current = init;
  const closeNotesRef = useRef(closeNotes);
  closeNotesRef.current = closeNotes;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const targetLabel = target || subtitle;

  const appearance = useXtermTheme();
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;

  const sendResize = useCallback(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    if (term && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  }, []);

  const connect = useCallback(() => {
    wsRef.current?.close();
    const term = termRef.current;
    if (!term) return;
    term.reset();
    setStatus('connecting');
    setOpenedAt(null);
    warnedRef.current = false;
    const ws = new WebSocket(typeof url === 'function' ? url() : url);
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus('open');
      setOpenedAt(Date.now());
      setNow(Date.now());
      fitRef.current?.fit();
      // init 프레임 — SSH 자격증명 + 초기 터미널 크기
      ws.send(JSON.stringify({
        ...initRef.current,
        type: 'init',
        cols: term.cols,
        rows: term.rows,
      }));
      term.focus();
    };
    ws.onmessage = (ev) => term.write(String(ev.data));
    ws.onerror = () => { if (wsRef.current === ws) setStatus('error'); };
    ws.onclose = (ev) => {
      // 이미 다른 소켓으로 재연결했으면 옛 소켓의 close 는 상태에 반영하지 않는다.
      if (wsRef.current !== ws) return;
      setStatus('closed');
      setOpenedAt(null);
      const note = closeNotesRef.current?.[ev.code]
        ?? DEFAULT_CLOSE_NOTES[ev.code]
        ?? '[연결 종료]';
      term.write(`\r\n\x1b[33m${note}\x1b[0m\r\n`);
    };
  }, [url]);

  // xterm 마운트 (1회)
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const { theme, fontSize, fontFamily } = appearanceRef.current;
    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily,
      theme,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    // Ctrl+C(선택 복사) / Ctrl+V(붙여넣기) — xterm 기본값에는 없어 직접 붙인다.
    attachClipboardShortcuts(term);
    term.onData((d) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'stdin', data: d }));
      }
    });
    termRef.current = term;
    fitRef.current = fit;

    const ro = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Appearance 변경(템플릿/글꼴 전환, 운영↔개발 프로파일)을 살아있는 세션에도 반영.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = appearance.theme;
    term.options.fontSize = appearance.fontSize;
    term.options.fontFamily = appearance.fontFamily;
    // 글꼴 크기가 바뀌면 행/열 수가 달라지므로 리핏 후 서버에도 알린다.
    fitRef.current?.fit();
    sendResize();
  }, [appearance, sendResize]);

  // 최초 + url 변경 시 (재)연결
  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  useEffect(() => { onStatusChangeRef.current?.(status); }, [status]);

  // 남은 시간 tick — 열린 세션에서만 1초 간격.
  useEffect(() => {
    if (openedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [openedAt]);

  const remainingSec = openedAt === null ? null : maxSessionSeconds - (now - openedAt) / 1000;
  const nearLimit = remainingSec !== null && remainingSec <= SESSION_WARN_SECONDS;

  // 상한 5분 전 — 터미널에 안내 1줄(연장 없음, 정책 9). 세션당 1회.
  useEffect(() => {
    if (!nearLimit || warnedRef.current || status !== 'open') return;
    warnedRef.current = true;
    termRef.current?.write(
      '\r\n\x1b[33m[세션 상한(1시간)까지 5분 남았습니다 — 작업을 저장하세요. 상한이 되면 연결이 끊깁니다]\x1b[0m\r\n',
    );
  }, [nearLimit, status]);

  // 열린 세션에서 새로고침·탭 닫기·창 닫기는 브라우저 기본 경고로 막는다. (앱 내 메뉴 이동은
  // 선언형 BrowserRouter 라 `useBlocker` 를 쓸 수 없어 차단 대상이 아니다 — D-037 과 같은 한계)
  useEffect(() => {
    if (status !== 'open') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [status]);

  /** 종료 — 열린 세션이면 확인을 받는다(원격 셸 작업 유실 방지). */
  const requestClose = () => {
    if (status === 'open') setConfirmClose(true);
    else onClose();
  };

  // 전체화면 토글 후 리핏
  useEffect(() => {
    const id = setTimeout(() => { fitRef.current?.fit(); sendResize(); }, 60);
    return () => clearTimeout(id);
  }, [fullscreen, sendResize]);

  // 터미널 크롬(zinc)은 테마와 무관한 고정 다크 — 상태는 정상 중립, 오류만 강조.
  const statusColor = status === 'error' ? 'text-status-critical' : 'text-zinc-400';
  const clipboardHint = clipboardHintText();

  // 기본(인라인) 모드는 드래그로 이동 가능한 플로팅 창 — 헤더가 드래그 핸들이다.
  const floating = !fill && !fullscreen;

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!floating) return;
    // 헤더 위 버튼 클릭은 드래그 시작으로 취급하지 않는다.
    if ((e.target as HTMLElement).closest('button, select, a, input')) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      x: Math.min(Math.max(e.clientX - d.dx, 8), Math.max(8, window.innerWidth - 160)),
      y: Math.min(Math.max(e.clientY - d.dy, 8), Math.max(8, window.innerHeight - 56)),
    });
  };
  const onHeaderPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const rootClass = fill
    ? 'bg-zinc-900 text-zinc-100 flex flex-col h-screen w-screen'
    : fullscreen
      ? 'fixed inset-0 z-50 bg-zinc-900 flex flex-col'
      // resize(우하단 핸들)로 크기 조절 — ResizeObserver 가 xterm 을 자동 리핏한다.
      : 'fixed z-40 bg-zinc-900 text-zinc-100 rounded-2xl border border-zinc-700 flex flex-col overflow-hidden shadow-2xl resize min-w-[420px] min-h-[300px] w-[min(1000px,calc(100vw_-_32px))] h-[72vh]';

  return (
    <div
      role="region"
      aria-label={`${label} 터미널 — ${targetLabel}`}
      className={rootClass}
      // 좌표만 동적(드래그) — 크기는 클래스, 사용자가 우하단으로 바꾼 크기는 브라우저가 유지한다.
      style={floating ? { left: pos.x, top: pos.y } : undefined}
    >
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
        title={floating ? '드래그해서 창 이동' : undefined}
        className={`flex items-center gap-2 px-4 py-2.5 border-b border-zinc-700 bg-zinc-800 text-zinc-100 ${
          floating ? 'cursor-move select-none touch-none' : ''
        }`}
      >
        <span className={`text-sm font-semibold ${labelClassName}`}>{label}</span>
        <span className="text-xs font-mono text-zinc-400 truncate">{subtitle}</span>
        <span className={`inline-flex items-center gap-1 text-xs shrink-0 ${statusColor}`} role="status" aria-live="polite">
          <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-current" />
          {STATUS_LABEL[status]}
        </span>
        {remainingSec !== null && (
          <span
            className={`inline-flex items-center gap-1 text-xs font-mono shrink-0 ${nearLimit ? 'text-status-warning' : 'text-zinc-400'}`}
            title={`세션 상한 ${Math.round(maxSessionSeconds / 60)}분 — 남은 시간 (연장 불가)`}
            aria-label={`세션 남은 시간 ${formatRemaining(remainingSec)}`}
          >
            <Timer className="w-3 h-3" aria-hidden="true" />
            {formatRemaining(remainingSec)}
          </span>
        )}
        {/* 복사/붙여넣기 단축키는 발견되기 어려워(터미널마다 규칙이 달라서) 헤더에 노출한다.
            좁은 창에서는 숨기고 아이콘 title 로만 남긴다. */}
        <span className="ml-auto hidden xl:inline text-[11px] text-zinc-500 truncate" title={clipboardHint}>
          <Clipboard className="w-3 h-3 inline-block mr-1 -mt-px" />{clipboardHint}
        </span>
        <button onClick={connect} title="재연결" aria-label="재연결"
          className="xl:ml-2 ml-auto p-1 rounded hover:bg-zinc-700 text-zinc-400">
          <RotateCw className="w-3.5 h-3.5" />
        </button>
        {onPopOut && !fill && (
          <button onClick={onPopOut} title="새 창으로 빼기" aria-label="새 창으로 빼기"
            className="p-1 rounded hover:bg-zinc-700 text-zinc-400">
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
        {!fill && (
          <button onClick={() => setFullscreen((v) => !v)} title={fullscreen ? '전체화면 해제' : '전체화면'}
            aria-label={fullscreen ? '전체화면 해제' : '전체화면'}
            className="p-1 rounded hover:bg-zinc-700 text-zinc-400">
            {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        )}
        <button onClick={requestClose} aria-label={`세션 종료 — ${targetLabel}`} title="종료"
          className="p-1 rounded hover:bg-zinc-700 text-zinc-400">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div ref={mountRef} className="flex-1 min-h-0 p-2 [&_.xterm]:h-full" />
      <ConfirmDialog
        open={confirmClose}
        danger
        title="SSH 세션 종료"
        description={`연결된 SSH 세션을 끊습니다 — ${targetLabel}. 실행 중인 원격 작업(편집기·로그 추적 등)이 함께 종료됩니다.`}
        confirmLabel="세션 끊기"
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => { setConfirmClose(false); onClose(); }}
      />
    </div>
  );
}
