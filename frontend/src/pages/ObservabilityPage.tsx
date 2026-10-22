import { useId, useMemo, useState } from 'react';
import {
  SelectClusterEmptyState, PageHeader, LoadingState, EmptyState, ErrorState, PageShell,
} from '@/components/common';
import { Activity, Plus, RefreshCw, Search, Settings2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { MetricCardsPanel } from '@/components/dashboard/MetricCardsPanel';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { useClusters } from '@/hooks/useCluster';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { pickParam, useUrlParams } from '@/hooks/useUrlParams';
import {
  useMetricValues,
  useObservabilityMetrics,
  useObservabilityModules,
  useObservabilitySettings,
  usePromActiveAlerts,
  usePromRules,
  usePromTargets,
} from '@/hooks/useObservability';
import {
  ActiveAlertsTable,
  DisabledMetricsSection,
  MetricEditModal,
  MetricsTable,
  ObservabilityNotice,
  ObservabilitySettingsDialog,
  RULE_STATE_LABEL,
  RulesTable,
  SourceBadge,
  TARGET_HEALTH_LABEL,
  TargetsTable,
  type MetricEditAction,
} from '@/components/observability';
import type { DataSource, ObservabilityFreshness, ObservabilityMetric } from '@/types';

const VIEW_VALUES = ['metrics', 'rules', 'targets', 'alerts'] as const;
type ViewTab = typeof VIEW_VALUES[number];

const VIEW_TABS: Array<{ value: ViewTab; label: string }> = [
  { value: 'metrics', label: '지표' },
  { value: 'rules', label: '알람 규칙' },
  { value: 'targets', label: '스크레이프 대상' },
  { value: 'alerts', label: '발화 중 알람' },
];

const RULE_STATES = ['all', 'firing', 'pending', 'inactive'] as const;
const TARGET_HEALTH = ['all', 'up', 'down', 'unknown'] as const;
const DEFAULT_MODULE = 'kube-prometheus-stack';

// 클러스터를 바꿔도 모듈·뷰·필터 쿼리를 유지한다(§12.13 URL 상태).
const observabilityPath = (id: string) => `/observability/${id}${window.location.search}`;

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
    active
      ? 'bg-primary text-primary-foreground'
      : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
  }`;

/** 뷰 응답 공통 메타 — 지표 현재값·규칙·대상·알람 응답이 모두 이 필드를 가진다. */
type ViewMeta = ObservabilityFreshness & {
  source?: DataSource;
  collectedAt?: string | null;
  detail?: string | null;
};

/**
 * Observability — 관측 스택(kube-prometheus-stack 등)의 개별 지표를 dense 테이블로 훑는 화면.
 *
 * 모듈 탭으로 스택을 고르고, 뷰 탭으로 지표 / 알람 규칙 / 스크레이프 대상 / 발화 중 알람을 본다.
 * 지표 목록은 DB 카탈로그(`observability_metrics`)라 운영자가 화면에서 직접 편집한다.
 * 조회 실패·미연결은 "없음"으로 보이지 않게 표마다 오류·미연결 상태를 따로 그린다(D-183).
 */
export function ObservabilityPage() {
  const clustersQ = useClusters();
  const clusters = useMemo(() => clustersQ.data ?? [], [clustersQ.data]);
  const { clusterId, selectCluster } = useClusterRouteParam('/observability', clusters, {
    pathFor: observabilityPath,
  });
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const viewTabsId = useId();

  const modulesQ = useObservabilityModules();
  const modules = useMemo(() => modulesQ.data ?? [], [modulesQ.data]);

  const [params, setParams] = useUrlParams({
    module: DEFAULT_MODULE, view: 'metrics', q: '', state: 'all', health: 'all',
  });
  // 주소의 모듈이 목록에 없으면(삭제·오타) 기본 모듈로.
  const moduleKey = modules.length > 0 && !modules.some((m) => m.key === params.module)
    ? (modules.some((m) => m.key === DEFAULT_MODULE) ? DEFAULT_MODULE : modules[0].key)
    : params.module;
  const view = pickParam(params.view, VIEW_VALUES, 'metrics');
  const ruleState = pickParam(params.state, RULE_STATES, 'all');
  const targetHealth = pickParam(params.health, TARGET_HEALTH, 'all');
  const query = params.q;
  const debouncedQuery = useDebouncedValue(query, 300);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeModule = modules.find((m) => m.key === moduleKey);
  const hasCluster = !!clusterId;
  // kube-prometheus-stack 전용 뷰(규칙/대상/발화 중)는 다른 모듈에서는 의미가 없다.
  const isPromModule = moduleKey === DEFAULT_MODULE;
  const effectiveView: ViewTab = isPromModule ? view : 'metrics';

  // 지표 정의(사용 안 함 포함) — 편집 대상·사용 안 함 섹션·빈 모듈 판정의 원천.
  const defsQ = useObservabilityMetrics(moduleKey);
  const defs = useMemo(() => defsQ.data ?? [], [defsQ.data]);
  const enabledCount = defs.filter((m) => m.enabled).length;
  const disabledDefs = useMemo(() => defs.filter((m) => !m.enabled), [defs]);
  const noEnabledMetrics = defsQ.isSuccess && enabledCount === 0;

  const values = useMetricValues(moduleKey, clusterId || null,
    hasCluster && effectiveView === 'metrics' && !noEnabledMetrics);
  const rules = usePromRules(clusterId || null, ruleState, debouncedQuery,
    hasCluster && effectiveView === 'rules');
  const targets = usePromTargets(clusterId || null, targetHealth,
    hasCluster && effectiveView === 'targets');
  const activeAlerts = usePromActiveAlerts(clusterId || null,
    hasCluster && effectiveView === 'alerts');

  const editingMetric: ObservabilityMetric | null = editingId
    ? defs.find((m) => m.id === editingId) ?? null
    : null;

  const metricRows = useMemo(() => {
    const rows = values.data?.data ?? [];
    if (!query.trim()) return rows;
    const needle = query.trim().toLowerCase();
    return rows.filter((row) =>
      `${row.label} ${row.key} ${row.category} ${row.promql}`.toLowerCase().includes(needle));
  }, [values.data, query]);

  const summary = useMemo(() => {
    const rows = values.data?.data ?? [];
    return {
      ok: rows.filter((r) => r.status === 'ok' && r.state === 'ok').length,
      warning: rows.filter((r) => r.status === 'ok' && r.state === 'warning').length,
      critical: rows.filter((r) => r.status === 'ok' && r.state === 'critical').length,
      unavailable: rows.filter((r) => r.status !== 'ok').length,
    };
  }, [values.data]);

  // 신선도·오류는 **현재 뷰 쿼리만** 읽는다(D-183 ④ — 다른 뷰 캐시가 "실시간"을 대신 띄우지 않게).
  const activeQuery = effectiveView === 'metrics' ? values
    : effectiveView === 'rules' ? rules
      : effectiveView === 'targets' ? targets
        : activeAlerts;
  const activeEnabled = hasCluster && !(effectiveView === 'metrics' && noEnabledMetrics);
  const meta: ViewMeta | undefined = activeQuery.data;
  const isFetching = activeQuery.isFetching;
  const refetchActive = () => { void activeQuery.refetch(); };
  // 데이터 없이 실패 → 표 자리에 ErrorState. 이전 데이터가 있으면 표 + "갱신 실패" 안내.
  const loadError = activeQuery.isError && !meta ? activeQuery.error : undefined;
  const refetchError = activeQuery.isError && meta ? activeQuery.error : undefined;
  const offline = !loadError && meta?.source === 'offline' ? (meta.detail ?? null) : undefined;
  // 오프라인이 아닌데 detail 이 있으면(구버전 서버: Alertmanager 실패 등) 역시 불완전한 결과다.
  const incomplete = !!(meta?.errors?.length || meta?.stale || refetchError || meta?.source === 'partial'
    || (offline === undefined && meta?.detail));

  const staleSettings = useObservabilitySettings(!!meta?.stale);

  const openEditor = (metricId: string | null) => {
    setEditingId(metricId);
    setEditorOpen(true);
  };

  // 편집은 숨기지 않고 비활성 + 사유(§12.9). 정의를 불러오기 전에는 빈 "지표 추가" 폼이 열리지 않게 막는다(D-186 ④).
  const editAction: MetricEditAction = {
    onEdit: openEditor,
    disabledReason: (metricId) => {
      if (!canOperate) return withHint('지표 편집');
      if (defsQ.isLoading) return '지표 정의를 불러오는 중입니다';
      if (defsQ.isError) return '지표 정의를 불러오지 못했습니다 — 새로고침하세요';
      if (!defs.some((d) => d.id === metricId)) return '지표 정의를 찾을 수 없습니다 — 새로고침하세요';
      return undefined;
    },
  };

  const addMetricButton = (
    <button
      type="button"
      onClick={() => openEditor(null)}
      disabled={!canOperate}
      title={withHint('지표 추가')}
      aria-label={ariaWithHint('지표 추가')}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Plus className="w-3.5 h-3.5" aria-hidden /> 지표 추가
    </button>
  );

  const clustersFailed = clustersQ.isError && clusters.length === 0;

  const renderBody = () => {
    if (effectiveView === 'metrics' && noEnabledMetrics) {
      return (
        <EmptyState
          title={disabledDefs.length > 0 ? '사용 중인 지표가 없습니다' : '등록된 지표가 없습니다'}
          description={disabledDefs.length > 0
            ? "아래 '사용 안 함'에서 지표를 다시 켜거나 새 지표를 추가하세요."
            : '지표를 추가하면 이 모듈이 활성화됩니다. PromQL 한 줄로 정의합니다.'}
        >
          <div className="mt-4">{addMetricButton}</div>
        </EmptyState>
      );
    }
    if (clustersFailed) {
      return (
        <ErrorState
          error={clustersQ.error}
          title="클러스터 목록을 불러오지 못했습니다"
          onRetry={() => { void clustersQ.refetch(); }}
        />
      );
    }
    if (!hasCluster) {
      return clustersQ.isLoading ? <LoadingState /> : <SelectClusterEmptyState />;
    }
    const common = {
      error: loadError,
      onRetry: refetchActive,
      offline,
      clusterId,
      incomplete,
    };
    if (effectiveView === 'metrics') {
      return (
        <MetricsTable
          {...common}
          rows={metricRows}
          isLoading={values.isLoading}
          emptyMessage={query ? '검색과 일치하는 지표가 없습니다' : undefined}
          edit={editAction}
        />
      );
    }
    if (effectiveView === 'rules') {
      return (
        <RulesTable
          {...common}
          rows={rules.data?.rules ?? []}
          isLoading={rules.isLoading}
          emptyMessage={debouncedQuery || ruleState !== 'all' ? '조건과 일치하는 규칙이 없습니다' : undefined}
        />
      );
    }
    if (effectiveView === 'targets') {
      return (
        <TargetsTable
          {...common}
          rows={targets.data?.targets ?? []}
          isLoading={targets.isLoading}
          emptyMessage={targetHealth !== 'all' ? '조건과 일치하는 스크레이프 대상이 없습니다' : undefined}
        />
      );
    }
    return (
      <ActiveAlertsTable
        {...common}
        rows={activeAlerts.data?.alerts ?? []}
        isLoading={activeAlerts.isLoading}
      />
    );
  };

  const changeView = (next: ViewTab) => setParams({ view: next, q: null });

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => selectCluster(id)}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <PageHeader
            icon={Activity}
            title="관측 지표"
            description="모듈별 지표 · 알람 규칙 · 스크레이프 대상 · 발화 중 알람을 한곳에서 봅니다."
          />

          {/* 모듈 탭 — 지표가 없는 모듈도 골라서 첫 지표를 추가할 수 있다(D-186 ③). */}
          <div>
            <div role="group" aria-label="관측 모듈" className="flex flex-wrap items-center gap-2">
              {modulesQ.isLoading ? (
                <LoadingState compact />
              ) : modulesQ.isError ? (
                <ErrorState
                  compact
                  error={modulesQ.error}
                  title="관측 모듈 목록을 불러오지 못했습니다"
                  onRetry={() => { void modulesQ.refetch(); }}
                />
              ) : modules.length === 0 ? (
                <EmptyState
                  compact
                  title="등록된 관측 모듈이 없습니다"
                  description="관측 모듈 카탈로그가 비어 있습니다. 백엔드 기동 로그에서 관측 모듈 시드 단계를 확인하세요."
                />
              ) : (
                modules.map((mod) => {
                  const planned = mod.status !== 'active';
                  const selected = mod.key === moduleKey;
                  return (
                    <button
                      key={mod.key}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setParams({ module: mod.key })}
                      title={planned
                        ? `${mod.label} — 사용 중인 지표가 없습니다. 골라서 지표를 추가하면 활성화됩니다.`
                        : mod.description ?? mod.label}
                      // 준비 중 모듈은 투명도 대신 점선 테두리로 구분한다 — 활성 버튼이라 글자 대비 4.5:1 을 지켜야 한다.
                      className={`${pill(selected)} ${planned && !selected ? 'border border-dashed border-border' : ''}`}
                    >
                      {mod.label}
                      <span className="ml-1.5 text-xs tabular-nums">
                        {planned ? '준비 중' : mod.metricCount}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            {activeModule?.description ? (
              <p className="mt-2 text-xs text-muted-foreground">{activeModule.description}</p>
            ) : null}
          </div>

          <MacCard
            title={activeModule?.label ?? moduleKey}
            bodyPadding="p-0"
            actions={<>
              {/* 뷰 탭 · 신선도 · 새로고침 */}
              <div role="tablist" aria-label="보기" className="flex flex-wrap items-center gap-1">
                {VIEW_TABS.map((tab) => {
                  const disabled = !isPromModule && tab.value !== 'metrics';
                  const selected = effectiveView === tab.value;
                  return (
                    <button
                      key={tab.value}
                      id={`${viewTabsId}-tab-${tab.value}`}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls={`${viewTabsId}-panel`}
                      aria-disabled={disabled || undefined}
                      aria-describedby={disabled ? `${viewTabsId}-prom-only` : undefined}
                      onClick={() => { if (!disabled) changeView(tab.value); }}
                      title={disabled ? 'kube-prometheus-stack 모듈에서만 제공됩니다.' : undefined}
                      className={`${pill(selected)} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
                <span id={`${viewTabsId}-prom-only`} className="sr-only">
                  kube-prometheus-stack 모듈에서만 제공됩니다.
                </span>
              </div>

              <div className="flex items-center gap-2">
                {activeEnabled ? (
                  <SourceBadge
                    source={meta?.source}
                    collectedAt={meta?.collectedAt}
                    stale={!!meta?.stale}
                    failed={activeQuery.isError}
                    lastSuccessAt={activeQuery.dataUpdatedAt || undefined}
                  />
                ) : null}
                {effectiveView === 'metrics' ? addMetricButton : null}
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  title="관측 지표 설정"
                  aria-label="관측 지표 설정"
                  className="p-1.5 rounded-xl text-muted-foreground bg-secondary hover:bg-secondary/80 transition-colors"
                >
                  <Settings2 className="w-4 h-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={refetchActive}
                  disabled={isFetching || !activeEnabled}
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
            <div
              id={`${viewTabsId}-panel`}
              role="tabpanel"
              aria-labelledby={`${viewTabsId}-tab-${effectiveView}`}
            >
              {/* 뷰별 보조 필터 + 요약 */}
              <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-border bg-muted/10">
                {effectiveView === 'metrics' ? (
                  <>
                    <SearchInput value={query} onChange={(v) => setParams({ q: v })} label="지표 · PromQL 검색" />
                    {values.data && offline === undefined ? (
                      <div className="flex items-center gap-2 text-xs">
                        <Chip tone="healthy" label="정상" count={summary.ok} />
                        <Chip tone="warning" label="경고" count={summary.warning} />
                        <Chip tone="critical" label="심각" count={summary.critical} />
                        <Chip tone="muted" label="수집 불가" count={summary.unavailable} />
                      </div>
                    ) : null}
                  </>
                ) : null}

                {effectiveView === 'rules' ? (
                  <>
                    <SearchInput value={query} onChange={(v) => setParams({ q: v })} label="규칙명 · 표현식 검색" />
                    <FilterGroup
                      label="규칙 상태"
                      options={RULE_STATES}
                      value={ruleState}
                      onChange={(v) => setParams({ state: v })}
                      labels={RULE_STATE_LABEL}
                    />
                    {rules.data ? (
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {rules.data.rules.length}건
                      </span>
                    ) : null}
                  </>
                ) : null}

                {effectiveView === 'targets' ? (
                  <>
                    <FilterGroup
                      label="수집 상태"
                      options={TARGET_HEALTH}
                      value={targetHealth}
                      onChange={(v) => setParams({ health: v })}
                      labels={TARGET_HEALTH_LABEL}
                    />
                    {targets.data ? (
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                        {targets.data.targets.length}건
                      </span>
                    ) : null}
                  </>
                ) : null}

                {effectiveView === 'alerts' && activeAlerts.data ? (
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {activeAlerts.data.alerts.length}건 발화·대기 중
                  </span>
                ) : null}
              </div>

              {activeEnabled ? (
                <ObservabilityNotice
                  errors={meta?.errors}
                  detail={offline === undefined ? meta?.detail : null}
                  stale={meta?.stale}
                  snapshotAgeSec={meta?.snapshotAgeSec}
                  collectedAt={meta?.collectedAt}
                  staleMinutes={staleSettings.data?.staleMinutes}
                  refetchError={refetchError}
                />
              ) : null}

              {renderBody()}

              {effectiveView === 'metrics' ? (
                defsQ.isError ? (
                  <div className="border-t border-border">
                    <ErrorState
                      compact
                      error={defsQ.error}
                      title="지표 정의를 불러오지 못했습니다 — 편집과 '사용 안 함' 목록을 쓸 수 없습니다"
                      onRetry={() => { void defsQ.refetch(); }}
                    />
                  </div>
                ) : (
                  <DisabledMetricsSection metrics={disabledDefs} onEdit={openEditor} />
                )
              ) : null}
            </div>
          </MacCard>

          <MetricCardsPanel />
        </div>
      </PageShell>

      <MetricEditModal
        isOpen={editorOpen}
        onClose={() => { setEditorOpen(false); setEditingId(null); }}
        moduleKey={moduleKey}
        editing={editingMetric}
        clusterId={clusterId || null}
      />
      <ObservabilitySettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

function SearchInput({ value, onChange, label }: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">{label}</label>
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" aria-hidden />
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={label}
        className="pl-8 pr-3 py-1.5 w-56 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
    </div>
  );
}

function FilterGroup({ label, options, value, onChange, labels }: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  labels?: Record<string, string>;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          aria-pressed={value === opt}
          onClick={() => onChange(opt)}
          title={opt === 'all' ? undefined : opt}
          className={`px-2.5 py-1 rounded-xl text-xs transition-colors ${
            value === opt
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
          }`}
        >
          {opt === 'all' ? '전체' : (labels?.[opt] ?? opt)}
        </button>
      ))}
    </div>
  );
}

// Tailwind JIT 는 클래스명을 정적으로 스캔하므로 템플릿 리터럴로 조립하면 안 된다 — 고정 맵.
// 정상은 무채색, 상태색은 비정상 + 값≠0 일 때만 (DESIGN_SYSTEM §12.12-3, D-119·D-132).
const CHIP_CLS: Record<'healthy' | 'warning' | 'critical' | 'muted', string> = {
  healthy: 'text-muted-foreground border-border',
  warning: 'text-status-warning border-status-warning/30',
  critical: 'text-status-critical border-status-critical/30',
  muted: 'text-muted-foreground border-border',
};

function Chip({ tone, label, count }: {
  tone: 'healthy' | 'warning' | 'critical' | 'muted';
  label: string;
  count: number;
}) {
  return (
    <span className={`px-2 py-0.5 rounded-xl border tabular-nums ${CHIP_CLS[count > 0 ? tone : 'muted']}`}>
      {label} {count}
    </span>
  );
}
