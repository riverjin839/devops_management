import { useMemo, useState } from 'react';
import { Plus, RefreshCw, Search } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { useClusters } from '@/hooks/useCluster';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import {
  useMetricValues,
  useObservabilityMetrics,
  useObservabilityModules,
  usePromActiveAlerts,
  usePromRules,
  usePromTargets,
} from '@/hooks/useObservability';
import { useAuthStore, hasRole } from '@/stores/authStore';
import {
  ActiveAlertsTable,
  MetricEditModal,
  MetricsTable,
  RulesTable,
  SourceBadge,
  TargetsTable,
} from '@/components/observability';
import type { DataSource, ObservabilityMetric } from '@/types';

type ViewTab = 'metrics' | 'rules' | 'targets' | 'alerts';

const VIEW_TABS: Array<{ value: ViewTab; label: string }> = [
  { value: 'metrics', label: '지표' },
  { value: 'rules', label: '알람 규칙' },
  { value: 'targets', label: '스크레이프 타겟' },
  { value: 'alerts', label: '발화중 알람' },
];

const RULE_STATES = ['all', 'firing', 'pending', 'inactive'];
const TARGET_HEALTH = ['all', 'up', 'down', 'unknown'];

const pill = (active: boolean) =>
  `px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
    active
      ? 'bg-primary text-primary-foreground'
      : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
  }`;

/**
 * Observability — 관측 스택(kube-prometheus-stack 등)의 개별 지표를 dense 테이블로 훑는 화면.
 *
 * 모듈 탭으로 스택을 고르고, 뷰 탭으로 지표 / 알람 규칙 / 스크레이프 타겟 / 발화중 알람을 본다.
 * 지표 목록은 DB 카탈로그(`observability_metrics`)라 운영자가 화면에서 직접 편집한다.
 */
export function ObservabilityPage() {
  const { data: clusters = [] } = useClusters();
  const { clusterId, selectCluster } = useClusterRouteParam('/observability', clusters);
  const user = useAuthStore((s) => s.user);
  const canEdit = hasRole(user, 'admin', 'operator');

  const { data: modules = [], isLoading: modulesLoading } = useObservabilityModules();
  const [moduleKey, setModuleKey] = useState('kube-prometheus-stack');
  const [view, setView] = useState<ViewTab>('metrics');

  const [metricQuery, setMetricQuery] = useState('');
  const [ruleState, setRuleState] = useState('all');
  const [ruleQuery, setRuleQuery] = useState('');
  const [targetHealth, setTargetHealth] = useState('all');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const activeModule = modules.find((m) => m.key === moduleKey);
  const hasCluster = !!clusterId;
  // kube-prometheus-stack 전용 뷰(규칙/타겟/발화중)는 다른 모듈에서는 의미가 없다.
  const isPromModule = moduleKey === 'kube-prometheus-stack';
  const effectiveView: ViewTab = isPromModule ? view : 'metrics';

  const values = useMetricValues(moduleKey, clusterId || null, hasCluster && effectiveView === 'metrics');
  const rules = usePromRules(clusterId || null, ruleState, ruleQuery,
    hasCluster && effectiveView === 'rules');
  const targets = usePromTargets(clusterId || null, targetHealth,
    hasCluster && effectiveView === 'targets');
  const activeAlerts = usePromActiveAlerts(clusterId || null,
    hasCluster && effectiveView === 'alerts');

  const { data: metricDefs = [] } = useObservabilityMetrics(moduleKey);
  const editingMetric: ObservabilityMetric | null = editingId
    ? metricDefs.find((m) => m.id === editingId) ?? null
    : null;

  const metricRows = useMemo(() => {
    const rows = values.data?.data ?? [];
    if (!metricQuery.trim()) return rows;
    const needle = metricQuery.trim().toLowerCase();
    return rows.filter((row) =>
      `${row.label} ${row.key} ${row.category} ${row.promql}`.toLowerCase().includes(needle));
  }, [values.data, metricQuery]);

  const summary = useMemo(() => {
    const rows = values.data?.data ?? [];
    return {
      ok: rows.filter((r) => r.status === 'ok' && r.state === 'ok').length,
      warning: rows.filter((r) => r.status === 'ok' && r.state === 'warning').length,
      critical: rows.filter((r) => r.status === 'ok' && r.state === 'critical').length,
      unavailable: rows.filter((r) => r.status !== 'ok').length,
    };
  }, [values.data]);

  // 뷰마다 쿼리 결과 타입이 달라 union 으로 두면 refetch 시그니처가 충돌한다 — 필요한 두
  // 값(진행중 여부 / 새로고침)만 뽑아 쓴다.
  const activeQuery = effectiveView === 'metrics' ? values
    : effectiveView === 'rules' ? rules
      : effectiveView === 'targets' ? targets
        : activeAlerts;
  const isFetching = activeQuery.isFetching;
  const refetchActive = () => { void activeQuery.refetch(); };

  const source: DataSource = (values.data?.source ?? rules.data?.source
    ?? targets.data?.source ?? activeAlerts.data?.source ?? 'offline');
  const collectedAt = values.data?.collectedAt ?? rules.data?.collectedAt
    ?? targets.data?.collectedAt ?? activeAlerts.data?.collectedAt ?? null;
  const detail = (effectiveView === 'metrics' ? values.data?.detail
    : effectiveView === 'rules' ? rules.data?.detail
      : effectiveView === 'targets' ? targets.data?.detail
        : activeAlerts.data?.detail) ?? null;

  const openEditor = (metricId: string | null) => {
    setEditingId(metricId);
    setEditorOpen(true);
  };

  return (
    <div className="min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => selectCluster(id)}
          iconOnly
        />

        <div className="flex-1 min-w-0 space-y-3">
          {/* 모듈 탭 — 지표가 등록된 모듈만 활성, 나머지는 '준비중' */}
          <MacCard title="Observability 모듈">
            <div className="flex flex-wrap items-center gap-2">
              {modulesLoading ? (
                <span className="text-sm text-muted-foreground">모듈을 불러오는 중…</span>
              ) : modules.length === 0 ? (
                <span className="text-sm text-muted-foreground">등록된 모듈이 없습니다.</span>
              ) : (
                modules.map((mod) => {
                  const planned = mod.status !== 'active';
                  return (
                    <button
                      key={mod.key}
                      type="button"
                      disabled={planned}
                      onClick={() => setModuleKey(mod.key)}
                      title={planned
                        ? `${mod.label} — 아직 등록된 지표가 없습니다. 지표를 추가하면 활성화됩니다.`
                        : mod.description ?? mod.label}
                      className={`${pill(mod.key === moduleKey)} ${
                        planned ? 'opacity-50 cursor-not-allowed' : ''
                      }`}
                    >
                      {mod.label}
                      <span className="ml-1.5 text-xs opacity-70">
                        {planned ? '준비중' : mod.metricCount}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            {activeModule?.description ? (
              <p className="mt-3 text-xs text-muted-foreground">{activeModule.description}</p>
            ) : null}
          </MacCard>

          <MacCard title={activeModule?.label ?? moduleKey} bodyPadding="p-0">
            {/* 툴바 — 뷰 탭 · 필터 · 신선도 · 새로고침 */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
              <div className="flex flex-wrap items-center gap-1">
                {VIEW_TABS.map((tab) => {
                  const disabled = !isPromModule && tab.value !== 'metrics';
                  return (
                    <button
                      key={tab.value}
                      type="button"
                      disabled={disabled}
                      onClick={() => setView(tab.value)}
                      title={disabled ? 'kube-prometheus-stack 모듈에서만 제공됩니다.' : undefined}
                      className={`${pill(effectiveView === tab.value)} ${
                        disabled ? 'opacity-40 cursor-not-allowed' : ''
                      }`}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <SourceBadge source={source} collectedAt={collectedAt} />
                {canEdit && effectiveView === 'metrics' ? (
                  <button
                    type="button"
                    onClick={() => openEditor(null)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" aria-hidden /> 지표 추가
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={refetchActive}
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

            {/* 뷰별 보조 필터 + 요약 */}
            <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-border bg-muted/10">
              {effectiveView === 'metrics' ? (
                <>
                  <SearchInput value={metricQuery} onChange={setMetricQuery} placeholder="지표 · PromQL 검색" />
                  <div className="flex items-center gap-2 text-xs">
                    <Chip tone="healthy" label="정상" count={summary.ok} />
                    <Chip tone="warning" label="경고" count={summary.warning} />
                    <Chip tone="critical" label="심각" count={summary.critical} />
                    <Chip tone="muted" label="수집불가" count={summary.unavailable} />
                  </div>
                </>
              ) : null}

              {effectiveView === 'rules' ? (
                <>
                  <SearchInput value={ruleQuery} onChange={setRuleQuery} placeholder="규칙명 · 표현식 검색" />
                  <FilterGroup
                    options={RULE_STATES}
                    value={ruleState}
                    onChange={setRuleState}
                    labels={{ all: '전체' }}
                  />
                  <span className="ml-auto text-xs text-muted-foreground">
                    {rules.data?.rules.length ?? 0}건
                  </span>
                </>
              ) : null}

              {effectiveView === 'targets' ? (
                <>
                  <FilterGroup
                    options={TARGET_HEALTH}
                    value={targetHealth}
                    onChange={setTargetHealth}
                    labels={{ all: '전체' }}
                  />
                  <span className="ml-auto text-xs text-muted-foreground">
                    {targets.data?.targets.length ?? 0}건
                  </span>
                </>
              ) : null}

              {effectiveView === 'alerts' ? (
                <span className="ml-auto text-xs text-muted-foreground">
                  {activeAlerts.data?.alerts.length ?? 0}건 발화/대기 중
                </span>
              ) : null}
            </div>

            {detail ? (
              <p className="px-4 py-2 text-xs text-[hsl(var(--status-warning))] border-b border-border">
                {detail}
              </p>
            ) : null}

            {!hasCluster ? (
              <p className="px-4 py-12 text-center text-sm text-muted-foreground">
                왼쪽에서 클러스터를 선택하세요.
              </p>
            ) : effectiveView === 'metrics' ? (
              <MetricsTable
                rows={metricRows}
                isLoading={values.isLoading}
                emptyMessage={metricQuery ? '검색과 일치하는 지표가 없습니다.' : undefined}
                onEdit={canEdit ? openEditor : undefined}
              />
            ) : effectiveView === 'rules' ? (
              <RulesTable rows={rules.data?.rules ?? []} isLoading={rules.isLoading} />
            ) : effectiveView === 'targets' ? (
              <TargetsTable rows={targets.data?.targets ?? []} isLoading={targets.isLoading} />
            ) : (
              <ActiveAlertsTable rows={activeAlerts.data?.alerts ?? []} isLoading={activeAlerts.isLoading} />
            )}
          </MacCard>
        </div>
      </div>

      <MetricEditModal
        isOpen={editorOpen}
        onClose={() => { setEditorOpen(false); setEditingId(null); }}
        moduleKey={moduleKey}
        editing={editingMetric}
      />
    </div>
  );
}

function SearchInput({ value, onChange, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-8 pr-3 py-1.5 w-56 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
    </div>
  );
}

function FilterGroup({ options, value, onChange, labels }: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  labels?: Record<string, string>;
}) {
  return (
    <div className="flex items-center gap-1">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`px-2.5 py-1 rounded-xl text-xs transition-colors ${
            value === opt
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
          }`}
        >
          {labels?.[opt] ?? opt}
        </button>
      ))}
    </div>
  );
}

// Tailwind JIT 는 클래스명을 정적으로 스캔하므로 템플릿 리터럴로 조립하면 안 된다 — 고정 맵.
const CHIP_CLS: Record<'healthy' | 'warning' | 'critical' | 'muted', string> = {
  healthy: 'text-[hsl(var(--status-healthy))] border-[hsl(var(--status-healthy)/0.35)]',
  warning: 'text-[hsl(var(--status-warning))] border-[hsl(var(--status-warning)/0.35)]',
  critical: 'text-[hsl(var(--status-critical))] border-[hsl(var(--status-critical)/0.35)]',
  muted: 'text-muted-foreground border-border',
};

function Chip({ tone, label, count }: {
  tone: 'healthy' | 'warning' | 'critical' | 'muted';
  label: string;
  count: number;
}) {
  return (
    <span className={`px-2 py-0.5 rounded-xl border ${CHIP_CLS[tone]}`}>
      {label} {count}
    </span>
  );
}
