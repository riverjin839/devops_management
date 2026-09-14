import { create } from 'zustand';

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
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    } catch { /* ignore */ }
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
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch { /* ignore */ }
    set({ token: null, user: null, logoutReason: 'manual', returnTo: null });
  },
  markSessionExpired: (returnTo) => {
    // 이미 로그아웃된 상태에서 401 이 연달아 오면(동시 요청 여러 개) 첫 기록을 유지한다.
    if (!useAuthStore.getState().token) return;
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch { /* ignore */ }
    set({ token: null, user: null, logoutReason: 'expired', returnTo: returnTo ?? null });
  },
}));

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
