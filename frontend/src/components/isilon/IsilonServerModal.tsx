import { useId, useState } from 'react';
import { X, Loader2, Plug, Trash2 } from 'lucide-react';
import type { IsilonServer } from '@/types';
import {
  useCreateIsilonServer,
  useUpdateIsilonServer,
  useDeleteIsilonServer,
  useTestIsilonServer,
  useIsilonCommands,
} from '@/hooks/useIsilonNfs';
import { useToast, ConfirmDialog } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useCanOperate } from '@/hooks/useCanOperate';

interface Props {
  server?: IsilonServer | null; // null/undefined = 신규
  onClose: () => void;
}

const INP = 'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';

function errMessage(e: unknown, fallback: string): string {
  const resp = (e as { response?: { data?: { detail?: string } } })?.response;
  return resp?.data?.detail ?? fallback;
}

export function IsilonServerModal({ server, onClose }: Props) {
  const isEdit = !!server;
  const dialogRef = useModalA11y(true, onClose);
  const titleId = useId();
  const toast = useToast();
  const createMut = useCreateIsilonServer();
  const updateMut = useUpdateIsilonServer();
  const testMut = useTestIsilonServer();
  const deleteMut = useDeleteIsilonServer();
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  // 서버 삭제 시 함께 지워지는 서버 전용 명령 수(FK ON DELETE CASCADE) — 확인 문구에 명시한다.
  const { data: commands = [] } = useIsilonCommands(server?.id, isEdit);
  const serverOnlyCommands = server ? commands.filter((c) => c.serverId === server.id) : [];
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 저장 자격증명 유무 — 지우기 성공 시 모달을 닫지 않고 바로 반영한다(prop 은 열 때의 스냅샷).
  const [hasPassword, setHasPassword] = useState(server?.hasPassword ?? false);
  const [hasPrivateKey, setHasPrivateKey] = useState(server?.hasPrivateKey ?? false);

  const [name, setName] = useState(server?.name ?? '');
  const [host, setHost] = useState(server?.host ?? '');
  const [port, setPort] = useState(server?.port ?? 22);
  const [username, setUsername] = useState(server?.username ?? 'root');
  const [description, setDescription] = useState(server?.description ?? '');
  const [isDefault, setIsDefault] = useState(server?.isDefault ?? false);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  const saving = createMut.isPending || updateMut.isPending;

  const handleClearCred = async (which: 'password' | 'privateKey') => {
    if (!server) return;
    try {
      await updateMut.mutateAsync({
        id: server.id,
        data: which === 'password' ? { clearSavedPassword: true } : { clearSavedPrivateKey: true },
      });
      if (which === 'password') { setHasPassword(false); setPassword(''); }
      else { setHasPrivateKey(false); setPrivateKey(''); }
      toast.success(which === 'password' ? '저장된 비밀번호를 지웠습니다' : '저장된 개인키를 지웠습니다');
    } catch (e) {
      toast.error('자격증명 지우기 실패', errMessage(e, '알 수 없는 오류'));
    }
  };

  const handleDelete = async () => {
    if (!server) return;
    try {
      await deleteMut.mutateAsync(server.id);
      toast.success('서버 삭제됨', server.name);
      setConfirmDelete(false);
      onClose();
    } catch (e) {
      toast.error('서버 삭제 실패', errMessage(e, '알 수 없는 오류'));
      setConfirmDelete(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim() || !host.trim()) {
      toast.error('이름과 호스트는 필수입니다.');
      return;
    }
    try {
      if (isEdit && server) {
        await updateMut.mutateAsync({
          id: server.id,
          data: {
            name, host, port, username, description, isDefault,
            ...(password ? { savedPassword: password } : {}),
            ...(privateKey ? { savedPrivateKey: privateKey } : {}),
          },
        });
      } else {
        await createMut.mutateAsync({
          name, host, port, username, description, isDefault,
          ...(password ? { savedPassword: password } : {}),
          ...(privateKey ? { savedPrivateKey: privateKey } : {}),
        });
      }
      toast.success('저장됨');
      onClose();
    } catch (e) {
      toast.error('저장 실패', errMessage(e, '알 수 없는 오류'));
    }
  };

  const handleTest = async () => {
    if (!isEdit || !server) {
      toast.info('먼저 저장한 뒤 연결 테스트하세요.');
      return;
    }
    try {
      const { data } = await testMut.mutateAsync(server.id);
      if (data.ok) toast.success('연결 성공', data.detail);
      else toast.error('연결 실패', data.detail);
    } catch (e) {
      toast.error('연결 테스트 실패', errMessage(e, '오류'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-card rounded-md border border-border shadow-card w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 id={titleId} className="text-sm font-semibold">{isEdit ? 'Isilon 서버 편집' : 'Isilon 서버 추가'}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <Field label="이름 *">
            <input className={INP} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: isilon-prod" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="호스트 *">
                <input className={INP} value={host} onChange={(e) => setHost(e.target.value)} placeholder="IP 또는 호스트명" />
              </Field>
            </div>
            <Field label="포트">
              <input className={INP} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} />
            </Field>
          </div>
          <Field label="SSH 사용자">
            <input className={INP} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="root" />
          </Field>
          <Field
            label={isEdit ? '비밀번호 (변경 시에만 입력)' : '비밀번호'}
            extra={isEdit && hasPassword ? (
              <ClearCredButton label="저장된 비밀번호 지우기" busy={updateMut.isPending} canOperate={canOperate}
                withHint={withHint} ariaWithHint={ariaWithHint} onClick={() => handleClearCred('password')} />
            ) : undefined}
          >
            <input className={INP} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={isEdit && hasPassword ? '저장됨 — 변경하려면 입력' : ''} />
          </Field>
          <Field
            label="개인키 (PEM, 비밀번호 대신 사용)"
            extra={isEdit && hasPrivateKey ? (
              <ClearCredButton label="저장된 개인키 지우기" busy={updateMut.isPending} canOperate={canOperate}
                withHint={withHint} ariaWithHint={ariaWithHint} onClick={() => handleClearCred('privateKey')} />
            ) : undefined}
          >
            <textarea className={`${INP} font-mono text-xs h-20`} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
              placeholder={isEdit && hasPrivateKey ? '저장됨 — 변경하려면 입력' : '-----BEGIN ...'} />
          </Field>
          <Field label="설명">
            <input className={INP} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            기본 서버로 설정 (server_id 없이 조회 시 사용)
          </label>
          <p className="text-xs text-muted-foreground">
            자격증명은 암호화되어 저장되며 응답에 평문으로 노출되지 않습니다.
          </p>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border">
          <div className="flex items-center gap-2">
            <button
              onClick={handleTest}
              disabled={!isEdit || !canOperate || testMut.isPending}
              title={withHint(isEdit ? '저장된 자격증명으로 SSH 연결만 확인' : '먼저 저장한 뒤 연결 테스트하세요')}
              aria-label={ariaWithHint('연결 테스트')}
              className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-xl border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Plug className="w-4 h-4" aria-hidden="true" />}
              연결 테스트
            </button>
            {isEdit && (
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={!canOperate || deleteMut.isPending}
                title={withHint('서버 삭제')}
                aria-label={ariaWithHint('서버 삭제')}
                className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-xl border border-status-critical/40 text-status-critical hover:bg-status-critical/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-4 h-4" aria-hidden="true" />
                서버 삭제
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-xl border border-border hover:bg-muted">취소</button>
            <button
              onClick={handleSave}
              disabled={!canOperate || saving}
              title={withHint('저장')}
              aria-label={ariaWithHint('저장')}
              className="inline-flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-xl bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              저장
            </button>
          </div>
        </div>
      </div>

      {confirmDelete && server && (
        <ConfirmDialog
          open
          danger
          title="Isilon 서버 삭제"
          description={`"${server.name}" (${server.host}) 서버를 삭제합니다. 되돌릴 수 없습니다.`}
          confirmLabel="서버 삭제"
          busy={deleteMut.isPending}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        >
          <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
            <li>저장된 비밀번호·개인키가 함께 삭제됩니다.</li>
            <li>
              이 서버 전용 명령{' '}
              <span className="font-semibold text-foreground tabular-nums">{serverOnlyCommands.length}개</span>
              {serverOnlyCommands.length > 0 && ` (${serverOnlyCommands.map((c) => c.label).join(', ')})`}
              가 함께 삭제됩니다. 글로벌 기본 명령은 유지됩니다.
            </li>
            {server.isDefault && <li>기본 서버였으므로, 삭제 후 다른 서버를 기본으로 지정하세요.</li>}
          </ul>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ClearCredButton({
  label, busy, canOperate, withHint, ariaWithHint, onClick,
}: {
  label: string;
  busy: boolean;
  canOperate: boolean;
  withHint: (t: string) => string;
  ariaWithHint: (t: string) => string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!canOperate || busy}
      title={withHint(label)}
      aria-label={ariaWithHint(label)}
      className="inline-flex items-center gap-1 text-xs text-status-critical hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Trash2 className="w-3 h-3" aria-hidden="true" />
      {label}
    </button>
  );
}

function Field({ label, extra, children }: { label: string; extra?: React.ReactNode; children: React.ReactNode }) {
  // 지우기 버튼(extra)이 <label> 안에 들어가면 라벨 클릭이 버튼을 누르므로 라벨 밖 형제로 둔다.
  if (extra) {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="block text-xs font-medium text-muted-foreground">{label}</span>
          {extra}
        </div>
        <label className="block">
          <span className="sr-only">{label}</span>
          {children}
        </label>
      </div>
    );
  }
  return (
    <label className="block">
      <span className="block text-xs font-medium text-muted-foreground mb-1">{label}</span>
      {children}
    </label>
  );
}
