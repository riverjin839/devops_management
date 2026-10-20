import { useEffect, useId, useState } from 'react';
import { Save, Play, Loader2, RotateCcw, Trash2, Pencil, FileQuestion } from 'lucide-react';
import type { ExecutableScriptVersion, ScriptTestRunResponse, ScriptUsageRef } from '@/types';
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, RunLogPanel, useToast } from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { CommandTraceList } from '@/components/common/CommandTraceList';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import { formatApiError } from '@/lib/utils';
import {
  useScript, useScriptVersions, useCreateScriptVersion, useSetCurrentScriptVersion,
  useUpdateScript, useDeleteScript, useTestRunScript, useCanEditScripts,
} from '@/hooks/useScripts';
import { ScriptKindBadge } from './ScriptListPanel';

type Tab = 'edit' | 'versions' | 'test-run' | 'usage';
const TABS: { value: Tab; label: string }[] = [
  { value: 'edit', label: '편집' },
  { value: 'versions', label: '버전 이력' },
  { value: 'test-run', label: '테스트 실행' },
  { value: 'usage', label: '어디서 쓰이나' },
];

interface Props {
  scriptId: string;
  /** 삭제 성공 또는 "찾을 수 없음"에서 "목록으로" — 선택 해제. */
  onDeleted: () => void;
  /** 본문 편집본이 저장되지 않았는지 — 상위가 다른 스크립트로 옮기기 전에 확인한다(D-146). */
  onDirtyChange?: (dirty: boolean) => void;
}

/** Python 은 테스트 실행 미지원(서버 501) — 버튼 비활성 사유(D-146). */
const PYTHON_TEST_RUN_HINT = 'Python 스크립트 테스트 실행은 아직 지원하지 않습니다 (서버 미구현)';

export function ScriptDetailPanel({ scriptId, onDeleted, onDirtyChange }: Props) {
  const toast = useToast();
  const { data: script, isLoading, isError, error, refetch } = useScript(scriptId);
  // §12.9 — 저장·롤백·삭제·테스트 실행은 operator 이상(관리자 전용 설정 시 admin). 숨기지 않고 비활성+사유(D-145).
  const { canEdit, withHint, ariaWithHint } = useCanEditScripts();
  const { data: versions } = useScriptVersions(scriptId);
  const createVersion = useCreateScriptVersion(scriptId);
  const setCurrentVersion = useSetCurrentScriptVersion(scriptId);
  const updateScript = useUpdateScript(scriptId);
  const deleteScript = useDeleteScript();
  const testRun = useTestRunScript(scriptId);

  const [tab, setTab] = useState<Tab>('edit');
  const tabIdBase = useId();
  const [draft, setDraft] = useState('');
  const [changelog, setChangelog] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  // 저장·롤백 즉시 반영 경고(D-146) — "항상 최신" 참조 잡이 다음 실행부터 새 버전을 쓴다.
  const [saveConfirm, setSaveConfirm] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<ExecutableScriptVersion | null>(null);

  // 스크립트를 바꾸거나(선택 변경) 버전이 바뀌면(롤백) 편집 초안을 현재 버전 내용으로 리셋.
  useEffect(() => {
    if (script?.currentVersion) {
      setDraft(script.currentVersion.content);
      setChangelog('');
    }
  }, [scriptId, script?.currentVersionId, script?.currentVersion]);

  const [target, setTarget] = useState({
    host: '', port: 22, username: 'root', authMethod: 'password' as 'password' | 'privateKey', secret: '',
  });
  const [inventoryContent, setInventoryContent] = useState('');
  const [runResult, setRunResult] = useState<ScriptTestRunResponse | null>(null);
  // 테스트 실행 로그(D-089/D-135) — 요청·대기·단계별 결과·실패 사유. 펼침 여부는 사용자가 정한다.
  const runLog = useRunLog();
  const { clear: clearRunLog } = runLog;
  const [showLog, setShowLog] = useLogPref('scripts-test-run');
  // 다른 스크립트를 고르면 이전 스크립트의 실행 결과·로그를 들고 있지 않는다.
  useEffect(() => {
    setRunResult(null);
    clearRunLog();
  }, [scriptId, clearRunLog]);

  const dirty = !!script?.currentVersion && draft !== script.currentVersion.content;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // 로딩·실패·없음을 분리한다(D-138) — 예전엔 `isLoading || !script` 하나라 실패·삭제된 스크립트에서
  // "불러오는 중…" 이 끝나지 않았다.
  if (isLoading) return <LoadingState compact />;
  const errStatus = (error as { response?: { status?: number } } | null)?.response?.status;
  if ((isError && errStatus === 404) || (!isError && !script)) {
    return (
      <div className="h-full flex items-center justify-center">
        <EmptyState
          icon={FileQuestion}
          title="스크립트를 찾을 수 없습니다"
          description="다른 사용자가 삭제했거나 주소가 잘못됐을 수 있습니다."
          action={{ label: '목록으로', onClick: onDeleted, variant: 'secondary' }}
        />
      </div>
    );
  }
  if (isError || !script) {
    return (
      <div className="h-full flex items-center justify-center">
        <ErrorState error={error} title="스크립트를 불러오지 못했습니다" onRetry={() => void refetch()} />
      </div>
    );
  }

  // 참조 잡 — "항상 최신"(고정 안 함)만 저장·롤백의 영향을 받는다.
  const usedBy = script.usedBy ?? [];
  const latestRefs = usedBy.filter((u) => !u.pinned);
  const pinnedRefs = usedBy.filter((u) => u.pinned);
  const nextVersion = Math.max(0, ...(versions ?? []).map((v) => v.version), script.currentVersion?.version ?? 0) + 1;
  const isPython = script.kind === 'python';

  // 참조 잡이 있으면 먼저 확인(D-146) — "저장"은 초안 저장이 아니라 새 버전 배포다.
  const requestSaveVersion = () => {
    if (script.usedByCount > 0) setSaveConfirm(true);
    else void handleSaveVersion();
  };

  const handleSaveVersion = async () => {
    setSaveConfirm(false);
    try {
      await createVersion.mutateAsync({ content: draft, changelog: changelog.trim() || undefined });
      toast.success('새 버전 저장됨');
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const requestRollback = (v: ExecutableScriptVersion) => {
    if (script.usedByCount > 0) setRollbackTarget(v);
    else void handleRollback(v.id);
  };

  const handleRollback = async (versionId: string) => {
    setRollbackTarget(null);
    try {
      await setCurrentVersion.mutateAsync(versionId);
      toast.success('해당 버전으로 되돌렸습니다.');
      setTab('edit');
    } catch (e) {
      toast.error('롤백 실패', formatApiError(e));
    }
  };

  const startEditMeta = () => {
    setNameDraft(script.name);
    setDescDraft(script.description ?? '');
    setTagsDraft((script.tags ?? []).join(', '));
    setEditingMeta(true);
  };

  const saveMeta = async () => {
    try {
      await updateScript.mutateAsync({
        name: nameDraft.trim(),
        // 지운 설명은 null 로 보내 서버가 비우게 한다(D-144) — undefined 는 "변경 없음".
        description: descDraft.trim() || null,
        tags: tagsDraft.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setEditingMeta(false);
      toast.success('스크립트 정보 수정됨');
    } catch (e) {
      toast.error('수정 실패', formatApiError(e));
    }
  };

  const handleDelete = async () => {
    try {
      await deleteScript.mutateAsync(script.id);
      toast.success('스크립트 삭제됨');
      setDeleteConfirm(false);
      onDeleted();
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
      setDeleteConfirm(false);
    }
  };

  const handleTestRun = async () => {
    setRunResult(null);
    if (target.host.trim() === '' && script.kind !== 'ansible_playbook') {
      toast.error('대상 호스트를 입력해주세요.');
      return;
    }
    const where = target.host.trim()
      ? `${target.username}@${target.host.trim()}:${target.port}`
      : '인벤토리 대상';
    const r = await runLogged(runLog, {
      title: '스크립트 테스트 실행',
      first: `${script.name} (${script.kind}${dirty ? ', 저장 안 된 편집본' : ''}) → ${where} 실행 요청`,
      fn: () => testRun.mutateAsync({
        content: draft,
        inventoryContent: script.kind === 'ansible_playbook' ? (inventoryContent || undefined) : undefined,
        target: {
          kind: 'ssh',
          host: target.host || undefined,
          port: target.port,
          username: target.username,
          password: target.authMethod === 'password' ? target.secret : undefined,
          privateKey: target.authMethod === 'privateKey' ? target.secret : undefined,
        },
      }),
      summarize: (res): RunLogEntry[] => {
        const out: RunLogEntry[] = res.steps.map((st): RunLogEntry => [
          st.status === 'failed' ? 'error' : st.status === 'skipped' ? 'warn' : 'info',
          `단계 ${st.label} · ${st.status === 'success' ? '완료' : st.status === 'failed' ? '실패' : st.status === 'skipped' ? '건너뜀' : '진행 중'}`
            + `${st.durationMs != null ? ` · ${st.durationMs}ms` : ''}${st.detail ? ` — ${st.detail.slice(0, 200)}` : ''}`,
        ]);
        if (res.error) out.push(['error', `오류 — ${res.error}`]);
        else if (res.exitCode != null && res.exitCode !== 0) {
          const firstErr = (res.stderr || '').split('\n').map((l) => l.trim()).find(Boolean);
          out.push(['error', `exit ${res.exitCode}${firstErr ? ` — ${firstErr.slice(0, 200)}` : ''}`]);
        }
        out.push([res.status === 'success' || res.status === 'ok' ? 'info' : 'warn',
          `상태 ${res.status} · exit ${res.exitCode ?? '—'} · 명령 ${res.commands.length}개 · ${res.durationMs}ms`]);
        return out;
      },
    });
    if (r.ok) setRunResult(r.data);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-shrink-0 px-4 pt-3 pb-2 border-b border-border">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {editingMeta ? (
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                aria-label="스크립트 이름"
                placeholder="이름"
                className="text-sm font-semibold px-2 py-1 rounded-lg border border-border bg-card w-full"
              />
            ) : (
              <h2 className="text-sm font-semibold truncate">{script.name}</h2>
            )}
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <ScriptKindBadge kind={script.kind} />
              {script.isSystem && (
                <span className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground">시스템 제공</span>
              )}
              {script.currentVersion && (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">v{script.currentVersion.version}</span>
              )}
              {(script.tags ?? []).map((t) => (
                <span key={t} className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{t}</span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {editingMeta ? (
              <>
                <button
                  onClick={saveMeta}
                  disabled={!canEdit || updateScript.isPending || !nameDraft.trim()}
                  title={withHint(nameDraft.trim() ? '이름/설명/태그 저장' : '이름은 비울 수 없습니다')}
                  aria-label={ariaWithHint('저장')}
                  className="px-2 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  저장
                </button>
                <button onClick={() => setEditingMeta(false)} className="px-2 py-1 text-xs border border-border rounded-lg hover:bg-secondary">취소</button>
              </>
            ) : (
              <button
                onClick={startEditMeta}
                disabled={!canEdit}
                title={withHint('이름/설명/태그 수정')}
                aria-label={ariaWithHint('이름/설명/태그 수정')}
                className="p-1.5 rounded-lg hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {!script.isSystem && (
              <button
                onClick={() => setDeleteConfirm(true)}
                disabled={!canEdit}
                title={withHint(script.usedByCount > 0 ? `참조 배치잡 ${script.usedByCount}건이 있어 삭제가 거부됩니다` : '삭제')}
                aria-label={ariaWithHint('삭제')}
                className="p-1.5 rounded-lg hover:bg-secondary text-status-critical disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        {editingMeta && (
          <div className="mt-2 space-y-1.5">
            <input
              value={descDraft} onChange={(e) => setDescDraft(e.target.value)} placeholder="설명" aria-label="스크립트 설명"
              className="w-full px-2 py-1 text-xs rounded-lg border border-border bg-card"
            />
            <input
              value={tagsDraft} onChange={(e) => setTagsDraft(e.target.value)} placeholder="태그 (콤마 구분)" aria-label="스크립트 태그 (콤마 구분)"
              className="w-full px-2 py-1 text-xs rounded-lg border border-border bg-card"
            />
          </div>
        )}
        {!editingMeta && script.description && (
          <p className="mt-1.5 text-xs text-muted-foreground">{script.description}</p>
        )}
      </div>

      <div role="tablist" aria-label="스크립트 상세" className="flex-shrink-0 flex items-center gap-1 px-4 pt-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={`${tabIdBase}-tab-${t.value}`}
            aria-selected={tab === t.value}
            aria-controls={`${tabIdBase}-panel`}
            onClick={() => setTab(t.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 transition-colors ${
              tab === t.value ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={`${tabIdBase}-panel`}
        aria-labelledby={`${tabIdBase}-tab-${tab}`}
        className="flex-1 min-h-0 overflow-y-auto p-4"
      >
        {tab === 'edit' && (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="스크립트 본문"
              rows={18}
              spellCheck={false}
              className="w-full px-3 py-2 text-xs font-mono rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
            <div className="flex items-center gap-2">
              <input
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                aria-label="변경 메모"
                placeholder="변경 메모 (선택 — 예: 타임아웃 값 조정)"
                className="flex-1 px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={requestSaveVersion}
                disabled={!canEdit || !dirty || createVersion.isPending}
                title={withHint(dirty
                  ? (latestRefs.length > 0
                    ? `새 버전으로 저장 — 항상 최신 참조 배치잡 ${latestRefs.length}건이 다음 실행부터 이 버전을 씁니다`
                    : '새 버전으로 저장')
                  : '변경사항이 없습니다')}
                aria-label={ariaWithHint('저장 (새 버전)')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createVersion.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                저장 (새 버전)
              </button>
            </div>
            {script.kind === 'ansible_playbook' && (
              <div className="pt-2 border-t border-border">
                <label className="text-xs text-muted-foreground block mb-1 space-y-1">
                  <span className="block">인벤토리 (선택 — 비워두면 테스트 실행 시 대상 호스트 1개로 자동 생성)</span>
                  <textarea
                    value={inventoryContent}
                    onChange={(e) => setInventoryContent(e.target.value)}
                    rows={4}
                    spellCheck={false}
                    placeholder={'[all]\n10.0.0.5'}
                    className="w-full px-2.5 py-1.5 text-xs font-mono rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                </label>
              </div>
            )}
          </div>
        )}

        {tab === 'versions' && (
          <div className="space-y-1.5">
            {(versions ?? []).map((v) => (
              <div key={v.id} className={`flex items-center gap-2 px-2.5 py-2 rounded-xl border ${v.id === script.currentVersionId ? 'border-primary bg-primary/5' : 'border-border'}`}>
                <span className="text-xs font-mono font-medium flex-shrink-0">v{v.version}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs truncate">{v.changelog || '(메모 없음)'}</p>
                  <p className="text-[11px] text-muted-foreground">{v.createdBy ?? '—'} · {new Date(v.createdAt).toLocaleString('ko-KR')}</p>
                </div>
                {v.id === script.currentVersionId ? (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-primary/15 text-primary flex-shrink-0">현재</span>
                ) : (
                  <button
                    onClick={() => requestRollback(v)}
                    disabled={!canEdit || setCurrentVersion.isPending}
                    title={withHint('이 버전으로 롤백')}
                    aria-label={ariaWithHint(`v${v.version} 으로 롤백`)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg border border-border hover:bg-secondary flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <RotateCcw className="w-3 h-3" /> 롤백
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === 'test-run' && (
          <div className="space-y-3">
            {isPython && (
              <div className="px-3 py-2 rounded-xl border border-status-warning/40 bg-status-warning-soft text-xs text-status-warning">
                Python 스크립트는 화면에서 테스트 실행을 아직 지원하지 않습니다(서버 미구현) — 실행 버튼이 비활성입니다.
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs space-y-1">
                <span className="text-muted-foreground">대상 호스트</span>
                <input
                  value={target.host} onChange={(e) => setTarget((t) => ({ ...t, host: e.target.value }))}
                  placeholder="10.0.0.5"
                  className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="text-xs space-y-1">
                <span className="text-muted-foreground">포트</span>
                <input
                  type="number" value={target.port}
                  onChange={(e) => setTarget((t) => ({ ...t, port: Number(e.target.value) || 22 }))}
                  className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="text-xs space-y-1">
                <span className="text-muted-foreground">사용자</span>
                <input
                  value={target.username} onChange={(e) => setTarget((t) => ({ ...t, username: e.target.value }))}
                  className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </label>
              <label className="text-xs space-y-1">
                <span className="text-muted-foreground">인증 방식</span>
                <select
                  value={target.authMethod}
                  onChange={(e) => setTarget((t) => ({ ...t, authMethod: e.target.value as 'password' | 'privateKey' }))}
                  className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="password">비밀번호</option>
                  <option value="privateKey">개인키</option>
                </select>
              </label>
              <label className="text-xs space-y-1 col-span-2">
                <span className="text-muted-foreground">{target.authMethod === 'password' ? '비밀번호' : '개인키 (PEM)'}</span>
                {target.authMethod === 'password' ? (
                  <input
                    type="password" value={target.secret} onChange={(e) => setTarget((t) => ({ ...t, secret: e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                ) : (
                  <textarea
                    value={target.secret} onChange={(e) => setTarget((t) => ({ ...t, secret: e.target.value }))}
                    rows={3} spellCheck={false}
                    className="w-full px-2.5 py-1.5 text-xs font-mono rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                )}
              </label>
            </div>
            <p className="text-[11px] text-muted-foreground">자격증명은 저장되지 않습니다 — 이번 테스트 실행 요청에만 사용됩니다.</p>
            <button
              onClick={handleTestRun}
              disabled={!canEdit || isPython || testRun.isPending}
              title={withHint(isPython ? PYTHON_TEST_RUN_HINT : '현재 편집 중인 내용으로 테스트 실행')}
              aria-label={ariaWithHint(isPython ? `테스트 실행 — ${PYTHON_TEST_RUN_HINT}` : '테스트 실행')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testRun.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              테스트 실행 (현재 편집 중인 내용 기준)
            </button>

            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
            {runResult && (
              <div className="space-y-3 pt-2 border-t border-border">
                <ExecutionStepsTimeline steps={runResult.steps} />
                <CommandTraceList commands={runResult.commands} />
              </div>
            )}
          </div>
        )}

        {tab === 'usage' && (
          script.usedByCount === 0 ? (
            <EmptyState
              compact
              title="참조하는 배치잡이 없습니다"
              description="배치잡의 실행 방식을 '스크립트'로 고르면 이 스크립트를 연결할 수 있습니다."
            />
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                배치잡 {script.usedByCount}건이 참조합니다. "항상 최신" 참조는 저장·롤백하면 다음 실행부터 바뀐 버전을 씁니다.
              </p>
              {usedBy.length > 0 && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-border">
                      <th className="py-1.5 pr-2 font-medium">배치잡</th>
                      <th className="py-1.5 pr-2 font-medium">클러스터</th>
                      <th className="py-1.5 pr-2 font-medium">참조 버전</th>
                      <th className="py-1.5 pr-2 font-medium">스케줄</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usedBy.map((u) => (
                      <tr key={u.jobId} className="border-b border-border/50">
                        <td className="py-1.5 pr-2 font-medium">
                          {u.name}
                          {!u.enabled && <span className="ml-1 text-muted-foreground">(사용 안 함)</span>}
                        </td>
                        <td className="py-1.5 pr-2 text-muted-foreground">{u.clusterName ?? u.clusterId}</td>
                        <td className="py-1.5 pr-2">
                          {u.pinned
                            ? <span className="text-muted-foreground">v{u.pinnedVersion ?? '?'} 고정</span>
                            : <span className="font-medium text-status-warning">항상 최신</span>}
                        </td>
                        <td className="py-1.5 pr-2 font-mono text-muted-foreground">{u.cron || '수동 실행'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )
        )}
      </div>

      <ConfirmDialog
        open={saveConfirm}
        title="새 버전 저장 — 배치잡에 바로 반영됩니다"
        description={latestRefs.length > 0
          ? `이 스크립트를 항상 최신으로 참조하는 배치잡 ${latestRefs.length}건이 다음 실행부터 v${nextVersion} 을 씁니다. 예약(cron) 잡은 다음 주기에 이 코드를 실서버에서 실행합니다.`
          : `참조 배치잡 ${script.usedByCount}건은 모두 특정 버전에 고정돼 있어 v${nextVersion} 저장의 영향을 받지 않습니다.`}
        confirmLabel={`v${nextVersion} 저장`}
        danger={latestRefs.length > 0}
        busy={createVersion.isPending}
        onConfirm={() => void handleSaveVersion()}
        onCancel={() => setSaveConfirm(false)}
      >
        <UsageRefList latest={latestRefs} pinned={pinnedRefs} />
      </ConfirmDialog>

      <ConfirmDialog
        open={!!rollbackTarget}
        title={`v${rollbackTarget?.version ?? ''} 으로 롤백 — 배치잡에 바로 반영됩니다`}
        description={latestRefs.length > 0
          ? `이 스크립트를 항상 최신으로 참조하는 배치잡 ${latestRefs.length}건이 다음 실행부터 v${rollbackTarget?.version ?? ''} 을 씁니다.`
          : `참조 배치잡 ${script.usedByCount}건은 모두 특정 버전에 고정돼 있어 롤백의 영향을 받지 않습니다.`}
        confirmLabel="롤백"
        danger={latestRefs.length > 0}
        busy={setCurrentVersion.isPending}
        onConfirm={() => { if (rollbackTarget) void handleRollback(rollbackTarget.id); }}
        onCancel={() => setRollbackTarget(null)}
      >
        <UsageRefList latest={latestRefs} pinned={pinnedRefs} />
      </ConfirmDialog>

      {deleteConfirm && (
        <ConfirmDialog
          open={deleteConfirm}
          title="스크립트 삭제"
          description={`"${script.name}" 스크립트를 삭제할까요? 모든 버전 이력이 함께 삭제되며 되돌릴 수 없습니다.`}
          danger
          confirmLabel="삭제"
          busy={deleteScript.isPending}
          onConfirm={handleDelete}
          onCancel={() => setDeleteConfirm(false)}
        />
      )}
    </div>
  );
}

/** 저장·롤백 확인 다이얼로그의 참조 잡 목록 — 영향받는(항상 최신) 잡을 먼저, 고정 잡은 뒤에. */
function UsageRefList({ latest, pinned }: { latest: ScriptUsageRef[]; pinned: ScriptUsageRef[] }) {
  if (latest.length === 0 && pinned.length === 0) return null;
  return (
    <div className="space-y-1.5 text-sm max-h-48 overflow-y-auto">
      {latest.length > 0 && (
        <div>
          <p className="font-semibold">영향받는 잡 (항상 최신)</p>
          <ul className="list-disc pl-5">
            {latest.map((u) => (
              <li key={u.jobId}>
                {u.name} <span className="text-muted-foreground">· {u.clusterName ?? u.clusterId}{u.cron ? ` · ${u.cron}` : ' · 수동'}{u.enabled ? '' : ' · 사용 안 함'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {pinned.length > 0 && (
        <div>
          <p className="text-muted-foreground">영향 없음 (버전 고정)</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {pinned.map((u) => (
              <li key={u.jobId}>{u.name} · v{u.pinnedVersion ?? '?'}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
