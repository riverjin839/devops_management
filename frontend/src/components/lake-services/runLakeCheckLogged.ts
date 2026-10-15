// LAKE 서비스 "지금 점검"(POST /lake-services/{id}/check, 동기) 을 실행 로그로 감싸는 공용 헬퍼(D-128).
// 목록 카드와 상세 페이지가 같은 줄 형식을 쓰도록 한 곳에 둔다.
// 비활성 서비스는 백엔드가 409 를 돌려준다 — 실패가 아니라 "점검 대상 아님" 이라 warn 줄로 남긴다.
import axios from 'axios';
import { runLogged, type RunLog, type RunLogEntry, type RunLogLevel, type RunLoggedResult } from '@/hooks/useRunLog';
import { formatApiError, parseUTC } from '@/lib/utils';
import type { LakeServiceCheck } from '@/types';

export type LakeCheckOutcome =
  | { kind: 'ok'; data: LakeServiceCheck }
  | { kind: 'disabled'; detail: string };

const STATUS_KO: Record<string, string> = { healthy: '정상', warning: '경고', critical: '위험', pending: '대기' };
const LEVEL: Record<string, RunLogLevel> = { healthy: 'info', warning: 'warn', critical: 'error', pending: 'warn' };
const MAX_DETAIL_LINES = 12;

function detailLines(details: Record<string, unknown> | null | undefined): RunLogEntry[] {
  const entries = Object.entries(details ?? {});
  const lines = entries.slice(0, MAX_DETAIL_LINES).map(([k, v]): RunLogEntry => {
    const text = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
    return ['info', `  ${k}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`];
  });
  if (entries.length > MAX_DETAIL_LINES) lines.push(['info', `  … 외 ${entries.length - MAX_DETAIL_LINES}개 항목`]);
  return lines;
}

export function runLakeCheckLogged(
  run: Pick<RunLog, 'begin' | 'log' | 'end'>,
  opts: { name: string; endpoint?: string | null; call: () => Promise<LakeServiceCheck> },
): Promise<RunLoggedResult<LakeCheckOutcome>> {
  const { name, endpoint, call } = opts;
  return runLogged(run, {
    title: `LAKE 점검 — ${name}`,
    first: `${name} 헬스체크 요청${endpoint ? ` · ${endpoint}` : ''}`,
    fn: async (): Promise<LakeCheckOutcome> => {
      try {
        return { kind: 'ok', data: await call() };
      } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 409) {
          return { kind: 'disabled', detail: formatApiError(e) };
        }
        throw e;
      }
    },
    summarize: (o) => {
      if (o.kind === 'disabled') return [['warn', `비활성 서비스 — 점검하지 않음 (${o.detail})`]];
      const c = o.data;
      return [
        [
          LEVEL[c.status] ?? 'warn',
          `${name} · ${STATUS_KO[c.status] ?? c.status}${c.responseTimeMs != null ? ` · 응답 ${c.responseTimeMs}ms` : ''}${c.message ? ` · ${c.message}` : ''}`,
        ],
        ...detailLines(c.details),
        ['info', `점검 시각 ${c.checkedAt ? parseUTC(c.checkedAt).toLocaleString('ko-KR') : '—'}`],
      ];
    },
  });
}
