import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LayoutGrid, PanelLeft, Settings2, Palmtree } from 'lucide-react';
import {
  useIslands, useUpdateIsland, describeIslandSaveError, type IslandPanelsUpdater,
} from '@/hooks/useIslands';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { useIslandStore } from '@/stores/islandStore';
import { useAuthStore } from '@/stores/authStore';
import { EmptyState, ErrorState, LoadingState, PageShell, useToast } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import {
  IslandManagerPane, IslandPanelHost, IslandRail, IslandTabBar, PanelPickerDialog,
  PanelEditDialog, MAX_PANELS, type IslandPanelView,
} from '@/components/island';
import type { Island, IslandPanel } from '@/types';

/** panels 배열에서 겹치지 않는 새 패널 키를 만든다 (같은 화면 중복 추가 허용). */
function nextPanelKey(panels: IslandPanel[]): string {
  const used = new Set(panels.map((p) => p.key));
  let n = panels.length + 1;
  while (used.has(`p${n}`)) n += 1;
  return `p${n}`;
}

/** 아일랜드가 아직 정해지지 않은 상태(로딩·조회 실패·없음)의 공통 틀 — 허브 밀도(§12.12-5). */
function IslandHubShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="hub" className="space-y-4">
        <PageHeader
          icon={Palmtree}
          title="나의 아일랜드"
          description="자주 쓰는 PEP 화면을 하나에 모아두는 개인 화면입니다."
        />
        {children}
      </PageShell>
    </div>
  );
}

/**
 * Your Island — 사용자 커스텀 화면 (`/island`, `/island/:islandId`).
 *
 * 패널은 기존 페이지 컴포넌트를 그대로 임베드하며(IslandPanelHost), **활성 패널 하나만**
 * 마운트한다. 비활성 패널을 붙여두면 임베드된 페이지들의 `useSearchParams` 가 서로 충돌하고
 * 폴링 쿼리가 백그라운드에서 계속 돌기 때문. 탭 전환 시의 재조회 비용은 TanStack Query
 * 캐시(staleTime)가 흡수한다.
 */
export function IslandPage() {
  const { islandId } = useParams<{ islandId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, isLoading, isError, error, refetch } = useIslands();
  const updateIsland = useUpdateIsland();
  const { navMap, getLabel } = useNavCatalog();
  const currentUser = useAuthStore((s) => s.user);
  const { lastIslandId, setLastIslandId, activePanels, setActivePanel } = useIslandStore();

  const [managerOpen, setManagerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingPanelKey, setEditingPanelKey] = useState<string | null>(null);

  const mine = useMemo(() => data?.data ?? [], [data?.data]);
  const shared = useMemo(() => data?.shared ?? [], [data?.shared]);

  const island: Island | null = useMemo(() => {
    if (!islandId) return null;
    return [...mine, ...shared].find((i) => i.id === islandId) ?? null;
  }, [islandId, mine, shared]);

  // 소유자만 편집 가능 — 공유받은 아일랜드는 읽기 전용(복제해서 쓰는 모델).
  const editable = !!island && island.ownerId === currentUser?.id;

  // 목록을 **성공적으로** 받았을 때만 리다이렉트·기억 삭제를 판단한다(B-11). 조회 실패를 "없음"으로
  // 읽으면 마지막에 보던 아일랜드 기억을 지우고 빈 상태로 보내 중복 생성을 유도한다.
  const listReady = !!data && !isError;

  // `/island` 로 들어오면 마지막에 보던 아일랜드(없으면 첫 번째)로 보낸다.
  useEffect(() => {
    if (islandId || !listReady || mine.length === 0) return;
    const target = mine.find((i) => i.id === lastIslandId) ?? mine[0];
    navigate(`/island/${target.id}`, { replace: true });
  }, [islandId, listReady, mine, lastIslandId, navigate]);

  // 성공 응답에 없는(삭제된) 아일랜드 id 로 들어오면 목록으로 되돌린다.
  useEffect(() => {
    if (!islandId || !listReady || island) return;
    setLastIslandId(null);
    navigate('/island', { replace: true });
  }, [islandId, listReady, island, navigate, setLastIslandId]);

  useEffect(() => {
    if (island) setLastIslandId(island.id);
  }, [island, setLastIslandId]);

  // useMemo 로 감싸야 아래 useMemo 들의 deps 가 매 렌더마다 바뀌지 않는다 (빈 배열 리터럴 주의).
  const panels = useMemo(() => island?.panels ?? [], [island]);

  // 활성 패널: URL 의 ?panel= 이 우선(딥링크·새로고침), 없으면 마지막으로 보던 것, 그다음 첫 패널.
  // `?tab=` 은 SettingsPage 등 임베드된 페이지가 이미 쓰고 있어 의도적으로 피한다.
  const panelParam = searchParams.get('panel');
  const activeKey = useMemo(() => {
    const stored = island ? activePanels[island.id] : null;
    const candidates = [panelParam, stored].filter(Boolean) as string[];
    for (const key of candidates) {
      if (panels.some((p) => p.key === key)) return key;
    }
    return panels[0]?.key ?? null;
  }, [panelParam, activePanels, island, panels]);

  const activePanel = panels.find((p) => p.key === activeKey) ?? null;

  const handleSelect = (key: string) => {
    if (island) setActivePanel(island.id, key);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('panel', key);
      return next;
    }, { replace: true });
  };

  const notifySaveError = (title: string) => (err: unknown) => {
    const msg = describeIslandSaveError(err, title);
    toast.error(msg.title, msg.description);
  };

  /**
   * 패널 변경은 "현재 패널 → 다음 패널" 함수로 보낸다. 훅이 아일랜드별로 직렬화하고, 앞 변경이
   * 서버에 반영된 최신 배열 위에서 이 함수를 다시 계산하므로 빠르게 이어진 변경이 서로 지우지 않는다(B-12).
   * 화면은 즉시 바뀌고(낙관적), 실패하면 그 변경만 되돌아간다.
   */
  const savePanels = (updater: IslandPanelsUpdater, failTitle = '패널 저장 실패') => {
    if (!island) return;
    updateIsland.mutate({ id: island.id, panels: updater }, { onError: notifySaveError(failTitle) });
  };

  const handleAddPanel = (path: string) => {
    if (!island) return;
    setPickerOpen(false);
    const panel: IslandPanel = { key: nextPanelKey(panels), path, label: null, icon: null };
    savePanels((cur) => (
      cur.some((p) => p.key === panel.key) || cur.length >= MAX_PANELS ? cur : [...cur, panel]
    ), '화면 추가 실패');
    handleSelect(panel.key);
  };

  // 제거는 확인 대화상자 대신 5초 "되돌리기" 토스트(정책 ⑧) — 사용자 지정 이름·아이콘까지 그대로 복원한다.
  const handleRemovePanel = (key: string) => {
    const index = panels.findIndex((p) => p.key === key);
    if (index < 0) return;
    const removed = panels[index];
    savePanels((cur) => cur.filter((p) => p.key !== key), '패널 제거 실패');
    toast.show({
      variant: 'info',
      title: '패널 제거됨',
      description: removed.label || getLabel(removed.path),
      durationMs: 5000,
      action: {
        label: '되돌리기',
        onClick: () => savePanels((cur) => {
          if (cur.some((p) => p.key === removed.key) || cur.length >= MAX_PANELS) return cur;
          const next = [...cur];
          next.splice(Math.min(index, next.length), 0, removed);
          return next;
        }, '패널 복원 실패'),
      },
    });
  };

  const handleEditPanel = (key: string, patch: { label: string | null; icon: string | null }) =>
    savePanels((cur) => cur.map((p) => (p.key === key ? { ...p, ...patch } : p)), '패널 표시 설정 저장 실패');

  const handleReorder = (keys: string[]) => {
    savePanels((cur) => {
      const byKey = new Map(cur.map((p) => [p.key, p]));
      const ordered = keys.map((k) => byKey.get(k)).filter((p): p is IslandPanel => !!p);
      // 순서를 정하는 사이 다른 변경으로 생긴 패널은 뒤에 붙여 잃지 않는다.
      const placed = new Set(ordered.map((p) => p.key));
      return [...ordered, ...cur.filter((p) => !placed.has(p.key))];
    }, '순서 저장 실패');
  };

  const toggleLayout = () => {
    if (!island) return;
    updateIsland.mutate(
      { id: island.id, layoutMode: island.layoutMode === 'tabs' ? 'sidebar' : 'tabs' },
      { onError: notifySaveError('레이아웃 전환 실패') },
    );
  };

  // 패널 → 표시용 뷰모델. 라벨/아이콘은 사용자 지정값이 있으면 그것, 없으면 사이드바와 같은 소스.
  const panelViews: IslandPanelView[] = useMemo(
    () => panels.map((p) => ({
      ...p,
      displayLabel: p.label || getLabel(p.path),
      Icon: navMap[p.path]?.icon ?? Palmtree,
    })),
    [panels, getLabel, navMap],
  );

  const editingPanel = panelViews.find((p) => p.key === editingPanelKey) ?? null;

  if (!island) {
    // 조회 실패는 "아일랜드 없음"이 아니다 — 다시 시도만 제공하고 생성으로 유도하지 않는다(B-11).
    if (isError) {
      return (
        <IslandHubShell>
          <ErrorState error={error} title="아일랜드 목록을 불러오지 못했습니다." onRetry={() => { void refetch(); }} />
        </IslandHubShell>
      );
    }
    // 첫 로딩, 또는 리다이렉트 직전(`/island` → 마지막 아일랜드, 없는 id → `/island`).
    if (isLoading || !data || islandId || mine.length > 0) {
      return <IslandHubShell><LoadingState /></IslandHubShell>;
    }
    return (
      <>
        <IslandHubShell>
          <EmptyState
            icon={Palmtree}
            title="아직 만든 아일랜드가 없습니다."
            description="아일랜드를 만들고 원하는 화면을 패널로 추가하면 탭이나 좌측 사이드바로 바로 전환할 수 있습니다."
            action={{ label: '첫 아일랜드 만들기', onClick: () => setManagerOpen(true) }}
          />
        </IslandHubShell>
        <IslandManagerPane open={managerOpen} onClose={() => setManagerOpen(false)} currentId={null} />
      </>
    );
  }

  const header = (
    <PageHeader
      title={island.name}
      titleExtra={!editable && (
        <span className="px-1.5 py-0.5 text-xs rounded bg-secondary text-muted-foreground whitespace-nowrap">
          {island.ownerName || '공유'} · 읽기 전용
        </span>
      )}
      actions={
      <>
      {editable && (
        <button
          type="button"
          onClick={toggleLayout}
          title={island.layoutMode === 'tabs' ? '사이드바 레이아웃으로' : '탭 레이아웃으로'}
          aria-label="레이아웃 전환"
          className="p-1.5 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
        >
          {island.layoutMode === 'tabs'
            ? <PanelLeft className="w-4 h-4" />
            : <LayoutGrid className="w-4 h-4" />}
        </button>
      )}
      <button
        type="button"
        onClick={() => setManagerOpen(true)}
        title="아일랜드 관리"
        aria-label="아일랜드 관리"
        className="p-1.5 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
      >
        <Settings2 className="w-4 h-4" />
      </button>
      </>
      }
    />
  );

  const body = activePanel
    ? (
      <IslandPanelHost
        path={activePanel.path}
        label={activePanel.label || getLabel(activePanel.path)}
        onRemove={editable ? () => handleRemovePanel(activePanel.key) : undefined}
      />
    )
    : (
      <EmptyState
        icon={Palmtree}
        title="담긴 화면이 없습니다."
        description={editable
          ? "'화면 추가'로 자주 쓰는 화면을 이 아일랜드에 담으세요."
          : '아일랜드 소유자가 화면을 추가하면 여기에 표시됩니다.'}
      />
    );

  return (
    <>
      {island.layoutMode === 'sidebar' ? (
        // 보조 사이드바는 메인 사이드바에 flush(좌측 공백 0) — CLAUDE.md 간격 표준.
        <div className="app-min-h-screen bg-background flex">
          <IslandRail
            panels={panelViews}
            activeKey={activeKey}
            editable={editable}
            onSelect={handleSelect}
            onRemove={handleRemovePanel}
            onEdit={setEditingPanelKey}
            onReorder={handleReorder}
            onAdd={() => setPickerOpen(true)}
            atCapacity={panels.length >= MAX_PANELS}
          />
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="px-3 py-2 border-b border-border">{header}</div>
            {body}
          </div>
        </div>
      ) : (
        <div className="app-min-h-screen bg-background flex flex-col">
          <div className="px-3 py-2 border-b border-border">{header}</div>
          <div className="px-3 py-2">
            <IslandTabBar
              panels={panelViews}
              activeKey={activeKey}
              editable={editable}
              onSelect={handleSelect}
              onRemove={handleRemovePanel}
              onEdit={setEditingPanelKey}
              onReorder={handleReorder}
              onAdd={() => setPickerOpen(true)}
              atCapacity={panels.length >= MAX_PANELS}
            />
          </div>
          {body}
        </div>
      )}

      <IslandManagerPane
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        currentId={island.id}
      />
      {editingPanel && (
        <PanelEditDialog
          panel={editingPanel}
          fallbackLabel={getLabel(editingPanel.path)}
          onClose={() => setEditingPanelKey(null)}
          onSave={(patch) => handleEditPanel(editingPanel.key, patch)}
        />
      )}

      {/* 닫혀 있을 땐 아예 마운트하지 않아 카탈로그 계산을 피한다. */}
      {pickerOpen && (
        <PanelPickerDialog
          open
          onClose={() => setPickerOpen(false)}
          existingPaths={panels.map((p) => p.path)}
          onPick={handleAddPanel}
        />
      )}
    </>
  );
}
