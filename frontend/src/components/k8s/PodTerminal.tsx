import { useEffect, useRef, useState } from 'react';
import { Terminal, X, Send, RotateCw } from 'lucide-react';
import { getAuthToken } from '@/stores/authStore';
import { k8sStreamUrls } from '@/services/api';

interface PodTerminalProps {
  clusterId: string;
  namespace: string;
  pod: string;
  container?: string;
  onClose: () => void;
}

/**
 * Pod exec 인터랙티브 터미널 — WebSocket 으로 백엔드 exec 스트림에 연결.
 * xterm 의존성 없이 경량 라인 기반 터미널(입력 한 줄 → 전송, 출력 누적)로 구현.
 * 토큰은 WS 가 Authorization 헤더를 못 보내므로 query param 으로 전달한다.
 */
export function PodTerminal({ clusterId, namespace, pod, container, onClose }: PodTerminalProps) {
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting');
  const [input, setInput] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const outRef = useRef<HTMLPreElement | null>(null);

  const connect = () => {
    wsRef.current?.close();
    setOutput('');
    setStatus('connecting');
    const url = k8sStreamUrls.exec(clusterId, namespace, pod, container, getAuthToken());
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => setStatus('open');
    ws.onmessage = (ev) => setOutput((prev) => (prev + String(ev.data)).slice(-100_000));
    ws.onerror = () => setStatus('error');
    ws.onclose = (ev) => {
      setStatus('closed');
      if (ev.code === 4401) setOutput((p) => p + '\n[인증 실패 — operator 권한이 필요합니다]\n');
      else if (ev.code === 4403) setOutput((p) => p + '\n[exec 기능이 비활성화되어 있습니다]\n');
      else if (ev.code === 4404) setOutput((p) => p + '\n[클러스터를 찾을 수 없습니다]\n');
      else if (ev.code === 4422) setOutput((p) => p + '\n[kubeconfig 미등록]\n');
    };
  };

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, namespace, pod, container]);

  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [output]);

  const send = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(input + '\n');
      setInput('');
    }
  };

  const statusColor =
    status === 'open' ? 'text-green-500' : status === 'error' ? 'text-red-500' : 'text-muted-foreground';

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex justify-center items-center p-4" onClick={onClose}>
      <div
        className="bg-zinc-900 text-zinc-100 w-full max-w-4xl h-[70vh] rounded-2xl border border-zinc-700 flex flex-col overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-700 bg-zinc-800">
          <Terminal className="w-4 h-4 text-green-400" />
          <span className="text-sm font-medium truncate">{namespace}/{pod}{container ? ` · ${container}` : ''}</span>
          <span className={`text-[11px] ${statusColor}`}>● {status}</span>
          <button onClick={connect} title="재연결" className="ml-auto p-1 rounded hover:bg-zinc-700 text-zinc-400">
            <RotateCw className="w-3.5 h-3.5" />
          </button>
          <button onClick={onClose} aria-label="닫기" className="p-1 rounded hover:bg-zinc-700 text-zinc-400">
            <X className="w-4 h-4" />
          </button>
        </div>
        <pre
          ref={outRef}
          className="flex-1 overflow-auto px-4 py-3 text-xs font-mono whitespace-pre-wrap break-all leading-relaxed"
        >
          {output || '연결 중…'}
        </pre>
        <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-700 bg-zinc-800">
          <span className="text-green-400 text-sm font-mono">$</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder="명령 입력 후 Enter (예: ls -al, cat /etc/hosts)"
            disabled={status !== 'open'}
            className="flex-1 bg-transparent text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:opacity-50"
            autoFocus
          />
          <button
            onClick={send}
            disabled={status !== 'open'}
            className="p-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 disabled:opacity-40"
            title="전송"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
