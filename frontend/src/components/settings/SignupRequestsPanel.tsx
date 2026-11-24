import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Inbox, Loader2, Save, UserPlus, X } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ConfirmDialog, EmptyState, RunLogPanel, SegTabs, useToast } from '@/components/common';
import { useRunLog, runLogged } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { authApi } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import type { SignupRequestItem, SignupSettings, SignupStatus } from '@/types';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';
const hintCls = 'mt-1 text-xs text-muted-foreground';

const STATUS_LABEL: Record<SignupStatus, string> = {
  pending: '승인 대기',
  approved: '승인',
  rejected: '거절',
  expired: '만료',
  withdrawn: '철회',
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

interface Draft {
  enabled: boolean;
  minPasswordLength: string;
  allowedEmailDomains: string;
  pendingExpireDays: string;
  retentionDays: string;
  maxPending: string;
  notice: string;
}

const toDraft = (s: SignupSettings): Draft => ({
  enabled: s.enabled,
  minPasswordLength: String(s.minPasswordLength),
  allowedEmailDomains: s.allowedEmailDomains.join('\n'),
  pendingExpireDays: String(s.pendingExpireDays),
  retentionDays: String(s.retentionDays),
  maxPending: String(s.maxPending),
  notice: s.notice,
});

/** Settings ▸ 가입 신청 — 로그인 화면 가입 신청 창구 정책 + 신청 승인·거절.
 *  설정 원천은 AppSetting `auth.signup`, 신청은 `signup_requests`(admin 전용 API). */
export function SignupRequestsPanel() {
  return (
    <div className="space-y-4">
      <SignupSettingsCard />
      <SignupRequestsCard />
    </div>
  );
}

function SignupSettingsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const { data, isLoading, error } = useQuery({
    queryKey: ['auth', 'signup-settings'],
    queryFn: async () => (await authApi.signupSettings()).data,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (data) setDraft(toDraft(data)); }, [data]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = !!(data && draft) && JSON.stringify(toDraft(data)) !== JSON.stringify(draft);

  const save = useMutation({
    mutationFn: (d: Draft) => authApi.updateSignupSettings({
      enabled: d.enabled,
      minPasswordLength: Number(d.minPasswordLength),
      allowedEmailDomains: d.allowedEmailDomains.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
      pendingExpireDays: Number(d.pendingExpireDays),
      retentionDays: Number(d.retentionDays),
      maxPending: Number(d.maxPending),
      notice: d.notice,
    }),
    onSuccess: () => {
      toast.success('가입 신청 설정 저장됨');
      void qc.invalidateQueries({ queryKey: ['auth', 'signup-settings'] });
      void qc.invalidateQueries({ queryKey: ['auth', 'signup-config'] });
    },
    onError: (e) => toast.error('저장 실패', formatApiError(e)),
  });

  return (
    <MacCard
      title="가입 신청 창구"
      icon={UserPlus}
      description="로그인 화면에서 계정을 신청받고, 관리자가 승인하면 계정이 만들어집니다."
      actions={draft && (
        <button
          type="button"
          onClick={() => draft && save.mutate(draft)}
          disabled={!dirty || save.isPending}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Save className="w-3.5 h-3.5" aria-hidden />}
          저장
        </button>
      )}
    >
      {isLoading || !draft ? (
        error ? (
          <p role="alert" className="text-sm text-destructive">{formatApiError(error, '설정을 불러오지 못했습니다.')}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> 불러오는 중…
          </p>
        )
      ) : (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <span>로그인 화면에 가입 신청 열기 <span className="text-muted-foreground">(기본 꺼짐)</span></span>
          </label>
          {data && (data.ldapEnabled || data.oidcEnabled) && (
            <p className="text-xs text-status-warning">
              {data.ldapEnabled ? '사내 디렉터리(LDAP)' : ''}{data.ldapEnabled && data.oidcEnabled ? '·' : ''}{data.oidcEnabled ? 'SSO' : ''}
              {' '}로그인이 켜져 있습니다. 디렉터리·IdP 사용자 이름과 같은 아이디를 승인하면 그 사람이 이 계정으로 들어오게 됩니다 —
              사내 계정이 있는 사람은 자동 생성(LDAP·SSO 설정)을 쓰고, 가입 신청은 외부 협력사처럼 사내 계정이 없는 사람에게만 승인하세요.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={f('domains')} className="block text-xs text-muted-foreground mb-1">허용 이메일 도메인</label>
              <textarea id={f('domains')} rows={3} value={draft.allowedEmailDomains}
                onChange={(e) => set('allowedEmailDomains', e.target.value)}
                placeholder={'corp.example\npartner.example'} className={`${inputCls} font-mono`} />
              <p className={hintCls}>한 줄에 하나(하위 도메인 포함). 비우면 모든 도메인을 받습니다. 이메일 소유 확인은 하지 않으니 승인 때 본인 여부를 확인하세요</p>
            </div>
            <div>
              <label htmlFor={f('notice')} className="block text-xs text-muted-foreground mb-1">신청 화면 안내 문구</label>
              <textarea id={f('notice')} rows={3} maxLength={500} value={draft.notice}
                onChange={(e) => set('notice', e.target.value)}
                placeholder="예) 소속 팀과 필요한 권한을 사유에 적어 주세요. 승인은 영업일 기준 1일 이내입니다."
                className={inputCls} />
              <p className={hintCls}>신청 폼 위에 그대로 보입니다(500자)</p>
            </div>
          </div>
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
            {([
              ['minPasswordLength', '비밀번호 최소 길이', '8~64자. 영문+숫자 필수'],
              ['pendingExpireDays', '승인 대기 기한(일)', '지나면 자동 만료'],
              ['retentionDays', '처리 기록 보관(일)', '승인·거절·만료 기록 삭제 시점'],
              ['maxPending', '대기 건수 상한', '넘으면 새 신청을 받지 않음'],
            ] as const).map(([k, label, hint]) => (
              <div key={k}>
                <label htmlFor={f(k)} className="block text-xs text-muted-foreground mb-1">{label}</label>
                <input id={f(k)} type="number" min={1} value={draft[k]}
                  onChange={(e) => set(k, e.target.value)} className={inputCls} />
                <p className={hintCls}>{hint}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </MacCard>
  );
}

type Decision = { kind: 'approve' | 'reject'; item: SignupRequestItem };

function SignupRequestsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const fid = useId();
  const [status, setStatus] = useState<SignupStatus | 'all'>('pending');
  const { data, isLoading, error } = useQuery({
    queryKey: ['auth', 'signup-requests', status],
    queryFn: async () => (await authApi.listSignupRequests(status)).data,
    refetchInterval: 60_000,
  });
  const [decision, setDecision] = useState<Decision | null>(null);
  const [role, setRole] = useState<'viewer' | 'operator'>('viewer');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('settings-signup');

  const open = (kind: Decision['kind'], item: SignupRequestItem) => {
    setDecision({ kind, item });
    setRole('viewer');
    setNote('');
  };

  const confirm = async () => {
    if (!decision || busy) return;
    const { kind, item } = decision;
    setBusy(true);
    const title = kind === 'approve' ? '가입 승인' : '가입 거절';
    const r = await runLogged(runLog, {
      title,
      first: `${item.displayName} (${item.username}) — ${kind === 'approve' ? `역할 ${role} 로 계정 생성` : '신청 거절'}`,
      fn: async () => (kind === 'approve'
        ? await authApi.approveSignup(item.id, role, note.trim())
        : await authApi.rejectSignup(item.id, note.trim())).data,
      summarize: (res) => (res.status === 'approved'
        ? [['info', `계정 생성 완료 — ${res.username} · 역할 ${res.grantedRole}`]]
        : [['info', `거절 처리 완료 — ${res.username}${res.decisionNote ? ` · 사유: ${res.decisionNote}` : ''}`]]),
    });
    setBusy(false);
    if (r.ok) {
      toast.success(kind === 'approve' ? `${item.username} 계정을 만들었습니다` : `${item.username} 신청을 거절했습니다`);
      setDecision(null);
      void qc.invalidateQueries({ queryKey: ['auth', 'signup-requests'] });
      if (kind === 'approve') {
        void qc.invalidateQueries({ queryKey: ['users'] });
        void qc.invalidateQueries({ queryKey: ['assignees'] });
      }
    } else if (!r.aborted) {
      toast.error(`${title} 실패`, formatApiError(r.error));
      void qc.invalidateQueries({ queryKey: ['auth', 'signup-requests'] });
    }
  };

  const counts = data?.counts;
  const options = (['pending', 'approved', 'rejected', 'expired', 'all'] as const).map(
    (s) => [s, s === 'all' ? '전체' : `${STATUS_LABEL[s]}${counts ? ` ${counts[s] ?? 0}` : ''}`] as const,
  );

  return (
    <MacCard
      title="가입 신청"
      icon={Inbox}
      description="오래된 신청부터 보입니다. 승인할 때 역할을 고르고(viewer·operator), admin 승격은 계정 생성 뒤 사용자 관리에서 합니다."
      actions={<SegTabs value={status} onChange={setStatus} options={options} label="신청 상태" />}
    >
      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> 불러오는 중…
        </p>
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">{formatApiError(error, '신청 목록을 불러오지 못했습니다.')}</p>
      ) : !data || data.items.length === 0 ? (
        <EmptyState icon={Inbox} title={status === 'pending' ? '승인 대기 중인 신청이 없습니다' : '신청 기록이 없습니다'} compact />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="py-2 pr-3 font-medium">신청자</th>
                <th className="py-2 pr-3 font-medium">이메일 · 소속</th>
                <th className="py-2 pr-3 font-medium">사유</th>
                <th className="py-2 pr-3 font-medium">신청</th>
                <th className="py-2 pr-3 font-medium">상태</th>
                <th className="py-2 font-medium text-right">처리</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.id} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{it.displayName}</div>
                    <div className="text-xs text-muted-foreground font-mono">{it.username}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="break-all">{it.email}</div>
                    {it.department && <div className="text-xs text-muted-foreground">{it.department}</div>}
                  </td>
                  <td className="py-2 pr-3 max-w-xs">
                    <p className="text-xs whitespace-pre-line line-clamp-3" title={it.reason ?? undefined}>{it.reason || '—'}</p>
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground whitespace-nowrap">
                    <div>{fmt(it.createdAt)}</div>
                    <div className="font-mono" title={it.userAgent ?? undefined}>{it.requestIp ?? '—'}</div>
                    {it.expiresAt && <div>만료 {fmt(it.expiresAt)}</div>}
                  </td>
                  <td className="py-2 pr-3 text-xs whitespace-nowrap">
                    <div className={it.status === 'rejected' ? 'text-status-critical' : undefined}>{STATUS_LABEL[it.status]}</div>
                    {it.status !== 'pending' && (
                      <div className="text-muted-foreground">
                        {it.decidedBy ?? '자동'} · {fmt(it.decidedAt)}
                        {it.grantedRole && <> · {it.grantedRole}</>}
                      </div>
                    )}
                    {it.decisionNote && <div className="text-muted-foreground max-w-[14rem] whitespace-normal">{it.decisionNote}</div>}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {it.status === 'pending' && (
                      <div className="inline-flex gap-1.5">
                        <button type="button" onClick={() => open('approve', it)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90">
                          <Check className="w-3.5 h-3.5" aria-hidden /> 승인
                        </button>
                        <button type="button" onClick={() => open('reject', it)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-secondary border border-border rounded-xl hover:bg-secondary/80">
                          <X className="w-3.5 h-3.5" aria-hidden /> 거절
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3">
        <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
      </div>

      <ConfirmDialog
        open={!!decision}
        title={decision?.kind === 'approve' ? '가입 승인' : '가입 거절'}
        description={decision ? `${decision.item.displayName} (${decision.item.username}) · ${decision.item.email}` : undefined}
        confirmLabel={decision?.kind === 'approve' ? '승인하고 계정 만들기' : '거절'}
        danger={decision?.kind === 'reject'}
        busy={busy}
        onConfirm={() => { void confirm(); }}
        onCancel={() => setDecision(null)}
      >
        {decision && (
          <div className="space-y-3 text-sm">
            {decision.kind === 'approve' && (
              <fieldset>
                <legend className="mb-1 text-xs text-muted-foreground">부여할 역할</legend>
                <div className="flex gap-4">
                  {(['viewer', 'operator'] as const).map((r) => (
                    <label key={r} className="flex items-center gap-1.5">
                      <input type="radio" name={`${fid}-role`} checked={role === r} onChange={() => setRole(r)} />
                      {r} <span className="text-xs text-muted-foreground">{r === 'viewer' ? '(조회)' : '(실행·변경)'}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div>
              <label htmlFor={`${fid}-note`} className="block text-xs text-muted-foreground mb-1">
                {decision.kind === 'approve' ? '승인 메모 (선택, 관리자만 봄)' : '거절 사유 (선택 — 신청자가 로그인 시 봄)'}
              </label>
              <textarea id={`${fid}-note`} rows={2} maxLength={500} value={note}
                onChange={(e) => setNote(e.target.value)} className={inputCls} />
            </div>
          </div>
        )}
      </ConfirmDialog>
    </MacCard>
  );
}
