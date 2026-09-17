import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarClock, CalendarDays,
  ListTodo, ServerCog, LayoutGrid, ListTree,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { MemberTodayTodos } from '@/components/dashboard/MemberTodayTodos';
import { WorkCalendar } from '@/components/dashboard/WorkCalendar';
import { WeeklyStatusTimeline } from '@/components/dashboard/WeeklyStatusTimeline';
import { DayScheduleBoard } from '@/components/dashboard/DayScheduleBoard';
import { PlatformStatusMatrix } from '@/components/platform-status';
import { BatchJobsPage } from '@/pages/BatchJobsPage';
import { useClusterStore } from '@/stores/clusterStore';
import { useClusters } from '@/hooks/useCluster';
import { useCheckMatrixFailureCount } from '@/hooks/useCheckMatrix';
import { useHomePrefs, useUpdateHomePrefs } from '@/hooks/useHomePrefs';
import { useHomeStore, type HomeTab } from '@/stores/homeStore';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { cn } from '@/lib/utils';

// ── Main ─────────────────────────────────────────────────────────────────────
export function HomePage() {
  const homeTab = useHomeStore((s) => s.homeTab);
  const setHomeTab = useHomeStore((s) => s.setHomeTab);
  const scheduleBg = useHomeStore((s) => s.scheduleBg);

  // 서버 저장 기본 홈 탭 — 기기·브라우저를 넘어 따라온다(D-060 연장). localStorage 는
  // 즉시 반영을 위한 기기 로컬 캐시일 뿐, 소스는 여기(user_settings.home_prefs).
  const { data: homePrefs } = useHomePrefs();
  const updateHomePrefs = useUpdateHomePrefs();
  const appliedServerDefault = useRef(false);
  useEffect(() => {
    if (appliedServerDefault.current || homePrefs === undefined) return;
    appliedServerDefault.current = true;
    if (homePrefs.defaultHomeTab) setHomeTab(homePrefs.defaultHomeTab);
  }, [homePrefs, setHomeTab]);

  const saveTimerRef = useRef<number | undefined>(undefined);
  const selectHomeTab = (tab: HomeTab) => {
    setHomeTab(tab);
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      updateHomePrefs.mutate({ defaultHomeTab: tab });
    }, 500);
  };

  // 플랫폼 탭의 매트릭스 툴바(도움말·설명·수행 로그·항목 추가·설정)를 여기 세그먼트 탭
  // 줄에 이식해 한 줄로 합친다 — 예전엔 탭 줄 바로 아래에 "플랫폼 현황" 제목을 다시 반복하는
  // 카드 헤더 줄이 통째로 하나 더 있어(제목 중복 + 세로 공간 낭비), 탭이 이미 "플랫폼 현황"을
  // 보여주는데 그 아래서 또 말하고 있었다. state 는 PlatformStatusMatrix 안에 그대로 두고
  // DOM 만 여기로 옮기는 portal 이라 소유권(캡슐화)은 그대로 유지된다.
  const [platformToolbarSlot, setPlatformToolbarSlot] = useState<HTMLDivElement | null>(null);

  // "위험 클러스터/점검 실패" 는 KPI 스트립 제거(Main UI 간소화 요청) 후에도 플랫폼 탭
  // 배지(아래 TABS.badge)를 위해 계속 필요 — useClusters() 는 clusterStore 를 채우는
  // 부수효과가 있어(다른 화면과 데이터를 공유) 호출 자체는 유지한다.
  const { clusters } = useClusterStore();
  useClusters();
  const { data: checkFailureCount } = useCheckMatrixFailureCount();
  const criticalClusters = useMemo(() => clusters.filter((c) => c.status === 'critical').length, [clusters]);

  // 플랫폼 탭 서브뷰 — 점검 매트릭스 / 배치잡. 배치잡은 예전엔 별도 라우트(/batch-jobs)
  // 였지만 화면 개수를 줄이려 여기 서브탭으로 접었다(/batch-jobs 는 하위호환 리다이렉트).
  // NAV_MAP 항목은 그대로 남아 있어 접근 제어(Settings)로 이 서브탭 자체를 끌 수 있다.
  const { featureAllowed } = useNavCatalog();
  const batchJobsAllowed = featureAllowed('/batch-jobs');
  const [platformView, setPlatformView] = useState<'matrix' | 'batch'>('matrix');

  // 기본 탭 = '주간' — WeeklyStatusTimeline(담당자 기준 스윔레인 뷰)도 이제 담당자별
  // 표시 개수 제한(기본 5개) + "더보기/접기", 항상 최상단 "전체" 요약 행, 화면당 표시
  // 인원 수 제한(기본 20명, 옵션)을 모두 지원해 MemberTodayTodos(담당자 탭)와 동등한
  // 밀도로 보이므로 기본 탭으로 되돌린다.
  const [weeklyTab, setWeeklyTab] = useState<'week' | 'month' | 'member'>('week');

  // 플랫폼 탭 배지 — 위험 클러스터 + 점검 실패 합계. 0이면 배지를 숨겨 평상시엔 조용하다.
  const platformSignalCount = criticalClusters + (checkFailureCount ?? 0);
  const TABS: Array<{ key: HomeTab; label: string; Icon: typeof ListTodo; badge?: number }> = [
    { key: 'work', label: '업무 현황', Icon: ListTodo },
    { key: 'platform', label: '플랫폼 현황', Icon: ServerCog, badge: platformSignalCount || undefined },
  ];
  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = (idx + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    selectHomeTab(TABS[next].key);
  };

  return (
    <div className="app-h-screen overflow-hidden bg-background flex flex-col">

      {/* ── 세그먼트 탭 — 홈 본문에서 뭘 볼지 고르는 로컬 선택. 예전엔 사이드바 전체를
          게이팅하는 "모드"였지만(D-054), 지금은 이 홈 화면 안에서만 의미가 있다.
          Main UI 간소화 요청으로 KPI 스트립(내 할일/미해결 이슈/위험 클러스터 등)을
          제거해 이 탭 줄이 홈의 최상단이 됐다 — 신호는 위험/실패가 있을 때만 뜨는
          탭 배지 하나로 압축했다. 플랫폼 탭일 때는 오른쪽에 매트릭스 툴바(portal slot)를
          같은 줄에 이어 붙여 카드 헤더 줄 하나를 통째로 줄인다. ───────── */}
      <div className="flex-none flex items-center gap-2 px-3 lg:px-4 py-2 border-b border-border bg-background/95 backdrop-blur">
        <div
          role="tablist"
          aria-label="홈 화면 보기"
          className="flex-shrink-0 inline-flex items-center rounded-xl border border-border overflow-hidden text-sm"
        >
          {TABS.map((t, idx) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={homeTab === t.key}
              tabIndex={homeTab === t.key ? 0 : -1}
              onClick={() => selectHomeTab(t.key)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 transition-colors',
                idx > 0 && 'border-l border-border',
                homeTab === t.key
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              <t.Icon className="w-3.5 h-3.5" />
              {t.label}
              {!!t.badge && (
                <span
                  className={cn(
                    'inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full text-[10px] font-bold tabular-nums',
                    homeTab === t.key
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-status-critical/15 text-status-critical',
                  )}
                  title={`위험 클러스터·점검 실패 합계 ${t.badge}건`}
                >
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>
        {homeTab === 'platform' && (
          <div ref={setPlatformToolbarSlot} className="flex-1 min-w-0 flex items-center gap-2" />
        )}
      </div>

      {/* ── 플랫폼 탭: 점검 매트릭스 / 배치잡 서브탭 — 남는 공간을 모두 채우고
          선택된 서브뷰 안쪽에서만 스크롤. 매트릭스 자체 툴바는 위 세그먼트 탭 줄의
          portal slot 으로 이식되므로 여기서는 toolbarSlot 만 넘긴다. ───────────── */}
      {homeTab === 'platform' && (() => {
        const effectiveView = platformView === 'batch' && !batchJobsAllowed ? 'matrix' : platformView;
        return (
          <div className="flex-1 min-h-0 px-3 pt-2 pb-3 flex flex-col gap-2 overflow-hidden">
            {batchJobsAllowed && (
              <div className="flex-none inline-flex items-center self-start rounded-lg border border-border overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => setPlatformView('matrix')}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 transition-colors',
                    effectiveView === 'matrix'
                      ? 'bg-secondary text-foreground font-semibold'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )}
                >
                  <LayoutGrid className="w-3.5 h-3.5" /> 점검 매트릭스
                </button>
                <button
                  type="button"
                  onClick={() => setPlatformView('batch')}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 border-l border-border transition-colors',
                    effectiveView === 'batch'
                      ? 'bg-secondary text-foreground font-semibold'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )}
                >
                  <ListTree className="w-3.5 h-3.5" /> 배치잡
                </button>
              </div>
            )}
            {effectiveView === 'matrix' ? (
              <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                <PlatformStatusMatrix toolbarSlot={platformToolbarSlot} />
              </div>
            ) : (
              // BatchJobsPage 는 원래 독립 라우트 페이지라 자체 전체높이 셸을 두른다 —
              // island-embed 로 그 셸을 무력화하고 이 flex 컨테이너 안에서 자체 스크롤만 하게 한다
              // (Your Island 패널이 페이지 컴포넌트를 임베드할 때 쓰는 것과 같은 패턴).
              <div className="island-embed flex-1 min-h-0 overflow-auto">
                <BatchJobsPage />
              </div>
            )}
          </div>
        );
      })()}

      {/* ── 업무 탭: 스케줄/진행 현황 패널 ───────────────────────────────────── */}
      {homeTab === 'work' && (
        <div className={cn(
          'flex-1 min-h-0 flex flex-col px-3 py-3 gap-3 overflow-auto',
          scheduleBg === 'cream' ? 'schedule-bg-cream' : 'schedule-bg-white',
        )}>
          {/* xl 미만에서는 그리드를 뷰포트 높이에 가두지 않고(패널이 짓눌려 이중 스크롤 나던 문제)
              바깥 컨테이너 하나만 스크롤시키고, 패널은 최소 높이로 자연 배치한다. xl 이상만 높이 채움. */}
          <div className="grid grid-cols-10 gap-3 xl:flex-1 xl:min-h-0">

            {/* ── 당일 시간단위 스케줄 (담당자 기준) (4/10) ─────────────────── */}
            <MacCard
              rootClassName="col-span-10 xl:col-span-4 flex flex-col min-h-[420px] xl:min-h-0"
              bodyPadding="p-0"
              className="flex-1 min-h-0 flex flex-col"
            >
              <div className="flex-none flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
                <CalendarClock className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
                  당일 스케줄
                </span>
              </div>
              <div className="flex-1 min-h-0 p-3">
                <DayScheduleBoard selectedClusterId={null} />
              </div>
            </MacCard>

            {/* ── 담당자별 진행 현황 (주간 / 월간 / 담당자) (6/10) ──────────── */}
            <MacCard
              rootClassName="col-span-10 xl:col-span-6 flex flex-col min-h-[420px] xl:min-h-0"
              bodyPadding="p-0"
              className="flex-1 min-h-0 flex flex-col"
            >
              <div className="flex-none flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
                  담당자별 진행 현황
                </span>
                <CalendarDays className="w-3.5 h-3.5 text-primary" />
                <div className="ml-auto flex items-center rounded-md border border-border overflow-hidden text-xs">
                  <button
                    onClick={() => setWeeklyTab('week')}
                    className={cn(
                      'px-2 py-1 transition-colors',
                      weeklyTab === 'week' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground',
                    )}
                  >
                    주간
                  </button>
                  <button
                    onClick={() => setWeeklyTab('month')}
                    className={cn(
                      'px-2 py-1 border-l border-border transition-colors',
                      weeklyTab === 'month' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground',
                    )}
                  >
                    월간
                  </button>
                  <button
                    onClick={() => setWeeklyTab('member')}
                    className={cn(
                      'px-2 py-1 border-l border-border transition-colors',
                      weeklyTab === 'member' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground',
                    )}
                  >
                    담당자
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                {weeklyTab === 'week' && (
                  <div className="h-full overflow-y-auto p-3"><WeeklyStatusTimeline selectedClusterId={null} /></div>
                )}
                {weeklyTab === 'month' && (
                  <div className="h-full overflow-y-auto p-4"><WorkCalendar selectedClusterId={null} /></div>
                )}
                {weeklyTab === 'member' && (
                  <div className="h-full overflow-y-auto p-4"><MemberTodayTodos selectedClusterId={null} /></div>
                )}
              </div>
            </MacCard>

          </div>
        </div>
      )}
    </div>
  );
}
