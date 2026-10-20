import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Loader2, PlugZap, Save, ShieldCheck } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { RunLogPanel, useToast } from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { authApi } from '@/services/api';
import { formatApiError } from '@/lib/utils';

type OidcSettings = Awaited<ReturnType<typeof authApi.oidcSettings>>['data'];
type OidcTestResult = Awaited<ReturnType<typeof authApi.testOidcSettings>>['data'];

interface Draft {
  enabled: boolean;
  displayName: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  clearClientSecret: boolean;
  scopes: string;
  usernameClaim: string;
  displayNameClaim: string;
  emailClaim: string;
  autoProvision: boolean;
  defaultRole: 'viewer' | 'operator';
  allowedDomains: string;
  requireEmailVerified: boolean;
  publicBaseUrl: string;
}

function toDraft(s: OidcSettings): Draft {
  return {
    enabled: s.enabled,
    displayName: s.displayName,
    issuer: s.issuer,
    clientId: s.clientId,
    clientSecret: '',
    clearClientSecret: false,
    scopes: s.scopes,
    usernameClaim: s.usernameClaim,
    displayNameClaim: s.displayNameClaim,
    emailClaim: s.emailClaim,
    autoProvision: s.autoProvision,
    defaultRole: s.defaultRole,
    allowedDomains: s.allowedDomains.join('\n'),
    requireEmailVerified: s.requireEmailVerified ?? true,
    publicBaseUrl: s.publicBaseUrl,
  };
}

const STEP_LABELS: Record<string, string> = {
  issuer: 'Issuer 주소',
  discovery: 'Discovery',
  algorithms: '서명 알고리즘',
  jwks: 'JWKS(서명 키)',
};

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';

/** Settings ▸ 접근 제어 — 사내 IdP SSO(OIDC) 로그인 (R-7·D-079).
 *  비밀번호 로그인은 그대로 두고 로그인 화면에 "{표시 이름}(으)로 로그인" 버튼을 더한다. 설정 원천은
 *  AppSetting `auth.oidc`(admin 전용 API). client secret 은 암호화 저장되고 화면에는 저장 여부만 보인다. */
export function OidcSettingsPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const { data, isLoading, error } = useQuery({
    queryKey: ['auth', 'oidc-settings'],
    queryFn: async () => (await authApi.oidcSettings()).data,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => { if (data) setDraft(toDraft(data)); }, [data]);

  const save = useMutation({
    mutationFn: (d: Draft) => authApi.updateOidcSettings({
      enabled: d.enabled,
      displayName: d.displayName,
      issuer: d.issuer,
      clientId: d.clientId,
      ...(d.clientSecret.trim() ? { clientSecret: d.clientSecret.trim() } : {}),
      ...(d.clearClientSecret ? { clearClientSecret: true } : {}),
      scopes: d.scopes,
      usernameClaim: d.usernameClaim,
      displayNameClaim: d.displayNameClaim,
      emailClaim: d.emailClaim,
      autoProvision: d.autoProvision,
      defaultRole: d.defaultRole,
      allowedDomains: d.allowedDomains.split(/[\n,]/).map((v) => v.trim()).filter(Boolean),
      requireEmailVerified: d.requireEmailVerified,
      publicBaseUrl: d.publicBaseUrl,
    }),
    onSuccess: () => {
      toast.success('SSO 설정 저장됨');
      void qc.invalidateQueries({ queryKey: ['auth', 'oidc-settings'] });
      void qc.invalidateQueries({ queryKey: ['auth', 'oidc-config'] });
    },
    onError: (e) => toast.error('저장 실패', formatApiError(e)),
  });

  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('settings-oidc');
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    if (!draft || testing) return;
    setTesting(true);
    const issuer = draft.issuer.trim();
    const r = await runLogged<OidcTestResult>(runLog, {
      title: 'SSO 연결 확인',
      first: `${issuer || '(저장된 Issuer)'} — Discovery·JWKS 조회`,
      fn: async () => (await authApi.testOidcSettings(issuer)).data,
      summarize: (res): RunLogEntry[] => {
        const lines: RunLogEntry[] = res.steps.map((s) => [
          s.ok ? 'info' : 'error',
          `${STEP_LABELS[s.name] ?? s.name} ${s.ok ? '확인' : '실패'} — ${s.detail}`,
        ]);
        if (res.authorizationEndpoint) lines.push(['info', `authorize: ${res.authorizationEndpoint}`]);
        if (res.tokenEndpoint) lines.push(['info', `token: ${res.tokenEndpoint}`]);
        if (res.pkceS256 === false) lines.push(['warn', 'IdP 가 PKCE S256 을 광고하지 않음 — 로그인이 거절될 수 있음']);
        lines.push(res.ok ? ['info', '연결 확인 완료'] : ['error', '연결 확인 실패']);
        return lines;
      },
    });
    if (r.ok) {
      if (r.data.ok) toast.success('IdP 연결 확인 완료');
      else toast.error('IdP 연결 확인 실패', r.data.steps.find((s) => !s.ok)?.detail);
    } else if (!r.aborted) {
      toast.error('연결 확인 실패', formatApiError(r.error));
    }
    setTesting(false);
  };

  const copyRedirect = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.redirectUri);
      toast.success('Redirect URI 복사됨');
    } catch {
      toast.error('복사 실패', data.redirectUri);
    }
  };

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = !!(data && draft) && JSON.stringify(toDraft(data)) !== JSON.stringify(draft);

  return (
    <MacCard
      title="사내 SSO 로그인 (OIDC)"
      icon={ShieldCheck}
      description="비밀번호 로그인은 그대로 두고 사내 IdP 로그인 버튼을 더합니다."
    >
      {isLoading || !draft ? (
        error ? (
          <p role="alert" className="text-sm text-destructive">{formatApiError(error, 'SSO 설정을 불러오지 못했습니다.')}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> 불러오는 중…
          </p>
        )
      ) : (
        <div className="space-y-4">
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              IdP 에 이 앱(Client)을 등록할 때 아래 <b>Redirect URI</b> 를 그대로 등록하세요. 리버스 프록시·Ingress
              뒤라 주소가 다르게 보이면 <b>공개 주소</b>를 채우면 그 값으로 계산됩니다.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-xl bg-secondary px-2 py-1 font-mono text-foreground">
                {data?.redirectUri}
              </code>
              <button
                type="button"
                onClick={copyRedirect}
                title="Redirect URI 복사"
                aria-label="Redirect URI 복사"
                className="inline-flex items-center rounded-xl border border-border px-2 py-1 hover:bg-secondary"
              >
                <Copy className="w-3.5 h-3.5" aria-hidden />
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <span>로그인 화면에 SSO 버튼 표시 <span className="text-muted-foreground">(Issuer·Client ID 가 있어야 켤 수 있음)</span></span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={f('display')} className="block text-xs font-medium mb-1">버튼 표시 이름</label>
              <input id={f('display')} className={inputCls} value={draft.displayName}
                onChange={(e) => set('displayName', e.target.value)} placeholder="사내 SSO" />
            </div>
            <div>
              <label htmlFor={f('issuer')} className="block text-xs font-medium mb-1">Issuer</label>
              <input id={f('issuer')} className={`${inputCls} font-mono`} value={draft.issuer}
                onChange={(e) => set('issuer', e.target.value)} placeholder="https://sso.corp/realms/main" />
              <p className="mt-1 text-[11px] text-muted-foreground">
                <code>/.well-known/openid-configuration</code> 앞까지의 주소
              </p>
            </div>
            <div>
              <label htmlFor={f('client')} className="block text-xs font-medium mb-1">Client ID</label>
              <input id={f('client')} className={`${inputCls} font-mono`} value={draft.clientId}
                onChange={(e) => set('clientId', e.target.value)} />
            </div>
            <div>
              <label htmlFor={f('secret')} className="block text-xs font-medium mb-1">Client Secret</label>
              <input id={f('secret')} type="password" autoComplete="new-password" className={`${inputCls} font-mono`}
                value={draft.clientSecret} disabled={draft.clearClientSecret}
                onChange={(e) => set('clientSecret', e.target.value)}
                placeholder={data?.hasSecret ? '저장됨 — 바꿀 때만 입력' : '공개 클라이언트면 비워 둠'} />
              {data?.hasSecret && (
                <label className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <input type="checkbox" checked={draft.clearClientSecret}
                    onChange={(e) => set('clearClientSecret', e.target.checked)} />
                  저장된 secret 삭제
                </label>
              )}
            </div>
            <div>
              <label htmlFor={f('scopes')} className="block text-xs font-medium mb-1">Scope</label>
              <input id={f('scopes')} className={`${inputCls} font-mono`} value={draft.scopes}
                onChange={(e) => set('scopes', e.target.value)} placeholder="openid profile email" />
            </div>
            <div>
              <label htmlFor={f('base')} className="block text-xs font-medium mb-1">공개 주소 (선택)</label>
              <input id={f('base')} className={`${inputCls} font-mono`} value={draft.publicBaseUrl}
                onChange={(e) => set('publicBaseUrl', e.target.value)} placeholder="https://pep.corp" />
              <p className="mt-1 text-[11px] text-muted-foreground">브라우저가 여는 PEP 주소. 비우면 요청 기준</p>
            </div>
          </div>

          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="mb-1 text-xs font-medium">ID 토큰 claim 매핑</legend>
            <div>
              <label htmlFor={f('uclaim')} className="block text-[11px] text-muted-foreground mb-1">사용자명 → PEP username</label>
              <input id={f('uclaim')} className={`${inputCls} font-mono`} value={draft.usernameClaim}
                onChange={(e) => set('usernameClaim', e.target.value)} placeholder="preferred_username" />
              <p className="mt-1 text-[11px] text-muted-foreground">
                같은 이름의 기존 PEP 계정(관리자 포함)으로 로그인된다. IdP 에서 사용자가 직접 바꿀 수 없는 값(사번 등)을 고른다
              </p>
            </div>
            <div>
              <label htmlFor={f('nclaim')} className="block text-[11px] text-muted-foreground mb-1">표시 이름</label>
              <input id={f('nclaim')} className={`${inputCls} font-mono`} value={draft.displayNameClaim}
                onChange={(e) => set('displayNameClaim', e.target.value)} placeholder="name" />
            </div>
            <div>
              <label htmlFor={f('eclaim')} className="block text-[11px] text-muted-foreground mb-1">이메일</label>
              <input id={f('eclaim')} className={`${inputCls} font-mono`} value={draft.emailClaim}
                onChange={(e) => set('emailClaim', e.target.value)} placeholder="email" />
            </div>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.autoProvision}
                  onChange={(e) => set('autoProvision', e.target.checked)} />
                <span>처음 로그인한 사용자 계정 자동 생성</span>
              </label>
              <div>
                <label htmlFor={f('role')} className="block text-xs font-medium mb-1">자동 생성 계정 역할</label>
                <select id={f('role')} value={draft.defaultRole} disabled={!draft.autoProvision}
                  onChange={(e) => set('defaultRole', e.target.value === 'operator' ? 'operator' : 'viewer')}
                  className="bg-secondary border border-border rounded-xl px-2 py-1.5 text-sm disabled:opacity-60">
                  <option value="viewer">viewer</option>
                  <option value="operator">operator</option>
                </select>
              </div>
              <p className="text-[11px] text-muted-foreground">
                끄면 PEP 에 같은 username 이 이미 있어야 로그인됩니다. 자동 생성 계정은 비밀번호가 없어 SSO 로만 로그인합니다.
              </p>
            </div>
            <div>
              <label htmlFor={f('domains')} className="block text-xs font-medium mb-1">허용 이메일 도메인 (선택)</label>
              <textarea id={f('domains')} rows={3} value={draft.allowedDomains}
                onChange={(e) => set('allowedDomains', e.target.value)} placeholder={'corp.example\nsub.corp.example'}
                className={`${inputCls} font-mono`} />
              <p className="mt-1 text-[11px] text-muted-foreground">한 줄에 하나. 비우면 제한 없음(하위 도메인 포함)</p>
              <label className="mt-2 flex items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5" checked={draft.requireEmailVerified}
                  onChange={(e) => set('requireEmailVerified', e.target.checked)} />
                <span>
                  IdP 가 검증한 이메일만 허용 (<code className="font-mono">email_verified=true</code>)
                  <span className="block text-[11px] text-muted-foreground">
                    도메인 제한이 있을 때 적용. 사용자가 이메일을 직접 고칠 수 있는 IdP 에서 정책 우회를 막는다. email_verified 를 내지 않는 IdP 만 끈다
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={runTest}
              disabled={testing || (!draft.issuer.trim() && !data?.issuer)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-xl border border-border hover:bg-secondary disabled:opacity-50 transition-colors"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <PlugZap className="w-4 h-4" aria-hidden />}
              연결 확인
            </button>
            <button
              type="button"
              onClick={() => save.mutate(draft)}
              disabled={!dirty || save.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Save className="w-4 h-4" aria-hidden />}
              저장
            </button>
          </div>

          <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
        </div>
      )}
    </MacCard>
  );
}
