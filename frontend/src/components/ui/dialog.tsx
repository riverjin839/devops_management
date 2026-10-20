import * as React from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useModalHistory } from '@/components/common/useModalHistory';

/**
 * Base UI `Dialog.Root` 래퍼 — controlled(`open` prop 이 있는) 다이얼로그를 브라우저/폰 "뒤로가기"로
 * 닫는다(D-029, `useModalHistory`).
 *
 * 뒤로가기로 기록이 사라지면 `actionsRef.close()` 를 부른다. Base UI 1.6 의 close 는
 * `store.setOpen(false, createChangeEventDetails('imperative-action'))` → `onOpenChange(false, details)`
 * 경로를 타므로 Escape·바깥 클릭·X 와 똑같이 호출부의 `onOpenChange` 가드(`!busy` 등)가 적용된다.
 * 호출부가 닫기를 거부해 `open` 이 그대로면 modalHistory 가 기록을 다시 push 한다.
 * uncontrolled(`open` 미지정) 다이얼로그는 기록을 쓰지 않는다. 호출부가 `actionsRef` 를 넘기면 그것을 쓴다.
 */
function Dialog<Payload = unknown>({ actionsRef, ...props }: BaseDialog.Root.Props<Payload>) {
  const innerActionsRef = React.useRef<BaseDialog.Root.Actions | null>(null);
  const actions = actionsRef ?? innerActionsRef;
  useModalHistory(!!props.open, () => actions.current?.close(), props.open !== undefined);
  return <BaseDialog.Root {...props} actionsRef={actions} />;
}
const DialogTrigger = BaseDialog.Trigger;
const DialogClose = BaseDialog.Close;
const DialogPortal = BaseDialog.Portal;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof BaseDialog.Backdrop>,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Backdrop>
>(({ className, ...props }, ref) => (
  <BaseDialog.Backdrop
    ref={ref}
    className={cn('fixed inset-0 z-50 bg-black/50 backdrop-blur-sm', className)}
    {...props}
  />
));
DialogOverlay.displayName = 'DialogOverlay';

const DialogContent = React.forwardRef<
  React.ElementRef<typeof BaseDialog.Popup>,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Popup> & { hideClose?: boolean }
>(({ className, children, hideClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <BaseDialog.Popup
      ref={ref}
      className={cn(
        'fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
        'bg-card border border-border rounded-md shadow-card max-h-[92vh] overflow-y-auto',
        className
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogClose className="absolute right-4 top-4 p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50" aria-label="닫기">
          <X className="w-4 h-4" />
        </DialogClose>
      )}
    </BaseDialog.Popup>
  </DialogPortal>
));
DialogContent.displayName = 'DialogContent';

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1 px-5 pt-5 pb-3', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center gap-2 px-5 pb-5 pt-1', className)} {...props} />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof BaseDialog.Title>,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Title>
>(({ className, ...props }, ref) => (
  <BaseDialog.Title ref={ref} className={cn('text-base font-semibold leading-tight', className)} {...props} />
));
DialogTitle.displayName = 'DialogTitle';

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof BaseDialog.Description>,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Description>
>(({ className, ...props }, ref) => (
  <BaseDialog.Description ref={ref} className={cn('text-xs text-muted-foreground', className)} {...props} />
));
DialogDescription.displayName = 'DialogDescription';

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
