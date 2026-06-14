import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowUpRight, Check, Copy } from 'lucide-react';
import type { OverlapColor } from './constants';

/** Tailwind 색상 prefix — bg/border/text 토큰을 한꺼번에 적용. */
export type IpGroupAccent = 'sky' | 'cyan' | 'amber' | 'emerald' | 'violet';

const ACCENT: Record<IpGroupAccent, { surface: string; label: string }> = {
  sky:     { surface: 'bg-sky-500/5 border-sky-500/20',     label: 'text-sky-600' },
  cyan:    { surface: 'bg-cyan-500/5 border-cyan-500/20',   label: 'text-cyan-600' },
  amber:   { surface: 'bg-amber-500/5 border-amber-500/20', label: 'text-amber-600' },
  emerald: { surface: 'bg-emerald-500/5 border-emerald-500/20', label: 'text-emerald-600' },
  violet:  { surface: 'bg-violet-500/5 border-violet-500/20', label: 'text-violet-600' },
};

interface IpGroupRowProps {
  label: string;
  /** 정규식/Glob 형식으로 압축된 IP 그룹 표기 (예: "10.0.1.[5-7,10]") */
  groups: string[];
  /** 원본 IP 개수 (그룹 표기 옆에 "N개" 로 노출) */
  totalIps: number;
  accent: IpGroupAccent;
  /** 비어있을 때 안내 문구 */
  emptyMessage: string;
  /** 정확히 0개일 때 표시할 fallback 노드 (예: 수동 입력 CIDR). 있으면 빈 상태 대신 fallback 표시. */
  fallback?: ReactNode;
  /** 그룹/fallback 이 모두 없으면 빈 상태로 렌더 */
  hasContent: boolean;
  /** CIDR Calculator 진입 링크용 값 (cluster.cidr 등) */
  calcCidr?: string;
  overlapColor?: OverlapColor | null;
}

/**
 * INTERNAL_IP / bond0 / bond1 같은 "정규식으로 묶은 IP 목록" 을 통일된
 * 카드형으로 보여주는 presentational 컴포넌트.
 */
export function IpGroupRow({
  label, groups, totalIps, accent, emptyMessage,
  fallback, hasContent, calcCidr, overlapColor,
}: IpGroupRowProps) {
  if (!hasContent) {
    return (
      <div className="rounded-lg border border-dashed border-border/40 px-3 py-2.5">
        <p className={`text-xs font-semibold uppercase tracking-wider mb-0.5 ${ACCENT[accent].label}`}>
          {label}
        </p>
        <p className="text-sm text-muted-foreground/60">{emptyMessage}</p>
      </div>
    );
  }

  const surface = overlapColor
    ? `${overlapColor.bg} ${overlapColor.border}`
    : ACCENT[accent].surface;
  const labelCls = overlapColor ? overlapColor.text : ACCENT[accent].label;

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${surface}`}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <p className={`text-xs font-semibold uppercase tracking-wider ${labelCls}`}>
          {label}
        </p>
        <div className="flex items-center gap-2">
          {totalIps > 0 && (
            <span className="text-xs text-muted-foreground font-mono tabular-nums">
              {totalIps}개
            </span>
          )}
          {overlapColor && (
            <span className={`flex items-center gap-1 text-xs font-medium ${overlapColor.text}`}>
              <AlertTriangle className="w-3 h-3" />겹침
            </span>
          )}
        </div>
      </div>

      {groups.length > 0 ? (
        <div className="space-y-0.5">
          {groups.map((g, i) => (
            <p
              key={i}
              className="text-sm font-mono text-foreground tabular-nums"
              title="/24 단위로 묶고 마지막 옥텟의 연속 구간을 압축한 표기 (grep -E / shell brace expansion 호환)"
            >
              {g}
            </p>
          ))}
        </div>
      ) : (
        fallback
      )}

      {(groups.length > 0 || calcCidr) && (
        <div className="flex items-center gap-1 mt-1.5 pt-1.5 border-t border-border/40">
          {groups.length > 0 && <CopyChip value={groups.join('\n')} />}
          {calcCidr && (
            <Link
              to={`/cidr?cidr=${encodeURIComponent(calcCidr)}`}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-primary hover:bg-primary/10 rounded transition-colors"
              title={`CIDR Calculator 에서 ${calcCidr} 분석`}
            >
              <ArrowUpRight className="w-2.5 h-2.5" />Calc
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
      title="줄바꿈으로 구분해 복사"
    >
      {copied ? <Check className="w-2.5 h-2.5 text-emerald-500" /> : <Copy className="w-2.5 h-2.5" />}
      {copied ? 'OK' : '복사'}
    </button>
  );
}
