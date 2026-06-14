import { useState } from 'react';
import { CheckCircle, AlertTriangle, XCircle, WifiOff, ChevronRight, Copy } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ProbeAxisBadge } from './ProbeAxisBadge';
import type { BottleneckStatus, ProbeResultOut } from '@/types';

const STATUS_META: Record<BottleneckStatus, { label: string; cls: string; icon: typeof CheckCircle }> = {
  healthy:  { label: '정상',  cls: 'text-emerald-500', icon: CheckCircle },
  warning:  { label: '경고',  cls: 'text-amber-500',   icon: AlertTriangle },
  critical: { label: '위험',  cls: 'text-red-500',     icon: XCircle },
  pending:  { label: '미연결', cls: 'text-slate-400',   icon: WifiOff },
};

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
          <div className="text-sm rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                Manual command 안내
              </span>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(result.manualFallback!.command)}
                aria-label="명령 복사"
                className="inline-flex items-center gap-1 text-xs hover:text-foreground text-muted-foreground"
              >
                <Copy className="w-3 h-3" />
                복사
              </button>
            </div>
            <pre className="font-mono text-xs bg-card border border-border rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
              {result.manualFallback.command}
            </pre>
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
          <pre className="text-xs font-mono bg-muted rounded p-2 overflow-x-auto max-h-64">
            {JSON.stringify(result.details, null, 2)}
          </pre>
        )}
      </div>
    </MacCard>
  );
}
