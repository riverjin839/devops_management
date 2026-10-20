import { useId, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, LogIn, Clock, KeyRound, ShipWheel, ShieldCheck, AlertCircle } from 'lucide-react';
import { authApi } from '@/services/api';
import { useAuthStore, consumeReturnTo } from '@/stores/authStore';
import { OidcCallbackPage } from '@/pages/OidcCallbackPage';
import type { TranslationResource } from '@/i18n/resources/ko';

/** SSO 콜백 경로 — 미로그인 상태에서는 AuthGate 가 어느 경로든 이 화면을 그리므로 여기서 분기한다. */
const OIDC_CALLBACK_PATH = '/auth/callback';

/** 서버 콜백·교환 실패 사유 코드(`/login?error=`) → 문구 키. 코드 목록은 backend oidc_service.ERROR_CODES. */
const SSO_ERROR_KEYS: Record<string, keyof TranslationResource['login']['ssoError']> = {
  disabled: 'disabled',
  rate_limited: 'rateLimited',
  state_invalid: 'stateInvalid',
  nonce_mismatch: 'stateInvalid',
  idp_error: 'idpError',
  discovery_failed: 'discoveryFailed',
  token_exchange_failed: 'tokenExchangeFailed',
  id_token_invalid: 'idTokenInvalid',
  claim_missing: 'claimMissing',
  domain_not_allowed: 'domainNotAllowed',
  user_not_found: 'userNotFound',
  user_inactive: 'userInactive',
  provision_failed: 'provisionFailed',
  exchange_failed: 'exchangeFailed',
};

export function LoginPage() {
  const { pathname } = useLocation();
  if (pathname === OIDC_CALLBACK_PATH) return <OidcCallbackPage />;
  return <LoginForm />;
}

function LoginForm() {
  const { t } = useTranslation();
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

  // R-7 — 사내 IdP SSO. 설정이 꺼져 있거나 조회 실패면 버튼을 그리지 않는다(비밀번호 로그인은 그대로).
  const { data: sso } = useQuery({
    queryKey: ['auth', 'oidc-config'],
    queryFn: async () => (await authApi.oidcConfig()).data,
    staleTime: 60_000,
    retry: false,
  });
  const ssoErrorCode = location.pathname === '/login' ? new URLSearchParams(location.search).get('error') : null;
  const ssoError = ssoErrorCode ? t(`login.ssoError.${SSO_ERROR_KEYS[ssoErrorCode] ?? 'unknown'}`) : null;
  // 로그인 후 돌아갈 곳 — 세션 만료 때 기록된 경로, 없으면 지금 보던 화면(로그인·콜백 경로 제외).
  const here = `${location.pathname}${location.search}`;
  const ssoReturnTo = returnTo
    ?? (location.pathname === '/' || location.pathname === '/login' || location.pathname === OIDC_CALLBACK_PATH ? null : here);

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
        ?? t('login.failed');
      setError(typeof msg === 'string' ? msg : t('login.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm bg-card border border-border rounded-md p-6 shadow-card">
        <div className="flex items-center gap-2 mb-6">
          <div className="w-9 h-9 bg-primary rounded-md flex items-center justify-center text-primary-foreground">
            <ShipWheel className="w-5 h-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight">PEP</h1>
            <p className="text-xs text-muted-foreground">{t('login.subtitle')}</p>
          </div>
        </div>

        {logoutReason === 'expired' && (
          <div
            role="status"
            className="mb-4 flex items-start gap-2 rounded-md border border-border bg-secondary/60 px-3 py-2 text-xs text-foreground"
          >
            <Clock className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>{t(returnTo ? 'login.sessionExpiredReturn' : 'login.sessionExpiredContinue')}</span>
          </div>
        )}
        {logoutReason === 'password_changed' && (
          <div
            role="status"
            className="mb-4 flex items-start gap-2 rounded-md border border-border bg-secondary/60 px-3 py-2 text-xs text-foreground"
          >
            <KeyRound className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
            <span>{t(returnTo ? 'login.passwordChangedReturn' : 'login.passwordChangedContinue')}</span>
          </div>
        )}

        {ssoError && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground"
          >
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-destructive" aria-hidden="true" />
            <span>{ssoError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor={f('username')} className="block text-sm font-medium mb-1">{t('login.username')}</label>
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
            <label htmlFor={f('password')} className="block text-sm font-medium mb-1">{t('login.password')}</label>
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
            {submitting ? t('login.submitting') : t('login.submit')}
          </button>
        </form>

        {sso?.enabled && (
          <>
            <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
              <span className="h-px flex-1 bg-border" />
              {t('login.or')}
              <span className="h-px flex-1 bg-border" />
            </div>
            {/* 링크 이동 — 서버가 state·PKCE 를 만들고 IdP 로 302 한다(axios 호출이 아니다). */}
            <a
              href={authApi.oidcLoginUrl(ssoReturnTo)}
              aria-label={t('login.ssoAria', { name: sso.displayName })}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold bg-secondary text-foreground border border-border rounded-md hover:bg-secondary/80 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            >
              <ShieldCheck className="w-4 h-4" aria-hidden="true" />
              {t('login.sso', { name: sso.displayName })}
            </a>
          </>
        )}

        {/* D-069 — 버전은 package.json 이 원천(vite define). 도움말·지원 진입점은 D-077 에서
            셸 메뉴와 함께 정하므로 여기서는 자리를 비워 둔다. */}
        <p className="mt-5 text-[11px] text-muted-foreground text-center tabular-nums select-none">
          v{__APP_VERSION__}
        </p>
      </div>
    </div>
  );
}
