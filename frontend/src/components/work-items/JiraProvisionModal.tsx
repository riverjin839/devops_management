import { useEffect, useState } from 'react';
import {
  X, Loader2, Rocket, CheckCircle2, AlertTriangle, ExternalLink, FileText,
} from 'lucide-react';
import { useProvisionDefaults, useProvision } from '@/hooks/useJira';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import type { ProvisionResult, WorkItem } from '@/types';

interface JiraProvisionModalProps {
  open: boolean;
  onClose: () => void;
  item: WorkItem | null;
}

const inputCls =
  'w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm text-foreground ' +
  'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50';

/**
 * 업무를 Jira 이슈 + Confluence 문서로 **함께 생성**하는 모달.
 *
 * 저장 위치·이슈 종류 같은 조건은 서버가 사용자/설정 기준으로 **기본값을 채워** 내려주고,
 * 화면에서 모두 수정할 수 있다(강제하지 않음). 한쪽만 만들 수도 있다.
 */
export function JiraProvisionModal({ open, onClose, item }: JiraProvisionModalProps) {
  const dialogRef = useModalA11y(open, onClose);
  const toast = useToast();
  const { data: defaults, isLoading } = useProvisionDefaults(item?.id, open && !!item);
  const provision = useProvision();

  const [createJira, setCreateJira] = useState(true);
  const [createConfluence, setCreateConfluence] = useState(true);
  const [projectKey, setProjectKey] = useState('');
  const [issueType, setIssueType] = useState('Task');
  const [priority, setPriority] = useState('');
  const [labels, setLabels] = useState('');
  const [components, setComponents] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [spaceKey, setSpaceKey] = useState('');
  const [parentPageId, setParentPageId] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [result, setResult] = useState<ProvisionResult | null>(null);

  // 서버가 준 기본값으로 폼을 채운다 — 이후 사용자가 자유롭게 수정.
  useEffect(() => {
    if (!defaults) return;
    setCreateJira(defaults.jiraEnabled);
    setCreateConfluence(defaults.confluenceEnabled);
    setProjectKey(defaults.projectKey);
    setIssueType(defaults.issueType || 'Task');
    setPriority(defaults.priority);
    setLabels(defaults.labels.join(', '));
    setComponents(defaults.components.join(', '));
    setSummary(defaults.summary);
    setDescription(defaults.description);
    setSpaceKey(defaults.spaceKey);
    setParentPageId(defaults.parentPageId);
    setPageTitle(defaults.pageTitle);
    setResult(null);
  }, [defaults]);

  if (!open || !item) return null;

  const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const busy = provision.isPending;

  const submit = async () => {
    if (!createJira && !createConfluence) {
      toast.error('선택 필요', 'Jira 또는 Confluence 중 하나 이상 선택하세요.');
      return;
    }
    try {
      const { data } = await provision.mutateAsync({
        workItemId: item.id,
        createJira, createConfluence,
        projectKey: projectKey.trim() || undefined,
        issueType, priority: priority.trim() || undefined,
        labels: csv(labels), components: csv(components),
        summary: summary.trim() || undefined,
        description: description || undefined,
        spaceKey: spaceKey.trim() || undefined,
        parentPageId: parentPageId.trim() || undefined,
        pageTitle: pageTitle.trim() || undefined,
      });
      setResult(data);
      if (data.status === 'ok') toast.success('생성 완료', data.detail);
      else if (data.status === 'partial') toast.error('일부만 생성됨', data.detail);
      else toast.error('생성 실패', data.detail);
    } catch (err) {
      toast.error('요청 실패', formatApiError(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="jira-provision-title"
        className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-2xl mx-4 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <Rocket className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="jira-provision-title" className="text-base font-semibold leading-tight">
              Jira · Confluence 자동 생성
            </h2>
            <p className="text-xs text-muted-foreground truncate">
              {item.title || item.content} — 기본값은 설정·업무 내용에서 채워졌고, 모두 수정할 수 있습니다.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3.5">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> 기본값 불러오는 중…
            </div>
          )}

          {defaults?.detail && !result && (
            <div className={`text-xs px-3 py-2 rounded-lg ${
              defaults.jiraEnabled || defaults.confluenceEnabled
                ? 'bg-secondary text-muted-foreground' : 'bg-amber-500/10 text-amber-500'
            }`}>
              {defaults.detail}
              {defaults.reporter && <span className="ml-2">· 보고자: {defaults.reporter}</span>}
            </div>
          )}

          {result ? (
            <>
              <div className={`rounded-xl border p-4 space-y-2 ${
                result.status === 'ok' ? 'border-emerald-500/30 bg-emerald-500/5'
                  : result.status === 'partial' ? 'border-amber-500/30 bg-amber-500/5'
                  : 'border-red-500/30 bg-red-500/5'
              }`}>
                <div className={`flex items-center gap-2 font-medium ${
                  result.status === 'ok' ? 'text-emerald-500'
                    : result.status === 'partial' ? 'text-amber-500' : 'text-red-500'
                }`}>
                  {result.status === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                  {result.detail}
                </div>
                <div className="text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-20">Jira</span>
                    {result.jiraKey ? (
                      <a href={result.jiraUrl ?? undefined} target="_blank" rel="noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1">
                        {result.jiraKey} <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : <span className="text-muted-foreground">{result.jiraDetail || '생성 안 함'}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-20">Confluence</span>
                    {result.confluenceUrl ? (
                      <a href={result.confluenceUrl} target="_blank" rel="noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1">
                        문서 열기 <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : <span className="text-muted-foreground">{result.confluenceDetail || '생성 안 함'}</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setResult(null)}
                  className="px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80">
                  다시 설정
                </button>
                <button type="button" onClick={onClose}
                  className="ml-auto px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90">
                  닫기
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Jira */}
              <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="rounded border-border" checked={createJira}
                    onChange={(e) => setCreateJira(e.target.checked)} />
                  Jira 이슈 생성
                  {item.jiraIssueKey && (
                    <span className="text-xs text-muted-foreground">(이미 {item.jiraIssueKey} 연결됨 — 건너뜁니다)</span>
                  )}
                </label>
                {createJira && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">프로젝트 키</span>
                      <input className={inputCls} placeholder="PROJ" value={projectKey}
                        onChange={(e) => setProjectKey(e.target.value)} />
                    </div>
                    <div>
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">이슈 종류</span>
                      <input className={inputCls} placeholder="Task" value={issueType}
                        onChange={(e) => setIssueType(e.target.value)} />
                    </div>
                    <div>
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">우선순위</span>
                      <input className={inputCls} placeholder="Medium" value={priority}
                        onChange={(e) => setPriority(e.target.value)} />
                    </div>
                    <div>
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">컴포넌트 (쉼표)</span>
                      <input className={inputCls} value={components}
                        onChange={(e) => setComponents(e.target.value)} />
                    </div>
                    <div>
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">라벨 (쉼표)</span>
                      <input className={inputCls} value={labels} onChange={(e) => setLabels(e.target.value)} />
                    </div>
                    <div>
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">제목(summary)</span>
                      <input className={inputCls} value={summary} onChange={(e) => setSummary(e.target.value)} />
                    </div>
                    <div className="col-span-2">
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">설명</span>
                      <textarea className={`${inputCls} min-h-[64px] resize-y`} value={description}
                        onChange={(e) => setDescription(e.target.value)} />
                    </div>
                  </div>
                )}
              </div>

              {/* Confluence */}
              <div className="rounded-xl border border-border bg-secondary/30 p-3 space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="rounded border-border" checked={createConfluence}
                    onChange={(e) => setCreateConfluence(e.target.checked)} />
                  Confluence 문서 생성
                </label>
                {createConfluence && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">스페이스 키</span>
                        <input className={inputCls} placeholder="TEAM" value={spaceKey}
                          onChange={(e) => setSpaceKey(e.target.value)} />
                      </div>
                      <div>
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">상위 페이지 ID (선택)</span>
                        <input className={inputCls} value={parentPageId}
                          onChange={(e) => setParentPageId(e.target.value)} />
                      </div>
                      <div className="col-span-2">
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">문서 제목</span>
                        <input className={inputCls} value={pageTitle}
                          onChange={(e) => setPageTitle(e.target.value)} />
                      </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                      <FileText className="w-3 h-3" />
                      담당자·일정·Jira 링크가 들어간 기본 문서로 생성됩니다(같은 제목이 있으면 갱신).
                    </p>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button type="button" onClick={() => void submit()} disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
                  생성
                </button>
                <button type="button" onClick={onClose} disabled={busy}
                  className="ml-auto px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground">
                  나중에
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
