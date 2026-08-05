/**
 * 감사 로그 조회 — Settings ▸ 감사 로그 탭 (admin 전용, SettingsPage 라우트 자체가 RequireAdmin).
 *
 * 로그인 성공/실패, 사용자 CRUD, 역할 변경, 클러스터/플레이북 등 위험 작업 기록 표시.
 */
import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';

import { MacCard } from '@/components/ui/MacCard';
import { auditLogsApi } from '@/services/api';
import type { AuditLog } from '@/types';
import { formatApiError, parseUTC } from '@/lib/utils';

// `*.  ` 로 끝나는 항목은 prefix(패밀리) 필터 — 백엔드 action_prefix 로 전달된다.
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
  'batch_job.*',
  'batch_job.create',
  'batch_job.update',
  'batch_job.delete',
  'batch_job.run',
  'batch_job.bulk_run',
  'batch_job.stop',
  'k8s.scale',
  'k8s.restart',
  'k8s.delete',
  'k8s.apply',
  'k8s.cordon',
  'k8s.drain',
  'k8s.exec.open',
  'k8s.exec.close',
  'metric.snapshot.run',
  'metric.snapshot.edit',
  'metric.check.toggle',
  'metric.item.create',
  'metric.item.update',
  'metric.item.delete',
  'metric.schedule.update',
  'cilium.exec',
];

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'success'
      ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
      : 'bg-rose-500/15 text-rose-700 border-rose-500/30';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-sm font-medium border rounded-md ${cls}`}>
      {status}
    </span>
  );
}

/** 중첩 객체/배열을 "a.b.c" 경로 키로 평탄화 — details 를 테이블 행으로 펼치기 위함. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenDetails(value: any, prefix = '', out: [string, string][] = []): [string, string][] {
  if (value === null || value === undefined) {
    out.push([prefix || '-', '-']);
  } else if (Array.isArray(value)) {
    if (value.length === 0) out.push([prefix, '[]']);
    else if (value.every((v) => typeof v !== 'object' || v === null)) {
      out.push([prefix, value.map((v) => String(v)).join(', ')]);
    } else {
      value.forEach((v, i) => flattenDetails(v, prefix ? `${prefix}[${i}]` : `[${i}]`, out));
    }
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      flattenDetails(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    out.push([prefix, String(value)]);
  }
  return out;
}

function DetailsCell({ row }: { row: AuditLog }) {
  const [open, setOpen] = useState(false);
  if (!row.details) return <span className="text-sm text-muted-foreground">-</span>;
  const summary = Object.entries(row.details)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' · ');
  if (!open) {
    // 접힘: 기존 한 줄 요약 — 클릭하면 key/value 테이블로 펼침 (JSON 원문보다 판독 쉬움).
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="클릭해 표로 펼치기"
        className="text-left w-full"
      >
        <code className="text-xs text-muted-foreground break-all line-clamp-2 hover:text-foreground">
          {summary}
        </code>
      </button>
    );
  }
  const rows = flattenDetails(row.details);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="w-full px-2 py-1 text-left text-xs text-muted-foreground bg-secondary/40 hover:bg-secondary/60"
      >
        접기 ▲
      </button>
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={`${k}-${i}`} className="border-t border-border align-top">
              <td className="px-2 py-1 font-mono text-muted-foreground whitespace-nowrap">{k}</td>
              <td className="px-2 py-1 font-mono break-all">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditLogManager() {
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [action, setAction] = useState('');
  const [actorUsername, setActorUsername] = useState('');
  const [status, setStatus] = useState('');

  // 'batch_job.*' 류 패밀리 선택은 prefix 필터로 변환해 하위 액션 전부를 조회.
  const isPrefix = action.endsWith('.*');
  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ['audit-logs', page, pageSize, action, actorUsername, status],
    queryFn: async () =>
      (await auditLogsApi.list({
        page,
        pageSize,
        action: !isPrefix && action ? action : undefined,
        actionPrefix: isPrefix ? action.slice(0, -1) : undefined,
        actorUsername: actorUsername || undefined,
        status: status || undefined,
      })).data,
  });

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, Math.ceil(data.total / data.pageSize));
  }, [data]);

  return (
    <MacCard title="감사 로그">
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div className="flex flex-col">
          <label htmlFor={f('action')} className="text-sm text-muted-foreground mb-1">액션</label>
          <select
            id={f('action')}
            value={action}
            onChange={(e) => { setAction(e.target.value); setPage(1); }}
            className="px-2 py-1.5 bg-background border border-border rounded-xl text-sm min-w-[160px]"
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>{a || '전체'}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col">
          <label htmlFor={f('username')} className="text-sm text-muted-foreground mb-1">사용자</label>
          <input
            id={f('username')}
            value={actorUsername}
            onChange={(e) => setActorUsername(e.target.value)}
            onBlur={() => setPage(1)}
            onKeyDown={(e) => { if (e.key === 'Enter') setPage(1); }}
            placeholder="username"
            className="px-2 py-1.5 bg-background border border-border rounded-xl text-sm w-[160px]"
          />
        </div>
        <div className="flex flex-col">
          <label htmlFor={f('status')} className="text-sm text-muted-foreground mb-1">상태</label>
          <select
            id={f('status')}
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="px-2 py-1.5 bg-background border border-border rounded-xl text-sm"
          >
            <option value="">전체</option>
            <option value="success">success</option>
            <option value="failure">failure</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => { setPage(1); refetch(); }}
          className="px-3 py-1.5 text-sm bg-secondary border border-border rounded-xl hover:bg-muted flex items-center gap-1"
        >
          <Search className="w-3.5 h-3.5" /> 조회
        </button>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-3 py-1.5 text-sm bg-secondary border border-border rounded-xl hover:bg-muted flex items-center gap-1"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          새로고침
        </button>
        <div className="ml-auto text-sm text-muted-foreground">
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
                <td className="py-2 pr-3 whitespace-nowrap text-sm text-muted-foreground">
                  {parseUTC(row.createdAt).toLocaleString()}
                </td>
                <td className="py-2 pr-3 font-medium">{row.actorUsername}</td>
                <td className="py-2 pr-3"><code className="text-sm">{row.action}</code></td>
                <td className="py-2 pr-3 text-sm text-muted-foreground">
                  {row.targetType ? `${row.targetType}` : '-'}
                  {row.targetId ? <span className="block text-xs opacity-70 break-all">{row.targetId}</span> : null}
                </td>
                <td className="py-2 pr-3"><StatusBadge status={row.status} /></td>
                <td className="py-2 pr-3 text-sm text-muted-foreground font-mono">{row.ip || '-'}</td>
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
          className="px-3 py-1 text-sm bg-secondary border border-border rounded-md hover:bg-muted disabled:opacity-50"
        >
          이전
        </button>
        <span className="px-3 py-1 text-sm">{page} / {totalPages}</span>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          disabled={page >= totalPages || isFetching}
          className="px-3 py-1 text-sm bg-secondary border border-border rounded-md hover:bg-muted disabled:opacity-50"
        >
          다음
        </button>
      </div>
    </MacCard>
  );
}
