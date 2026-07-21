import { useId, useState } from 'react';
import { X, Loader2, Plug } from 'lucide-react';
import type { IsilonServer } from '@/types';
import {
  useCreateIsilonServer,
  useUpdateIsilonServer,
  useTestIsilonServer,
} from '@/hooks/useIsilonNfs';
import { useToast } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';

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

  const [name, setName] = useState(server?.name ?? '');
  const [host, setHost] = useState(server?.host ?? '');
  const [port, setPort] = useState(server?.port ?? 22);
  const [username, setUsername] = useState(server?.username ?? 'root');
  const [description, setDescription] = useState(server?.description ?? '');
  const [isDefault, setIsDefault] = useState(server?.isDefault ?? false);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  const saving = createMut.isPending || updateMut.isPending;

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
      toast.success('저장되었습니다.');
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
        className="bg-card rounded-2xl border border-border mac-shadow w-full max-w-lg max-h-[90vh] overflow-y-auto"
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
          <Field label={isEdit ? '비밀번호 (변경 시에만 입력)' : '비밀번호'}>
            <input className={INP} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={isEdit && server?.hasPassword ? '저장됨 — 변경하려면 입력' : ''} />
          </Field>
          <Field label="개인키 (PEM, 비밀번호 대신 사용)">
            <textarea className={`${INP} font-mono text-xs h-20`} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
              placeholder={isEdit && server?.hasPrivateKey ? '저장됨 — 변경하려면 입력' : '-----BEGIN ...'} />
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
          <button
            onClick={handleTest}
            disabled={!isEdit || testMut.isPending}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-xl border border-border hover:bg-muted disabled:opacity-50"
          >
            {testMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
            연결 테스트
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="text-sm px-3 py-1.5 rounded-xl border border-border hover:bg-muted">취소</button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-xl bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              저장
            </button>
          </div>
        </div>
      </div>
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
