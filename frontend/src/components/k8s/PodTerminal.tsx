import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon, X, RotateCw } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useQuery } from '@tanstack/react-query';
import { getAuthToken } from '@/stores/authStore';
import { analyzeApi, k8sStreamUrls } from '@/services/api';
import { attachClipboardShortcuts, clipboardHintText } from '@/lib/terminalClipboard';

interface PodTerminalProps {
  clusterId: string;
  namespace: string;
  pod: string;
  container?: string;
  onClose: () => void;
}

/**
 * Pod exec 인터랙티브 터미널 — xterm.js TTY (freelens/Lens 파리티).
 * WebSocket 으로 백엔드 exec 스트림에 연결한다. 입력/리사이즈는 JSON 프레임
 * (`{"type":"stdin"|"resize",...}`)으로 보내고 출력은 raw text 로 받는다.
 * 백엔드가 tty=True + resize 채널을 지원하므로 vi/top 같은 풀스크린 앱도 동작.
 * 토큰은 WS 가 Authorization 헤더를 못 보내므로 query param 으로 전달한다.
 */
export function PodTerminal({ clusterId, namespace, pod, container: initialContainer, onClose }: PodTerminalProps) {
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [container, setContainer] = useState(initialContainer ?? '');
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);

  // 컨테이너 드롭다운 (멀티컨테이너 파드)
  const { data: containersData } = useQuery({
    queryKey: ['pod-containers', clusterId, namespace, pod],
    queryFn: () => analyzeApi.podContainers(clusterId, namespace, pod).then((r) => r.data),
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!container && containersData?.defaultContainer) setContainer(containersData.defaultContainer);
  }, [containersData, container]);

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
    const url = k8sStreamUrls.exec(clusterId, namespace, pod, container || undefined, getAuthToken());
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => {
      setStatus('open');
      // 초기 크기 통지 (fit 이후)
      fitRef.current?.fit();
      sendResize();
      term.focus();
    };
    ws.onmessage = (ev) => term.write(String(ev.data));
    ws.onerror = () => setStatus('error');
    ws.onclose = (ev) => {
      setStatus('closed');
      const note =
        ev.code === 4401 ? '[인증 실패 — operator 권한이 필요합니다]'
        : ev.code === 4403 ? '[exec 기능이 비활성화되어 있습니다]'
        : ev.code === 4404 ? '[클러스터를 찾을 수 없습니다]'
        : ev.code === 4422 ? '[kubeconfig 미등록]'
        : '[연결 종료]';
      term.write(`\r\n\x1b[33m${note}\x1b[0m\r\n`);
    };
  }, [clusterId, namespace, pod, container, sendResize]);

  // xterm 마운트 (1회)
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#18181b' }, // zinc-900 모달과 통일
      scrollback: 5000,
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

  // 대상/컨테이너 변경 시 (재)연결
  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  const statusColor =
    status === 'open' ? 'text-green-500' : status === 'error' ? 'text-red-500' : 'text-muted-foreground';
  const containers = containersData?.containers?.filter((c) => !c.init) ?? [];

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex justify-center items-center p-4" onClick={onClose}>
      <div
        className="bg-zinc-900 text-zinc-100 w-full max-w-4xl h-[70vh] rounded-2xl border border-zinc-700 flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-700 bg-zinc-800">
          <TerminalIcon className="w-4 h-4 text-green-400" />
          <span className="text-sm font-medium truncate">{namespace}/{pod}</span>
          {containers.length > 1 ? (
            <select
              value={container}
              onChange={(e) => setContainer(e.target.value)}
              className="rounded-lg bg-zinc-700 border border-zinc-600 px-1.5 py-0.5 text-xs text-zinc-100"
              title="컨테이너"
            >
              {containers.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          ) : (
            container && <span className="text-xs text-zinc-400">· {container}</span>
          )}
          <span className={`text-xs ${statusColor}`}>● {status}</span>
          <span className="ml-auto hidden lg:inline text-[11px] text-zinc-500 truncate" title={clipboardHintText()}>
            {clipboardHintText()}
          </span>
          <button onClick={connect} title="재연결" className="lg:ml-2 ml-auto p-1 rounded hover:bg-zinc-700 text-zinc-400">
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={onClose} aria-label="닫기" className="p-1 rounded hover:bg-zinc-700 text-zinc-400">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div ref={mountRef} className="flex-1 min-h-0 p-2 [&_.xterm]:h-full" />
      </div>
    </div>
  );
}
