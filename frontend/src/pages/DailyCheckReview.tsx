import { useEffect, useRef } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AxiosError } from 'axios';
import { Play, Settings, RefreshCw, ClipboardList } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { EmptyState, PageShell, RunLogPanel, Skeleton, StatusBadge } from '@/components/common';
import type { StatusVariant } from '@/components/common';
import {
  AiSummaryCard,
  TrendChart,
  DiffPanel,
  DeepCheckGrid,
  NotificationSettingsPanel,
  ResourceTrendChecklist,
} from '@/components/daily-check';
import { useClusters } from '@/hooks/useCluster';
import {
  useDeepCheckReview,
  useDailyCheckTrend,
  useRunDeepCheckNow,
} from '@/hooks/useDeepCheck';
import {
  useLatestDailyCheckLog,
  useDailyCheckLogs,
  useRunDailyCheckNow,
} from '@/hooks/useDailyCheck';
import { useDeepCheckDefinitions } from '@/hooks/useDeepCheckDefinitions';
import { useRunLog, runLogged, pollIntoRunLog, type RunLogEntry, type RunLogLevel } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { deepCheckApi, type DailyCheckLogLite } from '@/services/api';
import type { DeepCheckResult } from '@/types';
import { parseUTC } from '@/lib/utils';

function errMsg(e: unknown): string {
  const ax = e as AxiosError<{ detail?: string }>;
  return ax?.response?.data?.detail || (e as Error)?.message || '알 수 없는 오류';
}

// POST /daily-check/run/{id} 의 실제 응답(DailyCheckResponse) — api.ts 는 회차 picker 용 Lite 타입만 선언해
// 실행 로그에 필요한 상세 필드를 여기서 보강한다(응답 키는 axios 인터셉터가 camelCase 로 변환).
interface DailyCheckRunDetail extends DailyCheckLogLite {
  apiServerStatus?: string;
  apiServerResponseTimeMs?: number | null;
  apiServerDetails?: { error?: string } | null;
  componentsStatus?: Record<string, { status?: string; message?: string } | string> | null;
  totalNodes?: number;
  readyNodes?: number;
  nodesStatus?: { name?: string; status?: string }[] | null;
  systemPodsStatus?: { name?: string; status?: string; restarts?: number; error?: string }[] | null;
  errorMessages?: string[] | null;
  warningMessages?: string[] | null;
  checkDurationSeconds?: number | null;
}

const RUN_STATUS_KO: Record<string, string> = { healthy: '정상', warning: '경고', critical: '위험', pending: '대기' };
const statusKo = (s?: string | null) => (s ? RUN_STATUS_KO[s] ?? s : '—');
const statusLevel = (s?: string | null): RunLogLevel =>
  s === 'critical' ? 'error' : s === 'warning' || s === 'pending' ? 'warn' : 'info';

/** 기본 점검 응답 → 실행 로그 줄(API 서버 · 컴포넌트 · 노드 · kube-system 파드 · 경고/에러 · 종합). */
function summarizeDailyRun(res: DailyCheckRunDetail): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  const apiErr = res.apiServerDetails?.error;
  out.push([
    statusLevel(res.apiServerStatus),
    `API 서버 · ${statusKo(res.apiServerStatus)}${res.apiServerResponseTimeMs != null ? ` · 응답 ${res.apiServerResponseTimeMs}ms` : ''}${apiErr ? ` — ${apiErr}` : ''}`,
  ]);
  for (const [name, v] of Object.entries(res.componentsStatus ?? {})) {
    if (typeof v === 'string') out.push(['error', `컴포넌트 점검 실패 — ${v}`]);
    else out.push([statusLevel(v.status), `컴포넌트 ${name} · ${statusKo(v.status)}${v.message ? ` · ${v.message}` : ''}`]);
  }
  const total = res.totalNodes ?? 0;
  const ready = res.readyNodes ?? 0;
  out.push([ready < total ? 'warn' : 'info', `노드 Ready ${ready}/${total}`]);
  const notReady = (res.nodesStatus ?? []).filter((n) => n.status && n.status !== 'Ready').map((n) => n.name ?? '?');
  if (notReady.length > 0) out.push(['warn', `NotReady 노드 ${notReady.length}대 — ${notReady.join(', ')}`]);
  const pods = res.systemPodsStatus ?? [];
  let podIssues = 0;
  for (const p of pods) {
    if (p.error) { out.push(['error', `kube-system 파드 조회 실패 — ${p.error}`]); podIssues += 1; continue; }
    const badPhase = p.status && p.status !== 'Running' && p.status !== 'Succeeded';
    const manyRestarts = (p.restarts ?? 0) > 10;
    if (badPhase || manyRestarts) {
      podIssues += 1;
      out.push(['warn', `kube-system 파드 이상 · ${p.name ?? '?'} · ${p.status ?? '—'} · 재시작 ${p.restarts ?? 0}회`]);
    }
  }
  if (podIssues === 0) out.push(['info', `kube-system 파드 ${pods.length}개 · 이상 없음`]);
  for (const w of res.warningMessages ?? []) out.push(['warn', `경고 — ${w}`]);
  for (const e of res.errorMessages ?? []) out.push(['error', `에러 — ${e}`]);
  out.push([
    statusLevel(res.overallStatus),
    `종합 상태 ${statusKo(res.overallStatus)}${res.checkDurationSeconds != null ? ` · 소요 ${res.checkDurationSeconds}초` : ''}`,
  ]);
  return out;
}

export function DailyCheckReviewPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data: clusters = [] } = useClusters();

  // /daily-check/review (clusterId 미지정) 진입 시 첫 번째 클러스터로 자동 라우팅.
  // 메뉴에서 들어오는 사용자가 비어 있는 화면을 보지 않도록.
  useEffect(() => {
    if (!clusterId && clusters.length > 0) {
      navigate(`/daily-check/review/${clusters[0].id}`, { replace: true });
    }
  }, [clusterId, clusters, navigate]);

  // 최신 daily_check_log_id 자동 조회 — TanStack Query 훅으로 분리해 React 안티패턴 제거
  const { data: latestLog } = useLatestDailyCheckLog(clusterId);
  const dailyCheckLogId = params.get('log') || latestLog?.id || '';

  const {
    data: review,
    isLoading: reviewLoading,
    isError: reviewIsError,
    error: reviewError,
    refetch: refetchReview,
  } = useDeepCheckReview(dailyCheckLogId);
  const {
    data: trend,
    isError: trendIsError,
    error: trendError,
  } = useDailyCheckTrend(clusterId, 7);
  const runDeep = useRunDeepCheckNow();
  const runDaily = useRunDailyCheckNow();
  // 심층 점검 진행 추적의 완료 기준 — 이 클러스터에서 도는 활성 정의(글로벌 + 클러스터) 수.
  const { data: deepDefs } = useDeepCheckDefinitions(clusterId || undefined);

  const cluster = clusters.find((c) => c.id === clusterId);

  // 실행 로그 — 기본/심층 점검은 따로 돌 수 있어 버퍼를 나눈다. "로그 보기" 선택은 화면 단위로 공유.
  const dailyLog = useRunLog();
  const deepLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('daily-check-review-run');
  const deepAbort = useRef<AbortController | null>(null);
  useEffect(() => () => deepAbort.current?.abort(), [clusterId]);

  const handleRunDaily = async () => {
    if (!clusterId) return;
    const name = cluster?.name ?? clusterId.slice(0, 8);
    await runLogged(dailyLog, {
      title: `기본 점검 — ${name}`,
      first: `${name} — API 서버 · 컴포넌트 · 노드 · kube-system 파드 점검 요청`,
      fn: async () => (await runDaily.mutateAsync(clusterId)).data as DailyCheckRunDetail,
      summarize: summarizeDailyRun,
    });
  };

  const handleRunDeep = async () => {
    if (!clusterId) return;
    deepAbort.current?.abort();
    const ctrl = new AbortController();
    deepAbort.current = ctrl;
    const name = cluster?.name ?? clusterId.slice(0, 8);
    const defs = deepDefs?.filter((d) => d.enabled && (!d.clusterId || d.clusterId === clusterId));
    const defName = new Map((defs ?? []).map((d) => [d.id, d.name]));
    // 완료 판정: 정의 목록이 있으면 활성 정의 수만큼 새 결과가 모였을 때. 목록을 못 받았으면
    // 첫 결과 이후 30초간 새 결과가 없을 때(러너가 정의를 순서대로 돌리고 끝에 커밋하므로 그 뒤엔 더 안 온다).
    const expected = defs?.length;
    // 새 결과 판정은 클릭 직전 결과 ID 와의 차집합 — 서버·브라우저 시계 차이에 흔들리지 않게 checkedAt 대신 쓴다.
    // 기준 조회가 실패하면 클릭 시각(5초 여유) 이후 checkedAt 으로 대신한다.
    let baseline: Set<string> | null = null;
    const clickedAt = Date.now();
    const isNew = (r: DeepCheckResult) =>
      baseline ? !baseline.has(r.id) : parseUTC(r.checkedAt).getTime() >= clickedAt - 5000;

    const r = await runLogged(deepLog, {
      title: `심층 점검 — ${name}`,
      first: `${name} — 활성 심층 점검 정의 ${expected ?? '?'}개 실행 요청`,
      fn: async () => {
        try {
          baseline = new Set((await deepCheckApi.listResults(clusterId, { limit: 100 })).data.map((x) => x.id));
        } catch { baseline = null; }
        return (await runDeep.mutateAsync(clusterId)).data;
      },
      summarize: (res) =>
        res.status === 'queued'
          ? [['info', `큐잉됨 · task ${res.taskId || '—'} — 결과가 저장되는 대로 항목별로 표시`]]
          : [['warn', `워커 없음 → 동기 폴백 실행 · 점검 ${res.checksRun ?? 0}개 완료`]],
      keepOpen: true,
    });
    if (!r.ok) return;
    if (r.data.status !== 'queued') {
      r.run.end();
      refetchReview();
      return;
    }
    if (expected === 0) {
      r.run.log('warn', '활성 심층 점검 정의가 없어 실행된 항목이 없음 — 「점검 정의」에서 활성화하세요');
      r.run.end();
      return;
    }

    let seen = 0;
    let lastNewAt = performance.now();
    type Snap = { fresh: DeepCheckResult[]; quietMs: number };
    const done = (s: Snap) =>
      expected != null ? s.fresh.length >= expected : s.fresh.length > 0 && s.quietMs >= 30_000;
    await pollIntoRunLog<Snap>(r.run, {
      fetch: async () => {
        const rows = (await deepCheckApi.listResults(clusterId, { limit: 100 })).data;
        const fresh = rows.filter(isNew).reverse();
        if (fresh.length > seen) { seen = fresh.length; lastNewAt = performance.now(); }
        return { fresh, quietMs: performance.now() - lastNewAt };
      },
      describe: (snap, prev) => {
        const prevIds = new Set((prev?.fresh ?? []).map((x) => x.id));
        const lines: RunLogEntry[] = snap.fresh
          .filter((x) => !prevIds.has(x.id))
          .map((x) => [
            statusLevel(x.status),
            `${(x.definitionId && defName.get(x.definitionId)) || x.checkType} · ${statusKo(x.status)}${x.message ? ` · ${x.message}` : ''} · ${x.durationMs}ms`,
          ]);
        if (done(snap)) {
          const cnt = (st: string) => snap.fresh.filter((x) => x.status === st).length;
          const bad = cnt('critical');
          lines.push([
            bad > 0 ? 'error' : cnt('warning') > 0 ? 'warn' : 'info',
            `요약 · ${snap.fresh.length}개 · 정상 ${cnt('healthy')} · 경고 ${cnt('warning')} · 위험 ${bad}`,
          ]);
        }
        return lines;
      },
      isDone: done,
      intervalMs: 3000,
      timeoutMs: 600_000,
      signal: ctrl.signal,
    });
    refetchReview();
  };

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => {
              if (id) {
                navigate(`/daily-check/review/${id}`);
              }
            }}
            iconOnly
          />
        </div>
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <PageHeader
              back={{ to: '/', label: '홈' }}
              title={cluster ? `${cluster.name} — 일일 점검 리뷰` : '일일 점검 리뷰'}
              className="flex-1 min-w-[200px]"
            />
            <button
              type="button"
              onClick={handleRunDaily}
              disabled={!clusterId || runDaily.isPending}
              title="기본 헬스 체크 (API/Components/Nodes/Pods) — 새 점검 회차를 생성합니다"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${runDaily.isPending ? 'animate-spin' : ''}`} />
              {runDaily.isPending ? '실행 중…' : '기본 점검 실행'}
            </button>
            <button
              type="button"
              onClick={handleRunDeep}
              disabled={!clusterId || runDeep.isPending || deepLog.running}
              title="등록된 심층 점검 정의 (cert/PVC/CNI 등) 실행 — 최신 회차에 결과를 묶습니다"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {runDeep.isPending || deepLog.running ? '실행 중…' : '심층 점검 실행'}
            </button>
            <Link
              to="/daily-check/settings"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
            >
              <Settings className="w-3.5 h-3.5" />
              점검 정의
            </Link>
          </div>

          <RunLogPanel run={dailyLog} show={showLog} onShowChange={setShowLog} />
          <RunLogPanel run={deepLog} show={showLog} onShowChange={setShowLog} />

          <DailyCheckLogPicker
            clusterId={clusterId}
            value={dailyCheckLogId}
            onChange={(id) => setParams({ log: id })}
          />

          {clusterId && <ResourceTrendChecklist clusterId={clusterId} />}

          {!dailyCheckLogId && (
            <EmptyState
              icon={ClipboardList}
              title="점검 기록 없음"
              description="상단의 「기본 점검 실행」으로 새 회차를 만들고 「심층 점검 실행」으로 등록된 심층 점검 결과를 그 회차에 묶으세요. 클러스터 상세의 「점검 실행」은 별개 파이프라인이라 여기에 결과가 나타나지 않습니다."
            />
          )}

          {dailyCheckLogId && (
            <>
              {reviewLoading && (
                <MacCard title="AI 자동 리뷰">
                  <div className="space-y-2" aria-busy="true" aria-label="AI 리뷰 불러오는 중">
                    <Skeleton height={12} width="90%" />
                    <Skeleton height={12} width="75%" />
                    <Skeleton height={12} width="82%" />
                    <Skeleton height={12} width="60%" />
                  </div>
                </MacCard>
              )}
              {!reviewLoading && reviewIsError && (
                <MacCard title="AI 자동 리뷰">
                  <div className="rounded-md border border-status-critical/40 bg-status-critical-soft p-3 text-sm">
                    <p className="font-medium text-status-critical">리뷰를 불러오지 못했습니다</p>
                    <p className="mt-1 text-muted-foreground break-words">{errMsg(reviewError)}</p>
                    <button
                      type="button"
                      onClick={() => refetchReview()}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      재시도
                    </button>
                  </div>
                </MacCard>
              )}
              {review && <AiSummaryCard review={review} />}
              {review && <DeepCheckGrid results={review.deepResults} />}
              {review && <DiffPanel diff={review.aiDiff} />}
              <TrendChart trend={trend} isError={trendIsError} error={trendError} />
              <NotificationSettingsPanel />
            </>
          )}
        </div>
      </PageShell>
    </div>
  );
}

// status 한국어 라벨 — native <option> 은 아이콘을 넣을 수 없어 텍스트로 표현 (이모지 금지, D-126).
const STATUS_LABEL: Record<string, string> = {
  healthy: '정상',
  warning: '경고',
  critical: '위험',
  pending: '대기',
};

// 회차 배지 — 공용 StatusBadge (정상은 무채색, D-119)
const STATUS_VARIANT: Record<string, StatusVariant> = {
  healthy: 'healthy',
  warning: 'warning',
  critical: 'critical',
  pending: 'pending',
};

const SCHEDULE_LABEL: Record<string, string> = {
  morning: '아침',
  noon: '점심',
  evening: '저녁',
  manual: '수동',
};

function DailyCheckLogPicker({
  clusterId,
  value,
  onChange,
}: {
  clusterId: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const { data: logs = [] } = useDailyCheckLogs(clusterId, 20);

  if (logs.length === 0) return null;

  const selected = logs.find((l) => l.id === value);

  return (
    <MacCard title="점검 회차 선택">
      <div className="flex items-center gap-2">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 rounded-xl border border-border bg-card px-3 py-2 text-sm"
        >
          {logs.map((l) => {
            const statusKr = STATUS_LABEL[l.overallStatus] ?? l.overallStatus;
            const scheduleKr = SCHEDULE_LABEL[l.scheduleType] ?? l.scheduleType;
            const dt = parseUTC(l.checkedAt).toLocaleString('ko-KR');
            return (
              <option key={l.id} value={l.id}>
                {statusKr} · {dt} · {scheduleKr}
              </option>
            );
          })}
        </select>
        {selected && (
          <StatusBadge
            variant={STATUS_VARIANT[selected.overallStatus] ?? 'pending'}
            label={STATUS_LABEL[selected.overallStatus] ?? selected.overallStatus}
          />
        )}
      </div>
    </MacCard>
  );
}
