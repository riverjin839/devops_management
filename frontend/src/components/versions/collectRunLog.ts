// 수집 모달 공용 — SSH 수집을 SSE 스트림(`POST /clusters/{id}/collect-X/stream`, D-135)으로 실행하고 실행 로그에 쌓는다.
// 서버가 시작 줄·호스트별 "[i/N] host · status · exit · 오류" 줄·단계 칩·"완료 — 호스트 N대 · 변경 · 실패" 줄을
// 직접 흘리므로, 여기서는 서버 줄에 없는 모달별 부가 정보(버전·파라미터 수 등)와 호스트에 묶이지 않은 오류만 덧붙인다.
import { streamLogged, type RunLog, type RunLogEntry } from '@/hooks/useRunLog';
import { versionsCollectStreamUrl, type VersionsCollectKind } from '@/services/api';

export interface CollectHostLike {
  host: string;
  status?: string;
  stored?: boolean;
  error?: string | null;
  rawStderr?: string | null;
  exitCode?: number | null;
}

export interface CollectResponseLike<H extends CollectHostLike> {
  changed: number;
  hosts: H[];
  errors: string[];
}

/** 호스트마다 한 줄씩 남기는 상한 — 서버 단계 칩 상한(30대)과 맞춘다. 넘으면 요약 한 줄로 대신한다. */
const DETAIL_MAX_HOSTS = 30;
/** 상한을 넘을 때 요약 줄에 이름을 붙여 보여줄 저장 호스트 수. */
const STORED_NAMES_MAX = 20;

/** 실행 시작 줄 — "<클러스터> — <대상> · 노드 N대 수집 요청 (sudo)" */
export function collectFirstLine(clusterName: string | undefined, hostCount: number, what: string, useSudo: boolean): string {
  const who = clusterName ? `${clusterName} — ` : '';
  return `${who}${what} · 노드 ${hostCount}대 수집 요청${useSudo ? ' (sudo)' : ''}`;
}

/**
 * 스트림 결과(`result`) → 서버 줄에 없는 내용만 실행 로그 줄로.
 * - 정상 호스트마다 "host · (부가 정보) · 저장됨/변경 없음" 한 줄(호스트 30대 이하). 저장 여부는 서버 줄에
 *   없으므로 `detail` 이 없어도 남긴다.
 * - 30대를 넘으면 "저장됨 N대 · 변경 없음 M대 — 저장: h1, h2 … 외 K대" 요약 한 줄.
 * - 백엔드 `errors` 중 실패 호스트 줄("<host>: …")로 이미 나온 것을 뺀 나머지는 warn 줄.
 */
export function summarizeCollectStream<H extends CollectHostLike>(
  res: CollectResponseLike<H>,
  detail?: (h: H) => string | null | undefined,
): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  const failedHosts = res.hosts
    .filter((h) => !!h.error || (h.status !== undefined && h.status !== 'ok'))
    .map((h) => h.host);
  const okHosts = res.hosts.filter((h) => !failedHosts.includes(h.host));
  if (res.hosts.length <= DETAIL_MAX_HOSTS) {
    for (const h of okHosts) {
      const extra = detail?.(h);
      const parts = [h.host];
      if (extra) parts.push(extra);
      if (h.stored !== undefined) parts.push(h.stored ? '저장됨' : '변경 없음');
      if (parts.length > 1) out.push(['info', parts.join(' · ')]);
    }
  } else {
    const stored = okHosts.filter((h) => h.stored === true).map((h) => h.host);
    const unchanged = okHosts.filter((h) => h.stored === false).length;
    if (stored.length || unchanged) {
      const names = stored.slice(0, STORED_NAMES_MAX).join(', ');
      const rest = stored.length > STORED_NAMES_MAX ? ` 외 ${stored.length - STORED_NAMES_MAX}대` : '';
      out.push(['info', `저장됨 ${stored.length}대 · 변경 없음 ${unchanged}대${stored.length ? ` — 저장: ${names}${rest}` : ''}`]);
    }
  }
  for (const e of res.errors) {
    if (!failedHosts.some((host) => e.startsWith(`${host}:`))) out.push(['warn', e]);
  }
  return out;
}

/**
 * 수집 SSE 를 실행 로그로 흘리고 동기 엔드포인트와 같은 응답 본문을 돌려준다.
 * `useAbortableMutation` 의 mutationFn 안에서 부르면 onSuccess(결과 표·토스트·캐시 무효화)·중지·isPending 이 그대로 동작한다.
 * 실패·중지는 throw 한다(중지는 AbortError 라 useAbortableMutation 이 조용히 넘긴다).
 * `body` 는 기존 `versionsApi.collectX` 에 넘기던 camelCase payload 그대로 — snake_case 변환은 streamLogged 가 한다.
 */
export async function streamCollect<R extends CollectResponseLike<CollectHostLike>>(
  runLog: Pick<RunLog, 'begin' | 'log' | 'setStep' | 'end'>,
  opts: {
    title: string;
    first: string;
    clusterId: string;
    kind: VersionsCollectKind;
    body: unknown;
    signal: AbortSignal;
    detail?: (h: R['hosts'][number]) => string | null | undefined;
  },
): Promise<R> {
  const { title, first, clusterId, kind, body, signal, detail } = opts;
  const r = await streamLogged<R>(runLog, {
    title,
    first,
    url: versionsCollectStreamUrl(clusterId, kind),
    body,
    signal,
    summarize: (res) => summarizeCollectStream<R['hosts'][number]>(res, detail),
  });
  if (!r.ok) throw r.error;
  return r.data;
}
