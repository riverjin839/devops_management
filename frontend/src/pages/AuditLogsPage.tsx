/**
 * 감사 로그 조회 페이지 — admin 전용.
 *
 * 로그인 성공/실패, 사용자 CRUD, 역할 변경, 클러스터/플레이북 등 위험 작업 기록 표시.
 */
import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Search, FileSearch } from 'lucide-react';

import { MacCard } from '@/components/ui/MacCard';
import { RoleGate } from '@/components/auth/RoleGate';
import { auditLogsApi } from '@/services/api';
import type { AuditLog } from '@/types';
import { formatApiError } from '@/lib/utils';

const ACTIONS: string[] = [
  '',
  'login.success',
  'login.failure',
  'user.create',
  'user.delete',
  'user.role.update',
  'user.password.change',
  'user.password.reset',
  'cluster.create',
  'cluster.delete',
  'playbook.run',
  'bulk_exec.run',
  'etcdctl.run',
  'backup.import',
];

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'success'
      ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
      : 'bg-rose-500/15 text-rose-700 border-rose-500/30';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium border rounded-md ${cls}`}>
      {status}
    </span>
  );
}

function DetailsCell({ row }: { row: AuditLog }) {
  if (!row.details) return <span className="text-xs text-muted-foreground">-</span>;
  // 보기 좋게 key:value 한 줄에 표현.
  return (
    <code className="text-[11px] text-muted-foreground break-all">
      {Object.entries(row.details)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' · ')}
    </code>
  );
}

export function AuditLogsPage() {
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [action, setAction] = useState('');
  const [actorUsername, setActorUsername] = useState('');
  const [status, setStatus] = useState('');

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ['audit-logs', page, pageSize, action, actorUsername, status],
    queryFn: async () =>
      (await auditLogsApi.list({
        page,
        pageSize,
        action: action || undefined,
        actorUsername: actorUsername || undefined,
        status: status || undefined,
      })).data,
  });

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.total / data.pageSize));
  }, [data]);

  const content = (
    <MacCard title="감사 로그">
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div className="flex flex-col">
          <label htmlFor={f('action')} className="text-xs text-muted-foreground mb-1">액션</label>
          <select
            id={f('action')}
            value={action}
            onChange={(e) => { setAction(e.target.value); setPage(1); }}
            className="px-2 py-1.5 bg-background border border-border rounded-xl text-xs min-w-[160px]"
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>{a || '전체'}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col">
          <label htmlFor={f('username')} className="text-xs text-muted-foreground mb-1">사용자</label>
          <input
            id={f('username')}
            value={actorUsername}
            onChange={(e) => setActorUsername(e.target.value)}
            onBlur={() => setPage(1)}
            onKeyDown={(e) => { if (e.key === 'Enter') setPage(1); }}
            placeholder="username"
            className="px-2 py-1.5 bg-background border border-border rounded-xl text-xs w-[160px]"
          />
        </div>
        <div className="flex flex-col">
          <label htmlFor={f('status')} className="text-xs text-muted-foreground mb-1">상태</label>
          <select
            id={f('status')}
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="px-2 py-1.5 bg-background border border-border rounded-xl text-xs"
          >
            <option value="">전체</option>
            <option value="success">success</option>
            <option value="failure">failure</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => { setPage(1); refetch(); }}
          className="px-3 py-1.5 text-xs bg-secondary border border-border rounded-xl hover:bg-muted flex items-center gap-1"
        >
          <Search className="w-3.5 h-3.5" /> 조회
        </button>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-3 py-1.5 text-xs bg-secondary border border-border rounded-xl hover:bg-muted flex items-center gap-1"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          새로고침
        </button>
        <div className="ml-auto text-xs text-muted-foreground">
          {data ? `총 ${data.total}건 · ${data.page}/${totalPages}` : '-'}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive mb-3">
          감사 로그 조회 실패: {formatApiError(error)}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left">
            <tr>
              <th className="py-2 pr-3 font-medium whitespace-nowrap">시각</th>
              <th className="py-2 pr-3 font-medium">사용자</th>
              <th className="py-2 pr-3 font-medium">액션</th>
              <th className="py-2 pr-3 font-medium">대상</th>
              <th className="py-2 pr-3 font-medium">상태</th>
              <th className="py-2 pr-3 font-medium">IP</th>
              <th className="py-2 pr-3 font-medium">상세</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-0 align-top">
                <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted-foreground">
                  {new Date(row.createdAt).toLocaleString()}
                </td>
                <td className="py-2 pr-3 font-medium">{row.actorUsername}</td>
                <td className="py-2 pr-3"><code className="text-xs">{row.action}</code></td>
                <td className="py-2 pr-3 text-xs text-muted-foreground">
                  {row.targetType ? `${row.targetType}` : '-'}
                  {row.targetId ? <span className="block text-[10px] opacity-70 break-all">{row.targetId}</span> : null}
                </td>
                <td className="py-2 pr-3"><StatusBadge status={row.status} /></td>
                <td className="py-2 pr-3 text-xs text-muted-foreground font-mono">{row.ip || '-'}</td>
                <td className="py-2 pr-3 max-w-[420px]"><DetailsCell row={row} /></td>
              </tr>
            ))}
            {!isFetching && (!data || data.items.length === 0) && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  표시할 감사 로그가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-center gap-1 mt-3">
        <button
          type="button"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page <= 1 || isFetching}
          className="px-3 py-1 text-xs bg-secondary border border-border rounded-md hover:bg-muted disabled:opacity-50"
        >
          이전
        </button>
        <span className="px-3 py-1 text-xs">{page} / {totalPages}</span>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages || isFetching}
          className="px-3 py-1 text-xs bg-secondary border border-border rounded-md hover:bg-muted disabled:opacity-50"
        >
          다음
        </button>
      </div>
    </MacCard>
  );

  return (
    <div className="min-h-screen bg-background p-5">
      <div className="max-w-[1600px] mx-auto space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <FileSearch className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold">감사 로그</h1>
        </div>
        <RoleGate
          allow={['admin']}
          fallback={
            <MacCard>
              <p className="text-sm text-muted-foreground py-4 text-center">
                이 페이지는 admin 권한이 필요합니다.
              </p>
            </MacCard>
          }
        >
          {content}
        </RoleGate>
      </div>
    </div>
  );
}
