/** 업무관리게시판 목록(table) 컬럼 메타 — 헤더 / 행 / 추가폼 / 컬럼설정이
 *  공유하는 단일 소스. 순서·표시여부·너비 개인화의 기준값을 정의한다.
 */

export type WorkItemColumnKey =
  | 'project'
  | 'sprint'
  | 'status'
  | 'assignee'
  | 'category'
  | 'title'
  | 'startedAt'
  | 'closedAt'
  | 'actions'
  | 'priority'
  | 'cluster'
  | 'content'
  | 'result'
  | 'remarks'
  | 'jiraLink'
  | 'confluenceLink';

/** 클릭-정렬 가능한 컬럼이 매핑하는 정렬 키. */
export type WorkItemSortKey =
  | 'kanbanStatus'
  | 'priority'
  | 'assignee'
  | 'clusterName'
  | 'category'
  | 'startedAt'
  | 'closedAt';

export interface WorkItemColumnMeta {
  label: string;
  defaultWidth: number;
  /** 최초(또는 기본값 복원 시) 표시 여부. */
  defaultVisible: boolean;
  /** false 면 숨길 수 없음 (예: 작업 버튼 열). */
  hideable: boolean;
  /** 정렬 가능 컬럼이면 매핑되는 정렬 키. */
  sortKey?: WorkItemSortKey;
  headerAlign?: 'left' | 'center';
}

export const WORK_ITEM_COLUMNS: Record<WorkItemColumnKey, WorkItemColumnMeta> = {
  project:   { label: '프로젝트명',    defaultWidth: 150, defaultVisible: true,  hideable: true },
  sprint:    { label: '스프린트',      defaultWidth: 140, defaultVisible: false, hideable: true },
  status:    { label: '상태',          defaultWidth: 110, defaultVisible: true,  hideable: true, sortKey: 'kanbanStatus' },
  assignee:  { label: '담당자(정/부)', defaultWidth: 200, defaultVisible: true,  hideable: true, sortKey: 'assignee' },
  category:  { label: '업무 분류',     defaultWidth: 130, defaultVisible: true,  hideable: true, sortKey: 'category' },
  title:     { label: '제목',          defaultWidth: 260, defaultVisible: true,  hideable: true },
  startedAt: { label: '시작일',        defaultWidth: 130, defaultVisible: true,  hideable: true, sortKey: 'startedAt' },
  closedAt:  { label: '완료일',        defaultWidth: 130, defaultVisible: true,  hideable: true, sortKey: 'closedAt' },
  actions:   { label: '관리',          defaultWidth: 110, defaultVisible: true,  hideable: false, headerAlign: 'center' },
  priority:  { label: '우선순위',      defaultWidth: 90,  defaultVisible: false, hideable: true, sortKey: 'priority' },
  cluster:   { label: '대상 클러스터', defaultWidth: 140, defaultVisible: false, hideable: true, sortKey: 'clusterName' },
  content:   { label: '업무 내용',     defaultWidth: 280, defaultVisible: false, hideable: true },
  result:    { label: '업무 결과',     defaultWidth: 280, defaultVisible: false, hideable: true },
  remarks:   { label: '비고',          defaultWidth: 160, defaultVisible: false, hideable: true },
  jiraLink:       { label: 'Jira 링크',        defaultWidth: 110, defaultVisible: false, hideable: true },
  confluenceLink: { label: 'Confl. 링크',      defaultWidth: 110, defaultVisible: false, hideable: true },
};

/** 기본 컬럼 순서 (사용자 요청: 프로젝트명·상태·담당자·작업분류·제목·시작일·완료일·작업,
 *  이후 기본 숨김 컬럼). 행 드래그 핸들(`drag`)은 개인화 대상이 아니라 항상 선두 고정이므로 제외. */
export const DEFAULT_COLUMN_ORDER: WorkItemColumnKey[] = [
  'project', 'sprint', 'status', 'assignee', 'category', 'title', 'startedAt', 'closedAt', 'actions',
  'priority', 'cluster', 'content', 'result', 'remarks', 'jiraLink', 'confluenceLink',
];

export const DEFAULT_VISIBLE_COLUMNS: WorkItemColumnKey[] = (
  Object.entries(WORK_ITEM_COLUMNS) as [WorkItemColumnKey, WorkItemColumnMeta][]
)
  .filter(([, m]) => m.defaultVisible)
  .map(([k]) => k);

export const ALWAYS_VISIBLE_COLUMNS: WorkItemColumnKey[] = (
  Object.entries(WORK_ITEM_COLUMNS) as [WorkItemColumnKey, WorkItemColumnMeta][]
)
  .filter(([, m]) => !m.hideable)
  .map(([k]) => k);

/** useColumnWidths 기본값 — 행 드래그 핸들 포함. */
export const COLUMN_WIDTH_DEFAULTS: Record<string, number> = {
  drag: 28,
  ...Object.fromEntries(
    (Object.entries(WORK_ITEM_COLUMNS) as [WorkItemColumnKey, WorkItemColumnMeta][]).map(
      ([k, m]) => [k, m.defaultWidth],
    ),
  ),
};
