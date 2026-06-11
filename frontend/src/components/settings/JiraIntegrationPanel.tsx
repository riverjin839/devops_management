import { useEffect, useState } from 'react';
import { Loader2, Wifi, WifiOff, Trash2, Save, KeyRound, Globe } from 'lucide-react';
import {
  useJiraConfig, useUpdateJiraConfig, useJiraCredential,
  useSaveJiraCredential, useDeleteJiraCredential, useJiraTest,
} from '@/hooks/useJira';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';

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

  // 사용자 PAT
  const [token, setToken] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

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
    if (!token.trim()) { toast.error('토큰을 입력하세요'); return; }
    try {
      await saveCred.mutateAsync({ token: token.trim() });
      setToken('');
      toast.success('내 PAT 저장됨', '이제 연결 테스트와 가져오기를 할 수 있습니다.');
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
      toast.success('내 PAT 삭제됨');
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
          {!isAdmin && <span className="text-[11px] text-muted-foreground">(관리자만 수정 가능)</span>}
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          폐쇄망 내부 Jira(Server/Data Center) 의 Base URL 을 설정합니다. 가져오기는 백엔드에서 실행되므로
          백엔드 서버가 이 도메인에 접근 가능해야 합니다.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <span className="block text-xs font-medium text-muted-foreground mb-1">Base URL</span>
            <input className={inputCls} placeholder="https://jira.internal.example.com" value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)} disabled={!isAdmin} />
          </div>
          <div>
            <span className="block text-xs font-medium text-muted-foreground mb-1">기본 프로젝트 키 (선택)</span>
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

      {/* 내 PAT (전 사용자) */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="w-4 h-4 text-primary" />
          <h3 className="font-semibold">내 Jira 인증 (Personal Access Token)</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          본인 Jira 계정의 PAT 를 등록하면 <b>본인 권한</b>으로 이슈를 가져옵니다. 토큰은 암호화되어 저장되며
          화면에 다시 표시되지 않습니다.
        </p>

        <div className="flex items-center gap-2 mb-3">
          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
            cred?.configured
              ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
              : 'bg-secondary text-muted-foreground border-border'
          }`}>
            {cred?.configured ? '등록됨' : '미등록'}
          </span>
          {cred?.jiraAccount && <span className="text-xs text-muted-foreground">계정: {cred.jiraAccount}</span>}
          {cred?.lastVerifiedAt && (
            <span className="text-xs text-muted-foreground">마지막 검증: {new Date(cred.lastVerifiedAt).toLocaleString()}</span>
          )}
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <input className={inputCls} type="password" placeholder="PAT 붙여넣기" value={token}
            onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          <button onClick={handleSaveToken} disabled={saveCred.isPending}
            className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap">
            {saveCred.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            저장
          </button>
        </div>

        <div className="flex items-center gap-2 mt-3">
          <button onClick={handleTest} disabled={testConn.isPending || !cred?.configured}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50">
            {testConn.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
            연결 테스트
          </button>
          {cred?.configured && (
            <button onClick={handleDeleteToken} disabled={deleteCred.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm text-red-500 hover:bg-red-500/10 disabled:opacity-50">
              <Trash2 className="w-4 h-4" /> 토큰 삭제
            </button>
          )}
        </div>

        {testResult && (
          <div className={`text-xs mt-3 px-3 py-2 rounded-lg inline-flex items-center gap-1.5 ${
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
