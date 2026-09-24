/**
 * Section card — flat surface, 1px border, small uppercase label in a compact left-aligned header.
 * Internally a thin adapter over the shadcn `Card` primitive (see `ui/card.tsx`).
 *
 * P3(2026-09): macOS 신호등 점(빨강·노랑·초록) 장식을 쓰던 `variant="mac"` 을 없앴다 — 누를 수
 * 없는 장식이 상태색과 같은 hue 라 운영 화면에서 "장애"로 읽혔고, 사용처도 0건이었다.
 */
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface MacCardProps {
  /** Section title — uppercase label in the card header */
  title?: string;
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
  children,
  className = '',
  rootClassName = '',
  bodyPadding,
}: MacCardProps) {
  const padding = bodyPadding ?? 'p-4';

  return (
    <Card className={cn('rounded-md', rootClassName)}>
      {title && (
        <div className="flex items-center px-4 py-2.5 border-b border-border bg-surface-container-high">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
            {title}
          </span>
        </div>
      )}
      <div className={cn(padding, className)}>{children}</div>
    </Card>
  );
}
