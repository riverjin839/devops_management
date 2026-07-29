import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, X, Maximize2, Minimize2, ExternalLink } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useXtermTheme } from '@/hooks/useTerminalAppearance';

export type SshTerminalStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface SshTerminalWindowProps {
  /** 헤더 좌측 라벨 (예: `k9s`, `ssh`). */
  label: string;
  /** 라벨 색상 클래스 — 콘솔별 구분용. */
  labelClassName?: string;
  /** 헤더 부제 — 보통 `user@host:port` + 옵션 요약. */
  subtitle: string;
  /** 접속할 WebSocket URL (인증 토큰 포함). 바뀌면 재연결한다. */
  url: string;
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
}

const DEFAULT_CLOSE_NOTES: Record<number, string> = {
  4401: '[인증 실패 — operator 권한이 필요합니다]',
  4403: '[이 터미널 기능이 비활성화되어 있습니다]',
  4404: '[대상을 찾을 수 없습니다]',
  1008: '[접속 정보 오류]',
};

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
  label, labelClassName = 'text-green-400', subtitle, url, init,
  onClose, onPopOut, fill, closeNotes,
}: SshTerminalWindowProps) {
  const [status, setStatus] = useState<SshTerminalStatus>('connecting');
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
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus('open');
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
    ws.onerror = () => setStatus('error');
    ws.onclose = (ev) => {
      setStatus('closed');
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

  // 전체화면 토글 후 리핏
  useEffect(() => {
    const id = setTimeout(() => { fitRef.current?.fit(); sendResize(); }, 60);
    return () => clearTimeout(id);
  }, [fullscreen, sendResize]);

  const statusColor =
    status === 'open' ? 'text-green-500' : status === 'error' ? 'text-red-500' : 'text-muted-foreground';

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
      : 'fixed z-40 bg-zinc-900 text-zinc-100 rounded-2xl border border-zinc-700 flex flex-col overflow-hidden shadow-2xl resize min-w-[420px] min-h-[300px]';

  return (
    <div
      className={rootClass}
      style={floating ? { left: pos.x, top: pos.y, width: 'min(1000px, calc(100vw - 32px))', height: '72vh' } : undefined}
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
        <span className={`text-xs ${statusColor}`}>● {status}</span>
        <button onClick={connect} title="재연결" aria-label="재연결"
          className="ml-auto p-1 rounded hover:bg-zinc-700 text-zinc-400">
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
        <button onClick={onClose} aria-label="종료" title="종료"
          className="p-1 rounded hover:bg-zinc-700 text-zinc-400">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div ref={mountRef} className="flex-1 min-h-0 p-2 [&_.xterm]:h-full" />
    </div>
  );
}
