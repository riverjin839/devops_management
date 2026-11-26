import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Circle, Info, Loader2, MailCheck, UserPlus } from 'lucide-react';
import { authApi } from '@/services/api';
import { passwordRules, SIGNUP_USERNAME_RE } from '@/lib/signupPolicy';
import type { SignupPublicConfig } from '@/types';

const inputCls =
  'w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';

interface Props {
  config: SignupPublicConfig;
  /** 로그인 폼으로 돌아간다 — 접수 후에는 신청한 아이디를 로그인 폼에 채워 준다. */
  onBack: (username?: string) => void;
}

/** 로그인 화면의 가입 신청 폼 — 접수만 하고 계정은 관리자 승인 때 만들어진다(`/auth/signup`). */
export function SignupForm({ config, onBack }: Props) {
  const { t } = useTranslation();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const [form, setForm] = useState({
    username: '', displayName: '', email: '', department: '', reason: '', password: '', confirm: '', website: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((s) => ({ ...s, [k]: e.target.value }));

  const rules = passwordRules(form.password, form.username, config.minPasswordLength);
  const rulesOk = rules.every((r) => r.ok);
  const usernameOk = SIGNUP_USERNAME_RE.test(form.username.trim());
  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;
  const canSubmit = !submitting && usernameOk && form.displayName.trim() && form.email.trim()
    && rulesOk && form.confirm === form.password;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      await authApi.submitSignup({
        username: form.username.trim(),
        password: form.password,
        displayName: form.displayName.trim(),
        email: form.email.trim(),
        department: form.department.trim() || undefined,
        reason: form.reason.trim() || undefined,
        website: form.website || undefined,
      });
      setDone(form.username.trim());
    } catch (err) {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      setError(typeof detail === 'string' ? detail : t('login.signup.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-4">
        <div role="status" className="flex items-start gap-2 rounded-md border border-border bg-secondary/60 px-3 py-3 text-sm">
          <MailCheck className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="font-medium">{t('login.signup.doneTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('login.signup.done', { username: done })}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onBack(done)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          {t('login.signup.back')}
        </button>
      </div>
    );
  }

  const domains = config.allowedEmailDomains;

  return (
    <form onSubmit={handleSubmit} className="space-y-3" noValidate>
      <div>
        <h2 className="text-sm font-semibold">{t('login.signup.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('login.signup.intro')}</p>
      </div>
      {config.notice && (
        <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/60 px-3 py-2 text-xs whitespace-pre-line">
          <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{config.notice}</span>
        </div>
      )}

      <div>
        <label htmlFor={f('username')} className="block text-sm font-medium mb-1">{t('login.signup.username')}</label>
        <input id={f('username')} type="text" autoComplete="username" value={form.username} onChange={set('username')}
          disabled={submitting} required maxLength={64} aria-describedby={f('username-hint')}
          aria-invalid={form.username.length > 0 && !usernameOk} className={inputCls} />
        <p id={f('username-hint')} className={`mt-1 text-xs ${form.username.length > 0 && !usernameOk ? 'text-destructive' : 'text-muted-foreground'}`}>
          {t('login.signup.usernameHint')}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={f('name')} className="block text-sm font-medium mb-1">{t('login.signup.displayName')}</label>
          <input id={f('name')} type="text" autoComplete="name" value={form.displayName} onChange={set('displayName')}
            disabled={submitting} required maxLength={128} className={inputCls} />
        </div>
        <div>
          <label htmlFor={f('dept')} className="block text-sm font-medium mb-1">{t('login.signup.department')}</label>
          <input id={f('dept')} type="text" autoComplete="organization" value={form.department} onChange={set('department')}
            disabled={submitting} maxLength={128} className={inputCls} />
        </div>
      </div>

      <div>
        <label htmlFor={f('email')} className="block text-sm font-medium mb-1">{t('login.signup.email')}</label>
        <input id={f('email')} type="email" autoComplete="email" value={form.email} onChange={set('email')}
          disabled={submitting} required maxLength={255} aria-describedby={domains.length ? f('email-hint') : undefined}
          className={inputCls} />
        {domains.length > 0 && (
          <p id={f('email-hint')} className="mt-1 text-xs text-muted-foreground">
            {t('login.signup.emailHint', { domains: domains.map((d) => `@${d}`).join(', ') })}
          </p>
        )}
      </div>

      <div>
        <label htmlFor={f('reason')} className="block text-sm font-medium mb-1">{t('login.signup.reason')}</label>
        <textarea id={f('reason')} rows={2} value={form.reason} onChange={set('reason')} disabled={submitting}
          maxLength={1000} placeholder={t('login.signup.reasonPlaceholder')} className={`${inputCls} resize-y`} />
      </div>

      <div>
        <label htmlFor={f('pw')} className="block text-sm font-medium mb-1">{t('login.signup.password')}</label>
        <input id={f('pw')} type="password" autoComplete="new-password" value={form.password} onChange={set('password')}
          disabled={submitting} required maxLength={128} aria-describedby={f('pw-rules')} className={inputCls} />
        <ul id={f('pw-rules')} aria-label={t('login.signup.rulesLabel')} className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
          {rules.map((r) => (
            <li key={r.key} className={`flex items-center gap-1 ${r.ok ? 'text-foreground' : 'text-muted-foreground'}`}>
              {r.ok
                ? <Check className="w-3 h-3" aria-hidden="true" />
                : <Circle className="w-3 h-3" aria-hidden="true" />}
              <span>
                {r.key === 'length' && t('login.signup.ruleLength', { n: config.minPasswordLength })}
                {r.key === 'mix' && t('login.signup.ruleMix')}
                {r.key === 'noSpace' && t('login.signup.ruleNoSpace')}
                {r.key === 'noUsername' && t('login.signup.ruleNoUsername')}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <label htmlFor={f('pw2')} className="block text-sm font-medium mb-1">{t('login.signup.passwordConfirm')}</label>
        <input id={f('pw2')} type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')}
          disabled={submitting} required maxLength={128} aria-invalid={mismatch} className={inputCls} />
        {mismatch && <p className="mt-1 text-xs text-destructive">{t('login.signup.mismatch')}</p>}
      </div>

      {/* 봇용 숨김 필드(honeypot) — 화면·보조기기·탭 이동 모두에서 빠진다. 값이 있으면 서버가 버린다. */}
      <div aria-hidden="true" className="absolute -left-[10000px] w-px h-px overflow-hidden">
        <label htmlFor={f('website')}>Website</label>
        <input id={f('website')} type="text" tabIndex={-1} autoComplete="off" value={form.website} onChange={set('website')} />
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <UserPlus className="w-4 h-4" aria-hidden="true" />}
        {submitting ? t('login.signup.submitting') : t('login.signup.submit')}
      </button>
      <button
        type="button"
        onClick={() => onBack()}
        disabled={submitting}
        className="w-full flex items-center justify-center gap-1.5 px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded-md transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
        {t('login.signup.back')}
      </button>
    </form>
  );
}
