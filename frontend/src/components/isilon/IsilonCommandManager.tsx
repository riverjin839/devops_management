import { useId, useState } from 'react';
import { X, Plus, Trash2, Loader2, Lock, ShieldCheck } from 'lucide-react';
import type { IsilonCommand, IsilonCommandSection } from '@/types';
import {
  useIsilonCommands,
  useCreateIsilonCommand,
  useUpdateIsilonCommand,
  useDeleteIsilonCommand,
} from '@/hooks/useIsilonNfs';
import { useToast, ConfirmDialog } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';

const INP = 'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';

const SECTIONS: IsilonCommandSection[] = ['exports', 'nfs_settings', 'quotas', 'clients', 'node_health', 'custom'];

interface Props {
  serverId?: string;
  onClose: () => void;
}

function errMessage(e: unknown, fallback: string): string {
  const resp = (e as { response?: { data?: { detail?: string } } })?.response;
  return resp?.data?.detail ?? fallback;
}

const EMPTY = {
  key: '', label: '', section: 'custom' as IsilonCommandSection,
  command: '', parseMode: 'text' as 'json' | 'text', timeoutSeconds: 15,
  enabled: true, showOnOverview: true, sortOrder: 100,
};

export function IsilonCommandManager({ serverId, onClose }: Props) {
  const dialogRef = useModalA11y(true, onClose);
  const titleId = useId();
  const toast = useToast();
  const { data: commands = [], isLoading } = useIsilonCommands(serverId);
  const createMut = useCreateIsilonCommand();
  const updateMut = useUpdateIsilonCommand();
  const deleteMut = useDeleteIsilonCommand();

  const [editing, setEditing] = useState<IsilonCommand | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const startNew = () => { setEditing(null); setForm({ ...EMPTY }); };
  const startEdit = (c: IsilonCommand) => {
    setEditing(c);
    setForm({
      key: c.key, label: c.label, section: c.section, command: c.command,
      parseMode: c.parseMode, timeoutSeconds: c.timeoutSeconds,
      enabled: c.enabled, showOnOverview: c.showOnOverview, sortOrder: c.sortOrder,
    });
  };

  const save = async () => {
    if (!form.command.trim() || !form.label.trim() || (!editing && !form.key.trim())) {
      toast.error('key · label · command 는 필수입니다.');
      return;
    }
    try {
      if (editing) {
        await updateMut.mutateAsync({
          id: editing.id,
          data: {
            label: form.label, section: form.section, command: form.command,
            parseMode: form.parseMode, timeoutSeconds: form.timeoutSeconds,
            enabled: form.enabled, showOnOverview: form.showOnOverview, sortOrder: form.sortOrder,
          },
        });
      } else {
        await createMut.mutateAsync({ ...form, serverId: serverId ?? null });
      }
      toast.success('저장되었습니다.');
      startNew();
    } catch (e) {
      // 422 = 부하/변경 명령 거부 등 — 서버 메시지 그대로 노출
      toast.error('저장 실패', errMessage(e, '알 수 없는 오류'));
    }
  };

  const doDelete = async (id: string) => {
    try {
      await deleteMut.mutateAsync(id);
      toast.success('삭제되었습니다.');
      if (editing?.id === id) startNew();
    } catch (e) {
      toast.error('삭제 실패', errMessage(e, '오류'));
    } finally {
      setConfirmId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-card rounded-2xl border border-border mac-shadow w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div>
            <h3 id={titleId} className="text-sm font-semibold">isi 명령 관리</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {serverId ? '글로벌 기본 + 이 서버 전용 명령' : '글로벌 기본 명령'} · 읽기 전용 조회 명령만 등록됩니다
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-4 p-5">
          {/* 목록 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">등록된 명령</span>
              <button onClick={startNew} className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border hover:bg-muted">
                <Plus className="w-3.5 h-3.5" /> 새 명령
              </button>
            </div>
            {isLoading ? (
              <div className="text-sm text-muted-foreground py-6 text-center"><Loader2 className="w-4 h-4 animate-spin inline" /> 불러오는 중…</div>
            ) : (
              <ul className="space-y-1.5">
                {commands.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => startEdit(c)}
                      className={`w-full text-left rounded-xl border px-3 py-2 hover:bg-muted transition ${editing?.id === c.id ? 'border-primary bg-primary/5' : 'border-border'}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{c.label}</span>
                        {c.isBuiltin && <Lock className="w-3 h-3 text-muted-foreground" aria-label="builtin" />}
                        {!c.enabled && <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground">off</span>}
                        <span className="ml-auto text-[10px] px-1.5 rounded bg-muted text-muted-foreground">{c.section}</span>
                      </div>
                      <code className="block text-[11px] text-muted-foreground truncate mt-0.5">{c.command}</code>
                    </button>
                  </li>
                ))}
                {commands.length === 0 && <li className="text-sm text-muted-foreground py-4 text-center">등록된 명령이 없습니다.</li>}
              </ul>
            )}
          </div>

          {/* 편집 폼 */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
              변경·위험 동사, 셸 메타문자(;|`), --repeat 등은 저장이 거부됩니다.
            </div>
            <Field label="key (식별자) *">
              <input className={INP} value={form.key} disabled={!!editing}
                onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} placeholder="예: exports" />
            </Field>
            <Field label="label (표시명) *">
              <input className={INP} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="섹션">
                <select className={INP} value={form.section} onChange={(e) => setForm((f) => ({ ...f, section: e.target.value as IsilonCommandSection }))}>
                  {SECTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
              <Field label="파싱">
                <select className={INP} value={form.parseMode} onChange={(e) => setForm((f) => ({ ...f, parseMode: e.target.value as 'json' | 'text' }))}>
                  <option value="text">text</option>
                  <option value="json">json</option>
                </select>
              </Field>
            </div>
            <Field label="isi 명령 *">
              <textarea className={`${INP} font-mono text-xs h-16`} value={form.command}
                onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))} placeholder="isi nfs exports list --format json" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="timeout (초)">
                <input className={INP} type="number" value={form.timeoutSeconds}
                  onChange={(e) => setForm((f) => ({ ...f, timeoutSeconds: Number(e.target.value) || 15 }))} />
              </Field>
              <Field label="정렬">
                <input className={INP} type="number" value={form.sortOrder}
                  onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) || 100 }))} />
              </Field>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} /> 활성화
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={form.showOnOverview} onChange={(e) => setForm((f) => ({ ...f, showOnOverview: e.target.checked }))} /> 개요에 표시
              </label>
            </div>
            <div className="flex items-center justify-between pt-1">
              {editing && !editing.isBuiltin ? (
                <button onClick={() => setConfirmId(editing.id)} className="inline-flex items-center gap-1 text-sm text-red-500 hover:text-red-600">
                  <Trash2 className="w-4 h-4" /> 삭제
                </button>
              ) : <span className="text-xs text-muted-foreground">{editing?.isBuiltin ? '기본 명령은 삭제 불가(비활성만)' : ''}</span>}
              <button onClick={save} disabled={createMut.isPending || updateMut.isPending}
                className="inline-flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-xl bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
                {(createMut.isPending || updateMut.isPending) && <Loader2 className="w-4 h-4 animate-spin" />}
                {editing ? '수정 저장' : '추가'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmId && (
        <ConfirmDialog
          open
          title="명령 삭제"
          description="이 커스텀 명령을 삭제하시겠습니까?"
          confirmLabel="삭제"
          danger
          onConfirm={() => doDelete(confirmId)}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-muted-foreground mb-1">{label}</span>
      {children}
    </label>
  );
}
