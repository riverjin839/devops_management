import { useEffect } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { AxiosError } from 'axios';
import { Play, Settings, RefreshCw } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { Skeleton, StatusBadge } from '@/components/common';
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
import { parseUTC } from '@/lib/utils';

function errMsg(e: unknown): string {
  const ax = e as AxiosError<{ detail?: string }>;
  return ax?.response?.data?.detail || (e as Error)?.message || '알 수 없는 오류';
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

  const cluster = clusters.find((c) => c.id === clusterId);

  return (
    <div className="app-min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
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
              onClick={() => {
                if (!clusterId) return;
                runDaily.mutate(clusterId);
              }}
              disabled={!clusterId || runDaily.isPending}
              title="기본 헬스 체크 (API/Components/Nodes/Pods) — 새 점검 회차를 생성합니다"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${runDaily.isPending ? 'animate-spin' : ''}`} />
              {runDaily.isPending ? '실행 중…' : '기본 점검 실행'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!clusterId) return;
                runDeep.mutate(clusterId);
              }}
              disabled={!clusterId || runDeep.isPending}
              title="등록된 심층 점검 정의 (cert/PVC/CNI 등) 실행 — 최신 회차에 결과를 묶습니다"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {runDeep.isPending ? '실행 중…' : '심층 점검 실행'}
            </button>
            <Link
              to="/daily-check/settings"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
            >
              <Settings className="w-3.5 h-3.5" />
              점검 정의
            </Link>
          </div>

          <DailyCheckLogPicker
            clusterId={clusterId}
            value={dailyCheckLogId}
            onChange={(id) => setParams({ log: id })}
          />

          {clusterId && <ResourceTrendChecklist clusterId={clusterId} />}

          {!dailyCheckLogId && (
            <MacCard title="점검 기록 없음">
              <div className="text-sm text-muted-foreground">
                해당 클러스터의 점검 기록이 없습니다. 상단의 <strong>「기본 점검 실행」</strong>으로 새 회차를 만들고,
                <strong>「심층 점검 실행」</strong>으로 등록된 심층 점검 결과를 그 회차에 묶으세요.
                (클러스터 현황의 「점검 실행」은 별개 파이프라인이라 여기에 결과가 나타나지 않습니다.)
              </div>
            </MacCard>
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
      </div>
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
