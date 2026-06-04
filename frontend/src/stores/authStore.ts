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

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  setSession: (token: string, user: AuthUser) => void;
  setUser: (user: AuthUser) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: loadToken(),
  user: loadUser(),
  setSession: (token, user) => {
    const u = normalizeUser(user);
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    } catch { /* ignore */ }
    set({ token, user: u });
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
    set({ token: null, user: null });
  },
}));

// Stable accessor used by the axios interceptor (it can't subscribe to React).
export function getAuthToken(): string | null {
  return useAuthStore.getState().token;
}

export function clearAuthSession() {
  useAuthStore.getState().clear();
}

export function hasRole(user: AuthUser | null | undefined, ...allowed: UserRole[]): boolean {
  if (!user) return false;
  return allowed.includes(user.role);
}
