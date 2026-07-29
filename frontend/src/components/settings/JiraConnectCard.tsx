import { useState } from 'react';
import {
  Loader2, Save, Wifi, WifiOff, Cookie, KeyRound, Trash2, CheckCircle2, HelpCircle,
} from 'lucide-react';
import {
  useJiraCredential, useSaveJiraCredential, useDeleteJiraCredential, useJiraTest,
} from '@/hooks/useJira';
import { useToast } from '@/components/common';
import { formatApiError, parseUTC } from '@/lib/utils';
import type { JiraAuthType } from '@/types';

/**
 * 내 Jira 연결 — **사용자 개인 자격증명** 등록/검증 카드.
 *
 * 자격증명 API 는 관리자 전용이 아니라 로그인 사용자 누구나 자기 것을 등록한다. 그런데
 * 등록 UI 가 관리자용 Settings 안에만 있으면 일반 사용자가 찾지 못하므로, 가져오기 모달
 * 같은 **실제로 필요한 자리에서** 바로 등록할 수 있도록 이 카드를 공용으로 쓴다
 * (Settings 와 모달이 같은 구현을 공유해 동작이 갈리지 않게 한다).
 */
export function JiraConnectCard({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const { data: cred } = useJiraCredential();
  const saveCred = useSaveJiraCredential();
  const deleteCred = useDeleteJiraCredential();
  const testConn = useJiraTest();

  const [authType, setAuthType] = useState<JiraAuthType>('cookie');
  const [token, setToken] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  // 이미 등록된 사용자는 폼을 접어둔다 — 필요할 때만 펼쳐 재등록.
  const [editing, setEditing] = useState(false);

  const inputCls =
    'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
    'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

  const busy = saveCred.isPending || testConn.isPending || deleteCred.isPending;

  const handleSave = async () => {
    if (!token.trim()) {
      toast.error(authType === 'cookie' ? '세션 쿠키를 입력하세요' : '토큰을 입력하세요');
      return;
    }
    try {
      await saveCred.mutateAsync({ token: token.trim(), authType });
      setToken('');
      setResult(null);
      toast.success(authType === 'cookie' ? '내 세션 쿠키 저장됨' : '내 PAT 저장됨');
      // 저장 직후 바로 검증 — 형식 실수를 즉시 잡는다.
      const { data } = await testConn.mutateAsync();
      setResult({
        ok: data.ok,
        detail: data.ok ? (data.displayName ? `연결 정상 — ${data.displayName}` : '연결 정상') : data.detail,
      });
      if (data.ok) setEditing(false);
    } catch (err) {
      toast.error('저장 실패', formatApiError(err));
    }
  };

  const handleTest = async () => {
    setResult(null);
    try {
      const { data } = await testConn.mutateAsync();
      setResult({
        ok: data.ok,
        detail: data.ok ? (data.displayName ? `연결 정상 — ${data.displayName}` : '연결 정상') : data.detail,
      });
    } catch (err) {
      setResult({ ok: false, detail: formatApiError(err) });
    }
  };

  const handleDelete = async () => {
    try {
      await deleteCred.mutateAsync();
      setResult(null);
      setEditing(true);
      toast.success('내 Jira 인증 삭제됨');
    } catch (err) {
      toast.error('삭제 실패', formatApiError(err));
    }
  };

  const connected = !!cred?.configured;
  const open = editing || !connected;

  return (
    <div className={`rounded-xl border ${connected ? 'border-border bg-secondary/30' : 'border-amber-500/40 bg-amber-500/5'} p-3 space-y-2`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold">내 Jira 연결</span>
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
          connected ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
            : 'bg-amber-500/10 text-amber-500 border-amber-500/30'
        }`}>
          {connected
            ? `등록됨 · ${cred?.authType === 'sso' ? 'SSO' : cred?.authType === 'cookie' ? '세션 쿠키' : 'PAT'}`
            : '미등록 — 가져오기 전에 등록이 필요합니다'}
        </span>
        {cred?.jiraAccount && <span className="text-xs text-muted-foreground">{cred.jiraAccount}</span>}
        {cred?.lastVerifiedAt && (
          <span className="text-xs text-muted-foreground">
            검증 {parseUTC(cred.lastVerifiedAt).toLocaleString()}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {connected && (
            <button type="button" onClick={() => void handleTest()} disabled={busy}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-card text-xs hover:bg-secondary disabled:opacity-50">
              {testConn.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
              연결 테스트
            </button>
          )}
          {connected && (
            <button type="button" onClick={() => setEditing((v) => !v)}
              className="px-2 py-1 rounded-lg border border-border bg-card text-xs hover:bg-secondary">
              {editing ? '접기' : '재등록'}
            </button>
          )}
        </div>
      </div>

      {result && (
        <div className={`text-xs px-2 py-1.5 rounded-lg inline-flex items-center gap-1.5 ${
          result.ok ? 'bg-emerald-500/10 text-emerald-500' : 'bg-red-500/10 text-red-500'
        }`}>
          {result.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
          {result.detail}
        </div>
      )}

      {open && (
        <>
          <div className="flex items-stretch gap-1.5">
            {([
              { id: 'cookie' as const, label: '세션 쿠키', icon: Cookie },
              { id: 'pat' as const, label: 'Personal Access Token', icon: KeyRound },
            ]).map((m) => {
              const Icon = m.icon;
              return (
                <button key={m.id} type="button"
                  onClick={() => { setAuthType(m.id); setToken(''); setResult(null); }}
                  aria-pressed={authType === m.id}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-xl border text-xs font-medium transition-colors ${
                    authType === m.id ? 'bg-primary/10 text-primary border-primary/30 ring-2 ring-primary/20'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                  }`}>
                  <Icon className="w-3.5 h-3.5" /> {m.label}
                </button>
              );
            })}
          </div>

          {authType === 'cookie' ? (
            <textarea className={`${inputCls} font-mono text-xs min-h-[64px] resize-y`}
              placeholder="JSESSIONID=...; SMSESSION=...; atlassian.xsrf.token=..."
              value={token} onChange={(e) => setToken(e.target.value)}
              autoComplete="off" spellCheck={false} />
          ) : (
            <input className={inputCls} type="password" placeholder="PAT 붙여넣기"
              value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" onClick={() => void handleSave()} disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
              {saveCred.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              저장하고 연결 테스트
            </button>
            <button type="button" onClick={() => setShowGuide((v) => !v)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <HelpCircle className="w-3.5 h-3.5" /> 연결 가이드
            </button>
            {connected && (
              <button type="button" onClick={() => void handleDelete()} disabled={busy}
                className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-50">
                <Trash2 className="w-3.5 h-3.5" /> 인증 삭제
              </button>
            )}
          </div>

          {showGuide && (
            <div className="rounded-lg bg-card border border-border px-3 py-2 text-xs text-muted-foreground leading-relaxed space-y-1.5">
              {authType === 'cookie' ? (
                <>
                  <p className="font-medium text-foreground">세션 쿠키 얻는 법</p>
                  <ol className="list-decimal list-inside space-y-0.5">
                    <li>사내 브라우저에서 <b>Jira 에 평소처럼 SSO 로그인</b>합니다.</li>
                    <li>개발자 도구(F12) ▸ <b>Network</b> 탭 ▸ 아무 요청이나 클릭합니다.</li>
                    <li><b>Request Headers</b> 의 <code className="px-1 rounded bg-secondary">Cookie</code> 값을
                      <b> 통째로</b> 복사해 위에 붙여넣습니다.</li>
                    <li>저장하면 자동으로 연결 테스트까지 수행합니다.</li>
                  </ol>
                  <p className="text-amber-500">
                    ⚠ <b>값만 넣으면 안 됩니다</b> — <code className="px-1 rounded bg-secondary">이름=값</code> 형식이어야 하고,
                    여러 개면 <code className="px-1 rounded bg-secondary">;</code> 로 연결합니다. SSO 환경은 JSESSIONID
                    하나로 부족한 경우가 많아 <b>Cookie 헤더 전체</b>가 확실합니다.
                  </p>
                  <p>
                    세션은 시간이 지나면 만료됩니다. 가져오기가 인증 오류로 실패하면 같은 방법으로 다시 등록하세요.
                    만료 없이 쓰려면 <b>PAT</b> 발급이 가능한지 Jira 관리자에게 확인하는 편이 낫습니다.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium text-foreground">PAT 발급 방법 (권장 — 만료·재등록 없음)</p>
                  <ol className="list-decimal list-inside space-y-0.5">
                    <li>Jira 우측 상단 <b>프로필 ▸ Personal Access Tokens</b> 로 이동합니다.</li>
                    <li><b>Create token</b> 으로 토큰을 만들고 값을 복사합니다(한 번만 보입니다).</li>
                    <li>위에 붙여넣고 저장하면 연결 테스트까지 수행합니다.</li>
                  </ol>
                  <p>메뉴가 없으면 이 Jira 는 PAT 가 비활성화된 것이므로 세션 쿠키 방식을 쓰세요.</p>
                </>
              )}
            </div>
          )}
        </>
      )}

      {!compact && connected && !editing && (
        <p className="text-xs text-muted-foreground">
          이 자격으로 <b>본인 권한</b>의 이슈만 가져오고 반영합니다. 자격은 암호화 저장되며 화면에 다시 표시되지 않습니다.
        </p>
      )}
    </div>
  );
}
