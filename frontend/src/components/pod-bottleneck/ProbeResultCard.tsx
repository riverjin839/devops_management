import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { LogViewer } from '@/components/common';
import { ProbeAxisBadge } from './ProbeAxisBadge';
import { BOTTLENECK_STATUS_META as STATUS_META } from './statusMeta';
import type { ProbeResultOut } from '@/types';

interface ProbeResultCardProps {
  probeKey: string;
  label: string;
  axis: string;
  result: ProbeResultOut;
}

export function ProbeResultCard({ probeKey, label, axis, result }: ProbeResultCardProps) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[result.status] ?? STATUS_META.pending;
  const Icon = meta.icon;

  return (
    <MacCard title={label}>
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Icon className={`w-5 h-5 ${meta.cls}`} aria-label={`상태: ${meta.label}`} />
            <span className={`text-sm font-semibold ${meta.cls}`}>{meta.label}</span>
            <ProbeAxisBadge axis={axis} />
          </div>
          <span className="text-xs font-mono text-muted-foreground">{probeKey}</span>
        </div>

        <p className="text-sm">{result.message}</p>

        {result.recommendation && (
          <div className="text-sm rounded-md border border-border bg-muted/30 px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mr-1.5">권고</span>
            {result.recommendation}
          </div>
        )}

        {result.manualFallback && (
          <div className="text-sm rounded-md border border-status-warning/40 bg-status-warning/5 p-3 space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-status-warning">
              Manual command 안내
            </span>
            {/* LogViewer 툴바의 복사 버튼이 "복사됨" 피드백을 준다(D-098) */}
            <LogViewer text={result.manualFallback.command} maxHeight="max-h-40" />
            <p className="text-xs text-muted-foreground italic">이유: {result.manualFallback.reason}</p>
          </div>
        )}

        {result.details && Object.keys(result.details).length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ChevronRight className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            raw details (JSON)
          </button>
        )}
        {expanded && (
          <LogViewer text={JSON.stringify(result.details, null, 2)} maxHeight="max-h-64" />
        )}
      </div>
    </MacCard>
  );
}
