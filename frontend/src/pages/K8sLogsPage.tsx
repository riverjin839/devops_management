import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { ArrowLeft, Play, Square, Trash2, ScrollText, RefreshCw } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { LogViewTabs, NamespaceSingleSelect, PodSingleSelect } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import { getAuthToken } from '@/stores/authStore';

const MAX_LINES = 5000; // 브라우저 보호 — 최근 N줄만 유지

interface SseHandle { abort: () => void; }

/** 인증 fetch 기반 SSE 소비 (EventSource 는 Authorization 헤더 불가) */
function startLogStream(url: string, onLine: (l: string) => void, onError: (e: string) => void, onClose: () => void): SseHandle {
  const ac = new AbortController();
  const token = getAuthToken();
  fetch(url, { signal: ac.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then(async (resp) => {
      if (!resp.ok) { onError(`서버 오류 ${resp.status}`); return; }
      if (!resp.body) { onError('스트림 본문이 비어있습니다.'); return; }
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
            if (ln.startsWith('data:')) onLine(ln.slice(5).replace(/^ /, ''));
          }
        }
      }
      onClose();
    })
    .catch((e) => { if (!ac.signal.aborted) onError(String(e).slice(0, 200)); });
  return { abort: () => ac.abort() };
}

export function K8sLogsPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const { data: clusters = [] } = useClusters();

  useEffect(() => {
    if (!clusterId && clusters.length > 0) navigate(`/k8s-logs/${clusters[0].id}`, { replace: true });
  }, [clusterId, clusters, navigate]);

  const cluster = clusters.find((c) => c.id === clusterId);

  const [namespace, setNamespace] = useState('');
  const [pod, setPod] = useState('');
  const [container, setContainer] = useState('');
  const [tail, setTail] = useState(200);
  const [follow, setFollow] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const handleRef = useRef<SseHandle | null>(null);
  const scrollRef = useRef<HTMLPreElement | null>(null);

  const stop = useCallback(() => {
    handleRef.current?.abort();
    handleRef.current = null;
    setStreaming(false);
  }, []);

  const start = useCallback(() => {
    if (!clusterId || !namespace || !pod) return;
    stop();
    setLines([]);
    setErr('');
    const params = new URLSearchParams({
      tail_lines: String(tail),
      follow: String(follow),
    });
    if (container.trim()) params.set('container', container.trim());
    const url = `/api/v1/analyze/clusters/${clusterId}/namespaces/${namespace}/pods/${pod}/logs/stream?${params.toString()}`;
    setStreaming(true);
    handleRef.current = startLogStream(
      url,
      (l) => setLines((prev) => {
        const next = prev.length >= MAX_LINES ? prev.slice(prev.length - MAX_LINES + 1) : prev.slice();
        next.push(l);
        return next;
      }),
      (e) => { setErr(e); setStreaming(false); },
      () => setStreaming(false),
    );
  }, [clusterId, namespace, pod, container, tail, follow, stop]);

  // 언마운트/클러스터 변경 시 정리
  useEffect(() => () => { handleRef.current?.abort(); }, []);
  useEffect(() => { stop(); setNamespace(''); setPod(''); setLines([]); }, [clusterId, stop]);

  // 새 줄 도착 시 자동 스크롤(follow 중일 때)
  useEffect(() => {
    if (follow && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, follow]);

  const text = useMemo(() => lines.join('\n'), [lines]);

  return (
    <div className="min-h-screen bg-background p-3">
      <div className="flex gap-3 max-w-[1600px] mx-auto">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => { if (id) navigate(`/k8s-logs/${id}`); }}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
              <ArrowLeft className="w-3.5 h-3.5" /> 대시보드
            </Link>
            <h1 className="text-lg font-semibold min-w-[180px] flex items-center gap-2">
              <ScrollText className="w-4 h-4 text-primary" />
              {cluster ? `${cluster.name} — 실시간 로그` : '실시간 로그'}
            </h1>
            <div className="flex-1" />
            <LogViewTabs current="stream" />
          </div>

          <MacCard title="로그 스트림" bodyPadding="p-4">
            {/* 선택 컨트롤 */}
            <div className="flex items-end gap-2 flex-wrap mb-3">
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">네임스페이스</span>
                <div className="min-w-[200px]">
                  <NamespaceSingleSelect
                    clusterId={clusterId}
                    value={namespace}
                    onChange={(ns) => { setNamespace(ns); setPod(''); }}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">파드</span>
                <div className="min-w-[240px]">
                  <PodSingleSelect
                    clusterId={clusterId}
                    namespace={namespace}
                    value={pod}
                    onChange={setPod}
                  />
                </div>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">컨테이너(선택)</span>
                <input
                  value={container}
                  onChange={(e) => setContainer(e.target.value)}
                  placeholder="멀티컨테이너 시 지정"
                  className="rounded-lg border border-border bg-card px-2 py-1 text-sm w-40"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">tail</span>
                <input
                  type="number"
                  value={tail}
                  min={1}
                  max={5000}
                  onChange={(e) => setTail(Number(e.target.value) || 200)}
                  className="rounded-lg border border-border bg-card px-2 py-1 text-sm w-20"
                />
              </label>
              <label className="flex items-center gap-1.5 text-sm cursor-pointer pb-1.5">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-primary" />
                follow
              </label>
              {streaming ? (
                <button onClick={stop} className="inline-flex items-center gap-1.5 rounded-xl bg-red-500/90 text-white px-3 py-1.5 text-sm font-medium hover:bg-red-500">
                  <Square className="w-3.5 h-3.5" /> 중지
                </button>
              ) : (
                <button
                  onClick={start}
                  disabled={!pod}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90"
                >
                  <Play className="w-3.5 h-3.5" /> 스트림 시작
                </button>
              )}
              <button
                onClick={() => setLines([])}
                title="화면 지우기"
                className="inline-flex items-center gap-1.5 rounded-xl border border-border px-2 py-1.5 text-sm hover:bg-secondary"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {err && (
              <div className="mb-2 text-sm text-red-500 flex items-center gap-1.5">
                <RefreshCw className="w-3 h-3" /> {err}
              </div>
            )}

            {/* 로그 출력 — 다크 모노 박스, 최근 5000줄 */}
            <pre
              ref={scrollRef}
              className="h-[60vh] overflow-auto rounded-xl bg-zinc-950 text-zinc-100 text-xs leading-relaxed font-mono p-3 whitespace-pre-wrap break-all"
            >
              {text || (streaming ? '스트리밍 대기 중…' : '네임스페이스·파드를 선택하고 "스트림 시작"을 누르세요.')}
              {streaming && <span className="inline-block w-2 h-3 bg-zinc-400 animate-pulse align-middle ml-0.5" />}
            </pre>
            <p className="mt-1 text-xs text-muted-foreground">
              {lines.length}줄 (최대 {MAX_LINES}) · 읽기전용 · follow 중지는 "중지" 버튼
            </p>
          </MacCard>
        </div>
      </div>
    </div>
  );
}
