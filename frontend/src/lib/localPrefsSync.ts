import { isPersonalKey, snapshotPersonal } from './personalStorage';

/**
 * 브라우저 로컬 개인 설정(그룹 접힘·화면별 보기 모드 등)을 서버(`/me/local-prefs`)와 맞춘다 — 다른 PC 에서
 * 로그인해도 같은 화면 설정으로 시작하게.
 *
 * 화면 40여 곳이 모듈 로드·마운트 때 localStorage 를 읽으므로, 서버 값은 **화면이 뜨기 전에만** 깐다:
 *   - 새로 고침/첫 진입: `main.tsx` 가 앱을 불러오기 전에 `bootLocalPrefsSync()` 를 기다린다(최대 1.5초).
 *   - 로그인 직후: 서버에서 가져온 값이 있으면 새로 고친다(`authStore.setSession`).
 * 화면이 떠 있는 동안에는 이 기기에서 바뀐 키만 올린다(15초마다·탭을 숨길 때·로그아웃 직전). 다른 기기에서
 * 바뀐 값은 다음 진입 때 반영된다.
 *
 * 합치기는 키 단위 3-way: 이 기기가 마지막으로 맞춘 값(기준본, `pep-sync:{사용자}`)과 비교해
 *   - 이 기기에서 안 바뀐 키 → 서버 값을 따른다.
 *   - 이 기기에서 바뀐 키 → 이 기기 값을 올린다(양쪽 다 바뀌었으면 이 기기가 이긴다).
 * 처음 맞추는 기기는 서버에 있는 키는 서버 값을, 서버에 없는 키는 이 기기 값을 올린다(서버가 비었으면 전부 올림).
 *
 * axios 대신 fetch 를 쓴다 — 응답 인터셉터의 키 camelCase 변환이 설정 키("pep:homeTab")를 바꾸지 않게,
 * 그리고 앱(store·axios)을 불러오기 전에 돌 수 있게.
 */

const API = '/api/v1/me/local-prefs';
const TOKEN_KEY = 'k8s:auth:token';
const USER_KEY = 'k8s:auth:user';
const TAB_TOKEN_KEY = 'k8s:auth:tab-token';
const TAB_USER_KEY = 'k8s:auth:tab-user';
const OWNER_KEY = 'pep:profile-owner';
const BASE_PREFIX = 'pep-sync:'; // 기기 값(사용자별 기준본) — 개인 키 접두사가 아니라 프로필 전환 대상이 아니다
const PUSH_INTERVAL_MS = 15_000;
const MAX_VALUE_CHARS = 64 * 1024; // 서버 local_prefs.MAX_VALUE_CHARS 와 같다
const KEEPALIVE_MAX_BYTES = 60 * 1024; // fetch keepalive 본문 한도(64KB) 아래

// 서버 services/local_prefs.py 와 같은 규칙 — 기기 값·캐시·비밀 가능성이 있는 값은 올리지 않는다.
const SYNC_EXCLUDED = new Set(['k8s:theme', 'k8s:accent', 'k8s:debug-flags-v1', 'k8s:playbook-ssh-creds']);
const SYNC_EXCLUDED_PREFIXES = ['k8s:img:work-item:', 'pep:popout:', 'k8s:saved-cmd:'];

export function isSyncableKey(key: string): boolean {
  if (!isPersonalKey(key) || SYNC_EXCLUDED.has(key)) return false;
  return !SYNC_EXCLUDED_PREFIXES.some((p) => key.startsWith(p));
}

type Values = Record<string, string>;
interface Remote { values: Values; rev: number; rejected?: string[] }
interface Base { rev: number; values: Values; skip: string[] }

function readAuth(): { token: string; userId: string } | null {
  try {
    // 비밀번호를 바꾼 탭은 토큰을 탭 전용(sessionStorage)으로 든다(stores/authStore.ts) — 그쪽을 먼저 본다.
    const token = sessionStorage.getItem(TAB_TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
    const user = JSON.parse(sessionStorage.getItem(TAB_USER_KEY) ?? localStorage.getItem(USER_KEY) ?? 'null') as { id?: unknown } | null;
    const userId = user && user.id != null ? String(user.id) : '';
    if (!token || !userId) return null;
    // 지금 깔린 로컬 설정이 다른 계정 것이면(프로필 전환 전) 건드리지 않는다.
    const owner = localStorage.getItem(OWNER_KEY);
    if (owner && owner !== userId) return null;
    return { token, userId };
  } catch {
    return null;
  }
}

function loadBase(userId: string): Base | null {
  try {
    const raw = JSON.parse(localStorage.getItem(BASE_PREFIX + userId) ?? 'null') as Partial<Base> | null;
    if (!raw || typeof raw.values !== 'object' || raw.values === null) return null;
    return { rev: Number(raw.rev) || 0, values: raw.values as Values, skip: Array.isArray(raw.skip) ? raw.skip : [] };
  } catch {
    return null;
  }
}

function saveBase(userId: string, base: Base): void {
  try {
    localStorage.setItem(BASE_PREFIX + userId, JSON.stringify(base));
  } catch { /* quota — 다음 동기화 때 다시 맞춘다 */ }
}

function localValues(skip: string[] = []): Values {
  const out: Values = {};
  for (const [k, v] of Object.entries(snapshotPersonal())) {
    if (isSyncableKey(k) && v.length <= MAX_VALUE_CHARS && !skip.includes(k)) out[k] = v;
  }
  return out;
}

function syncable(values: Values, skip: string[]): Values {
  const out: Values = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (typeof v === 'string' && isSyncableKey(k) && !skip.includes(k)) out[k] = v;
  }
  return out;
}

async function call(
  method: 'GET' | 'PATCH',
  token: string,
  opts: { body?: unknown; signal?: AbortSignal; keepalive?: boolean } = {},
): Promise<Remote> {
  const res = await fetch(API, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
    keepalive: opts.keepalive,
  });
  if (res.status === 404) {
    // 엔드포인트가 없는 backend(1.58 미만)가 응답했다 — 롤링 배포 중이거나 새 backend 파드가 기동하지 못해
    // 구버전 파드가 남아 있다는 뜻이다. 동기화는 건너뛰고 이 기기 설정으로 계속한다.
    throw new Error('local-prefs 404 — 구버전 backend 가 응답함(배포 진행 중이거나 새 backend 파드 기동 실패)');
  }
  if (!res.ok) throw new Error(`local-prefs ${method} ${res.status}`);
  return (await res.json()) as Remote;
}

function setLocal(key: string, value: string | undefined): void {
  if (value === undefined) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

/**
 * 서버와 전체를 맞춘다. 서버 값을 이 기기에 깔았으면 true — 호출부가 화면이 뜨기 전이 아니면 새로 고쳐야 한다.
 * 실패(서버 미도달·시간 초과)는 조용히 false — 로컬 설정만으로 계속 동작한다.
 */
export async function syncLocalPrefs(timeoutMs = 5_000): Promise<boolean> {
  const auth = readAuth();
  if (!auth) return false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const prev = loadBase(auth.userId);
    const skip = prev?.skip ?? [];
    const remoteRaw = await call('GET', auth.token, { signal: ctl.signal });
    const remote = syncable(remoteRaw.values, skip);
    const local = localValues(skip);
    const toSet: Values = {};
    const toRemove: string[] = [];
    let applied = false;

    if (!prev) {
      for (const [k, r] of Object.entries(remote)) {
        if (local[k] !== r) { setLocal(k, r); applied = true; }
      }
      for (const [k, l] of Object.entries(local)) if (!(k in remote)) toSet[k] = l;
    } else {
      const keys = new Set([...Object.keys(prev.values), ...Object.keys(local), ...Object.keys(remote)]);
      for (const k of keys) {
        const b = prev.values[k];
        const l = local[k];
        const r = remote[k];
        if (l === b) {
          if (r !== b) { setLocal(k, r); applied = true; }
        } else if (l !== r) {
          if (l === undefined) toRemove.push(k);
          else toSet[k] = l;
        }
      }
    }

    let base: Base = { rev: remoteRaw.rev, values: remote, skip };
    if (Object.keys(toSet).length || toRemove.length) {
      const res = await call('PATCH', auth.token, { body: { set: toSet, remove: toRemove }, signal: ctl.signal });
      const nextSkip = [...new Set([...skip, ...(res.rejected ?? [])])];
      base = { rev: res.rev, values: syncable(res.values, nextSkip), skip: nextSkip };
    }
    saveBase(auth.userId, base);
    return applied;
  } catch (e) {
    console.warn('[localPrefsSync] 서버와 맞추지 못했다 — 이 기기 설정으로 계속한다', e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let pushing = false;

/**
 * 이 기기에서 바뀐 키만 올린다(서버 값은 깔지 않는다). 기준본이 없으면(전체 동기화 전) 아무것도 하지 않는다.
 * ``keepalive`` 는 탭 숨김·로그아웃 직전처럼 페이지가 곧 사라질 때 — 첫 await 전에 fetch 를 내보낸다.
 */
export async function pushLocalPrefs(keepalive = false): Promise<void> {
  if (pushing && !keepalive) return;
  const auth = readAuth();
  if (!auth) return;
  const base = loadBase(auth.userId);
  if (!base) return;
  const local = localValues(base.skip);
  const set: Values = {};
  const remove: string[] = [];
  for (const k of new Set([...Object.keys(base.values), ...Object.keys(local)])) {
    if (local[k] === base.values[k]) continue;
    if (local[k] === undefined) remove.push(k);
    else set[k] = local[k];
  }
  if (!Object.keys(set).length && !remove.length) return;
  const body = { set, remove };
  const useKeepalive = keepalive && JSON.stringify(body).length < KEEPALIVE_MAX_BYTES;
  pushing = true;
  try {
    const res = await call('PATCH', auth.token, { body, keepalive: useKeepalive });
    // 올린 키만 기준본에 반영한다 — 응답에 섞인 다른 기기 변경은 다음 진입 때 3-way 로 깐다.
    const latest = loadBase(auth.userId) ?? base;
    const skip = [...new Set([...latest.skip, ...(res.rejected ?? [])])];
    const values = { ...latest.values };
    for (const [k, v] of Object.entries(set)) values[k] = v;
    for (const k of remove) delete values[k];
    for (const k of skip) delete values[k];
    saveBase(auth.userId, { rev: latest.rev, values, skip });
  } catch {
    /* 서버 미도달 — 다음 주기에 다시 올린다 */
  } finally {
    pushing = false;
  }
}

let started = false;

/** 앱 진입 전에 한 번 맞추고(최대 1.5초 대기), 이후 이 기기 변경을 주기적으로 올린다. */
export async function bootLocalPrefsSync(): Promise<void> {
  await syncLocalPrefs(1_500);
  if (started) return;
  started = true;
  window.setInterval(() => { void pushLocalPrefs(); }, PUSH_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void pushLocalPrefs(true);
  });
}
