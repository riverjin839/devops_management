import { useEffect, useState } from 'react';
import { Loader2, Wifi, WifiOff, Trash2, Save, KeyRound, Globe, LogIn, ShieldCheck, Download, Copy, Stethoscope } from 'lucide-react';
import {
  useJiraConfig, useUpdateJiraConfig, useJiraCredential,
  useDeleteJiraCredential, useJiraTest, useJiraSsoLogin,
  useConfluenceTest, useSsoDiagnose,
} from '@/hooks/useJira';
import { useAuthStore } from '@/stores/authStore';
import { JiraConnectCard } from '@/components/settings/JiraConnectCard';
import { jiraApi } from '@/services/api';
import { useToast } from '@/components/common';
import { formatApiError, parseUTC } from '@/lib/utils';
import type { SsoDiagnoseResult } from '@/types';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

export function JiraIntegrationPanel() {
  const toast = useToast();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const { data: config, isLoading: cfgLoading } = useJiraConfig();
  const updateConfig = useUpdateJiraConfig();
  const { data: cred } = useJiraCredential();
  const deleteCred = useDeleteJiraCredential();
  const testConn = useJiraTest();
  const confluenceTest = useConfluenceTest();
  const ssoDiagnose = useSsoDiagnose();
  const ssoLogin = useJiraSsoLogin();

  // 관리자 설정 폼 상태
  const [baseUrl, setBaseUrl] = useState('');
  const [confluenceUrl, setConfluenceUrl] = useState('');
  const [ssoLoginUrl, setSsoLoginUrl] = useState('');
  const [ssoUsernameField, setSsoUsernameField] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [verifyTls, setVerifyTls] = useState(true);
  const [defaultProject, setDefaultProject] = useState('');

  useEffect(() => {
    if (config) {
      setBaseUrl(config.baseUrl ?? '');
      setConfluenceUrl(config.confluenceBaseUrl ?? '');
      setSsoLoginUrl(config.ssoLoginUrl ?? '');
      setSsoUsernameField(config.ssoUsernameField ?? '');
      setEnabled(!!config.enabled);
      setVerifyTls(config.verifyTls !== false);
      setDefaultProject(config.defaultProjectKey ?? '');
    }
  }, [config]);

  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [confTestResult, setConfTestResult] = useState<{ ok: boolean; detail: string } | null>(null);
  const [diagResult, setDiagResult] = useState<SsoDiagnoseResult | null>(null);

  // 파드 내 SSO 폼 자동 로그인 (ID/PW — 브라우저 불필요, K8s 배포 기본 경로)
  const [ssoUser, setSsoUser] = useState('');
  const [ssoPw, setSsoPw] = useState('');
  const [ssoSave, setSsoSave] = useState(true);

  const runSsoLogin = async (payload?: import('@/types').JiraSsoLoginRequest) => {
    setTestResult(null);
    try {
      const { data } = await ssoLogin.mutateAsync(payload);
      if (data.ok) {
        setSsoPw('');
        toast.success('SSO 로그인 완료', data.displayName ? `${data.displayName} 세션이 저장되었습니다.` : data.detail);
        // Confluence 동시 로그인이 시도됐고 실패한 경우만 별도 안내 (Jira 는 정상).
        if (data.confluenceOk === false) {
          toast.error('Confluence 로그인 실패', data.confluenceDetail || 'Jira 세션은 정상 저장되었습니다.');
        }
      } else {
        toast.error('SSO 로그인 실패', data.detail);
      }
    } catch (err) {
      toast.error('SSO 로그인 실패', formatApiError(err));
    }
  };

  const handleSsoFormLogin = () => {
    if (!ssoUser.trim() || !ssoPw) {
      toast.error('입력 필요', 'SSO 아이디와 비밀번호를 입력하세요.');
      return;
    }
    void runSsoLogin({ username: ssoUser.trim(), password: ssoPw, saveLogin: ssoSave });
  };

  // K8s/컨테이너 배포용 — 본인 PC 에서 실행할 로컬 SSO 도우미 스크립트.
  const helperCmd = [
    'pip install playwright',
    'playwright install chromium',
    `python jira_sso_helper.py --pep-url ${window.location.origin}`,
  ].join('\n');

  const handleDownloadHelper = async () => {
    try {
      const { data } = await jiraApi.downloadSsoHelper();
      const url = URL.createObjectURL(new Blob([data], { type: 'text/x-python' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jira_sso_helper.py';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('다운로드 실패', formatApiError(err));
    }
  };

  const handleCopyHelperCmd = async () => {
    try {
      await navigator.clipboard.writeText(helperCmd);
      toast.success('실행 명령 복사됨', '터미널(cmd/PowerShell)에 붙여넣어 실행하세요.');
    } catch {
      toast.error('복사 실패', '브라우저가 클립보드 접근을 막았습니다. 화면의 명령을 직접 복사하세요.');
    }
  };

  const handleSaveConfig = async () => {
    try {
      await updateConfig.mutateAsync({
        baseUrl: baseUrl.trim(),
        confluenceBaseUrl: confluenceUrl.trim(),
        ssoLoginUrl: ssoLoginUrl.trim(),
        ssoUsernameField: ssoUsernameField.trim(),
        enabled,
        verifyTls,
        defaultProjectKey: defaultProject.trim() || null,
      });
      toast.success('Jira 설정 저장됨');
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

  const handleSsoDiagnose = async () => {
    setDiagResult(null);
    try {
      const { data } = await ssoDiagnose.mutateAsync();
      setDiagResult(data);
    } catch (err) {
      toast.error('SSO 진단 실패', formatApiError(err));
    }
  };

  const handleConfluenceTest = async () => {
    setConfTestResult(null);
    try {
      const { data } = await confluenceTest.mutateAsync();
      setConfTestResult({
        ok: data.ok,
        detail: data.ok
          ? (data.displayName ? `Confluence 연결 정상 — ${data.displayName}` : 'Confluence 연결 정상')
          : data.detail,
      });
    } catch (err) {
      setConfTestResult({ ok: false, detail: formatApiError(err) });
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
          <div className="md:col-span-2">
            <span className="block text-sm font-medium text-muted-foreground mb-1">
              Confluence Base URL (선택 — 같은 SSO 사용 시)
            </span>
            <input className={inputCls} placeholder="https://confluence.internal.example.com" value={confluenceUrl}
              onChange={(e) => setConfluenceUrl(e.target.value)} disabled={!isAdmin} />
            <p className="text-xs text-muted-foreground mt-1">
              설정하면 SSO 자동 로그인이 같은 IdP 세션으로 Jira 와 Confluence 세션을 한 번에 캡처합니다.
            </p>
          </div>
          <div className="md:col-span-2">
            <span className="block text-sm font-medium text-muted-foreground mb-1">
              IdP 로그인 URL (선택 — 자동 탐색 실패 시)
            </span>
            <input className={inputCls} placeholder="https://login.example.com/sso/am/jira/login.jsp"
              value={ssoLoginUrl} onChange={(e) => setSsoLoginUrl(e.target.value)} disabled={!isAdmin} />
            <p className="text-xs text-muted-foreground mt-1">
              브라우저로 Jira 접속 시 거쳐가는 <b>SSO 로그인 페이지 주소</b>. 백엔드가 로그인 폼을
              스스로 찾지 못할 때 이 주소를 진입점으로 사용합니다 (아래 "내 Jira 인증"의 SSO 진단으로 확인).
            </p>
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
          {cred?.hasConfluence && (
            <span className="inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full border bg-emerald-500/10 text-emerald-500 border-emerald-500/30">
              Confluence 세션
            </span>
          )}
          {cred?.jiraAccount && <span className="text-sm text-muted-foreground">계정: {cred.jiraAccount}</span>}
          {cred?.lastVerifiedAt && (
            <span className="text-sm text-muted-foreground">마지막 검증: {parseUTC(cred.lastVerifiedAt).toLocaleString()}</span>
          )}
        </div>

        {/* SSO 자동 로그인 (권장) — 파드 내 폼 로그인 (ID/PW, 브라우저 불필요) */}
        <div className="rounded-xl border border-primary/25 bg-primary/[0.04] p-4 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-4 h-4 text-primary" />
            <h4 className="text-sm font-semibold">SSO 자동 로그인 <span className="text-xs font-normal text-primary">권장</span></h4>
          </div>
          <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
            사내 SSO 아이디/비밀번호를 입력하면 <b>서버가 SSO 로그인을 대신 수행</b>해 세션을
            캡처·등록합니다(토큰/쿠키 복사 불필요). Confluence URL 이 설정돼 있으면 <b>Jira 와
            Confluence 세션을 한 번에</b> 캡처합니다. 순수 아이디/비밀번호 SSO(2차 인증 없음)
            전용이며, 비밀번호는 Jira/SSO 서버로만 전달됩니다 — "로그인 정보 저장"을 체크한
            경우에만 암호화 저장되어 세션 만료 시 <b>자동 재로그인</b>(API 호출 중 401 감지 시)과
            원클릭 재로그인에 쓰입니다.
          </p>
          {cred?.hasSsoLogin && (
            <button onClick={() => void runSsoLogin({ useSaved: true })} disabled={ssoLogin.isPending}
              className="mb-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
              {ssoLogin.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              저장된 로그인 정보로 다시 로그인
            </button>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
            <input className={inputCls} placeholder="SSO 아이디" value={ssoUser}
              onChange={(e) => setSsoUser(e.target.value)} autoComplete="off" />
            <input className={inputCls} type="password" placeholder="SSO 비밀번호" value={ssoPw}
              onChange={(e) => setSsoPw(e.target.value)} autoComplete="new-password"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSsoFormLogin(); }} />
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={handleSsoFormLogin} disabled={ssoLogin.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
              {ssoLogin.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              {ssoLogin.isPending ? 'SSO 로그인 중…' : 'SSO 로그인'}
            </button>
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input type="checkbox" checked={ssoSave} onChange={(e) => setSsoSave(e.target.checked)}
                className="rounded border-border" />
              로그인 정보 저장 (세션 만료 시 원클릭 재로그인)
            </label>
          </div>

          {/* SSO 진단 — 파드가 실제로 보는 로그인 페이지를 확인 (폐쇄망 IdP 원인 판별) */}
          <div className="mt-3 pt-3 border-t border-border/60">
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={handleSsoDiagnose} disabled={ssoDiagnose.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/70 disabled:opacity-50">
                {ssoDiagnose.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Stethoscope className="w-4 h-4" />}
                SSO 진단
              </button>
              <span className="text-xs text-muted-foreground">
                로그인 실패 시 — 백엔드가 어느 페이지까지 도달하는지 확인합니다 (자격 불필요).
              </span>
            </div>
            {diagResult && (
              <div className="mt-2 space-y-2">
                <p className={`text-xs leading-relaxed ${diagResult.ok ? 'text-emerald-500' : 'text-amber-500'}`}>
                  {diagResult.detail}
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] border border-border rounded-lg">
                    <thead className="bg-secondary/60 text-muted-foreground">
                      <tr>
                        <th className="text-left px-2 py-1 font-medium">진입 경로</th>
                        <th className="text-left px-2 py-1 font-medium">최종 URL</th>
                        <th className="text-left px-2 py-1 font-medium">HTTP</th>
                        <th className="text-left px-2 py-1 font-medium">폼/PW</th>
                        <th className="text-left px-2 py-1 font-medium">계정 필드</th>
                        <th className="text-left px-2 py-1 font-medium">hidden 필드</th>
                        <th className="text-left px-2 py-1 font-medium">비고</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {diagResult.entries.map((e, i) => (
                        <tr key={`${e.product}-${e.url}-${i}`} className="border-t border-border">
                          <td className="px-2 py-1 align-top break-all">{e.product} {e.url}</td>
                          <td className="px-2 py-1 align-top break-all">{e.finalUrl || '-'}</td>
                          <td className="px-2 py-1 align-top">{e.httpStatus ?? '-'}</td>
                          <td className={`px-2 py-1 align-top ${e.passwordInputs > 0 ? 'text-emerald-500' : ''}`}>
                            {e.forms}/{e.passwordInputs}
                          </td>
                          <td className="px-2 py-1 align-top break-all">
                            {e.usernameField || '-'}{e.wantsBase64 ? ' (base64)' : ''}
                          </td>
                          <td className="px-2 py-1 align-top break-all max-w-[16rem]">
                            {Object.entries(e.hiddenFields ?? {}).map(([k, v]) => `${k}=${v}`).join(' · ') || '-'}
                          </td>
                          <td className="px-2 py-1 align-top break-all">
                            {e.error || e.clientRedirect || e.wwwAuthenticate || e.title || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {diagResult.entries.filter((e) => (e.loginFields?.length ?? 0) > 0).map((e, i) => (
                  <div key={`f-${e.product}-${i}`} className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[11px] space-y-1">
                    <p className="font-medium text-foreground break-all">로그인 폼 상세 — {e.finalUrl}</p>
                    <p className="font-mono break-all">action: {e.loginFormAction || '(현재 URL)'}</p>
                    <p className="font-mono break-all">필드: {(e.loginFields ?? []).join(' · ')}</p>
                    {(e.scripts?.length ?? 0) > 0 && (
                      <p className="font-mono break-all">스크립트: {(e.scripts ?? []).join(' · ')}</p>
                    )}
                    {(e.cryptoHints?.length ?? 0) > 0 && (
                      <p className="text-amber-500 leading-relaxed">
                        ⚠ 클라이언트 암호화/보안모듈 흔적: {(e.cryptoHints ?? []).join(', ')} —
                        이런 페이지는 서버측 폼 로그인이 원리상 불가하므로 "내 PC 도우미" 또는 PAT/세션 쿠키를 사용하세요.
                      </p>
                    )}
                  </div>
                ))}
                {(diagResult.podSourceIp || diagResult.podHostname) && (
                  <p className="text-[11px] text-muted-foreground font-mono break-all">
                    이 파드: {diagResult.podHostname || '-'} · 출발지 IP {diagResult.podSourceIp || '-'}
                    <span className="font-sans"> — SSO 가 클라이언트 IP 를 검사하는 구성이면 이 IP(보통 노드/게이트웨이 IP 로 NAT 됨)를 허용해야 합니다.</span>
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  최종 URL 이 IdP 주소로 바뀌고 PW 열이 1 이상이면 정상입니다. IdP 로 안 넘어가면
                  위 공통 설정의 <b>IdP 로그인 URL</b> 에 브라우저에서 확인한 주소를 넣어보세요.
                  로그인이 "거부"로 실패하면 <b>hidden 필드</b> 열을 확인하세요 —
                  <code className="px-1 rounded bg-background">encoded=true</code> 면 자격을 base64 로
                  보내야 하는 구성입니다(자동 처리됨).
                </p>
              </div>
            )}
          </div>

          <details className="mt-3">
            <summary className="text-xs text-muted-foreground cursor-pointer select-none hover:text-foreground">
              폼 로그인이 실패한다면 (JS 기반 SSO / 2차 인증) — 내 PC 도우미로 로그인
            </summary>
            <div className="mt-2 space-y-2">
              <p className="text-xs text-muted-foreground leading-relaxed">
                도우미 스크립트를 <b>내 PC 에서 실행</b>하면 브라우저가 열리고, 평소처럼 SSO 로그인만
                마치면 세션이 자동으로 캡처되어 PEP 에 등록됩니다.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={handleDownloadHelper}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/70">
                  <Download className="w-4 h-4" /> 도우미 스크립트 다운로드
                </button>
                <button onClick={handleCopyHelperCmd}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/70"
                  title="실행 명령 복사" aria-label="실행 명령 복사">
                  <Copy className="w-4 h-4" /> 실행 명령 복사
                </button>
              </div>
              <div className="rounded-lg bg-secondary/50 border border-border px-3 py-2 text-xs text-muted-foreground leading-relaxed">
                <p className="font-medium text-foreground mb-1">실행 방법 (최초 1회 준비 포함)</p>
                <pre className="font-mono whitespace-pre-wrap break-all text-[11px] leading-relaxed">{helperCmd}</pre>
              </div>
              <button onClick={() => void runSsoLogin()} disabled={ssoLogin.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/70 disabled:opacity-50">
                {ssoLogin.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
                서버 브라우저로 SSO 로그인 (백엔드 호스트에 화면이 있는 배포 전용)
              </button>
            </div>
          </details>
        </div>

        {/* 수동 등록 — 가져오기 모달과 **같은 공용 카드**를 쓴다(동작이 갈리지 않게). */}
        <JiraConnectCard />


        <div className="flex items-center gap-2 mt-4">
          <button onClick={handleTest} disabled={testConn.isPending || !cred?.configured}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50">
            {testConn.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
            연결 테스트
          </button>
          {!!config?.confluenceBaseUrl && (
            <button onClick={handleConfluenceTest} disabled={confluenceTest.isPending || !cred?.configured}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50">
              {confluenceTest.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
              Confluence 테스트
            </button>
          )}
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
        {confTestResult && (
          <div className={`text-sm mt-3 ml-2 px-3 py-2 rounded-lg inline-flex items-center gap-1.5 ${
            confTestResult.ok ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
          }`}>
            {confTestResult.ok ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {confTestResult.detail}
          </div>
        )}
      </div>
    </div>
  );
}
