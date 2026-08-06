import { cn } from '@/lib/utils';
import { STATUS_ICON } from '@/lib/statusColors';
import type { KanbanStatus } from '@/types';

/** 업무 상태를 색상 없이도 구분할 수 있는 아이콘 — 색상 단독 신호를 보강한다. */
export function StatusGlyph({ status, className }: { status: KanbanStatus; className?: string }) {
  const Icon = STATUS_ICON[status] ?? STATUS_ICON.todo;
  return <Icon className={cn('w-3 h-3 flex-shrink-0', className)} />;
}
