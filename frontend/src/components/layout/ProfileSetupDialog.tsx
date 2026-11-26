import { useEffect, useId, useState } from 'react';
import { Loader2, LogOut, UserCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useMyAssignee, useUpdateMyAssignee } from '@/hooks/useAssignees';
import { useToastSafe } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

// 첫 로그인 "내 정보 등록" 팝업.
// GET /ui-settings/assignees/me 의 profileComplete 가 false(이메일·IP·좌석 중 하나라도 비어 있음)면
// 닫을 수 없는 팝업을 띄워 필수 항목을 채우게 한다 — 첫 로그인뿐 아니라, 관리자가 값을 지워
// 다시 비게 된 경우에도 다음 화면 진입 때 같은 팝업이 뜬다. 저장은 본인 행만 고치는
// PUT /ui-settings/assignees/me 로 나가며, 담당 업무는 선택 항목이다.
// 빠져나갈 길은 "로그아웃" 하나 — Escape·바깥 클릭·뒤로가기로는 닫히지 않는다.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// IPv6 는 서버(ipaddress.ip_address)가 최종 판정 — 여기선 콜론이 있는 16진 표기만 대략 거른다.
const IPV6_RE = /^[0-9a-fA-F:]+(%\S+)?$/;

type FormState = { email: string; ip: string; seatLocation: string; duty: string };
type FieldKey = keyof FormState;

function validate(f: FormState): Partial<Record<FieldKey, string>> {
  const err: Partial<Record<FieldKey, string>> = {};
  if (!f.email.trim()) err.email = '이메일을 입력하세요.';
  else if (!EMAIL_RE.test(f.email.trim())) err.email = '이메일 형식이 올바르지 않습니다.';
  const ip = f.ip.trim();
  if (!ip) err.ip = 'IP 주소를 입력하세요.';
  else if (!IPV4_RE.test(ip) && !(ip.includes(':') && IPV6_RE.test(ip))) err.ip = 'IP 주소 형식이 올바르지 않습니다. (예: 10.0.0.1)';
  if (!f.seatLocation.trim()) err.seatLocation = '좌석 위치를 입력하세요.';
  return err;
}

export function ProfileSetupDialog() {
  const currentUser = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.clear);
  const { data, isSuccess } = useMyAssignee(!!currentUser);
  const update = useUpdateMyAssignee();
  const toast = useToastSafe();

  const open = isSuccess && !!data && !data.profileComplete;
  const me = data?.data;

  const [form, setForm] = useState<FormState>({ email: '', ip: '', seatLocation: '', duty: '' });
  const [touched, setTouched] = useState(false);
  // 팝업이 열릴 때 서버에 이미 있는 값으로 채운다(일부만 등록된 경우 다시 입력하지 않게).
  useEffect(() => {
    if (!open || !me) return;
    setForm({
      email: me.email ?? '',
      ip: me.ip ?? '',
      seatLocation: me.seatLocation ?? '',
      duty: me.duty ?? '',
    });
    setTouched(false);
  }, [open, me?.email, me?.ip, me?.seatLocation, me?.duty]); // eslint-disable-line react-hooks/exhaustive-deps

  const fid = useId();
  const errors = validate(form);
  const hasErrors = Object.keys(errors).length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (hasErrors) return;
    update.mutate(
      {
        email: form.email.trim(),
        ip: form.ip.trim(),
        seatLocation: form.seatLocation.trim(),
        duty: form.duty.trim(),
      },
      {
        onSuccess: () => toast.success('내 정보가 등록되었습니다'),
        onError: (err) => toast.error('등록 실패', formatApiError(err)),
      },
    );
  };

  const field = (key: FieldKey, label: string, placeholder: string, required: boolean, type = 'text') => {
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
          autoComplete={key === 'email' ? 'email' : 'off'}
          className={`w-full px-3 py-2 bg-background border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary ${msg ? 'border-destructive' : 'border-border'}`}
        />
        {msg && <p id={`${id}-err`} className="mt-1 text-xs text-destructive">{msg}</p>}
      </div>
    );
  };

  if (!currentUser) return null;

  return (
    // onOpenChange 를 무시 — Escape·바깥 클릭·뒤로가기로 닫지 않는다(필수 등록).
    <Dialog open={open} onOpenChange={() => {}} dismissible={false}>
      <DialogContent hideClose className="max-w-md">
        <form onSubmit={handleSubmit} noValidate>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-primary" />
              내 정보 등록
            </DialogTitle>
            <DialogDescription>
              처음 로그인하셨습니다. 업무 연락·접속 확인을 위해 아래 정보를 등록해 주세요.
              <span className="text-destructive"> *</span> 표시 항목은 필수입니다.
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 pb-4 space-y-3">
            <div className="text-sm font-semibold">
              {me?.name || currentUser.displayName || currentUser.username}
              {me?.employeeId && <span className="ml-2 text-xs font-normal text-muted-foreground">{me.employeeId}</span>}
            </div>
            {field('email', '이메일', 'user@company.com', true, 'email')}
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
              disabled={update.isPending || (touched && hasErrors)}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {update.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              등록
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
