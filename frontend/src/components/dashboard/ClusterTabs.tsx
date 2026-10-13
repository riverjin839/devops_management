import { cn } from '@/lib/utils';
import { Cluster } from '@/types';
import { StatusDot, statusToVariant } from '@/components/common/StatusBadge';

interface ClusterTabsProps {
  clusters: Cluster[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export function ClusterTabs({ clusters, selectedId, onSelect }: ClusterTabsProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        onClick={() => onSelect(null)}
        className={cn(
          'px-4 py-2 rounded-lg text-sm font-medium transition-all',
          selectedId === null
            ? 'bg-primary text-primary-foreground'
            : 'bg-transparent border border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
        )}
      >
        All
      </button>
      {clusters.map((cluster) => (
        <button
          key={cluster.id}
          onClick={() => onSelect(cluster.id)}
          className={cn(
            'px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2',
            selectedId === cluster.id
              ? 'bg-primary text-primary-foreground'
              : 'bg-transparent border border-border text-muted-foreground hover:text-foreground hover:bg-secondary'
          )}
        >
          <StatusDot variant={statusToVariant(cluster.status)} />
          {cluster.name}
        </button>
      ))}
    </div>
  );
}
