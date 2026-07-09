import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, Square, Trash2, Download, Search, WrapText, Clock, History,
  ChevronUp, ChevronDown, RefreshCw, Regex,
} from 'lucide-react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useQuery } from '@tanstack/react-query';
import { getAuthToken } from '@/stores/authStore';
import { analyzeApi, k8sStreamUrls } from '@/services/api';
import { useLogTheme } from '@/hooks/useTerminalAppearance';
import { classifyLine, stripAnsi, tokenize } from '@/components/common/logLine';

const MAX_LINES = 20_000; // 가상화 도입으로 상향 — 뷰포트 행만 렌더되므로 안전

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

// SSE 는 항상 timestamps=true 로 받는다 — 표시는 토글(freelens 패턴).
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s?(.*)$/;

function splitTimestamp(line: string): { ts: string | null; body: string } {
  const m = line.match(TS_RE);
  if (m) return { ts: m[1], body: m[2] };
  return { ts: null, body: line };
}

/** 검색 매치 하이라이트 렌더 — 매치 라인은 토큰 컬러 대신 하이라이트 우선. */
function renderHighlighted(body: string, re: RegExp): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) out.push(body.slice(last, m.index));
    out.push(
      <mark key={m.index} className="bg-amber-400/50 text-inherit rounded-[2px] px-px">
        {m[0]}
      </mark>,
    );
    last = re.lastIndex;
    if (last === m.index) re.lastIndex = m.index + 1; // 0-width 방지
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}

interface PodLogStreamProps {
  clusterId: string;
  namespace: string;
  pod: string;
  /** 마운트/파드 변경 시 자동 스트림 시작 (딥링크용) */
  autoStart?: boolean;
  initialContainer?: string;
  heightClass?: string; // 기본 h-[60vh]
}

/**
 * OpenLens/freelens 급 파드 로그 스트림 뷰 — SSE follow 유지 + 컨테이너 드롭다운,
 * previous/timestamps/word-wrap 토글, 검색(prev/next+하이라이트), 다운로드, 가상화.
 */
export function PodLogStream({
  clusterId, namespace, pod, autoStart = false, initialContainer, heightClass = 'h-[60vh]',
}: PodLogStreamProps) {
  const [container, setContainer] = useState(initialContainer ?? '');
  const [tail, setTail] = useState(200);
  const [follow, setFollow] = useState(true);
  const [previous, setPrevious] = useState(false);
  const [showTs, setShowTs] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [err, setErr] = useState('');

  // 검색
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [activeMatch, setActiveMatch] = useState(0);

  const handleRef = useRef<SseHandle | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const { style: themeStyle } = useLogTheme();

  // 컨테이너 목록 (init 포함) — default-container 어노테이션 존중
  const { data: containersData } = useQuery({
    queryKey: ['pod-containers', clusterId, namespace, pod],
    queryFn: () => analyzeApi.podContainers(clusterId, namespace, pod).then((r) => r.data),
    enabled: !!clusterId && !!namespace && !!pod,
    staleTime: 30_000,
  });

  // 파드가 바뀌면 컨테이너 선택 초기화 → default 로
  useEffect(() => {
    setContainer(initialContainer ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, namespace, pod]);
  useEffect(() => {
    if (!container && containersData?.defaultContainer) {
      setContainer(containersData.defaultContainer);
    }
  }, [containersData, container]);

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
    const url = k8sStreamUrls.logsStream(clusterId, namespace, pod, {
      container: container || undefined,
      tailLines: tail,
      follow,
      previous,
      timestamps: true, // 항상 수신, 표시만 토글
    });
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
  }, [clusterId, namespace, pod, container, tail, follow, previous, stop]);

  // 언마운트/대상 변경 시 정리
  useEffect(() => () => { handleRef.current?.abort(); }, []);
  useEffect(() => { stop(); setLines([]); setErr(''); }, [clusterId, namespace, pod, stop]);

  // 딥링크 자동 시작 — 컨테이너 결정(또는 목록 로드) 후 1회
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    if (!clusterId || !namespace || !pod) return;
    if (!container && !containersData) return; // 컨테이너 확정 대기
    autoStartedRef.current = true;
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, clusterId, namespace, pod, container, containersData]);

  // 검색 정규식 (잘못된 패턴은 무시)
  const searchRe = useMemo<RegExp | null>(() => {
    const q = query.trim();
    if (!q) return null;
    try {
      return useRegex
        ? new RegExp(q, 'gi')
        : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch {
      return null;
    }
  }, [query, useRegex]);

  // 매치 라인 인덱스
  const matches = useMemo<number[]>(() => {
    if (!searchRe) return [];
    const out: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      searchRe.lastIndex = 0;
      if (searchRe.test(stripAnsi(lines[i]))) out.push(i);
    }
    return out;
  }, [lines, searchRe]);

  useEffect(() => { setActiveMatch(0); }, [query, useRegex]);

  const jumpTo = useCallback((matchIdx: number) => {
    if (matches.length === 0) return;
    const bounded = ((matchIdx % matches.length) + matches.length) % matches.length;
    setActiveMatch(bounded);
    virtuosoRef.current?.scrollToIndex({ index: matches[bounded], align: 'center' });
  }, [matches]);

  // 표시용 텍스트 생성 (다운로드 "보이는 로그" 공용)
  const displayLine = useCallback((raw: string): string => {
    const clean = stripAnsi(raw);
    const { ts, body } = splitTimestamp(clean);
    return showTs && ts ? `${ts} ${body}` : body;
  }, [showTs]);

  const downloadVisible = useCallback(() => {
    const text = lines.map(displayLine).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${pod}_${container || 'default'}.visible.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [lines, displayLine, pod, container]);

  const [downloadingAll, setDownloadingAll] = useState(false);
  const downloadAll = useCallback(async () => {
    setDownloadingAll(true);
    try {
      const token = getAuthToken();
      const url = k8sStreamUrls.logsDownload(clusterId, namespace, pod, container || undefined, previous);
      const resp = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!resp.ok) throw new Error(`서버 오류 ${resp.status}`);
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${pod}_${container || 'default'}${previous ? '.previous' : ''}.log`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setDownloadingAll(false);
    }
  }, [clusterId, namespace, pod, container, previous]);

  const activeMatchLine = matches.length > 0 ? matches[activeMatch] : -1;

  const itemContent = useCallback((index: number, raw: string) => {
    const clean = stripAnsi(raw);
    const { ts, body } = splitTimestamp(clean);
    const { cls } = classifyLine(body);
    const isActive = index === activeMatchLine;
    let content: React.ReactNode;
    if (searchRe) {
      searchRe.lastIndex = 0;
      content = searchRe.test(body) ? renderHighlighted(body, searchRe) : (body || ' ');
    } else {
      content = body ? tokenize(body) : ' ';
    }
    return (
      <div
        className={`${cls} ${isActive ? 'bg-primary/15' : ''} ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}
      >
        {showTs && ts && <span className="text-[color:var(--log-muted)]">{ts} </span>}
        {content}
      </div>
    );
  }, [searchRe, activeMatchLine, showTs, wrap]);

  const containers = containersData?.containers ?? [];
  const normals = containers.filter((c) => !c.init);
  const inits = containers.filter((c) => c.init);

  return (
    <div>
      {/* 컨트롤 행 */}
      <div className="flex items-end gap-2 flex-wrap mb-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">컨테이너</span>
          <select
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            className="rounded-lg border border-border bg-card px-2 py-1.5 text-sm min-w-[180px]"
          >
            {containers.length === 0 && <option value="">(기본)</option>}
            {normals.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}{c.restartCount > 0 ? ` (↻${c.restartCount})` : ''}
              </option>
            ))}
            {inits.length > 0 && (
              <optgroup label="Init Containers">
                {inits.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">tail</span>
          <input
            type="number"
            value={tail}
            min={1}
            max={5000}
            onChange={(e) => setTail(Number(e.target.value) || 200)}
            className="rounded-lg border border-border bg-card px-2 py-1.5 text-sm w-20"
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer pb-2">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-primary" />
          follow
        </label>
        <label
          className="flex items-center gap-1 text-sm cursor-pointer pb-2"
          title="이전(재시작 전) 컨테이너 로그"
        >
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} className="accent-primary" />
          <History className="w-3.5 h-3.5" /> previous
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

        <div className="flex-1" />

        {/* 검색 */}
        <div className="flex items-center gap-1 pb-0.5">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jumpTo(e.shiftKey ? activeMatch - 1 : activeMatch + 1);
              }}
              placeholder="검색…"
              className="pl-7 pr-2 py-1.5 rounded-lg border border-border bg-card text-sm w-44"
            />
          </div>
          <button
            onClick={() => setUseRegex((v) => !v)}
            title="정규식"
            className={`p-1.5 rounded-lg border border-border hover:bg-secondary ${useRegex ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}
          >
            <Regex className="w-3.5 h-3.5" />
          </button>
          {query.trim() && (
            <span className="text-xs text-muted-foreground min-w-[52px] text-center">
              {matches.length > 0 ? `${activeMatch + 1}/${matches.length}` : '0/0'}
            </span>
          )}
          <button
            onClick={() => jumpTo(activeMatch - 1)}
            disabled={matches.length === 0}
            title="이전 매치 (Shift+Enter)"
            className="p-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => jumpTo(activeMatch + 1)}
            disabled={matches.length === 0}
            title="다음 매치 (Enter)"
            className="p-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 표시 토글 + 다운로드 */}
        <div className="flex items-center gap-1 pb-0.5">
          <button
            onClick={() => setShowTs((v) => !v)}
            title="타임스탬프 표시"
            className={`p-1.5 rounded-lg border border-border hover:bg-secondary ${showTs ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}
          >
            <Clock className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setWrap((v) => !v)}
            title={wrap ? '줄바꿈 해제' : '줄바꿈'}
            className={`p-1.5 rounded-lg border border-border hover:bg-secondary ${wrap ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}
          >
            <WrapText className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={downloadVisible}
            disabled={lines.length === 0}
            title="보이는 로그 다운로드"
            className="p-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 text-muted-foreground"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={downloadAll}
            disabled={downloadingAll || !pod}
            title="전체 로그 다운로드 (서버)"
            className="px-2 py-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 text-xs text-muted-foreground inline-flex items-center gap-1"
          >
            {downloadingAll ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
            전체
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-2 text-sm text-red-500 flex items-center gap-1.5">
          <RefreshCw className="w-3 h-3" /> {err}
        </div>
      )}

      {/* 로그 출력 — 가상화(뷰포트 행만 렌더), follow 시 자동 하단 고정 */}
      <div
        style={themeStyle}
        className={`${heightClass} rounded-xl bg-zinc-950 text-zinc-100 text-xs leading-relaxed font-mono overflow-hidden`}
      >
        {lines.length === 0 ? (
          <div className="p-3 text-zinc-400">
            {streaming ? '스트리밍 대기 중…' : '컨테이너를 선택하고 "스트림 시작"을 누르세요.'}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            data={lines}
            followOutput={follow && streaming ? 'auto' : false}
            itemContent={itemContent}
            className="px-3 py-2"
          />
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {lines.length}줄 (최대 {MAX_LINES.toLocaleString()}) · 읽기전용
        {streaming && ' · 스트리밍 중'}
        {previous && ' · previous(재시작 전) 로그'}
      </p>
    </div>
  );
}
