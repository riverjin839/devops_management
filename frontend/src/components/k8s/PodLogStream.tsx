import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Play, Square, Trash2, Download, Search, WrapText, Clock, History,
  ChevronUp, ChevronDown, Regex, AlertTriangle, Info, RotateCcw, StepForward, Loader2,
} from 'lucide-react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useQuery } from '@tanstack/react-query';
import { getAuthToken } from '@/stores/authStore';
import { analyzeApi, k8sStreamUrls } from '@/services/api';
import { useLogTheme } from '@/hooks/useTerminalAppearance';
import { classifyLine, stripAnsi, tokenize } from '@/components/common/logLine';
import { ErrorState } from '@/components/common/EmptyState';
import { useToastSafe } from '@/components/common/Toast';

const MAX_LINES = 20_000; // 가상화 — 뷰포트 행만 렌더되므로 안전. 넘치면 링 버퍼가 오래된 줄부터 덮어쓴다.
const FLUSH_MS = 100;     // 수신 줄을 모아 화면에 반영하는 주기(D-187 ④ — 줄마다 setState 금지)
const RESUME_TAIL = 5000; // 이어 받기 시 서버 tail 상한(서버 클램프와 같음)
const RESUME_SKEW_SEC = 10; // 브라우저↔노드 시계 차 여유 — 겹친 줄은 타임스탬프로 걸러낸다

// ── SSE 소비 ────────────────────────────────────────────────────────────────

type EndReason = 'eof' | 'max_duration' | 'truncated' | 'closed' | 'stopped';

interface StreamEnd { reason: EndReason; bytes?: number; message?: string }

interface StreamCallbacks {
  onLines: (lines: string[]) => void;
  onEnd: (e: StreamEnd) => void;
  onError: (message: string) => void;
}

interface SseHandle { abort: () => void }

/** 실패 응답 본문의 FastAPI `detail` 을 사람이 읽을 문구로(429 동시 한도 사유 등 — D-182). */
async function readErrorDetail(resp: Response): Promise<string> {
  const fallback = `서버 오류 ${resp.status}`;
  try {
    const text = await resp.text();
    if (!text) return fallback;
    try {
      const j = JSON.parse(text) as { detail?: unknown; message?: unknown };
      const d = j.detail ?? j.message;
      if (typeof d === 'string' && d) return d;
      if (Array.isArray(d)) {
        const msgs = d.map((x) => (x && typeof x === 'object' && 'msg' in x ? String((x as { msg: unknown }).msg) : String(x)));
        if (msgs.length) return msgs.join(' · ');
      }
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    /* 본문 읽기 실패 — 상태 코드만 */
  }
  return fallback;
}

function parseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const END_REASONS: readonly EndReason[] = ['eof', 'max_duration', 'truncated', 'closed'];

/**
 * 인증 fetch 기반 SSE 소비 (EventSource 는 Authorization 헤더 불가).
 *
 * 서버 계약(D-182·D-187): 로그 `data: <line>` · 종료 `event: end` + `{"reason","bytes"}` ·
 * 오류 `event: error` + `{"message"}` · 하트비트 `: ping` 주석(무시).
 * 구버전 서버는 종료·오류를 `data: [stream ended] …` / `data: [stream error] …` 줄로 보낸다 —
 * 실제 로그 줄은 항상 timestamps=true 라 RFC3339 로 시작하므로 이 접두사로 시작하는 줄만 표식으로 본다.
 * 종료·오류는 줄 콜백으로 흘리지 않는다(검색·다운로드 오염 방지).
 */
function startLogStream(url: string, cb: StreamCallbacks): SseHandle {
  const ac = new AbortController();
  let finished = false;
  const end = (e: StreamEnd) => {
    if (finished || ac.signal.aborted) return;
    finished = true;
    cb.onEnd(e);
  };
  const fail = (m: string) => {
    if (finished || ac.signal.aborted) return;
    finished = true;
    cb.onError(m);
  };

  const dispatch = (block: string) => {
    if (finished || ac.signal.aborted) return;
    let event = 'message';
    const data: string[] = [];
    for (const ln of block.split('\n')) {
      if (!ln || ln.startsWith(':')) continue; // 하트비트·주석
      if (ln.startsWith('event:')) event = ln.slice(6).trim();
      else if (ln.startsWith('data:')) data.push(ln.slice(5).replace(/^ /, ''));
    }
    if (event === 'end') {
      const j = parseJson(data.join('\n'));
      const r = typeof j?.reason === 'string' ? j.reason : 'eof';
      end({
        reason: (END_REASONS as readonly string[]).includes(r) ? (r as EndReason) : 'eof',
        bytes: typeof j?.bytes === 'number' ? j.bytes : undefined,
      });
      return;
    }
    if (event === 'error') {
      const j = parseJson(data.join('\n'));
      fail(typeof j?.message === 'string' && j.message ? j.message : (data.join(' ') || '스트림 오류'));
      return;
    }
    const out: string[] = [];
    for (const d of data) {
      if (d.startsWith('[stream ended]')) {
        if (out.length) cb.onLines(out);
        const msg = d.slice('[stream ended]'.length).trim();
        end({ reason: msg.includes('시간 초과') ? 'max_duration' : 'eof', message: msg || undefined });
        return;
      }
      if (d.startsWith('[stream error]')) {
        if (out.length) cb.onLines(out);
        fail(d.slice('[stream error]'.length).trim() || '스트림 오류');
        return;
      }
      out.push(d);
    }
    if (out.length) cb.onLines(out);
  };

  const token = getAuthToken();
  fetch(url, { signal: ac.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then(async (resp) => {
      if (!resp.ok) { fail(await readErrorDetail(resp)); return; }
      if (!resp.body) { fail('스트림 본문이 비어 있습니다.'); return; }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          dispatch(block);
        }
        if (finished) { void reader.cancel().catch(() => undefined); return; }
      }
      if (buf.trim()) dispatch(buf);
      // 종료 이벤트 없이 닫힘 — 프록시·서버 재시작 등으로 연결이 끊긴 경우
      end({ reason: 'closed' });
    })
    .catch((e) => { if (!ac.signal.aborted) fail(String(e).slice(0, 200)); });
  return { abort: () => ac.abort() };
}

// ── 링 버퍼 ──────────────────────────────────────────────────────────────────

/** 고정 용량 링 버퍼 — 줄 추가마다 배열을 복사하지 않고, 넘치면 가장 오래된 줄을 덮어쓴다. */
class LineRing {
  private buf: string[];
  private head = 0;
  size = 0;
  /** 첫 줄의 절대 순번 — 가상 리스트 key·검색 매치 위치로 쓴다(지워도 단조 증가). */
  startSeq = 0;

  constructor(readonly cap: number) { this.buf = new Array<string>(cap); }

  /** 추가하고, 밀려난 줄이 있으면 true. */
  push(line: string): boolean {
    if (this.size < this.cap) {
      this.buf[(this.head + this.size) % this.cap] = line;
      this.size++;
      return false;
    }
    this.buf[this.head] = line;
    this.head = (this.head + 1) % this.cap;
    this.startSeq++;
    return true;
  }

  get(i: number): string { return this.buf[(this.head + i) % this.cap] ?? ''; }

  clear() {
    this.startSeq += this.size;
    this.buf = new Array<string>(this.cap);
    this.head = 0;
    this.size = 0;
  }

  toArray(): string[] {
    const out = new Array<string>(this.size);
    for (let i = 0; i < this.size; i++) out[i] = this.get(i);
    return out;
  }
}

// SSE 는 항상 timestamps=true 로 받는다 — 표시는 토글(freelens 패턴).
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s?(.*)$/;

function splitTimestamp(line: string): { ts: string | null; body: string } {
  const m = line.match(TS_RE);
  if (m) return { ts: m[1], body: m[2] };
  return { ts: null, body: line };
}

function tsMs(line: string): number {
  const m = line.match(TS_RE);
  return m ? Date.parse(m[1]) : NaN;
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
      <mark key={m.index} className="bg-status-warning/50 text-inherit rounded-sm px-px">
        {m[0]}
      </mark>,
    );
    last = re.lastIndex;
    if (last === m.index) re.lastIndex = m.index + 1; // 0-width 방지
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}

function lineMatches(re: RegExp, raw: string): boolean {
  re.lastIndex = 0;
  return re.test(stripAnsi(raw));
}

type StreamStatus =
  | { kind: 'end'; reason: EndReason; bytes?: number; message?: string }
  | { kind: 'error'; message: string };

interface ViewState {
  count: number;
  matchCount: number;
  /** 링 버퍼 한도로 밀려난 줄 수(이번 화면 기준) */
  dropped: number;
  rev: number;
}

interface StreamTarget { container: string; previous: boolean }

function endReasonLabel(reason: EndReason, follow: boolean, message?: string): string {
  switch (reason) {
    case 'max_duration': return '최대 스트림 시간 초과';
    case 'truncated': return '스트림 전송 한도(10MB)에 도달해 잘림';
    case 'closed': return '서버 연결이 끊김';
    case 'stopped': return '사용자 중지';
    case 'eof':
    default:
      if (message) return message;
      return follow ? '로그 끝 — 파드 재시작·컨테이너 종료 등' : '요청한 줄을 모두 받음';
  }
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

const ICON_BTN = 'p-1.5 rounded-xl border border-border hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed';

/**
 * OpenLens/freelens 급 파드 로그 스트림 뷰 — SSE follow 유지 + 컨테이너 드롭다운,
 * 이전 컨테이너/타임스탬프/줄바꿈 토글, 검색(이전/다음+하이라이트), 다운로드, 가상화.
 *
 * 스트림 시작/중지는 라이브 스트림 뷰라 §12.9.1 실행 로그 대상이 아니다(같은 절 예외 ③).
 * 종료·오류는 로그 줄이 아니라 로그 영역 위 상태 줄로 표시한다(D-187).
 */
export function PodLogStream({
  clusterId, namespace, pod, autoStart = false, initialContainer, heightClass = 'h-[60vh]',
}: PodLogStreamProps) {
  const fid = useId();
  const toast = useToastSafe();
  const [container, setContainer] = useState(initialContainer ?? '');
  const [tail, setTail] = useState(200);
  const [follow, setFollow] = useState(true);
  const [previous, setPrevious] = useState(false);
  const [showTs, setShowTs] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<StreamStatus | null>(null);
  /** 화면에 있는 줄을 받은 대상 — 선택이 바뀐 뒤에도 어떤 컨테이너 로그인지 보여준다. */
  const [shownTarget, setShownTarget] = useState<StreamTarget | null>(null);
  const [view, setView] = useState<ViewState>({ count: 0, matchCount: 0, dropped: 0, rev: 0 });
  const [downloadNotice, setDownloadNotice] = useState<{ kind: 'error' | 'truncated'; message: string } | null>(null);

  // 검색
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [activeMatch, setActiveMatch] = useState(0);

  const handleRef = useRef<SseHandle | null>(null);
  const streamingRef = useRef(false);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const ringRef = useRef(new LineRing(MAX_LINES));
  const pendingRef = useRef<string[]>([]);
  const pendingDroppedRef = useRef(0);
  const flushTimerRef = useRef<number | null>(null);
  const matchesRef = useRef<number[]>([]); // 매치 줄의 절대 순번(오름차순)
  const droppedRef = useRef(0);
  const lastMsRef = useRef<number>(NaN);
  /** 이어 받기 중 겹치는 줄 거르기 — 마지막 수신 시각과 그 시각의 줄들 */
  const resumeFilterRef = useRef<{ ms: number; seen: Set<string> } | null>(null);
  const { style: themeStyle } = useLogTheme();

  // 컨테이너 목록 (init 포함) — default-container 어노테이션 존중
  const containersQ = useQuery({
    queryKey: ['pod-containers', clusterId, namespace, pod],
    queryFn: () => analyzeApi.podContainers(clusterId, namespace, pod).then((r) => r.data),
    enabled: !!clusterId && !!namespace && !!pod,
    staleTime: 30_000,
  });
  const containersData = containersQ.data;

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
  const searchReRef = useRef<RegExp | null>(searchRe);
  searchReRef.current = searchRe;

  /** 모아 둔 줄을 링 버퍼에 반영 + 검색 매치 증분 갱신 → 화면 1회 갱신. */
  const flush = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const batch = pendingRef.current;
    pendingRef.current = [];
    const ring = ringRef.current;
    const re = searchReRef.current;
    let dropped = pendingDroppedRef.current;
    pendingDroppedRef.current = 0;
    for (const line of batch) {
      const seq = ring.startSeq + ring.size; // 이 줄의 절대 순번(가득 차도 같다)
      if (ring.push(line)) dropped++;
      if (re && lineMatches(re, line)) matchesRef.current.push(seq);
      const ms = tsMs(line);
      if (!Number.isNaN(ms)) lastMsRef.current = ms;
    }
    // 밀려난 줄의 매치 제거
    const matches = matchesRef.current;
    let cut = 0;
    while (cut < matches.length && matches[cut] < ring.startSeq) cut++;
    if (cut > 0) {
      matches.splice(0, cut);
      setActiveMatch((a) => Math.max(0, a - cut));
    }
    droppedRef.current += dropped;
    setView((v) => ({ count: ring.size, matchCount: matches.length, dropped: droppedRef.current, rev: v.rev + 1 }));
  }, []);

  const onLines = useCallback((incoming: string[]) => {
    let lines = incoming;
    const f = resumeFilterRef.current;
    if (f) {
      // 이어 받기: since_seconds 여유분으로 겹친 줄을 타임스탬프로 걸러낸다
      const kept: string[] = [];
      for (const l of lines) {
        if (!resumeFilterRef.current) { kept.push(l); continue; }
        const ms = tsMs(l);
        if (Number.isNaN(ms)) { kept.push(l); continue; }
        if (ms < f.ms) continue;
        if (ms === f.ms && f.seen.has(l)) continue;
        if (ms > f.ms) resumeFilterRef.current = null;
        kept.push(l);
      }
      lines = kept;
    }
    if (lines.length === 0) return;
    const pending = pendingRef.current;
    for (const l of lines) pending.push(l);
    if (pending.length > MAX_LINES) {
      const over = pending.length - MAX_LINES;
      pending.splice(0, over);
      pendingDroppedRef.current += over;
    }
    if (flushTimerRef.current === null) {
      flushTimerRef.current = window.setTimeout(flush, FLUSH_MS);
    }
  }, [flush]);

  const clearLines = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    pendingRef.current = [];
    pendingDroppedRef.current = 0;
    ringRef.current.clear();
    matchesRef.current = [];
    droppedRef.current = 0;
    resumeFilterRef.current = null;
    setActiveMatch(0);
    setView((v) => ({ count: 0, matchCount: 0, dropped: 0, rev: v.rev + 1 }));
  }, []);

  /** 연결만 끊는다(서버 슬롯 반환 — D-182). 받은 줄은 반영하고 상태 표시는 호출자가 정한다. */
  const abortStream = useCallback(() => {
    const h = handleRef.current;
    handleRef.current = null;
    h?.abort();
    streamingRef.current = false;
    setStreaming(false);
    if (pendingRef.current.length > 0 || pendingDroppedRef.current > 0) flush();
  }, [flush]);

  const stop = useCallback(() => {
    const wasStreaming = streamingRef.current;
    abortStream();
    if (wasStreaming) setStatus({ kind: 'end', reason: 'stopped' });
  }, [abortStream]);

  const start = useCallback((mode: 'fresh' | 'resume' = 'fresh') => {
    if (!clusterId || !namespace || !pod) return;
    abortStream();
    setStatus(null);
    let sinceSeconds: number | undefined;
    if (mode === 'resume' && !Number.isNaN(lastMsRef.current)) {
      const lastMs = lastMsRef.current;
      const ring = ringRef.current;
      const seen = new Set<string>();
      for (let i = ring.size - 1; i >= 0; i--) {
        const l = ring.get(i);
        const ms = tsMs(l);
        if (!Number.isNaN(ms) && ms < lastMs) break;
        if (ms === lastMs) seen.add(l);
      }
      resumeFilterRef.current = { ms: lastMs, seen };
      sinceSeconds = Math.max(1, (Date.now() - lastMs) / 1000 + RESUME_SKEW_SEC);
    } else {
      clearLines();
      lastMsRef.current = NaN;
      setShownTarget({ container, previous });
    }
    const url = k8sStreamUrls.logsStream(clusterId, namespace, pod, {
      container: container || undefined,
      tailLines: sinceSeconds ? RESUME_TAIL : tail,
      follow,
      previous,
      timestamps: true, // 항상 수신, 표시만 토글
      sinceSeconds,
    });
    streamingRef.current = true;
    setStreaming(true);
    const handle: SseHandle = startLogStream(url, {
      onLines: (ls) => { if (handleRef.current === handle) onLines(ls); },
      onEnd: (e) => {
        if (handleRef.current !== handle) return;
        abortStream();
        setStatus({ kind: 'end', ...e });
      },
      onError: (message) => {
        if (handleRef.current !== handle) return;
        abortStream();
        setStatus({ kind: 'error', message });
      },
    });
    handleRef.current = handle;
  }, [clusterId, namespace, pod, container, tail, follow, previous, abortStream, clearLines, onLines]);

  // 언마운트 시 연결 해제(서버 슬롯 반환) + 타이머 정리
  useEffect(() => () => {
    handleRef.current?.abort();
    handleRef.current = null;
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
  }, []);
  // 대상(클러스터·파드) 변경 시 정리
  useEffect(() => {
    abortStream();
    clearLines();
    setStatus(null);
    setShownTarget(null);
  }, [clusterId, namespace, pod, abortStream, clearLines]);

  // 스트리밍 중 컨테이너·이전 컨테이너 변경 → 새 대상으로 다시 시작(D-187 ③)
  const targetKey = `${container}|${previous}`;
  const prevTargetKeyRef = useRef(targetKey);
  useEffect(() => {
    if (prevTargetKeyRef.current === targetKey) return;
    prevTargetKeyRef.current = targetKey;
    if (streamingRef.current) start('fresh');
  }, [targetKey, start]);

  // 딥링크 자동 시작 — 컨테이너 결정(또는 목록 확정) 후 1회
  const containerResolved = !!container
    || containersQ.isError
    || (containersQ.isSuccess && !containersQ.data?.defaultContainer);
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    if (!clusterId || !namespace || !pod) return;
    if (!containerResolved) return;
    autoStartedRef.current = true;
    prevTargetKeyRef.current = targetKey;
    start('fresh');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, clusterId, namespace, pod, containerResolved]);

  // 검색어가 바뀌면 매치를 한 번 전체 재계산(이후는 flush 에서 증분)
  useEffect(() => {
    const ring = ringRef.current;
    const out: number[] = [];
    if (searchRe) {
      for (let i = 0; i < ring.size; i++) {
        if (lineMatches(searchRe, ring.get(i))) out.push(ring.startSeq + i);
      }
    }
    matchesRef.current = out;
    setActiveMatch(0);
    setView((v) => ({ ...v, matchCount: out.length, rev: v.rev + 1 }));
  }, [searchRe]);

  const jumpTo = useCallback((matchIdx: number) => {
    const matches = matchesRef.current;
    if (matches.length === 0) return;
    const bounded = ((matchIdx % matches.length) + matches.length) % matches.length;
    setActiveMatch(bounded);
    virtuosoRef.current?.scrollToIndex({ index: matches[bounded] - ringRef.current.startSeq, align: 'center' });
  }, []);

  // 표시용 텍스트 생성 (다운로드 "보이는 로그" 공용)
  const displayLine = useCallback((raw: string): string => {
    const clean = stripAnsi(raw);
    const { ts, body } = splitTimestamp(clean);
    return showTs && ts ? `${ts} ${body}` : body;
  }, [showTs]);

  const fileContainer = (shownTarget?.container ?? container) || 'default';
  const filePrevious = shownTarget?.previous ?? previous;

  const downloadVisible = useCallback(() => {
    const text = ringRef.current.toArray().map(displayLine).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${pod}_${fileContainer}${filePrevious ? '.previous' : ''}.visible.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [displayLine, pod, fileContainer, filePrevious]);

  const [downloadingAll, setDownloadingAll] = useState(false);
  const downloadAll = useCallback(async () => {
    setDownloadingAll(true);
    setDownloadNotice(null);
    try {
      const token = getAuthToken();
      const url = k8sStreamUrls.logsDownload(clusterId, namespace, pod, container || undefined, previous);
      const resp = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!resp.ok) throw new Error(await readErrorDetail(resp));
      const truncated = resp.headers.get('X-Log-Truncated') === '1';
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${pod}_${container || 'default'}${previous ? '.previous' : ''}.log`;
      a.click();
      URL.revokeObjectURL(a.href);
      if (truncated) {
        const msg = '서버 한도(10MB)에서 잘려 앞부분만 저장했습니다.';
        setDownloadNotice({ kind: 'truncated', message: msg });
        toast.warning('전체 로그가 잘렸습니다', msg);
      }
    } catch (e) {
      setDownloadNotice({ kind: 'error', message: `전체 로그 다운로드 실패 — ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
    } finally {
      setDownloadingAll(false);
    }
  }, [clusterId, namespace, pod, container, previous, toast]);

  const activeMatchSeq = view.matchCount > 0 ? (matchesRef.current[activeMatch] ?? -1) : -1;

  const itemContent = useCallback((index: number) => {
    const raw = ringRef.current.get(index);
    const clean = stripAnsi(raw);
    const { ts, body } = splitTimestamp(clean);
    const { cls } = classifyLine(body);
    const isActive = ringRef.current.startSeq + index === activeMatchSeq;
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
    // view.rev — 링 버퍼 내용이 바뀌면 보이는 행을 다시 그린다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchRe, activeMatchSeq, showTs, wrap, view.rev]);

  const computeItemKey = useCallback((index: number) => ringRef.current.startSeq + index, []);

  const containers = containersData?.containers ?? [];
  const normals = containers.filter((c) => !c.init);
  const inits = containers.filter((c) => c.init);

  const targetChanged = !!shownTarget && view.count > 0 && !streaming
    && (shownTarget.container !== container || shownTarget.previous !== previous);
  const canResume = !Number.isNaN(lastMsRef.current) && view.count > 0 && follow && !previous;

  return (
    <div>
      {/* 컨트롤 행 */}
      <div className="flex items-end gap-2 flex-wrap mb-2">
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${fid}-container`} className="text-muted-foreground">컨테이너</label>
          <select
            id={`${fid}-container`}
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            className="rounded-xl border border-border bg-card px-2 py-1.5 text-sm min-w-[180px]"
          >
            {containers.length === 0 && <option value="">(기본 컨테이너)</option>}
            {normals.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}{c.restartCount > 0 ? ` (재시작 ${c.restartCount}회)` : ''}
              </option>
            ))}
            {inits.length > 0 && (
              <optgroup label="초기화 컨테이너">
                {inits.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </optgroup>
            )}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor={`${fid}-tail`} className="text-muted-foreground">마지막 N줄</label>
          <input
            id={`${fid}-tail`}
            type="number"
            value={tail}
            min={1}
            max={5000}
            onChange={(e) => setTail(Number(e.target.value) || 200)}
            title="시작할 때 먼저 받아 올 최근 줄 수(최대 5,000)"
            className="rounded-xl border border-border bg-card px-2 py-1.5 text-sm w-24"
          />
        </div>
        <label
          className="flex items-center gap-1.5 text-sm cursor-pointer pb-2"
          title="켜면 새 로그를 계속 받습니다. 끄면 마지막 N줄만 받고 끝납니다(다음 시작부터 적용)."
        >
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-primary" />
          따라가기
        </label>
        <label
          className="flex items-center gap-1 text-sm cursor-pointer pb-2"
          title="재시작 전 컨테이너의 로그 — 스트리밍 중 바꾸면 다시 시작합니다"
        >
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} className="accent-primary" />
          <History className="w-3.5 h-3.5" aria-hidden="true" /> 이전 컨테이너
        </label>
        {streaming ? (
          <button
            type="button"
            onClick={stop}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-secondary text-foreground px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Square className="w-3.5 h-3.5" aria-hidden="true" /> 중지
          </button>
        ) : (
          <button
            type="button"
            onClick={() => start('fresh')}
            disabled={!pod}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90"
          >
            <Play className="w-3.5 h-3.5" aria-hidden="true" /> 스트림 시작
          </button>
        )}
        <button
          type="button"
          onClick={clearLines}
          title="화면 지우기"
          aria-label="화면 지우기"
          className="inline-flex items-center gap-1.5 rounded-xl border border-border px-2 py-1.5 text-sm hover:bg-secondary"
        >
          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
        </button>

        <div className="flex-1" />

        {/* 검색 */}
        <div className="flex items-center gap-1 pb-0.5" role="search">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jumpTo(e.shiftKey ? activeMatch - 1 : activeMatch + 1);
              }}
              placeholder="검색…"
              aria-label="로그 검색 (Enter 다음 · Shift+Enter 이전)"
              className="pl-7 pr-2 py-1.5 rounded-xl border border-border bg-card text-sm w-44"
            />
          </div>
          <button
            type="button"
            onClick={() => setUseRegex((v) => !v)}
            title="정규식"
            aria-label="정규식"
            aria-pressed={useRegex}
            className={`${ICON_BTN} ${useRegex ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}
          >
            <Regex className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          {query.trim() && (
            <span className="text-xs text-muted-foreground min-w-[52px] text-center" aria-live="polite">
              {view.matchCount > 0 ? `${activeMatch + 1}/${view.matchCount}` : '0/0'}
            </span>
          )}
          <button
            type="button"
            onClick={() => jumpTo(activeMatch - 1)}
            disabled={view.matchCount === 0}
            title="이전 매치 (Shift+Enter)"
            aria-label="이전 매치"
            className={ICON_BTN}
          >
            <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => jumpTo(activeMatch + 1)}
            disabled={view.matchCount === 0}
            title="다음 매치 (Enter)"
            aria-label="다음 매치"
            className={ICON_BTN}
          >
            <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* 표시 토글 + 다운로드 */}
        <div className="flex items-center gap-1 pb-0.5">
          <button
            type="button"
            onClick={() => setShowTs((v) => !v)}
            title="타임스탬프 표시"
            aria-label="타임스탬프 표시"
            aria-pressed={showTs}
            className={`${ICON_BTN} ${showTs ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}
          >
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setWrap((v) => !v)}
            title="줄바꿈"
            aria-label="줄바꿈"
            aria-pressed={wrap}
            className={`${ICON_BTN} ${wrap ? 'text-primary bg-primary/10' : 'text-muted-foreground'}`}
          >
            <WrapText className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={downloadVisible}
            disabled={view.count === 0}
            title="보이는 로그 다운로드"
            aria-label="보이는 로그 다운로드"
            className={`${ICON_BTN} text-muted-foreground`}
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={downloadAll}
            disabled={downloadingAll || !pod}
            title="전체 로그 다운로드 (서버, 최대 10MB)"
            aria-label="전체 로그 다운로드"
            className="px-2 py-1.5 rounded-xl border border-border hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed text-xs text-muted-foreground inline-flex items-center gap-1"
          >
            {downloadingAll
              ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
              : <Download className="w-3 h-3" aria-hidden="true" />}
            전체
          </button>
        </div>
      </div>

      {/* 컨테이너 목록 실패 — "(기본 컨테이너)" 하나로 보이지 않게(D-188) */}
      {containersQ.isError && (
        <div className="mb-2">
          <ErrorState
            error={containersQ.error}
            title="컨테이너 목록을 불러오지 못했습니다"
            onRetry={() => { void containersQ.refetch(); }}
            compact
          />
        </div>
      )}

      {/* 스트림 상태 줄 — 로그 줄과 분리(D-187 ①②). 검색·다운로드에 섞이지 않는다. */}
      {status?.kind === 'error' && (
        <div
          role="alert"
          className="mb-2 flex items-center gap-2 flex-wrap rounded-md border border-status-critical/40 bg-status-critical/10 px-3 py-2 text-sm"
        >
          <AlertTriangle className="w-4 h-4 text-status-critical shrink-0" aria-hidden="true" />
          <span className="font-medium text-status-critical">스트림 오류</span>
          <span className="text-foreground break-all min-w-0 flex-1">{status.message}</span>
          <button
            type="button"
            onClick={() => start('fresh')}
            className="inline-flex items-center gap-1 rounded-xl border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-secondary"
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> 다시 시도
          </button>
        </div>
      )}
      {status?.kind === 'end' && (
        <div
          role="status"
          className="mb-2 flex items-center gap-2 flex-wrap rounded-md border border-border bg-secondary/40 px-3 py-2 text-sm"
        >
          <Info className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <span className="font-medium text-foreground">
            스트림 종료({endReasonLabel(status.reason, follow, status.message)})
          </span>
          {typeof status.bytes === 'number' && (
            <span className="text-xs text-muted-foreground">{status.bytes.toLocaleString()}바이트 수신</span>
          )}
          {status.reason === 'truncated' && (
            <span className="text-xs text-muted-foreground">
              이후 로그는 받지 않았습니다 — 이어 받거나 "전체" 다운로드를 쓰세요.
            </span>
          )}
          <div className="flex-1" />
          {canResume && (
            <button
              type="button"
              onClick={() => start('resume')}
              title="화면의 줄을 유지하고 마지막 수신 시각 이후부터 이어 받습니다"
              className="inline-flex items-center gap-1 rounded-xl border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-secondary"
            >
              <StepForward className="w-3 h-3" aria-hidden="true" /> 이어 받기
            </button>
          )}
          <button
            type="button"
            onClick={() => start('fresh')}
            title="화면을 비우고 마지막 N줄부터 다시 받습니다"
            className="inline-flex items-center gap-1 rounded-xl border border-border bg-card px-2.5 py-1 text-xs font-medium hover:bg-secondary"
          >
            <RotateCcw className="w-3 h-3" aria-hidden="true" /> 처음부터 다시
          </button>
        </div>
      )}
      {downloadNotice && (
        <div
          role={downloadNotice.kind === 'error' ? 'alert' : 'status'}
          className="mb-2 flex items-center gap-2 text-sm"
        >
          <AlertTriangle
            className={`w-3.5 h-3.5 shrink-0 ${downloadNotice.kind === 'error' ? 'text-status-critical' : 'text-status-warning'}`}
            aria-hidden="true"
          />
          <span className={downloadNotice.kind === 'error' ? 'text-status-critical' : 'text-foreground'}>
            {downloadNotice.message}
          </span>
          <button
            type="button"
            onClick={() => setDownloadNotice(null)}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            닫기
          </button>
        </div>
      )}
      {targetChanged && shownTarget && (
        <p className="mb-2 text-xs text-muted-foreground" role="status">
          아래 로그는 컨테이너 {shownTarget.container || '(기본 컨테이너)'}{shownTarget.previous ? '(이전 컨테이너)' : ''} 의 로그입니다
          — 선택한 대상으로 보려면 스트림을 다시 시작하세요.
        </p>
      )}

      {/* 로그 출력 — 가상화(뷰포트 행만 렌더), 따라가기 시 자동 하단 고정.
          style 은 터미널 Appearance 프로파일의 CSS 변수 주입(LogViewer 와 같은 경로) — 정적 색 아님. */}
      <div
        style={themeStyle}
        role="log"
        aria-live="off"
        aria-label="파드 로그 출력"
        className={`${heightClass} rounded-md border border-border bg-background text-foreground text-xs leading-relaxed font-mono overflow-hidden`}
      >
        {view.count === 0 ? (
          <div className="p-3 text-muted-foreground">
            {streaming ? '스트리밍 대기 중…' : '컨테이너를 고르고 "스트림 시작"을 누르세요.'}
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            totalCount={view.count}
            computeItemKey={computeItemKey}
            followOutput={follow && streaming ? 'auto' : false}
            itemContent={itemContent}
            className="px-3 py-2"
          />
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {view.count.toLocaleString()}줄 (최대 {MAX_LINES.toLocaleString()}) · 읽기 전용
        {streaming && ' · 스트리밍 중'}
        {(shownTarget?.previous ?? previous) && ' · 이전 컨테이너(재시작 전) 로그'}
        {view.dropped > 0 && (
          <> · 앞쪽 {view.dropped.toLocaleString()}줄은 화면 한도를 넘어 생략됨(전체 로그는 "전체" 다운로드)</>
        )}
      </p>
    </div>
  );
}
