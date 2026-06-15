import { useState } from 'react';
import { History, ChevronRight, Plus, Pencil, ArrowRightLeft, Circle } from 'lucide-react';
import { useWorkItemActivities } from '@/hooks/useWorkItems';
import type { WorkItemActivity } from '@/types';

const STATUS_LABEL: Record<string, string> = {
  backlog: '백로그', todo: '할일', in_progress: '진행중', review_test: '검토', done: '완료',
};

function fmt(t: string): string {
  const d = new Date(t.endsWith('Z') || t.includes('+') ? t : t + 'Z');
  if (isNaN(d.getTime())) return t.slice(0, 16).replace('T', ' ');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function describe(a: WorkItemActivity): { icon: typeof Plus; text: string } {
  const d = (a.details ?? {}) as Record<string, unknown>;
  switch (a.action) {
    case 'work_item.create':
      return { icon: Plus, text: '업무 생성' };
    case 'work_item.update': {
      const fields = Array.isArray(d.changedFields) ? (d.changedFields as string[]) : [];
      return { icon: Pencil, text: fields.length ? `수정 · ${fields.join(', ')}` : '수정' };
    }
    case 'work_item.status_change': {
      const from = STATUS_LABEL[String(d.from)] ?? String(d.from ?? '');
      const to = STATUS_LABEL[String(d.to)] ?? String(d.to ?? '');
      return { icon: ArrowRightLeft, text: `상태 변경: ${from} → ${to}` };
    }
    default:
      return { icon: Circle, text: a.action.replace(/^work_item\./, '') };
  }
}

export function ActivityTimeline({ workItemId }: { workItemId: string }) {
  const { data: activities = [] } = useWorkItemActivities(workItemId);
  const [open, setOpen] = useState(false);

  if (activities.length === 0) return null;
  // 최신순
  const ordered = [...activities].reverse();

  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        <History className="w-3.5 h-3.5" />
        변경 이력 <span className="text-primary">{activities.length}</span>
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open && (
        <ul className="mt-2 space-y-1.5">
          {ordered.map((a) => {
            const { icon: Icon, text } = describe(a);
            return (
              <li key={a.id} className="flex items-start gap-2 text-sm">
                <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <span className="text-foreground">{text}</span>
                  <span className="text-muted-foreground"> · {a.actor}</span>
                  <span className="text-muted-foreground/70 font-mono ml-1">{fmt(a.createdAt)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
