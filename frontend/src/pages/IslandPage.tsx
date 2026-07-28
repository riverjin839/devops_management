import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LayoutGrid, PanelLeft, Settings2, Palmtree, Plus } from 'lucide-react';
import { useIslands, useUpdateIsland } from '@/hooks/useIslands';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { useIslandStore } from '@/stores/islandStore';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/components/common';
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

function EmptyIslandState({ onOpenManager }: { onOpenManager: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <Palmtree className="w-10 h-10 text-muted-foreground" />
      <h1 className="text-lg font-semibold text-foreground">Your Island</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        자주 쓰는 PEP 화면을 하나에 모아두는 개인 화면입니다. 아일랜드를 만들고 원하는 화면을
        패널로 추가하면 탭이나 좌측 사이드바로 즉시 전환할 수 있습니다.
      </p>
      <button
        type="button"
        onClick={onOpenManager}
        className="mt-1 flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground"
      >
        <Plus className="w-4 h-4" />
        첫 아일랜드 만들기
      </button>
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
  const { data, isLoading } = useIslands();
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

  // `/island` 로 들어오면 마지막에 보던 아일랜드(없으면 첫 번째)로 보낸다.
  useEffect(() => {
    if (islandId || isLoading || mine.length === 0) return;
    const target = mine.find((i) => i.id === lastIslandId) ?? mine[0];
    navigate(`/island/${target.id}`, { replace: true });
  }, [islandId, isLoading, mine, lastIslandId, navigate]);

  // 존재하지 않는(또는 삭제된) 아일랜드 id 로 들어오면 목록으로 되돌린다.
  useEffect(() => {
    if (!islandId || isLoading || island) return;
    setLastIslandId(null);
    navigate('/island', { replace: true });
  }, [islandId, isLoading, island, navigate, setLastIslandId]);

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

  const savePanels = (nextPanels: IslandPanel[]) => {
    if (!island) return;
    updateIsland.mutate(
      { id: island.id, panels: nextPanels },
      { onError: () => toast.error('패널 저장 실패') },
    );
  };

  const handleAddPanel = (path: string) => {
    if (!island) return;
    setPickerOpen(false);
    const panel: IslandPanel = { key: nextPanelKey(panels), path, label: null, icon: null };
    savePanels([...panels, panel]);
    handleSelect(panel.key);
  };

  const handleRemovePanel = (key: string) => savePanels(panels.filter((p) => p.key !== key));

  const handleEditPanel = (key: string, patch: { label: string | null; icon: string | null }) =>
    savePanels(panels.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  const handleReorder = (keys: string[]) => {
    const byKey = new Map(panels.map((p) => [p.key, p]));
    savePanels(keys.map((k) => byKey.get(k)).filter((p): p is IslandPanel => !!p));
  };

  const toggleLayout = () => {
    if (!island) return;
    updateIsland.mutate({
      id: island.id,
      layoutMode: island.layoutMode === 'tabs' ? 'sidebar' : 'tabs',
    });
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

  if (isLoading) return null;

  if (!island) {
    return (
      <div className="min-h-screen bg-background p-6">
        <EmptyIslandState onOpenManager={() => setManagerOpen(true)} />
        <IslandManagerPane open={managerOpen} onClose={() => setManagerOpen(false)} currentId={null} />
      </div>
    );
  }

  const header = (
    <div className="flex items-center gap-2 min-w-0">
      <h1 className="text-sm font-semibold text-foreground truncate">{island.name}</h1>
      {!editable && (
        <span className="px-1.5 py-0.5 text-xs rounded bg-secondary text-muted-foreground whitespace-nowrap">
          {island.ownerName || '공유'} · 읽기 전용
        </span>
      )}
      <div className="flex-1" />
      {editable && (
        <button
          type="button"
          onClick={toggleLayout}
          title={island.layoutMode === 'tabs' ? '사이드바 레이아웃으로' : '탭 레이아웃으로'}
          aria-label="레이아웃 전환"
          className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
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
        className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
      >
        <Settings2 className="w-4 h-4" />
      </button>
    </div>
  );

  const body = activePanel
    ? <IslandPanelHost path={activePanel.path} label={activePanel.label || getLabel(activePanel.path)} />
    : (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
        <Palmtree className="w-8 h-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {editable
            ? '아직 담긴 화면이 없습니다. "화면 추가"로 자주 쓰는 화면을 담아보세요.'
            : '이 아일랜드에는 담긴 화면이 없습니다.'}
        </p>
      </div>
    );

  return (
    <>
      {island.layoutMode === 'sidebar' ? (
        // 보조 사이드바는 메인 사이드바에 flush(좌측 공백 0) — CLAUDE.md 간격 표준.
        <div className="min-h-screen bg-background flex">
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
        <div className="min-h-screen bg-background flex flex-col">
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
