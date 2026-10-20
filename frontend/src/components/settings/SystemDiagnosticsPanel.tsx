/**
 * 시스템 진단 — Settings ▸ 시스템 진단 탭 (admin 전용, SettingsPage 라우트 자체가 RequireAdmin).
 *
 * "지금 어디가 문제인가" 를 한 화면에서 본다: backend 파드·버전(섞임 경고), 부팅 마이그레이션(실패 단계·미룬 DDL),
 * Celery 워커·큐, DB 연결·오래 열린 트랜잭션·lock 대기(막는 pid), 점검 수행 적체, 최근 서버 오류.
 * 섹션마다 따로 수집되고 실패한 섹션은 "수집 실패" 로만 보인다(나머지는 계속 보인다).
 * 판정 근거(임계값)는 서버 응답의 `thresholds` 를 그대로 보여 준다.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

import { MacCard } from '@/components/ui/MacCard';
import { EmptyState } from '@/components/common/EmptyState';
import { systemDiagnosticsApi } from '@/services/api';
import { formatApiError, parseUTC } from '@/lib/utils';
import { serverErrorsPath } from '@/lib/requestId';
import type { DiagStatus, SystemDiagnostics } from '@/types';

const STATUS_META: Record<DiagStatus, { label: string; cls: string }> = {
  // 정상은 중립색 — 상태색은 비정상에만(DESIGN_SYSTEM §12.12).
  ok: { label: '정상', cls: 'text-muted-foreground border-border' },
  warning: { label: '주의', cls: 'text-status-warning border-status-warning/50' },
  critical: { label: '위험', cls: 'text-status-critical border-status-critical/50' },
  offline: { label: '수집 실패', cls: 'text-muted-foreground border-dashed border-border' },
};

function StatusChip({ status }: { status: DiagStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.offline;
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-medium ${m.cls}`}>{m.label}</span>;
}

function SectionCard({
  title, section, children,
}: { title: string; section: { status: DiagStatus; error?: string; problems?: string[] }; children?: React.ReactNode }) {
  return (
    <MacCard title={title} actions={<StatusChip status={section.status} />}>
      {section.error && <p className="text-sm text-status-critical break-all mb-2">{section.error}</p>}
      {(section.problems?.length ?? 0) > 0 && (
        <ul className="text-sm space-y-0.5 mb-2">
          {section.problems!.map((p) => <li key={p} className="break-all">{p}</li>)}
        </ul>
      )}
      {children}
    </MacCard>
  );
}

function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null) return '-';
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분`;
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
}

const fmtTime = (iso: string | null | undefined) => (iso ? parseUTC(iso).toLocaleString('ko-KR') : '-');

export function SystemDiagnosticsPanel() {
  const [auto, setAuto] = useState(true);
  const { data, isFetching, refetch, error, dataUpdatedAt } = useQuery({
    queryKey: ['system-diagnostics'],
    queryFn: async () => (await systemDiagnosticsApi.get()).data,
    refetchInterval: auto ? 30_000 : false,
  });

  const header = (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {data && <span className="inline-flex items-center gap-1.5">전체 <StatusChip status={data.overall} /></span>}
      <span className="text-muted-foreground">
        {dataUpdatedAt ? `수집 ${new Date(dataUpdatedAt).toLocaleTimeString('ko-KR')}` : '수집 중…'}
      </span>
      <label className="inline-flex items-center gap-1.5 text-muted-foreground">
        <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
        30초마다 자동 갱신
      </label>
      <button
        type="button"
        onClick={() => void refetch()}
        title="지금 다시 수집"
        aria-label="지금 다시 수집"
        className="p-1.5 rounded-xl hover:bg-secondary text-muted-foreground"
      >
        <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
      </button>
    </div>
  );

  if (error && !data) {
    return (
      <MacCard title="시스템 진단" actions={header}>
        <p className="text-sm text-status-critical whitespace-pre-wrap">{formatApiError(error)}</p>
      </MacCard>
    );
  }
  if (!data) return <MacCard title="시스템 진단" actions={header}><p className="text-sm text-muted-foreground">수집 중…</p></MacCard>;

  return (
    <div className="space-y-4">
      <MacCard title="시스템 진단" actions={header}>
        <p className="text-sm text-muted-foreground">
          backend 파드·부팅 마이그레이션·Celery·DB·점검 수행·서버 오류를 한 번에 본다. 문제가 있는 섹션만 색이 붙고,
          수집하지 못한 섹션은 &quot;수집 실패&quot; 로 사유를 보여 준다. 오류 한 건을 끝까지 추적하려면 서버 오류 탭에서 요청 ID 로 찾는다.
        </p>
        <Problems data={data} />
      </MacCard>
      <PodsCard data={data} />
      <BootCard data={data} />
      <CeleryCard data={data} />
      <DatabaseCard data={data} />
      <RunsCard data={data} />
      <ErrorsCard data={data} />
    </div>
  );
}

/** 섹션별 문제를 맨 위에 한 줄씩 모은다 — 여기만 봐도 어디부터 볼지 안다. */
function Problems({ data }: { data: SystemDiagnostics }) {
  const rows: { area: string; text: string; status: DiagStatus }[] = [];
  const add = (area: string, s: { status: DiagStatus; error?: string; problems?: string[] }) => {
    if (s.error) rows.push({ area, text: s.error, status: s.status });
    for (const p of s.problems ?? []) rows.push({ area, text: p, status: s.status });
  };
  add('파드', data.pods);
  add('부팅', data.boot);
  if ((data.boot.pendingDdl?.length ?? 0) > 0) rows.push({ area: '부팅', text: `미룬 DDL: ${data.boot.pendingDdl!.join(', ')}`, status: 'critical' });
  add('Celery', data.celery);
  add('DB', data.database);
  add('점검 수행', data.runs);
  if ((data.errors.last1h ?? 0) > 0) rows.push({ area: '서버 오류', text: `최근 1시간 ${data.errors.last1h}건`, status: data.errors.status });
  if (data.respondingPod.version && data.respondingPod.version !== __APP_VERSION__) {
    rows.push({ area: '버전', text: `화면 v${__APP_VERSION__} · 응답한 backend v${data.respondingPod.version} — 배포 중이거나 브라우저 캐시`, status: 'warning' });
  }
  if (rows.length === 0) return <p className="mt-2 text-sm">발견된 문제가 없다.</p>;
  return (
    <ul className="mt-2 space-y-1 text-sm">
      {rows.map((r, i) => (
        <li key={`${r.area}-${i}`} className="flex items-start gap-2">
          <StatusChip status={r.status} />
          <span className="text-muted-foreground whitespace-nowrap">{r.area}</span>
          <span className="break-all">{r.text}</span>
        </li>
      ))}
    </ul>
  );
}

function PodsCard({ data }: { data: SystemDiagnostics }) {
  const rp = data.respondingPod;
  const pods = data.pods.pods ?? [];
  return (
    <SectionCard title="backend 파드" section={data.pods}>
      <p className="text-sm mb-2">
        응답한 파드 <span className="font-mono">{rp.pod ?? '-'}</span> · v{rp.version ?? '?'} · 기동 {fmtAge(rp.uptimeSeconds)} 전
        {rp.rssMb != null && ` · 메모리 ${rp.rssMb}MiB`} · 화면 v{__APP_VERSION__}
      </p>
      {pods.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left">
              <tr className="border-b border-border">
                <th className="py-1 pr-2">파드</th><th className="py-1 pr-2">버전</th><th className="py-1 pr-2">기동</th>
                <th className="py-1 pr-2">부팅 소요</th><th className="py-1 pr-2">메모리</th><th className="py-1 pr-2">부팅 문제</th>
                <th className="py-1 pr-2">마지막 신호</th>
              </tr>
            </thead>
            <tbody>
              {pods.map((p) => (
                <tr key={p.pod} className="border-b border-border align-top">
                  <td className="py-1 pr-2 font-mono text-xs">{p.pod}</td>
                  <td className="py-1 pr-2 tabular-nums">{p.version ?? '-'}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">{fmtTime(p.processStartedAt)}</td>
                  <td className="py-1 pr-2 tabular-nums">{p.bootDurationMs != null ? `${(p.bootDurationMs / 1000).toFixed(1)}초` : '부팅 중'}</td>
                  <td className="py-1 pr-2 tabular-nums">{p.rssMb != null ? `${p.rssMb}MiB` : '-'}</td>
                  <td className="py-1 pr-2 break-all">
                    {[...p.failedSteps.map((s) => `실패 ${s}`), ...p.pendingDdl.map((d) => `미룬 DDL ${d}`)].join(' · ') || '-'}
                  </td>
                  <td className="py-1 pr-2 whitespace-nowrap">{fmtTime(p.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function BootCard({ data }: { data: SystemDiagnostics }) {
  const b = data.boot;
  return (
    <SectionCard title="부팅 마이그레이션 (응답한 파드)" section={b}>
      <p className="text-sm mb-2">
        {b.startedAt ? `시작 ${fmtTime(b.startedAt)} · ` : ''}
        {b.durationMs != null ? `소요 ${(b.durationMs / 1000).toFixed(1)}초` : '진행 중이거나 기록 없음'}
        {` · 단계 ${b.stepCount ?? 0}개 · 직렬화 lock ${b.advisoryLock ?? '-'}`}
      </p>
      {(b.failedSteps?.length ?? 0) > 0 && (
        <ul className="text-sm space-y-0.5 mb-2">
          {b.failedSteps!.map((s) => <li key={s.name} className="break-all"><span className="font-mono">{s.name}</span> — {s.error}</li>)}
        </ul>
      )}
      {(b.slowSteps?.length ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground">
          오래 걸린 단계: {b.slowSteps!.map((s) => `${s.name} ${(s.durationMs / 1000).toFixed(1)}초`).join(' · ')}
        </p>
      )}
    </SectionCard>
  );
}

function CeleryCard({ data }: { data: SystemDiagnostics }) {
  const c = data.celery;
  return (
    <SectionCard title="Celery 워커·큐" section={c}>
      {c.queues && (
        <p className="text-sm mb-2">
          대기열: {Object.entries(c.queues).map(([q, n]) => `${q} ${n}건`).join(' · ')}
          {` (경고 기준 ${data.thresholds.queueLengthWarning ?? '-'}건)`}
        </p>
      )}
      {(c.workers?.length ?? 0) > 0 ? (
        <ul className="text-sm space-y-0.5">
          {c.workers!.map((w) => (
            <li key={w.name} className="font-mono text-xs">{w.name} — 실행 중 {w.active} · 예약 {w.reserved}</li>
          ))}
        </ul>
      ) : c.status !== 'offline' && <p className="text-sm text-muted-foreground">응답한 워커가 없다.</p>}
    </SectionCard>
  );
}

function DatabaseCard({ data }: { data: SystemDiagnostics }) {
  const d = data.database;
  return (
    <SectionCard title="데이터베이스" section={d}>
      {d.connections && (
        <p className="text-sm mb-2">
          연결 {d.connections.total}/{d.connections.max} ({Math.round(d.connections.usage * 100)}%)
          {d.pool && ` · 이 파드 풀 사용 ${d.pool.checkedOut ?? '-'}/${d.pool.size ?? '-'} (+초과 ${d.pool.overflow ?? '-'})`}
        </p>
      )}
      {(d.lockWaits?.length ?? 0) > 0 && (
        <>
          <h3 className="text-xs font-semibold text-muted-foreground mb-1">lock 대기 — 막는 세션(pid)을 먼저 확인</h3>
          <ul className="text-xs font-mono space-y-1 mb-2">
            {d.lockWaits!.map((w) => (
              <li key={w.pid} className="break-all">
                pid {w.pid} · {fmtAge(w.waitSeconds)} 대기 · 막는 pid {w.blockedBy.join(', ') || '-'} · {w.query}
              </li>
            ))}
          </ul>
        </>
      )}
      {(d.longTransactions?.length ?? 0) > 0 && (
        <>
          <h3 className="text-xs font-semibold text-muted-foreground mb-1">
            오래 열린 트랜잭션 ({fmtAge(data.thresholds.longTransactionSeconds)} 이상)
          </h3>
          <ul className="text-xs font-mono space-y-1">
            {d.longTransactions!.map((t) => (
              <li key={t.pid} className="break-all">
                pid {t.pid} · {t.state ?? '-'} · {fmtAge(t.ageSeconds)} · {t.application || '-'} {t.client ?? ''} · {t.query}
              </li>
            ))}
          </ul>
        </>
      )}
      {d.status === 'ok' && <p className="text-sm text-muted-foreground">lock 대기·오래 열린 트랜잭션 없음.</p>}
    </SectionCard>
  );
}

function RunsCard({ data }: { data: SystemDiagnostics }) {
  const r = data.runs;
  return (
    <SectionCard title="점검 수행" section={r}>
      {r.status !== 'offline' && (
        <p className="text-sm">
          대기 {r.queued ?? 0} · 실행 중 {r.running ?? 0} · 오래 대기 {r.staleQueued ?? 0} · 오래 실행 {r.staleRunning ?? 0}
          <span className="text-muted-foreground">
            {` (기준 대기 ${data.thresholds.staleQueuedMinutes ?? '-'}분 · 실행 ${data.thresholds.staleRunningMinutes ?? '-'}분)`}
          </span>
        </p>
      )}
    </SectionCard>
  );
}

function ErrorsCard({ data }: { data: SystemDiagnostics }) {
  const e = data.errors;
  return (
    <SectionCard title="최근 서버 오류" section={e}>
      {e.status !== 'offline' && (
        <>
          <p className="text-sm mb-2">
            최근 1시간 {e.last1h ?? 0}건 · 24시간 {e.last24h ?? 0}건
            {' · '}<Link to="/settings?tab=server-errors" className="underline hover:no-underline">서버 오류 탭에서 전체 보기</Link>
          </p>
          {(e.topPaths?.length ?? 0) > 0 && (
            <p className="text-xs text-muted-foreground mb-2 break-all">
              많이 난 경로(24시간): {e.topPaths!.map((p) => `${p.path ?? '-'} ${p.count}건`).join(' · ')}
            </p>
          )}
          {(e.latest?.length ?? 0) > 0 ? (
            <ul className="text-xs font-mono space-y-0.5">
              {e.latest!.map((x, i) => (
                <li key={`${x.requestId ?? i}`} className="break-all">
                  {fmtTime(x.createdAt)} · {x.statusCode} {x.method} {x.path} {x.errorType ? `· ${x.errorType}` : ''}
                  {x.requestId && <> · <Link to={serverErrorsPath(x.requestId)} className="underline hover:no-underline">req {x.requestId}</Link></>}
                </li>
              ))}
            </ul>
          ) : <EmptyState compact title="최근 서버 오류가 없습니다" />}
        </>
      )}
    </SectionCard>
  );
}
