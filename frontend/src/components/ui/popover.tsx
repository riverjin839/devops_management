import * as React from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';

import { cn } from '@/lib/utils';

/**
 * Base UI Popover 래퍼 (shadcn base 스타일). 포커스 가둠·Escape·바깥 클릭·트리거로 포커스 복귀를
 * Base UI 가 처리한다 — 손으로 만든 `createPortal` 팝오버 대신 쓴다(알림 종 등).
 */
const Popover = BasePopover.Root;
const PopoverTrigger = BasePopover.Trigger;
const PopoverClose = BasePopover.Close;
const PopoverTitle = BasePopover.Title;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof BasePopover.Popup>,
  React.ComponentPropsWithoutRef<typeof BasePopover.Popup> & {
    sideOffset?: number;
    side?: React.ComponentProps<typeof BasePopover.Positioner>['side'];
    align?: React.ComponentProps<typeof BasePopover.Positioner>['align'];
  }
>(({ className, sideOffset = 8, side = 'bottom', align = 'end', ...props }, ref) => (
  <BasePopover.Portal>
    <BasePopover.Positioner side={side} align={align} sideOffset={sideOffset} collisionPadding={8} className="z-[60]">
      <BasePopover.Popup
        ref={ref}
        className={cn(
          'rounded-md border border-border bg-popover text-popover-foreground shadow-xl outline-none',
          className,
        )}
        {...props}
      />
    </BasePopover.Positioner>
  </BasePopover.Portal>
));
PopoverContent.displayName = 'PopoverContent';

export { Popover, PopoverTrigger, PopoverContent, PopoverClose, PopoverTitle };
