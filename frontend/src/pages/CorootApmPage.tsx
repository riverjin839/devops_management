import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ExternalLink,
  Gauge,
  Monitor,
  RefreshCw,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { ClusterSidebar } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useCorootSummary, useCorootDeepLink, useCorootHealth } from '@/hooks/useCoroot';

/**
 * Coroot APM — 별도 배포된 coroot 의 애플리케이션 옵저버빌리티를 PEP 에서 연동.
 *
 * - 좌측 ClusterSidebar(iconOnly) 로 클러스터 선택.
 * - 선택 클러스터에 매핑된 coroot project 의 application 요약 카드.
 * - "Open in Coroot" 딥링크(새 탭) + (보조) iframe 임베드.
 * coroot 미배포/미연동 시 offline 안내로 우아하게 빠진다 (500 없음).
 */
export function CorootApmPage() {
  useClusters();
  const { clusters } = useClusterStore();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [showEmbed, setShowEmbed] = useState(false);

  useEffect(() => {
    if (!selectedClusterId && clusters.length > 0) setSelectedClusterId(clusters[0].id);
  }, [clusters, selectedClusterId]);

  const cid = selectedClusterId ?? '';
  const health = useCorootHealth();
  const summary = useCorootSummary(cid || null);
  const deeplink = useCorootDeepLink(cid || null);

  const globalOffline = health.data?.status === 'offline';
  const deepUrl = deeplink.data?.url ?? null;

  return (
    <div className="min-h-screen bg-background flex">
      <ClusterSidebar
        clusters={clusters}
        selectedId={selectedClusterId}
        onSelect={setSelectedClusterId}
        allowAll={false}
        iconOnly
      />
      <main className="flex-1 min-w-0 px-4 lg:px-6 py-5 space-y-4 max-w-[1700px]">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Gauge className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold leading-tight">애플리케이션 APM (Coroot)</h1>
              <p className="text-sm text-muted-foreground">
                서비스 지연·에러율·SLO — 별도 배포된 coroot 연동
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg border ${
                globalOffline
                  ? 'border-border bg-secondary text-muted-foreground'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              }`}
            >
              <span className={globalOffline ? 'text-muted-foreground' : 'text-emerald-500'}>●</span>
              coroot {globalOffline ? 'offline' : 'online'}
            </span>
            <button
              onClick={() => { summary.refetch(); deeplink.refetch(); health.refetch(); }}
              disabled={!cid}
              className="px-3 py-1.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${summary.isFetching ? 'animate-spin' : ''}`} />
              새로고침
            </button>
          </div>
        </div>

        {!cid ? (
          <MacCard bodyPadding="p-10">
            <div className="text-center text-sm text-muted-foreground">왼쪽에서 클러스터를 선택하세요.</div>
          </MacCard>
        ) : (
          <>
            <SummaryStrip
              loading={summary.isLoading}
              status={summary.data?.status}
              serviceCount={summary.data?.serviceCount ?? null}
              healthy={summary.data?.healthy ?? null}
              alerting={summary.data?.alerting ?? null}
              error={summary.data?.error ?? null}
            />

            {/* Deep-link + embed toggle */}
            <MacCard bodyPadding="p-3">
              <div className="flex items-center gap-2 flex-wrap">
                {deepUrl ? (
                  <a
                    href={deepUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1.5 mac-shadow"
                  >
                    <Activity className="w-3.5 h-3.5" />
                    Open in Coroot
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                ) : (
                  <span className="text-sm text-muted-foreground inline-flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                    이 클러스터에 coroot 연동/매핑이 설정되지 않았습니다. (클러스터 관리에서 project 매핑)
                  </span>
                )}
                {deepUrl && (
                  <button
                    onClick={() => setShowEmbed((v) => !v)}
                    className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1.5"
                  >
                    <Monitor className="w-3.5 h-3.5" />
                    {showEmbed ? '임베드 닫기' : '여기에 임베드'}
                  </button>
                )}
              </div>
            </MacCard>

            {/* Optional embed (best-effort — coroot 의 CSP/X-Frame-Options 가 막으면 빈 화면일 수 있음) */}
            {showEmbed && deepUrl && (
              <MacCard title="Coroot (embedded)" bodyPadding="p-0" className="overflow-hidden">
                <div className="px-4 py-2 border-b border-border bg-amber-500/5 text-xs text-muted-foreground flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                  화면이 비어 있으면 coroot 가 iframe 임베드를 차단한 것입니다. 위의 “Open in Coroot” 로 새 탭에서 여세요.
                </div>
                <iframe
                  src={deepUrl}
                  title="Coroot"
                  className="w-full border-0"
                  style={{ height: '70vh' }}
                  sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
                  referrerPolicy="no-referrer"
                />
              </MacCard>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ── Summary strip ─────────────────────────────────────────────────────────────

interface SummaryStripProps {
  loading: boolean;
  status?: 'ok' | 'error' | 'offline';
  serviceCount: number | null;
  healthy: number | null;
  alerting: number | null;
  error: string | null;
}

function SummaryStrip({ loading, status, serviceCount, healthy, alerting, error }: SummaryStripProps) {
  if (loading) {
    return <div className="h-20 rounded-2xl bg-secondary/40 animate-pulse" />;
  }
  if (status && status !== 'ok') {
    return (
      <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold">
            {status === 'offline' ? 'Coroot 연동이 활성화되지 않았거나 도달할 수 없습니다.' : 'Coroot 요약을 불러오지 못했습니다.'}
          </p>
          {error && <p className="text-sm text-muted-foreground">{error}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <SummaryCell
        icon={<Boxes className="w-4 h-4" />}
        label="서비스 수"
        value={serviceCount ?? '—'}
        accent="text-primary"
      />
      <SummaryCell
        icon={<CheckCircle2 className="w-4 h-4" />}
        label="정상"
        value={healthy ?? '—'}
        accent="text-emerald-500"
      />
      <SummaryCell
        icon={<AlertTriangle className="w-4 h-4" />}
        label="알림/주의"
        value={alerting ?? '—'}
        accent={(alerting ?? 0) > 0 ? 'text-red-500' : 'text-muted-foreground'}
      />
    </div>
  );
}

interface SummaryCellProps { icon: React.ReactNode; label: string; value: string | number; accent?: string }
function SummaryCell({ icon, label, value, accent = 'text-foreground' }: SummaryCellProps) {
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-xl bg-secondary flex items-center justify-center ${accent}`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-base font-bold leading-tight ${accent}`}>{value}</p>
      </div>
    </div>
  );
}
