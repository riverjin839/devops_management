import { useEffect, useMemo, useState } from 'react';
import {
  Bot, Plus, Trash2, Pencil, Loader2, PlugZap, KeyRound, RefreshCw,
  AlertTriangle, Activity, Radar,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useToast, ConfirmDialog } from '@/components/common';
import { llmApi } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import {
  useLlmSettings, useUpdateLlmSettings, useLlmHealth, useLlmUsage,
  useLlmCredentials, useCreateLlmCredential, useDeleteLlmCredential,
  useLlmProfileModels, useLlmAnalysisScope, useUpdateLlmAnalysisScope,
} from '@/hooks/useLlmSettings';
import { useClusters } from '@/hooks/useCluster';
import type {
  LlmAnalysisScope, LlmAnalysisScopeRule, LlmProfile, LlmSettings, LlmTestResult,
} from '@/types';

// axios 인터셉터가 응답 키를 camelCase 로 변환하므로 purpose 키도 camelCase 로 다룬다
// (요청 시 자동으로 snake_case 로 역변환되어 백엔드 PURPOSES 와 일치).
const PURPOSE_LABELS: Record<string, string> = {
  chat: 'AI 챗봇',
  incidentAnalysis: '장애 분석',
  reviewSummary: '점검 리뷰/요약',
  archDoc: '아키텍처 문서',
  trends: '기술 트렌드 요약',
  embedding: '임베딩 (유사 검색)',
};

const ANALYZER_LABELS: Record<string, string> = {
  rule_based: '규칙 기반 (LLM 미사용)',
  local_llm: 'LLM 분석 (라우팅된 프로필 사용)',
  claude: 'Claude (외부망 전용)',
};

const EMPTY_PROFILE: LlmProfile = {
  name: '',
  provider: 'openai_compat',
  baseUrl: '',
  model: '',
  apiKeyRef: '',
  timeoutSeconds: 120,
  maxConcurrency: 2,
  enabled: true,
};

/**
 * Settings → AI/LLM 탭 — 폐쇄망 LLM 이중 운용(사내 LLM + 인클러스터 Ollama)의
 * 운영자 편집 화면. 프로필(엔드포인트) CRUD, 용도별 라우팅, 분석기 선택,
 * API 키(암호화 저장) 관리, 알람 자동 분석 범위, health/사용량 가시화를 담당한다.
 */
export function LlmSettingsTab() {
  const toast = useToast();
  const { data: settingsResp, isLoading } = useLlmSettings();
  const { data: health } = useLlmHealth();
  const { data: usage } = useLlmUsage();
  const { data: credentials } = useLlmCredentials();
  const updateMut = useUpdateLlmSettings();
  const createCredMut = useCreateLlmCredential();
  const deleteCredMut = useDeleteLlmCredential();

  const [draft, setDraft] = useState<LlmSettings | null>(null);
  const [editing, setEditing] = useState<LlmProfile | null>(null);
  const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ profile: string; result: LlmTestResult } | null>(null);
  const [credModalOpen, setCredModalOpen] = useState(false);
  const [credName, setCredName] = useState('');
  const [credKey, setCredKey] = useState('');

  const purposes = Object.keys(PURPOSE_LABELS);

  useEffect(() => {
    if (settingsResp?.data && draft === null) setDraft(settingsResp.data);
  }, [settingsResp, draft]);

  const healthByProfile = useMemo(() => {
    const map: Record<string, { status: string; detail: string; latencyMs: number }> = {};
    (health ?? []).forEach((h) => { map[h.profile] = h; });
    return map;
  }, [health]);

  const usageSummary = useMemo(() => {
    const agg: Record<string, { count: number; errors: number; latencySum: number; tokens: number }> = {};
    (usage ?? []).forEach((u) => {
      const key = `${u.profile}|${u.purpose}`;
      const cur = agg[key] ?? { count: 0, errors: 0, latencySum: 0, tokens: 0 };
      cur.count += u.count;
      cur.errors += u.errors;
      cur.latencySum += u.avgLatencyMs * u.count;
      cur.tokens += u.promptTokens + u.completionTokens;
      agg[key] = cur;
    });
    return Object.entries(agg)
      .map(([key, v]) => {
        const [profile, purpose] = key.split('|');
        return {
          profile, purpose,
          count: v.count, errors: v.errors,
          avgLatency: v.count ? Math.round(v.latencySum / v.count) : 0,
          tokens: v.tokens,
        };
      })
      .sort((a, b) => b.count - a.count);
  }, [usage]);

  if (isLoading || !draft) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> LLM 설정을 불러오는 중…
      </div>
    );
  }

  const save = async (next: LlmSettings) => {
    try {
      const res = await updateMut.mutateAsync(next);
      setDraft(res.data);
      if (res.warnings?.length) {
        res.warnings.forEach((w) => toast.warning('저장됨 (주의)', w));
      } else {
        toast.success('저장 완료', 'LLM 설정이 저장되었습니다. (반영까지 최대 1분)');
      }
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const upsertProfile = (profile: LlmProfile) => {
    const name = profile.name.trim();
    if (!name || !profile.baseUrl.trim()) {
      toast.error('입력 오류', '프로필 이름과 엔드포인트 URL 은 필수입니다.');
      return;
    }
    const others = draft.profiles.filter((p) => p.name !== (editingOriginalName ?? name));
    if (others.some((p) => p.name === name)) {
      toast.error('입력 오류', `프로필 이름 '${name}' 이 이미 존재합니다.`);
      return;
    }
    let routing = draft.routing;
    if (editingOriginalName && editingOriginalName !== name) {
      // 이름 변경 시 라우팅 참조 함께 갱신
      routing = Object.fromEntries(Object.entries(draft.routing).map(([k, v]) => [k, {
        primary: v.primary === editingOriginalName ? name : v.primary,
        fallback: v.fallback === editingOriginalName ? name : v.fallback,
      }]));
    }
    const next = {
      ...draft,
      profiles: [...others, { ...profile, name }],
      routing,
    };
    setEditing(null);
    setEditingOriginalName(null);
    void save(next);
  };

  const removeProfile = (name: string) => {
    if (draft.profiles.length <= 1) {
      toast.error('삭제 불가', '프로필은 최소 1개 필요합니다.');
      return;
    }
    const used = Object.entries(draft.routing)
      .filter(([, r]) => r.primary === name)
      .map(([p]) => PURPOSE_LABELS[p] ?? p);
    if (used.length) {
      toast.error('삭제 불가', `이 프로필이 primary 로 지정된 용도가 있습니다: ${used.join(', ')}`);
      return;
    }
    const next = {
      ...draft,
      profiles: draft.profiles.filter((p) => p.name !== name),
      routing: Object.fromEntries(Object.entries(draft.routing).map(([k, v]) => [k, {
        primary: v.primary,
        fallback: v.fallback === name ? null : v.fallback,
      }])),
    };
    void save(next);
  };

  const runTest = async (name: string) => {
    setTesting(name);
    setTestResult(null);
    try {
      const res = await llmApi.testProfile(name);
      setTestResult({ profile: name, result: res.data });
      if (res.data.status === 'ok') {
        toast.success('연결 확인 완료', `${name}: ${res.data.latencyMs}ms`);
      } else {
        toast.error('연결 실패', `${name}: ${res.data.error ?? res.data.status}`);
      }
    } catch (e) {
      toast.error('연결 테스트 실패', formatApiError(e));
    } finally {
      setTesting(null);
    }
  };

  const setRoute = (purpose: string, field: 'primary' | 'fallback', value: string) => {
    const cur = draft.routing[purpose] ?? { primary: draft.profiles[0]?.name ?? '', fallback: null };
    const nextRoute = { ...cur, [field]: field === 'fallback' && value === '' ? null : value };
    if (nextRoute.fallback === nextRoute.primary) nextRoute.fallback = null;
    setDraft({ ...draft, routing: { ...draft.routing, [purpose]: nextRoute } });
  };

  const statusPill = (name: string, enabled: boolean) => {
    const h = healthByProfile[name];
    if (!enabled) {
      return <span className="px-2 py-0.5 text-xs rounded-full bg-muted text-muted-foreground">비활성</span>;
    }
    if (!h) {
      return <span className="px-2 py-0.5 text-xs rounded-full bg-secondary text-muted-foreground">확인 중…</span>;
    }
    if (h.status === 'online' && h.detail) {
      return <span className="px-2 py-0.5 text-xs rounded-full bg-status-warning/15 text-status-warning" title={h.detail}>모델 미준비</span>;
    }
    if (h.status === 'online') {
      return <span className="px-2 py-0.5 text-xs rounded-full bg-status-healthy/15 text-status-healthy">온라인 · {h.latencyMs}ms</span>;
    }
    return <span className="px-2 py-0.5 text-xs rounded-full bg-status-critical/15 text-status-critical" title={h.detail}>오프라인</span>;
  };

  return (
    <div className="space-y-6 mb-6">
      {/* ── LLM 엔드포인트 프로필 ── */}
      <MacCard title="LLM 엔드포인트 프로필" bodyPadding="p-0">
        <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border flex items-center justify-between">
          <span>
            사내 LLM 서비스(OpenAI 호환)와 인클러스터 Ollama 를 프로필로 등록하고, 아래 용도별 라우팅에서 어느 LLM 을 쓸지 지정합니다.
          </span>
          <button
            type="button"
            onClick={() => { setEditing({ ...EMPTY_PROFILE }); setEditingOriginalName(null); }}
            className="flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> 프로필 추가
          </button>
        </div>
        <div className="divide-y divide-border">
          {draft.profiles.map((p) => (
            <div key={p.name} className="px-4 py-3 flex items-center gap-3">
              <Bot className="w-4 h-4 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="px-1.5 py-0.5 text-xs rounded bg-secondary text-muted-foreground">
                    {p.provider === 'ollama' ? 'Ollama' : 'OpenAI 호환'}
                  </span>
                  {statusPill(p.name, p.enabled)}
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {p.baseUrl} · 모델 {p.model || '(미지정)'} · 동시 {p.maxConcurrency} · {p.timeoutSeconds}s
                  {p.apiKeyRef ? ` · 키 ${p.apiKeyRef}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => runTest(p.name)}
                disabled={testing !== null}
                title="연결 테스트"
                aria-label={`${p.name} 연결 테스트`}
                className="p-1.5 rounded-xl hover:bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {testing === p.name ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
              </button>
              <button
                type="button"
                onClick={() => { setEditing({ ...p }); setEditingOriginalName(p.name); }}
                title="편집"
                aria-label={`${p.name} 편집`}
                className="p-1.5 rounded-xl hover:bg-secondary text-muted-foreground hover:text-foreground"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(p.name)}
                title="삭제"
                aria-label={`${p.name} 삭제`}
                className="p-1.5 rounded-xl hover:bg-secondary text-muted-foreground hover:text-status-critical"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
        {testResult && (
          <div className="px-4 py-2 border-t border-border text-xs">
            <span className="font-medium">{testResult.profile}</span>{' '}
            {testResult.result.status === 'ok' ? (
              <span className="text-status-healthy">
                응답 {testResult.result.latencyMs}ms — “{testResult.result.answerPreview}”
              </span>
            ) : (
              <span className="text-status-critical">
                실패: {testResult.result.error ?? testResult.result.status}
              </span>
            )}
          </div>
        )}
      </MacCard>

      {/* ── 용도별 라우팅 ── */}
      <MacCard title="용도별 LLM 라우팅" bodyPadding="p-0">
        <p className="px-4 py-2 text-xs text-muted-foreground border-b border-border">
          각 기능이 어떤 LLM 프로필을 쓸지 지정합니다. primary 실패 시 fallback 으로 자동 전환됩니다.
          예: 챗봇은 사내 LLM, 임베딩은 Ollama 로 병행 운용.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border">
                <th className="text-left px-4 py-2 font-medium">용도</th>
                <th className="text-left px-4 py-2 font-medium">Primary</th>
                <th className="text-left px-4 py-2 font-medium">Fallback</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {purposes.map((purpose) => {
                const route = draft.routing[purpose] ?? { primary: draft.profiles[0]?.name ?? '', fallback: null };
                return (
                  <tr key={purpose}>
                    <td className="px-4 py-2">
                      {PURPOSE_LABELS[purpose] ?? purpose}
                      {purpose === 'embedding' && (
                        <p className="text-xs text-muted-foreground">모델은 아래 임베딩 모델 설정을 따릅니다</p>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={route.primary}
                        onChange={(e) => setRoute(purpose, 'primary', e.target.value)}
                        aria-label={`${PURPOSE_LABELS[purpose] ?? purpose} primary 프로필`}
                        className="bg-secondary border border-border rounded-xl px-2 py-1.5 text-sm"
                      >
                        {draft.profiles.map((p) => (
                          <option key={p.name} value={p.name}>{p.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={route.fallback ?? ''}
                        onChange={(e) => setRoute(purpose, 'fallback', e.target.value)}
                        aria-label={`${PURPOSE_LABELS[purpose] ?? purpose} fallback 프로필`}
                        className="bg-secondary border border-border rounded-xl px-2 py-1.5 text-sm"
                      >
                        <option value="">(없음)</option>
                        {draft.profiles.filter((p) => p.name !== route.primary).map((p) => (
                          <option key={p.name} value={p.name}>{p.name}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </MacCard>

      {/* ── 일반 설정 ── */}
      <MacCard title="분석기 · 언어 · 임베딩" bodyPadding="p-0">
        <div className="divide-y divide-border">
          <div className="px-4 py-3 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm">장애 분석 백엔드</p>
              <p className="text-xs text-muted-foreground">
                AI 장애 분석(수동 + 알람 자동 분석)이 사용할 분석기. LLM 분석을 켜기 전에 프로필 연결을 먼저 확인하세요.
              </p>
            </div>
            <select
              value={draft.analyzerBackend}
              onChange={(e) => setDraft({ ...draft, analyzerBackend: e.target.value as LlmSettings['analyzerBackend'] })}
              aria-label="장애 분석 백엔드"
              className="bg-secondary border border-border rounded-xl px-2 py-1.5 text-sm"
            >
              {Object.entries(ANALYZER_LABELS).map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </div>
          <div className="px-4 py-3 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm">응답 언어</p>
              <p className="text-xs text-muted-foreground">시스템 프롬프트 언어 — 챗봇/분석/요약 응답 언어의 기본값</p>
            </div>
            <select
              value={draft.language}
              onChange={(e) => setDraft({ ...draft, language: e.target.value as LlmSettings['language'] })}
              aria-label="응답 언어"
              className="bg-secondary border border-border rounded-xl px-2 py-1.5 text-sm"
            >
              <option value="ko">한국어</option>
              <option value="en">English</option>
            </select>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm">임베딩 모델</p>
                <p className="text-xs text-muted-foreground">유사 업무/가이드 검색용 임베딩 모델 (768차원)</p>
              </div>
              <input
                value={draft.embeddingModel}
                onChange={(e) => setDraft({ ...draft, embeddingModel: e.target.value })}
                aria-label="임베딩 모델"
                className="bg-secondary border border-border rounded-xl px-3 py-1.5 text-sm w-56"
              />
            </div>
            {settingsResp?.data.embeddingModel !== draft.embeddingModel && (
              <p className="mt-2 text-xs text-status-warning flex items-center gap-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                임베딩 모델을 바꾸면 기존 저장 임베딩과 비교할 수 없어 전체 재계산이 필요합니다.
              </p>
            )}
          </div>
        </div>
        <div className="px-4 py-3 border-t border-border flex justify-end">
          <button
            type="button"
            onClick={() => save(draft)}
            disabled={updateMut.isPending}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {updateMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            라우팅 · 일반 설정 저장
          </button>
        </div>
      </MacCard>

      {/* ── 알람 자동 분석 범위 ── */}
      <AnalysisScopePanel />

      {/* ── API 키 (자격증명) ── */}
      <MacCard title="API 키 (자격증명)" bodyPadding="p-0">
        <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border flex items-center justify-between">
          <span>
            사내 LLM 서비스의 API 키를 암호화 저장합니다. 프로필에서 <code>credential:&lt;이름&gt;</code> 으로 참조하세요. 키 원문은 다시 표시되지 않습니다.
          </span>
          <button
            type="button"
            onClick={() => { setCredName(''); setCredKey(''); setCredModalOpen(true); }}
            className="flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> 키 등록
          </button>
        </div>
        {(credentials ?? []).length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">등록된 키가 없습니다.</p>
        ) : (
          <div className="divide-y divide-border">
            {(credentials ?? []).map((c) => (
              <div key={c.name} className="px-4 py-2.5 flex items-center gap-3">
                <KeyRound className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="text-sm font-medium">{c.name}</span>
                <span className="text-xs text-muted-foreground font-mono">{c.hint}</span>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await deleteCredMut.mutateAsync(c.name);
                      toast.success('삭제 완료', `자격증명 '${c.name}' 을 삭제했습니다.`);
                    } catch (e) {
                      toast.error('삭제 실패', formatApiError(e));
                    }
                  }}
                  title="삭제"
                  aria-label={`자격증명 ${c.name} 삭제`}
                  className="p-1.5 rounded-xl hover:bg-secondary text-muted-foreground hover:text-status-critical"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </MacCard>

      {/* ── 사용량 (최근 24h) ── */}
      <MacCard title="LLM 사용량 (최근 24시간)" bodyPadding="p-0">
        <p className="px-4 py-2 text-xs text-muted-foreground border-b border-border">
          프로필 × 용도별 호출량/오류/평균 지연. 분석 범위를 넓히기 전에 부하를 확인하세요.
        </p>
        {usageSummary.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground flex items-center gap-2">
            <Activity className="w-4 h-4" /> 아직 집계된 호출이 없습니다.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border">
                  <th className="text-left px-4 py-2 font-medium">프로필</th>
                  <th className="text-left px-4 py-2 font-medium">용도</th>
                  <th className="text-right px-4 py-2 font-medium">호출</th>
                  <th className="text-right px-4 py-2 font-medium">오류</th>
                  <th className="text-right px-4 py-2 font-medium">평균 지연</th>
                  <th className="text-right px-4 py-2 font-medium">토큰</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {usageSummary.map((row) => (
                  <tr key={`${row.profile}-${row.purpose}`}>
                    <td className="px-4 py-2">{row.profile}</td>
                    <td className="px-4 py-2">{PURPOSE_LABELS[row.purpose] ?? row.purpose}</td>
                    <td className="px-4 py-2 text-right">{row.count.toLocaleString()}</td>
                    <td className={`px-4 py-2 text-right ${row.errors > 0 ? 'text-status-critical' : ''}`}>
                      {row.errors.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right">{row.avgLatency.toLocaleString()}ms</td>
                    <td className="px-4 py-2 text-right">{row.tokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </MacCard>

      {/* ── 프로필 편집 모달 ── */}
      {editing && (
        <ProfileEditModal
          profile={editing}
          isNew={editingOriginalName === null}
          credentials={(credentials ?? []).map((c) => c.name)}
          onCancel={() => { setEditing(null); setEditingOriginalName(null); }}
          onSave={upsertProfile}
        />
      )}

      {/* ── 자격증명 등록 모달 ── */}
      {credModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="API 키 등록">
          <div className="bg-card border border-border rounded-md shadow-lg w-full max-w-md p-5 space-y-4">
            <h3 className="text-sm font-semibold flex items-center gap-2"><KeyRound className="w-4 h-4" /> API 키 등록</h3>
            <div className="space-y-3">
              <label className="block text-xs text-muted-foreground">
                이름 (프로필에서 credential:이름 으로 참조)
                <input
                  value={credName}
                  onChange={(e) => setCredName(e.target.value)}
                  placeholder="internal-llm-key"
                  className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                API 키
                <input
                  value={credKey}
                  onChange={(e) => setCredKey(e.target.value)}
                  type="password"
                  placeholder="sk-…"
                  className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm font-mono"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCredModalOpen(false)}
                className="px-3 py-1.5 rounded-xl text-sm text-muted-foreground hover:bg-secondary"
              >
                취소
              </button>
              <button
                type="button"
                disabled={!credName.trim() || !credKey.trim() || createCredMut.isPending}
                onClick={async () => {
                  try {
                    await createCredMut.mutateAsync({ name: credName.trim(), apiKey: credKey.trim() });
                    toast.success('등록 완료', `자격증명 '${credName.trim()}' 을 저장했습니다.`);
                    setCredModalOpen(false);
                  } catch (e) {
                    toast.error('등록 실패', formatApiError(e));
                  }
                }}
                className="px-3 py-1.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                저장
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="프로필 삭제"
        description={`프로필 '${deleteTarget ?? ''}' 을 삭제할까요? 이 프로필을 fallback 으로 쓰는 라우팅은 (없음) 으로 바뀝니다.`}
        confirmLabel="삭제"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) removeProfile(deleteTarget);
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

// ── 알람 자동 분석 범위 패널 ────────────────────────────────────────────

const EMPTY_RULE: Omit<LlmAnalysisScopeRule, 'id'> = {
  priority: 100,
  enabled: true,
  clusterId: null,
  namespacePattern: '*',
  alertnamePattern: '*',
  severityMin: 'warning',
  maxPerHour: 10,
  notifyAnalysis: false,
  includeLogs: false,
};

function AnalysisScopePanel() {
  const toast = useToast();
  const { data: scope } = useLlmAnalysisScope();
  const updateMut = useUpdateLlmAnalysisScope();
  const { data: clusters } = useClusters();
  const [draft, setDraft] = useState<LlmAnalysisScope | null>(null);

  useEffect(() => {
    if (scope && draft === null) setDraft(scope);
  }, [scope, draft]);

  if (!draft) {
    return (
      <MacCard title="알람 자동 분석 범위" bodyPadding="p-4">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> 불러오는 중…
        </div>
      </MacCard>
    );
  }

  const save = async (next: LlmAnalysisScope) => {
    try {
      const res = await updateMut.mutateAsync(next);
      setDraft(res.data);
      if (res.warnings?.length) {
        res.warnings.forEach((w) => toast.warning('저장됨 (주의)', w));
      } else {
        toast.success('저장 완료', '자동 분석 범위가 저장되었습니다. (반영까지 최대 1분)');
      }
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const setRule = (idx: number, patch: Partial<LlmAnalysisScopeRule>) => {
    const rules = draft.rules.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    setDraft({ ...draft, rules });
  };

  return (
    <MacCard title="알람 자동 분석 범위" bodyPadding="p-0">
      <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border flex items-center justify-between gap-3">
        <span>
          알람 수신 시 규칙(클러스터/네임스페이스/알람명/심각도)에 매칭되면 AI 분석을 자동 실행합니다.
          규칙은 priority 오름차순 first-match. 시간당 상한·디바운스로 부하를 제한하며, 아래 사용량 표를 보면서 점진적으로 넓히세요.
        </span>
        <label className="flex items-center gap-2 text-sm shrink-0">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            className="rounded"
          />
          자동 분석 활성화
        </label>
      </div>

      <div className="px-4 py-3 flex flex-wrap items-center gap-4 border-b border-border text-sm">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          디바운스(초)
          <input
            type="number" min={0} max={86400}
            value={draft.debounceSeconds}
            onChange={(e) => setDraft({ ...draft, debounceSeconds: Number(e.target.value) || 0 })}
            className="w-24 bg-secondary border border-border rounded-xl px-2 py-1.5 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          전역 시간당 최대 분석
          <input
            type="number" min={1} max={1000}
            value={draft.globalMaxPerHour}
            onChange={(e) => setDraft({ ...draft, globalMaxPerHour: Number(e.target.value) || 1 })}
            className="w-24 bg-secondary border border-border rounded-xl px-2 py-1.5 text-sm"
          />
        </label>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setDraft({
            ...draft,
            rules: [...draft.rules, { ...EMPTY_RULE, id: `r${Date.now().toString(36)}` }],
          })}
          className="flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs font-medium bg-secondary border border-border hover:bg-muted"
        >
          <Plus className="w-3.5 h-3.5" /> 규칙 추가
        </button>
      </div>

      {draft.rules.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground flex items-center gap-2">
          <Radar className="w-4 h-4" /> 규칙이 없습니다 — 활성화해도 아무 알람도 분석되지 않습니다.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-border">
                <th className="text-left px-3 py-2 font-medium">on</th>
                <th className="text-left px-3 py-2 font-medium">우선순위</th>
                <th className="text-left px-3 py-2 font-medium">클러스터</th>
                <th className="text-left px-3 py-2 font-medium">네임스페이스</th>
                <th className="text-left px-3 py-2 font-medium">알람명 패턴</th>
                <th className="text-left px-3 py-2 font-medium">심각도≥</th>
                <th className="text-left px-3 py-2 font-medium">시간당</th>
                <th className="text-left px-3 py-2 font-medium">로그</th>
                <th className="text-left px-3 py-2 font-medium">알림</th>
                <th className="px-3 py-2">
                  <span className="sr-only">삭제</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {draft.rules.map((rule, idx) => (
                <tr key={rule.id}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox" checked={rule.enabled}
                      onChange={(e) => setRule(idx, { enabled: e.target.checked })}
                      aria-label="규칙 활성화" className="rounded"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" value={rule.priority}
                      onChange={(e) => setRule(idx, { priority: Number(e.target.value) || 100 })}
                      aria-label="우선순위"
                      className="w-16 bg-secondary border border-border rounded-xl px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={rule.clusterId ?? ''}
                      onChange={(e) => setRule(idx, { clusterId: e.target.value || null })}
                      aria-label="클러스터"
                      className="bg-secondary border border-border rounded-xl px-2 py-1 text-sm max-w-[140px]"
                    >
                      <option value="">(전체)</option>
                      {(clusters ?? []).map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={rule.namespacePattern}
                      onChange={(e) => setRule(idx, { namespacePattern: e.target.value })}
                      aria-label="네임스페이스 패턴" placeholder="prod-*"
                      className="w-24 bg-secondary border border-border rounded-xl px-2 py-1 text-sm font-mono"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={rule.alertnamePattern}
                      onChange={(e) => setRule(idx, { alertnamePattern: e.target.value })}
                      aria-label="알람명 패턴" placeholder="KubePod*"
                      className="w-28 bg-secondary border border-border rounded-xl px-2 py-1 text-sm font-mono"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={rule.severityMin}
                      onChange={(e) => setRule(idx, { severityMin: e.target.value as LlmAnalysisScopeRule['severityMin'] })}
                      aria-label="최소 심각도"
                      className="bg-secondary border border-border rounded-xl px-2 py-1 text-sm"
                    >
                      <option value="info">info</option>
                      <option value="warning">warning</option>
                      <option value="critical">critical</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min={1} value={rule.maxPerHour}
                      onChange={(e) => setRule(idx, { maxPerHour: Number(e.target.value) || 1 })}
                      aria-label="시간당 최대"
                      className="w-16 bg-secondary border border-border rounded-xl px-2 py-1 text-sm"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox" checked={rule.includeLogs}
                      onChange={(e) => setRule(idx, { includeLogs: e.target.checked })}
                      aria-label="파드 로그 포함" title="분석 시 파드 로그 수집 (read-only)"
                      className="rounded"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox" checked={rule.notifyAnalysis}
                      onChange={(e) => setRule(idx, { notifyAnalysis: e.target.checked })}
                      aria-label="분석 완료 알림" title="분석 완료 시 인앱 알림 발송"
                      className="rounded"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, rules: draft.rules.filter((_, i) => i !== idx) })}
                      title="규칙 삭제" aria-label="규칙 삭제"
                      className="p-1 rounded-xl hover:bg-secondary text-muted-foreground hover:text-status-critical"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="px-4 py-3 border-t border-border flex justify-end">
        <button
          type="button"
          onClick={() => save(draft)}
          disabled={updateMut.isPending}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {updateMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          분석 범위 저장
        </button>
      </div>
    </MacCard>
  );
}

// ── 프로필 편집 모달 ────────────────────────────────────────────────────

function ProfileEditModal({
  profile, isNew, credentials, onCancel, onSave,
}: {
  profile: LlmProfile;
  isNew: boolean;
  credentials: string[];
  onCancel: () => void;
  onSave: (p: LlmProfile) => void;
}) {
  const [form, setForm] = useState<LlmProfile>(profile);
  const [modelListOpen, setModelListOpen] = useState(false);
  const { data: models, isFetching: modelsLoading } = useLlmProfileModels(
    isNew ? '' : profile.name, modelListOpen,
  );

  const keyRefKind = form.apiKeyRef.startsWith('credential:')
    ? 'credential'
    : form.apiKeyRef.startsWith('env:') ? 'env' : 'none';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="LLM 프로필 편집">
      <div className="bg-card border border-border rounded-md shadow-lg w-full max-w-lg p-5 space-y-4 max-h-[85vh] overflow-y-auto">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Bot className="w-4 h-4" /> {isNew ? '프로필 추가' : `프로필 편집 — ${profile.name}`}
        </h3>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-muted-foreground col-span-1">
            이름
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="internal-llm"
              className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-xs text-muted-foreground col-span-1">
            Provider
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value as LlmProfile['provider'] })}
              className="mt-1 w-full bg-secondary border border-border rounded-xl px-2 py-2 text-sm"
            >
              <option value="openai_compat">OpenAI 호환 (사내 LLM 서비스 / vLLM)</option>
              <option value="ollama">Ollama (인클러스터 자체 LLM)</option>
            </select>
          </label>
          <label className="block text-xs text-muted-foreground col-span-2">
            엔드포인트 URL
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder={form.provider === 'ollama' ? 'http://ollama:11434' : 'http://llm-gw.corp.internal:8000'}
              className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm font-mono"
            />
          </label>
          <div className="col-span-2">
            <label className="block text-xs text-muted-foreground">
              모델
              <div className="mt-1 flex gap-2">
                <input
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  placeholder={form.provider === 'ollama' ? 'qwen2.5-coder:7b' : 'corp-qwen3-32b'}
                  className="flex-1 bg-secondary border border-border rounded-xl px-3 py-2 text-sm font-mono"
                />
                {!isNew && (
                  <button
                    type="button"
                    onClick={() => setModelListOpen(true)}
                    title="엔드포인트에서 모델 목록 조회"
                    aria-label="모델 목록 조회"
                    className="px-3 py-2 rounded-xl text-xs bg-secondary border border-border hover:bg-muted"
                  >
                    {modelsLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '목록 조회'}
                  </button>
                )}
              </div>
            </label>
            {modelListOpen && (models ?? []).length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {(models ?? []).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setForm({ ...form, model: m })}
                    className={`px-2 py-0.5 text-xs rounded-full border ${form.model === m ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
            {modelListOpen && !modelsLoading && (models ?? []).length === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">모델 목록을 가져올 수 없습니다 (엔드포인트 오프라인?)</p>
            )}
          </div>

          <div className="col-span-2">
            <p className="text-xs text-muted-foreground mb-1">API 키</p>
            <div className="flex gap-2 items-center">
              <select
                value={keyRefKind}
                onChange={(e) => {
                  const kind = e.target.value;
                  setForm({
                    ...form,
                    apiKeyRef: kind === 'none' ? ''
                      : kind === 'env' ? 'env:LLM_API_KEY'
                        : `credential:${credentials[0] ?? ''}`,
                  });
                }}
                aria-label="API 키 참조 방식"
                className="bg-secondary border border-border rounded-xl px-2 py-2 text-sm"
              >
                <option value="none">사용 안 함</option>
                <option value="credential">저장된 자격증명</option>
                <option value="env">환경변수</option>
              </select>
              {keyRefKind === 'credential' && (
                <select
                  value={form.apiKeyRef.slice('credential:'.length)}
                  onChange={(e) => setForm({ ...form, apiKeyRef: `credential:${e.target.value}` })}
                  aria-label="자격증명 선택"
                  className="flex-1 bg-secondary border border-border rounded-xl px-2 py-2 text-sm"
                >
                  {credentials.length === 0 && <option value="">— 먼저 API 키를 등록하세요 —</option>}
                  {credentials.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
              {keyRefKind === 'env' && (
                <input
                  value={form.apiKeyRef.slice('env:'.length)}
                  onChange={(e) => setForm({ ...form, apiKeyRef: `env:${e.target.value}` })}
                  aria-label="환경변수 이름"
                  placeholder="LLM_API_KEY"
                  className="flex-1 bg-secondary border border-border rounded-xl px-3 py-2 text-sm font-mono"
                />
              )}
            </div>
          </div>

          <label className="block text-xs text-muted-foreground">
            타임아웃 (초)
            <input
              type="number" min={5} max={600}
              value={form.timeoutSeconds}
              onChange={(e) => setForm({ ...form, timeoutSeconds: Number(e.target.value) || 120 })}
              className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            최대 동시 호출
            <input
              type="number" min={1} max={32}
              value={form.maxConcurrency}
              onChange={(e) => setForm({ ...form, maxConcurrency: Number(e.target.value) || 1 })}
              className="mt-1 w-full bg-secondary border border-border rounded-xl px-3 py-2 text-sm"
            />
          </label>

          <label className="col-span-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="rounded"
            />
            프로필 활성화
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-xl text-sm text-muted-foreground hover:bg-secondary"
          >
            취소
          </button>
          <button
            type="button"
            onClick={() => onSave(form)}
            className="px-3 py-1.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:opacity-90"
          >
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
