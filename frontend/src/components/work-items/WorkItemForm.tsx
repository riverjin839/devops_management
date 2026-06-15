import { useEffect, useId, useState } from 'react';
import { Plus, Settings2, ChevronDown, Users } from 'lucide-react';
import { WorkItem, WorkItemCreate, WorkItemUpdate, WorkItemType, KanbanStatus, WorkItemModule, WorkItemTypeLabel } from '@/types';
import { KANBAN_STATUS_LABEL, MODULE_CONFIG, TYPE_LABEL_CONFIG } from './workItemKanbanUtils';
import { loadWorkItemImages, saveWorkItemImages } from '@/lib/workItemImages';
import { RichTextEditor } from '@/components/editor';
import { DateTimePicker } from '@/components/ui/DateTimePicker';
import { useAssignees } from '@/hooks/useAssignees';
import { ConfluenceUrlInput, useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { useServiceCatalog } from '@/hooks/useServiceCatalog';
import { getComponentsForService } from '@/components/services/serviceCatalog';
import { useCreateWorkItem, useUpdateWorkItem } from '@/hooks/useWorkItems';
import { useWorkItemCustomFields, sortedWorkItemFields } from '@/hooks/useWorkItemCustomFields';
import { useWorkItems } from '@/hooks/useWorkItems';
import { useProjects } from '@/hooks/useProjects';
import { useSprints } from '@/hooks/useSprints';
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

const PRIORITIES = [
  { value: 'high', label: '높음' },
  { value: 'medium', label: '보통' },
  { value: 'low', label: '낮음' },
];

const KANBAN_STATUS_OPTIONS: KanbanStatus[] = ['backlog', 'todo', 'in_progress', 'review_test', 'done'];
const MODULE_OPTIONS = Object.entries(MODULE_CONFIG) as [WorkItemModule, { label: string; cls: string }][];
const TYPE_OPTIONS = Object.entries(TYPE_LABEL_CONFIG) as [WorkItemTypeLabel, { label: string; cls: string }][];

/** 신규 등록 기본값 — 시간 없이 날짜만(YYYY-MM-DD). 시간은 DateTimePicker 옵션으로 추가. */
function todayDate(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 폼 값(YYYY-MM-DD 또는 YYYY-MM-DDTHH:mm)을 백엔드 datetime 으로 보정.
 * - 날짜만이면 자정(T00:00:00)으로 채워 datetime 파싱 실패를 막는다.
 * - 초가 없으면 :00 을 붙인다.
 */
function toApiDatetime(v?: string | null): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return `${v}:00`;
  return v;
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
  /** 저장 완료 후 콜백. id 는 신규 등록 시 발급된 새 id. */
  onSaved: (savedId?: string) => void;
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
  const serviceCatalog = useServiceCatalog();
  const createTask = useCreateWorkItem();
  const updateTask = useUpdateWorkItem();
  const toast = useToast();

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [projectId, setProjectId] = useState(initial?.projectId ?? '');
  const { data: projectsData } = useProjects();
  const projects = projectsData?.data ?? [];

  const [sprintId, setSprintId] = useState(initial?.sprintId ?? '');
  const { data: sprintsData } = useSprints();
  const sprints = sprintsData?.data ?? [];
  const [title, setTitle] = useState(initial?.title ?? '');
  const [primaryList, setPrimaryList] = useState<string[]>(
    !initial && !parentItem && defaultAssignee ? [defaultAssignee] : [],
  );
  const [primInput, setPrimInput] = useState('');
  const [secondaryList, setSecondaryList] = useState<string[]>([]);
  const [secInput, setSecInput] = useState('');
  const [clusterIds, setClusterIds] = useState<string[]>([]);
  const [category, setTaskCategory] = useState('');
  const [taskCategoryCustom, setTaskCategoryCustom] = useState('');
  const [service, setService] = useState('');
  // Phase B — service 하위 component (recommended dropdown + 직접 입력 escape hatch).
  // 빈 문자열 = 미선택, '__custom__' = 직접 입력 모드 (componentCustom 사용).
  const [component, setComponent] = useState('');
  const [componentCustom, setComponentCustom] = useState('');
  const [content, setTaskContent] = useState('');
  const [resolution, setResultContent] = useState('');
  const [startedAt, setScheduledAt] = useState(defaultStartedAt ?? todayDate());
  const [closedAt, setCompletedAt] = useState('');
  const [priority, setPriority] = useState('medium');
  const [remarks, setRemarks] = useState('');
  const [confluenceUrl, setConfluenceUrl] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [customCategories, setCustomCategories] = useState<string[]>(loadCustomCategories);
  const [showCatManage, setShowCatManage] = useState(false);
  const [newCatInput, setNewCatInput] = useState('');
  const [kanbanStatus, setKanbanStatus] = useState<KanbanStatus>('todo');
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
      setImages(loadWorkItemImages(initial.id));
      setKanbanStatus(initial.kanbanStatus ?? 'todo');
      setModule((initial.module ?? '') as WorkItemModule | '');
      setTypeLabel((initial.typeLabel ?? '') as WorkItemTypeLabel | '');
      setEffortHours(initial.effortHours ? String(initial.effortHours) : '');
      setDoneCondition(initial.doneCondition ?? '');
      setIssueId(initial.relatedWorkItemId ?? '');
      setCustomValues(initial.customValues ?? {});
      setAllAttendees(initial.allAttendees ?? false);
      setService(initial.service ?? '');
      // Phase B — initial.component 가 COMPONENT_BY_SERVICE 의 추천 옵션이면 그대로,
      // 그렇지 않으면 '__custom__' 모드로 진입 + componentCustom 채움.
      {
        const initComp = initial.component ?? '';
        if (initComp) {
          const known = getComponentsForService(initial.service).includes(initComp);
          setComponent(known ? initComp : '__custom__');
          setComponentCustom(known ? '' : initComp);
        }
      }
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

  // 담당자(정) 복수 선택 — chip 추가/삭제 (쉼표/Enter 로 구분).
  const addPrimary = (raw: string) => {
    const name = raw.trim().replace(/,$/, '').trim();
    if (!name) return;
    setPrimaryList((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setPrimInput('');
  };
  const removePrimary = (name: string) => {
    setPrimaryList((prev) => prev.filter((n) => n !== name));
  };

  // 담당자(부) 복수 선택 — chip 추가/삭제.
  const addSecondary = (raw: string) => {
    const name = raw.trim().replace(/,$/, '').trim();
    if (!name) return;
    setSecondaryList((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setSecInput('');
  };
  const removeSecondary = (name: string) => {
    setSecondaryList((prev) => prev.filter((n) => n !== name));
  };

  const allCategories = [...DEFAULT_TASK_CATEGORIES, ...customCategories, '기타'];
  const resolvedCategory = category === '기타' ? taskCategoryCustom.trim() : category;
  const primaryCluster = clusters.find((c) => c.id === clusterIds[0]);
  const addCluster = (id: string) => setClusterIds((prev) => (id && !prev.includes(id) ? [...prev, id] : prev));
  const removeCluster = (id: string) => setClusterIds((prev) => prev.filter((x) => x !== id));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const plainTaskContent = content.replace(/<[^>]*>/g, '').trim();
    // 입력 중이던(미확정) 담당자도 제출 시 반영.
    const primaryFinal = primInput.trim() && !primaryList.includes(primInput.trim())
      ? [...primaryList, primInput.trim()] : primaryList;
    const secondaryFinal = secInput.trim() && !secondaryList.includes(secInput.trim())
      ? [...secondaryList, secInput.trim()] : secondaryList;
    // 필수값 누락 — 조용히 return 하지 않고 무엇이 빠졌는지 알려준다.
    if (!primaryFinal.length) { toast.error('등록 불가', '담당자(정)를 입력하세요.'); return; }
    if (!resolvedCategory) { toast.error('등록 불가', '분류를 선택하세요.'); return; }
    if (!plainTaskContent) { toast.error('등록 불가', '내용을 입력하세요.'); return; }
    if (!startedAt) { toast.error('등록 불가', '예정일시를 선택하세요.'); return; }

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
      kanbanStatus,
      module: module || undefined,
      typeLabel: typeLabel || undefined,
      effortHours: effortHours ? parseInt(effortHours, 10) : undefined,
      doneCondition: doneCondition.trim() || undefined,
      parentId: parentItem?.id,
      relatedWorkItemId: relatedWorkItemId || undefined,
      customValues: customFields.length ? customValues : undefined,
      allAttendees,
      service: service.trim() || undefined,
      // Phase B — service 가 있을 때만 component 가 의미. '__custom__' 모드면 input 값을,
      // 추천 옵션 선택이면 그 값을 그대로 전송. service 가 없으면 component 강제 null.
      component: service.trim()
        ? (component === '__custom__'
            ? (componentCustom.trim() || undefined)
            : (component || undefined))
        : undefined,
    };

    try {
      let savedId: string | undefined;
      if (isEdit && initial) {
        await updateTask.mutateAsync({ id: initial.id, data: payload as WorkItemUpdate });
        saveWorkItemImages(initial.id, images);
        savedId = initial.id;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await createTask.mutateAsync(payload);
        savedId = res?.data?.id ?? res?.id;
        if (images.length > 0 && savedId) saveWorkItemImages(savedId, images);
      }
      onSaved(savedId);
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
      {/* ── 기본 설정 — 컴팩트 단일 그리드 (담당자/클러스터/서비스/우선순위/보드상태/분류/일정/프로젝트) ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10 gap-x-2 gap-y-2">
        <div>
          <label htmlFor={f('primary')} className={labelClass}>
            담당자(정) * <span className="text-muted-foreground/60 font-normal">(복수 가능)</span>
          </label>
          <div className="w-full flex flex-wrap items-center gap-1 px-1.5 py-1 bg-background border border-border rounded-md min-h-[30px]">
            {primaryList.map((name) => (
              <span key={name} className="inline-flex items-center gap-0.5 text-xs bg-blue-500/10 text-blue-600 border border-blue-500/20 rounded px-1.5 py-0.5">
                {name}
                <button type="button" onClick={() => removePrimary(name)} className="hover:text-red-500" aria-label={`${name} 제거`}>×</button>
              </span>
            ))}
            <input
              id={f('primary')}
              type="text"
              value={primInput}
              onChange={(e) => setPrimInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addPrimary(primInput); }
                else if (e.key === 'Backspace' && !primInput && primaryList.length) { removePrimary(primaryList[primaryList.length - 1]); }
              }}
              onBlur={() => { if (primInput.trim()) addPrimary(primInput); }}
              list="item-assignee-list"
              placeholder={primaryList.length ? '' : '이름 입력 후 Enter'}
              className="flex-1 min-w-[64px] bg-transparent text-sm outline-none"
            />
          </div>
          <datalist id="item-assignee-list">
            {registeredAssignees.map((a) => (
              <option key={a.name} value={a.name} />
            ))}
          </datalist>
        </div>
        <div className="md:col-span-2">
          <div className="flex items-center justify-between mb-0.5">
            <label htmlFor={f('secondary')} className="text-xs font-medium text-muted-foreground">
              담당자(부) <span className="text-muted-foreground/60 font-normal">(복수 가능)</span>
            </label>
            <button
              type="button"
              onClick={() => setAllAttendees((v) => !v)}
              aria-pressed={allAttendees}
              title="전체 참석 — 회의 등 모든 구성원이 참석. 체크 시 전원의 개인 일정(Work To Do)에 표시됩니다."
              className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded border transition-colors ${
                allAttendees
                  ? 'bg-primary/10 text-primary border-primary/30'
                  : 'text-muted-foreground border-border hover:text-foreground hover:bg-secondary'
              }`}
            >
              <Users className="w-2.5 h-2.5" /> 전체 참석
            </button>
          </div>
          <div className="w-full flex flex-wrap items-center gap-1 px-1.5 py-1 bg-background border border-border rounded-md min-h-[30px]">
            {secondaryList.map((name) => (
              <span key={name} className="inline-flex items-center gap-0.5 text-xs bg-purple-500/10 text-purple-600 border border-purple-500/20 rounded px-1.5 py-0.5">
                {name}
                <button type="button" onClick={() => removeSecondary(name)} className="hover:text-red-500" aria-label={`${name} 제거`}>×</button>
              </span>
            ))}
            <input
              id={f('secondary')}
              type="text"
              value={secInput}
              onChange={(e) => setSecInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addSecondary(secInput); }
                else if (e.key === 'Backspace' && !secInput && secondaryList.length) { removeSecondary(secondaryList[secondaryList.length - 1]); }
              }}
              onBlur={() => { if (secInput.trim()) addSecondary(secInput); }}
              list="item-assignee-list"
              placeholder={secondaryList.length ? '' : '이름 입력 후 Enter'}
              className="flex-1 min-w-[64px] bg-transparent text-sm outline-none"
            />
          </div>
        </div>
        <div>
          <label htmlFor={f('cluster')} className={labelClass}>대상 클러스터 (다중)</label>
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
        <div>
          <label htmlFor={f('service')} className={labelClass} title="통합지식 서비스 카탈로그 tag">
            서비스
          </label>
          <select
            id={f('service')}
            value={service}
            onChange={(e) => {
              // Phase B cascade — service 변경 시 component 도 함께 reset (이전 값 잔존 방지)
              setService(e.target.value);
              setComponent('');
              setComponentCustom('');
            }}
            className={inputClass}
          >
            <option value="">— 선택 안 함 —</option>
            {serviceCatalog
              .filter((s) => s.key !== 'other')
              .map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
          </select>
        </div>
        {/* Phase B — service 가 있을 때만 component dropdown 활성화 */}
        {service && (
          <div>
            <label htmlFor={f('component')} className={labelClass} title="서비스 하위 component (선택)">
              컴포넌트
            </label>
            <select
              id={f('component')}
              value={component}
              onChange={(e) => setComponent(e.target.value)}
              className={inputClass}
            >
              <option value="">— component 선택 (선택) —</option>
              {getComponentsForService(service).map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
              <option value="__custom__">직접 입력...</option>
            </select>
            {component === '__custom__' && (
              <input
                type="text"
                value={componentCustom}
                onChange={(e) => setComponentCustom(e.target.value)}
                placeholder="component 이름"
                className={`${inputClass} mt-1`}
                maxLength={64}
              />
            )}
          </div>
        )}
        <div>
          <label htmlFor={f('priority')} className={labelClass}>우선순위 *</label>
          <select
            id={f('priority')}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className={inputClass}
          >
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={f('kanban')} className={labelClass}>보드 상태</label>
          <select
            id={f('kanban')}
            value={kanbanStatus}
            onChange={(e) => setKanbanStatus(e.target.value as KanbanStatus)}
            className={inputClass}
          >
            {KANBAN_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{KANBAN_STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor={f('category')} className="text-xs font-medium text-muted-foreground">업무 분류 *</label>
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
              <option value="">— 선택 —</option>
              {allCategories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label htmlFor={f('startedAt')} className={labelClass}>업무 예정일시 *</label>
          <DateTimePicker
            id={f('startedAt')}
            value={startedAt}
            onChange={setScheduledAt}
            placeholder="예정일 선택"
            clearable={false}
          />
        </div>
        <div>
          <label htmlFor={f('closedAt')} className={labelClass}>업무 완료일시</label>
          <DateTimePicker
            id={f('closedAt')}
            value={closedAt}
            onChange={setCompletedAt}
            placeholder="완료 시 입력"
          />
        </div>
        {projects.length > 0 && (
          <div>
            <label htmlFor={f('project')} className={labelClass}>프로젝트</label>
            <select
              id={f('project')}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className={inputClass}
            >
              <option value="">미분류</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}
        {sprints.length > 0 && (
          <div>
            <label htmlFor={f('sprint')} className={labelClass}>스프린트</label>
            <select
              id={f('sprint')}
              value={sprintId}
              onChange={(e) => setSprintId(e.target.value)}
              className={inputClass}
            >
              <option value="">미배정</option>
              {sprints.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.status === 'active' ? ' (진행중)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
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

      {/* ── 본문 — type 에 따라 라벨 변경 ──────────────────────────────── */}
      <div>
        <label htmlFor={f('content')} className="block text-sm font-semibold text-foreground mb-1">
          {type === 'issue' ? '이슈 내용' : '업무 내용'} <span className="text-primary">*</span>
        </label>
        <div id={f('content')}>
          <RichTextEditor
            value={content}
            onChange={setTaskContent}
            placeholder={type === 'issue' ? '발생한 이슈를 상세히 기술하세요' : '수행할 업무를 상세히 기술하세요'}
            minHeight="520px"
            onImagePaste={handleImagePaste}
            linkSearch={linkSearch}
            defaultBg="#ffffff"
          />
        </div>
      </div>

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

      {/* ── Confluence 링크 — 업무 결과 바로 위, 한 줄 컴팩트 ──────────────── */}
      <div className="max-w-xl">
        <ConfluenceUrlInput
          id={f('confluenceUrl')}
          value={confluenceUrl}
          onChange={setConfluenceUrl}
          inline
          showHint={false}
        />
      </div>

      {/* ── 조치 / 작업 결과 — 접이식 (default closed) ────────────────────── */}
      <details className="group rounded-lg border border-border bg-muted/10 open:bg-card open:shadow-sm">
        <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm font-medium select-none">
          <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
          <span>{type === 'issue' ? '조치 내용' : '업무 결과'}</span>
          <span className="text-xs text-muted-foreground/70">(클릭해서 펼치기 — 선택 입력)</span>
        </summary>
        <div className="px-3 pb-3">
          <RichTextEditor
            value={resolution}
            onChange={setResultContent}
            placeholder={type === 'issue' ? '조치 내용을 기술하세요' : '업무 결과를 기술하세요'}
            minHeight="160px"
            onImagePaste={handleImagePaste}
            linkSearch={linkSearch}
            defaultBg="#ffffff"
          />
        </div>
      </details>

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

      {/* ── 추가 옵션 — 접이식 (모듈/유형/이슈연결/비고) ─── */}
      <details className="group rounded-lg border border-border bg-muted/10 open:bg-card open:shadow-sm">
        <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm font-medium select-none">
          <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
          <span>추가 옵션</span>
          <span className="text-xs text-muted-foreground/70">
            (모듈/유형 · 이슈 연결 · 비고)
          </span>
        </summary>
        <div className="px-3 pb-3 space-y-2">
          {/* 모듈 / 유형 */}
          <div>
            <p className="text-xs font-semibold text-muted-foreground/80 mb-1 uppercase tracking-wider">모듈 / 유형</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <div>
                <label htmlFor={f('module')} className={labelClass} title="추후 deprecate 예정 — 가능하면 위 '서비스/컴포넌트' 사용">
                  모듈 <span className="text-[10px] text-muted-foreground/60">(legacy)</span>
                </label>
                <select
                  id={f('module')}
                  value={module}
                  onChange={(e) => setModule(e.target.value as WorkItemModule | '')}
                  className={inputClass}
                >
                  <option value="">— 선택 안 함 —</option>
                  {MODULE_OPTIONS.map(([key, cfg]) => (
                    <option key={key} value={key}>{cfg.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={f('type')} className={labelClass}>유형</label>
                <select
                  id={f('type')}
                  value={typeLabel}
                  onChange={(e) => setTypeLabel(e.target.value as WorkItemTypeLabel | '')}
                  className={inputClass}
                >
                  <option value="">— 선택 안 함 —</option>
                  {TYPE_OPTIONS.map(([key, cfg]) => (
                    <option key={key} value={key}>{cfg.label} ({key})</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={f('effort')} className={labelClass}>예상 소요 (h)</label>
                <input
                  id={f('effort')}
                  type="number"
                  min={1}
                  max={999}
                  value={effortHours}
                  onChange={(e) => setEffortHours(e.target.value)}
                  placeholder="예: 4"
                  className={inputClass}
                />
              </div>
            </div>
            <div className="mt-2">
              <label htmlFor={f('doneCond')} className={labelClass}>
                완료 조건
                <span className="ml-1 text-xs text-muted-foreground/70 font-normal">(Done 이동 기준)</span>
              </label>
              <input
                id={f('doneCond')}
                type="text"
                value={doneCondition}
                onChange={(e) => setDoneCondition(e.target.value)}
                placeholder="예: docker pull 캐시 동작 확인"
                className={inputClass}
              />
            </div>
          </div>

          {/* 연결된 이슈 / Confluence / 비고 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="md:col-span-2">
              <label htmlFor={f('issueLink')} className={labelClass}>
                연결된 이슈
                <span className="ml-1 text-xs text-muted-foreground/70 font-normal">(이 업무의 원인/배경)</span>
              </label>
              <select
                id={f('issueLink')}
                value={relatedWorkItemId}
                onChange={(e) => setIssueId(e.target.value)}
                className={inputClass}
              >
                <option value="">— 연결 안 함 —</option>
                {items
                  .slice()
                  .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
                  .map((i) => {
                    const title = i.content.replace(/<[^>]*>/g, '').slice(0, 60);
                    const when = (i.startedAt ?? '').slice(0, 10);
                    const status = i.closedAt ? '✓' : '●';
                    return (
                      <option key={i.id} value={i.id}>
                        {status} [{i.category}] {title || i.category} — {when}
                      </option>
                    );
                  })}
              </select>
            </div>
            <div className="md:col-span-2">
              <label htmlFor={f('remarks')} className={labelClass}>비고</label>
              <input
                id={f('remarks')}
                type="text"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="추가 메모 (선택 사항)"
                className={inputClass}
              />
            </div>
          </div>
        </div>
      </details>

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
