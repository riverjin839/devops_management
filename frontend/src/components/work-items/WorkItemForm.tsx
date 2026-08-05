import { useEffect, useId, useMemo, useState } from 'react';
import { Plus, Settings2, ChevronDown } from 'lucide-react';
import { WorkItem, WorkItemCreate, WorkItemUpdate, WorkItemType, KanbanStatus, WorkItemModule, WorkItemTypeLabel } from '@/types';
import { loadWorkItemImages, saveWorkItemImages } from '@/lib/workItemImages';
import { RichTextEditor, assigneeWorkTableTemplate } from '@/components/editor';
import { DateTimePicker } from '@/components/ui/DateTimePicker';
import { useAssignees } from '@/hooks/useAssignees';
import { ConfluenceUrlInput, useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { useCreateWorkItem, useUpdateWorkItem } from '@/hooks/useWorkItems';
import { useWorkItemCustomFields, sortedWorkItemFields } from '@/hooks/useWorkItemCustomFields';
import { useWorkItems } from '@/hooks/useWorkItems';
import { useAuthStore } from '@/stores/authStore';

const DEFAULT_TASK_CATEGORIES = [
  'Cluster 점검',
  'Node 관리',
  'Pod 배포',
  'Network 설정',
  'Storage 관리',
  'RBAC / 보안',
  'Monitoring 설정',
  'Backup / Restore',
  '업그레이드',
  '장애 대응',
  '이슈 대응',
  '문서 작업',
  '회의참석',
  '교육 / 학습',
  '코드 리뷰',
  '기획 / 검토',
];
const TASK_CATEGORIES = [...DEFAULT_TASK_CATEGORIES, '기타'];
const CATEGORY_STORAGE_KEY = 'k8s:item:categories';

function loadCustomCategories(): string[] {
  try {
    const raw = localStorage.getItem(CATEGORY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveCustomCategories(cats: string[]) {
  localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(cats));
}

/** 콤마구분 담당자 문자열 ↔ 배열. 담당자(부) 복수 선택 저장 호환용. */
function parseAssignees(s?: string | null): string[] {
  return s ? s.split(',').map((t) => t.trim()).filter(Boolean) : [];
}

/** 신규 등록 기본값 — 현재 날짜(YYYY-MM-DD, 시간 미포함). DateTimePicker 는 'T' 가 없으면
 *  "시간 포함" 토글이 기본 꺼진 상태로 열려 날짜만 입력하는 흐름을 기본값으로 삼는다. */
function nowDateOnly(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 폼 값(YYYY-MM-DD 또는 YYYY-MM-DDTHH:mm)을 백엔드 datetime 으로 보정.
 *
 * 앱 canonical 규약 = **UTC 저장 + KST 표시**. 폼 입력은 로컬(KST) 벽시계이므로
 * 로컬로 해석한 뒤 `toISOString()`(UTC Z)으로 직렬화한다 (QuickAddTaskModal 과 동일 규약).
 * 이전에는 naive 로컬 문자열을 그대로 저장해, 리더가 UTC 로 간주하며 +9h 시프트되던 버그가 있었다.
 * - 날짜만이면 자정(T00:00:00)으로 채운다.
 * - 초가 없으면 :00 을 붙인다.
 * - 파싱 불가면 null.
 */
function toApiDatetime(v?: string | null): string | null {
  if (!v) return null;
  let s = v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00`;
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s = `${s}:00`;
  const d = new Date(s); // 브라우저 로컬(KST) 해석
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toDatetimeLocal(dateStr?: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface WorkItemFormProps {
  /** undefined → 신규 등록, WorkItem → 수정 */
  initial?: WorkItem;
  /** 신규 등록 시 기본 type. 수정 시에는 initial.type 이 우선. */
  defaultType?: WorkItemType;
  /** 하위 업무 등록 시 상위 업무 — 카테고리/담당자 자동 채움. */
  parentItem?: WorkItem | null;
  /** 신규 등록 시 초기 날짜·시간 (YYYY-MM-DDTHH:mm). URL 파라미터나 달력 날짜 클릭에서 전달. */
  defaultStartedAt?: string;
  onCancel: () => void;
  /** 저장 완료 후 콜백. id 는 신규 등록 시 발급된 새 id, created 는 신규 등록일 때만
   *  서버가 반환한 전체 WorkItem(수정 시에는 undefined) — 자동 생성 모달 등에 필요. */
  onSaved: (savedId?: string, created?: WorkItem) => void;
  /** 컴팩트한 인라인 모드 (SidePane 내부) — 외부 컨테이너가 이미 패딩을 갖춘 환경에서 form 만 렌더. */
  embedded?: boolean;
}

export function WorkItemForm({ initial, parentItem, defaultStartedAt, onCancel, onSaved, embedded = false }: WorkItemFormProps) {
  const isEdit = !!initial;
  // 업무/이슈 구분 폐지 — 신규는 항상 'task'. 기존 항목 수정 시에는 원래 type 유지(레거시 이슈 호환).
  // '이슈 대응' 은 분류(category)로 대체한다.
  const [type, setType] = useState<WorkItemType>(initial?.type ?? 'task');
  const [detailContent, setDetailContent] = useState(initial?.detailContent ?? '');

  useClusters();
  const { clusters } = useClusterStore();
  const { data: registeredAssignees = [] } = useAssignees();
  // 신규 등록 시 담당자(정) 기본값 = 현재 로그인 사용자 (변경 가능)
  const currentUser = useAuthStore((s) => s.user);
  const defaultAssignee = (currentUser?.displayName?.trim() || currentUser?.username || '').trim();
  const createTask = useCreateWorkItem();
  const updateTask = useUpdateWorkItem();
  const toast = useToast();

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // 프로젝트/스프린트 배정은 등록 폼에서 뺐다(효율화) — 기존 값은 수정 시 유지되도록
  // state 는 남겨두되 선택 UI 는 제공하지 않는다.
  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const [sprintId, setSprintId] = useState(initial?.sprintId ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [primaryList, setPrimaryList] = useState<string[]>(
    !initial && !parentItem && defaultAssignee ? [defaultAssignee] : [],
  );
  const [secondaryList, setSecondaryList] = useState<string[]>([]);
  const [clusterIds, setClusterIds] = useState<string[]>([]);
  const [category, setTaskCategory] = useState('');
  const [taskCategoryCustom, setTaskCategoryCustom] = useState('');
  const [content, setTaskContent] = useState('');
  const [resolution, setResultContent] = useState('');
  const [startedAt, setScheduledAt] = useState(defaultStartedAt ?? nowDateOnly());
  const [closedAt, setCompletedAt] = useState('');
  const [priority, setPriority] = useState('medium');
  const [remarks, setRemarks] = useState('');
  const [confluenceUrl, setConfluenceUrl] = useState('');
  const [jiraUrl, setJiraUrl] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [customCategories, setCustomCategories] = useState<string[]>(loadCustomCategories);
  const [showCatManage, setShowCatManage] = useState(false);
  const [newCatInput, setNewCatInput] = useState('');
  const [kanbanStatus, setKanbanStatus] = useState<KanbanStatus>('in_progress');
  const [module, setModule] = useState<WorkItemModule | ''>('');
  const [typeLabel, setTypeLabel] = useState<WorkItemTypeLabel | ''>('');
  const [effortHours, setEffortHours] = useState('');
  const [doneCondition, setDoneCondition] = useState('');
  const [relatedWorkItemId, setIssueId] = useState('');
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(initial?.customValues ?? {});
  const [allAttendees, setAllAttendees] = useState<boolean>(initial?.allAttendees ?? false);
  const { data: cfRaw } = useWorkItemCustomFields();
  const customFields = sortedWorkItemFields(cfRaw);
  const setCustomVal = (key: string, val: unknown) =>
    setCustomValues((p) => ({ ...p, [key]: val }));
  const [hydrated, setHydrated] = useState(!isEdit && !parentItem);

  const { data: issueData } = useWorkItems();
  const items = issueData?.data ?? [];

  // 업무 내용 에디터 "실무 템플릿" 메뉴에 노출할 동적 템플릿 — Settings 등록 담당자로 만든
  // "파트 데일리 회의록" 분담표(담당자 열 자동 입력).
  const worktableTemplates = useMemo(
    () => [assigneeWorkTableTemplate(registeredAssignees.map((a) => a.name))],
    [registeredAssignees],
  );

  // 백링크([[ ]]) — 에디터에서 다른 업무로 내부 링크. 이미 로드된 items 로 검색.
  const linkSearch = (q: string) => {
    const ql = q.trim().toLowerCase();
    return items
      .filter((t) => t.id !== initial?.id)
      .map((t) => ({
        id: t.id,
        label: (t.title?.trim() || t.content.replace(/<[^>]*>/g, '').trim() || t.category).slice(0, 50),
        href: `/tasks-mgmt/${t.id}`,
      }))
      .filter((o) => !ql || o.label.toLowerCase().includes(ql))
      .slice(0, 8);
  };

  useEffect(() => {
    if (hydrated) return;
    const allKnownCategories = [...TASK_CATEGORIES, ...loadCustomCategories()];
    if (isEdit && initial) {
      setProjectId(initial.projectId ?? '');
      setSprintId(initial.sprintId ?? '');
      setTitle(initial.title ?? '');
      setType(initial.type);
      setPrimaryList(parseAssignees(initial.primaryAssignee ?? initial.assignee));
      setSecondaryList(parseAssignees(initial.secondaryAssignee));
      setClusterIds(
        initial.clusterIds && initial.clusterIds.length
          ? initial.clusterIds
          : (initial.clusterId ? [initial.clusterId] : []),
      );
      const predefined = allKnownCategories.includes(initial.category);
      setTaskCategory(predefined ? initial.category : '기타');
      setTaskCategoryCustom(predefined ? '' : initial.category);
      setTaskContent(initial.content);
      setResultContent(initial.resolution ?? '');
      setDetailContent(initial.detailContent ?? '');
      setScheduledAt(toDatetimeLocal(initial.startedAt));
      setCompletedAt(toDatetimeLocal(initial.closedAt));
      setPriority(initial.priority);
      setRemarks(initial.remarks ?? '');
      setConfluenceUrl(initial.confluenceUrl ?? '');
      setJiraUrl(initial.jiraUrl ?? '');
      setImages(loadWorkItemImages(initial.id));
      setKanbanStatus(initial.kanbanStatus ?? 'todo');
      setModule((initial.module ?? '') as WorkItemModule | '');
      setTypeLabel((initial.typeLabel ?? '') as WorkItemTypeLabel | '');
      setEffortHours(initial.effortHours ? String(initial.effortHours) : '');
      setDoneCondition(initial.doneCondition ?? '');
      setIssueId(initial.relatedWorkItemId ?? '');
      setCustomValues(initial.customValues ?? {});
      setAllAttendees(initial.allAttendees ?? false);
      setHydrated(true);
    } else if (parentItem) {
      setPrimaryList(parseAssignees(parentItem.primaryAssignee ?? parentItem.assignee));
      setSecondaryList(parseAssignees(parentItem.secondaryAssignee));
      setTaskCategory(parentItem.category);
      setHydrated(true);
    }
  }, [isEdit, initial, parentItem, hydrated]);

  const addCustomCategory = () => {
    const cat = newCatInput.trim();
    if (!cat || TASK_CATEGORIES.includes(cat) || customCategories.includes(cat)) return;
    const updated = [...customCategories, cat];
    setCustomCategories(updated);
    saveCustomCategories(updated);
    setNewCatInput('');
    setTaskCategory(cat);
  };

  const deleteCustomCategory = (cat: string) => {
    const updated = customCategories.filter((c) => c !== cat);
    setCustomCategories(updated);
    saveCustomCategories(updated);
    if (category === cat) setTaskCategory('');
  };

  const handleImagePaste = (dataUrl: string) => {
    setImages((prev) => [...prev, dataUrl]);
  };


  const allCategories = [...DEFAULT_TASK_CATEGORIES, ...customCategories, '기타'];
  const resolvedCategory = category === '기타' ? taskCategoryCustom.trim() : category;
  const primaryCluster = clusters.find((c) => c.id === clusterIds[0]);
  const addCluster = (id: string) => setClusterIds((prev) => (id && !prev.includes(id) ? [...prev, id] : prev));
  const removeCluster = (id: string) => setClusterIds((prev) => prev.filter((x) => x !== id));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // 담당자(정) = 로그인 사용자 자동 맵핑(primaryList). 담당자(부)는 수정 시 보존.
    const primaryFinal = primaryList;
    const secondaryFinal = secondaryList;

    const payload: WorkItemCreate = {
      type,
      assignee: primaryFinal[0],
      primaryAssignee: primaryFinal.join(', '),
      secondaryAssignee: secondaryFinal.length ? secondaryFinal.join(', ') : undefined,
      clusterId: clusterIds[0] || undefined,
      clusterName: primaryCluster?.name,
      clusterIds: clusterIds.length ? clusterIds : undefined,
      projectId: projectId || undefined,
      sprintId: sprintId || null,
      title: title.trim() || undefined,
      category: resolvedCategory,
      content,
      resolution: resolution || undefined,
      detailContent: type === 'issue' ? (detailContent || undefined) : undefined,
      startedAt: toApiDatetime(startedAt) as string,
      closedAt: toApiDatetime(closedAt),
      priority,
      remarks: remarks.trim() || undefined,
      confluenceUrl: confluenceUrl.trim() || undefined,
      jiraUrl: jiraUrl.trim() || undefined,
      kanbanStatus,
      module: module || undefined,
      typeLabel: typeLabel || undefined,
      effortHours: effortHours ? parseInt(effortHours, 10) : undefined,
      doneCondition: doneCondition.trim() || undefined,
      parentId: parentItem?.id,
      relatedWorkItemId: relatedWorkItemId || undefined,
      customValues: customFields.length ? customValues : undefined,
      allAttendees,
    };

    try {
      let savedId: string | undefined;
      let created: WorkItem | undefined;
      if (isEdit && initial) {
        await updateTask.mutateAsync({ id: initial.id, data: payload as WorkItemUpdate });
        saveWorkItemImages(initial.id, images);
        savedId = initial.id;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await createTask.mutateAsync(payload);
        created = res?.data ?? res;
        savedId = created?.id;
        if (images.length > 0 && savedId) saveWorkItemImages(savedId, images);
      }
      onSaved(savedId, created);
    } catch (err) {
      // 저장 실패(검증 422·권한 등)를 조용히 삼키지 않고 사유를 노출.
      toast.error(isEdit ? '수정 실패' : '등록 실패', formatApiError(err, '저장 중 오류가 발생했습니다.'));
    }
  };

  const inputClass =
    'w-full px-2 py-1 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-primary';
  const labelClass = 'block text-xs font-medium text-muted-foreground mb-0.5';
  const submitting = createTask.isPending || updateTask.isPending;

  const formInner = (
    <form id="item-form" onSubmit={handleSubmit} className="space-y-2.5">
      {/* 업무/이슈 구분 폐지 — type 선택 토글 제거. '이슈 대응' 은 분류(category)로 선택한다. */}
      {/* ── 기본 설정 — 한 줄 그리드. 우선순위/보드상태/프로젝트/스프린트는 등록 폼에서 제외
           (우선순위·보드상태는 목록/칸반에서 바로 편집 가능). ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10 gap-x-2 gap-y-2">
        {/* 업무 분류 — 옵션 */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor={f('category')} className="text-xs font-medium text-muted-foreground">업무 분류</label>
            <button
              type="button"
              onClick={() => setShowCatManage((v) => !v)}
              className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="분류 관리"
            >
              <Settings2 className="w-2.5 h-2.5" />
              관리
            </button>
          </div>
          {category === '기타' ? (
            <div className="flex gap-1">
              <select
                id={f('category')}
                value={category}
                onChange={(e) => setTaskCategory(e.target.value)}
                className={`${inputClass} w-20 flex-shrink-0`}
              >
                <option value="">—</option>
                {allCategories.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <input
                type="text"
                value={taskCategoryCustom}
                onChange={(e) => setTaskCategoryCustom(e.target.value)}
                placeholder="직접 입력"
                className={`${inputClass} flex-1 min-w-0`}
              />
            </div>
          ) : (
            <select
              id={f('category')}
              value={category}
              onChange={(e) => setTaskCategory(e.target.value)}
              className={inputClass}
            >
              <option value="">— 선택 안 함 —</option>
              {allCategories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          )}
        </div>
        {/* 대상 클러스터 — 옵션 */}
        <div>
          <label htmlFor={f('cluster')} className={labelClass}>대상 클러스터</label>
          {clusterIds.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-1">
              {clusterIds.map((id) => {
                const c = clusters.find((x) => x.id === id);
                return (
                  <span key={id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-xs border border-primary/20">
                    {c?.name ?? id}
                    <button type="button" onClick={() => removeCluster(id)} className="hover:text-rose-500 leading-none" aria-label={`${c?.name ?? id} 제거`}>×</button>
                  </span>
                );
              })}
            </div>
          )}
          <select
            id={f('cluster')}
            value=""
            onChange={(e) => { addCluster(e.target.value); e.currentTarget.selectedIndex = 0; }}
            className={inputClass}
          >
            <option value="">{clusterIds.length ? '+ 클러스터 추가' : '— 선택 안 함 —'}</option>
            {clusters.filter((c) => !clusterIds.includes(c.id)).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        {/* 업무 시작일 — 등록 시점 자동, 수정 가능 */}
        <div>
          <label htmlFor={f('startedAt')} className={labelClass}>업무 시작일</label>
          <DateTimePicker
            id={f('startedAt')}
            value={startedAt}
            onChange={setScheduledAt}
            placeholder="시작일 선택"
            size="sm"
            clearable={false}
          />
        </div>
        {/* 업무 완료일 — 옵션 */}
        <div>
          <label htmlFor={f('closedAt')} className={labelClass}>업무 완료일</label>
          <DateTimePicker
            id={f('closedAt')}
            value={closedAt}
            onChange={setCompletedAt}
            placeholder="완료 시 입력"
            size="sm"
          />
        </div>
        {/* 공통업무 — 옵션. 특정 개인 담당자 업무가 아니라 파트 전체가 함께 하는 업무(회의 등).
            개인 담당자와 별개로 홈 "담당자별 진행 현황" 의 "공통" 카드/요약 행에도 노출된다.
            "전체 참석" 이라는 문구는 마치 전원이 반드시 참석해야 하는 것처럼 읽혀 의미가
            좁게 오해될 수 있어 "공통업무" 로 표기 — 실제 의미(특정 담당자 개인 업무가 아닌
            파트 공통 업무)에 더 가깝다. 필드명(allAttendees)/데이터는 그대로 유지, 표시 문구만 변경. */}
        {/* 설명은 툴팁으로 — 한 줄 그리드에서 긴 문구가 두 칸을 잡아먹어 다른 필드가
            밀려나던 문제를 없앤다(의미는 title 로 그대로 남는다). */}
        <div className="flex items-end">
          <label
            className="flex items-center gap-2 text-sm cursor-pointer select-none h-7"
            title="파트 회의 등 특정 담당자 개인 업무가 아닌 공통 업무 — 홈 '담당자별 진행 현황' 의 '공통' 요약에도 노출됩니다."
          >
            <input
              type="checkbox"
              checked={allAttendees}
              onChange={(e) => setAllAttendees(e.target.checked)}
              className="accent-primary"
            />
            <span className="font-medium whitespace-nowrap">👥 공통업무</span>
          </label>
        </div>
        {/* Confluence 링크 — 옵션 */}
        <div className="md:col-span-2">
          <ConfluenceUrlInput
            id={f('confluenceUrl')}
            value={confluenceUrl}
            onChange={setConfluenceUrl}
            inline
            showHint={false}
          />
        </div>
        {/* Jira 링크 — 옵션. 가져오기/프로비저닝으로 **연결된** 업무는 이 URL 만 고쳐도
            실제 연결(jira_issue_key/id)이 바뀌지 않아 아무 일도 일어나지 않는다.
            그래서 연결된 경우엔 읽기 전용으로 두고 연결 관리(게시판 행의 🔗 버튼)로 보낸다. */}
        <div className="md:col-span-2">
          {initial?.jiraIssueKey ? (
            <>
              <span className={labelClass}>Jira 링크</span>
              <div className={`${inputClass} flex items-center gap-1.5 bg-secondary/50 text-muted-foreground`}>
                <span className="font-mono text-xs text-brand-jira dark:text-blue-300">{initial.jiraIssueKey}</span>
                <span className="truncate">{jiraUrl || '—'}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                연결된 업무입니다 — 연결 해제/변경은 게시판 행의 <b>Jira 연결 관리</b>에서 하세요.
              </p>
            </>
          ) : (
            <ConfluenceUrlInput
              id={f('jiraUrl')}
              label="Jira 링크"
              value={jiraUrl}
              onChange={setJiraUrl}
              inline
              showHint={false}
              placeholder="https://jira.example.com/browse/..."
            />
          )}
        </div>
      </div>

      {/* 분류 관리 패널 — 토글 */}
      {showCatManage && (
        <div className="p-2.5 bg-muted/20 border border-border rounded-lg space-y-2">
          {customCategories.length > 0 && (
            <div className="flex items-center flex-wrap gap-1.5">
              <span className="text-xs text-muted-foreground font-medium mr-1">사용자 분류:</span>
              {customCategories.map((cat) => (
                <span key={cat} className="inline-flex items-center gap-0.5 text-xs bg-card border border-border rounded px-1.5 py-0.5">
                  {cat}
                  <button
                    type="button"
                    onClick={() => deleteCustomCategory(cat)}
                    className="text-muted-foreground hover:text-red-400 transition-colors"
                    title="삭제"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-1.5">
            <input
              type="text"
              value={newCatInput}
              onChange={(e) => setNewCatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addCustomCategory();
                }
              }}
              placeholder="새 분류명"
              className="flex-1 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="button"
              onClick={addCustomCategory}
              className="flex items-center gap-0.5 px-2 py-1 text-sm bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded transition-colors"
            >
              <Plus className="w-3 h-3" />
              추가
            </button>
          </div>
        </div>
      )}

      {/* ── 제목 ──────────────────────────────────────────────────────────── */}
      <div>
        <label htmlFor={f('title')} className="block text-sm font-semibold text-foreground mb-1">
          제목
        </label>
        <input
          id={f('title')}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={type === 'issue' ? '이슈 제목 (예: master1 kubelet 재기동 필요)' : '업무 제목 (예: 노드 NIC 점검)'}
          className="w-full px-2.5 py-1.5 bg-white text-zinc-900 placeholder:text-zinc-400 border border-border rounded-md text-sm font-medium focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* ── 업무 내용 — 접이식 (기본 접힘) ──────────────────────────────── */}
      <details className="group rounded-lg border border-border bg-muted/10 open:bg-card open:shadow-sm">
        <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm font-medium select-none">
          <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
          <span>{type === 'issue' ? '이슈 내용' : '업무 내용'}</span>
          <span className="text-xs text-muted-foreground/70">(클릭해서 펼치기)</span>
        </summary>
        <div className="px-3 pb-3" id={f('content')}>
          <RichTextEditor
            value={content}
            onChange={setTaskContent}
            placeholder={type === 'issue' ? '발생한 이슈를 상세히 기술하세요' : '수행할 업무를 상세히 기술하세요'}
            minHeight="520px"
            onImagePaste={handleImagePaste}
            linkSearch={linkSearch}
            defaultBg="#ffffff"
            extraTemplates={worktableTemplates}
          />
        </div>
      </details>

      {/* ── 이슈 상세 — type=issue 일 때만, 접이식 ────────────────────────── */}
      {type === 'issue' && (
        <details className="group rounded-lg border border-border bg-muted/10 open:bg-card open:shadow-sm">
          <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm font-medium select-none">
            <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
            <span>이슈 상세</span>
            <span className="text-xs text-muted-foreground/70">(추가 배경 · 재현 절차 등 — 선택 입력)</span>
          </summary>
          <div className="px-3 pb-3">
            <RichTextEditor
              value={detailContent}
              onChange={setDetailContent}
              placeholder="이슈의 배경 / 재현 절차 / 관련 정보를 기술하세요"
              minHeight="160px"
              onImagePaste={handleImagePaste}
              linkSearch={linkSearch}
              defaultBg="#ffffff"
            />
          </div>
        </details>
      )}


      {/* ── 사용자 정의 필드 ─────────────────────────────────────────────── */}
      {customFields.length > 0 && (
        <details className="group rounded-lg border border-border bg-muted/10 open:bg-card open:shadow-sm" open>
          <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm font-medium select-none">
            <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
            <span>사용자 정의 필드</span>
          </summary>
          <div className="px-3 pb-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            {customFields.map((cf) => {
              const v = customValues[cf.key];
              return (
                <div key={cf.id}>
                  <label className={labelClass} title={cf.description ?? undefined}>{cf.label}</label>
                  {cf.dataType === 'checkbox' ? (
                    <label className="flex items-center gap-2 text-sm h-7">
                      <input type="checkbox" checked={!!v}
                        onChange={(e) => setCustomVal(cf.key, e.target.checked)} className="accent-primary" />
                      <span className="text-muted-foreground">{v ? '예' : '아니오'}</span>
                    </label>
                  ) : cf.dataType === 'select' ? (
                    <select value={v == null ? '' : String(v)}
                      onChange={(e) => setCustomVal(cf.key, e.target.value || undefined)} className={inputClass}>
                      <option value="">—</option>
                      {(cf.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input
                      type={cf.dataType === 'number' ? 'number' : cf.dataType === 'date' ? 'date' : 'text'}
                      value={v == null ? '' : String(v)}
                      onChange={(e) => setCustomVal(cf.key, e.target.value || undefined)}
                      className={inputClass}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </details>
      )}


      {/* 푸터 액션 */}
      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
        >
          취소
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-60"
        >
          {submitting ? '저장 중…' : isEdit ? '저장' : '등록'}
        </button>
      </div>
    </form>
  );

  if (embedded) return formInner;
  return (
    <div className="bg-card border border-border rounded-2xl p-5 mac-shadow">
      {formInner}
    </div>
  );
}
