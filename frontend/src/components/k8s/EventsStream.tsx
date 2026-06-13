import { useEffect, useRef, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { getAuthToken } from '@/stores/authStore';
import { k8sStreamUrls } from '@/services/api';

interface K8sEvent {
  watchType?: string;
  type?: string; // Normal | Warning
  reason?: string;
  message?: string;
  namespace?: string | null;
  involvedKind?: string | null;
  involvedName?: string | null;
  count?: number | null;
  lastTimestamp?: string | null;
}

const MAX_EVENTS = 500;

/** 클러스터 이벤트 SSE 뷰어 (Lens Events 탭). 인증 fetch + ReadableStream 으로 소비. */
export function EventsStream({ clusterId, namespace }: { clusterId: string; namespace?: string }) {
  const [events, setEvents] = useState<K8sEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState('');
  const acRef = useRef<AbortController | null>(null);

  const stop = () => {
    acRef.current?.abort();
    acRef.current = null;
    setStreaming(false);
  };

  const start = () => {
    stop();
    setEvents([]);
    setErr('');
    const ac = new AbortController();
    acRef.current = ac;
    setStreaming(true);
    const token = getAuthToken();
    fetch(k8sStreamUrls.events(clusterId, namespace), {
      signal: ac.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) { setErr(`서버 오류 ${resp.status}`); setStreaming(false); return; }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const ln of block.split('\n')) {
              if (!ln.startsWith('data:')) continue;
              try {
                const obj = JSON.parse(ln.slice(5).trim());
                if (obj.error) { setErr(String(obj.error)); continue; }
                setEvents((prev) => [obj as K8sEvent, ...prev].slice(0, MAX_EVENTS));
              } catch { /* skip malformed */ }
            }
          }
        }
        setStreaming(false);
      })
      .catch((e) => { if (!ac.signal.aborted) { setErr(String(e).slice(0, 200)); setStreaming(false); } });
  };

  useEffect(() => () => acRef.current?.abort(), []);
  useEffect(() => {
    stop();
    setEvents([]);
  }, [clusterId, namespace]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {streaming ? (
          <button onClick={stop} className="inline-flex items-center gap-1.5 rounded-xl bg-red-500/10 text-red-600 border border-red-500/30 px-3 py-1.5 text-xs font-medium">
            <Square className="w-3.5 h-3.5" /> 중지
          </button>
        ) : (
          <button onClick={start} className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium">
            <Play className="w-3.5 h-3.5" /> 이벤트 스트림 시작
          </button>
        )}
        <span className="text-xs text-muted-foreground">{events.length}건{namespace ? ` · ns=${namespace}` : ' · 전체'}</span>
        {err && <span className="text-xs text-red-500">· {err}</span>}
      </div>
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="grid grid-cols-[70px_120px_1fr_70px] gap-2 px-3 py-1.5 text-[10px] font-semibold text-muted-foreground bg-secondary/30 border-b border-border">
          <span>유형</span><span>대상</span><span>메시지</span><span className="text-right">횟수</span>
        </div>
        <div className="max-h-[60vh] overflow-auto">
          {events.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {streaming ? '이벤트 대기 중…' : '시작 버튼을 눌러 이벤트를 수신하세요.'}
            </div>
          ) : (
            events.map((e, i) => (
              <div key={i} className="grid grid-cols-[70px_120px_1fr_70px] gap-2 px-3 py-1.5 text-xs border-b border-border/40">
                <span className={e.type === 'Warning' ? 'text-amber-600 font-medium' : 'text-muted-foreground'}>{e.type ?? '-'}</span>
                <span className="truncate text-muted-foreground" title={`${e.involvedKind}/${e.involvedName}`}>
                  {e.involvedKind}/{e.involvedName}
                </span>
                <span className="truncate" title={e.message ?? ''}>
                  <span className="font-medium">{e.reason}</span> {e.message}
                </span>
                <span className="text-right text-muted-foreground tabular-nums">{e.count ?? '-'}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
