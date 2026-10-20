import { useId, useMemo, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { useNavigate, useParams } from 'react-router-dom';

import { ConfluenceUrlInput, useToast, PageShell, LoadingState, EmptyState, ErrorState } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import {
  useCommands, useCreateCommand, useUpdateCommand, type CommandEntryPatch,
} from '@/hooks/useCommands';
import { useCanOperate } from '@/hooks/useCanOperate';
import type { CommandEntry, CommandEntryCreate, CommandImportance } from '@/types';
import { formatApiError } from '@/lib/utils';

const IMPORTANCE_OPTIONS: CommandImportance[] = ['info', 'low', 'medium', 'high', 'critical'];
const IMPORTANCE_LABEL: Record<CommandImportance, string> = {
  info: '정보', low: '낮음', medium: '보통', high: '높음', critical: '치명',
};

export function CommandFormPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const editMode = !!id;

  // 수정 모드: 목록 fetch 결과에서 해당 id 의 entry 를 찾는다 (단건 fetch 엔드포인트 대신 캐시 재활용).
  const {
    data: listData, isLoading: listLoading, isError: listError, error: listErrorObj, refetch,
  } = useCommands();
  const initial = useMemo<CommandEntry | undefined>(() => {
    if (!editMode) return undefined;
    return listData?.data.find((e) => e.id === id);
  }, [editMode, listData, id]);

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="doc">
        <PageHeader
          title={editMode ? '명령어 수정' : '명령어 추가'}
          description="자주 쓰는 CLI 한 줄을 의미·주의사항·중요도와 함께 기록합니다."
          back={{ to: '/commands', label: '목록으로' }}
          className="mb-8"
        />

        {editMode && listLoading ? (
          <LoadingState />
        ) : editMode && listError ? (
          // 조회 실패를 "찾을 수 없음"으로 보여주지 않는다(D-137) — 없음은 조회 성공 + 목록에 없을 때만.
          <ErrorState error={listErrorObj} title="명령어를 불러오지 못했습니다" onRetry={() => { void refetch(); }} />
        ) : editMode && !initial ? (
          <EmptyState
            title="명령어를 찾을 수 없습니다"
            description="삭제됐거나 주소가 잘못됐을 수 있습니다. 목록에서 다시 선택하세요."
            action={{ label: '목록으로', variant: 'secondary', onClick: () => navigate('/commands') }}
          />
        ) : (
          <MacCard title="명령어 정보" bodyPadding="p-8">
            <CommandForm
              initial={initial}
              onCancel={() => navigate('/commands')}
              onSaved={() => navigate('/commands')}
            />
          </MacCard>
        )}
      </PageShell>
    </div>
  );
}

interface CommandFormProps {
  initial?: CommandEntry;
  onCancel: () => void;
  onSaved: () => void;
}

function CommandForm({ initial, onCancel, onSaved }: CommandFormProps) {
  const create = useCreateCommand();
  const update = useUpdateCommand();
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate();

  const [category, setCategory] = useState(initial?.category ?? '');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [caution, setCaution] = useState(initial?.caution ?? '');
  const [examples, setExamples] = useState(initial?.examples ?? '');
  const [tags, setTags] = useState(initial?.tags ?? '');
  const [importance, setImportance] = useState<CommandImportance>(initial?.importance ?? 'medium');
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [confluenceUrl, setConfluenceUrl] = useState(initial?.confluenceUrl ?? '');
  const [error, setError] = useState<string | null>(null);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const submit = async () => {
    setError(null);
    if (!command.trim()) {
      setError('command 는 필수입니다.');
      return;
    }
    // 수정 모드에서 비운 선택 필드는 null — undefined 면 JSON 에서 빠져 서버가 옛 값을 유지한다(D-144).
    const blank = initial ? null : undefined;
    const opt = (v: string) => v.trim() || blank;
    const fields = {
      category: opt(category),
      description: opt(description),
      caution: opt(caution),
      examples: opt(examples),
      tags: opt(tags),
      confluenceUrl: opt(confluenceUrl),
    };
    try {
      if (initial) {
        const patch: CommandEntryPatch = { ...fields, command: command.trim(), importance, pinned };
        await update.mutateAsync({ id: initial.id, data: patch });
        toast.success('수정됨', '명령어 정보가 업데이트되었습니다.');
      } else {
        const payload: CommandEntryCreate = {
          category: fields.category ?? undefined,
          command: command.trim(),
          description: fields.description ?? undefined,
          caution: fields.caution ?? undefined,
          examples: fields.examples ?? undefined,
          tags: fields.tags ?? undefined,
          importance,
          pinned,
          confluenceUrl: fields.confluenceUrl ?? undefined,
        };
        await create.mutateAsync(payload);
        toast.success('명령어 추가됨');
      }
      onSaved();
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const pending = create.isPending || update.isPending;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label htmlFor={f('cat')} className="block text-sm text-muted-foreground mb-1">카테고리</label>
          <input
            id={f('cat')}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="kubectl / helm / docker / linux …"
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
          />
        </div>
        <div>
          <label htmlFor={f('imp')} className="block text-sm text-muted-foreground mb-1">중요도</label>
          <select
            id={f('imp')}
            value={importance}
            onChange={(e) => setImportance(e.target.value as CommandImportance)}
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
          >
            {IMPORTANCE_OPTIONS.map((v) => (
              <option key={v} value={v}>{IMPORTANCE_LABEL[v]} ({v})</option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            상단 고정
          </label>
        </div>
      </div>

      <div>
        <label htmlFor={f('cmd')} className="block text-sm text-muted-foreground mb-1">명령어 *</label>
        <textarea
          id={f('cmd')}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          rows={3}
          placeholder="kubectl drain <node> --ignore-daemonsets --delete-emptydir-data"
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl font-mono"
        />
      </div>

      <div>
        <label htmlFor={f('desc')} className="block text-sm text-muted-foreground mb-1">의미</label>
        <textarea
          id={f('desc')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="해당 노드의 모든 워크로드를 다른 노드로 이동시킵니다."
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
        />
      </div>

      <div>
        <label htmlFor={f('caution')} className="block text-sm text-muted-foreground mb-1">주의사항</label>
        <textarea
          id={f('caution')}
          value={caution}
          onChange={(e) => setCaution(e.target.value)}
          rows={2}
          placeholder="DaemonSet 은 무시되며, 빈 디렉토리 볼륨도 함께 삭제됩니다 — 재기동 전 백업 필요."
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
        />
      </div>

      <div>
        <label htmlFor={f('ex')} className="block text-sm text-muted-foreground mb-1">예시 (선택)</label>
        <textarea
          id={f('ex')}
          value={examples}
          onChange={(e) => setExamples(e.target.value)}
          rows={3}
          placeholder="kubectl drain worker-3 --ignore-daemonsets --delete-emptydir-data"
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl font-mono"
        />
      </div>

      <div>
        <label htmlFor={f('tags')} className="block text-sm text-muted-foreground mb-1">태그 (쉼표 구분)</label>
        <input
          id={f('tags')}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="node, maintenance, drain"
          className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
        />
      </div>

      <ConfluenceUrlInput
        id={f('confluence')}
        value={confluenceUrl}
        onChange={setConfluenceUrl}
      />

      {error && <div className="text-sm text-status-critical">{error}</div>}

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm rounded-xl bg-secondary text-secondary-foreground"
        >
          취소
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending || !canOperate}
          title={withHint(initial ? '수정' : '등록')}
          aria-label={canOperate ? undefined : ariaWithHint(initial ? '수정' : '등록')}
          className="px-3 py-1.5 text-sm rounded-xl bg-primary text-primary-foreground disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {pending ? '저장 중…' : (initial ? '수정' : '등록')}
        </button>
      </div>
    </div>
  );
}
