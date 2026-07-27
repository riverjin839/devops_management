import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Copy, LayoutGrid, PanelLeft, Plus, Share2, Sparkles, Trash2, Users,
} from 'lucide-react';
import { SidePane, ConfirmDialog, ClusterIconPicker, useToast } from '@/components/common';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import {
  useIslands, useCreateIsland, useUpdateIsland, useDeleteIsland, useCloneIsland,
} from '@/hooks/useIslands';
import { useIslandStore } from '@/stores/islandStore';
import type { Island } from '@/types';

interface IslandManagerPaneProps {
  open: boolean;
  onClose: () => void;
  /** 현재 열려 있는 아일랜드 — 목록에서 강조. */
  currentId: string | null;
}

function IslandIcon({ icon, className }: { icon?: string | null; className?: string }) {
  const resolved = resolveClusterIcon(icon);
  if (resolved?.kind === 'lucide') {
    const Icon = resolved.Component;
    return <Icon className={className} />;
  }
  if (resolved?.kind === 'image') {
    return <img src={resolved.value} alt="" className={`${className ?? ''} object-contain rounded-sm`} />;
  }
  if (resolved?.kind === 'text') {
    return <span className="text-base leading-none">{resolved.value}</span>;
  }
  return <Sparkles className={className} />;
}

/** 아일랜드 목록 관리 — 생성/이름·아이콘 편집/레이아웃 전환/공유/복제/삭제. */
export function IslandManagerPane({ open, onClose, currentId }: IslandManagerPaneProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data } = useIslands();
  const createIsland = useCreateIsland();
  const updateIsland = useUpdateIsland();
  const deleteIsland = useDeleteIsland();
  const cloneIsland = useCloneIsland();
  const setLastIslandId = useIslandStore((s) => s.setLastIslandId);

  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Island | null>(null);
  const [iconTarget, setIconTarget] = useState<Island | null>(null);

  const mine = data?.data ?? [];
  const shared = data?.shared ?? [];

  const handleCreate = () => {
    const name = newName.trim();
    if (!name) return;
    createIsland.mutate(
      { name, layoutMode: 'tabs', panels: [] },
      {
        onSuccess: (res) => {
          setNewName('');
          setLastIslandId(res.data.id);
          navigate(`/island/${res.data.id}`);
          toast.success('아일랜드 생성', `"${res.data.name}" 을(를) 만들었습니다.`);
        },
        onError: () => toast.error('아일랜드 생성 실패'),
      },
    );
  };

  const handleClone = (island: Island) => {
    cloneIsland.mutate(island.id, {
      onSuccess: (res) => {
        setLastIslandId(res.data.id);
        navigate(`/island/${res.data.id}`);
        toast.success('복제 완료', `"${res.data.name}" 이(가) 내 아일랜드에 추가되었습니다.`);
      },
      onError: () => toast.error('복제 실패'),
    });
  };

  const confirmDelete = () => {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    deleteIsland.mutate(target.id, {
      onSuccess: () => {
        if (currentId === target.id) {
          setLastIslandId(null);
          navigate('/island');
        }
        toast.success('삭제 완료', `"${target.name}" 을(를) 삭제했습니다.`);
      },
      onError: () => toast.error('삭제 실패'),
    });
  };

  return (
    <>
      <SidePane open={open} onClose={onClose} title="아일랜드 관리" width="480px">
        {/* 새 아일랜드 */}
        <div className="flex gap-2 mb-5">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
            placeholder="새 아일랜드 이름"
            aria-label="새 아일랜드 이름"
            className="flex-1 min-w-0 px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button
            type="button"
            onClick={handleCreate}
            disabled={!newName.trim() || createIsland.isPending}
            className="flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground disabled:opacity-50 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            만들기
          </button>
        </div>

        {/* 내 아일랜드 */}
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          내 아일랜드
        </p>
        <div className="space-y-2 mb-6">
          {mine.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">아직 만든 아일랜드가 없습니다.</p>
          )}
          {mine.map((island) => (
            <div
              key={island.id}
              className={`flex items-center gap-2 p-2.5 rounded-xl border transition-colors ${
                island.id === currentId ? 'border-primary/50 bg-primary/5' : 'border-border bg-card'
              }`}
            >
              <button
                type="button"
                onClick={() => setIconTarget(island)}
                title="아이콘 변경"
                aria-label={`${island.name} 아이콘 변경`}
                className="flex items-center justify-center w-8 h-8 rounded-lg bg-secondary text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              >
                <IslandIcon icon={island.icon} className="w-4 h-4" />
              </button>
              <input
                type="text"
                defaultValue={island.name}
                aria-label={`${island.name} 이름`}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== island.name) updateIsland.mutate({ id: island.id, name });
                  else e.target.value = island.name;
                }}
                className="flex-1 min-w-0 px-2 py-1 text-sm bg-transparent border border-transparent rounded-lg hover:border-border focus:border-border focus:outline-none"
              />
              <button
                type="button"
                onClick={() => updateIsland.mutate({
                  id: island.id,
                  layoutMode: island.layoutMode === 'tabs' ? 'sidebar' : 'tabs',
                })}
                title={island.layoutMode === 'tabs' ? '탭 레이아웃 (클릭 시 사이드바)' : '사이드바 레이아웃 (클릭 시 탭)'}
                aria-label="레이아웃 전환"
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors flex-shrink-0"
              >
                {island.layoutMode === 'tabs'
                  ? <LayoutGrid className="w-4 h-4" />
                  : <PanelLeft className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={() => updateIsland.mutate({ id: island.id, isShared: !island.isShared })}
                title={island.isShared ? '팀에 공유됨 (클릭 시 비공개)' : '비공개 (클릭 시 팀에 공유)'}
                aria-label="공유 전환"
                className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${
                  island.isShared
                    ? 'text-primary bg-primary/10'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                <Share2 className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(island)}
                title="삭제"
                aria-label={`${island.name} 삭제`}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-status-critical-soft hover:text-status-critical transition-colors flex-shrink-0"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>

        {/* 공유된 아일랜드 — 읽기 전용, 복제만 가능 */}
        {shared.length > 0 && (
          <>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Users className="w-3.5 h-3.5" />
              팀 공유 아일랜드
            </p>
            <div className="space-y-2">
              {shared.map((island) => (
                <div key={island.id} className="flex items-center gap-2 p-2.5 rounded-xl border border-border bg-card">
                  <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-secondary text-muted-foreground flex-shrink-0">
                    <IslandIcon icon={island.icon} className="w-4 h-4" />
                  </span>
                  <button
                    type="button"
                    onClick={() => navigate(`/island/${island.id}`)}
                    className="flex-1 min-w-0 text-left"
                  >
                    <span className="block text-sm text-foreground truncate">{island.name}</span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {island.ownerName || '알 수 없음'} · 패널 {island.panels.length}개
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleClone(island)}
                    title="내 아일랜드로 복제"
                    aria-label={`${island.name} 복제`}
                    className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors flex-shrink-0"
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </SidePane>

      <ConfirmDialog
        open={!!pendingDelete}
        title="아일랜드 삭제"
        description={`"${pendingDelete?.name ?? ''}" 을(를) 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {iconTarget && (
        <ClusterIconPicker
          value={iconTarget.icon}
          title="아일랜드 아이콘 선택"
          clusterName={iconTarget.name}
          onChange={(next) => updateIsland.mutate({ id: iconTarget.id, icon: next })}
          onClose={() => setIconTarget(null)}
        />
      )}
    </>
  );
}
