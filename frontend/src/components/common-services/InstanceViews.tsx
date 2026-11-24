// 공통 서비스 인스턴스 화면의 탭 내용 — 설정(컴포넌트별 최신 값 + 24시간 안 변경 배지) · 변경 이력 · 수집 로그(실행 목록 → 저장된 로그).
import { useMemo, useState } from 'react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, LoadingState, LogViewer, StatusBadge } from '@/components/common';
import { useCommonServiceChanges, useCommonServiceConfig, useCommonServiceRun, useCommonServiceRuns } from '@/hooks/useCommonServices';
import { formatRunLog, toRunLogLevel } from '@/hooks/useRunLog';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';
import { RUN_STATUS, componentLabel } from './labels';

const TH = 'text-left px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border';
const TD = 'px-3 py-1.5 border-b border-border align-top text-sm';
const INPUT = 'px-2.5 py-1.5 rounded-xl border border-border bg-card text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary';

export function ConfigView({ instanceId }: { instanceId: string }) {
  const { data, isLoading } = useCommonServiceConfig(instanceId);
  const [q, setQ] = useState('');
  const comps = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.components ?? []).map((c) => ({
      ...c,
      items: needle ? c.items.filter((i) => i.key.toLowerCase().includes(needle) || (i.value ?? '').toLowerCase().includes(needle)) : c.items,
    })).filter((c) => c.items.length > 0 || !needle);
  }, [data, q]);
  if (isLoading) return <LoadingState />;
  if (!data?.components.length) {
    return <EmptyState compact title="수집한 설정이 없습니다" description="'지금 수집'을 누르거나 다음 주기 수집을 기다리세요." />;
  }
  const total = data.components.reduce((n, c) => n + c.items.length, 0);
  const changed = data.components.reduce((n, c) => n + c.items.filter((i) => i.changed).length, 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input className={`${INPUT} w-64`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="키·값 검색" aria-label="설정 검색" />
        <span className="text-xs text-muted-foreground">컴포넌트 {data.components.length} · 설정 {total}개{changed ? ` · 24시간 안 변경 ${changed}개` : ''}</span>
      </div>
      {comps.map((c) => (
        <MacCard
          key={c.component}
          title={componentLabel(c.component)}
          titleExtra={<span className="text-xs text-muted-foreground font-mono">{c.component}</span>}
          actions={c.collectedAt ? <span className="text-xs text-muted-foreground" title={formatDateTime(c.collectedAt)}>값 기준 {formatRelativeTime(c.collectedAt)}</span> : null}
          bodyPadding="p-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead><tr><th className={`${TH} w-[40%]`}>키</th><th className={TH}>값</th></tr></thead>
              <tbody>
                {c.items.map((i) => (
                  <tr key={i.key}>
                    <td className={`${TD} font-mono text-xs break-all`}>{i.key}</td>
                    <td className={`${TD} font-mono text-xs break-all whitespace-pre-wrap`}>
                      {i.value ?? <span className="text-muted-foreground">없음</span>}
                      {i.changed && (
                        <span className="block mt-0.5 font-sans text-status-warning" title={i.changed.at ? formatDateTime(i.changed.at) : undefined}>
                          {i.changed.at ? formatRelativeTime(i.changed.at) : ''} 변경 · {i.changed.old ?? '없음'} → {i.changed.new ?? '없음'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </MacCard>
      ))}
    </div>
  );
}

export function ChangesView({ instanceId }: { instanceId: string }) {
  const { data, isLoading } = useCommonServiceChanges(instanceId);
  if (isLoading) return <LoadingState />;
  if (!data?.length) return <EmptyState compact title="변경 이력이 없습니다" description="직전 수집과 값이 달라지면 여기에 쌓입니다(첫 수집은 기준값)." />;
  return (
    <MacCard title={`변경 ${data.length}건`} bodyPadding="p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead><tr><th className={TH}>감지 시각</th><th className={TH}>컴포넌트</th><th className={TH}>키</th><th className={TH}>전 → 후</th><th className={TH}>경로</th></tr></thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id}>
                <td className={`${TD} text-xs whitespace-nowrap`}>{c.detectedAt ? formatDateTime(c.detectedAt) : '—'}</td>
                <td className={`${TD} text-xs`}>{componentLabel(c.component)}</td>
                <td className={`${TD} font-mono text-xs break-all`}>{c.key}</td>
                <td className={`${TD} font-mono text-xs break-all`}>{c.oldValue ?? '없음'} → {c.newValue ?? '없음'}</td>
                <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>{c.source === 'schedule' ? '주기 수집' : '수동 수집'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </MacCard>
  );
}

export function RunsView({ instanceId }: { instanceId: string }) {
  const { data, isLoading } = useCommonServiceRuns(instanceId);
  const [sel, setSel] = useState<string | null>(null);
  const { data: detail, isLoading: detailLoading } = useCommonServiceRun(instanceId, sel);
  const text = useMemo(() => formatRunLog((detail?.logLines ?? []).map(([ts, level, message]) => ({ ts, level: toRunLogLevel(level), message }))), [detail]);
  if (isLoading) return <LoadingState />;
  if (!data?.length) return <EmptyState compact title="실행 기록이 없습니다" description="수집·접속 테스트를 실행하면 단계와 로그가 남습니다." />;
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,420px)_1fr]">
      <MacCard title="실행 목록" bodyPadding="p-0">
        <ul className="divide-y divide-border" aria-label="실행 목록">
          {data.map((r) => {
            const st = RUN_STATUS[r.status];
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSel(r.id)}
                  aria-current={sel === r.id ? 'true' : undefined}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-secondary ${sel === r.id ? 'bg-primary/10' : ''}`}
                >
                  <span className="flex items-center gap-2">
                    <StatusBadge variant={st.variant} label={st.label} />
                    <span className="text-foreground">{r.kind === 'test' ? '접속 테스트' : '수집'} · {r.trigger === 'schedule' ? '주기' : r.startedBy ?? '수동'}</span>
                  </span>
                  <span className="block mt-0.5 text-muted-foreground">
                    {r.startedAt ? formatDateTime(r.startedAt) : ''}
                    {r.summary.keys !== undefined ? ` · 설정 ${r.summary.keys}개` : ''}
                    {r.summary.changed ? ` · 변경 ${r.summary.changed}건` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </MacCard>
      <MacCard title="실행 로그">
        {!sel ? <p className="text-sm text-muted-foreground">왼쪽에서 실행을 고르세요.</p>
          : detailLoading || !detail ? <LoadingState />
            : (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {detail.steps.map((s) => (
                    <StatusBadge key={s.name} variant={s.status === 'done' ? 'healthy' : s.status === 'failed' ? 'critical' : 'loading'}
                      label={s.label} title={s.message || undefined} />
                  ))}
                </div>
                <LogViewer text={text} maxHeight="max-h-[60vh]" popoutTitle="공통 서비스 실행 로그" />
              </div>
            )}
      </MacCard>
    </div>
  );
}
