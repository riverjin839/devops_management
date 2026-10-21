/**
 * 서버 오류 조회 — Settings ▸ 서버 오류 탭 (admin 전용, SettingsPage 라우트 자체가 RequireAdmin).
 *
 * 처리 안 된 예외·5xx 응답을 요청 ID 로 찾는다. 화면 오류 토스트의 "원인 보기"가 `?rid=` 로 이 탭을 연다.
 * 한 행을 펼치면 스택(LogViewer)과, 같은 요청이 남긴 감사 기록을 함께 보여준다.
 * 파드 로그는 재시작하면 사라지므로, 어디서 왜 실패했는지는 여기가 원천이다(보존 30일).
 */
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RefreshCw, Search } from 'lucide-react';

import { MacCard } from '@/components/ui/MacCard';
import { EmptyState } from '@/components/common/EmptyState';
import { LogViewer } from '@/components/common/LogViewer';
import { useUrlParams } from '@/hooks/useUrlParams';
import { systemErrorsApi } from '@/services/api';
import { formatApiError, parseUTC } from '@/lib/utils';
import type { SystemErrorLog } from '@/types';

const PAGE_SIZE = 50;

export function SystemErrorManager() {
  const f = useId();
  const [params, setParams] = useUrlParams({ rid: '' });
  const [ridInput, setRidInput] = useState(params.rid);
  const [path, setPath] = useState('');
  const [pathApplied, setPathApplied] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ['system-errors', params.rid, pathApplied, page],
    queryFn: async () => (await systemErrorsApi.list({
      requestId: params.rid || undefined, path: pathApplied || undefined, page, pageSize: PAGE_SIZE,
    })).data,
  });

  const search = () => {
    setPage(1);
    setPathApplied(path.trim());
    setParams({ rid: ridInput.trim() });
  };
  const items = data?.items ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  // 요청 ID 로 찾았고 한 건뿐이면 바로 펼친다(토스트 "원인 보기"로 들어온 경우).
  const autoOpen = params.rid && items.length === 1 ? items[0].id : null;

  return (
    <MacCard
      title="서버 오류"
      actions={(
        <button
          type="button"
          onClick={() => void refetch()}
          title="새로고침"
          aria-label="새로고침"
          className="p-1.5 rounded-xl hover:bg-secondary text-muted-foreground"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      )}
    >
      <p className="text-sm text-muted-foreground mb-3">
        처리 안 된 예외와 5xx 응답을 요청 ID 와 함께 30일 보관한다. 화면 오류 메시지의 &quot;요청 ID&quot; 를 넣으면 그 요청의 스택·파드·버전과
        같은 요청이 남긴 감사 기록을 볼 수 있다. 서버 로그에서도 같은 ID 가 <code className="font-mono">[req=…]</code> 로 찍힌다.
      </p>
      <form
        className="flex flex-wrap items-end gap-2 mb-3"
        onSubmit={(e) => { e.preventDefault(); search(); }}
      >
        <div className="flex flex-col">
          <label htmlFor={`${f}-rid`} className="text-sm text-muted-foreground mb-1">요청 ID</label>
          <input
            id={`${f}-rid`}
            value={ridInput}
            onChange={(e) => setRidInput(e.target.value)}
            placeholder="앞부분만 넣어도 된다"
            className="px-2 py-1.5 bg-background border border-border rounded-xl text-sm w-[220px] font-mono"
          />
        </div>
        <div className="flex flex-col">
          <label htmlFor={`${f}-path`} className="text-sm text-muted-foreground mb-1">경로</label>
          <input
            id={`${f}-path`}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/api/v1/check-matrix"
            className="px-2 py-1.5 bg-background border border-border rounded-xl text-sm w-[240px] font-mono"
          />
        </div>
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-sm"
        >
          <Search className="w-4 h-4" aria-hidden="true" />찾기
        </button>
      </form>

      {error ? (
        <p className="text-sm text-status-critical">{formatApiError(error)}</p>
      ) : items.length === 0 && !isFetching ? (
        <EmptyState
          compact
          title={params.rid ? '이 요청 ID 로 남은 서버 오류가 없습니다' : '최근 서버 오류가 없습니다'}
          description={params.rid
            ? '4xx(입력·권한 오류)는 기록하지 않는다. 응답이 아예 없었다면(타임아웃) 서버 로그에서 [req=ID] 로 찾는다.'
            : '처리 안 된 예외·5xx 응답이 생기면 여기에 쌓인다.'}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left">
              <tr className="border-b border-border">
                <th className="py-1.5 pr-2 w-6" aria-label="펼치기" />
                <th className="py-1.5 pr-2">시각</th>
                <th className="py-1.5 pr-2">상태</th>
                <th className="py-1.5 pr-2">요청</th>
                <th className="py-1.5 pr-2">오류</th>
                <th className="py-1.5 pr-2">사용자</th>
                <th className="py-1.5 pr-2">파드·버전</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <ErrorRow
                  key={r.id}
                  row={r}
                  open={openId === r.id || (openId === null && autoOpen === r.id)}
                  onToggle={() => setOpenId((cur) => (cur === r.id ? '' : r.id))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {params.rid && (data?.relatedAudit.length ?? 0) > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-semibold text-muted-foreground mb-1">같은 요청의 감사 기록</h3>
          <ul className="text-sm space-y-0.5">
            {data!.relatedAudit.map((a) => (
              <li key={a.id} className="font-mono text-xs">
                {parseUTC(a.createdAt).toLocaleString('ko-KR')} · {a.action} · {a.status} · {a.actorUsername}
                {a.targetType ? ` · ${a.targetType}:${a.targetId ?? ''}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 mt-3 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="px-2 py-1 rounded-xl border border-border disabled:opacity-50">이전</button>
          <span className="text-muted-foreground tabular-nums">{page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
            className="px-2 py-1 rounded-xl border border-border disabled:opacity-50">다음</button>
        </div>
      )}
    </MacCard>
  );
}

function ErrorRow({ row, open, onToggle }: { row: SystemErrorLog; open: boolean; onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <tr className="border-b border-border align-top hover:bg-secondary/40 cursor-pointer" onClick={onToggle}>
        <td className="py-1.5 pr-2">
          <button type="button" aria-expanded={open} aria-label={open ? '접기' : '펼치기'} title={open ? '접기' : '펼치기'}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            <Chevron className="w-4 h-4 text-muted-foreground" />
          </button>
        </td>
        <td className="py-1.5 pr-2 whitespace-nowrap tabular-nums">{parseUTC(row.createdAt).toLocaleString('ko-KR')}</td>
        <td className="py-1.5 pr-2 text-status-critical tabular-nums">{row.statusCode}</td>
        <td className="py-1.5 pr-2 font-mono text-xs break-all">
          {row.method} {row.path}
          <div className="text-muted-foreground">req {row.requestId ?? '-'}</div>
        </td>
        <td className="py-1.5 pr-2 break-all">
          {row.errorType && <span className="font-mono text-xs">{row.errorType} </span>}
          <span className="line-clamp-2">{row.message ?? '-'}</span>
        </td>
        <td className="py-1.5 pr-2">{row.username ?? '-'}</td>
        <td className="py-1.5 pr-2 font-mono text-xs">
          {row.pod ?? '-'}
          <div className="text-muted-foreground">v{row.appVersion ?? '?'}{row.durationMs != null ? ` · ${row.durationMs}ms` : ''}</div>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border">
          <td colSpan={7} className="py-2 pl-6 pr-2 space-y-2">
            {row.message && <p className="text-sm break-all whitespace-pre-wrap">{row.message}</p>}
            {row.traceback
              ? <LogViewer text={row.traceback} maxHeight="max-h-96" asError />
              : <p className="text-xs text-muted-foreground">스택이 없다 — 라우터가 직접 5xx 로 돌려준 응답이다. 위 사유와 같은 요청 ID 의 서버 로그를 본다.</p>}
          </td>
        </tr>
      )}
    </>
  );
}
