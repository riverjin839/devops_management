/**
 * Section card. Two visual variants:
 *  - 'flat' (default, Databricks-leaning): flat surface, 1px border, no shadow,
 *    small uppercase label in a compact left-aligned header.
 *  - 'mac':   legacy macOS window with traffic-light dots and centred title.
 *    Kept for opt-in nostalgia or specific marketing surfaces.
 *
 * Call-site compatible — existing <MacCard title="..."> calls automatically
 * render in the new 'flat' variant.
 */
import type { ReactNode } from 'react';

interface MacCardProps {
  /** Section title — uppercase label in flat variant, centred in mac variant */
  title?: string;
  /** Visual style. Default 'flat' (Phase A redesign). 'mac' keeps legacy look. */
  variant?: 'flat' | 'mac';
  children: ReactNode;
  /** Extra Tailwind classes applied to the body wrapper */
  className?: string;
  /** Extra Tailwind classes applied to the root element */
  rootClassName?: string;
  /** Padding applied to the body area (default p-4) */
  bodyPadding?: string;
}

export function MacCard({
  title,
  variant = 'flat',
  children,
  className = '',
  rootClassName = '',
  bodyPadding,
}: MacCardProps) {
  const padding = bodyPadding ?? (variant === 'mac' ? 'p-5' : 'p-4');

  if (variant === 'mac') {
    return (
      <div
        className={`bg-card rounded-2xl border border-border overflow-hidden mac-shadow ${rootClassName}`}
      >
        <div className="flex items-center px-4 py-3 gap-2">
          <div className="flex items-center gap-[6px] flex-shrink-0">
            <span className="w-[13px] h-[13px] rounded-full" style={{ background: 'var(--mac-red)' }} />
            <span className="w-[13px] h-[13px] rounded-full" style={{ background: 'var(--mac-yellow)' }} />
            <span className="w-[13px] h-[13px] rounded-full" style={{ background: 'var(--mac-green)' }} />
          </div>
          {title && (
            <span className="flex-1 text-center text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground select-none pr-8">
              {title}
            </span>
          )}
        </div>
        <div className="h-px bg-border/60" />
        <div className={`${padding} ${className}`}>{children}</div>
      </div>
    );
  }

  // 'flat' (default)
  return (
    <div className={`bg-card rounded-md border border-border overflow-hidden ${rootClassName}`}>
      {title && (
        <div className="flex items-center px-4 py-2.5 border-b border-border bg-muted/40">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
            {title}
          </span>
        </div>
      )}
      <div className={`${padding} ${className}`}>{children}</div>
    </div>
  );
}
