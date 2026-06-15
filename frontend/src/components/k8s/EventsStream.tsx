import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Search } from 'lucide-react';
import { getAuthToken } from '@/stores/authStore';
import { k8sStreamUrls } from '@/services/api';
import { NamespaceMultiSelect } from '@/components/k8s/NamespaceMultiSelect';

interface K8sEvent {
  watchType?: string;
  type?: string; // Normal | Warning
  reason?: string;
  message?: string;
  namespace?: string | null;
  involvedKind?: string | null;
  involvedName?: string | null;
  source?: string | null;
  count?: number | null;
  firstTimestamp?: string | null;
  lastTimestamp?: string | null;
}

const MAX_EVENTS = 1000;
const COLS = 'grid-cols-[70px_120px_120px_1fr_150px_110px_46px_80px]';

function rel(iso?: string | null): string {
  if (!iso) return '<unknown>';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '<unknown>';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

interface Props {
  clusterId: string;
  selectedNs: Set<string>;
  onSelectedNsChange: (s: Set<string>) => void;
}

/** 클러스터 이벤트 SSE 뷰어 — 전체 스트림 + 클라이언트 필터(네임스페이스 멀티셀렉트/타입/검색). */
export function EventsStream({ clusterId, selectedNs, onSelectedNsChange }: Props) {
  const [events, setEvents] = useState<K8sEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [err, setErr] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'Normal' | 'Warning'>('all');
  const [search, setSearch] = useState('');
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
    fetch(k8sStreamUrls.events(clusterId), {
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

  useEffect(() => {
    start();
    return () => acRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
      if (selectedNs.size > 0 && !(e.namespace && selectedNs.has(e.namespace))) return false;
      if (typeFilter !== 'all' && e.type !== typeFilter) return false;
      if (q && !`${e.reason ?? ''} ${e.message ?? ''} ${e.involvedKind ?? ''} ${e.involvedName ?? ''} ${e.source ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [events, selectedNs, typeFilter, search]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {streaming ? (
          <button onClick={stop} className="inline-flex items-center gap-1.5 rounded-xl bg-red-500/10 text-red-600 border border-red-500/30 px-3 py-1.5 text-sm font-medium">
            <Square className="w-3.5 h-3.5" /> 중지
          </button>
        ) : (
          <button onClick={start} className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium">
            <Play className="w-3.5 h-3.5" /> 재시작
          </button>
        )}

        <NamespaceMultiSelect clusterId={clusterId} selected={selectedNs} onChange={onSelectedNsChange} />

        <div className="inline-flex rounded-xl border border-border overflow-hidden">
          {(['all', 'Normal', 'Warning'] as const).map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)}
              className={`px-2.5 py-1.5 text-sm font-medium ${typeFilter === t ? (t === 'Warning' ? 'bg-amber-500/15 text-amber-600' : 'bg-primary text-primary-foreground') : 'bg-card text-muted-foreground hover:bg-secondary/60'}`}>
              {t === 'all' ? '전체' : t}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="이벤트 검색"
            className="rounded-xl border border-border bg-card pl-7 pr-2 py-1.5 text-sm w-44 focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>

        <span className="text-sm text-muted-foreground ml-auto">{filtered.length} / {events.length}건</span>
        {err && <span className="text-sm text-red-500">· {err}</span>}
      </div>

      <div className="rounded-xl border border-border overflow-hidden">
        <div className={`grid ${COLS} gap-2 px-3 py-1.5 text-xs font-semibold text-muted-foreground bg-secondary/30 border-b border-border`}>
          <span>유형</span><span>네임스페이스</span><span>Reason</span><span>메시지</span><span>대상</span><span>Source</span><span className="text-right">횟수</span><span className="text-right">Last Seen</span>
        </div>
        <div className="max-h-[60vh] overflow-auto">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {streaming ? '조건에 맞는 이벤트 대기 중…' : '재시작을 눌러 이벤트를 수신하세요.'}
            </div>
          ) : (
            filtered.map((e, i) => (
              <div key={i} className={`grid ${COLS} gap-2 px-3 py-1.5 text-sm border-b border-border/40 items-center`}>
                <span className={e.type === 'Warning' ? 'text-amber-600 font-medium' : 'text-muted-foreground'}>{e.type ?? '-'}</span>
                <span className="truncate text-muted-foreground">{e.namespace ?? '-'}</span>
                <span className="truncate font-medium" title={e.reason ?? ''}>{e.reason ?? '-'}</span>
                <span className="truncate" title={e.message ?? ''}>{e.message}</span>
                <span className="truncate text-muted-foreground" title={`${e.involvedKind}/${e.involvedName}`}>{e.involvedKind}: {e.involvedName}</span>
                <span className="truncate text-muted-foreground" title={e.source ?? ''}>{e.source ?? '-'}</span>
                <span className="text-right text-muted-foreground tabular-nums">{e.count ?? '-'}</span>
                <span className="text-right text-muted-foreground tabular-nums">{rel(e.lastTimestamp)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
