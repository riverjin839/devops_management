import { useEffect } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Play, Settings, RefreshCw } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
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

  const { data: review, isLoading: reviewLoading } = useDeepCheckReview(dailyCheckLogId);
  const { data: trend } = useDailyCheckTrend(clusterId, 7);
  const runDeep = useRunDeepCheckNow();
  const runDaily = useRunDailyCheckNow();

  const cluster = clusters.find((c) => c.id === clusterId);

  return (
    <div className="min-h-screen bg-background py-3 pr-3">
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
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              대시보드
            </Link>
            <h1 className="text-lg font-semibold flex-1 min-w-[200px]">
              {cluster ? `${cluster.name} — 일일 점검 리뷰` : '일일 점검 리뷰'}
            </h1>
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
              {runDaily.isPending ? '실행 중…' : 'Daily Check 실행'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!clusterId) return;
                runDeep.mutate(clusterId);
              }}
              disabled={!clusterId || runDeep.isPending}
              title="등록된 Deep Check 정의 (cert/PVC/CNI 등) 실행 — 최신 daily 회차에 결과를 묶습니다"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {runDeep.isPending ? '실행 중…' : 'Deep Check 실행'}
            </button>
            <Link
              to="/daily-check/settings"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
            >
              <Settings className="w-3.5 h-3.5" />
              체크 정의
            </Link>
          </div>

          <DailyCheckLogPicker
            clusterId={clusterId}
            value={dailyCheckLogId}
            onChange={(id) => setParams({ log: id })}
          />

          {clusterId && <ResourceTrendChecklist clusterId={clusterId} />}

          {!dailyCheckLogId && (
            <MacCard title="안내">
              <div className="text-sm text-muted-foreground italic">
                해당 클러스터의 점검 기록이 없습니다. 상단의 <strong>"Daily Check 실행"</strong> 버튼을 눌러 새 회차를 생성하세요.
                (Dashboard 의 "체크 실행" 은 별개 파이프라인이라 여기에 결과가 나타나지 않습니다.)
              </div>
            </MacCard>
          )}

          {dailyCheckLogId && (
            <>
              {reviewLoading && (
                <MacCard title="AI 자동 리뷰">
                  <div className="text-sm text-muted-foreground italic">불러오는 중…</div>
                </MacCard>
              )}
              {review && <AiSummaryCard review={review} />}
              {review && <DeepCheckGrid results={review.deepResults} />}
              {review && <DiffPanel diff={review.aiDiff} />}
              <TrendChart trend={trend} />
              <NotificationSettingsPanel />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// status 별 visual marker — native <option> 은 children 스타일링이 불가하므로 텍스트 접두사로 표현.
// 진짜 컬러 badge 가 필요해지면 components/ui/Select 를 Radix dropdown-menu 기반으로 추가하는
// 별도 design system 작업이 필요.
const STATUS_MARKER: Record<string, string> = {
  healthy: '🟢',
  warning: '🟡',
  critical: '🔴',
  pending: '⚪',
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
            const marker = STATUS_MARKER[l.overallStatus] ?? '⚪';
            const scheduleKr = SCHEDULE_LABEL[l.scheduleType] ?? l.scheduleType;
            const dt = parseUTC(l.checkedAt).toLocaleString('ko-KR');
            return (
              <option key={l.id} value={l.id}>
                {marker} {dt} · {scheduleKr} · {l.overallStatus}
              </option>
            );
          })}
        </select>
        {selected && (
          <span
            className={`text-xs font-medium px-2 py-1 rounded-full ${
              selected.overallStatus === 'critical'
                ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                : selected.overallStatus === 'warning'
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-500'
                  : selected.overallStatus === 'healthy'
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'bg-slate-500/10 text-slate-500'
            }`}
          >
            {selected.overallStatus}
          </span>
        )}
      </div>
    </MacCard>
  );
}
