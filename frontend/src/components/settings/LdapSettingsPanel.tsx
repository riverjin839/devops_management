import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, PlugZap, Save } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { RunLogPanel, useToast } from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { authApi } from '@/services/api';
import { formatApiError } from '@/lib/utils';

type LdapSettings = Awaited<ReturnType<typeof authApi.ldapSettings>>['data'];
type LdapTestResult = Awaited<ReturnType<typeof authApi.testLdapSettings>>['data'];

interface Draft {
  enabled: boolean;
  serverUrls: string;
  startTls: boolean;
  tlsVerify: boolean;
  caCertPem: string;
  timeoutSeconds: string;
  bindMode: 'direct' | 'search';
  bindDnTemplate: string;
  serviceBindDn: string;
  bindPassword: string;
  clearBindPassword: boolean;
  userSearchBase: string;
  userSearchFilter: string;
  displayNameAttribute: string;
  emailAttribute: string;
  groupAttribute: string;
  allowedGroups: string;
  autoProvision: boolean;
  defaultRole: 'viewer' | 'operator';
  priority: 'local_first' | 'ldap_first';
  protectLocalAdmins: boolean;
}

function toDraft(s: LdapSettings): Draft {
  return {
    enabled: s.enabled,
    serverUrls: s.serverUrls.join('\n'),
    startTls: s.startTls,
    tlsVerify: s.tlsVerify,
    caCertPem: s.caCertPem,
    timeoutSeconds: String(s.timeoutSeconds),
    bindMode: s.bindMode,
    bindDnTemplate: s.bindDnTemplate,
    serviceBindDn: s.serviceBindDn,
    bindPassword: '',
    clearBindPassword: false,
    userSearchBase: s.userSearchBase,
    userSearchFilter: s.userSearchFilter,
    displayNameAttribute: s.displayNameAttribute,
    emailAttribute: s.emailAttribute,
    groupAttribute: s.groupAttribute,
    allowedGroups: s.allowedGroups.join('\n'),
    autoProvision: s.autoProvision,
    defaultRole: s.defaultRole,
    priority: s.priority,
    protectLocalAdmins: s.protectLocalAdmins,
  };
}

const lines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean);

/** 저장·연결 확인이 함께 쓰는 연결 관련 필드(사용자 입력 → API 키). 비밀번호는 입력했을 때만 싣는다. */
function connectionPayload(d: Draft) {
  return {
    serverUrls: d.serverUrls.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
    startTls: d.startTls,
    tlsVerify: d.tlsVerify,
    caCertPem: d.caCertPem,
    timeoutSeconds: Number(d.timeoutSeconds) || 5,
    bindMode: d.bindMode,
    bindDnTemplate: d.bindDnTemplate,
    serviceBindDn: d.serviceBindDn,
    ...(d.bindPassword ? { bindPassword: d.bindPassword } : {}),
    ...(d.clearBindPassword ? { clearBindPassword: true } : {}),
    userSearchBase: d.userSearchBase,
    userSearchFilter: d.userSearchFilter,
    displayNameAttribute: d.displayNameAttribute,
    emailAttribute: d.emailAttribute,
    groupAttribute: d.groupAttribute,
    allowedGroups: lines(d.allowedGroups),
  };
}

const STEP_LABELS: Record<string, string> = {
  module: 'ldap3 모듈',
  config: '설정 값',
  connect: '서버 연결',
  service_bind: '서비스 바인드',
  user_search: '사용자 검색',
  group: '허용 그룹',
  error: '오류',
};

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';
const hintCls = 'mt-1 text-[11px] text-muted-foreground';

/** Settings ▸ 접근 제어 — 사내 디렉터리(LDAP/AD) 비밀번호 로그인 (R-7).
 *  로그인 화면은 그대로 두고 `/auth/login` 이 우선순위에 따라 로컬 비밀번호와 LDAP 바인드를 시도한다.
 *  설정 원천은 AppSetting `auth.ldap`(admin 전용 API). 서비스 계정 비밀번호는 암호화 저장되고 화면에는
 *  저장 여부만 보인다. */
export function LdapSettingsPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const { data, isLoading, error } = useQuery({
    queryKey: ['auth', 'ldap-settings'],
    queryFn: async () => (await authApi.ldapSettings()).data,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testUsername, setTestUsername] = useState('');
  useEffect(() => { if (data) setDraft(toDraft(data)); }, [data]);

  const save = useMutation({
    mutationFn: (d: Draft) => authApi.updateLdapSettings({
      enabled: d.enabled,
      ...connectionPayload(d),
      autoProvision: d.autoProvision,
      defaultRole: d.defaultRole,
      priority: d.priority,
      protectLocalAdmins: d.protectLocalAdmins,
    }),
    onSuccess: () => {
      toast.success('LDAP 설정 저장됨');
      void qc.invalidateQueries({ queryKey: ['auth', 'ldap-settings'] });
    },
    onError: (e) => toast.error('저장 실패', formatApiError(e)),
  });

  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('settings-ldap');
  const [testing, setTesting] = useState(false);

  const runTest = async () => {
    if (!draft || testing) return;
    setTesting(true);
    const payload = { ...connectionPayload(draft), testUsername: testUsername.trim() };
    const target = payload.serverUrls.join(', ') || '(서버 주소 없음)';
    const r = await runLogged<LdapTestResult>(runLog, {
      title: 'LDAP 연결 확인',
      first: `${target} — 연결 → 서비스 바인드${payload.testUsername ? ` → 사용자 검색(${payload.testUsername})` : ''}`,
      fn: async () => (await authApi.testLdapSettings(payload)).data,
      summarize: (res): RunLogEntry[] => {
        const out: RunLogEntry[] = (res.warnings ?? []).map((w) => ['warn', `주의 — ${w}`]);
        for (const s of res.steps) {
          out.push([s.ok ? 'info' : 'error', `${STEP_LABELS[s.name] ?? s.name} ${s.ok ? '확인' : '실패'} — ${s.detail}`]);
        }
        if (res.user) {
          if (res.user.displayName) out.push(['info', `표시 이름: ${res.user.displayName}`]);
          if (res.user.email) out.push(['info', `이메일: ${res.user.email}`]);
          if (res.user.groups) out.push(['info', `그룹 ${res.user.groups.length}개${res.user.groups.length ? ` — ${res.user.groups.slice(0, 5).join(' | ')}` : ''}`]);
        }
        out.push(res.ok ? ['info', '연결 확인 완료'] : ['error', '연결 확인 실패']);
        return out;
      },
    });
    if (r.ok) {
      if (r.data.ok) toast.success('LDAP 연결 확인 완료');
      else toast.error('LDAP 연결 확인 실패', r.data.steps.find((s) => !s.ok)?.detail);
    } else if (!r.aborted) {
      toast.error('연결 확인 실패', formatApiError(r.error));
    }
    setTesting(false);
  };

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const dirty = !!(data && draft) && JSON.stringify(toDraft(data)) !== JSON.stringify(draft);
  const plaintext = !!draft && !draft.startTls && /(^|\s)ldap:\/\//i.test(draft.serverUrls);

  return (
    <MacCard
      title="사내 디렉터리 로그인 (LDAP/AD)"
      icon={KeyRound}
      description="로그인 화면은 그대로 두고, 같은 아이디·비밀번호 입력으로 사내 디렉터리 계정을 확인합니다."
    >
      {isLoading || !draft ? (
        error ? (
          <p role="alert" className="text-sm text-destructive">{formatApiError(error, 'LDAP 설정을 불러오지 못했습니다.')}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> 불러오는 중…
          </p>
        )
      ) : (
        <div className="space-y-4">
          {data && !data.moduleAvailable && (
            <p role="alert" className="text-xs text-status-critical">
              백엔드 이미지에 ldap3 모듈이 없습니다 — 켜 두어도 LDAP 로그인은 동작하지 않고 로컬 로그인만 됩니다.
              requirements.txt 로 이미지를 다시 빌드하세요.
            </p>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <span>LDAP 로그인 사용 <span className="text-muted-foreground">(서버 주소와 바인드 설정이 있어야 켤 수 있음)</span></span>
          </label>

          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="mb-1 text-xs font-medium">서버</legend>
            <div>
              <label htmlFor={f('urls')} className="block text-[11px] text-muted-foreground mb-1">서버 주소</label>
              <textarea id={f('urls')} rows={2} value={draft.serverUrls}
                onChange={(e) => set('serverUrls', e.target.value)}
                placeholder={'ldaps://dc1.corp.example:636\nldaps://dc2.corp.example:636'}
                className={`${inputCls} font-mono`} />
              <p className={hintCls}>한 줄에 하나. 앞 서버에 연결되지 않을 때만 다음 서버를 시도합니다</p>
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.startTls} onChange={(e) => set('startTls', e.target.checked)} />
                <span>StartTLS <span className="text-muted-foreground">(ldap:// 연결을 TLS 로 올림 — ldaps:// 에는 쓰지 않음)</span></span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.tlsVerify} onChange={(e) => set('tlsVerify', e.target.checked)} />
                <span>TLS 인증서 검증 <span className="text-muted-foreground">(끄면 중간자 공격에 노출됨)</span></span>
              </label>
              <div>
                <label htmlFor={f('timeout')} className="block text-[11px] text-muted-foreground mb-1">타임아웃(초, 서버당)</label>
                <input id={f('timeout')} type="number" min={1} max={60} value={draft.timeoutSeconds}
                  onChange={(e) => set('timeoutSeconds', e.target.value)} className={`${inputCls} w-24`} />
              </div>
              {plaintext && (
                <p className="text-[11px] text-status-warning">
                  ldap:// 에 StartTLS 가 꺼져 있으면 사용자 비밀번호가 평문으로 전송됩니다.
                </p>
              )}
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={f('ca')} className="block text-[11px] text-muted-foreground mb-1">사설 CA 인증서 PEM (선택)</label>
              <textarea id={f('ca')} rows={2} value={draft.caCertPem}
                onChange={(e) => set('caCertPem', e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----" className={`${inputCls} font-mono text-xs`} />
              <p className={hintCls}>사내 CA 가 서명한 디렉터리 인증서를 검증할 때. 비우면 시스템 신뢰 저장소를 씁니다</p>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="mb-1 text-xs font-medium">바인드 방식</legend>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name={f('mode')} checked={draft.bindMode === 'direct'}
                  onChange={() => set('bindMode', 'direct')} />
                직접 바인드 (템플릿)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name={f('mode')} checked={draft.bindMode === 'search'}
                  onChange={() => set('bindMode', 'search')} />
                서비스 계정으로 검색 후 재바인드
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {draft.bindMode === 'direct' ? (
                <div className="sm:col-span-2">
                  <label htmlFor={f('tpl')} className="block text-[11px] text-muted-foreground mb-1">바인드 DN 템플릿</label>
                  <input id={f('tpl')} className={`${inputCls} font-mono`} value={draft.bindDnTemplate}
                    onChange={(e) => set('bindDnTemplate', e.target.value)}
                    placeholder="{username}@corp.example  또는  uid={username},ou=people,dc=corp,dc=example" />
                  <p className={hintCls}>
                    <code>{'{username}'}</code> 자리에 로그인 아이디가 들어갑니다. DN 형식이면 특수 문자를 escape 하고,
                    UPN 형식이면 @·\ 등이 든 아이디를 거절합니다
                  </p>
                </div>
              ) : (
                <>
                  <div>
                    <label htmlFor={f('svc')} className="block text-[11px] text-muted-foreground mb-1">서비스 계정 DN</label>
                    <input id={f('svc')} className={`${inputCls} font-mono`} value={draft.serviceBindDn}
                      onChange={(e) => set('serviceBindDn', e.target.value)}
                      placeholder="cn=svc-pep,ou=service,dc=corp,dc=example" />
                    <p className={hintCls}>비우면 익명 바인드로 검색합니다(디렉터리가 허용할 때만)</p>
                  </div>
                  <div>
                    <label htmlFor={f('svcpw')} className="block text-[11px] text-muted-foreground mb-1">서비스 계정 비밀번호</label>
                    <input id={f('svcpw')} type="password" autoComplete="new-password" className={`${inputCls} font-mono`}
                      value={draft.bindPassword} disabled={draft.clearBindPassword}
                      onChange={(e) => set('bindPassword', e.target.value)}
                      placeholder={data?.hasBindPassword ? '저장됨 — 바꿀 때만 입력' : '입력'} />
                    {data?.hasBindPassword && (
                      <label className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <input type="checkbox" checked={draft.clearBindPassword}
                          onChange={(e) => set('clearBindPassword', e.target.checked)} />
                        저장된 비밀번호 삭제
                      </label>
                    )}
                  </div>
                </>
              )}
              <div>
                <label htmlFor={f('base')} className="block text-[11px] text-muted-foreground mb-1">사용자 검색 base</label>
                <input id={f('base')} className={`${inputCls} font-mono`} value={draft.userSearchBase}
                  onChange={(e) => set('userSearchBase', e.target.value)} placeholder="ou=people,dc=corp,dc=example" />
              </div>
              <div>
                <label htmlFor={f('filter')} className="block text-[11px] text-muted-foreground mb-1">사용자 검색 필터</label>
                <input id={f('filter')} className={`${inputCls} font-mono`} value={draft.userSearchFilter}
                  onChange={(e) => set('userSearchFilter', e.target.value)} placeholder="(sAMAccountName={username})" />
                <p className={hintCls}>
                  아이디는 escape 해서 넣습니다.
                  {draft.bindMode === 'direct' && ' 직접 바인드에서는 UPN 템플릿일 때 속성·그룹을 읽는 데만 씁니다'}
                </p>
              </div>
            </div>
          </fieldset>

          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="mb-1 text-xs font-medium">속성 매핑</legend>
            <div>
              <label htmlFor={f('dname')} className="block text-[11px] text-muted-foreground mb-1">표시 이름</label>
              <input id={f('dname')} className={`${inputCls} font-mono`} value={draft.displayNameAttribute}
                onChange={(e) => set('displayNameAttribute', e.target.value)} placeholder="displayName" />
            </div>
            <div>
              <label htmlFor={f('mail')} className="block text-[11px] text-muted-foreground mb-1">이메일</label>
              <input id={f('mail')} className={`${inputCls} font-mono`} value={draft.emailAttribute}
                onChange={(e) => set('emailAttribute', e.target.value)} placeholder="mail" />
            </div>
            <div>
              <label htmlFor={f('gattr')} className="block text-[11px] text-muted-foreground mb-1">그룹 속성</label>
              <input id={f('gattr')} className={`${inputCls} font-mono`} value={draft.groupAttribute}
                onChange={(e) => set('groupAttribute', e.target.value)} placeholder="memberOf" />
            </div>
            <div className="sm:col-span-3">
              <label htmlFor={f('groups')} className="block text-[11px] text-muted-foreground mb-1">허용 그룹 DN (선택)</label>
              <textarea id={f('groups')} rows={2} value={draft.allowedGroups}
                onChange={(e) => set('allowedGroups', e.target.value)}
                placeholder="CN=PEP-Users,OU=Groups,DC=corp,DC=example" className={`${inputCls} font-mono`} />
              <p className={hintCls}>한 줄에 하나. 비우면 제한 없음. 사용자 항목의 그룹 속성(직접 소속)과 대소문자 무시로 비교합니다</p>
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
                끄면 PEP 에 같은 아이디(대소문자 무시)가 이미 있어야 로그인됩니다. 자동 생성 계정은 PEP 비밀번호가 없어
                LDAP 로만 로그인하고, 비밀번호는 사내 디렉터리에서 바꿉니다.
              </p>
            </div>
            <div className="space-y-2">
              <div>
                <label htmlFor={f('prio')} className="block text-xs font-medium mb-1">우선순위</label>
                <select id={f('prio')} value={draft.priority}
                  onChange={(e) => set('priority', e.target.value === 'ldap_first' ? 'ldap_first' : 'local_first')}
                  className="bg-secondary border border-border rounded-xl px-2 py-1.5 text-sm">
                  <option value="local_first">로컬 비밀번호 먼저 → LDAP</option>
                  <option value="ldap_first">LDAP 먼저 → 로컬 비밀번호</option>
                </select>
                <p className={hintCls}>PEP 비밀번호가 없는 계정(SSO·LDAP 생성)은 순서와 관계없이 LDAP 만 시도합니다</p>
              </div>
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" className="mt-0.5" checked={draft.protectLocalAdmins}
                  onChange={(e) => set('protectLocalAdmins', e.target.checked)} />
                <span>
                  로컬 비밀번호가 있는 admin 계정은 LDAP 로 로그인하지 않음
                  <span className="block text-[11px] text-muted-foreground">
                    디렉터리에 같은 이름(admin 등)의 계정이 있어도 PEP 관리자 권한을 얻지 못하게 합니다
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-end justify-end gap-2">
            <div className="mr-auto">
              <label htmlFor={f('tuser')} className="block text-[11px] text-muted-foreground mb-1">테스트 사용자명 (선택)</label>
              <input id={f('tuser')} className={`${inputCls} w-48 font-mono`} value={testUsername}
                onChange={(e) => setTestUsername(e.target.value)} placeholder="비밀번호 없이 검색만" />
            </div>
            <button
              type="button"
              onClick={runTest}
              disabled={testing || !draft.serverUrls.trim()}
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
