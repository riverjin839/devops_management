import { useMemo, useState } from 'react';
import { BellOff, Check, ExternalLink, RefreshCw, Search, Trash2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { AlertAnalysisPanel } from '@/components/observability/AlertAnalysisPanel';
import { useToast } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import {
  useAckAlert,
  useAckAllAlerts,
  useAlertStats,
  useAlerts,
  useDeleteAlert,
} from '@/hooks/useAlertInbox';
import { useAuthStore, hasRole } from '@/stores/authStore';
import {
  AlertNotifyRulesPanel,
  AlertReceiverGuide,
  LabelTable,
  ROW,
  TD,
  TH,
  TableMessage,
  formatTime,
} from '@/components/observability';
import type { AlertEvent, AlertSeverity } from '@/types';
import { formatApiError } from '@/lib/utils';

type MainTab = 'inbox' | 'rules';

const SEVERITY_TABS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

const STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: 'firing', label: '발생중' },
  { value: 'resolved', label: '해소' },
  { value: 'all', label: '전체' },
];

/**
 * 심각도별 시각 구분 — 좌측 3px 바 + 행 배경 그라데이션 + 글자 굵기.
 * 색은 전부 테마 토큰이라 3개 테마에서 자동 대응한다(DESIGN_SYSTEM §12.4: raw hex 금지).
 * Tailwind JIT 가 정적으로 스캔하므로 클래스는 조립하지 않고 고정 문자열로 둔다.
 */
const SEVERITY_ROW: Record<AlertSeverity, { bar: string; grad: string; text: string; label: string }> = {
  critical: {
    bar: 'bg-[hsl(var(--status-critical))]',
    grad: 'bg-gradient-to-r from-[hsl(var(--status-critical)/0.14)] via-[hsl(var(--status-critical)/0.05)] to-transparent',
    text: 'text-[hsl(var(--status-critical))] font-semibold',
    label: 'Critical',
  },
  warning: {
    bar: 'bg-[hsl(var(--status-warning))]',
    grad: 'bg-gradient-to-r from-[hsl(var(--status-warning)/0.12)] via-[hsl(var(--status-warning)/0.04)] to-transparent',
    text: 'text-[hsl(var(--status-warning))] font-medium',
    label: 'Warning',
  },
  info: {
    bar: 'bg-[hsl(var(--status-info))]',
    grad: 'bg-gradient-to-r from-[hsl(var(--status-info)/0.10)] to-transparent',
    text: 'text-[hsl(var(--status-info))]',
    label: 'Info',
  },
};

const COLS = 10;

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
    active
      ? 'bg-primary text-primary-foreground'
      : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
  }`;

/**
 * 알람 인박스 — Alertmanager / 사내 alert-forwarder 가 PEP 로 보낸 인시던트 알람 목록.
 *
 * 같은 알람이 반복 수신되면 행이 늘지 않고 반복 수(×N)만 올라간다. 개인 알림(종)은
 * 알림 규칙의 중복 억제 창에 따라 1건만 생성된다.
 */
export function AlertInboxPage() {
  const toast = useToast();
  const { data: clusters = [] } = useClusters();
  const user = useAuthStore((s) => s.user);
  const canEdit = hasRole(user, 'admin', 'operator');

  const [tab, setTab] = useState<MainTab>('inbox');
  const [clusterId, setClusterId] = useState<string | null>(null);
  const [severity, setSeverity] = useState('all');
  const [status, setStatus] = useState('firing');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useAlerts({
    clusterId, severity, status, q: query.trim() || undefined, limit: 200,
  });
  const { data: stats } = useAlertStats(clusterId);

  const ackAlert = useAckAlert();
  const ackAll = useAckAllAlerts();
  const removeAlert = useDeleteAlert();

  const alerts: AlertEvent[] = useMemo(() => data?.data ?? [], [data]);

  const handleAck = async (alert: AlertEvent) => {
    try {
      await ackAlert.mutateAsync({ id: alert.id, acked: !alert.acked });
    } catch (err) {
      toast.error(formatApiError(err, '확인 처리 실패'));
    }
  };

  const handleAckAll = async () => {
    try {
      const res = await ackAll.mutateAsync({ clusterId, severity });
      toast.success(`${res.acked}건을 확인 처리했습니다.`);
    } catch (err) {
      toast.error(formatApiError(err, '일괄 확인 실패'));
    }
  };

  const handleDelete = async (alert: AlertEvent) => {
    try {
      await removeAlert.mutateAsync(alert.id);
    } catch (err) {
      toast.error(formatApiError(err, '알람 삭제 실패'));
    }
  };

  return (
    <div className="min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId}
          onSelect={(id) => setClusterId(id ?? null)}
          allowAll
          allLabel="전체 클러스터"
          iconOnly
        />

        <div className="flex-1 min-w-0 space-y-3">
          <AlertReceiverGuide />

          <div className="flex items-center gap-1">
            <button type="button" className={pill(tab === 'inbox')} onClick={() => setTab('inbox')}>
              알람 인박스
            </button>
            <button type="button" className={pill(tab === 'rules')} onClick={() => setTab('rules')}>
              알림 규칙
            </button>
          </div>

          {tab === 'rules' ? (
            <AlertNotifyRulesPanel clusters={clusters} canEdit={canEdit} />
          ) : (
            <MacCard title="수신 알람" bodyPadding="p-0">
              {/* 필터 툴바 */}
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
                <div className="flex flex-wrap items-center gap-1">
                  {SEVERITY_TABS.map((t) => (
                    <button key={t.value} type="button" className={pill(severity === t.value)}
                      onClick={() => setSeverity(t.value)}>
                      {t.label}
                    </button>
                  ))}
                  <span className="mx-2 h-4 w-px bg-border" aria-hidden />
                  {STATUS_TABS.map((t) => (
                    <button key={t.value} type="button" className={pill(status === t.value)}
                      onClick={() => setStatus(t.value)}>
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" aria-hidden />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="알람명 · 요약 · 대상 검색"
                      aria-label="알람 검색"
                      className="pl-8 pr-3 py-1.5 w-56 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleAckAll}
                    disabled={ackAll.isPending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" aria-hidden /> 일괄 확인
                  </button>
                  <button
                    type="button"
                    onClick={() => refetch()}
                    disabled={isFetching}
                    title="새로고침"
                    aria-label="새로고침"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
                    새로고침
                  </button>
                </div>
              </div>

              {/* 요약 (최근 24시간) */}
              {stats ? (
                <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-muted/10 text-xs">
                  <span className="text-muted-foreground">최근 24시간</span>
                  <span className="px-2 py-0.5 rounded-xl border border-[hsl(var(--status-critical)/0.35)] text-[hsl(var(--status-critical))]">
                    Critical {stats.critical}
                  </span>
                  <span className="px-2 py-0.5 rounded-xl border border-[hsl(var(--status-warning)/0.35)] text-[hsl(var(--status-warning))]">
                    Warning {stats.warning}
                  </span>
                  <span className="px-2 py-0.5 rounded-xl border border-[hsl(var(--status-info)/0.35)] text-[hsl(var(--status-info))]">
                    Info {stats.info}
                  </span>
                  <span className="px-2 py-0.5 rounded-xl border border-border text-muted-foreground">
                    미확인 {stats.unacked}
                  </span>
                  <span className="ml-auto text-muted-foreground">
                    총 {data?.total ?? 0}건 중 {alerts.length}건 표시
                  </span>
                </div>
              ) : null}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/20">
                    <tr>
                      <th className={`${TH} w-1 p-0`}><span className="sr-only">심각도</span></th>
                      <th className={`${TH} w-36`}>수신</th>
                      <th className={`${TH} w-20`}>상태</th>
                      <th className={`${TH} w-20`}>심각도</th>
                      <th className={`${TH} w-28`}>클러스터</th>
                      <th className={TH}>알람</th>
                      <th className={`${TH} w-44`}>대상</th>
                      <th className={TH}>요약</th>
                      <th className={`${TH} w-24 text-right`}>반복</th>
                      <th className={`${TH} w-20`}>확인</th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading ? (
                      <TableMessage colSpan={COLS}>알람을 불러오는 중…</TableMessage>
                    ) : alerts.length === 0 ? (
                      <TableMessage colSpan={COLS}>
                        수신된 알람이 없습니다. 위의 &quot;알람 수신 설정 방법&quot;을 참고해 Alertmanager
                        receiver 를 등록하세요.
                      </TableMessage>
                    ) : (
                      alerts.map((alert) => {
                        const sev = SEVERITY_ROW[alert.severity] ?? SEVERITY_ROW.info;
                        const isOpen = expandedId === alert.id;
                        const resolved = alert.status === 'resolved';
                        return [
                          <tr
                            key={alert.id}
                            onClick={() => setExpandedId(isOpen ? null : alert.id)}
                            className={`${ROW} cursor-pointer ${resolved ? 'opacity-60' : sev.grad}`}
                          >
                            {/* 심각도 색 바 — 순수 장식(같은 정보가 '심각도' 열에 글자로 있음) */}
                            <td className="p-0 w-1" aria-hidden="true">
                              <span className={`block w-1 h-full min-h-[2.25rem] ${resolved ? 'bg-border' : sev.bar}`} />
                            </td>
                            <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>
                              {formatTime(alert.receivedAt)}
                            </td>
                            <td className={`${TD} text-xs`}>
                              <span className={resolved
                                ? 'text-[hsl(var(--status-healthy))]'
                                : 'text-[hsl(var(--status-critical))]'}>
                                {resolved ? '해소' : '발생중'}
                              </span>
                            </td>
                            <td className={`${TD} text-xs ${sev.text}`}>{sev.label}</td>
                            <td className={`${TD} text-xs text-muted-foreground truncate`}>
                              {alert.clusterName ?? '-'}
                            </td>
                            <td className={`${TD} truncate max-w-[16rem] ${sev.text}`}>
                              {alert.alertname}
                              {alert.severitySource === 'rule' ? (
                                <span className="ml-1.5 text-[10px] text-muted-foreground" title="알림 규칙이 심각도를 재정의했습니다">
                                  (규칙)
                                </span>
                              ) : null}
                            </td>
                            <td className={`${TD} font-mono text-xs text-muted-foreground truncate max-w-[11rem]`}>
                              {[alert.namespace, alert.resource].filter(Boolean).join(' / ') || '-'}
                            </td>
                            <td className={`${TD} text-xs text-muted-foreground truncate max-w-[20rem]`}>
                              {alert.summary ?? alert.description ?? '-'}
                            </td>
                            <td className={`${TD} text-right text-xs font-mono`}>
                              {alert.occurrences > 1 ? `×${alert.occurrences}` : '-'}
                              {alert.suppressedCount > 0 ? (
                                <span
                                  className="ml-1 text-[10px] text-muted-foreground"
                                  title={`중복 억제로 알림을 만들지 않은 횟수: ${alert.suppressedCount}`}
                                >
                                  (억제 {alert.suppressedCount})
                                </span>
                              ) : null}
                            </td>
                            <td className={TD}>
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); void handleAck(alert); }}
                                  title={alert.acked ? `확인 해제 (${alert.ackBy ?? ''})` : '확인 처리'}
                                  aria-label={alert.acked ? '확인 해제' : '확인 처리'}
                                  className={`p-1 rounded-xl transition-colors ${
                                    alert.acked
                                      ? 'text-[hsl(var(--status-healthy))] hover:bg-secondary'
                                      : 'text-muted-foreground hover:bg-secondary'
                                  }`}
                                >
                                  {alert.acked ? <Check className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
                                </button>
                                {canEdit ? (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); void handleDelete(alert); }}
                                    title="알람 삭제"
                                    aria-label="알람 삭제"
                                    className="p-1 rounded-xl text-muted-foreground hover:bg-secondary hover:text-[hsl(var(--status-critical))] transition-colors"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          </tr>,
                          isOpen ? (
                            <tr key={`${alert.id}-detail`} className="bg-muted/10 border-t border-border">
                              <td colSpan={COLS} className="px-4 py-3 space-y-3">
                                <div className="text-xs text-muted-foreground">
                                  수신 경로 {alert.source} · 발생 {formatTime(alert.startsAt)}
                                  {alert.endsAt ? ` · 해소 ${formatTime(alert.endsAt)}` : ''}
                                  {alert.notifyCount > 0 ? ` · 알림 ${alert.notifyCount}회` : ' · 알림 없음'}
                                  {alert.ackBy ? ` · 확인 ${alert.ackBy} (${formatTime(alert.ackAt)})` : ''}
                                </div>
                                {alert.description ? (
                                  <p className="text-xs whitespace-pre-wrap">{alert.description}</p>
                                ) : null}
                                <AlertAnalysisPanel alert={alert} />
                                <div className="grid gap-4 md:grid-cols-2">
                                  <LabelTable title="라벨" pairs={alert.labels} />
                                  <LabelTable title="어노테이션" pairs={alert.annotations} />
                                </div>
                                {alert.generatorUrl ? (
                                  <a
                                    href={alert.generatorUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                  >
                                    <ExternalLink className="w-3 h-3" aria-hidden /> Prometheus 에서 보기
                                  </a>
                                ) : null}
                                {alert.rawJson ? (
                                  <details>
                                    <summary className="text-xs text-muted-foreground cursor-pointer">
                                      원본 페이로드
                                    </summary>
                                    <pre className="mt-1 text-xs font-mono whitespace-pre-wrap break-all bg-secondary rounded-xl p-2 max-h-80 overflow-y-auto">
                                      {alert.rawJson}
                                    </pre>
                                  </details>
                                ) : null}
                              </td>
                            </tr>
                          ) : null,
                        ];
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </MacCard>
          )}
        </div>
      </div>
    </div>
  );
}
