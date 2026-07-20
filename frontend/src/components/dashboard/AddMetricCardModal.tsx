import { useEffect, useId, useMemo, useState } from 'react';
import { X, FlaskConical, CheckCircle2, AlertTriangle, BookOpen, ChevronDown, ChevronUp } from 'lucide-react';
import { useCreateMetricCard, useTestPromql, useUpdateMetricCard } from '@/hooks/useMetricCards';
import { MetricCard } from '@/types';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';

interface AddMetricCardModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingCard?: MetricCard | null;
}

const CATEGORY_OPTIONS = [
  { value: 'alert', label: 'Alert', icon: '🚨' },
  { value: 'resource', label: 'Resource', icon: '⚡' },
  { value: 'storage', label: 'Storage', icon: '💾' },
  { value: 'network', label: 'Network', icon: '🌐' },
  { value: 'general', label: 'General', icon: '📊' },
];

const DISPLAY_TYPES = [
  { value: 'value', label: 'Single Value', description: 'Large number display' },
  { value: 'gauge', label: 'Gauge Bar', description: 'Progress bar with percentage' },
  { value: 'list', label: 'List', description: 'Multiple results as table' },
];

const UNIT_OPTIONS = ['', '%', 'count', 'bytes', 'bytes/s', 'ms', 'req/s'];

interface PromqlTemplate {
  label: string;
  promql: string;
  unit: string;
  displayType: string;
  category: string;
  /** 이 메트릭이 어떤 exporter 에서 노출되는지 — 사용자에게 사전 점검을 알려주기 위함. */
  source?: string;
  /** 추천 thresholds 가 있으면 자동 채움. 사용자가 편집 가능. */
  thresholds?: string;
  group?: string;
}

const PROMQL_TEMPLATES: PromqlTemplate[] = [
  // ── General K8s ───────────────────────────────────────
  {
    group: 'k8s',
    label: 'Pod restart count (last 1h)',
    promql: 'sum(increase(kube_pod_container_status_restarts_total[1h])) by (pod, namespace)',
    unit: 'count',
    displayType: 'list',
    category: 'alert',
    source: 'kube-state-metrics',
  },
  {
    group: 'k8s',
    label: 'Node not ready count',
    promql: 'sum(kube_node_status_condition{condition="Ready",status="false"}) OR on() vector(0)',
    unit: 'count',
    displayType: 'value',
    category: 'alert',
    source: 'kube-state-metrics',
  },
  {
    group: 'k8s',
    label: 'API Server request latency (p99)',
    promql: 'histogram_quantile(0.99, sum(rate(apiserver_request_duration_seconds_bucket[5m])) by (le)) * 1000',
    unit: 'ms',
    displayType: 'value',
    category: 'resource',
    source: 'kube-apiserver',
    thresholds: 'warning:300,critical:1000',
  },
  {
    group: 'k8s',
    label: 'Pending pods count',
    promql: 'sum(kube_pod_status_phase{phase="Pending"}) OR on() vector(0)',
    unit: 'count',
    displayType: 'value',
    category: 'alert',
    source: 'kube-state-metrics',
  },
  // ── etcd ────────────────────────────────────────────
  // 자주 발생하는 "etcd 카드 에러" 의 원인은 보통 (a) 메트릭 이름이 틀림
  // (b) Prometheus 가 etcd /metrics 를 스크랩하지 않음. 아래 템플릿은 정상적인 metric 이름 + scrape 검증용.
  {
    group: 'etcd',
    label: 'etcd has leader',
    promql: 'min(etcd_server_has_leader) OR on() vector(0)',
    unit: 'count',
    displayType: 'value',
    category: 'alert',
    source: 'etcd /metrics (kube-system 의 etcd ServiceMonitor 필요)',
    thresholds: 'warning:0.5,critical:0.5',
  },
  {
    group: 'etcd',
    label: 'etcd leader changes (last 1h)',
    promql: 'sum(rate(etcd_server_leader_changes_seen_total[1h])) * 3600',
    unit: 'count',
    displayType: 'value',
    category: 'alert',
    source: 'etcd /metrics',
    thresholds: 'warning:1,critical:5',
  },
  {
    group: 'etcd',
    label: 'etcd proposal failures (last 1h)',
    promql: 'sum(increase(etcd_server_proposals_failed_total[1h]))',
    unit: 'count',
    displayType: 'value',
    category: 'alert',
    source: 'etcd /metrics',
    thresholds: 'warning:1,critical:10',
  },
  {
    group: 'etcd',
    label: 'etcd disk WAL fsync p99 (ms)',
    promql: 'histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])) * 1000',
    unit: 'ms',
    displayType: 'value',
    category: 'resource',
    source: 'etcd /metrics',
    thresholds: 'warning:50,critical:100',
  },
  {
    group: 'etcd',
    label: 'etcd backend commit p99 (ms)',
    promql: 'histogram_quantile(0.99, rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])) * 1000',
    unit: 'ms',
    displayType: 'value',
    category: 'resource',
    source: 'etcd /metrics',
    thresholds: 'warning:25,critical:100',
  },
  {
    group: 'etcd',
    label: 'etcd DB size (bytes)',
    promql: 'max(etcd_mvcc_db_total_size_in_bytes)',
    unit: 'bytes',
    displayType: 'value',
    category: 'storage',
    source: 'etcd /metrics',
  },
];

export function AddMetricCardModal({ isOpen, onClose, editingCard }: AddMetricCardModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('📊');
  const [promql, setPromql] = useState('');
  const [unit, setUnit] = useState('');
  const [displayType, setDisplayType] = useState('value');
  const [category, setCategory] = useState('general');
  const [thresholds, setThresholds] = useState('');
  const [grafanaPanelUrl, setGrafanaPanelUrl] = useState('');

  const titleId = useId();
  const iconId = useId();
  const descId = useId();
  const promqlId = useId();
  const categoryId = useId();
  const displayTypeId = useId();
  const unitId = useId();
  const thresholdsId = useId();
  const grafanaUrlId = useId();

  const [testStatus, setTestStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [testResult, setTestResult] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const toast = useToast();
  const createCard = useCreateMetricCard();
  const updateCard = useUpdateMetricCard();
  const testQuery = useTestPromql();

  const isEditMode = !!editingCard;
  const [showGuide, setShowGuide] = useState(false);

  // 그룹별 템플릿 묶음 (k8s / etcd / …) — 그룹마다 헤더로 구분.
  const groupedTemplates = useMemo(() => {
    const m = new Map<string, PromqlTemplate[]>();
    for (const tpl of PROMQL_TEMPLATES) {
      const g = tpl.group || 'general';
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(tpl);
    }
    const order = ['k8s', 'etcd', 'general'];
    return order
      .filter((g) => m.has(g))
      .map((g) => ({ group: g, items: m.get(g)! }));
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    if (editingCard) {
      setTitle(editingCard.title);
      setDescription(editingCard.description || '');
      setIcon(editingCard.icon);
      setPromql(editingCard.promql);
      setUnit(editingCard.unit || '');
      setDisplayType(editingCard.displayType);
      setCategory(editingCard.category);
      setThresholds(editingCard.thresholds || '');
      setGrafanaPanelUrl(editingCard.grafanaPanelUrl || '');
      setTestStatus('idle');
      setTestResult('');
      return;
    }

    resetForm();
  }, [isOpen, editingCard]);

  if (!isOpen) return null;

  const handleTest = async () => {
    if (!promql.trim()) return;
    setTestStatus('loading');
    try {
      const { data } = await testQuery.mutateAsync(promql);
      const d = data as unknown as Record<string, unknown>;
      if (d.status === 'ok') {
        setTestStatus('ok');
        const val = d.value != null ? String(d.value) : 'vector result';
        setTestResult(`Result: ${val}`);
      } else {
        setTestStatus('error');
        setTestResult(String(d.error || 'Query failed'));
      }
    } catch {
      setTestStatus('error');
      setTestResult('Failed to reach Prometheus');
    }
  };

  const handleSave = async () => {
    if (!title.trim() || !promql.trim()) return;

    const payload = {
      title: title.trim(),
      description: description.trim() || undefined,
      icon,
      promql: promql.trim(),
      unit,
      displayType: displayType as 'value' | 'gauge' | 'list',
      category,
      thresholds: thresholds.trim() || undefined,
      grafanaPanelUrl: grafanaPanelUrl.trim() || undefined,
      sortOrder: editingCard?.sortOrder ?? 99,
      enabled: editingCard?.enabled ?? true,
    };

    setSaving(true);
    try {
      if (editingCard) {
        await updateCard.mutateAsync({ id: editingCard.id, data: payload });
      } else {
        await createCard.mutateAsync(payload);
      }
      // 성공했을 때만 폼 리셋 + 모달 닫기 — 실패 시 입력값을 보존해 재시도 가능하게 한다.
      resetForm();
      onClose();
    } catch (err) {
      toast.error(
        editingCard ? '카드 수정 실패' : '카드 생성 실패',
        formatApiError(err, '저장 중 오류가 발생했습니다.'),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleTemplateSelect = (tpl: PromqlTemplate) => {
    setPromql(tpl.promql);
    setUnit(tpl.unit);
    setDisplayType(tpl.displayType);
    setCategory(tpl.category);
    if (tpl.thresholds && !thresholds) setThresholds(tpl.thresholds);
    if (!title) setTitle(tpl.label);
    setTestStatus('idle');
    setTestResult('');
  };


  const resetForm = () => {
    setTitle('');
    setDescription('');
    setIcon('📊');
    setPromql('');
    setUnit('');
    setDisplayType('value');
    setCategory('general');
    setThresholds('');
    setGrafanaPanelUrl('');
    setTestStatus('idle');
    setTestResult('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10">
          <h2 className="text-lg font-semibold">{isEditMode ? 'Edit Metric Card' : 'Add Metric Card'}</h2>
          <button onClick={onClose} aria-label="닫기" className="p-1 hover:bg-secondary rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* 가이드 / Help — 첫 사용자가 PromQL 카드 만드는 법을 빠르게 익히기 위함. */}
          <div className="rounded-lg border border-border bg-muted/30 overflow-hidden">
            <button
              onClick={() => setShowGuide((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold hover:bg-muted/50 transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5 text-primary" />
                커스텀 카드 등록 가이드 (처음이라면 펼쳐 읽어보세요)
              </span>
              {showGuide
                ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
                : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
            </button>
            {showGuide && (
              <div className="px-4 pb-3 pt-1 text-xs text-muted-foreground leading-relaxed space-y-2 border-t border-border">
                <p>
                  대시보드의 카드는 모두 <b className="text-foreground">PromQL</b> 한 줄로 정의됩니다.
                  Prometheus 가 이미 스크랩하고 있는 메트릭을 자유롭게 조합하세요.
                </p>
                <div>
                  <p className="text-foreground/90 font-semibold mb-1">필드 설명</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li><b>Title</b>: 카드 헤더에 보일 이름. (예: <i>etcd has leader</i>)</li>
                    <li><b>PromQL Query</b>: 단일 표현식. <span className="font-mono">OR on() vector(0)</span> 으로 비어있을 때 0 fallback 권장.</li>
                    <li><b>Display Type</b>:
                      <span className="font-mono"> value</span> = 큰 숫자 ·
                      <span className="font-mono"> gauge</span> = 0~100% 게이지 ·
                      <span className="font-mono"> list</span> = 여러 시리즈를 표 형태로
                    </li>
                    <li><b>Unit</b>: 숫자 포맷팅. <span className="font-mono">%</span>/<span className="font-mono">bytes</span>/<span className="font-mono">ms</span>/<span className="font-mono">count</span> 등.</li>
                    <li><b>Thresholds</b>: <span className="font-mono">warning:80,critical:95</span> — 색상 자동 (녹/황/적).</li>
                  </ul>
                </div>
                <div>
                  <p className="text-foreground/90 font-semibold mb-1">자주 발생하는 에러</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li><b>"empty result"</b> = 메트릭은 있지만 라벨/조건과 매치 안 됨. <span className="font-mono">OR on() vector(0)</span> 으로 가드.</li>
                    <li><b>"metric not found"</b> = exporter 가 안 켜짐. 예: <i>etcd_*</i> 는 etcd /metrics 가 Prometheus 에 등록돼야 합니다.</li>
                    <li><b>parse error / unexpected</b> = PromQL 문법. <i>Test Query</i> 버튼으로 즉시 검증 가능.</li>
                  </ul>
                </div>
                <div>
                  <p className="text-foreground/90 font-semibold mb-1">정상 동작 검증 절차</p>
                  <ol className="list-decimal pl-4 space-y-0.5">
                    <li>아래 <b>Quick Templates</b> 에서 비슷한 카드 골라 자동 채움.</li>
                    <li>필요시 라벨/조건 수정.</li>
                    <li><b>Test Query</b> 클릭 → 결과 / 에러 즉시 확인.</li>
                    <li>이상 없으면 <b>Create Card</b> 클릭.</li>
                  </ol>
                </div>
              </div>
            )}
          </div>

          <div>
            <p className="block text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Quick Templates
            </p>
            <div className="space-y-3">
              {groupedTemplates.map(({ group, items }) => (
                <div key={group}>
                  <p className="text-xs font-mono uppercase text-muted-foreground/70 mb-1">
                    {group === 'k8s' ? 'Kubernetes / API server' : group === 'etcd' ? 'etcd' : 'General'}
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {items.map((tpl) => (
                      <button
                        key={tpl.label}
                        onClick={() => handleTemplateSelect(tpl)}
                        title={tpl.source ? `필요 exporter: ${tpl.source}` : undefined}
                        className="text-left p-2.5 rounded-lg border border-border hover:border-primary/40 hover:bg-primary/5 transition-all"
                      >
                        <div className="text-sm font-medium">{tpl.label}</div>
                        <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">{tpl.promql}</div>
                        {tpl.source && (
                          <div className="text-xs text-muted-foreground/70 mt-0.5">
                            <span className="opacity-70">출처:</span> {tpl.source}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-[1fr_80px] gap-3">
            <div>
              <label htmlFor={titleId} className="block text-sm font-medium mb-1">
                Title <span className="text-red-400">*</span>
              </label>
              <input
                id={titleId}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Cluster CPU Usage"
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label htmlFor={iconId} className="block text-sm font-medium mb-1">Icon</label>
              <input
                id={iconId}
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          <div>
            <label htmlFor={descId} className="block text-sm font-medium mb-1">Description</label>
            <input
              id={descId}
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short explanation of what this metric shows"
              className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          <div>
            <label htmlFor={promqlId} className="block text-sm font-medium mb-1">
              PromQL Query <span className="text-red-400">*</span>
            </label>
            <textarea
              id={promqlId}
              value={promql}
              onChange={(e) => { setPromql(e.target.value); setTestStatus('idle'); }}
              placeholder='e.g. sum(kube_pod_status_phase{phase="Failed"}) OR on() vector(0)'
              rows={3}
              className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
            />
            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={handleTest}
                disabled={!promql.trim() || testStatus === 'loading'}
                className="px-3 py-1.5 text-sm font-medium bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-40"
              >
                <FlaskConical className="w-3 h-3" />
                {testStatus === 'loading' ? 'Testing...' : 'Test Query'}
              </button>
              {testStatus === 'ok' && (
                <span className="text-sm text-green-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> {testResult}
                </span>
              )}
              {testStatus === 'error' && (
                <span className="text-sm text-red-400 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> {testResult}
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor={categoryId} className="block text-sm font-medium mb-1">Category</label>
              <select
                id={categoryId}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.icon} {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={displayTypeId} className="block text-sm font-medium mb-1">Display Type</label>
              <select
                id={displayTypeId}
                value={displayType}
                onChange={(e) => setDisplayType(e.target.value)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {DISPLAY_TYPES.map((dt) => (
                  <option key={dt.value} value={dt.value}>{dt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={unitId} className="block text-sm font-medium mb-1">Unit</label>
              <select
                id={unitId}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {UNIT_OPTIONS.map((u) => (
                  <option key={u} value={u}>{u || '(none)'}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor={thresholdsId} className="block text-sm font-medium mb-1">
              Thresholds <span className="text-sm text-muted-foreground">(optional)</span>
            </label>
            <input
              id={thresholdsId}
              type="text"
              value={thresholds}
              onChange={(e) => setThresholds(e.target.value)}
              placeholder="warning:70,critical:90"
              className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Color thresholds: green → warning → critical (red)
            </p>
          </div>

          <div>
            <label htmlFor={grafanaUrlId} className="block text-sm font-medium mb-1">
              Grafana Panel URL <span className="text-sm text-muted-foreground">(optional)</span>
            </label>
            <input
              id={grafanaUrlId}
              type="text"
              value={grafanaPanelUrl}
              onChange={(e) => setGrafanaPanelUrl(e.target.value)}
              placeholder="http://grafana.monitoring.svc:3000/d/..."
              className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => { resetForm(); onClose(); }}
              className="flex-1 px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!title.trim() || !promql.trim() || saving}
              className="flex-1 px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-40"
            >
              {saving ? 'Saving...' : isEditMode ? 'Save Changes' : 'Create Card'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
