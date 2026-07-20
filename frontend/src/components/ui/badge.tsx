/* eslint-disable react-refresh/only-export-components -- badgeVariants shared alongside Badge, same pattern as StatusBadge.tsx */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'border-border text-foreground',
        healthy: 'border-transparent bg-status-healthy/15 text-status-healthy',
        warning: 'border-transparent bg-status-warning/15 text-status-warning',
        critical: 'border-transparent bg-status-critical/15 text-status-critical',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

const DOT_CLS: Record<string, string> = {
  default: 'bg-primary-foreground',
  secondary: 'bg-secondary-foreground',
  destructive: 'bg-destructive-foreground',
  outline: 'bg-foreground',
  healthy: 'bg-status-healthy',
  warning: 'bg-status-warning',
  critical: 'bg-status-critical',
};

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /**
   * 색 dot 표시 여부. a11y 규칙(색만으로 의미 전달 금지) 준수를 위해 텍스트 라벨과 항상 함께 써야 함 —
   * dot 만 있고 children 이 없는 사용은 금지.
   */
  dot?: boolean;
  /** dot 색 오버라이드 (brand.* 등 variant 팔레트에 없는 색을 dot 로 쓸 때). 미지정 시 variant 기본값 사용 */
  dotClassName?: string;
}

function Badge({ className, variant = 'default', dot = false, dotClassName, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && (
        <span
          className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', dotClassName ?? DOT_CLS[variant ?? 'default'])}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
