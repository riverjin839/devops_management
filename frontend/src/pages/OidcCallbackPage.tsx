import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { authApi, type LoginResponse } from '@/services/api';
import { useAuthStore, consumeReturnTo } from '@/stores/authStore';

/** 사내 IdP SSO(OIDC) 콜백 — `/auth/callback?code=…` (R-7).
 *
 *  서버 콜백(`/api/v1/auth/oidc/callback`)이 IdP 검증을 끝내고 1회용 handoff code(60초)를 붙여
 *  여기로 보낸다. 세션 토큰은 URL 에 실리지 않는다 — code 를 POST 로 교환해 `setSession` 한다.
 *  실패(`?error=` 또는 교환 실패)는 `/login?error=<사유코드>` 로 넘겨 로그인 화면이 사람 문구로 보여준다.
 *  미로그인 상태에서는 LoginPage 가 이 경로를 보고 이 화면을 그리고, 이미 로그인된 탭이면 App 라우트가 그린다. */

// handoff code 는 1회용이라 StrictMode(개발) 의 effect 이중 실행에서 두 번 교환하면 두 번째가 실패한다 —
// 같은 code 의 교환 요청을 공유한다.
const exchanges = new Map<string, Promise<LoginResponse & { returnTo: string }>>();

export function OidcCallbackPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');

  useEffect(() => {
    if (!code) {
      navigate(`/login?error=${encodeURIComponent(error || 'state_invalid')}`, { replace: true });
      return;
    }
    let cancelled = false;
    let pending = exchanges.get(code);
    if (!pending) {
      pending = authApi.oidcExchange(code).then((r) => r.data);
      exchanges.set(code, pending);
    }
    pending
      .then((data) => {
        if (cancelled) return;
        // 세션 만료로 남아 있던 복귀 경로는 이번 로그인에서 서버가 돌려준 값(로그인 시 보낸 return_to)으로 대체.
        consumeReturnTo();
        // 주소를 먼저 옮긴 뒤 세션을 끼운다 — 콜백 URL(code 포함)이 기록에 남지 않고, 로그인 직후
        // 이 화면이 다시 마운트돼 같은 code 로 교환을 재시도하지 않는다.
        navigate(data.returnTo || '/', { replace: true });
        setSession(data.accessToken, data.user);
      })
      .catch(() => {
        if (cancelled) return;
        navigate('/login?error=exchange_failed', { replace: true });
      });
    return () => { cancelled = true; };
  }, [code, error, navigate, setSession]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        사내 SSO 로그인 확인 중…
      </p>
    </div>
  );
}
