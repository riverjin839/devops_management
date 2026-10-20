import { create } from 'zustand';
import { activateProfile, clearSessionSecrets } from '@/lib/personalStorage';
import { getJwtExpiryMs } from '@/lib/jwt';

// API response interceptor converts snake_case → camelCase, so we model the
// shape the React tree actually receives.
export type UserRole = 'admin' | 'operator' | 'viewer';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  displayName?: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

const TOKEN_KEY = 'k8s:auth:token';
const USER_KEY = 'k8s:auth:user';

function normalizeUser(raw: Partial<AuthUser> & { role?: string }): AuthUser {
  // Backend legacy data might still emit role='user' — display it as 'viewer'.
  const rawRole = raw.role as string | undefined;
  const role = rawRole === 'user' ? 'viewer' : (rawRole as UserRole);
  return {
    id: String(raw.id ?? ''),
    username: String(raw.username ?? ''),
    role: (role ?? 'viewer') as UserRole,
    displayName: raw.displayName ?? null,
    isActive: Boolean(raw.isActive ?? true),
    mustChangePassword: Boolean(raw.mustChangePassword ?? false),
    createdAt: String(raw.createdAt ?? ''),
  };
}

function loadToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

/** 아직 만료 전인(exp 미래) 토큰인지 — exp 없는 토큰은 판단 불가라 유효로 본다. */
function isUnexpired(token: string | null): token is string {
  if (!token) return false;
  const exp = getJwtExpiryMs(token);
  return exp == null || exp > Date.now();
}

function loadUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return normalizeUser(JSON.parse(raw) as Partial<AuthUser>);
  } catch { return null; }
}

/** 세션이 끊긴 사유 — 로그인 화면이 "왜 다시 로그인해야 하는지" 를 보여주는 데 쓴다(D-079). */
export type LogoutReason = 'expired' | 'manual';

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  /** 직전 로그아웃 사유. 로그인 성공 시 지운다. */
  logoutReason: LogoutReason | null;
  /** 세션 만료로 로그아웃됐을 때 보고 있던 경로(path+search) — 재로그인 후 복귀용. */
  returnTo: string | null;
  setSession: (token: string, user: AuthUser) => void;
  setUser: (user: AuthUser) => void;
  /**
   * 토큰만 교체(재발급·다른 탭 동기화) — localStorage 와 메모리만 갱신한다. 같은 계정의 세션이
   * 이어지는 것이므로 `setSession` 과 달리 프로필 전환·새로 고침을 하지 않는다.
   */
  setToken: (token: string, user?: AuthUser) => void;
  clear: () => void;
  /** 토큰 만료/무효(401) 로 세션을 끊을 때 — 사유와 복귀 경로를 남기고 clear 한다. */
  markSessionExpired: (returnTo?: string | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: loadToken(),
  user: loadUser(),
  logoutReason: null,
  returnTo: null,
  setSession: (token, user) => {
    const u = normalizeUser(user);
    // 공용 PC — 직전에 다른 계정이 쓰던 브라우저면 그 사람의 로컬 개인 설정(테마·접힘 등)을
    // 보관하고 이 계정 것으로 바꿔 끼운다(lib/personalStorage.ts).
    const switched = activateProfile(u.id);
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    } catch { /* ignore */ }
    if (switched) {
      // 모듈 로드 시점에 localStorage 를 읽어 둔 store(테마·사이드바 등)와 서버 캐시가 이전
      // 사람 값을 들고 있으므로 새로 고친다. 직전 사람의 복귀 경로(returnTo)도 함께 버려진다.
      window.location.replace('/');
      return;
    }
    // returnTo 는 LoginPage 가 로그인 직후 읽어 복귀에 쓰고 나서 직접 지운다 — 여기서
    // 같이 지우면 setSession 이 먼저 돌아 복귀 경로를 잃는다.
    set({ token, user: u, logoutReason: null });
    // 홈 탭(work/platform) 선호는 localStorage 에 영속되므로 로그인마다 리셋하지
    // 않는다(D-056 — 예전엔 매번 강제로 'work' 로 되돌렸다). 서버 저장 기본 탭은
    // useHomePrefs() 가 로드된 뒤 반영한다.
  },
  setUser: (user) => {
    const u = normalizeUser(user);
    try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch { /* ignore */ }
    set({ user: u });
  },
  setToken: (token, user) => {
    const u = user ? normalizeUser(user) : undefined;
    try {
      localStorage.setItem(TOKEN_KEY, token);
      if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    } catch { /* ignore */ }
    set(u ? { token, user: u, logoutReason: null } : { token, logoutReason: null });
  },
  clear: () => {
    clearSessionSecrets();
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch { /* ignore */ }
    set({ token: null, user: null, logoutReason: 'manual', returnTo: null });
  },
  markSessionExpired: (returnTo) => {
    // 이미 로그아웃된 상태에서 401 이 연달아 오면(동시 요청 여러 개) 첫 기록을 유지한다.
    const current = useAuthStore.getState().token;
    if (!current) return;
    // 다른 탭이 이미 재발급(또는 재로그인)해 둔 유효 토큰이 있으면 그것을 채택하고 끊지 않는다 —
    // 오래된 탭의 만료가 공유 저장소의 새 토큰까지 지워 모든 탭을 로그아웃시키던 문제(R-7).
    const stored = loadToken();
    if (stored && stored !== current && isUnexpired(stored)) {
      const storedUser = loadUser();
      const me = useAuthStore.getState().user;
      if (!storedUser || !me || storedUser.id === me.id) {
        set(storedUser ? { token: stored, user: storedUser } : { token: stored });
        return;
      }
      // 저장소의 토큰은 다른 계정의 살아 있는 세션 — 그것은 지우지 않고 이 탭만 로그아웃한다.
      clearSessionSecrets();
      set({ token: null, user: null, logoutReason: 'expired', returnTo: returnTo ?? null });
      return;
    }
    clearSessionSecrets();
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch { /* ignore */ }
    set({ token: null, user: null, logoutReason: 'expired', returnTo: returnTo ?? null });
  },
}));

// 이미 로그인된 채 새 버전이 배포된 브라우저 — 지금 깔린 로컬 개인 설정의 주인을 이 계정으로
// 기록해 둔다(다음에 다른 사람이 로그인하면 그때 바꿔 끼울 수 있게). 드물게 주인이 다르면
// (다른 탭에서 계정이 바뀐 경우) 바꿔 끼우고 새로 고친다 — 주인이 맞춰졌으므로 한 번뿐이다.
{
  const bootUser = useAuthStore.getState().user;
  if (bootUser && activateProfile(bootUser.id)) window.location.reload();
}

// 탭 간 동기화 — 다른 탭의 재발급·로그인·로그아웃을 `storage` 이벤트로 받아 이 탭 상태에 반영한다
// (`storage` 이벤트는 값을 바꾼 탭 자신에게는 오지 않는다).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.storageArea && e.storageArea !== window.localStorage) return;
    const st = useAuthStore.getState();
    // e.key === null 은 localStorage.clear() — 토큰 키가 바뀐 것과 같게 다룬다.
    if (e.key === TOKEN_KEY || e.key === null) {
      const next = loadToken();
      if (next === st.token) return;
      if (!next) {
        // 다른 탭이 로그아웃(수동 또는 만료). 이 탭의 sessionStorage 비밀값도 함께 비운다.
        clearSessionSecrets();
        const expired = !isUnexpired(st.token);
        const here = `${window.location.pathname}${window.location.search}`;
        useAuthStore.setState({
          token: null,
          user: null,
          logoutReason: expired ? 'expired' : 'manual',
          returnTo: expired ? here : null,
        });
        return;
      }
      const nextUser = loadUser();
      if (!st.token || (st.user && nextUser && nextUser.id !== st.user.id)) {
        // 로그아웃돼 있던 탭에 다른 탭의 로그인이 들어왔거나 계정이 바뀌었다 — 로그인 시 개인 설정
        // 프로필이 바뀌어 끼워졌을 수 있으므로(setSession) 새로 고쳐 부팅 경로로 다시 읽는다.
        // 로그인 화면은 제자리 렌더라 URL 이 그대로라 보던 화면으로 돌아온다.
        window.location.reload();
        return;
      }
      useAuthStore.setState(
        nextUser ? { token: next, user: nextUser, logoutReason: null } : { token: next, logoutReason: null },
      );
      return;
    }
    if (e.key === USER_KEY && e.newValue && st.token) {
      const nextUser = loadUser();
      if (!nextUser) return;
      // 토큰 이벤트가 사용자 키보다 먼저 처리돼 계정 변경을 놓쳤으면 여기서 잡는다.
      if (st.user && nextUser.id !== st.user.id) { window.location.reload(); return; }
      useAuthStore.setState({ user: nextUser });
    }
  });
}

/** localStorage 에 저장된 토큰(다른 탭이 재발급했을 수 있다) — 재발급 전 중복 확인용. */
export function peekStoredToken(): string | null {
  return loadToken();
}

// Stable accessor used by the axios interceptor (it can't subscribe to React).
export function getAuthToken(): string | null {
  return useAuthStore.getState().token;
}

export function clearAuthSession() {
  useAuthStore.getState().clear();
}

/** axios 401 인터셉터용 — 현재 화면 경로를 복귀 지점으로 남기며 세션을 끊는다(D-079). */
export function expireAuthSession() {
  const here = `${window.location.pathname}${window.location.search}`;
  // 로그인 화면 자체는 별도 라우트가 없어(AuthGate 가 제자리에서 그린다) 항상 실제 화면 경로다.
  useAuthStore.getState().markSessionExpired(here);
}

/** 재로그인 후 복귀 경로를 소비한다 — 한 번 읽으면 지운다. */
export function consumeReturnTo(): string | null {
  const rt = useAuthStore.getState().returnTo;
  if (rt) useAuthStore.setState({ returnTo: null });
  return rt;
}

export function hasRole(user: AuthUser | null | undefined, ...allowed: UserRole[]): boolean {
  if (!user) return false;
  return allowed.includes(user.role);
}
