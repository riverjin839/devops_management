/**
 * 가입 신청 비밀번호·아이디 규칙 — backend `services/signup_service.py` 의 `password_problems` /
 * `USERNAME_RE` 와 같은 규칙을 화면에서 미리 보여 주기 위한 사본. 최종 판정은 서버가 한다
 * (흔한 비밀번호 목록·예약 아이디는 서버에서만 막는다).
 */
export const SIGNUP_USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export interface PasswordRule {
  key: 'length' | 'mix' | 'noSpace' | 'noUsername';
  ok: boolean;
}

export function passwordRules(password: string, username: string, minLength: number): PasswordRule[] {
  const u = username.trim().toLowerCase();
  return [
    { key: 'length', ok: password.length >= minLength && password.length <= 128 },
    { key: 'mix', ok: /[A-Za-z]/.test(password) && /\d/.test(password) },
    { key: 'noSpace', ok: password.length > 0 && !/\s/.test(password) },
    { key: 'noUsername', ok: password.length > 0 && !(u.length >= 3 && password.toLowerCase().includes(u)) },
  ];
}
