import { useEffect, useId, useState } from 'react';
import { Plus, Settings2, ChevronDown } from 'lucide-react';
import { WorkItem, WorkItemCreate, WorkItemUpdate, WorkItemType, KanbanStatus, WorkItemModule, WorkItemTypeLabel } from '@/types';
import { KANBAN_STATUS_LABEL, MODULE_CONFIG, TYPE_LABEL_CONFIG } from './workItemKanbanUtils';
import { loadWorkItemImages, saveWorkItemImages } from '@/lib/workItemImages';
import { RichTextEditor } from '@/components/editor';
import { DateTimePicker } from '@/components/ui/DateTimePicker';
import { useAssignees } from '@/hooks/useAssignees';
import { ConfluenceUrlInput } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { useServiceCatalog } from '@/hooks/useServiceCatalog';
import { useCreateWorkItem, useUpdateWorkItem } from '@/hooks/useWorkItems';
import { useWorkItems } from '@/hooks/useWorkItems';

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

const PRIORITIES = [
  { value: 'high', label: '높음' },
  { value: 'medium', label: '보통' },
  { value: 'low', label: '낮음' },
];

const KANBAN_STATUS_OPTIONS: KanbanStatus[] = ['backlog', 'todo', 'in_progress', 'review_test', 'done'];
const MODULE_OPTIONS = Object.entries(MODULE_CONFIG) as [WorkItemModule, { label: string; cls: string }][];
const TYPE_OPTIONS = Object.entries(TYPE_LABEL_CONFIG) as [WorkItemTypeLabel, { label: string; cls: string }][];

function todayDatetimeLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  /** 하위 작업 등록 시 상위 작업 — 카테고리/담당자 자동 채움. */
  parentItem?: WorkItem | null;
  onCancel: () => void;
  /** 저장 완료 후 콜백. id 는 신규 등록 시 발급된 새 id. */
  onSaved: (savedId?: string) => void;
  /** 컴팩트한 인라인 모드 (SidePane 내부) — 외부 컨테이너가 이미 패딩을 갖춘 환경에서 form 만 렌더. */
  embedded?: boolean;
}

export function WorkItemForm({ initial, defaultType = 'task', parentItem, onCancel, onSaved, embedded = false }: WorkItemFormProps) {
  const isEdit = !!initial;
  const [type, setType] = useState<WorkItemType>(initial?.type ?? defaultType);
  const [detailContent, setDetailContent] = useState(initial?.detailContent ?? '');

  useClusters();
  const { clusters } = useClusterStore();
  const { data: registeredAssignees = [] } = useAssignees();
  const serviceCatalog = useServiceCatalog();
  const createTask = useCreateWorkItem();
  const updateTask = useUpdateWorkItem();

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [primaryAssignee, setPrimaryAssignee] = useState('');
  const [secondaryAssignee, setSecondaryAssignee] = useState('');
  const [clusterId, setClusterId] = useState('');
  const [category, setTaskCategory] = useState('');
  const [taskCategoryCustom, setTaskCategoryCustom] = useState('');
  const [service, setService] = useState('');
  const [content, setTaskContent] = useState('');
  const [resolution, setResultContent] = useState('');
  const [startedAt, setScheduledAt] = useState(todayDatetimeLocal());
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
  const [hydrated, setHydrated] = useState(!isEdit && !parentItem);

  const { data: issueData } = useWorkItems();
  const items = issueData?.data ?? [];

  useEffect(() => {
    if (hydrated) return;
    const allKnownCategories = [...TASK_CATEGORIES, ...loadCustomCategories()];
    if (isEdit && initial) {
      setType(initial.type);
      setPrimaryAssignee(initial.primaryAssignee ?? initial.assignee);
      setSecondaryAssignee(initial.secondaryAssignee ?? '');
      setClusterId(initial.clusterId ?? '');
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
      setService(initial.service ?? '');
      setHydrated(true);
    } else if (parentItem) {
      setPrimaryAssignee(parentItem.primaryAssignee ?? parentItem.assignee);
      setSecondaryAssignee(parentItem.secondaryAssignee ?? '');
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
  const selectedCluster = clusters.find((c) => c.id === clusterId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const plainTaskContent = content.replace(/<[^>]*>/g, '').trim();
    if (!primaryAssignee.trim() || !resolvedCategory || !plainTaskContent || !startedAt) return;

    const payload: WorkItemCreate = {
      type,
      assignee: primaryAssignee.trim(),
      primaryAssignee: primaryAssignee.trim(),
      secondaryAssignee: secondaryAssignee.trim() || undefined,
      clusterId: clusterId || undefined,
      clusterName: selectedCluster?.name,
      category: resolvedCategory,
      content,
      resolution: resolution || undefined,
      detailContent: type === 'issue' ? (detailContent || undefined) : undefined,
      startedAt,
      closedAt: closedAt || null,
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
      service: service.trim() || undefined,
    };

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
  };

  const inputClass =
    'w-full px-2.5 py-1.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary';
  const labelClass = 'block text-[11px] font-medium text-muted-foreground mb-1';
  const submitting = createTask.isPending || updateTask.isPending;

  const formInner = (
    <form id="item-form" onSubmit={handleSubmit} className="space-y-3">
      {/* ── Type 선택 — 'issue' (이슈) vs 'task' (작업) ─────────────────────── */}
      {!isEdit && (
        <div className="flex items-center gap-1.5 bg-secondary/40 rounded-lg p-1 w-fit">
          {(['task', 'issue'] as WorkItemType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={
                'px-3 py-1 rounded-md text-xs font-medium transition-colors ' +
                (type === t
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground')
              }
            >
              {t === 'task' ? '작업' : '이슈'}
            </button>
          ))}
        </div>
      )}
      {/* ── Meta strip — 담당자/클러스터/서비스/우선순위/분류 1줄 컴팩트 ─────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
        <div>
          <label htmlFor={f('primary')} className={labelClass}>담당자(정) *</label>
          <input
            id={f('primary')}
            type="text"
            value={primaryAssignee}
            onChange={(e) => setPrimaryAssignee(e.target.value)}
            placeholder="이름"
            className={inputClass}
            required
            list="item-assignee-list"
          />
          <datalist id="item-assignee-list">
            {registeredAssignees.map((a) => (
              <option key={a.name} value={a.name} />
            ))}
          </datalist>
        </div>
        <div>
          <label htmlFor={f('secondary')} className={labelClass}>담당자(부)</label>
          <input
            id={f('secondary')}
            type="text"
            value={secondaryAssignee}
            onChange={(e) => setSecondaryAssignee(e.target.value)}
            placeholder="보조"
            className={inputClass}
            list="item-assignee-list"
          />
        </div>
        <div>
          <label htmlFor={f('cluster')} className={labelClass}>대상 클러스터</label>
          <select
            id={f('cluster')}
            value={clusterId}
            onChange={(e) => setClusterId(e.target.value)}
            className={inputClass}
          >
            <option value="">— 선택 안 함 —</option>
            {clusters.map((c) => (
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
            onChange={(e) => setService(e.target.value)}
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
          <div className="flex items-center justify-between mb-1">
            <label htmlFor={f('category')} className="text-[11px] font-medium text-muted-foreground">작업 분류 *</label>
            <button
              type="button"
              onClick={() => setShowCatManage((v) => !v)}
              className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
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
                required
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
                required
              />
            </div>
          ) : (
            <select
              id={f('category')}
              value={category}
              onChange={(e) => setTaskCategory(e.target.value)}
              className={inputClass}
              required
            >
              <option value="">— 선택 —</option>
              {allCategories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* 분류 관리 패널 — 토글 */}
      {showCatManage && (
        <div className="p-2.5 bg-muted/20 border border-border rounded-lg space-y-2">
          {customCategories.length > 0 && (
            <div className="flex items-center flex-wrap gap-1.5">
              <span className="text-[10px] text-muted-foreground font-medium mr-1">사용자 분류:</span>
              {customCategories.map((cat) => (
                <span key={cat} className="inline-flex items-center gap-0.5 text-[10px] bg-card border border-border rounded px-1.5 py-0.5">
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
              className="flex-1 px-2 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="button"
              onClick={addCustomCategory}
              className="flex items-center gap-0.5 px-2 py-1 text-xs bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded transition-colors"
            >
              <Plus className="w-3 h-3" />
              추가
            </button>
          </div>
        </div>
      )}

      {/* ── 일정 — 예정/완료 2칸 컴팩트 ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        <div>
          <label htmlFor={f('startedAt')} className={labelClass}>작업 예정일시 *</label>
          <DateTimePicker
            id={f('startedAt')}
            value={startedAt}
            onChange={setScheduledAt}
            placeholder="예정일과 시간 선택"
            required
            clearable={false}
          />
        </div>
        <div>
          <label htmlFor={f('closedAt')} className={labelClass}>작업 완료일시</label>
          <DateTimePicker
            id={f('closedAt')}
            value={closedAt}
            onChange={setCompletedAt}
            placeholder="완료 시 입력"
          />
        </div>
      </div>

      {/* ── 본문 ★ 가장 중요 — type 에 따라 라벨 변경 ──────────────────────── */}
      <div>
        <label htmlFor={f('content')} className="block text-sm font-semibold text-foreground mb-1.5">
          {type === 'issue' ? '이슈 내용' : '작업 내용'} <span className="text-primary">*</span>
        </label>
        <div id={f('content')}>
          <RichTextEditor
            value={content}
            onChange={setTaskContent}
            placeholder={type === 'issue' ? '발생한 이슈를 상세히 기술하세요' : '수행할 작업을 상세히 기술하세요'}
            minHeight="340px"
            onImagePaste={handleImagePaste}
          />
        </div>
      </div>

      {/* ── 이슈 상세 — type=issue 일 때만, 접이식 ────────────────────────── */}
      {type === 'issue' && (
        <details className="group rounded-lg border border-border bg-muted/10 open:bg-card open:shadow-sm">
          <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm font-medium select-none">
            <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
            <span>이슈 상세</span>
            <span className="text-[11px] text-muted-foreground/70">(추가 배경 · 재현 절차 등 — 선택 입력)</span>
          </summary>
          <div className="px-3 pb-3">
            <RichTextEditor
              value={detailContent}
              onChange={setDetailContent}
              placeholder="이슈의 배경 / 재현 절차 / 관련 정보를 기술하세요"
              minHeight="160px"
              onImagePaste={handleImagePaste}
            />
          </div>
        </details>
      )}

      {/* ── 조치 / 작업 결과 — 접이식 (default closed) ────────────────────── */}
      <details className="group rounded-lg border border-border bg-muted/10 open:bg-card open:shadow-sm">
        <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm font-medium select-none">
          <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
          <span>{type === 'issue' ? '조치 내용' : '작업 결과'}</span>
          <span className="text-[11px] text-muted-foreground/70">(클릭해서 펼치기 — 선택 입력)</span>
        </summary>
        <div className="px-3 pb-3">
          <RichTextEditor
            value={resolution}
            onChange={setResultContent}
            placeholder={type === 'issue' ? '조치 내용을 기술하세요' : '작업 결과를 기술하세요'}
            minHeight="160px"
            onImagePaste={handleImagePaste}
          />
        </div>
      </details>

      {/* ── 추가 옵션 — 접이식 (칸반/모듈/유형/이슈연결/Confluence/비고) ─── */}
      <details className="group rounded-lg border border-border bg-muted/10 open:bg-card open:shadow-sm">
        <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer text-sm font-medium select-none">
          <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform group-open:rotate-180" />
          <span>추가 옵션</span>
          <span className="text-[11px] text-muted-foreground/70">
            (칸반 보드 · 모듈/유형 · 이슈 연결 · Confluence · 비고)
          </span>
        </summary>
        <div className="px-3 pb-3 space-y-3">
          {/* 칸반 보드 */}
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground/80 mb-1.5 uppercase tracking-wider">칸반 보드</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
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
                <label htmlFor={f('module')} className={labelClass}>모듈</label>
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
            <div className="mt-2.5">
              <label htmlFor={f('doneCond')} className={labelClass}>
                완료 조건
                <span className="ml-1 text-[10px] text-muted-foreground/70 font-normal">(Done 이동 기준)</span>
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            <div className="md:col-span-2">
              <label htmlFor={f('issueLink')} className={labelClass}>
                연결된 이슈
                <span className="ml-1 text-[10px] text-muted-foreground/70 font-normal">(이 작업의 원인/배경)</span>
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
              <ConfluenceUrlInput
                id={f('confluenceUrl')}
                value={confluenceUrl}
                onChange={setConfluenceUrl}
              />
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
