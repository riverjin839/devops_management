import { AlertTriangle } from 'lucide-react';
import type { OverlapColor } from './constants';

interface CidrRowProps {
  label: string;
  cidr?: string;
  first?: string;
  last?: string;
  color: { bg: string; border: string; text: string; label: string };
  overlapColor?: OverlapColor | null;
}

export function CidrRow({ label, cidr, first, last, color, overlapColor }: CidrRowProps) {
  if (!cidr && !first && !last) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 px-3 py-2.5">
        <p className={`text-xs font-semibold uppercase tracking-wider mb-0.5 ${color.label}`}>{label}</p>
        <p className="text-sm text-muted-foreground/50">미입력</p>
      </div>
    );
  }
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${overlapColor ? `${overlapColor.bg} ${overlapColor.border}` : `${color.bg} ${color.border}`}`}>
      <div className="flex items-center justify-between mb-1.5">
        <p className={`text-xs font-semibold uppercase tracking-wider ${overlapColor ? overlapColor.text : color.label}`}>{label}</p>
        {overlapColor && (
          <span className={`flex items-center gap-1 text-xs font-medium ${overlapColor.text}`}>
            <AlertTriangle className="w-3 h-3" />겹침
          </span>
        )}
      </div>
      {cidr  && <p className="text-sm font-mono"><span className="text-muted-foreground text-xs">CIDR  </span><span className="text-foreground font-semibold">{cidr}</span></p>}
      {first && <p className="text-sm font-mono mt-0.5"><span className="text-muted-foreground text-xs">First </span><span className="text-foreground">{first}</span></p>}
      {last  && <p className="text-sm font-mono mt-0.5"><span className="text-muted-foreground text-xs">Last  </span><span className="text-foreground">{last}</span></p>}
    </div>
  );
}
