import { Server, CheckCircle2, AlertTriangle, XCircle, Cpu } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useClusterStore } from '@/stores/clusterStore';
import { useDailyCheckSummary } from '@/hooks/useDailyCheck';

export function InfraHealthBar() {
  const { clusters } = useClusterStore();
  const { data: summary = [] } = useDailyCheckSummary();

  const healthy  = clusters.filter((c) => c.status === 'healthy').length;
  const warning  = clusters.filter((c) => c.status === 'warning').length;
  const critical = clusters.filter((c) => c.status === 'critical').length;

  const totalNodes = summary.reduce(
    (acc, s) => acc + (s.latest_check?.total_nodes ?? 0), 0,
  );
  const readyNodes = summary.reduce(
    (acc, s) => acc + (s.latest_check?.ready_nodes ?? 0), 0,
  );

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-card/80 border-b border-border flex-wrap">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1">
        인프라 현황
      </span>

      <Link
        to="/cluster-overview"
        className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-background border border-border hover:border-primary/40 transition-colors text-xs"
      >
        <Server className="w-3 h-3 text-muted-foreground" />
        <span className="text-muted-foreground">클러스터</span>
        <span className="font-semibold tabular-nums">{clusters.length}</span>
      </Link>

      {healthy > 0 && (
        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
          <CheckCircle2 className="w-3 h-3" />
          <span className="tabular-nums">{healthy}</span>
          <span className="text-muted-foreground">정상</span>
        </span>
      )}
      {warning > 0 && (
        <Link
          to="/cluster-overview"
          className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:underline"
        >
          <AlertTriangle className="w-3 h-3" />
          <span className="tabular-nums">{warning}</span>
          <span>경고</span>
        </Link>
      )}
      {critical > 0 && (
        <Link
          to="/cluster-overview"
          className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400 hover:underline"
        >
          <XCircle className="w-3 h-3" />
          <span className="tabular-nums">{critical}</span>
          <span>위험</span>
        </Link>
      )}

      {totalNodes > 0 && (
        <Link
          to="/node-specs"
          className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-background border border-border hover:border-primary/40 transition-colors text-xs ml-1"
        >
          <Cpu className="w-3 h-3 text-muted-foreground" />
          <span className="text-muted-foreground">노드</span>
          <span className="font-semibold tabular-nums">{readyNodes}/{totalNodes}</span>
        </Link>
      )}
    </div>
  );
}
