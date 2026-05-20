import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Search, Terminal, AlertTriangle,
} from 'lucide-react';

import { MacCard } from '@/components/ui/MacCard';
import { ConfirmDialog } from '@/components/common';
import { CommandsTable } from '@/components/commands/CommandsTable';
import {
  useCommands, useCreateCommand, useDeleteCommand, useUpdateCommand,
} from '@/hooks/useCommands';
import type { CommandEntry, CommandImportance } from '@/types';

// ── 중요도 색상 매핑 ─────────────────────────────────────────────────────────
// info=slate / low=sky / medium=amber / high=orange / critical=red.
const IMPORTANCE_META: Record<CommandImportance, { label: string }> = {
  info:     { label: '정보'  },
  low:      { label: '낮음'  },
  medium:   { label: '보통'  },
  high:     { label: '높음'  },
  critical: { label: '치명'  },
};

const IMPORTANCE_OPTIONS: CommandImportance[] = ['info', 'low', 'medium', 'high', 'critical'];

// ── 메인 페이지 ─────────────────────────────────────────────────────────────
export function CommandsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterImportance, setFilterImportance] = useState<CommandImportance | ''>('');
  const [confirmDelete, setConfirmDelete] = useState<CommandEntry | null>(null);

  const queryParams = useMemo(() => ({
    q: search.trim() || undefined,
    category: filterCategory || undefined,
    importance: filterImportance || undefined,
  }), [search, filterCategory, filterImportance]);

  const { data, isLoading } = useCommands(queryParams);
  const del = useDeleteCommand();
  const updateInline = useUpdateCommand();
  const createInline = useCreateCommand();

  const entries = useMemo(() => data?.data ?? [], [data]);

  // 카테고리 목록은 등록된 항목들에서 동적으로 추출 — 필터 드롭다운에 사용.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      if (e.category) set.add(e.category);
    }
    return Array.from(set).sort();
  }, [entries]);

  return (
    <main className="mx-auto p-5 space-y-4 max-w-[1400px]">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Terminal className="w-5 h-5" /> 주요 명령어 / 파라미터 모음
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            자주 쓰는 CLI 한 줄을 의미·주의사항·중요도와 함께 기록. 파괴적 명령은
            <span className="ml-1 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border bg-red-500/15 text-red-600 border-red-500/30">
              <AlertTriangle className="w-3 h-3" /> 치명
            </span>
            으로 분류해 시각적으로 구분합니다.
          </p>
        </div>
        <button
          onClick={() => navigate('/commands/new')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90"
        >
          <Plus className="w-3.5 h-3.5" /> 새 명령어
        </button>
      </div>

      {/* 필터 / 검색 바 */}
      <MacCard bodyPadding="p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="명령어 / 의미 / 주의사항 / 태그 검색"
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-background border border-border rounded-xl"
            />
          </div>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="px-2 py-1.5 text-xs bg-background border border-border rounded-xl"
          >
            <option value="">모든 카테고리</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            value={filterImportance}
            onChange={(e) => setFilterImportance(e.target.value as CommandImportance | '')}
            className="px-2 py-1.5 text-xs bg-background border border-border rounded-xl"
          >
            <option value="">모든 중요도</option>
            {IMPORTANCE_OPTIONS.map((v) => (
              <option key={v} value={v}>{IMPORTANCE_META[v].label}</option>
            ))}
          </select>
          <span className="text-[11px] text-muted-foreground tabular-nums ml-auto">
            {entries.length}건
          </span>
        </div>
      </MacCard>

      {/* 리스트 */}
      <MacCard bodyPadding="p-0">
        {isLoading ? (
          <p className="text-xs text-muted-foreground p-5">로딩 중…</p>
        ) : (
          <CommandsTable
            entries={entries}
            onUpdate={(id, data) => updateInline.mutate({ id, data })}
            onCreate={(data) => createInline.mutate(data)}
            onDelete={(e) => setConfirmDelete(e)}
            onTogglePin={(e) => updateInline.mutate({ id: e.id, data: { pinned: !e.pinned } })}
            onOpenForm={(e) => navigate(`/commands/${e.id}/edit`)}
          />
        )}
      </MacCard>

      {confirmDelete && (
        <ConfirmDialog
          open={!!confirmDelete}
          title="명령어 삭제"
          description={`"${confirmDelete.command.slice(0, 60)}${confirmDelete.command.length > 60 ? '…' : ''}" 항목을 삭제합니다. 계속할까요?`}
          confirmLabel="삭제"
          danger
          onConfirm={async () => {
            await del.mutateAsync(confirmDelete.id);
            setConfirmDelete(null);
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </main>
  );
}
