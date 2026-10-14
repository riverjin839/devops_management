/**
 * Section card — flat surface, 1px border, small uppercase label in a compact left-aligned header.
 * Internally a thin adapter over the shadcn `Card` primitive (see `ui/card.tsx`).
 *
 * P3(2026-09): macOS 신호등 점(빨강·노랑·초록) 장식을 쓰던 `variant="mac"` 을 없앴다 — 누를 수
 * 없는 장식이 상태색과 같은 hue 라 운영 화면에서 "장애"로 읽혔고, 사용처도 0건이었다.
 *
 * D-122(2026-10): 헤더 슬롯(`icon`·`description`·`titleExtra`·`actions`)을 더했다. 카드 첫 줄에
 * 제목+버튼 행을 손으로 그리지 말고 이 슬롯을 쓴다. `title` 없이 `actions` 만 주면 헤더 바에
 * 액션(필터·툴바)만 그린다.
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface MacCardProps {
  /** Section title — uppercase label in the card header */
  title?: string;
  /** 제목 앞 아이콘(회색) */
  icon?: LucideIcon;
  /** 제목 옆 한 줄 보조 설명(대소문자 그대로) */
  description?: ReactNode;
  /** 제목 옆 배지·건수 */
  titleExtra?: ReactNode;
  /** 헤더 우측 버튼·토글 묶음 */
  actions?: ReactNode;
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
  icon: Icon,
  description,
  titleExtra,
  actions,
  children,
  className = '',
  rootClassName = '',
  bodyPadding,
}: MacCardProps) {
  const padding = bodyPadding ?? 'p-4';
  const hasHeader = Boolean(title || actions);

  return (
    <Card className={cn('rounded-md', rootClassName)}>
      {hasHeader && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 border-b border-border bg-surface-container-high min-h-[41px]">
          {title && (
            <div className="flex items-center gap-2 min-w-0">
              {Icon && <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden />}
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
                {title}
              </span>
              {titleExtra}
              {description && (
                <span className="text-xs text-muted-foreground truncate">{description}</span>
              )}
            </div>
          )}
          {actions && (
            <div className={cn('flex flex-wrap items-center gap-2', title ? 'ml-auto' : 'w-full')}>
              {actions}
            </div>
          )}
        </div>
      )}
      <div className={cn(padding, className)}>{children}</div>
    </Card>
  );
}
