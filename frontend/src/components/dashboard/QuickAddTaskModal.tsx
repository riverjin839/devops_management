import { useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CalendarDays, X, Loader2, AlertTriangle, Server, Users, ExternalLink,
  CheckCircle2,
} from 'lucide-react';
import { useCreateWorkItem, useUpdateWorkItem } from '@/hooks/useWorkItems';
import { useClusters } from '@/hooks/useCluster';
import { useAssignees } from '@/hooks/useAssignees';
import { useJiraConfig } from '@/hooks/useJira';
import { useToast } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useAuthStore } from '@/stores/authStore';
import { JiraProvisionModal } from '@/components/work-items/JiraProvisionModal';
import type { KanbanStatus, WorkItem, WorkItemType } from '@/types';
import { WORK_ITEM_TYPE_CONFIG, WORK_ITEM_TYPE_ORDER } from '@/components/work-items/workItemKanbanUtils';
import { formatApiError } from '@/lib/utils';

interface QuickAddTaskModalProps {
  open: boolean;
  /** YYYY-MM-DD — 클릭한 달력 날짜. 신규 등록 모드(initial 미지정)에서만 필수. */
  defaultDate?: string;
  /** HH:mm — 시간단위 스케줄에서 클릭한 시각 미리 채움 (선택, 기본 09:00). */
  defaultTime?: string;
  /** 담당자 미리 채움 — 담당자별 스케줄에서 빈 슬롯 클릭 시 (선택). */
  defaultAssignee?: string;
  /** 클러스터 사이드바에서 선택된 클러스터 — 미리 채움 (선택). */
  defaultClusterId?: string | null;
  /** 지정하면 수정 모드 — 해당 업무를 프리필하고 저장 시 update(부분 필드만) 를 호출한다.
   *  유형(type)은 생성 후 변경 불가라 수정 모드에서는 표시만 하고 선택은 막는다. */
  initial?: WorkItem | null;
  /** 지정하면 하위 업무 등록 모드 — 상위 업무를 읽기전용 칩으로 보여주고(수정 불가) 저장
   *  시 parentId 로 연결한다. initial 과 동시에 쓰지 않는다(하위 업무 "수정"은 initial 만). */
  parentItem?: WorkItem | null;
  onClose: () => void;
  /** 등록 후 caller 가 추가로 처리할 후크 (선택). 기본은 useCreateWorkItem 가 캐시 무효화. */
  onCreated?: () => void;
  /** 수정 저장 후 caller 가 추가로 처리할 후크 (선택). 기본은 useUpdateWorkItem 가 캐시 무효화. */
  onSaved?: () => void;
}

const PRIORITY_OPTIONS: { value: 'high' | 'medium' | 'low'; label: string; dot: string }[] = [
  { value: 'high',   label: '높음', dot: 'bg-status-critical' },
  { value: 'medium', label: '보통', dot: 'bg-status-warning' },
  { value: 'low',    label: '낮음', dot: 'bg-status-healthy' },
];


function buildScheduledAtIso(date: string, time: string): string {
  // KST → UTC 보존을 위해 datetime-local 같은 의미로 처리:
  // Date(`${date}T${time}:00`) 는 브라우저 로컬 타임존 기준이므로,
  // toISOString() 으로 UTC 직렬화하여 백엔드 DateTime 컬럼에 저장.
  // 시간이 비었거나 형식이 어긋나면 자정(00:00)으로 안전하게 처리해 Invalid Date 를 방지.
  const t = /^\d{2}:\d{2}$/.test(time) ? time : '00:00';
  const d = new Date(`${date}T${t}:00`);
  return Number.isNaN(d.getTime()) ? `${date}T00:00:00` : d.toISOString();
}

function formatDateLabel(date: string): string {
  const d = new Date(date + 'T00:00:00');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ISO datetime → 로컬 타임존 기준 YYYY-MM-DD / HH:mm 추출 (수정 모드 프리필용). */
function toLocalDate(iso?: string | null): Date | null {
  if (!iso) return null;
  const norm = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  const d = new Date(norm);
  return Number.isNaN(d.getTime()) ? null : d;
}
function extractDateYMD(iso?: string | null): string {
  const d = toLocalDate(iso);
  if (!d) return todayStr();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function extractTimeHHMM(iso?: string | null): string {
  const d = toLocalDate(iso);
  if (!d) return '09:00';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 메인 화면 달력에서 날짜 클릭 시 띄우는 빠른 업무 등록 모달 — `initial` 을 지정하면
 * 같은 디자인/패턴 그대로 "업무 수정" 모달로 동작한다(업무 관리 게시판의 ✏️ 버튼이 진입점).
 *
 * 백엔드의 `work_items` 테이블을 그대로 사용한다 — `startedAt` 가 일정의 시점,
 * `type` 으로 이슈 대응/회의/운영 대응/기타 를 구분한다. 자세한 옵션(서비스 태그,
 * 모듈, effortHours, 본문 리치텍스트 등)은 "상세 입력/수정" 링크로 이어지는 정식 폼에서
 * 추가/수정한다 — 수정 모드에서도 이 모달이 건드리는 필드(제목/시간/우선순위/담당자/
 * 클러스터/칸반상태)만 부분 업데이트(PUT, `exclude_unset`)로 전송해 기존 본문(content)
 * 등 다른 필드를 절대 덮어쓰지 않는다. 유형(type)은 생성 후 변경 불가라 수정 모드에서는
 * 현재 값만 표시하고 선택은 막는다.
 *
 * PEP 저장 성공 후(신규 등록에서만) Jira 연동이 켜져 있으면(`jiraConfig.enabled`) 곧바로
 * `JiraProvisionModal`(Jira 이슈·Confluence 문서 생성 팝업)로 전환한다 — 그 안의
 * 체크박스 + "생성"/"나중에" 가 "Jira/Confluence 에도 등록할지" 를 묻는 절차를 겸한다.
 * "나중에" 를 누르면 PEP 에만 저장된 채로 끝난다. 연동이 꺼져 있으면 이 단계 자체가
 * 생략되고 바로 닫힌다. 수정 모드는 이미 연결된 Jira/Confluence 상태를 건드리지 않으므로
 * 저장 후 바로 닫힌다(연동 관리는 행의 별도 아이콘으로 수행).
 */
export function QuickAddTaskModal({
  open, defaultDate, defaultTime, defaultAssignee, defaultClusterId, initial, parentItem,
  onClose, onCreated, onSaved,
}: QuickAddTaskModalProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const isEdit = !!initial;
  const effectiveDate = isEdit ? extractDateYMD(initial!.startedAt) : (defaultDate ?? todayStr());

  const currentUser = useAuthStore((s) => s.user);
  const myName = (currentUser?.displayName?.trim() || currentUser?.username || '').trim();
  const { data: clusters = [] } = useClusters();
  const { data: assignees = [] } = useAssignees();
  const { data: jiraConfig } = useJiraConfig();
  const createMut = useCreateWorkItem();
  const updateMut = useUpdateWorkItem();
  // 등록 성공 후 Jira/Confluence 단계로 넘어가면 이 폼 자체는 닫힌 것으로 취급 —
  // 포커스 트랩·Escape 를 JiraProvisionModal 쪽으로 넘긴다(이중 활성 방지). 수정 모드는
  // 이 단계 자체를 타지 않는다(이미 연결된 연동 상태를 건드리지 않음).
  const [provisionItem, setProvisionItem] = useState<WorkItem | null>(null);
  const dialogRef = useModalA11y(open && !provisionItem, onClose);

  const [selectedType, setSelectedType] = useState<WorkItemType | null>(null);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [kanbanStatus, setKanbanStatus] = useState<KanbanStatus>('todo');
  const [time, setTime] = useState('09:00');
  const [clusterId, setClusterId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  // 모달 열릴 때마다 입력값 초기화 — 수정 모드면 initial 값으로, 아니면 신규 등록 기본값으로.
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setSelectedType(initial.type);
      setTitle(initial.title ?? '');
      setAssignee(initial.primaryAssignee || initial.assignee || '');
      setPriority((initial.priority as 'high' | 'medium' | 'low') ?? 'medium');
      setKanbanStatus(initial.kanbanStatus ?? 'todo');
      setTime(extractTimeHHMM(initial.startedAt));
      setClusterId(initial.clusterId ?? '');
    } else {
      setSelectedType(null);
      setTitle('');
      // 하위 업무는 상위 업무의 담당자를 기본값으로 물려받는다(그대로 두거나 바꿀 수 있음).
      // 그 외에는 로그인한 본인을 기본 담당자로 채운다(그대로 두거나 바꿀 수 있음).
      setAssignee(defaultAssignee ?? parentItem?.primaryAssignee ?? parentItem?.assignee ?? myName);
      setPriority('medium');
      setKanbanStatus('todo');
      setTime(defaultTime ?? '09:00');
      setClusterId(defaultClusterId ?? parentItem?.clusterId ?? '');
    }
    setError(null);
    setProvisionItem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.id, parentItem?.id, defaultClusterId, defaultTime, defaultAssignee]);

  if (!open) return null;

  // Jira/Confluence 단계 — 완료(생성 또는 나중에) 시에만 진짜로 닫는다. 신규 등록 전용.
  const finishAfterProvision = () => {
    setProvisionItem(null);
    onCreated?.();
    onClose();
  };

  if (provisionItem) {
    return (
      <JiraProvisionModal open onClose={finishAfterProvision} item={provisionItem} />
    );
  }

  const busy = createMut.isPending || updateMut.isPending;
  const canSubmit = selectedType !== null
    && title.trim().length > 0
    && assignee.trim().length > 0
    && !busy;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !selectedType) return;
    setError(null);
    try {
      const cluster = clusters.find((c) => c.id === clusterId);
      const trimmedTitle = title.trim();

      if (isEdit && initial) {
        // 부분 업데이트 — 이 모달이 다루는 필드만 전송한다. content/category 등은 절대
        // 포함하지 않아 기존 본문(리치텍스트 등)이 덮어써지지 않는다(백엔드 exclude_unset).
        await updateMut.mutateAsync({
          id: initial.id,
          data: {
            assignee: assignee.trim(),
            primaryAssignee: assignee.trim(),
            title: trimmedTitle,
            startedAt: buildScheduledAtIso(effectiveDate, time),
            priority,
            kanbanStatus,
            clusterId: cluster?.id,
            clusterName: cluster?.name,
          },
        });
        toast.success('업무 수정 완료', trimmedTitle);
        onSaved?.();
        onClose();
        return;
      }

      const created = await createMut.mutateAsync({
        type: selectedType,
        assignee: assignee.trim(),
        primaryAssignee: assignee.trim(),
        title: trimmedTitle,
        category: parentItem?.category || '일반 업무',
        content: trimmedTitle,
        startedAt: buildScheduledAtIso(effectiveDate, time),
        priority,
        kanbanStatus,
        clusterId: cluster?.id,
        clusterName: cluster?.name,
        parentId: parentItem?.id,
      });
      const typeLabel = WORK_ITEM_TYPE_CONFIG[selectedType].label;
      toast.success(
        parentItem ? '하위 업무 등록 완료' : `${typeLabel} 등록 완료`,
        `${formatDateLabel(effectiveDate)} · ${time}`,
      );
      // 연동이 켜져 있으면 바로 Jira/Confluence 생성 단계로 이어준다 — PEP 저장은
      // 이미 끝났으므로 이 단계를 건너뛰어도("나중에") 데이터 유실은 없다.
      if (jiraConfig?.enabled) {
        setProvisionItem(created.data);
      } else {
        onCreated?.();
        onClose();
      }
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !busy && onClose()} />
      <form
        ref={dialogRef as unknown as React.RefObject<HTMLFormElement>}
        role="dialog"
        aria-modal="true"
        aria-labelledby={f('heading')}
        onSubmit={handleSubmit}
        className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-md mx-4 max-h-[92vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <CalendarDays className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={f('heading')} className="text-base font-semibold leading-tight">
              {isEdit ? '업무 수정' : parentItem ? '하위 업무 등록' : '업무 등록'}
            </h2>
            <p className="text-xs text-muted-foreground">{formatDateLabel(effectiveDate)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-50 transition-colors"
            aria-label="닫기"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-3.5">
          {/* 상위 업무 — 하위 업무 등록 전용, 읽기전용(수정 불가). */}
          {parentItem && !isEdit && (
            <div>
              <p className="text-sm font-medium text-muted-foreground mb-1">상위 업무</p>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-border bg-secondary/60 text-sm text-foreground max-w-full">
                <span className="truncate">{parentItem.title?.trim() || parentItem.category}</span>
              </div>
            </div>
          )}

          {/* 업무 유형 — 이슈 대응/회의/운영 대응/기타. 신규 등록만 선택 가능(기본값 없음),
              수정 모드는 생성 후 변경 불가 정책에 따라 현재 값만 배지로 표시. */}
          <fieldset>
            <legend className="text-sm font-medium text-muted-foreground mb-1.5 block">
              유형 {!isEdit && <span className="text-status-critical">*</span>}
            </legend>
            {isEdit ? (
              selectedType && (
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-current text-xs font-medium ${WORK_ITEM_TYPE_CONFIG[selectedType].cls}`}>
                    {(() => { const Icon = WORK_ITEM_TYPE_CONFIG[selectedType].Icon; return <Icon className="w-4 h-4" />; })()}
                    {WORK_ITEM_TYPE_CONFIG[selectedType].label}
                  </span>
                  <span className="text-xs text-muted-foreground">유형은 등록 후 변경할 수 없습니다.</span>
                </div>
              )
            ) : (
              <div className="flex items-stretch gap-1.5">
                {WORK_ITEM_TYPE_ORDER.map((key) => {
                  const cfg = WORK_ITEM_TYPE_CONFIG[key];
                  const active = selectedType === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedType(key)}
                      aria-pressed={active}
                      className={`flex-1 flex flex-col items-center justify-center gap-1 px-2 py-2 rounded-xl border text-xs font-medium transition-colors ${
                        active
                          ? `${cfg.cls} border-current ring-2 ring-primary/30`
                          : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:bg-secondary/80'
                      }`}
                    >
                      <cfg.Icon className="w-4 h-4" />
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            )}
          </fieldset>

          {/* 제목 */}
          <div>
            <label htmlFor={f('title')} className="text-sm font-medium text-muted-foreground mb-1 block">
              제목 *
            </label>
            <input
              id={f('title')}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예) 노드 NIC 점검, master1 kubelet 재기동…"
              autoFocus
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              required
            />
          </div>

          {/* 시간 + 우선순위 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={f('time')} className="text-sm font-medium text-muted-foreground mb-1 block">시간</label>
              <input
                id={f('time')}
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground mb-1">우선순위</p>
              <div className="flex items-center gap-1 bg-secondary/60 rounded-xl p-0.5">
                {PRIORITY_OPTIONS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => setPriority(p.value)}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-sm rounded-lg transition-colors ${
                      priority === p.value
                        ? 'bg-card text-foreground shadow-sm font-semibold'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full ${p.dot}`} />
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 담당자 + 클러스터 */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={f('assignee')} className="text-sm font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                <Users className="w-3 h-3" /> 담당자 *
              </label>
              <input
                id={f('assignee')}
                list={f('assignee-list')}
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="이름 입력 또는 선택"
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                required
              />
              <datalist id={f('assignee-list')}>
                {assignees.map((a) => (
                  <option key={a.name} value={a.name}>{a.name}</option>
                ))}
              </datalist>
            </div>
            <div>
              <label htmlFor={f('cluster')} className="text-sm font-medium text-muted-foreground mb-1 block flex items-center gap-1">
                <Server className="w-3 h-3" /> 클러스터
              </label>
              <select
                id={f('cluster')}
                value={clusterId}
                onChange={(e) => setClusterId(e.target.value)}
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="">선택 안 함</option>
                {clusters.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm text-status-warning flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button
            type="button"
            onClick={() => {
              onClose();
              navigate(isEdit && initial ? `/tasks-mgmt/${initial.id}?edit=1` : `/tasks-mgmt/new?startedAt=${effectiveDate}T${time}`);
            }}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
          >
            <ExternalLink className="w-3 h-3" /> {isEdit ? '상세 수정' : '상세 입력'}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="px-3.5 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors disabled:opacity-50"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 inline-flex items-center gap-1.5 mac-shadow"
            >
              {busy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              {isEdit ? (busy ? '저장 중…' : '저장') : (busy ? '등록 중…' : '업무 등록')}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
