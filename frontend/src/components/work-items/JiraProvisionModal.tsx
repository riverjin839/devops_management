import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Loader2, Rocket, CheckCircle2, AlertTriangle, ExternalLink, FileText, RotateCcw, KeyRound,
  ListChecks, FolderTree, Search,
} from 'lucide-react';
import {
  useProvisionDefaults, useProvision, useJiraIssueLookup, useConfluencePageInfo, useConfluenceChildren,
} from '@/hooks/useJira';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useToast } from '@/components/common';
import { JiraConnectCard } from '@/components/settings/JiraConnectCard';
import { formatApiError } from '@/lib/utils';
import type { ConfluenceChildPage, JiraIssueLookupItem, ProvisionResult, WorkItem } from '@/types';

const ISSUE_TYPES = ['Epic', 'Task', 'Sub-task'] as const;
type IssueTypeOption = (typeof ISSUE_TYPES)[number];

/** Epic/상위 이슈 "목록에서 선택" 인라인 피커 — 버튼을 누르면 조회하고, 결과에서 골라
 * 바로 입력칸을 채운다(수동 입력을 대체하지 않고 보조). 프로젝트 이슈가 많으면 스크롤로
 * 찾기 번거로워 키/요약 텍스트로 좁히는 필터 입력을 맨 위에 둔다(로컬 필터 — 별도 조회
 * 없이 이미 받아온 목록만 좁힌다). `open` 이 꺼지면 언마운트되므로 다시 열 때마다
 * 필터가 자연히 비워진다.  */
function IssueLookupPicker({
  open, loading, status, detail, items, onPick,
}: {
  open: boolean;
  loading: boolean;
  status?: 'ok' | 'offline' | 'error';
  detail?: string;
  items: JiraIssueLookupItem[];
  onPick: (key: string) => void;
}) {
  const [filterText, setFilterText] = useState('');
  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.key.toLowerCase().includes(q) || it.summary.toLowerCase().includes(q));
  }, [items, filterText]);

  if (!open) return null;
  return (
    <div className="mt-1 border border-border rounded-lg bg-card max-h-48 overflow-y-auto mac-shadow">
      {!loading && (status === undefined || status === 'ok') && items.length > 0 && (
        <div className="sticky top-0 bg-card border-b border-border p-1.5">
          <div className="relative">
            <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              autoFocus
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="키 또는 제목으로 필터"
              aria-label="이슈 목록 필터"
              className="w-full pl-6 pr-2 py-1 text-xs bg-secondary border border-border rounded focus:outline-none focus:border-primary/50"
            />
          </div>
        </div>
      )}
      {loading && (
        <div className="p-2 text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> 불러오는 중…
        </div>
      )}
      {!loading && status && status !== 'ok' && (
        <div className="p-2 text-xs text-status-critical">{detail || '조회 실패'}</div>
      )}
      {!loading && status === 'ok' && items.length === 0 && (
        <div className="p-2 text-xs text-muted-foreground">해당 프로젝트에 이슈가 없습니다.</div>
      )}
      {!loading && status === 'ok' && items.length > 0 && filtered.length === 0 && (
        <div className="p-2 text-xs text-muted-foreground">필터에 맞는 이슈가 없습니다.</div>
      )}
      {!loading && filtered.map((it) => (
        <button key={it.key} type="button" onClick={() => onPick(it.key)}
          className="w-full text-left px-2 py-1.5 text-xs hover:bg-secondary flex items-center gap-1.5">
          <span className="font-medium text-primary flex-shrink-0">{it.key}</span>
          <span className="text-muted-foreground truncate">{it.summary}</span>
        </button>
      ))}
    </div>
  );
}

/** 상위 페이지 ID 아래 "하위 페이지 가져오기" 피커 — 고른 페이지를 새 상위로 선택하면
 * 그 페이지 밑에 문서가 생성된다(IssueLookupPicker 와 동일한 결).  */
function ChildPagePicker({
  open, loading, status, detail, items, onPick,
}: {
  open: boolean;
  loading: boolean;
  status?: 'ok' | 'offline' | 'error';
  detail?: string;
  items: ConfluenceChildPage[];
  onPick: (page: ConfluenceChildPage) => void;
}) {
  if (!open) return null;
  return (
    <div className="mt-1 border border-border rounded-lg bg-card max-h-36 overflow-y-auto mac-shadow">
      {loading && (
        <div className="p-2 text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" /> 불러오는 중…
        </div>
      )}
      {!loading && status && status !== 'ok' && (
        <div className="p-2 text-xs text-status-critical">{detail || '조회 실패'}</div>
      )}
      {!loading && status === 'ok' && items.length === 0 && (
        <div className="p-2 text-xs text-muted-foreground">하위 페이지가 없습니다.</div>
      )}
      {!loading && items.map((p) => (
        <button key={p.id} type="button" onClick={() => onPick(p)}
          className="w-full text-left px-2 py-1.5 text-xs hover:bg-secondary flex items-center gap-1.5">
          <span className="font-mono text-muted-foreground/70 flex-shrink-0">{p.id}</span>
          <span className="text-foreground truncate">{p.title || '(제목 없음)'}</span>
        </button>
      ))}
    </div>
  );
}

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
  const epicLookup = useJiraIssueLookup();
  const parentLookup = useJiraIssueLookup();
  const pageInfoLookup = useConfluencePageInfo();
  const childLookup = useConfluenceChildren();

  const [createJira, setCreateJira] = useState(true);
  const [createConfluence, setCreateConfluence] = useState(true);
  const [projectKey, setProjectKey] = useState('');
  const [issueType, setIssueType] = useState<IssueTypeOption>('Task');
  const [priority, setPriority] = useState('');
  const [labels, setLabels] = useState('');
  const [components, setComponents] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [epicKey, setEpicKey] = useState('');
  const [parentKey, setParentKey] = useState('');
  const [epicName, setEpicName] = useState('');
  // 담당자 — 기본은 로그인 사용자 자신(defaults.assigneeUsername), 화면에서 다른 PEP
  // 사용자로 바꿀 수 있다(defaults.assignableUsers 중에서만 — 계정 매핑 불안정 방지).
  const [assigneeUsername, setAssigneeUsername] = useState('');
  const [showEpicPicker, setShowEpicPicker] = useState(false);
  const [showParentPicker, setShowParentPicker] = useState(false);
  const [spaceKey, setSpaceKey] = useState('');
  const [pageId, setPageId] = useState('');
  const [parentPageId, setParentPageId] = useState('');
  // 상위 페이지 ID 입력 후 조회된 제목 — mouseover(title 속성) 툴팁 + 인라인 확인용.
  const [parentPageTitle, setParentPageTitle] = useState('');
  const [showChildPicker, setShowChildPicker] = useState(false);
  const [pageTitle, setPageTitle] = useState('');
  const [confluenceLabels, setConfluenceLabels] = useState('');
  const [contributor, setContributor] = useState('');
  const [rememberPreset, setRememberPreset] = useState(true);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  // 상위 페이지 ID 입력이 멈춘 뒤(디바운스) 제목을 조회 — mouseover 시 title 속성으로
  // 보여줄 값을 준비한다. ID 를 지우면 즉시 초기화.
  useEffect(() => {
    const id = parentPageId.trim();
    if (!id) { setParentPageTitle(''); return; }
    const t = window.setTimeout(() => {
      pageInfoLookup.mutate(id, {
        onSuccess: (res) => setParentPageTitle(res.data.status === 'ok' ? res.data.title : ''),
        onError: () => setParentPageTitle(''),
      });
    }, 500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentPageId]);

  // 모달이 열려 있는 동안 배경에서 defaults 가 다시 조회되면(포커스 복귀·재연결 등 —
  // useProvisionDefaults 의 staleTime 10초가 지나면 트리거될 수 있음) useQuery 가 새
  // 객체를 반환한다. 이 effect 가 [defaults, item] 만 보고 무조건 재실행되면 그때마다
  // 폼 전체가 서버 기본값으로 덮어써져, 사용자가 이미 골라 넣은 Epic 키/상위 이슈를
  // 포함한 모든 입력이 흔적도 없이 사라지는 버그가 있었다("입력이 안 되는 것"처럼
  // 보였던 원인). 이번에 모달이 열린 뒤 이 업무 1건에 대해 **한 번만** 초기화하도록
  // ref 로 막는다 — 모달을 닫았다 다시 열거나 다른 업무로 바뀌면 다시 초기화된다.
  const initializedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open) initializedForRef.current = null;
  }, [open]);

  useEffect(() => {
    if (!defaults || !item) return;
    if (initializedForRef.current === item.id) return;
    initializedForRef.current = item.id;
    setCreateJira(defaults.jiraEnabled && !item?.jiraIssueKey);
    setCreateConfluence(defaults.confluenceEnabled && !item?.confluenceUrl);
    setProjectKey(defaults.projectKey);
    setIssueType((ISSUE_TYPES as readonly string[]).includes(defaults.issueType)
      ? (defaults.issueType as IssueTypeOption) : 'Task');
    setPriority(defaults.priority);
    setLabels(defaults.labels.join(', '));
    setComponents(defaults.components.join(', '));
    setSummary(defaults.summary);
    setDescription(defaults.description);
    setEpicKey(defaults.epicKey ?? '');
    setParentKey(defaults.parentKey ?? '');
    setEpicName(defaults.epicName || defaults.summary);
    setAssigneeUsername(defaults.assigneeUsername ?? '');
    setShowEpicPicker(false);
    setShowParentPicker(false);
    setSpaceKey(defaults.spaceKey);
    setPageId('');
    setParentPageId(defaults.parentPageId);
    setParentPageTitle('');
    setShowChildPicker(false);
    setPageTitle(defaults.pageTitle);
    setConfluenceLabels('');
    setContributor(defaults.contributor ?? '');
    setRememberPreset(true);
    setResult(null);
  }, [defaults, item]);

  if (!open || !item) return null;

  const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const busy = provision.isPending;
  const projectKeyMissing = createJira && !item.jiraIssueKey && !projectKey.trim();

  const openEpicPicker = () => {
    setShowEpicPicker((v) => !v);
    if (!showEpicPicker) epicLookup.mutate({ projectKey: projectKey.trim(), issueType: 'Epic' });
  };
  const openParentPicker = () => {
    setShowParentPicker((v) => !v);
    if (!showParentPicker) parentLookup.mutate({ projectKey: projectKey.trim(), issueType: 'Task' });
  };
  // 상위 페이지 ID 아래 하위 페이지 "가져오기" — 고른 페이지를 새 상위 페이지 ID 로 교체.
  const openChildPicker = () => {
    setShowChildPicker((v) => !v);
    if (!showChildPicker) childLookup.mutate(parentPageId.trim());
  };
  const pickChildPage = (page: ConfluenceChildPage) => {
    setParentPageId(page.id);
    setParentPageTitle(page.title);
    setShowChildPicker(false);
  };

  const submit = async () => {
    if (!createJira && !createConfluence) {
      toast.error('선택 필요', 'Jira 또는 Confluence 중 하나 이상 선택하세요.');
      return;
    }
    if (projectKeyMissing) {
      toast.error('입력 필요', '프로젝트 키는 필수 입력입니다.');
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
        epicKey: issueType === 'Task' ? (epicKey.trim() || undefined) : undefined,
        parentKey: issueType === 'Sub-task' ? (parentKey.trim() || undefined) : undefined,
        epicName: issueType === 'Epic' ? (epicName.trim() || summary.trim() || undefined) : undefined,
        assigneeUsername: assigneeUsername || undefined,
        spaceKey: spaceKey.trim() || undefined,
        pageId: pageId.trim() || undefined,
        parentPageId: parentPageId.trim() || undefined,
        pageTitle: pageTitle.trim() || undefined,
        confluenceLabels: csv(confluenceLabels),
        contributor: contributor.trim() || undefined,
        rememberPreset,
      });
      setResult(data);
      // 성공한 쪽은 체크 해제 — "다시 시도"를 누르면 이 submit() 을 그대로 재사용해도
      // 남은 쪽만 다시 보낸다(서버도 이미 연결된 쪽은 멱등하게 건너뛰지만, 화면에서부터
      // 필요한 것만 보여주는 편이 명확하다).
      if (data.jiraKey) setCreateJira(false);
      if (data.confluenceUrl) setCreateConfluence(false);
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

          {!result && item.provisionStatus === 'partial' && (
            <div className="text-xs px-3 py-2 rounded-lg bg-status-warning/10 text-status-warning flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>
                지난 시도에서 일부만 생성됐습니다.
                {item.provisionJiraError && <> Jira: {item.provisionJiraError}</>}
                {item.provisionConfluenceError && <> Confluence: {item.provisionConfluenceError}</>}
              </span>
            </div>
          )}

          {defaults?.detail && !result && (
            <div className={`text-xs px-3 py-2 rounded-lg ${
              defaults.jiraEnabled || defaults.confluenceEnabled
                ? 'bg-secondary text-muted-foreground' : 'bg-status-warning/10 text-status-warning'
            }`}>
              {defaults.detail}
              {defaults.presetSource === 'user' && (
                <span className="ml-2">· 지난번에 쓴 조건을 불러왔습니다 (수정 가능)</span>
              )}
              {defaults.reporter && <span className="ml-2">· 보고자: {defaults.reporter}</span>}
            </div>
          )}

          {result ? (
            <>
              <div className={`rounded-xl border p-4 space-y-2 ${
                result.status === 'ok' ? 'border-status-healthy/30 bg-status-healthy/5'
                  : result.status === 'partial' ? 'border-status-warning/30 bg-status-warning/5'
                  : 'border-status-critical/30 bg-status-critical/5'
              }`}>
                <div className={`flex items-center gap-2 font-medium ${
                  result.status === 'ok' ? 'text-status-healthy'
                    : result.status === 'partial' ? 'text-status-warning' : 'text-status-critical'
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
              {result.status !== 'ok' && (
                <div className="rounded-xl border border-status-warning/30 bg-status-warning/5 p-3.5 space-y-3">
                  <div className="text-sm font-medium text-status-warning">
                    다시 시도하시겠어요? {(result.jiraAuthIssue || result.confluenceAuthIssue)
                      && '— 연결 설정을 먼저 고치면 재시도가 성공할 확률이 높습니다.'}
                  </div>
                  {(result.jiraAuthIssue || result.confluenceAuthIssue) && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
                        <KeyRound className="w-3.5 h-3.5" />
                        {result.jiraAuthIssue && result.confluenceAuthIssue
                          ? 'Jira · Confluence 인증(토큰/세션) 문제로 보입니다 — 아래에서 바로 고칠 수 있습니다.'
                          : result.jiraAuthIssue
                            ? 'Jira 인증(토큰/세션) 문제로 보입니다 — 아래에서 바로 고칠 수 있습니다.'
                            : 'Confluence 인증(세션) 문제로 보입니다 — 같은 세션 쿠키를 다시 등록하면 Confluence 도 함께 갱신됩니다.'}
                      </p>
                      <JiraConnectCard compact />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void submit()} disabled={busy}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50">
                      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                      다시 시도 {result.jiraKey ? '(Confluence만)' : result.confluenceUrl ? '(Jira만)' : ''}
                    </button>
                    <button type="button" onClick={() => setResult(null)} disabled={busy}
                      className="px-3 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80 disabled:opacity-50">
                      설정 수정
                    </button>
                    <button type="button" onClick={onClose} disabled={busy}
                      className="ml-auto px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
                      나중에
                    </button>
                  </div>
                </div>
              )}
              {result.status === 'ok' && (
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
              )}
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
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">
                        프로젝트 키 <span className="text-status-critical">*</span>
                      </span>
                      <input
                        className={`${inputCls} ${projectKeyMissing ? 'border-status-critical/60' : ''}`}
                        placeholder="PROJ" value={projectKey}
                        onChange={(e) => setProjectKey(e.target.value)} />
                      {projectKeyMissing && (
                        <span className="text-[11px] text-status-critical mt-0.5 block">필수 입력입니다.</span>
                      )}
                    </div>
                    <div>
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">이슈 종류</span>
                      <div className="inline-flex rounded-xl border border-border overflow-hidden w-full">
                        {ISSUE_TYPES.map((t) => (
                          <button key={t} type="button" onClick={() => setIssueType(t)}
                            className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
                              issueType === t
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-secondary text-muted-foreground hover:text-foreground'
                            }`}>
                            {t}
                          </button>
                        ))}
                      </div>
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
                    <div>
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">담당자</span>
                      {defaults && defaults.assignableUsers.length > 0 ? (
                        <select className={inputCls} value={assigneeUsername}
                          onChange={(e) => setAssigneeUsername(e.target.value)}>
                          <option value="">지정 안 함</option>
                          {defaults.assignableUsers.map((u) => (
                            <option key={u.username} value={u.username}>
                              {u.displayName}{u.isSelf ? ' (나)' : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-[11px] text-muted-foreground py-2">
                          선택 가능한 담당자가 없습니다 — 설정 &gt; 연동에서 Jira 계정을 먼저 연동하세요.
                        </p>
                      )}
                    </div>
                    {/* Jira 계층 — 이슈 종류에 따라 필요한 상위 연결만 보여준다.
                        Epic 은 상위가 없고, Task 는 Epic 링크, Sub-task 는 상위 이슈가 필요하다. */}
                    {issueType === 'Epic' && (
                      <div className="col-span-2">
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">Epic 이름</span>
                        <input className={inputCls} placeholder={summary || '에픽 이름'} value={epicName}
                          title="Jira 의 'Epic Name' 필드 — Epic 보드에 표시되는 짧은 이름(제목과 별개). 비우면 제목(summary)으로 채웁니다."
                          onChange={(e) => setEpicName(e.target.value)} />
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          Epic 은 상위 연결이 필요 없습니다 (Epic 키 / 상위 이슈 입력 불필요). 관리자가
                          Epic Name 필드를 설정하지 않았으면 이 값은 전송되지 않습니다.
                        </p>
                      </div>
                    )}
                    {issueType === 'Task' && (
                      <div className="col-span-2 relative">
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">Epic 키 (선택)</span>
                        <div className="flex items-center gap-1.5">
                          <input className={inputCls} placeholder="DL-7" value={epicKey}
                            title="이 이슈를 묶을 상위 Epic. 직접 입력하거나 목록에서 선택하세요."
                            onChange={(e) => setEpicKey(e.target.value)} />
                          <button type="button" onClick={openEpicPicker} disabled={!projectKey.trim()}
                            title="프로젝트의 Epic 목록에서 선택" aria-label="Epic 목록에서 선택"
                            className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-2 rounded-lg border border-border bg-secondary text-xs hover:bg-secondary/80 disabled:opacity-40">
                            <ListChecks className="w-3.5 h-3.5" /> 목록
                          </button>
                        </div>
                        <IssueLookupPicker
                          open={showEpicPicker} loading={epicLookup.isPending}
                          status={epicLookup.data?.data.status} detail={epicLookup.data?.data.detail}
                          items={epicLookup.data?.data.items ?? []}
                          onPick={(key) => { setEpicKey(key); setShowEpicPicker(false); }}
                        />
                      </div>
                    )}
                    {issueType === 'Sub-task' && (
                      <div className="col-span-2 relative">
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">상위 이슈</span>
                        <div className="flex items-center gap-1.5">
                          <input className={inputCls} placeholder="DL-10" value={parentKey}
                            title="Sub-task 의 상위 이슈. 직접 입력하거나 목록에서 선택하세요."
                            onChange={(e) => setParentKey(e.target.value)} />
                          <button type="button" onClick={openParentPicker} disabled={!projectKey.trim()}
                            title="프로젝트의 상위 이슈 목록에서 선택" aria-label="상위 이슈 목록에서 선택"
                            className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-2 rounded-lg border border-border bg-secondary text-xs hover:bg-secondary/80 disabled:opacity-40">
                            <ListChecks className="w-3.5 h-3.5" /> 목록
                          </button>
                        </div>
                        <IssueLookupPicker
                          open={showParentPicker} loading={parentLookup.isPending}
                          status={parentLookup.data?.data.status} detail={parentLookup.data?.data.detail}
                          items={parentLookup.data?.data.items ?? []}
                          onPick={(key) => { setParentKey(key); setShowParentPicker(false); }}
                        />
                      </div>
                    )}
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
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">문서 ID (선택)</span>
                        <input className={inputCls} placeholder="기존 문서를 직접 지정" value={pageId}
                          title="지정하면 제목 검색 없이 이 문서를 그대로 갱신합니다."
                          onChange={(e) => setPageId(e.target.value)} />
                      </div>
                      <div className="col-span-2 relative">
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">상위 페이지 ID (선택)</span>
                        <div className="flex items-center gap-1.5">
                          <input className={inputCls} value={parentPageId}
                            title={parentPageTitle ? `제목: ${parentPageTitle}` : undefined}
                            placeholder="예: 123456"
                            onChange={(e) => setParentPageId(e.target.value)} />
                          <button type="button" onClick={openChildPicker} disabled={!parentPageId.trim()}
                            title="이 페이지의 하위 페이지 목록에서 선택" aria-label="하위 페이지 목록에서 선택"
                            className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-2 rounded-lg border border-border bg-secondary text-xs hover:bg-secondary/80 disabled:opacity-40">
                            <FolderTree className="w-3.5 h-3.5" /> 가져오기
                          </button>
                        </div>
                        {pageInfoLookup.isPending ? (
                          <p className="text-[11px] text-muted-foreground mt-0.5 inline-flex items-center gap-1">
                            <Loader2 className="w-3 h-3 animate-spin" /> 제목 확인 중…
                          </p>
                        ) : parentPageTitle && (
                          <p className="text-[11px] text-muted-foreground mt-0.5 truncate" title={parentPageTitle}>
                            → {parentPageTitle}
                          </p>
                        )}
                        <ChildPagePicker
                          open={showChildPicker} loading={childLookup.isPending}
                          status={childLookup.data?.data.status} detail={childLookup.data?.data.detail}
                          items={childLookup.data?.data.items ?? []}
                          onPick={pickChildPage}
                        />
                      </div>
                      <div>
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">라벨 (쉼표)</span>
                        <input className={inputCls} value={confluenceLabels}
                          onChange={(e) => setConfluenceLabels(e.target.value)} />
                      </div>
                      <div>
                        <span className="text-xs font-medium text-muted-foreground mb-1 block">Contributor</span>
                        <input className={inputCls} value={contributor}
                          title="문서 기여자 표시명 — 기본은 나 자신이며 수정할 수 있습니다."
                          onChange={(e) => setContributor(e.target.value)} />
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

              {/* 기준 조건 재사용 — 매 등록마다 프로젝트/컴포넌트/라벨/Epic/스페이스를
                  다시 입력하지 않도록 마지막에 쓴 값을 내 기본값으로 기억한다. */}
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" className="rounded border-border" checked={rememberPreset}
                  onChange={(e) => setRememberPreset(e.target.checked)} />
                <span>이 조건을 내 기본값으로 기억</span>
                <span className="text-xs text-muted-foreground">
                  (프로젝트 · 종류 · 라벨 · 컴포넌트 · Epic · 저장 위치)
                </span>
              </label>

              <div className="flex items-center gap-2 pt-1">
                <button type="button" onClick={() => void submit()} disabled={busy || projectKeyMissing}
                  title={projectKeyMissing ? '프로젝트 키를 입력하세요.' : undefined}
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
