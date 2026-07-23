import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, AlertTriangle, CalendarClock, MessageSquare, X } from 'lucide-react';
import { useHomeWorkItems } from '@/hooks/useWorkItems';
import { useAuthStore } from '@/stores/authStore';
import { notificationsApi } from '@/services/api';
import { stripHtml, assigneeNames, toLocalDateKey } from '@/lib/utils';
import type { WorkItem } from '@/types';

/**
 * 업무 일정 알람 (UI 채널).
 *
 * 현재 로그인한 담당자에게 배정된 **미완료**(kanbanStatus !== 'done') 업무 중
 * **지연**(시작일 < 오늘) 또는 **오늘 마감**(시작일 == 오늘) 건을 사이드바 벨로 알린다.
 * 실시간 집계 — 업무를 완료하면 알람이 자동으로 사라진다.
 *
 * 확장(나중에): CUBE / E-Mail 등 다른 채널은 백엔드에서 동일한 "담당자별 미완료 업무"
 * 집계를 재사용해 `services/notifier.py` 채널 패턴 + Celery 스케줄로 추가하면 된다.
 * 이 컴포넌트는 그 중 UI(인앱) 채널에 해당한다.
 */

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** fromKey~toKey 사이 일수 (YYYY-MM-DD, 양수 = toKey 가 나중). */
function daysBetween(fromKey: string, toKey: string): number {
  const a = new Date(fromKey + 'T00:00:00');
  const b = new Date(toKey + 'T00:00:00');
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function itemLabel(item: WorkItem): string {
  const t = item.title?.trim();
  if (t) return t;
  const c = stripHtml(item.content).trim();
  return c || '(제목 없음)';
}

function AlarmRow({ item, today, onOpen }: { item: WorkItem; today: string; onOpen: (i: WorkItem) => void }) {
  const due = toLocalDateKey(item.startedAt);
  const overdueDays = due ? daysBetween(due, today) : 0;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="w-full text-left px-3 py-2 hover:bg-muted/40 transition-colors flex flex-col gap-0.5 border-b border-border/60 last:border-b-0"
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-sm text-foreground/90 line-clamp-1 flex-1 min-w-0">{itemLabel(item)}</span>
        {overdueDays > 0 ? (
          <span className="text-xs font-bold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-500 whitespace-nowrap flex-shrink-0">
            {overdueDays}일 지연
          </span>
        ) : (
          <span className="text-xs font-bold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 whitespace-nowrap flex-shrink-0">
            오늘
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="px-1.5 py-0.5 rounded-full bg-primary/10 text-primary truncate max-w-[120px]">{item.category}</span>
        {due && <span className="tabular-nums">{due}</span>}
      </div>
    </button>
  );
}

export function WorkAlarmBell() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const myName = user?.displayName?.trim() || user?.username || null;

  const { data } = useHomeWorkItems();
  const items = useMemo(() => data?.data ?? [], [data]);
  const today = dateKey(new Date());

  const { overdue, dueToday } = useMemo(() => {
    const overdueList: WorkItem[] = [];
    const todayList: WorkItem[] = [];
    if (myName) {
      for (const t of items) {
        if (t.kanbanStatus === 'done') continue;
        // 담당자 필드에 쉼표로 여러 명("A,B")이 들어올 수 있어 정확 일치가 아닌 분리 매칭.
        const mine = assigneeNames(t).includes(myName);
        if (!mine) continue;
        const due = toLocalDateKey(t.startedAt);
        if (!due) continue;
        if (due < today) overdueList.push(t);
        else if (due === today) todayList.push(t);
      }
    }
    const byDate = (a: WorkItem, b: WorkItem) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
    overdueList.sort(byDate);
    todayList.sort(byDate);
    return { overdue: overdueList, dueToday: todayList };
  }, [items, myName, today]);

  const total = overdue.length + dueToday.length;

  // 개인 인앱 알림(댓글 등)
  const qc = useQueryClient();
  const { data: notifResp } = useQuery({
    queryKey: ['myNotifications'],
    queryFn: () => notificationsApi.listMy().then((r) => r.data),
    refetchInterval: 60000,
    enabled: !!user,
  });
  const notifications = notifResp?.data ?? [];
  const unreadNotif = notifResp?.unread ?? 0;
  const grandTotal = total + unreadNotif;

  const openNotif = (n: { id: string; link?: string | null }) => {
    setOpen(false);
    if (n.link) navigate(n.link);
    notificationsApi.markRead(n.id).then(() => qc.invalidateQueries({ queryKey: ['myNotifications'] })).catch(() => {});
  };
  const markAllNotif = () => {
    notificationsApi.markAllRead().then(() => qc.invalidateQueries({ queryKey: ['myNotifications'] })).catch(() => {});
  };

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (btnRef.current && btnRef.current.contains(e.target as Node)) return;
      const panel = document.getElementById('work-alarm-panel');
      if (panel && panel.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  const togglePanel = () => {
    setAnchor(btnRef.current?.getBoundingClientRect() ?? null);
    setOpen((v) => !v);
  };

  const openItem = (item: WorkItem) => {
    setOpen(false);
    navigate(`/tasks-mgmt/${item.id}`);
  };

  const tooltip = total > 0 ? `업무 알람 — 지연/오늘 ${total}건` : '업무 알람 (처리할 항목 없음)';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={togglePanel}
        aria-label={tooltip}
        title={tooltip}
        className={`relative flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
          open ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
        }`}
      >
        <Bell className="w-4 h-4" />
        {grandTotal > 0 && (
          <span
            aria-hidden
            className={`absolute top-0.5 right-0.5 min-w-[16px] h-4 px-1 rounded-full text-white text-xs font-bold leading-4 text-center pointer-events-none ${
              overdue.length > 0 ? 'bg-red-500' : dueToday.length > 0 ? 'bg-amber-500' : 'bg-blue-500'
            }`}
          >
            {grandTotal > 99 ? '99+' : grandTotal}
          </span>
        )}
      </button>

      {open && anchor && createPortal(
        <div
          id="work-alarm-panel"
          role="dialog"
          aria-label="업무 알람"
          style={{
            // 버튼 아래로, 오른쪽 가장자리를 버튼 우측에 맞춰 연다 (우상단 배치에서도 화면 밖으로 안 나가게).
            top: Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - 8 - 440)),
            right: Math.max(8, window.innerWidth - anchor.right),
          }}
          className="fixed z-[60] w-80 max-h-[70vh] rounded-xl border border-border bg-card shadow-xl flex flex-col overflow-hidden"
        >
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-border flex-shrink-0">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4 text-primary" />
              <span className="text-sm font-semibold">업무 알람</span>
              {total > 0 && <span className="text-sm text-muted-foreground">{total}건</span>}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
              aria-label="닫기"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="overflow-y-auto flex-1">
            {grandTotal === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                처리할 미완료 업무가 없습니다 🎉
              </div>
            ) : (
              <>
                {notifications.length > 0 && (
                  <>
                    <div className="flex items-center justify-between px-3 py-1.5 bg-blue-500/5 text-blue-600 text-xs font-semibold sticky top-0">
                      <span className="flex items-center gap-1.5"><MessageSquare className="w-3.5 h-3.5" /> 알림 {unreadNotif > 0 ? unreadNotif : ''}</span>
                      {unreadNotif > 0 && (
                        <button type="button" onClick={markAllNotif} className="text-xs underline hover:no-underline">모두 읽음</button>
                      )}
                    </div>
                    {notifications.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => openNotif(n)}
                        className={`w-full text-left px-3 py-2 border-b border-border/40 hover:bg-secondary/40 transition-colors ${n.isRead ? '' : 'bg-blue-500/[0.04]'}`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {!n.isRead && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />}
                          <span className="text-sm font-medium truncate">{n.title}</span>
                        </div>
                        {n.body && <p className="text-xs text-muted-foreground truncate mt-0.5">{n.body}</p>}
                      </button>
                    ))}
                  </>
                )}
                {overdue.length > 0 && (
                  <>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/5 text-red-500 text-xs font-semibold sticky top-0">
                      <AlertTriangle className="w-3.5 h-3.5" /> 지연 {overdue.length}
                    </div>
                    {overdue.map((it) => <AlarmRow key={it.id} item={it} today={today} onOpen={openItem} />)}
                  </>
                )}
                {dueToday.length > 0 && (
                  <>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/5 text-amber-600 text-xs font-semibold sticky top-0">
                      <CalendarClock className="w-3.5 h-3.5" /> 오늘 마감 {dueToday.length}
                    </div>
                    {dueToday.map((it) => <AlarmRow key={it.id} item={it} today={today} onOpen={openItem} />)}
                  </>
                )}
              </>
            )}
          </div>

          {total > 0 && (
            <button
              type="button"
              onClick={() => { setOpen(false); navigate('/tasks-mgmt'); }}
              className="flex-shrink-0 border-t border-border px-3 py-2 text-sm text-primary hover:bg-primary/5 transition-colors text-left"
            >
              전체 업무 보기 →
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
