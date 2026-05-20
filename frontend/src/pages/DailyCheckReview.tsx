import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Play, Settings } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import {
  AiSummaryCard,
  TrendChart,
  DiffPanel,
  DeepCheckGrid,
  NotificationSettingsPanel,
} from '@/components/daily-check';
import { useClusters } from '@/hooks/useCluster';
import {
  useDeepCheckReview,
  useDailyCheckTrend,
  useRunDeepCheckNow,
} from '@/hooks/useDeepCheck';
import api from '@/services/api';

interface DailyCheckLogLite {
  id: string;
  clusterId: string;
  checkedAt: string;
  overallStatus: string;
  scheduleType: string;
}

export function DailyCheckReviewPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [latestLogId, setLatestLogId] = useState<string | null>(null);
  const { data: clusters = [] } = useClusters();

  // /daily-check/review (clusterId 미지정) 진입 시 첫 번째 클러스터로 자동 라우팅.
  // 메뉴에서 들어오는 사용자가 비어 있는 화면을 보지 않도록.
  useEffect(() => {
    if (!clusterId && clusters.length > 0) {
      navigate(`/daily-check/review/${clusters[0].id}`, { replace: true });
    }
  }, [clusterId, clusters, navigate]);

  const dailyCheckLogId = params.get('log') || latestLogId || '';

  // 최신 daily_check_log_id 자동 조회 — log 쿼리 미지정 시
  // (간단히 axios 호출, 별도 hook 만들 정도는 아님)
  useMemo(() => {
    if (params.get('log') || latestLogId) return;
    if (!clusterId) return;
    api
      .get<DailyCheckLogLite>(`/daily-check/results/${clusterId}/latest`)
      .then((res) => {
        if (res.data?.id) setLatestLogId(res.data.id);
      })
      .catch(() => {
        // 점검 기록 없음 — 아무것도 안 함
      });
  }, [clusterId, params, latestLogId]);

  const { data: review, isLoading: reviewLoading } = useDeepCheckReview(dailyCheckLogId);
  const { data: trend } = useDailyCheckTrend(clusterId, 7);
  const runNow = useRunDeepCheckNow();

  const cluster = clusters.find((c) => c.id === clusterId);

  return (
    <div className="min-h-screen bg-background p-5">
      <div className="flex gap-4 max-w-[1600px] mx-auto">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => {
              if (id) {
                window.location.href = `/daily-check/review/${id}`;
              }
            }}
            iconOnly
          />
        </div>
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              대시보드
            </Link>
            <h1 className="text-lg font-semibold flex-1">
              {cluster ? `${cluster.name} — 일일 점검 리뷰` : '일일 점검 리뷰'}
            </h1>
            <button
              type="button"
              onClick={() => {
                if (!clusterId) return;
                runNow.mutate(clusterId);
              }}
              disabled={!clusterId || runNow.isPending}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {runNow.isPending ? '실행 중…' : 'Deep Check 지금 실행'}
            </button>
            <Link
              to="/daily-check/settings"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted"
            >
              <Settings className="w-3.5 h-3.5" />
              체크 정의
            </Link>
          </div>

          <DailyCheckLogPicker
            clusterId={clusterId}
            value={dailyCheckLogId}
            onChange={(id) => {
              setLatestLogId(id);
              setParams({ log: id });
            }}
          />

          {!dailyCheckLogId && (
            <MacCard title="안내">
              <div className="text-sm text-muted-foreground italic">
                해당 클러스터의 점검 기록이 없습니다. 대시보드의 "체크 실행" 버튼으로 점검을 먼저 수행하세요.
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

function DailyCheckLogPicker({
  clusterId,
  value,
  onChange,
}: {
  clusterId: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [logs, setLogs] = useState<DailyCheckLogLite[] | null>(null);

  useMemo(() => {
    if (!clusterId) return;
    api
      .get<DailyCheckLogLite[]>(`/daily-check/results/${clusterId}`, {
        params: { limit: 20 },
      })
      .then((res) => setLogs(res.data || []))
      .catch(() => setLogs([]));
  }, [clusterId]);

  if (!logs || logs.length === 0) return null;

  return (
    <MacCard title="점검 회차 선택">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm"
      >
        {logs.map((l) => (
          <option key={l.id} value={l.id}>
            {new Date(l.checkedAt).toLocaleString('ko-KR')} · {l.scheduleType} ·{' '}
            {l.overallStatus}
          </option>
        ))}
      </select>
    </MacCard>
  );
}
