import { MetricCard as MetricCardType, MetricQueryResult } from '@/types';
import { ExternalLink, Trash2, AlertTriangle, WifiOff, Pencil, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMetricSparkline } from '@/hooks/useMetricCards';
import { Sparkline } from '@/components/ui/Sparkline';

interface MetricCardProps {
  card: MetricCardType;
  result?: MetricQueryResult;
  onDelete?: () => void;
  onEdit?: () => void;
}

// ── Threshold parser ─────────────────────────────────────
function parseThresholds(thresholds?: string): { warning: number; critical: number } | null {
  if (!thresholds) return null;
  const parts = thresholds.split(',');
  let warning = Infinity;
  let critical = Infinity;
  for (const part of parts) {
    const [level, val] = part.trim().split(':');
    if (level === 'warning') warning = parseFloat(val);
    if (level === 'critical') critical = parseFloat(val);
  }
  return { warning, critical };
}

function getThresholdColor(value: number | null | undefined, thresholds?: string): string {
  if (value == null) return 'text-muted-foreground';
  const t = parseThresholds(thresholds);
  if (!t) return 'text-foreground';
  if (value >= t.critical) return 'text-status-critical';
  if (value >= t.warning) return 'text-status-warning';
  return 'text-status-healthy';
}

function getThresholdBgColor(value: number | null | undefined, thresholds?: string): string {
  if (value == null) return 'bg-secondary';
  const t = parseThresholds(thresholds);
  if (!t) return 'bg-primary';
  if (value >= t.critical) return 'bg-status-critical';
  if (value >= t.warning) return 'bg-status-warning';
  return 'bg-status-healthy';
}

/** Sparkline stroke 는 Tailwind class 가 아니라 실제 CSS color 값이 필요 — getThresholdColor 와
 *  같은 판정 로직을 hsl(var(--status-*)) 문자열로 반환. */
function getThresholdStrokeColor(value: number | null | undefined, thresholds?: string): string {
  if (value == null) return 'hsl(var(--muted-foreground))';
  const t = parseThresholds(thresholds);
  if (!t) return 'hsl(var(--foreground))';
  if (value >= t.critical) return 'hsl(var(--status-critical))';
  if (value >= t.warning) return 'hsl(var(--status-warning))';
  return 'hsl(var(--status-healthy))';
}

// ── Format value ─────────────────────────────────────────
function formatValue(value: number | null | undefined, unit: string): string {
  if (value == null) return '—';
  if (unit === '%') return `${value.toFixed(1)}%`;
  if (unit === 'bytes/s') {
    if (value > 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB/s`;
    if (value > 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB/s`;
    if (value > 1024) return `${(value / 1024).toFixed(1)} KB/s`;
    return `${value.toFixed(0)} B/s`;
  }
  if (unit === 'bytes') {
    if (value > 1_073_741_824) return `${(value / 1_073_741_824).toFixed(1)} GB`;
    if (value > 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
    return `${value.toFixed(0)} B`;
  }
  if (unit === 'count') return value.toFixed(0);
  return value.toFixed(2);
}

// ── Gauge display ────────────────────────────────────────
function GaugeDisplay({ value, thresholds, unit }: { value: number | null | undefined; thresholds?: string; unit: string }) {
  const pct = Math.min(Math.max(value ?? 0, 0), 100);
  const color = getThresholdBgColor(value, thresholds);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className={`text-2xl font-bold font-mono ${getThresholdColor(value, thresholds)}`}>
          {formatValue(value, unit)}
        </span>
      </div>
      <div className="w-full bg-secondary rounded-full h-2">
        <div
          className={`h-2 rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Value display ────────────────────────────────────────
function ValueDisplay({ value, thresholds, unit }: { value: number | null | undefined; thresholds?: string; unit: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className={`text-3xl font-bold font-mono ${getThresholdColor(value, thresholds)}`}>
        {formatValue(value, unit)}
      </span>
    </div>
  );
}

// ── List display ─────────────────────────────────────────
function ListDisplay({ results }: { results?: Array<Record<string, unknown>> | null }) {
  if (!results || results.length === 0) {
    return <span className="text-sm text-status-healthy font-mono">None detected</span>;
  }

  return (
    <div className="space-y-1 max-h-28 overflow-y-auto">
      {results.slice(0, 5).map((item, i) => {
        const labels = (item.labels || {}) as Record<string, string>;
        const val = item.value as number;
        const name = labels.persistentvolumeclaim || labels.namespace || labels.pod || `item-${i}`;
        return (
          <div key={i} className="flex items-center justify-between text-sm font-mono">
            <span className="text-muted-foreground truncate max-w-[160px]">{name}</span>
            <span className="text-status-warning">{typeof val === 'number' ? `${val.toFixed(1)}%` : String(val)}</span>
          </div>
        );
      })}
      {results.length > 5 && (
        <span className="text-sm text-muted-foreground">+{results.length - 5} more</span>
      )}
    </div>
  );
}

// ── Status overlay ───────────────────────────────────────
/** 에러 메시지에서 자주 발생하는 패턴을 감지해 사용자에게 친숙한 힌트 한 줄 추가.
 *  대부분의 etcd / 기타 모듈 카드 에러는 "Prometheus 에 해당 메트릭이 없음" 으로 귀결되므로
 *  단순히 "Query error" 만 보여주면 사용자가 문제 원인을 모른다.
 */
function errorHint(error?: string | null): string | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (e.includes('parse') || e.includes('syntax') || e.includes('unexpected'))
    return '쿼리 문법 오류 — 카드를 편집해 PromQL 을 점검하세요.';
  if (e.includes('unknown function')) return 'PromQL 함수명을 확인하세요 (예: sum, rate, histogram_quantile).';
  if (e.includes('not found') || e.includes('no such') || e.includes('metric'))
    return 'Prometheus 에 해당 메트릭이 없습니다 — exporter (kube-state-metrics, etcd-exporter) 가 켜져 있는지 확인하세요.';
  if (e.includes('empty') || e === 'no data' || e.includes('empty result'))
    return '결과가 비어있습니다 — 라벨/조건이 너무 좁거나 메트릭이 0 일 수 있어요.';
  if (e.includes('timeout')) return 'Prometheus 응답이 늦습니다 — 쿼리 시간 범위를 줄여보세요.';
  return null;
}

function StatusOverlay({
  result,
  promql,
  onEdit,
  onRefresh,
}: {
  result?: MetricQueryResult;
  promql?: string;
  onEdit?: () => void;
  onRefresh?: () => void;
}) {
  if (!result) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className="w-2 h-2 rounded-full bg-muted-foreground animate-pulse" />
        Loading...
      </div>
    );
  }
  if (result.status === 'offline') {
    return (
      <div className="flex items-start gap-1.5 text-sm text-status-warning">
        <WifiOff className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <div className="space-y-0.5">
          <p className="font-medium">Prometheus offline</p>
          {result.error && <p className="text-xs text-status-warning/80">{result.error}</p>}
          {onRefresh && (
            <button
              onClick={(e) => { e.stopPropagation(); onRefresh(); }}
              className="text-xs text-status-warning hover:underline inline-flex items-center gap-0.5"
            >
              <RefreshCw className="w-2.5 h-2.5" /> 다시 시도
            </button>
          )}
        </div>
      </div>
    );
  }
  if (result.status === 'error') {
    const hint = errorHint(result.error);
    return (
      <div className="flex items-start gap-1.5 text-sm text-status-critical">
        <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <div className="space-y-0.5 min-w-0 flex-1">
          <p className="font-medium break-words">{result.error || 'Query error'}</p>
          {hint && <p className="text-xs text-status-critical/80">{hint}</p>}
          {promql && (
            <code className="block text-xs font-mono text-muted-foreground/80 break-all max-h-12 overflow-hidden">
              {promql}
            </code>
          )}
          <div className="flex items-center gap-2 pt-1">
            {onRefresh && (
              <button
                onClick={(e) => { e.stopPropagation(); onRefresh(); }}
                className="text-xs text-status-critical/80 hover:text-status-critical inline-flex items-center gap-0.5"
              >
                <RefreshCw className="w-2.5 h-2.5" /> 재시도
              </button>
            )}
            {onEdit && (
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                className="text-xs text-primary/80 hover:text-primary inline-flex items-center gap-0.5"
              >
                <Pencil className="w-2.5 h-2.5" /> 카드 편집
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  return null;
}

// ── Main Card ────────────────────────────────────────────
export function MetricCard({ card, result, onDelete, onEdit }: MetricCardProps) {
  const hasError = result && result.status !== 'ok';
  const queryClient = useQueryClient();
  // 사용자가 "재시도" 를 누르면 metric 결과 캐시 무효화 → 백그라운드 refetch.
  const handleRefresh = () => queryClient.invalidateQueries({ queryKey: ['metricResults'] });

  // Sparkline — value/gauge 카드만, 정상 조회된 상태에서만 (list 카드/에러 카드는 의미 없음).
  const showSparkline = !hasError && result && card.displayType !== 'list';
  const { data: sparkline } = useMetricSparkline(card.id, showSparkline);

  return (
    <div className="bg-card border border-border rounded-xl p-5 hover:border-muted-foreground/30 transition-all hover:-translate-y-0.5 relative group">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="w-11 h-11 rounded-lg bg-secondary flex items-center justify-center text-xl">
          {card.icon}
        </div>
        <div className="flex items-center gap-1.5">
          {card.grafanaPanelUrl && (
            <a
              href={card.grafanaPanelUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 hover:bg-secondary rounded-lg transition-colors opacity-0 group-hover:opacity-100"
              title="Open in Grafana"
            >
              <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
            </a>
          )}
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-1.5 hover:bg-status-critical/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
              title="Delete card"
              aria-label="Delete card"
            >
              <Trash2 className="w-3.5 h-3.5 text-status-critical" />
            </button>
          )}
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="p-1.5 hover:bg-primary/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
              title="Edit card"
              aria-label="Edit card"
            >
              <Pencil className="w-3.5 h-3.5 text-primary" />
            </button>
          )}
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-secondary text-muted-foreground uppercase tracking-wider">
            {card.category}
          </span>
        </div>
      </div>

      {/* Title */}
      <h3 className="text-base font-semibold mb-1">{card.title}</h3>
      {card.description && (
        <p className="text-sm text-muted-foreground mb-4">{card.description}</p>
      )}

      {/* Content */}
      <div className="pt-4 border-t border-border">
        {hasError ? (
          <StatusOverlay
            result={result}
            promql={card.promql}
            onEdit={onEdit}
            onRefresh={handleRefresh}
          />
        ) : !result ? (
          <StatusOverlay />
        ) : card.displayType === 'gauge' ? (
          <GaugeDisplay value={result.value} thresholds={card.thresholds} unit={card.unit} />
        ) : card.displayType === 'list' ? (
          <ListDisplay results={result.results} />
        ) : (
          <ValueDisplay value={result.value} thresholds={card.thresholds} unit={card.unit} />
        )}
        {showSparkline && sparkline?.status === 'ok' && sparkline.points.length >= 2 && (
          <Sparkline
            points={sparkline.points}
            color={getThresholdStrokeColor(result.value, card.thresholds)}
            className="mt-2"
          />
        )}
      </div>

      {/* PromQL hint */}
      <div className="mt-3 text-xs text-muted-foreground/50 font-mono truncate" title={card.promql}>
        {card.promql}
      </div>
    </div>
  );
}
