import { useEffect, useState } from 'react';
import { Save, Play, Loader2, RotateCcw, Trash2, Pencil } from 'lucide-react';
import type { ScriptTestRunResponse } from '@/types';
import { ConfirmDialog, useToast } from '@/components/common';
import { CommandTraceList } from '@/components/common/CommandTraceList';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import { formatApiError } from '@/lib/utils';
import {
  useScript, useScriptVersions, useCreateScriptVersion, useSetCurrentScriptVersion,
  useUpdateScript, useDeleteScript, useTestRunScript,
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
  onDeleted: () => void;
}

export function ScriptDetailPanel({ scriptId, onDeleted }: Props) {
  const toast = useToast();
  const { data: script, isLoading } = useScript(scriptId);
  const { data: versions } = useScriptVersions(scriptId);
  const createVersion = useCreateScriptVersion(scriptId);
  const setCurrentVersion = useSetCurrentScriptVersion(scriptId);
  const updateScript = useUpdateScript(scriptId);
  const deleteScript = useDeleteScript();
  const testRun = useTestRunScript(scriptId);

  const [tab, setTab] = useState<Tab>('edit');
  const [draft, setDraft] = useState('');
  const [changelog, setChangelog] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');

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
  const [runError, setRunError] = useState<string | null>(null);

  if (isLoading || !script) {
    return <div className="p-4 text-xs text-muted-foreground">불러오는 중…</div>;
  }

  const dirty = draft !== (script.currentVersion?.content ?? '');

  const handleSaveVersion = async () => {
    try {
      await createVersion.mutateAsync({ content: draft, changelog: changelog.trim() || undefined });
      toast.success('새 버전을 저장했습니다.');
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const handleRollback = async (versionId: string) => {
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
        description: descDraft.trim() || undefined,
        tags: tagsDraft.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setEditingMeta(false);
      toast.success('스크립트 정보를 수정했습니다.');
    } catch (e) {
      toast.error('수정 실패', formatApiError(e));
    }
  };

  const handleDelete = async () => {
    try {
      await deleteScript.mutateAsync(script.id);
      toast.success('스크립트를 삭제했습니다.');
      setDeleteConfirm(false);
      onDeleted();
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
      setDeleteConfirm(false);
    }
  };

  const handleTestRun = async () => {
    setRunError(null);
    setRunResult(null);
    if (target.host.trim() === '' && script.kind !== 'ansible_playbook') {
      toast.error('대상 호스트를 입력해주세요.');
      return;
    }
    try {
      const result = await testRun.mutateAsync({
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
      });
      setRunResult(result);
    } catch (e) {
      setRunError(formatApiError(e));
    }
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
                className="text-sm font-semibold px-2 py-1 rounded-lg border border-border bg-card w-full"
              />
            ) : (
              <h2 className="text-sm font-semibold truncate">{script.name}</h2>
            )}
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <ScriptKindBadge kind={script.kind} />
              {script.isSystem && (
                <span className="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground">시스템 제공</span>
              )}
              {script.currentVersion && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">v{script.currentVersion.version}</span>
              )}
              {(script.tags ?? []).map((t) => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">{t}</span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {editingMeta ? (
              <>
                <button onClick={saveMeta} className="px-2 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90">저장</button>
                <button onClick={() => setEditingMeta(false)} className="px-2 py-1 text-xs border border-border rounded-lg hover:bg-secondary">취소</button>
              </>
            ) : (
              <button onClick={startEditMeta} title="이름/설명/태그 수정" aria-label="이름/설명/태그 수정" className="p-1.5 rounded-lg hover:bg-secondary">
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {!script.isSystem && (
              <button onClick={() => setDeleteConfirm(true)} title="삭제" aria-label="삭제" className="p-1.5 rounded-lg hover:bg-secondary text-status-critical">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        {editingMeta && (
          <div className="mt-2 space-y-1.5">
            <input
              value={descDraft} onChange={(e) => setDescDraft(e.target.value)} placeholder="설명"
              className="w-full px-2 py-1 text-xs rounded-lg border border-border bg-card"
            />
            <input
              value={tagsDraft} onChange={(e) => setTagsDraft(e.target.value)} placeholder="태그 (콤마 구분)"
              className="w-full px-2 py-1 text-xs rounded-lg border border-border bg-card"
            />
          </div>
        )}
        {!editingMeta && script.description && (
          <p className="mt-1.5 text-xs text-muted-foreground">{script.description}</p>
        )}
      </div>

      <div className="flex-shrink-0 flex items-center gap-1 px-4 pt-2 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 transition-colors ${
              tab === t.value ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {tab === 'edit' && (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={18}
              spellCheck={false}
              className="w-full px-3 py-2 text-xs font-mono rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
            <div className="flex items-center gap-2">
              <input
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                placeholder="변경 메모 (선택 — 예: 타임아웃 값 조정)"
                className="flex-1 px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={handleSaveVersion}
                disabled={!dirty || createVersion.isPending}
                title={dirty ? '새 버전으로 저장' : '변경사항이 없습니다'}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
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
                  <p className="text-[10px] text-muted-foreground">{v.createdBy ?? '-'} · {new Date(v.createdAt).toLocaleString('ko-KR')}</p>
                </div>
                {v.id === script.currentVersionId ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary flex-shrink-0">현재</span>
                ) : (
                  <button
                    onClick={() => handleRollback(v.id)}
                    disabled={setCurrentVersion.isPending}
                    title="이 버전으로 롤백"
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg border border-border hover:bg-secondary flex-shrink-0 disabled:opacity-50"
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
            {script.kind === 'python' && (
              <div className="px-3 py-2 rounded-xl border border-status-warning/40 bg-status-warning-soft text-xs text-status-warning">
                Python 스크립트 테스트 실행은 아직 지원하지 않습니다 — 대상 클러스터의 일회용 K8s Job
                실행기가 Phase 2 에 구현될 예정입니다.
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
            <p className="text-[10px] text-muted-foreground">자격증명은 저장되지 않습니다 — 이번 테스트 실행 요청에만 사용됩니다.</p>
            <button
              onClick={handleTestRun}
              disabled={testRun.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
            >
              {testRun.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              테스트 실행 (현재 편집 중인 내용 기준)
            </button>

            {runError && (
              <div className="px-3 py-2 rounded-xl border border-status-critical/40 bg-status-critical-soft text-xs text-status-critical whitespace-pre-wrap">
                {runError}
              </div>
            )}
            {runResult && (
              <div className="space-y-3 pt-2 border-t border-border">
                <ExecutionStepsTimeline steps={runResult.steps} />
                <CommandTraceList commands={runResult.commands} />
              </div>
            )}
          </div>
        )}

        {tab === 'usage' && (
          <div className="text-xs text-muted-foreground">
            {script.usedByCount > 0
              ? `이 스크립트를 참조하는 Batch Job/점검 항목 ${script.usedByCount}건이 있습니다.`
              : '아직 이 스크립트를 참조하는 Batch Job/점검 항목이 없습니다 — Batch Job 연결은 Phase 2 에서 지원될 예정입니다.'}
          </div>
        )}
      </div>

      {deleteConfirm && (
        <ConfirmDialog
          open={deleteConfirm}
          title="스크립트 삭제"
          description={`"${script.name}" 스크립트를 삭제할까요? 모든 버전 이력이 함께 삭제되며 되돌릴 수 없습니다.`}
          danger
          confirmLabel="삭제"
          onConfirm={handleDelete}
          onCancel={() => setDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
