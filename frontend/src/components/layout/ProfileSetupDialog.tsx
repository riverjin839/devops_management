import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, LogOut, UserCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useMyAssignee, useUpdateMyAssignee } from '@/hooks/useAssignees';
import { useToastSafe } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { authApi } from '@/services/api';
import { useAuthStore, type AuthUser } from '@/stores/authStore';

// 첫 로그인 "내 정보 등록" 팝업 — 두 가지를 한 번에 받는다.
//  1) 비밀번호 변경: GET /auth/me 의 mustChangePassword 가 true 면(사번으로 자동 발급된 초기 비밀번호,
//     관리자가 만들어 주거나 재설정한 비밀번호, 부트스트랩 admin) 새 비밀번호를 정해야 한다.
//     LDAP·SSO 계정은 서버가 항상 false 로 내려 이 칸이 나오지 않는다.
//  2) 내 정보: GET /ui-settings/assignees/me 의 profileComplete 가 false(이메일·IP·좌석 중 빈 값)면 채워야 한다.
// 둘 중 하나라도 남아 있으면 닫을 수 없는 팝업이 뜬다 — 빠져나갈 길은 "로그아웃" 하나(Escape·바깥 클릭·뒤로가기 무시).
// 저장 순서는 비밀번호 → 내 정보. 비밀번호를 바꾸면 기존 토큰이 무효가 되므로 응답의 새 토큰을 먼저
// 이 탭에 끼운 뒤(ChangePasswordPage 와 같은 방식) 내 정보를 저장한다.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// IPv6 는 서버(ipaddress.ip_address)가 최종 판정 — 여기선 콜론이 있는 16진 표기만 대략 거른다.
const IPV6_RE = /^[0-9a-fA-F:]+(%\S+)?$/;
const MIN_PASSWORD = 8;

type FormState = {
  email: string; ip: string; seatLocation: string; duty: string;
  currentPassword: string; newPassword: string; confirmPassword: string;
};
type FieldKey = keyof FormState;

function validate(f: FormState, needPassword: boolean, ids: string[]): Partial<Record<FieldKey, string>> {
  const err: Partial<Record<FieldKey, string>> = {};
  if (needPassword) {
    if (!f.currentPassword) err.currentPassword = '현재(초기) 비밀번호를 입력하세요.';
    if (f.newPassword.length < MIN_PASSWORD) err.newPassword = `새 비밀번호는 ${MIN_PASSWORD}자 이상이어야 합니다.`;
    else if (!/[A-Za-z]/.test(f.newPassword) || !/\d/.test(f.newPassword)) err.newPassword = '영문과 숫자를 함께 넣어 주세요.';
    else if (f.newPassword === f.currentPassword) err.newPassword = '현재 비밀번호와 다르게 정하세요.';
    else if (ids.some((id) => id && f.newPassword.toLowerCase() === id.toLowerCase())) err.newPassword = '아이디·사번과 같은 비밀번호는 쓸 수 없습니다.';
    if (f.confirmPassword !== f.newPassword) err.confirmPassword = '새 비밀번호 확인이 일치하지 않습니다.';
  }
  if (!f.email.trim()) err.email = '이메일을 입력하세요.';
  else if (!EMAIL_RE.test(f.email.trim())) err.email = '이메일 형식이 올바르지 않습니다.';
  const ip = f.ip.trim();
  if (!ip) err.ip = 'IP 주소를 입력하세요.';
  else if (!IPV4_RE.test(ip) && !(ip.includes(':') && IPV6_RE.test(ip))) err.ip = 'IP 주소 형식이 올바르지 않습니다. (예: 10.0.0.1)';
  if (!f.seatLocation.trim()) err.seatLocation = '좌석 위치를 입력하세요.';
  return err;
}

const EMPTY: FormState = { email: '', ip: '', seatLocation: '', duty: '', currentPassword: '', newPassword: '', confirmPassword: '' };

export function ProfileSetupDialog() {
  const currentUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.clear);
  const setUser = useAuthStore((s) => s.setUser);
  const scopeSessionToThisTab = useAuthStore((s) => s.scopeSessionToThisTab);
  const qc = useQueryClient();
  const toast = useToastSafe();

  // 로그인 응답에 저장된 값보다 서버 값을 우선한다(관리자 재설정·다른 탭 변경 반영). ChangePasswordPage 와 같은 키.
  const { data: me, isSuccess: meLoaded } = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => (await authApi.me()).data,
    staleTime: 30_000,
    enabled: !!currentUser,
  });
  const { data, isSuccess } = useMyAssignee(!!currentUser);
  const update = useUpdateMyAssignee();

  // 이번 팝업에서 비밀번호를 이미 바꿨는지 — 내 정보 저장만 실패해 다시 누를 때 비밀번호를 또 바꾸지 않게.
  const [passwordDone, setPasswordDone] = useState(false);
  const needPassword = meLoaded && !!me?.mustChangePassword && !passwordDone;
  const needProfile = isSuccess && !!data && !data.profileComplete;
  const open = meLoaded && isSuccess && (needPassword || needProfile);
  const mine = data?.data;

  const [form, setForm] = useState<FormState>(EMPTY);
  const [touched, setTouched] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  // 팝업이 열릴 때 서버에 이미 있는 값으로 채운다(일부만 등록된 경우 다시 입력하지 않게).
  useEffect(() => {
    if (!open || !mine) return;
    setForm((cur) => ({
      ...cur,
      email: mine.email ?? '',
      ip: mine.ip ?? '',
      seatLocation: mine.seatLocation ?? '',
      duty: mine.duty ?? '',
    }));
    setTouched(false);
  }, [open, mine?.email, mine?.ip, mine?.seatLocation, mine?.duty]); // eslint-disable-line react-hooks/exhaustive-deps

  const fid = useId();
  const ids = [currentUser?.username ?? '', mine?.employeeId ?? ''];
  const errors = validate(form, needPassword, ids);
  const hasErrors = Object.keys(errors).length > 0;
  const busy = changingPassword || update.isPending;

  const saveProfile = () => {
    update.mutate(
      {
        email: form.email.trim(),
        ip: form.ip.trim(),
        seatLocation: form.seatLocation.trim(),
        duty: form.duty.trim(),
      },
      {
        onSuccess: () => toast.success('첫 로그인 설정이 끝났습니다'),
        onError: (err) => toast.error('내 정보 저장 실패', formatApiError(err)),
      },
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setTouched(true);
    if (hasErrors) return;
    if (needPassword) {
      setChangingPassword(true);
      try {
        const res = await authApi.changeMyPassword(form.currentPassword, form.newPassword);
        // 비밀번호를 바꾸면 이 탭의 토큰도 무효가 된다 — 응답의 새 토큰을 이 탭 전용으로 끼워 세션을 잇는다.
        const { accessToken, ...nextUser } = res.data as AuthUser & { accessToken?: string | null };
        const updated = { ...nextUser, mustChangePassword: false };
        if (accessToken) scopeSessionToThisTab(accessToken, updated);
        setUser(updated);
        qc.setQueryData(['auth', 'me'], updated);
        setPasswordDone(true);
        setForm((cur) => ({ ...cur, currentPassword: '', newPassword: '', confirmPassword: '' }));
      } catch (err) {
        toast.error('비밀번호 변경 실패', formatApiError(err));
        return;
      } finally {
        setChangingPassword(false);
      }
    }
    saveProfile();
  };

  const field = (key: FieldKey, label: string, placeholder: string, required: boolean, type = 'text', autoComplete = 'off') => {
    const id = `${fid}-${key}`;
    const msg = touched ? errors[key] : undefined;
    return (
      <div>
        <label htmlFor={id} className="block text-xs font-medium text-muted-foreground mb-1">
          {label}{required && <span className="text-destructive ml-0.5" aria-hidden>*</span>}
        </label>
        <input
          id={id}
          type={type}
          value={form[key]}
          onChange={(e) => setForm((cur) => ({ ...cur, [key]: e.target.value }))}
          placeholder={placeholder}
          required={required}
          aria-invalid={!!msg}
          aria-describedby={msg ? `${id}-err` : undefined}
          autoComplete={autoComplete}
          className={`w-full px-3 py-2 bg-background border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary ${msg ? 'border-destructive' : 'border-border'}`}
        />
        {msg && <p id={`${id}-err`} className="mt-1 text-xs text-destructive">{msg}</p>}
      </div>
    );
  };

  if (!currentUser) return null;

  return (
    // onOpenChange 를 무시 — Escape·바깥 클릭·뒤로가기로 닫지 않는다(필수 등록).
    <Dialog open={open} onOpenChange={() => {}} disablePointerDismissal>
      <DialogContent hideClose className="max-w-md">
        <form onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-primary" />
              {needPassword ? '첫 로그인 설정' : '내 정보 등록'}
            </DialogTitle>
            <DialogDescription>
              {needPassword
                ? '처음 로그인하셨습니다. 초기 비밀번호를 바꾸고, 업무 연락·접속 확인을 위해 내 정보를 등록해 주세요.'
                : '업무 연락·접속 확인을 위해 아래 정보를 등록해 주세요.'}
              <span className="text-destructive"> *</span> 표시 항목은 필수입니다.
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 pb-4 space-y-3">
            <div className="text-sm font-semibold">
              {mine?.name || currentUser.displayName || currentUser.username}
              <span className="ml-2 text-xs font-normal text-muted-foreground">{currentUser.username}</span>
            </div>
            {needPassword && (
              <fieldset className="space-y-3 rounded-md border border-border p-3">
                <legend className="px-1 text-xs font-semibold flex items-center gap-1.5">
                  <KeyRound className="w-3.5 h-3.5 text-primary" /> 비밀번호 변경
                </legend>
                {field('currentPassword', '현재(초기) 비밀번호', '사번 또는 안내받은 비밀번호', true, 'password', 'current-password')}
                {field('newPassword', '새 비밀번호', `영문+숫자 ${MIN_PASSWORD}자 이상`, true, 'password', 'new-password')}
                {field('confirmPassword', '새 비밀번호 확인', '한 번 더 입력', true, 'password', 'new-password')}
              </fieldset>
            )}
            {field('email', '이메일', 'user@company.com', true, 'email', 'email')}
            {field('ip', 'IP 주소', '10.0.0.1', true)}
            {field('seatLocation', '좌석 위치', '3층 A-12', true)}
            {field('duty', '담당 업무', 'K8s 운영, CI/CD', false)}
          </div>
          <DialogFooter className="justify-between">
            <button
              type="button"
              onClick={logout}
              className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground rounded-lg hover:bg-secondary hover:text-foreground transition-colors"
            >
              <LogOut className="w-4 h-4" /> 로그아웃
            </button>
            <button
              type="submit"
              disabled={busy || (touched && hasErrors)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              등록
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
