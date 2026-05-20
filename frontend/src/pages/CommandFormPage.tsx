import { useId, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Terminal } from 'lucide-react';

import { ConfluenceUrlInput, useToast } from '@/components/common';
import {
  useCommands, useCreateCommand, useUpdateCommand,
} from '@/hooks/useCommands';
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
  const { data: listData, isLoading: listLoading } = useCommands();
  const initial = useMemo<CommandEntry | undefined>(() => {
    if (!editMode) return undefined;
    return listData?.data.find((e) => e.id === id);
  }, [editMode, listData, id]);

  return (
    <div className="min-h-screen bg-background">
      <div className="sticky top-0 z-10 bg-background/85 backdrop-blur-md border-b border-border">
        <div className="max-w-[1400px] mx-auto px-8 py-2.5 flex items-center gap-2">
          <button
            onClick={() => navigate('/commands')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
            title="목록으로"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <Terminal className="w-4 h-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{editMode ? '명령어 수정' : '새 명령어'}</span>
        </div>
      </div>

      <main className="max-w-[1400px] mx-auto px-8 pt-10 pb-16">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground tracking-tight">
            {editMode ? '명령어 수정' : '새 명령어 등록'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            자주 쓰는 CLI 한 줄을 의미·주의사항·중요도와 함께 기록합니다.
          </p>
        </div>

        <div className="bg-card border border-border rounded-2xl p-8 mac-shadow">
          {editMode && listLoading ? (
            <p className="text-sm text-muted-foreground">불러오는 중…</p>
          ) : editMode && !initial ? (
            <p className="text-sm text-destructive">명령어를 찾을 수 없습니다.</p>
          ) : (
            <CommandForm
              initial={initial}
              onCancel={() => navigate('/commands')}
              onSaved={() => navigate('/commands')}
            />
          )}
        </div>
      </main>
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
    const payload: CommandEntryCreate = {
      category: category.trim() || undefined,
      command: command.trim(),
      description: description.trim() || undefined,
      caution: caution.trim() || undefined,
      examples: examples.trim() || undefined,
      tags: tags.trim() || undefined,
      importance,
      pinned,
      confluenceUrl: confluenceUrl.trim() || undefined,
    };
    try {
      if (initial) {
        await update.mutateAsync({ id: initial.id, data: payload });
        toast.success('수정 완료', '명령어 정보가 업데이트되었습니다.');
      } else {
        await create.mutateAsync(payload);
        toast.success('등록 완료', '새 명령어가 추가되었습니다.');
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
          <label htmlFor={f('cat')} className="block text-xs text-muted-foreground mb-1">카테고리</label>
          <input
            id={f('cat')}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="kubectl / helm / docker / linux …"
            className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl"
          />
        </div>
        <div>
          <label htmlFor={f('imp')} className="block text-xs text-muted-foreground mb-1">중요도</label>
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
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
            상단 고정
          </label>
        </div>
      </div>

      <div>
        <label htmlFor={f('cmd')} className="block text-xs text-muted-foreground mb-1">명령어 *</label>
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
        <label htmlFor={f('desc')} className="block text-xs text-muted-foreground mb-1">의미</label>
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
        <label htmlFor={f('caution')} className="block text-xs text-muted-foreground mb-1">주의사항</label>
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
        <label htmlFor={f('ex')} className="block text-xs text-muted-foreground mb-1">예시 (선택)</label>
        <textarea
          id={f('ex')}
          value={examples}
          onChange={(e) => setExamples(e.target.value)}
          rows={3}
          placeholder="kubectl drain worker-3 --ignore-daemonsets --delete-emptydir-data"
          className="w-full px-3 py-2 text-xs bg-background border border-border rounded-xl font-mono"
        />
      </div>

      <div>
        <label htmlFor={f('tags')} className="block text-xs text-muted-foreground mb-1">태그 (쉼표 구분)</label>
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

      {error && <div className="text-xs text-red-500">{error}</div>}

      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded-xl bg-secondary text-secondary-foreground"
        >
          취소
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="px-3 py-1.5 text-xs rounded-xl bg-primary text-primary-foreground disabled:opacity-60"
        >
          {pending ? '저장 중…' : (initial ? '수정' : '등록')}
        </button>
      </div>
    </div>
  );
}
