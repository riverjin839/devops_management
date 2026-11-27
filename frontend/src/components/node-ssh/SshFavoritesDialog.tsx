import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, RotateCcw, X } from 'lucide-react';
import { ConfirmDialog, useModalA11y, useToast } from '@/components/common';
import { useSshFavoriteMutations } from '@/hooks/useSshFavorites';
import { judgeCommand } from '@/lib/dangerCommand';
import { favoriteIsDanger } from './favoriteDanger';
import { formatApiError } from '@/lib/utils';
import type { SshFavorite, SshFavoriteRunMode } from '@/types';

interface Props {
  open: boolean;
  favorites: SshFavorite[];
  onClose: () => void;
}

interface Draft {
  name: string;
  description: string;
  command: string;
  runMode: SshFavoriteRunMode;
}

const EMPTY: Draft = { name: '', description: '', command: '', runMode: 'insert' };
const NEW = '__new__';
const INPUT = 'w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary';

function toDraft(f: SshFavorite): Draft {
  return { name: f.name, description: f.description ?? '', command: f.command, runMode: f.runMode };
}

/**
 * SSH 즐겨찾기 명령 편집 — 왼쪽 목록(순서 바꾸기), 오른쪽 편집 폼. 내 계정에 저장(서버)되어 다른 PC·브라우저에서도 같다.
 * 기본 명령은 옛 커널 파라미터 콘솔 프리셋이고, 고치거나 지워도 「기본값 복원」으로 되돌린다.
 */
export function SshFavoritesDialog({ open, favorites, onClose }: Props) {
  const dialogRef = useModalA11y(open, onClose);
  const titleId = useId();
  const fid = useId();
  const toast = useToast();
  const m = useSshFavoriteMutations();
  const [selectedId, setSelectedId] = useState<string>('');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);

  const current = favorites.find((f) => f.id === selectedId) ?? null;
  const isNew = selectedId === NEW;
  const base = isNew ? EMPTY : current ? toDraft(current) : EMPTY;
  const dirty = JSON.stringify(base) !== JSON.stringify(draft);
  // 손대지 않은 기본 명령은 검증된 조회 명령으로 본다(favoriteIsDanger 와 같은 규칙).
  const untouchedPreset = !!current?.presetKey && !current.modified && draft.command === current.command;
  const verdict = useMemo(() => {
    if (!draft.command.trim()) return null;
    if (untouchedPreset) return { readOnly: true, subcommand: '', reason: null };
    return judgeCommand(draft.command, 'shell');
  }, [draft.command, untouchedPreset]);
  const canSave = draft.name.trim().length > 0 && draft.command.trim().length > 0 && dirty;
  const busy = m.create.isPending || m.update.isPending || m.remove.isPending || m.reorder.isPending || m.reset.isPending;

  // 열 때 첫 항목을 고른다. 고른 항목이 사라지면(삭제·복원) 첫 항목으로.
  useEffect(() => {
    if (!open) return;
    if (selectedId === NEW) return;
    if (!favorites.some((f) => f.id === selectedId)) {
      const first = favorites[0];
      setSelectedId(first?.id ?? NEW);
      setDraft(first ? toDraft(first) : EMPTY);
    }
  }, [open, favorites, selectedId]);

  if (!open) return null;

  const doSelect = (id: string) => {
    setSelectedId(id);
    const f = favorites.find((x) => x.id === id);
    setDraft(f ? toDraft(f) : EMPTY);
  };
  const select = (id: string) => {
    if (id === selectedId) return;
    if (dirty) setPendingSelect(id);
    else doSelect(id);
  };
  const fail = (title: string) => (e: unknown) => toast.error(title, formatApiError(e));

  const save = () => {
    if (!canSave || busy) return;
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      command: draft.command.replace(/\s+$/, ''),
      runMode: draft.runMode,
    };
    if (isNew) {
      m.create.mutate(body, {
        onSuccess: (row) => { setSelectedId(row.id); setDraft(toDraft(row)); toast.success('즐겨찾기를 추가했습니다'); },
        onError: fail('즐겨찾기를 추가하지 못했습니다'),
      });
    } else if (current) {
      m.update.mutate({ id: current.id, data: body }, {
        onSuccess: (row) => { setDraft(toDraft(row)); toast.success('저장했습니다'); },
        onError: fail('저장하지 못했습니다'),
      });
    }
  };
  const move = (id: string, delta: -1 | 1) => {
    const ids = favorites.map((f) => f.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    m.reorder.mutate(ids, { onError: fail('순서를 바꾸지 못했습니다') });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative bg-card border border-border rounded-md shadow-card w-full max-w-4xl mx-4 h-[min(720px,calc(100vh_-_48px))] flex flex-col overflow-hidden"
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border">
          <h2 id={titleId} className="text-sm font-semibold">즐겨찾기 명령</h2>
          <p className="text-sm text-muted-foreground truncate">내 계정에 저장돼서 다른 PC와 브라우저에서도 그대로 보입니다</p>
          <button type="button" onClick={onClose} title="닫기" aria-label="즐겨찾기 편집 닫기"
            className="ml-auto p-1 rounded-xl hover:bg-secondary text-muted-foreground">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex flex-col md:flex-row">
          {/* 목록 */}
          <div className="md:w-80 md:border-r border-b md:border-b-0 border-border flex flex-col min-h-0 max-h-[40%] md:max-h-none">
            <div className="p-3 flex gap-2">
              <button type="button" onClick={() => select(NEW)} disabled={busy}
                className="flex-1 px-3 py-1.5 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-1">
                <Plus className="w-4 h-4" aria-hidden="true" /> 새 명령
              </button>
              <button type="button" onClick={() => setConfirmReset(true)} disabled={busy}
                title="기본 명령을 원래 내용·순서로 되돌립니다(지운 것도 되살림). 내가 만든 명령은 그대로 둡니다."
                className="px-3 py-1.5 text-sm rounded-xl border border-border hover:bg-secondary disabled:opacity-50 flex items-center gap-1">
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> 기본값 복원
              </button>
            </div>
            <ul className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-0.5" aria-label="즐겨찾기 목록">
              {isNew && (
                <li className="px-2 py-1.5 rounded-md bg-accent text-sm font-medium">새 명령 (저장 전)</li>
              )}
              {favorites.map((f, i) => {
                const danger = favoriteIsDanger(f);
                const active = f.id === selectedId;
                return (
                  <li key={f.id} className={`group flex items-center gap-1 rounded-md ${active ? 'bg-accent' : 'hover:bg-secondary'}`}>
                    <button type="button" onClick={() => select(f.id)} aria-current={active ? 'true' : undefined}
                      className={`flex-1 min-w-0 text-left px-2 py-1.5 text-sm flex items-center gap-1.5 ${active ? 'font-medium' : ''}`}>
                      <span className="truncate">{f.name}</span>
                      {danger && <span className="text-xs px-1.5 rounded-full bg-status-critical/10 text-status-critical border border-status-critical/30 shrink-0">변경 명령</span>}
                      <span className="ml-auto text-xs text-muted-foreground shrink-0 font-normal">
                        {f.presetKey ? (f.modified ? '기본 · 수정됨' : '기본') : '내 명령'}
                      </span>
                    </button>
                    <button type="button" onClick={() => move(f.id, -1)} disabled={i === 0 || busy}
                      title="위로" aria-label={`${f.name} 위로`} className="p-1 rounded-xl text-muted-foreground hover:bg-background disabled:opacity-30">
                      <ArrowUp className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => move(f.id, 1)} disabled={i === favorites.length - 1 || busy}
                      title="아래로" aria-label={`${f.name} 아래로`} className="p-1 mr-1 rounded-xl text-muted-foreground hover:bg-background disabled:opacity-30">
                      <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* 편집 */}
          <div className="flex-1 min-w-0 min-h-0 overflow-y-auto p-5 flex flex-col gap-3">
            <div>
              <label htmlFor={`${fid}-name`} className="block text-sm text-muted-foreground mb-1">이름</label>
              <input id={`${fid}-name`} value={draft.name} maxLength={120}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={INPUT} />
            </div>
            <div>
              <label htmlFor={`${fid}-desc`} className="block text-sm text-muted-foreground mb-1">
                설명 <span className="text-xs">(선택, 메뉴에 회색으로 보입니다)</span>
              </label>
              <input id={`${fid}-desc`} value={draft.description} maxLength={500}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={INPUT} />
            </div>
            <div>
              <label htmlFor={`${fid}-cmd`} className="block text-sm text-muted-foreground mb-1">명령</label>
              <textarea id={`${fid}-cmd`} rows={6} value={draft.command} maxLength={8000}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                placeholder="예: journalctl -u kubelet -n 200 --no-pager"
                className={`${INPUT} font-mono text-xs resize-y`} />
              {verdict && (
                <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={`px-2 py-0.5 rounded-full border ${verdict.readOnly
                    ? 'bg-secondary text-muted-foreground border-border'
                    : 'bg-status-critical/10 text-status-critical border-status-critical/30'}`}>
                    {verdict.readOnly ? '조회 명령' : '변경 명령'}
                  </span>
                  {verdict.readOnly ? '바로 실행해도 됩니다.' : `${verdict.reason ?? '조회 명령이 아닙니다.'} 바로 실행이면 보내기 전에 확인합니다.`}
                </p>
              )}
            </div>
            <fieldset className="border border-border rounded-md px-4 py-3 flex flex-col gap-2">
              <legend className="px-1 text-sm text-muted-foreground">누르면</legend>
              {(['insert', 'run'] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-2 text-sm">
                  <input type="radio" name={`${fid}-mode`} checked={draft.runMode === mode}
                    onChange={() => setDraft({ ...draft, runMode: mode })} />
                  {mode === 'insert' ? '입력만 한다 (Enter 는 직접 누름)' : '입력하고 바로 실행한다 (변경 명령은 실행 전에 확인)'}
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-muted-foreground leading-relaxed">
              기본 명령은 기존 커널 파라미터 콘솔의 조회 프리셋을 옮긴 것입니다. 고칠 수도 지울 수도 있고, 「기본값 복원」을 누르면 원래대로 돌아옵니다.
              비밀번호·토큰 같은 비밀은 명령에 넣지 마세요(서버에 그대로 저장됩니다).
            </p>
            <div className="mt-auto pt-2 flex items-center gap-2">
              {!isNew && current && (
                <button type="button" onClick={() => setConfirmDelete(true)} disabled={busy}
                  className="px-3 py-1.5 text-sm rounded-xl border border-status-critical/40 text-status-critical hover:bg-status-critical/10 disabled:opacity-50">
                  삭제
                </button>
              )}
              <span className="ml-auto text-xs text-muted-foreground">{dirty ? '저장하지 않은 변경이 있습니다' : ''}</span>
              <button type="button" onClick={() => setDraft(base)} disabled={!dirty || busy}
                className="px-3 py-1.5 text-sm rounded-xl border border-border hover:bg-secondary disabled:opacity-50">
                변경 취소
              </button>
              <button type="button" onClick={save} disabled={!canSave || busy}
                className="px-4 py-1.5 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {isNew ? '추가' : '저장'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingSelect !== null}
        title="저장하지 않은 변경"
        description="편집 중인 내용을 저장하지 않고 다른 명령으로 옮깁니다."
        confirmLabel="버리고 이동"
        onCancel={() => setPendingSelect(null)}
        onConfirm={() => {
          const id = pendingSelect;
          setPendingSelect(null);
          if (id) doSelect(id);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        danger
        title="즐겨찾기 삭제"
        description={current ? `「${current.name}」을(를) 지웁니다.${current.presetKey ? ' 기본 명령이라 「기본값 복원」으로 되살릴 수 있습니다.' : ''}` : undefined}
        confirmLabel="삭제"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          if (current) m.remove.mutate(current.id, { onError: fail('삭제하지 못했습니다') });
        }}
      />
      <ConfirmDialog
        open={confirmReset}
        title="기본값 복원"
        description="기본 명령을 원래 내용·순서로 되돌리고 지운 기본 명령도 되살립니다. 내가 만든 명령은 그대로 뒤에 남습니다."
        confirmLabel="복원"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          m.reset.mutate(undefined, {
            onSuccess: () => toast.success('기본값으로 되돌렸습니다'),
            onError: fail('기본값으로 되돌리지 못했습니다'),
          });
        }}
      />
    </div>
  );
}
