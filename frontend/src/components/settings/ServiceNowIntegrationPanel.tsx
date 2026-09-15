import { useEffect, useState } from 'react';
import { Loader2, Wifi, WifiOff, Save, Globe } from 'lucide-react';
import { useServiceNowConfig, useUpdateServiceNowConfig, useServiceNowTest } from '@/hooks/useServiceNow';
import { useAuthStore } from '@/stores/authStore';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

const textareaCls = `${inputCls} font-mono text-xs`;

/**
 * ServiceNow ITSM 연동 공통 설정 — `JiraIntegrationPanel` 의 공통 설정 카드와 동일 구조.
 *
 * 1차 구현은 전용 ServiceNow 인증 UI가 없다 — Jira/SSO 세션을 그대로 재사용하므로 이
 * 패널에는 "내 인증" 카드가 없고, 대신 실제 인스턴스 스펙(테이블명/필드 매핑)이 확인되기
 * 전까지 관리자가 코드 수정 없이 바로 조정할 수 있도록 값을 노출한다(UI-First 원칙).
 */
export function ServiceNowIntegrationPanel() {
  const toast = useToast();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const { data: config } = useServiceNowConfig();
  const updateConfig = useUpdateServiceNowConfig();
  const testConn = useServiceNowTest();

  const [baseUrl, setBaseUrl] = useState('');
  const [tableName, setTableName] = useState('incident');
  const [enabled, setEnabled] = useState(false);
  const [verifyTls, setVerifyTls] = useState(true);
  const [fieldMappingText, setFieldMappingText] = useState('{}');
  const [priorityMapText, setPriorityMapText] = useState('{}');
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  useEffect(() => {
    if (config) {
      setBaseUrl(config.baseUrl ?? '');
      setTableName(config.tableName || 'incident');
      setEnabled(!!config.enabled);
      setVerifyTls(config.verifyTls !== false);
      setFieldMappingText(JSON.stringify(config.fieldMapping ?? {}, null, 2));
      setPriorityMapText(JSON.stringify(config.priorityMap ?? {}, null, 2));
    }
  }, [config]);

  const handleSaveConfig = async () => {
    let fieldMapping: Record<string, string>;
    let priorityMap: Record<string, string>;
    try {
      fieldMapping = JSON.parse(fieldMappingText || '{}');
      priorityMap = JSON.parse(priorityMapText || '{}');
    } catch {
      toast.error('저장 실패', '필드 매핑 / 우선순위 매핑이 올바른 JSON 형식이 아닙니다.');
      return;
    }
    try {
      await updateConfig.mutateAsync({
        baseUrl: baseUrl.trim(),
        tableName: tableName.trim() || 'incident',
        enabled,
        verifyTls,
        fieldMapping,
        priorityMap,
      });
      toast.success('설정 저장됨');
    } catch (err) {
      toast.error('저장 실패', formatApiError(err));
    }
  };

  const runTest = async () => {
    setTestResult(null);
    try {
      const { data } = await testConn.mutateAsync();
      setTestResult({ ok: data.ok, detail: data.detail });
      if (data.ok) toast.success('연결 성공', data.displayName ?? data.detail);
      else toast.error('연결 실패', data.detail);
    } catch (err) {
      toast.error('연결 실패', formatApiError(err));
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <Globe className="w-4 h-4 text-primary" />
          <h3 className="font-semibold">ServiceNow 공통 설정</h3>
          {!isAdmin && <span className="text-xs text-muted-foreground">(관리자만 수정 가능)</span>}
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          사내에 구축된 ServiceNow ITSM 의 Base URL 을 설정합니다. 실제 인스턴스의 테이블명·필드
          스펙이 아래 기본값(표준 Table API 가정)과 다르면 코드 수정 없이 여기서 조정하세요.
          인증은 별도 자격증명 없이 현재 로그인 사용자의 Jira/SSO 세션을 재사용합니다
          (Settings → 연동(Jira)에서 SSO 자동 로그인 필요) — 전용 인증은 추후 개선 예정입니다.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <span className="block text-sm font-medium text-muted-foreground mb-1">Base URL</span>
            <input className={inputCls} placeholder="https://itsm.internal.example.com" value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)} disabled={!isAdmin} />
          </div>
          <div>
            <span className="block text-sm font-medium text-muted-foreground mb-1">테이블명</span>
            <input className={inputCls} placeholder="incident" value={tableName}
              onChange={(e) => setTableName(e.target.value)} disabled={!isAdmin} />
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
          <div>
            <span className="block text-sm font-medium text-muted-foreground mb-1">
              필드 매핑 (ServiceNow 필드명 → PEP 업무 필드명, JSON)
            </span>
            <textarea className={textareaCls} rows={4} value={fieldMappingText}
              onChange={(e) => setFieldMappingText(e.target.value)} disabled={!isAdmin} />
          </div>
          <div>
            <span className="block text-sm font-medium text-muted-foreground mb-1">
              우선순위 매핑 (PEP priority → ServiceNow urgency, JSON)
            </span>
            <textarea className={textareaCls} rows={4} value={priorityMapText}
              onChange={(e) => setPriorityMapText(e.target.value)} disabled={!isAdmin} />
          </div>
        </div>
        {isAdmin && (
          <div className="mt-4">
            <button onClick={() => void handleSaveConfig()} disabled={updateConfig.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
              {updateConfig.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              설정 저장
            </button>
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-xl p-5">
        <h3 className="font-semibold mb-3">연결 테스트</h3>
        <button onClick={() => void runTest()} disabled={testConn.isPending}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-secondary hover:bg-secondary/80 text-sm font-medium disabled:opacity-50">
          {testConn.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wifi className="w-4 h-4" />}
          연결 테스트
        </button>
        {testResult && (
          <p className={`mt-2 text-sm flex items-center gap-1.5 ${testResult.ok ? 'text-status-healthy' : 'text-status-critical'}`}>
            {testResult.ok ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {testResult.detail}
          </p>
        )}
      </div>
    </div>
  );
}
