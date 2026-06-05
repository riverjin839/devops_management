import { CalendarCheck2 } from 'lucide-react';
import {
  WorkCalendar,
  YesterdayChanges,
  MemberTodayTodos,
} from '@/components/dashboard';
import { MacCard } from '@/components/ui/MacCard';

export function WorkSummaryPage() {
  // 업무 현황은 전체 클러스터 기준 — 클러스터 사이드바 미사용 (selectedClusterId 항상 전체).
  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-20 px-4 lg:px-6 py-2 bg-background/95 backdrop-blur border-b border-border flex items-center gap-2">
        <CalendarCheck2 className="w-4 h-4 text-primary" />
        <h1 className="font-bold text-sm tracking-tight">업무 현황</h1>
        <p className="text-[11px] text-muted-foreground hidden sm:block">
          업무 진행 달력 · 어제 변경 사항 · 오늘 멤버별 할일
        </p>
      </div>

      <div className="mx-auto px-3 lg:px-4 xl:px-6 py-3">
        <main className="flex-1 min-w-0 space-y-3">
          {/* ── Yesterday Changes ↔ Member Today Todos (2-col) ─────────────── */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 min-w-0">
            <MacCard title="어제 클러스터 작업 변경 사항" bodyPadding="p-4" className="overflow-hidden" rootClassName="min-w-0">
              <YesterdayChanges selectedClusterId={null} />
            </MacCard>
            <MacCard title="멤버별 오늘 할일" bodyPadding="p-4" className="overflow-hidden" rootClassName="min-w-0">
              <MemberTodayTodos selectedClusterId={null} />
            </MacCard>
          </div>

          {/* ── Work Calendar (full width) ─────────────────────────────────── */}
          <MacCard title="업무 진행 달력" bodyPadding="p-4" className="overflow-hidden" rootClassName="min-w-0">
            <WorkCalendar selectedClusterId={null} />
          </MacCard>
        </main>
      </div>
    </div>
  );
}
