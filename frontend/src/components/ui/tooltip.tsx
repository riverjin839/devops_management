import * as React from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';

import { cn } from '@/lib/utils';

const TooltipProvider = BaseTooltip.Provider;
const Tooltip = BaseTooltip.Root;
const TooltipTrigger = BaseTooltip.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof BaseTooltip.Popup>,
  React.ComponentPropsWithoutRef<typeof BaseTooltip.Popup> & {
    sideOffset?: number;
    side?: React.ComponentProps<typeof BaseTooltip.Positioner>['side'];
  }
>(({ className, sideOffset = 6, side = 'top', ...props }, ref) => (
  <BaseTooltip.Portal>
    <BaseTooltip.Positioner side={side} sideOffset={sideOffset}>
      <BaseTooltip.Popup
        ref={ref}
        className={cn(
          'z-50 overflow-hidden rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
          'data-[open]:animate-none',
          className
        )}
        {...props}
      />
    </BaseTooltip.Positioner>
  </BaseTooltip.Portal>
));
TooltipContent.displayName = 'TooltipContent';

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
