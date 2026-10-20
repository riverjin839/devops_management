/**
 * Self-service password change — 사용자 메뉴에서 호출되는 수동 비번 변경 화면.
 * 라우트: `/me/change-password`
 */
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, KeyRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '@/services/api';
import { useAuthStore, type AuthUser } from '@/stores/authStore';

export function ChangePasswordPage() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const scopeSessionToThisTab = useAuthStore((s) => s.scopeSessionToThisTab);
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // 로그인 방식은 저장된 사용자 정보보다 서버 값을 우선한다 — 다른 탭에서 LDAP 로 다시 로그인했을 수 있다.
  const { data: me } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => (await authApi.me()).data,
    staleTime: 30_000,
  });
  const authSource = me?.authSource ?? user?.authSource ?? null;
  const directoryAccount = authSource === 'ldap' || authSource === 'external';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSuccess(null);

    if (newPassword.length < 4) {
      setError('새 비밀번호는 최소 4자 이상이어야 합니다.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('새 비밀번호 확인이 일치하지 않습니다.');
      return;
    }
    if (currentPassword === newPassword) {
      setError('새 비밀번호는 기존 비밀번호와 달라야 합니다.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await authApi.changeMyPassword(currentPassword, newPassword);
      // 비밀번호를 바꾸면 그 이전에 로그인한 토큰(이 탭 것 포함)이 모두 무효가 된다 — 응답에 실린
      // 새 토큰을 이 탭 전용으로 끼워 이 세션만 이어 간다(R-7). 같은 브라우저의 다른 탭은 공유 토큰이
      // 지워져 다시 로그인해야 한다. 구버전 백엔드면 accessToken 이 없다.
      const { accessToken, ...nextUser } = res.data as AuthUser & { accessToken?: string | null };
      if (accessToken) scopeSessionToThisTab(accessToken, { ...nextUser, mustChangePassword: false });
      setUser({ ...nextUser, mustChangePassword: false });
      setSuccess('비밀번호가 변경되었습니다.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => navigate(-1), 800);
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } }; message?: string })?.response?.data?.detail
        ?? (err as { message?: string })?.message
        ?? '비밀번호 변경에 실패했습니다.';
      setError(typeof msg === 'string' ? msg : '비밀번호 변경에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md bg-card border border-border rounded-md p-6 shadow-card">
        <div className="flex items-center gap-2 mb-5">
          <div className="w-9 h-9 bg-primary rounded-md flex items-center justify-center text-primary-foreground">
            <KeyRound className="w-4 h-4" />
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight">비밀번호 변경</h1>
            <p className="text-sm text-muted-foreground">
              {`${user?.username ?? ''} 계정의 비밀번호를 변경합니다.`}
            </p>
          </div>
        </div>

        {directoryAccount ? (
          <div className="space-y-4">
            <div role="status" className="space-y-1 rounded-md border border-border bg-secondary px-3 py-2 text-sm">
              <p className="font-medium">
                {authSource === 'ldap' ? '사내 디렉터리(LDAP) 계정입니다.' : 'SSO 계정입니다.'}
              </p>
              <p className="text-muted-foreground">
                {authSource === 'ldap'
                  ? '이 계정은 사내 디렉터리 비밀번호로 로그인합니다. 비밀번호는 PEP 가 아니라 사내 디렉터리(사내 계정 관리 화면 등)에서 변경하세요.'
                  : '이 계정에는 PEP 비밀번호가 없습니다. 비밀번호는 사내 IdP 에서 변경하세요.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-xl hover:bg-muted"
            >
              돌아가기
            </button>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor={f('current')} className="block text-sm font-medium mb-1">현재 비밀번호</label>
            <input
              id={f('current')}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              disabled={submitting}
              required
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label htmlFor={f('new')} className="block text-sm font-medium mb-1">새 비밀번호</label>
            <input
              id={f('new')}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
              minLength={4}
              required
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label htmlFor={f('confirm')} className="block text-sm font-medium mb-1">새 비밀번호 확인</label>
            <input
              id={f('confirm')}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
              minLength={4}
              required
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {success && <p role="status" className="text-sm text-status-healthy">{success}</p>}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting || !currentPassword || !newPassword || !confirmPassword}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
              {submitting ? '변경 중…' : '비밀번호 변경'}
            </button>
            <button
              type="button"
              onClick={() => navigate(-1)}
              disabled={submitting}
              className="px-3 py-2 text-sm bg-secondary border border-border rounded-xl hover:bg-muted"
            >
              취소
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
}
