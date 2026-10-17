// 실행 로그 버퍼 — "실행" 버튼마다 단계·결과·오류를 시각과 함께 쌓는다(D-089).
// 서버가 SSE 로 단계를 흘려주는 실행은 그 이벤트를 그대로 쌓고(appendServer), 단건 요청형 실행은
// 화면이 요청 시작·응답 요약·오류를 직접 기록한다(log). 보여줄지는 RunLogPanel 의 "로그 보기" 가 정한다.
//
// 한 화면의 실행 로그 하나를 여러 실행이 함께 쓸 수 있다. `begin` 은 그 실행 전용 핸들을 돌려주고,
// 앞 실행이 아직 진행 중이면 줄을 지우지 않고 이어 쓰며 각 실행의 줄 앞에 `[제목]` 을 붙인다.
// `running` 은 진행 중인 실행이 하나라도 있으면 참이다(먼저 끝난 실행이 다른 실행을 끝난 것처럼 만들지 않는다).
import { useCallback, useRef, useState } from 'react';
import { postSse, type SseEvent } from '@/lib/sse';
import { formatApiError } from '@/lib/utils';
import { camelizeKeys, snakeizeKeys } from '@/services/api';

export type RunLogLevel = 'info' | 'warn' | 'error';
export interface RunLogLine { ts: string; level: RunLogLevel; message: string }
export type RunStepStatus = 'running' | 'done' | 'failed';
export interface RunStep { name: string; label: string; status: RunStepStatus }

/** 실행 1건 전용 기록기 — `begin` 이 돌려준다. 동시 실행 중이면 줄·단계 앞에 `[제목]` 이 붙고,
 *  `end` 는 이 실행만 끝낸다. */
export interface RunLogHandle {
  log: (level: RunLogLevel, message: string) => void;
  setStep: (name: string, label: string, status: RunStepStatus) => void;
  end: () => void;
}

export interface RunLog {
  /** 이번 실행의 이름(예: "K8s 동기화") — 패널 헤더에 표시. 동시 실행 중이면 "첫 실행 외 N건". */
  title: string;
  lines: RunLogLine[];
  steps: RunStep[];
  running: boolean;
  /** 실행 시작 — 그 실행 전용 핸들을 돌려준다(헬퍼는 이 핸들로만 기록·종료한다). */
  begin: (title: string, firstMessage?: string) => RunLogHandle;
  /** 핸들 없이 기록(단일 실행 화면의 하위 호환). */
  log: (level: RunLogLevel, message: string) => void;
  setStep: (name: string, label: string, status: RunStepStatus) => void;
  /** 진행 중인 실행 전부를 끝낸다. 실행 1건만 끝내려면 핸들의 `end` 를 쓴다. */
  end: () => void;
  clear: () => void;
}

const LEVELS: RunLogLevel[] = ['info', 'warn', 'error'];

export function toRunLogLevel(v: unknown): RunLogLevel {
  return LEVELS.includes(v as RunLogLevel) ? (v as RunLogLevel) : 'info';
}

interface ActiveRun { title: string; shared: boolean }

export function useRunLog(): RunLog {
  const [title, setTitle] = useState('');
  const [lines, setLines] = useState<RunLogLine[]>([]);
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [running, setRunning] = useState(false);
  const active = useRef(new Map<number, ActiveRun>());
  const seq = useRef(0);

  const log = useCallback((level: RunLogLevel, message: string) => {
    setLines((prev) => [...prev, { ts: new Date().toISOString(), level, message }]);
  }, []);

  const setStep = useCallback((name: string, label: string, status: RunStepStatus) => {
    setSteps((prev) => {
      const i = prev.findIndex((s) => s.name === name);
      if (i < 0) return [...prev, { name, label, status }];
      const next = [...prev];
      next[i] = { name, label: label || next[i].label, status };
      return next;
    });
  }, []);

  /** 헤더 제목·진행 여부를 진행 중인 실행 목록에 맞춘다(모두 끝나면 마지막 제목을 남긴다). */
  const sync = useCallback(() => {
    const runs = [...active.current.values()];
    if (runs.length > 0) setTitle(runs.length > 1 ? `${runs[0].title} 외 ${runs.length - 1}건` : runs[0].title);
    setRunning(runs.length > 0);
  }, []);

  const begin = useCallback((t: string, firstMessage?: string): RunLogHandle => {
    const id = ++seq.current;
    const runs = active.current;
    const me: ActiveRun = { title: t, shared: false };
    const now = new Date().toISOString();
    if (runs.size === 0) {
      setSteps([]);
      setLines(firstMessage ? [{ ts: now, level: 'info', message: firstMessage }] : []);
    } else {
      // 앞 실행이 진행 중 — 지우지 않고 이어 쓰고, 이후 모든 진행 중 실행의 줄에 제목을 붙인다.
      const others = runs.size;
      runs.forEach((r) => { r.shared = true; });
      me.shared = true;
      // 이미 떠 있는 단계 칩(이름 = `${id}:…`)에도 소속 실행 제목을 붙인다.
      const titles = new Map([...runs].map(([rid, r]) => [String(rid), r.title]));
      setSteps((prev) => prev.map((s) => {
        const owner = titles.get(s.name.split(':', 1)[0]);
        return owner && !s.label.startsWith(`[${owner}] `) ? { ...s, label: `[${owner}] ${s.label}` } : s;
      }));
      const added: RunLogLine[] = [{ ts: now, level: 'info', message: `${t} 시작 — 진행 중인 실행 ${others}건과 함께 기록` }];
      if (firstMessage) added.push({ ts: now, level: 'info', message: `[${t}] ${firstMessage}` });
      setLines((prev) => [...prev, ...added]);
    }
    runs.set(id, me);
    sync();
    const tag = (msg: string) => (me.shared ? `[${t}] ${msg}` : msg);
    return {
      log: (level, message) => log(level, tag(message)),
      setStep: (name, label, status) => setStep(`${id}:${name}`, label ? tag(label) : label, status),
      end: () => {
        if (active.current.delete(id)) sync();
      },
    };
  }, [log, setStep, sync]);

  const end = useCallback(() => {
    active.current.clear();
    setRunning(false);
  }, []);
  const clear = useCallback(() => {
    active.current.clear();
    setTitle('');
    setLines([]);
    setSteps([]);
    setRunning(false);
  }, []);

  return { title, lines, steps, running, begin, log, setStep, end, clear };
}

/** LogViewer 에 넘길 텍스트 — `HH:MM:SS LEVEL message`. LogViewer 가 ERROR/WARN 키워드로 색을 입힌다. */
export function formatRunLog(lines: RunLogLine[]): string {
  return lines
    .map((l) => {
      const t = new Date(l.ts);
      const hhmmss = Number.isNaN(t.getTime()) ? l.ts : t.toLocaleTimeString('ko-KR', { hour12: false });
      return `${hhmmss} ${l.level.toUpperCase().padEnd(5)} ${l.message}`;
    })
    .join('\n');
}

/** 서버 SSE 의 `log`·`step` 이벤트를 실행 로그에 그대로 반영한다(`result`·`error` 는 호출자가 처리).
 *  이벤트 규약: log{level,ts,message} · step{name,label,status: running|done|failed}. */
export function applyRunEvent(run: Pick<RunLog, 'log' | 'setStep'>, evt: SseEvent): void {
  if (evt.type === 'log') run.log(toRunLogLevel(evt.level), String(evt.message ?? ''));
  else if (evt.type === 'step') {
    const st: RunStepStatus = evt.status === 'failed' ? 'failed' : evt.status === 'done' ? 'done' : 'running';
    run.setStep(String(evt.name ?? ''), String(evt.label ?? evt.name ?? ''), st);
  }
}

// ── 단건 요청·큐잉 실행을 실행 로그로 감싸는 헬퍼 (D-128, DESIGN_SYSTEM.md §12.9.1) ─────────────

/** 실행 로그 한 줄 — `[level, message]`. */
export type RunLogEntry = [RunLogLevel, string];

/** 시작 시각(`performance.now()`)부터의 경과 — "1234ms" / "12.3s". */
export function elapsed(t0: number): string {
  const ms = Math.round(performance.now() - t0);
  return ms < 10_000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function isAbortError(e: unknown): boolean {
  const x = e as { name?: string; code?: string } | null;
  return x?.name === 'CanceledError' || x?.code === 'ERR_CANCELED' || x?.name === 'AbortError';
}

/** 실행 결과 — `run` 은 이 실행의 핸들(`keepOpen` 이면 이어서 `pollIntoRunLog`·`log`·`end` 에 넘긴다). */
export type RunLoggedResult<T> =
  | { ok: true; data: T; run: RunLogHandle }
  | { ok: false; error: unknown; aborted: boolean; run: RunLogHandle };

/**
 * 단건 요청형 실행(동기 1응답)을 실행 로그로 감싼다.
 * begin(title, first) → 응답을 기다리는 동안 `heartbeatMs` 마다 "응답 대기 중 · N초" →
 * 응답이 오면 `summarize(res)` 의 줄들 → 소요 시간 → end. 실패는 error 줄, 사용자 중지는 warn 줄.
 * throw 하지 않고 결과 union 을 돌려준다(호출자가 토스트·결과 표를 이어서 처리).
 * `keepOpen` 이면 end 를 부르지 않는다(큐잉 후 `pollIntoRunLog` 로 이어가는 경우).
 */
export async function runLogged<T>(
  runLog: Pick<RunLog, 'begin'>,
  opts: {
    title: string;
    first?: string;
    fn: () => Promise<T>;
    summarize?: (res: T) => RunLogEntry[];
    heartbeatMs?: number;
    keepOpen?: boolean;
  },
): Promise<RunLoggedResult<T>> {
  const { title, first, fn, summarize, heartbeatMs = 5000, keepOpen = false } = opts;
  const t0 = performance.now();
  const run = runLog.begin(title, first ?? `${title} 요청 전송`);
  const hb = heartbeatMs > 0
    ? setInterval(() => run.log('info', `응답 대기 중 · ${Math.round((performance.now() - t0) / 1000)}초 경과`), heartbeatMs)
    : null;
  try {
    const data = await fn();
    if (hb) clearInterval(hb);
    run.log('info', `응답 수신 · ${elapsed(t0)}`);
    for (const [level, msg] of summarize?.(data) ?? []) run.log(level, msg);
    if (!keepOpen) run.end();
    return { ok: true, data, run };
  } catch (error) {
    if (hb) clearInterval(hb);
    const aborted = isAbortError(error);
    if (aborted) run.log('warn', `사용자 중지 · ${elapsed(t0)}`);
    else run.log('error', `실패 · ${elapsed(t0)} — ${formatApiError(error)}`);
    run.end();
    return { ok: false, error, aborted, run };
  }
}

/**
 * 큐잉(Celery)형 실행의 진행을 도메인 리소스 폴링으로 실행 로그에 이어 쓴다.
 * `describe(snap, prev)` 가 이전 스냅샷과 비교해 새로 생긴 변화만 줄로 돌려준다.
 * `isDone` 이 참이 되거나 `timeoutMs` 가 지나거나 `signal` 이 abort 되면 끝내고 end 를 부른다.
 * 조회 실패는 warn 한 줄만 남기고 계속 폴링한다(백엔드 일시 오류로 로그가 끊기지 않게).
 */
export async function pollIntoRunLog<S>(
  run: Pick<RunLog, 'log' | 'end'>,
  opts: {
    fetch: () => Promise<S>;
    describe: (snap: S, prev: S | undefined) => RunLogEntry[];
    isDone: (snap: S) => boolean;
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<S | undefined> {
  const { fetch, describe, isDone, intervalMs = 2000, timeoutMs = 180_000, signal } = opts;
  const t0 = performance.now();
  let prev: S | undefined;
  let warned = false;
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  try {
    for (;;) {
      if (signal?.aborted) { run.log('warn', `진행 추적 중지 · ${elapsed(t0)}`); return prev; }
      try {
        const snap = await fetch();
        for (const [level, msg] of describe(snap, prev)) run.log(level, msg);
        prev = snap;
        if (isDone(snap)) { run.log('info', `완료 · ${elapsed(t0)}`); return snap; }
      } catch (e) {
        if (!warned) { run.log('warn', `진행 조회 실패(재시도) — ${formatApiError(e)}`); warned = true; }
      }
      if (performance.now() - t0 > timeoutMs) {
        run.log('warn', `${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 추적 중지 — 백그라운드에서 계속 진행될 수 있음`);
        return prev;
      }
      await sleep(intervalMs);
    }
  } finally {
    run.end();
  }
}

/**
 * SSE 실행(서버가 단계를 흘리는 실행)을 실행 로그로 감싼다(D-135).
 * begin → 서버의 log·step 을 그대로 쌓고(applyRunEvent) → ``result`` 는 camelCase 로 바꿔 돌려주며
 * ``summarize`` 의 줄을 덧붙인다 → ``error`` 이벤트·연결 실패는 error 줄 → end.
 * 본문은 camelCase 로 넘기면 snake_case 로 바꿔 보낸다(SSE 는 axios 인터셉터를 타지 않는다).
 * throw 하지 않고 `runLogged` 와 같은 결과 union 을 돌려준다.
 */
export async function streamLogged<T>(
  runLog: Pick<RunLog, 'begin'>,
  opts: {
    title: string;
    first?: string;
    url: string;
    body: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    summarize?: (res: T) => RunLogEntry[];
  },
): Promise<RunLoggedResult<T>> {
  const { title, first, url, body, signal, headers, summarize } = opts;
  const t0 = performance.now();
  const run = runLog.begin(title, first ?? `${title} 요청 전송`);
  let result: T | undefined;
  let streamError: string | null = null;
  try {
    await postSse(url, snakeizeKeys(body), (evt) => {
      if (evt.type === 'result') result = camelizeKeys<T>(evt.result);
      else if (evt.type === 'error') streamError = String(evt.message ?? '실행 실패');
      else applyRunEvent(run, evt);
    }, signal, headers);
    if (streamError) throw new Error(streamError);
    if (result === undefined) throw new Error('결과 없이 스트림이 끝났습니다.');
    for (const [level, msg] of summarize?.(result) ?? []) run.log(level, msg);
    run.log('info', `총 소요 ${elapsed(t0)}`);
    run.end();
    return { ok: true, data: result, run };
  } catch (error) {
    const aborted = isAbortError(error);
    if (aborted) run.log('warn', `사용자 중지 · ${elapsed(t0)}`);
    else run.log('error', `실패 · ${elapsed(t0)} — ${error instanceof Error && !('response' in error) ? error.message : formatApiError(error)}`);
    run.end();
    return { ok: false, error, aborted, run };
  }
}

/** 콘솔형 단건 실행(stdout/stderr 를 돌려주는 SSH·kubectl 실행) 응답 → 실행 로그 줄(D-135).
 *  출력 본문은 ExecOutputTabs/LogViewer 가 보여주므로 여기서는 결과 요약만 남긴다. */
export interface ConsoleRunLike {
  host?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  stderr?: string | null;
  error?: string | null;
  status?: string | null;
  executedCommand?: string | null;
}

export function consoleRunLines(res: ConsoleRunLike | ConsoleRunLike[], label?: string): RunLogEntry[] {
  const rows = Array.isArray(res) ? res : [res];
  const out: RunLogEntry[] = [];
  let failed = 0;
  for (const r of rows) {
    const firstErr = (r.error || '').trim()
      || (r.stderr || '').split('\n').map((l) => l.trim()).find(Boolean)
      || '';
    const bad = !!r.error || (r.status != null && r.status !== 'ok' && r.status !== 'success')
      || (r.exitCode != null && r.exitCode !== 0);
    if (bad) failed += 1;
    const parts = [r.host || label || '결과'];
    if (r.status) parts.push(r.status);
    parts.push(`exit ${r.exitCode ?? '—'}`);
    if (r.durationMs != null) parts.push(`${r.durationMs}ms`);
    if (bad && firstErr) parts.push(`오류 — ${firstErr.slice(0, 200)}`);
    out.push([bad ? 'error' : 'info', parts.join(' · ')]);
  }
  if (rows.length > 1) {
    out.push([failed ? 'warn' : 'info', `대상 ${rows.length} · 성공 ${rows.length - failed} · 실패 ${failed}`]);
  }
  return out;
}
