import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Search, Terminal, AlertTriangle,
} from 'lucide-react';

import { MacCard } from '@/components/ui/MacCard';
import { ConfirmDialog, ErrorState, LoadingState, PageShell, useToast } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { CommandsTable } from '@/components/commands/CommandsTable';
import {
  useCommandCategories, useCommands, useCreateCommand, useDeleteCommand, useUpdateCommand,
} from '@/hooks/useCommands';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { CommandEntry, CommandImportance } from '@/types';
import { formatApiError } from '@/lib/utils';

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

  // 검색어는 디바운스 — 키 입력마다 요청·표 깜빡임이 생기지 않게(D-148). 이전 결과는 hook 의
  // `placeholderData: keepPreviousData` 가 유지한다.
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const queryParams = useMemo(() => {
    const p = {
      q: debouncedSearch || undefined,
      category: filterCategory || undefined,
      importance: filterImportance || undefined,
    };
    // 필터가 하나도 없으면 undefined — 카테고리 옵션용 전체 목록(useCommandCategories)과 캐시를 공유한다.
    return p.q || p.category || p.importance ? p : undefined;
  }, [debouncedSearch, filterCategory, filterImportance]);

  const { data, isLoading, isError, error, refetch, isFetching } = useCommands(queryParams);
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const del = useDeleteCommand();
  const updateInline = useUpdateCommand();
  const createInline = useCreateCommand();
  const toast = useToast();
  // 인라인 수정·추가·고정 실패가 무음이면 저장됐다고 믿게 된다(D-143) — 실패는 토스트로 알린다.
  const onInlineError = (title: string) => (e: unknown) => toast.error(title, formatApiError(e));

  const entries = useMemo(() => data?.data ?? [], [data]);

  // 카테고리 옵션은 필터 없는 전체 목록에서 — 고른 카테고리가 드롭다운에서 나머지를 지우지 않게(D-148).
  // 저장된 URL 등으로 목록에 없는 값이 선택돼 있어도 옵션에 남겨 둔다.
  const allCategories = useCommandCategories();
  const categories = useMemo(
    () => (filterCategory && !allCategories.includes(filterCategory)
      ? [...allCategories, filterCategory].sort()
      : allCategories),
    [allCategories, filterCategory],
  );

  return (
    <PageShell density="hub" className="space-y-4">
      <PageHeader
        icon={Terminal}
        title="주요 명령어 / 파라미터 모음"
        description={
          <>
            자주 쓰는 CLI 한 줄을 의미·주의사항·중요도와 함께 기록합니다. 파괴적 명령은
            <span className="mx-1 inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border bg-status-critical/15 text-status-critical border-status-critical/30">
              <AlertTriangle className="w-3 h-3" /> 치명
            </span>
            으로 분류해 구분합니다.
          </>
        }
        actions={
          <button
            onClick={() => navigate('/commands/new')}
            disabled={!canOperate}
            title={withHint('명령어 추가')}
            aria-label={ariaWithHint('명령어 추가')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" /> 명령어 추가
          </button>
        }
      />

      {/* 리스트 — D-122: 필터 바를 별도 툴바 카드 대신 목록 카드의 헤더 바로 올림 */}
      <MacCard
        bodyPadding="p-0"
        actions={
          <div className="flex items-center gap-2 flex-wrap w-full">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="명령어 검색"
                placeholder="명령어 / 의미 / 주의사항 / 태그 검색"
                className="w-full pl-8 pr-3 py-1.5 text-sm bg-background border border-border rounded-xl"
              />
            </div>
            <select
              aria-label="카테고리 필터"
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="px-2 py-1.5 text-sm bg-background border border-border rounded-xl"
            >
              <option value="">모든 카테고리</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select
              aria-label="중요도 필터"
              value={filterImportance}
              onChange={(e) => setFilterImportance(e.target.value as CommandImportance | '')}
              className="px-2 py-1.5 text-sm bg-background border border-border rounded-xl"
            >
              <option value="">모든 중요도</option>
              {IMPORTANCE_OPTIONS.map((v) => (
                <option key={v} value={v}>{IMPORTANCE_META[v].label}</option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground tabular-nums ml-auto" aria-live="polite">
              {isFetching && !isLoading ? '검색 중…' : `${entries.length}건`}
            </span>
          </div>
        }
      >
        {isLoading ? (
          <LoadingState compact />
        ) : isError ? (
          <ErrorState error={error} title="명령어 목록을 불러오지 못했습니다" onRetry={() => { void refetch(); }} compact />
        ) : (
          <CommandsTable
            entries={entries}
            onUpdate={(id, data) => updateInline.mutate({ id, data }, { onError: onInlineError('수정 실패') })}
            onCreate={(data) => createInline.mutate(data, { onError: onInlineError('추가 실패') })}
            onDelete={(e) => setConfirmDelete(e)}
            onTogglePin={(e) => updateInline.mutate(
              { id: e.id, data: { pinned: !e.pinned } },
              { onError: onInlineError(e.pinned ? '고정 해제 실패' : '고정 실패') },
            )}
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
          busy={del.isPending}
          onConfirm={async () => {
            // ConfirmDialog 는 onConfirm 결과를 기다리지 않는다 — 실패는 여기서 잡아 토스트로(D-143).
            try {
              await del.mutateAsync(confirmDelete.id);
              setConfirmDelete(null);
            } catch (e) {
              toast.error('명령어 삭제 실패', formatApiError(e));
            }
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </PageShell>
  );
}
