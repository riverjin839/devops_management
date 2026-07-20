import { useEffect, useState } from 'react';
import { Loader2, Wifi, WifiOff, Trash2, Save, KeyRound, Globe, Cookie, LogIn, ShieldCheck } from 'lucide-react';
import {
  useJiraConfig, useUpdateJiraConfig, useJiraCredential,
  useSaveJiraCredential, useDeleteJiraCredential, useJiraTest, useJiraSsoLogin,
} from '@/hooks/useJira';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/components/common';
import { formatApiError, parseUTC } from '@/lib/utils';
import type { JiraAuthType } from '@/types';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

export function JiraIntegrationPanel() {
  const toast = useToast();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const { data: config, isLoading: cfgLoading } = useJiraConfig();
  const updateConfig = useUpdateJiraConfig();
  const { data: cred } = useJiraCredential();
  const saveCred = useSaveJiraCredential();
  const deleteCred = useDeleteJiraCredential();
  const testConn = useJiraTest();
  const ssoLogin = useJiraSsoLogin();

  // 관리자 설정 폼 상태
  const [baseUrl, setBaseUrl] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [verifyTls, setVerifyTls] = useState(true);
  const [defaultProject, setDefaultProject] = useState('');

  useEffect(() => {
    if (config) {
      setBaseUrl(config.baseUrl ?? '');
      setEnabled(!!config.enabled);
      setVerifyTls(config.verifyTls !== false);
      setDefaultProject(config.defaultProjectKey ?? '');
    }
  }, [config]);

  // 사용자 인증 (PAT | 세션 쿠키)
  const [authType, setAuthType] = useState<JiraAuthType>('pat');
  const [token, setToken] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  // 등록된 자격의 방식을 수동 토글 초기값으로 반영 (SSO 는 별도 버튼이라 토글엔 미반영).
  useEffect(() => {
    if (cred?.configured && (cred.authType === 'pat' || cred.authType === 'cookie')) {
      setAuthType(cred.authType);
    }
  }, [cred?.configured, cred?.authType]);

  const handleSsoLogin = async () => {
    setTestResult(null);
    try {
      const { data } = await ssoLogin.mutateAsync();
      if (data.ok) {
        toast.success('SSO 로그인 완료', data.displayName ? `${data.displayName} 세션이 저장되었습니다.` : data.detail);
      } else {
        toast.error('SSO 로그인 실패', data.detail);
      }
    } catch (err) {
      toast.error('SSO 로그인 실패', formatApiError(err));
    }
  };

  const handleSaveConfig = async () => {
    try {
      await updateConfig.mutateAsync({
        baseUrl: baseUrl.trim(),
        enabled,
        verifyTls,
        defaultProjectKey: defaultProject.trim() || null,
      });
      toast.success('Jira 설정 저장됨');
    } catch (err) {
      toast.error('저장 실패', formatApiError(err));
    }
  };

  const handleSaveToken = async () => {
    if (!token.trim()) {
      toast.error(authType === 'cookie' ? '세션 쿠키를 입력하세요' : '토큰을 입력하세요');
      return;
    }
    try {
      await saveCred.mutateAsync({ token: token.trim(), authType });
      setToken('');
      setTestResult(null);
      toast.success(
        authType === 'cookie' ? '내 세션 쿠키 저장됨' : '내 PAT 저장됨',
        '이제 연결 테스트와 가져오기를 할 수 있습니다.',
      );
    } catch (err) {
      toast.error('저장 실패', formatApiError(err));
    }
  };

  const handleTest = async () => {
    setTestResult(null);
    try {
      const { data } = await testConn.mutateAsync();
      setTestResult({ ok: data.ok, detail: data.ok ? (data.displayName ? `연결 정상 — ${data.displayName}` : '연결 정상') : data.detail });
    } catch (err) {
      setTestResult({ ok: false, detail: formatApiError(err) });
    }
  };

  const handleDeleteToken = async () => {
    try {
      await deleteCred.mutateAsync();
      setTestResult(null);
      toast.success('내 Jira 인증 삭제됨');
    } catch (err) {
      toast.error('삭제 실패', formatApiError(err));
    }
  };

  if (cfgLoading) {
    return <div className="flex items-center gap-2 text-muted-foreground text-sm p-6"><Loader2 className="w-4 h-4 animate-spin" /> 불러오는 중…</div>;
  }

  return (
    <div className="space-y-6">
      {/* 공통 설정 (관리자) */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <Globe className="w-4 h-4 text-primary" />
          <h3 className="font-semibold">Jira 공통 설정</h3>
          {!isAdmin && <span className="text-xs text-muted-foreground">(관리자만 수정 가능)</span>}
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          폐쇄망 내부 Jira(Server/Data Center) 의 Base URL 을 설정합니다. 가져오기는 백엔드에서 실행되므로
          백엔드 서버가 이 도메인에 접근 가능해야 합니다.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <span className="block text-sm font-medium text-muted-foreground mb-1">Base URL</span>
            <input className={inputCls} placeholder="https://jira.internal.example.com" value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)} disabled={!isAdmin} />
          </div>
          <div>
            <span className="block text-sm font-medium text-muted-foreground mb-1">기본 프로젝트 키 (선택)</span>
            <input className={inputCls} placeholder="PROJ" value={defaultProject}
              onChange={(e) => setDefaultProject(e.target.value)} disabled={!isAdmin} />
          </div>
          <div className="flex items-end gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!isAdmin} />
              연동 활성화
            </label>
            <label className="flex items-center gap-2 text-sm" title="자체서명 인증서면 체크 해제">
              <input type="checkbox" checked={verifyTls} onChange={(e) => setVerifyTls(e.target.checked)} disabled={!isAdmin} />
              TLS 인증서 검증
            </label>
          </div>
        </div>
        {isAdmin && (
          <div className="mt-4">
            <button onClick={handleSaveConfig} disabled={updateConfig.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
              {updateConfig.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              설정 저장
            </button>
          </div>
        )}
      </div>

      {/* 내 인증 (전 사용자) — PAT 또는 세션 쿠키 */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="w-4 h-4 text-primary" />
          <h3 className="font-semibold">내 Jira 인증</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          본인 Jira 계정 자격을 등록하면 <b>본인 권한</b>으로 이슈를 가져옵니다. 자격은 암호화되어 저장되며
          화면에 다시 표시되지 않습니다. <b>SSO 자동 로그인</b>이 가장 간편합니다 — 토큰이나 쿠키를 직접
          복사할 필요가 없습니다.
        </p>

        {/* 등록 상태 */}
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <span className={`inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full border ${
            cred?.configured
              ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
              : 'bg-secondary text-muted-foreground border-border'
          }`}>
            {cred?.configured
              ? `등록됨 · ${cred.authType === 'sso' ? 'SSO' : cred.authType === 'cookie' ? '세션 쿠키' : 'PAT'}`
              : '미등록'}
          </span>
          {cred?.jiraAccount && <span className="text-sm text-muted-foreground">계정: {cred.jiraAccount}</span>}
          {cred?.lastVerifiedAt && (
            <span className="text-sm text-muted-foreground">마지막 검증: {parseUTC(cred.lastVerifiedAt).toLocaleString()}</span>
          )}
        </div>

        {/* SSO 자동 로그인 (권장) */}
        <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-4 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-4 h-4 text-primary" />
            <h4 className="text-sm font-semibold">SSO 자동 로그인 <span className="text-xs font-normal text-primary">권장</span></h4>
          </div>
          <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
            버튼을 누르면 <b>백엔드 서버에서 브라우저가 열립니다</b>. 평소처럼 사내 SSO 로그인만 마치면
            세션이 자동으로 캡처·저장되어 바로 가져오기·되쓰기를 할 수 있습니다(토큰/쿠키 복사 불필요).
            세션이 만료되면 다시 로그인하세요.
          </p>
          <button onClick={handleSsoLogin} disabled={ssoLogin.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
            {ssoLogin.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
            {ssoLogin.isPending ? '브라우저 창에서 로그인을 완료하세요…' : cred?.authType === 'sso' ? 'SSO 다시 로그인' : '브라우저로 SSO 로그인'}
          </button>
        </div>

        {/* 또는 수동 등록 (대체) */}
        <details className="group">
          <summary className="text-sm font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground mb-3">
            또는 수동 등록 (PAT · 세션 쿠키)
          </summary>

        {/* 인증 방식 선택 */}
        <div className="flex items-stretch gap-1.5 mb-3">
          {([
            { id: 'pat' as const, label: 'Personal Access Token', icon: KeyRound },
            { id: 'cookie' as const, label: '세션 쿠키 (수동)', icon: Cookie },
          ]).map((m) => {
            const Icon = m.icon;
            return (
              <button key={m.id} type="button" onClick={() => { setAuthType(m.id); setToken(''); setTestResult(null); }}
                aria-pressed={authType === m.id}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                  authType === m.id
                    ? 'bg-primary/10 text-primary border-primary/30 ring-2 ring-primary/20'
                    : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                }`}>
                <Icon className="w-4 h-4" /> {m.label}
              </button>
            );
          })}
        </div>

        {authType === 'cookie' ? (
          <div className="space-y-2">
            <div className="rounded-lg bg-secondary/50 border border-border px-3 py-2 text-xs text-muted-foreground leading-relaxed">
              <p className="font-medium text-foreground mb-1 flex items-center gap-1.5"><Cookie className="w-3.5 h-3.5" /> 세션 쿠키 얻는 법</p>
              <ol className="list-decimal list-inside space-y-0.5">
                <li>사내 브라우저에서 Jira 에 SSO 로그인합니다.</li>
                <li>개발자 도구(F12) ▸ Network 탭에서 아무 요청이나 클릭 ▸ Request Headers 의 <code className="px-1 rounded bg-background">Cookie</code> 값을 통째로 복사합니다.</li>
                <li>아래에 붙여넣고 저장 후 <b>연결 테스트</b>로 확인하세요. 세션이 만료되면 다시 등록해야 합니다.</li>
              </ol>
            </div>
            <textarea className={`${inputCls} font-mono text-xs min-h-[76px] resize-y`}
              placeholder="JSESSIONID=...; atlassian.xsrf.token=...; seraph.rememberme.cookie=..."
              value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
            <button onClick={handleSaveToken} disabled={saveCred.isPending}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap">
              {saveCred.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              세션 쿠키 저장
            </button>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-2">
            <input className={inputCls} type="password" placeholder="PAT 붙여넣기" value={token}
              onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            <button onClick={handleSaveToken} disabled={saveCred.isPending}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap">
              {saveCred.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              저장
            </button>
          </div>
        )}
        </details>

        <div className="flex items-center gap-2 mt-4">
          <button onClick={handleTest} disabled={testConn.isPending || !cred?.configured}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50">
            {testConn.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
            연결 테스트
          </button>
          {cred?.configured && (
            <button onClick={handleDeleteToken} disabled={deleteCred.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm text-red-500 hover:bg-red-500/10 disabled:opacity-50">
              <Trash2 className="w-4 h-4" /> 인증 삭제
            </button>
          )}
        </div>

        {testResult && (
          <div className={`text-sm mt-3 px-3 py-2 rounded-lg inline-flex items-center gap-1.5 ${
            testResult.ok ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
          }`}>
            {testResult.ok ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {testResult.detail}
          </div>
        )}
      </div>
    </div>
  );
}
