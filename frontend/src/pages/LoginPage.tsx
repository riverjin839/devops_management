import { useId, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2, LogIn, Clock } from 'lucide-react';
import { authApi } from '@/services/api';
import { useAuthStore, consumeReturnTo } from '@/stores/authStore';

export function LoginPage() {
  const setSession = useAuthStore((s) => s.setSession);
  // D-079 — 세션 만료로 여기까지 왔으면 이유를 보여주고, 로그인 후 보던 화면으로 돌려보낸다.
  const logoutReason = useAuthStore((s) => s.logoutReason);
  const returnTo = useAuthStore((s) => s.returnTo);
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await authApi.login(username.trim(), password);
      // AuthGate 가 제자리에서 로그인 화면을 그리므로 URL 은 만료 당시 화면 그대로다. 그래도
      // 만료 후 사용자가 주소를 옮겼을 수 있으니 기록된 복귀 경로와 다르면 거기로 보낸다.
      const rt = consumeReturnTo();
      setSession(res.data.accessToken, res.data.user);
      if (rt && rt !== `${location.pathname}${location.search}`) navigate(rt, { replace: true });
    } catch (err) {
      const msg = (err as { response?: { data?: { detail?: string } }; message?: string })?.response?.data?.detail
        ?? (err as { message?: string })?.message
        ?? '로그인에 실패했습니다.';
      setError(typeof msg === 'string' ? msg : '로그인에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm bg-card border border-border rounded-md p-6 mac-shadow">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-9 h-9 bg-gradient-to-br from-primary to-sky-700 rounded-md flex items-center justify-center text-white text-base shadow-sm">
            ☸
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight">PEP</h1>
            <p className="text-xs text-muted-foreground">Platform Engineering Portal</p>
          </div>
        </div>

        {logoutReason === 'expired' && (
          <div
            role="status"
            className="mb-4 flex items-start gap-2 rounded-md border border-border bg-secondary/60 px-3 py-2 text-xs text-foreground"
          >
            <Clock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>
              세션이 만료되어 로그아웃되었습니다. 다시 로그인하면
              {returnTo ? ' 보던 화면으로 돌아갑니다.' : ' 계속 이용할 수 있습니다.'}
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor={f('username')} className="block text-sm font-medium mb-1">사용자명</label>
            <input
              id={f('username')}
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
              required
              className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          <div>
            <label htmlFor={f('password')} className="block text-sm font-medium mb-1">비밀번호</label>
            <input
              id={f('password')}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              required
              className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting || !username.trim() || !password}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
            {submitting ? '로그인 중…' : '로그인'}
          </button>
        </form>

        {/* D-069 — 버전은 package.json 이 원천(vite define). 도움말·지원 진입점은 D-077 에서
            셸 메뉴와 함께 정하므로 여기서는 자리를 비워 둔다. */}
        <p className="mt-5 text-[11px] text-muted-foreground text-center tabular-nums select-none">
          v{__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}
