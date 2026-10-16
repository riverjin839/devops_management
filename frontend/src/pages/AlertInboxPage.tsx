import { useId, useMemo, useState } from 'react';
import { Bell, BellRing, Check, ExternalLink, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { AlertAnalysisPanel } from '@/components/observability/AlertAnalysisPanel';
import {
  ConfirmDialog, EmptyState, LoadingState, LogViewer, PageHeader, PageShell, useToast,
} from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import {
  useAckAlert,
  useAckAllAlerts,
  useAlertStats,
  useAlertsPaged,
  useDeleteAlert,
} from '@/hooks/useAlertInbox';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  AlertNotifyRulesPanel,
  AlertReceiverGuide,
  LabelTable,
  ROW,
  TD,
  TH,
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
 * 심각도별 시각 구분 — 좌측 바(색) + 심각도 열 글자색. 알람명은 굵기로만 위계를 준다
 * (상태당 신호 1~2개, 그라데이션 금지 — DESIGN_SYSTEM §12.12-3·4).
 * Tailwind JIT 가 정적으로 스캔하므로 클래스는 조립하지 않고 고정 문자열로 둔다.
 */
const SEVERITY_ROW: Record<AlertSeverity, { bar: string; text: string; name: string; label: string }> = {
  critical: {
    bar: 'bg-status-critical',
    text: 'text-status-critical font-semibold',
    name: 'text-foreground font-semibold',
    label: 'Critical',
  },
  warning: {
    bar: 'bg-status-warning',
    text: 'text-status-warning font-medium',
    name: 'text-foreground font-medium',
    label: 'Warning',
  },
  info: {
    bar: 'bg-status-info',
    text: 'text-status-info',
    name: 'text-foreground',
    label: 'Info',
  },
};

// 최근 24시간 요약 칩 — 값이 0 이면 중립색 (§12.12-2).
const statChip = (count: number, tone: string) =>
  `px-2 py-0.5 rounded-xl border tabular-nums ${count > 0 ? tone : 'border-border text-muted-foreground'}`;

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

  const [tab, setTab] = useState<MainTab>('inbox');
  const [clusterId, setClusterId] = useState<string | null>(null);
  const [severity, setSeverity] = useState('all');
  const [status, setStatus] = useState('firing');
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [ackAllOpen, setAckAllOpen] = useState(false);

  // 검색어는 타이핑이 멈춘 뒤 300ms 에만 조회한다(D-111). 일괄 확인도 같은 값을 써야
  // "지금 보이는 목록"과 처리 대상이 어긋나지 않는다.
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const q = debouncedQuery || undefined;

  const {
    data, isLoading, isError, error, isFetching, refetch,
    hasNextPage, fetchNextPage, isFetchingNextPage,
  } = useAlertsPaged({ clusterId, severity, status, q });
  const statsQuery = useAlertStats(clusterId);
  const stats = statsQuery.data;

  const ackAlert = useAckAlert();
  const ackAll = useAckAllAlerts();
  const removeAlert = useDeleteAlert();

  // 반복 수신은 received_at 을 갱신해 행이 앞으로 올라온다 — 페이지 사이에 같은 알람이 다시 실릴 수 있어 id 로 중복을 걷는다(D-111).
  const alerts: AlertEvent[] = useMemo(() => {
    const seen = new Set<string>();
    return (data?.pages.flatMap((page) => page.data) ?? []).filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  }, [data]);
  const total = data?.pages[0]?.total ?? 0;

  const handleAck = async (alert: AlertEvent) => {
    try {
      await ackAlert.mutateAsync({ id: alert.id, acked: !alert.acked });
    } catch (err) {
      toast.error(formatApiError(err, '확인 처리 실패'));
    }
  };

  // 일괄 확인 대상 = 지금 목록에 걸린 조건 그대로(클러스터·심각도·상태·검색어) — D-103
  const ackAllScope = [
    clusterId ? (clusters.find((c) => c.id === clusterId)?.name ?? '선택 클러스터') : '볼 수 있는 전체 클러스터',
    severity === 'all' ? '모든 심각도' : severity,
    status === 'all' ? '발생중·해소 전체' : status === 'firing' ? '발생중' : '해소',
    q ? `검색 "${q}"` : null,
  ].filter(Boolean).join(' · ');

  const handleAckAll = async () => {
    setAckAllOpen(false);
    try {
      const res = await ackAll.mutateAsync({ clusterId, severity, status, q });
      toast.success(`${res.acked}건 확인 처리됨`);
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
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId}
          onSelect={(id) => setClusterId(id ?? null)}
          allowAll
          allLabel="전체 클러스터"
          iconOnly
        />

        <div className="flex-1 min-w-0 space-y-3">
          <PageHeader
            icon={BellRing}
            title="알람 인박스"
            description="Alertmanager 에서 받은 알람을 확인·분석하고 알림 규칙을 관리합니다."
          />

          <AlertReceiverGuide />

          <div className="flex items-center gap-1">
            <button type="button" aria-pressed={tab === 'inbox'} className={pill(tab === 'inbox')}
              onClick={() => setTab('inbox')}>
              알람 인박스
            </button>
            <button type="button" aria-pressed={tab === 'rules'} className={pill(tab === 'rules')}
              onClick={() => setTab('rules')}>
              알림 규칙
            </button>
          </div>

          {tab === 'rules' ? (
            <AlertNotifyRulesPanel clusters={clusters} />
          ) : (
            <MacCard
              title="수신 알람"
              bodyPadding="p-0"
              actions={<>
                <div className="flex flex-wrap items-center gap-1">
                  {SEVERITY_TABS.map((t) => (
                    <button key={t.value} type="button" aria-pressed={severity === t.value}
                      className={pill(severity === t.value)}
                      onClick={() => setSeverity(t.value)}>
                      {t.label}
                    </button>
                  ))}
                  <span className="mx-2 h-4 w-px bg-border" aria-hidden />
                  {STATUS_TABS.map((t) => (
                    <button key={t.value} type="button" aria-pressed={status === t.value}
                      className={pill(status === t.value)}
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
                  {/* 확인(ack)·일괄 확인은 서버가 역할 제한 없이 허용한다(볼 수 있는 알람이면 viewer 도 가능). */}
                  <button
                    type="button"
                    onClick={() => setAckAllOpen(true)}
                    disabled={ackAll.isPending}
                    title="지금 보이는 조건의 미확인 알람을 모두 확인 처리"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
                  >
                    <Check className="w-3.5 h-3.5" aria-hidden /> 일괄 확인
                  </button>
                  <button
                    type="button"
                    onClick={() => { void refetch(); void statsQuery.refetch(); }}
                    disabled={isFetching}
                    title="새로고침"
                    aria-label="새로고침"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} aria-hidden />
                    새로고침
                  </button>
                </div>
              </>}
            >
              {/* 요약 — 목록 필터와 기준이 다르므로 기준을 함께 적는다(D-111). */}
              <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-muted/10 text-xs">
                <span
                  className="text-muted-foreground"
                  title="선택한 클러스터만 반영하고, 위의 심각도·상태·검색 조건은 반영하지 않습니다."
                >
                  최근 24시간 · 해소 포함 · 필터 미적용
                </span>
                {stats ? (
                  <>
                    <span className={statChip(stats.critical, 'border-status-critical/30 text-status-critical')}>
                      Critical {stats.critical}
                    </span>
                    <span className={statChip(stats.warning, 'border-status-warning/30 text-status-warning')}>
                      Warning {stats.warning}
                    </span>
                    <span className={statChip(stats.info, 'border-status-info/30 text-status-info')}>
                      Info {stats.info}
                    </span>
                    <span
                      className="px-2 py-0.5 rounded-xl border border-border text-muted-foreground"
                      title="발생중인 알람 중 아직 확인하지 않은 건수"
                    >
                      미확인 {stats.unacked}
                    </span>
                  </>
                ) : statsQuery.isError ? (
                  <span className="text-status-warning">
                    요약을 불러오지 못했습니다 — {formatApiError(statsQuery.error)}{' '}
                    <button
                      type="button"
                      onClick={() => { void statsQuery.refetch(); }}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      다시 시도
                    </button>
                  </span>
                ) : (
                  <span className="text-muted-foreground">불러오는 중…</span>
                )}
                {stats && statsQuery.isError ? (
                  <span className="text-status-warning">
                    최근 갱신 실패 — {formatApiError(statsQuery.error)}
                  </span>
                ) : null}
              </div>

              {isError && data ? (
                <p className="px-4 py-2 border-b border-border text-xs text-status-warning">
                  최근 갱신 실패 — {formatApiError(error)}{' '}
                  <button
                    type="button"
                    onClick={() => { void refetch(); }}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    다시 시도
                  </button>
                </p>
              ) : null}

              {isLoading ? (
                <LoadingState label="알람을 불러오는 중…" />
              ) : isError && !data ? (
                <EmptyState
                  title="알람을 불러오지 못했습니다"
                  description={formatApiError(error)}
                  action={{ label: '다시 시도', onClick: () => { void refetch(); }, variant: 'secondary' }}
                />
              ) : alerts.length === 0 ? (
                <EmptyState
                  title="수신된 알람이 없습니다"
                  description={'조건에 맞는 알람이 없습니다. 아직 수신 설정 전이라면 위의 "알람 수신 설정 방법"을 참고해 Alertmanager receiver 를 등록하세요.'}
                />
              ) : (
                <>
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
                        {alerts.map((alert) => (
                          <AlertRow
                            key={alert.id}
                            alert={alert}
                            isOpen={expandedId === alert.id}
                            onToggle={() => setExpandedId((prev) => (prev === alert.id ? null : alert.id))}
                            onAck={() => { void handleAck(alert); }}
                            onDelete={() => { void handleDelete(alert); }}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-border text-xs text-muted-foreground">
                    <span>총 {total}건 중 {alerts.length}건 표시</span>
                    {hasNextPage ? (
                      <button
                        type="button"
                        onClick={() => { void fetchNextPage(); }}
                        disabled={isFetchingNextPage}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-secondary px-3 py-1.5 text-sm text-foreground hover:bg-secondary/80 disabled:opacity-50"
                      >
                        {isFetchingNextPage ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : null}
                        더 보기
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </MacCard>
          )}
        </div>
      </PageShell>
      <ConfirmDialog
        open={ackAllOpen}
        title="미확인 알람 일괄 확인"
        description={`다음 조건에 맞는 미확인 알람을 모두 확인 처리한다 — ${ackAllScope}.`}
        confirmLabel="일괄 확인"
        onConfirm={() => void handleAckAll()}
        onCancel={() => setAckAllOpen(false)}
      />
    </div>
  );
}

/**
 * 알람 한 행(+펼침 상세). 삭제 권한은 알람이 속한 클러스터 기준으로 판정해야 해서
 * (테넌트 바인딩) 행 단위 컴포넌트로 분리해 그 안에서 `useCanOperate` 를 호출한다(D-105).
 */
function AlertRow({ alert, isOpen, onToggle, onAck, onDelete }: {
  alert: AlertEvent;
  isOpen: boolean;
  onToggle: () => void;
  onAck: () => void;
  onDelete: () => void;
}) {
  const { canOperate, withHint, ariaWithHint } = useCanOperate(alert.clusterId);
  const detailId = useId();
  const sev = SEVERITY_ROW[alert.severity] ?? SEVERITY_ROW.info;
  const resolved = alert.status === 'resolved';

  return (
    <>
      <tr
        onClick={onToggle}
        className={`${ROW} cursor-pointer ${resolved ? 'opacity-60' : ''}`}
      >
        {/* 심각도 색 바 — 순수 장식(같은 정보가 '심각도' 열에 글자로 있음) */}
        <td className="p-0 w-1" aria-hidden="true">
          <span className={`block w-1 h-full min-h-[2.25rem] ${resolved ? 'bg-border' : sev.bar}`} />
        </td>
        <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>
          {formatTime(alert.receivedAt)}
        </td>
        <td className={`${TD} text-xs`}>
          <span className={resolved ? 'text-muted-foreground' : 'text-foreground font-medium'}>
            {resolved ? '해소' : '발생중'}
          </span>
        </td>
        <td className={`${TD} text-xs ${sev.text}`}>{sev.label}</td>
        <td className={`${TD} text-xs text-muted-foreground truncate`}>
          {alert.clusterName ?? '—'}
        </td>
        <td className={`${TD} truncate max-w-[16rem] ${sev.name}`}>
          {/* 키보드 펼침 — 행 onClick 은 마우스 편의, 실제 토글 컨트롤은 이 버튼(D-107). */}
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls={detailId}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className="max-w-full truncate text-left rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {alert.alertname}
          </button>
          {alert.severitySource === 'rule' ? (
            <span className="ml-1.5 text-[11px] text-muted-foreground" title="알림 규칙이 심각도를 재정의했습니다">
              (규칙)
            </span>
          ) : null}
        </td>
        <td className={`${TD} font-mono text-xs text-muted-foreground truncate max-w-[11rem]`}>
          {[alert.namespace, alert.resource].filter(Boolean).join(' / ') || '—'}
        </td>
        <td className={`${TD} text-xs text-muted-foreground truncate max-w-[20rem]`}>
          {alert.summary ?? alert.description ?? '—'}
        </td>
        <td className={`${TD} text-right text-xs font-mono`}>
          {alert.occurrences > 1 ? `×${alert.occurrences}` : '—'}
          {alert.suppressedCount > 0 ? (
            <span
              className="ml-1 text-[11px] text-muted-foreground"
              title={`중복 억제로 알림을 만들지 않은 횟수: ${alert.suppressedCount}`}
            >
              (억제 {alert.suppressedCount})
            </span>
          ) : null}
        </td>
        <td className={TD}>
          <div className="flex items-center gap-1">
            {/* 확인(ack)은 서버가 역할 제한을 두지 않는다 — 알람을 볼 수 있으면 누구나 가능. */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onAck(); }}
              title={alert.acked ? `확인 해제 (${alert.ackBy ?? ''})` : '확인 처리'}
              aria-label={`${alert.alertname} 확인`}
              aria-pressed={alert.acked}
              className={`p-1 rounded-xl transition-colors ${
                alert.acked
                  ? 'text-foreground hover:bg-secondary'
                  : 'text-muted-foreground hover:bg-secondary'
              }`}
            >
              {alert.acked
                ? <Check className="w-3.5 h-3.5" aria-hidden />
                : <Bell className="w-3.5 h-3.5" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              disabled={!canOperate}
              title={withHint('알람 삭제')}
              aria-label={ariaWithHint(`${alert.alertname} 알람 삭제`)}
              className="p-1 rounded-xl text-muted-foreground hover:bg-secondary hover:text-status-critical transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden />
            </button>
          </div>
        </td>
      </tr>
      {isOpen ? (
        <tr id={detailId} className="bg-muted/10 border-t border-border">
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
                <div className="mt-1">
                  <LogViewer text={alert.rawJson} maxHeight="max-h-80" />
                </div>
              </details>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
