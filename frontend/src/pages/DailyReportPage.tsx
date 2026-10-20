// 일일 리포트 — 로그인 없이 여는 공개 화면(App.tsx 가 AuthGate 바깥에서 렌더).
// 클러스터·날짜·랭킹 기준을 URL 쿼리(c, d, r)에 담아 링크로 공유할 수 있다.
// 데이터는 비인증 공개 API(`/public/daily-report/*`) — 지난 날짜는 일 롤업, 오늘은 실시간 집계.
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, FileBarChart, RefreshCw, Search, Settings2, X } from 'lucide-react';
import { EmptyState, ErrorState, LoadingState, PageHeader, PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import {
  DailyReportSettingsDialog, DailyReportTable, RANK_OPTIONS, cores, dateLabel, gi, pct, shiftDate,
} from '@/components/daily-report';
import { PublicPageLinks } from '@/components/public-pages';
import { useDailyReport, useDailyReportClusters, useDailyReportSearch } from '@/hooks/useDailyReport';
import { useAuthStore } from '@/stores/authStore';
import { cn } from '@/lib/utils';
import type { DailyReportRankBy } from '@/types';

const BTN = 'text-sm inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed';
const ICON_BTN = 'inline-flex items-center justify-center w-8 h-8 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed';
const CHIP = 'text-sm px-3 py-1 rounded-xl border transition-colors';
const CHIP_ON = 'border-primary bg-primary text-primary-foreground';
const CHIP_OFF = 'border-border bg-card text-foreground hover:bg-secondary';

const SOURCE_TEXT: Record<string, string> = {
  live: '오늘 — 실시간 집계(진행 중, 5분마다 갱신)',
  rollup: '일 단위 롤업',
  backfill: '일 단위 롤업(방금 계산)',
  none: '수집 데이터 없음',
};

function isRankBy(v: string | null): v is DailyReportRankBy {
  return !!v && RANK_OPTIONS.some((o) => o.value === v);
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground tabular-nums">
        {value}{sub && <span className="ml-1 text-muted-foreground">{sub}</span>}
      </dd>
    </div>
  );
}

export function DailyReportPage() {
  const [params, setParams] = useSearchParams();
  const isAdmin = useAuthStore((s) => !!s.token && s.user?.role === 'admin');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const meta = useDailyReportClusters();
  const clusters = useMemo(() => meta.data?.clusters ?? [], [meta.data]);
  const today = meta.data?.today ?? '';
  const minDate = meta.data?.minDate ?? '';

  const clusterId = params.get('c') && clusters.some((c) => c.id === params.get('c'))
    ? (params.get('c') as string) : (clusters[0]?.id ?? '');
  const rawDate = params.get('d') ?? '';
  const date = rawDate && today && rawDate <= today && rawDate >= minDate ? rawDate : today;
  const rankBy: DailyReportRankBy = isRankBy(params.get('r')) ? (params.get('r') as DailyReportRankBy) : 'cpu_rate';

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  // 첫 진입 시 기본 선택을 URL 에 박아 둔다 — 그대로 복사해 공유할 수 있게.
  useEffect(() => {
    if (!clusterId || !date) return;
    if (params.get('c') !== clusterId || params.get('d') !== date) {
      const next = new URLSearchParams(params);
      next.set('c', clusterId);
      next.set('d', date);
      setParams(next, { replace: true });
    }
  }, [clusterId, date, params, setParams]);

  // 본인 업무 모듈 찾기 — 입력은 즉시 반영하고 URL(`q`)·검색 요청은 300ms 뒤에(타이핑마다 요청하지 않게).
  const q = params.get('q') ?? '';
  const [qInput, setQInput] = useState(q);
  useEffect(() => { setQInput(q); }, [q]);
  useEffect(() => {
    if (qInput === q) return undefined;
    const t = setTimeout(() => update({ q: qInput.trim() }), 300);
    return () => clearTimeout(t);
    // update 는 매 렌더 새로 만들어지지만 params 기반이라 qInput 변화에만 반응하면 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);
  const searching = q.trim().length >= 2;
  const search = useDailyReportSearch(clusterId, date, q, rankBy);

  const report = useDailyReport(clusterId, date, rankBy, date === today);
  const data = report.data;
  const rankHelp = RANK_OPTIONS.find((o) => o.value === rankBy)?.help ?? '';

  const canPrev = !!date && date > minDate;
  const canNext = !!date && date < today;

  const header = (
    <PageHeader
      icon={FileBarChart}
      title="일일 자원 리포트"
      description={
        meta.data
          ? `K8S 자원 관리 — 네임스페이스별 request·limit·사용량 일 단위 리포트 · 최근 ${meta.data.retentionDays}일 조회 가능 · ${meta.data.timezone} 자정 기준`
          : 'K8S 자원 관리 — 네임스페이스별 request·limit·사용량 일 단위 리포트'
      }
      actions={(
        <div className="flex items-center gap-2">
          {isAdmin && (
            <button type="button" className={BTN} onClick={() => setSettingsOpen(true)}>
              <Settings2 className="w-4 h-4" /> 설정
            </button>
          )}
          <PublicPageLinks />
        </div>
      )}
    />
  );

  if (meta.isLoading) {
    return <div className="min-h-screen bg-background"><PageShell density="hub" className="mx-auto">{header}<LoadingState /></PageShell></div>;
  }
  if (meta.isError) {
    const status = (meta.error as { response?: { status?: number } })?.response?.status;
    return (
      <div className="min-h-screen bg-background">
        <PageShell density="hub" className="mx-auto space-y-4">
          {header}
          {status === 404
            ? <EmptyState title="일일 리포트가 공개되어 있지 않습니다" description="관리자가 일일 리포트 설정에서 공개 페이지를 끈 상태입니다." />
            : <ErrorState error={meta.error} onRetry={() => void meta.refetch()} />}
        </PageShell>
        {isAdmin && <DailyReportSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <PageShell density="hub" className="mx-auto space-y-4">
        {header}

        {clusters.length === 0 ? (
          <EmptyState title="공개된 클러스터가 없습니다"
            description="테넌트에 묶이지 않은 클러스터가 없거나, 설정의 공개 클러스터 목록이 비어 있습니다." />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="클러스터 선택">
                {clusters.map((c) => (
                  <button key={c.id} type="button" aria-pressed={c.id === clusterId}
                    className={cn(CHIP, c.id === clusterId ? CHIP_ON : CHIP_OFF)}
                    onClick={() => update({ c: c.id })}>
                    {c.name}
                  </button>
                ))}
              </div>
              <label className="relative flex items-center">
                <Search className="absolute left-2.5 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input type="search" value={qInput} onChange={(e) => setQInput(e.target.value)}
                  placeholder="내 네임스페이스·워크로드·파드 검색" aria-label="네임스페이스·워크로드·파드 검색"
                  className="w-72 max-w-full text-sm pl-8 pr-8 py-1.5 rounded-xl border border-border bg-card text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                {qInput && (
                  <button type="button" className="absolute right-2 text-muted-foreground hover:text-foreground"
                    onClick={() => setQInput('')} title="검색어 지우기" aria-label="검색어 지우기">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </label>
              <div className="flex items-center gap-1.5 ml-auto" role="group" aria-label="날짜 이동">
                <button type="button" className={ICON_BTN} disabled={!canPrev}
                  onClick={() => update({ d: shiftDate(date, -1) })} title="전날" aria-label="전날">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <label className="inline-flex items-center gap-1.5 px-2 py-1 rounded-xl border border-border bg-card text-sm">
                  <CalendarDays className="w-4 h-4 text-muted-foreground" />
                  <input type="date" className="bg-transparent text-foreground focus:outline-none" value={date}
                    min={minDate} max={today} aria-label="리포트 날짜"
                    onChange={(e) => { if (e.target.value) update({ d: e.target.value }); }} />
                </label>
                <button type="button" className={ICON_BTN} disabled={!canNext}
                  onClick={() => update({ d: shiftDate(date, 1) })} title="다음날" aria-label="다음날">
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button type="button" className={BTN} disabled={date === today} onClick={() => update({ d: today })}>오늘</button>
                <button type="button" className={ICON_BTN} onClick={() => void report.refetch()}
                  title="다시 불러오기" aria-label="다시 불러오기" disabled={report.isFetching}>
                  <RefreshCw className={cn('w-4 h-4', report.isFetching && 'animate-spin')} />
                </button>
              </div>
            </div>

            {report.isError ? (
              <ErrorState error={report.error} onRetry={() => void report.refetch()} />
            ) : !data ? (
              <LoadingState />
            ) : (
              <>
                <MacCard title={`${data.cluster.name} · ${dateLabel(data.date)}`}
                  description={SOURCE_TEXT[data.source] ?? data.source}>
                  {data.summary.namespaces === 0 ? (
                    <EmptyState compact title="이 날짜의 수집 샘플이 없습니다"
                      description="K8S 자원 관리 → 효율화 탭의 수집 스케줄이 꺼져 있었거나, 원본 샘플 보관 기간이 지났습니다." />
                  ) : (
                    <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-x-6 gap-y-3">
                      <Stat label="네임스페이스" value={String(data.summary.namespaces)} />
                      <Stat label="파드(평균)" value={String(data.summary.pods)} />
                      <Stat label="CPU Request" value={cores(data.summary.cpu.req)} />
                      <Stat label="CPU Limit" value={cores(data.summary.cpu.lim)} />
                      <Stat label="CPU 평균 사용" value={cores(data.summary.cpu.useAvg)} sub={pct(data.summary.cpu.rateAvg)} />
                      <Stat label="메모리 Request" value={gi(data.summary.mem.req)} />
                      <Stat label="메모리 Limit" value={gi(data.summary.mem.lim)} />
                      <Stat label="메모리 평균 사용" value={gi(data.summary.mem.useAvg)} sub={pct(data.summary.mem.rateAvg)} />
                    </dl>
                  )}
                </MacCard>

                {searching && (
                  <MacCard
                    title={`검색 결과 — "${q.trim()}"`}
                    description={search.data
                      ? `${search.data.total}개 네임스페이스 · 순위는 현재 랭킹 기준(${RANK_OPTIONS.find((o) => o.value === rankBy)?.label ?? ''}) · 파드 검색은 워크로드 샘플이 남아 있는 최근 날짜만`
                      : '검색 중…'}
                    bodyPadding="p-0"
                  >
                    {search.isError ? (
                      <ErrorState compact error={search.error} onRetry={() => void search.refetch()} />
                    ) : !search.data ? (
                      <LoadingState compact />
                    ) : search.data.items.length === 0 ? (
                      <EmptyState compact icon={Search} title="일치하는 네임스페이스가 없습니다"
                        description="네임스페이스·워크로드·파드 이름의 일부(2자 이상)로 찾는다. 다른 날짜나 클러스터에서 다시 찾아본다." />
                    ) : (
                      <DailyReportTable items={search.data.items} rankBy={rankBy} />
                    )}
                  </MacCard>
                )}

                <MacCard
                  title={`네임스페이스 비효율 TOP ${data.topN}`}
                  description={`${rankHelp} · 대상 ${data.rankedTotal}개`}
                  actions={(
                    <div className="flex flex-wrap gap-1" role="group" aria-label="랭킹 기준">
                      {RANK_OPTIONS.map((o) => (
                        <button key={o.value} type="button" title={o.help} aria-pressed={o.value === rankBy}
                          className={cn(CHIP, 'text-xs px-2.5', o.value === rankBy ? CHIP_ON : CHIP_OFF)}
                          onClick={() => update({ r: o.value })}>
                          {o.label}
                        </button>
                      ))}
                    </div>
                  )}
                  bodyPadding="p-0"
                >
                  {data.items.length === 0 ? (
                    <EmptyState compact title="랭킹 대상 네임스페이스가 없습니다"
                      description="사용량이 수집되지 않았거나 모든 NS 가 최소 request 기준 미만입니다." />
                  ) : (
                    <DailyReportTable items={data.items} rankBy={rankBy} />
                  )}
                </MacCard>

                <p className="text-xs text-muted-foreground leading-relaxed">
                  request·limit 은 당일 샘플 평균, 사용량은 평균/최소/최대, 사용률은 샘플별 사용량 ÷ request 의 평균과 범위다.
                  사용률 30% 미만은 강조 표시한다. 랭킹 제외 — CPU request {cores(data.thresholds.minCpuReqM)} 미만 ·
                  메모리 request {gi(data.thresholds.minMemReqB)} 미만{data.thresholds.excludeSystemNamespaces ? ' · 시스템 네임스페이스' : ''}
                  {data.noUsageNamespaces > 0 ? ` · 사용량 미수집 ${data.noUsageNamespaces}개` : ''}. GPU 는 수집 경로 추가 예정.
                  {data.computedAt ? ` 롤업 계산 ${new Date(`${data.computedAt}Z`).toLocaleString()}.` : ''}
                </p>
              </>
            )}
          </>
        )}
      </PageShell>
      {isAdmin && <DailyReportSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
