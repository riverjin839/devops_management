/**
 * 로그인 계정 관리 — Settings ▸ 시스템 담당자 ▸ 로그인 계정 서브탭 (admin 전용).
 *
 * 원래 사이드바 "사용자 관리"(`/settings/users`) 독립 페이지였던 것을 Settings 안으로
 * 통합했다. 라우트 자체가 이미 `RequireAdmin` 으로 보호되므로 여기서는 별도 RoleGate 를
 * 두지 않는다. 본인 자신의 강등/삭제는 UI 와 서버에서 동시에 차단.
 */
import { useId, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, KeyRound, Loader2, RefreshCw } from 'lucide-react';

import { MacCard } from '@/components/ui/MacCard';
import { ConfirmDialog, useToast, useModalA11y } from '@/components/common';
import { authApi, type UserRoleApi } from '@/services/api';
import { useAuthStore, type AuthUser } from '@/stores/authStore';
import { formatApiError, parseUTC } from '@/lib/utils';

const ROLES: { value: UserRoleApi; label: string; desc: string }[] = [
  { value: 'viewer', label: 'Viewer', desc: '조회 전용' },
  { value: 'operator', label: 'Operator', desc: '쓰기/실행' },
  { value: 'admin', label: 'Admin', desc: '전체 권한 + 계정 관리' },
];

function RoleBadge({ role }: { role: string }) {
  const cls =
    role === 'admin'
      ? 'bg-rose-500/15 text-rose-700 border-rose-500/30'
      : role === 'operator'
      ? 'bg-amber-500/15 text-amber-700 border-amber-500/30'
      : 'bg-slate-500/15 text-slate-600 border-slate-500/30';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-sm font-medium border rounded-md ${cls}`}>
      {role}
    </span>
  );
}

function CreateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRoleApi>('viewer');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const dialogRef = useModalA11y(open, onClose);

  if (!open) return null;

  const submit = async () => {
    if (submitting) return;
    setError(null);
    if (!username.trim() || password.length < 4) {
      setError('사용자명과 4자 이상 비밀번호를 입력하세요.');
      return;
    }
    setSubmitting(true);
    try {
      await authApi.createUser({
        username: username.trim(),
        password,
        role,
        displayName: displayName.trim() || undefined,
      });
      toast.success(`사용자 ${username} 이(가) 추가되었습니다.`);
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    } catch (err) {
      setError(formatApiError(err) ?? '사용자 생성에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={f('title')} className="w-full max-w-md bg-card border border-border rounded-2xl p-5 mac-shadow">
        <h3 id={f('title')} className="text-base font-bold mb-4">새 사용자</h3>
        <div className="space-y-3">
          <div>
            <label htmlFor={f('u')} className="block text-sm mb-1">사용자명</label>
            <input
              id={f('u')}
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm"
            />
          </div>
          <div>
            <label htmlFor={f('p')} className="block text-sm mb-1">초기 비밀번호 (4자 이상)</label>
            <input
              id={f('p')}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm"
            />
          </div>
          <div>
            <label htmlFor={f('d')} className="block text-sm mb-1">표시 이름 (선택)</label>
            <input
              id={f('d')}
              autoComplete="off"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm"
            />
          </div>
          <div>
            <label htmlFor={f('r')} className="block text-sm mb-1">역할</label>
            <select
              id={f('r')}
              value={role}
              onChange={(e) => setRole(e.target.value as UserRoleApi)}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm"
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label} — {r.desc}</option>
              ))}
            </select>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm bg-secondary border border-border rounded-xl hover:bg-muted"
          >취소</button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            추가
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetPasswordModal({
  user,
  onClose,
}: {
  user: AuthUser | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalA11y(!!user, onClose);
  const titleId = useId();

  if (!user) return null;

  const submit = async () => {
    if (submitting) return;
    if (newPassword.length < 4) {
      setError('4자 이상 입력하세요.');
      return;
    }
    setSubmitting(true);
    try {
      await authApi.resetPassword(user.id, newPassword);
      toast.success(`${user.username} 비밀번호가 재설정되었습니다.`);
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    } catch (err) {
      setError(formatApiError(err) ?? '비밀번호 재설정에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-sm bg-card border border-border rounded-2xl p-5 mac-shadow">
        <h3 id={titleId} className="text-base font-bold mb-2">{user.username} 비밀번호 재설정</h3>
        <p className="text-sm text-muted-foreground mb-3">
          새 비밀번호를 입력하세요. 변경 즉시 적용됩니다.
        </p>
        <input
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          minLength={4}
          className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm"
        />
        {error && <p role="alert" className="text-sm text-destructive mt-2">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm bg-secondary border border-border rounded-xl hover:bg-muted"
          >취소</button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || newPassword.length < 4}
            className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
            재설정
          </button>
        </div>
      </div>
    </div>
  );
}

export function SystemUserAccountManager() {
  const me = useAuthStore((s) => s.user);
  const toast = useToast();
  const qc = useQueryClient();

  const { data, isFetching, refetch, error } = useQuery({
    queryKey: ['users'],
    queryFn: async () => (await authApi.listUsers()).data,
  });

  const updateRole = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: UserRoleApi }) =>
      (await authApi.updateUserRole(id, role)).data,
    onSuccess: () => {
      toast.success('역할이 변경되었습니다.');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(formatApiError(err) ?? '역할 변경 실패'),
  });

  const deleteUser = useMutation({
    mutationFn: async (id: string) => (await authApi.deleteUser(id)).data,
    onSuccess: () => {
      toast.success('사용자가 삭제되었습니다.');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(formatApiError(err) ?? '삭제 실패'),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<AuthUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AuthUser | null>(null);

  const sortedUsers = useMemo(() => {
    if (!data) return [];
    const arr = [...data];
    arr.sort((a, b) => a.username.localeCompare(b.username));
    return arr;
  }, [data]);

  return (
    <MacCard title="로그인 계정">
      <div className="flex justify-between items-center mb-3">
        <p className="text-sm text-muted-foreground">
          역할: viewer (조회) · operator (쓰기/실행) · admin (전체 + 계정 관리)
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="px-3 py-1.5 text-sm bg-secondary border border-border rounded-xl hover:bg-muted flex items-center gap-1"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            새로고침
          </button>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" /> 새 사용자
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive mb-3">
          사용자 목록 조회 실패: {formatApiError(error)}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left">
            <tr>
              <th className="py-2 pr-3 font-medium">사용자명</th>
              <th className="py-2 pr-3 font-medium">표시 이름</th>
              <th className="py-2 pr-3 font-medium">역할</th>
              <th className="py-2 pr-3 font-medium">생성</th>
              <th className="py-2 pr-3 font-medium text-right">작업</th>
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((u) => {
              const isSelf = me?.id === u.id;
              return (
                <tr key={u.id} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3 font-medium">{u.username}{isSelf && <span className="ml-1 text-sm text-muted-foreground">(나)</span>}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{u.displayName || '-'}</td>
                  <td className="py-2 pr-3">
                    {isSelf ? (
                      <RoleBadge role={u.role} />
                    ) : (
                      <select
                        value={u.role}
                        onChange={(e) => updateRole.mutate({ id: u.id, role: e.target.value as UserRoleApi })}
                        disabled={updateRole.isPending}
                        className="px-2 py-1 bg-background border border-border rounded-md text-sm"
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-sm text-muted-foreground">
                    {u.createdAt ? parseUTC(u.createdAt).toLocaleString() : '-'}
                  </td>
                  <td className="py-2 pr-3 text-right" aria-label="작업">
                    <div className="inline-flex gap-1">
                      <button
                        type="button"
                        onClick={() => setResetTarget(u)}
                        className="px-2 py-1 text-sm bg-secondary border border-border rounded-md hover:bg-muted inline-flex items-center gap-1"
                        title="비밀번호 재설정"
                      >
                        <KeyRound className="w-3 h-3" /> 비번
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(u)}
                        disabled={isSelf}
                        className="px-2 py-1 text-sm bg-secondary border border-border rounded-md hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
                        title={isSelf ? '자기 자신은 삭제할 수 없습니다' : '사용자 삭제'}
                      >
                        <Trash2 className="w-3 h-3" /> 삭제
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!isFetching && sortedUsers.length === 0 && (
              <tr><td colSpan={5} className="py-8 text-center text-muted-foreground text-sm">사용자가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <ResetPasswordModal user={resetTarget} onClose={() => setResetTarget(null)} />
      <ConfirmDialog
        open={!!deleteTarget}
        title="사용자 삭제"
        description={deleteTarget ? `${deleteTarget.username} 계정을 정말 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.` : ''}
        confirmLabel="삭제"
        danger
        onConfirm={() => {
          if (deleteTarget) {
            deleteUser.mutate(deleteTarget.id);
            setDeleteTarget(null);
          }
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </MacCard>
  );
}
