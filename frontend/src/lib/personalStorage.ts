/**
 * 브라우저(localStorage) 개인 설정의 **계정별 분리** + 내보내기/가져오기 도우미.
 *
 * 테마·강조색·그룹 접힘·화면별 보기 모드 등 40여 개 화면이 localStorage 에 개인 설정을 둔다.
 * 키에 사용자 구분이 없어 공용 PC 에서 A 가 로그아웃하고 B 가 로그인하면 A 의 설정을 그대로 물려받았다.
 * 40여 개 호출부를 전부 고치는 대신, 로그인 시점에 "지금 localStorage 에 깔린 개인 설정이 누구 것인지"
 * (`OWNER_KEY`)를 보고 다른 사람이면 통째로 바꿔 끼운다:
 *
 *   1. 현재 주인의 개인 키를 `pep:profile:{주인 id}` 한 덩어리로 보관하고 원래 키는 지운다.
 *   2. 로그인한 사람의 보관본이 있으면 풀어서 원래 키로 되돌린다(없으면 기본값으로 시작).
 *   3. 모듈 로드 시점에 localStorage 를 읽는 store 들이 새 값을 쓰도록 화면을 새로 고친다(호출부 책임).
 *
 * 주인 표식이 없는 첫 로그인(이 기능 배포 직후)은 지금 값을 그 사람 것으로 인정한다 — 혼자 쓰던
 * 브라우저에서 설정이 사라지지 않게.
 *
 * 기기에 묶인 값(로그인 토큰, 창·패널 폭)은 사람이 아니라 화면 크기를 따르므로 바꿔 끼우지 않는다.
 */

const OWNER_KEY = 'pep:profile-owner';
const PROFILE_PREFIX = 'pep:profile:';
const PERSONAL_PREFIXES = ['k8s:', 'pep:', 'pep.', 'cluster-links-'];
const DEVICE_KEYS = new Set(['k8s:auth:token', 'k8s:auth:user', 'k8s:theme-migrated-light-default', OWNER_KEY]);
const DEVICE_PATTERN = /width/i; // 사이드바·패널·컬럼 폭 — 기기(화면) 설정

/** 로그아웃 때 같이 지울 탭 단위 비밀 — 다음 사람이 이전 사람의 SSH 자격증명으로 실행하지 못하게. */
const SESSION_SECRET_KEYS = ['k8s:playbook-ssh-creds'];

export function isPersonalKey(key: string): boolean {
  if (DEVICE_KEYS.has(key) || key.startsWith(PROFILE_PREFIX) || DEVICE_PATTERN.test(key)) return false;
  return PERSONAL_PREFIXES.some((p) => key.startsWith(p));
}

function personalKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && isPersonalKey(k)) out.push(k);
  }
  return out;
}

/** 지금 깔린 개인 키 전체(내보내기용). */
export function snapshotPersonal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const k of personalKeys()) {
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    }
  } catch { /* 저장소 접근 불가 — 빈 스냅샷 */ }
  return out;
}

/** 개인 키를 통째로 교체(가져오기용). 허용되지 않는 키는 무시한다. 반환: 쓴 키 수. */
export function replacePersonal(values: Record<string, unknown>): number {
  let written = 0;
  try {
    for (const k of personalKeys()) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(values)) {
      if (!isPersonalKey(k) || typeof v !== 'string') continue;
      localStorage.setItem(k, v);
      written++;
    }
  } catch { /* quota 등 — 쓴 만큼만 반영 */ }
  return written;
}

/**
 * 로그인한 사용자의 개인 설정을 깐다. 다른 사람 것이 깔려 있었으면 바꿔 끼우고 true 를 돌려준다
 * (호출부가 새로 고침해야 store 들이 새 값을 읽는다). 보관에 실패하면(quota) 아무것도 지우지 않고
 * false — 설정이 섞이는 편이 남의 설정을 날리는 것보다 낫다.
 */
export function activateProfile(userId: string): boolean {
  if (!userId) return false;
  try {
    const owner = localStorage.getItem(OWNER_KEY);
    if (owner === userId) return false;
    if (!owner) {
      localStorage.setItem(OWNER_KEY, userId);
      return false;
    }
    const live = snapshotPersonal();
    localStorage.setItem(PROFILE_PREFIX + owner, JSON.stringify(live));
    for (const k of Object.keys(live)) localStorage.removeItem(k);

    const savedRaw = localStorage.getItem(PROFILE_PREFIX + userId);
    if (savedRaw) {
      const saved = JSON.parse(savedRaw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(saved)) {
        if (isPersonalKey(k) && typeof v === 'string') localStorage.setItem(k, v);
      }
      localStorage.removeItem(PROFILE_PREFIX + userId);
    }
    localStorage.setItem(OWNER_KEY, userId);
    return true;
  } catch (e) {
    console.warn('[personalStorage] 계정별 설정 전환 실패 — 현재 설정을 유지한다', e);
    return false;
  }
}

export function clearSessionSecrets(): void {
  try {
    for (const k of SESSION_SECRET_KEYS) sessionStorage.removeItem(k);
  } catch { /* ignore */ }
}
