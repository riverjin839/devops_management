import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, X, Maximize2, Minimize2, ExternalLink } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { getAuthToken } from '@/stores/authStore';
import { k8sStreamUrls } from '@/services/api';

export interface K9sConnectParams {
  host: string;
  port: number;
  username: string;
  authMode: 'password' | 'key';
  password: string;
  privateKey: string;
  namespace?: string;
  readonly?: boolean;
}

type Status = 'connecting' | 'open' | 'closed' | 'error';

interface K9sTerminalProps {
  clusterId: string;
  params: K9sConnectParams;
  onClose: () => void;
  /** 주어지면 헤더에 "새 창으로 빼기" 버튼 노출 (별도 브라우저 창으로 세션 이동). */
  onPopOut?: () => void;
  /** 뷰포트 전체를 채운다 (팝업 창 전용). true 면 pop-out/전체화면 버튼은 숨긴다. */
  fill?: boolean;
}

/**
 * k9s TUI 웹 터미널 — control-plane 서버에 SSH 로 접속해 서버 내장 `k9s` 를
 * xterm.js 로 스트리밍한다. 백엔드가 paramiko PTY(invoke_shell) 로 브리지하며,
 * tty + resize 를 지원하므로 k9s 풀스크린 UI 가 그대로 동작한다.
 *
 * 토큰은 WS query param 으로, SSH 자격증명은 accept 직후 **init 프레임**(JSON)으로
 * 전달한다(비밀번호가 URL/로그에 남지 않도록). 이후 입력/리사이즈는 stdin/resize
 * 프레임으로 보낸다.
 */
export function K9sTerminal({ clusterId, params, onClose, onPopOut, fill }: K9sTerminalProps) {
  const [status, setStatus] = useState<Status>('connecting');
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
  const paramsRef = useRef(params);
  paramsRef.current = params;

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
    const url = k8sStreamUrls.k9s(clusterId, getAuthToken());
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus('open');
      fitRef.current?.fit();
      const p = paramsRef.current;
      // init 프레임 — SSH 자격증명 + 초기 터미널 크기
      ws.send(JSON.stringify({
        type: 'init',
        host: p.host,
        port: p.port,
        username: p.username,
        password: p.authMode === 'password' ? p.password : undefined,
        privateKey: p.authMode === 'key' ? p.privateKey : undefined,
        namespace: p.namespace || undefined,
        readonly: !!p.readonly,
        cols: term.cols,
        rows: term.rows,
      }));
      term.focus();
    };
    ws.onmessage = (ev) => term.write(String(ev.data));
    ws.onerror = () => setStatus('error');
    ws.onclose = (ev) => {
      setStatus('closed');
      const note =
        ev.code === 4401 ? '[인증 실패 — operator 권한이 필요합니다]'
        : ev.code === 4403 ? '[k9s SSH 기능이 비활성화되어 있습니다]'
        : ev.code === 4404 ? '[클러스터를 찾을 수 없습니다]'
        : ev.code === 1008 ? '[접속 정보 오류]'
        : '[연결 종료]';
      term.write(`\r\n\x1b[33m${note}\x1b[0m\r\n`);
    };
  }, [clusterId]);

  // xterm 마운트 (1회)
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#18181b' },
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

  // 최초 + params 변경 시 (재)연결
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
        <span className="text-sm font-semibold text-green-400">k9s</span>
        <span className="text-xs font-mono text-zinc-400 truncate">
          {params.username}@{params.host}:{params.port}
          {params.namespace ? ` · ns=${params.namespace}` : ''}
          {params.readonly ? ' · readonly' : ''}
        </span>
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
