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
  | 'dueDate'
  | 'actions'
  | 'priority'
  | 'cluster'
  | 'content'
  | 'result'
  | 'remarks'
  | 'jiraLink'
  | 'confluenceLink'
  // ── Jira 원본 축 — 가져온 이슈를 Jira 에서 보던 것과 같은 항목으로 보여준다.
  // "Jira 상태"는 별도 컬럼 없이 'status'(상태) 셀이 연결 업무면 Jira 원본 상태명으로
  // 대신 표시한다 — 두 항목이 같은 정보라 하나로 합쳤다(WorkItemTableRow.tsx `case 'status'`).
  | 'jiraEpic'
  | 'jiraType'
  | 'jiraComponents'
  | 'jiraLabels';

/** 클릭-정렬 가능한 컬럼이 매핑하는 정렬 키. */
export type WorkItemSortKey =
  | 'kanbanStatus'
  | 'priority'
  | 'assignee'
  | 'clusterName'
  | 'category'
  | 'startedAt'
  | 'closedAt'
  | 'dueDate'
  | 'jiraEpic'
  | 'jiraType';

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
  project:   { label: '프로젝트명',    defaultWidth: 150, defaultVisible: false, hideable: true },
  sprint:    { label: '스프린트',      defaultWidth: 140, defaultVisible: false, hideable: true },
  status:    { label: '상태',          defaultWidth: 110, defaultVisible: true,  hideable: true, sortKey: 'kanbanStatus' },
  assignee:  { label: '담당자(정/부)', defaultWidth: 200, defaultVisible: true,  hideable: true, sortKey: 'assignee' },
  category:  { label: '업무 분류',     defaultWidth: 130, defaultVisible: true,  hideable: true, sortKey: 'category' },
  title:     { label: '작업 제목',     defaultWidth: 260, defaultVisible: true,  hideable: true },
  startedAt: { label: '시작일',        defaultWidth: 130, defaultVisible: true,  hideable: true, sortKey: 'startedAt' },
  closedAt:  { label: '완료일',        defaultWidth: 130, defaultVisible: false, hideable: true, sortKey: 'closedAt' },
  dueDate:   { label: '마감일',        defaultWidth: 130, defaultVisible: true,  hideable: true, sortKey: 'dueDate' },
  actions:   { label: '관리',          defaultWidth: 110, defaultVisible: true,  hideable: false, headerAlign: 'center' },
  priority:  { label: '우선순위',      defaultWidth: 90,  defaultVisible: false, hideable: true, sortKey: 'priority' },
  cluster:   { label: '대상 클러스터', defaultWidth: 140, defaultVisible: false, hideable: true, sortKey: 'clusterName' },
  content:   { label: '업무 내용',     defaultWidth: 280, defaultVisible: false, hideable: true },
  result:    { label: '업무 결과',     defaultWidth: 280, defaultVisible: false, hideable: true },
  remarks:   { label: '비고',          defaultWidth: 160, defaultVisible: false, hideable: true },
  // 구 "작업 제목" 셀에 인라인으로 붙어 있던 Jira/Confluence 칩을 독립 컬럼으로 분리한 것 —
  // WorkItemTableRow.tsx 의 'jiraLink'/'confluenceLink' case 가 각각 DL/WIKI 칩을 그린다.
  jiraLink:       { label: 'DL',   defaultWidth: 90, defaultVisible: true, hideable: true },
  confluenceLink: { label: 'WIKI', defaultWidth: 90, defaultVisible: true, hideable: true },
  // "상위업무" = Epic→Task 체인(둘 다 있으면 두 칩을 함께 표시, WorkItemTableRow.tsx 참고).
  jiraEpic:       { label: '상위업무',         defaultWidth: 260, defaultVisible: true,  hideable: true, sortKey: 'jiraEpic' },
  jiraType:       { label: '이슈 종류',        defaultWidth: 100, defaultVisible: true,  hideable: true, sortKey: 'jiraType' },
  jiraComponents: { label: '컴포넌트',         defaultWidth: 160, defaultVisible: false, hideable: true },
  jiraLabels:     { label: '라벨',             defaultWidth: 160, defaultVisible: false, hideable: true },
};

/** 기본 컬럼 순서/표시여부 (사용자 요청 고정값): 상태·담당자·상위업무·이슈종류·DL·WIKI·
 *  작업제목·시작일·마감일·관리·업무 분류. 나머지는 기본 숨김(컬럼 설정에서 켤 수 있음).
 *  행 드래그 핸들(`drag`)은 개인화 대상이 아니라 항상 선두 고정이므로 제외. */
export const DEFAULT_COLUMN_ORDER: WorkItemColumnKey[] = [
  'status', 'assignee', 'jiraEpic', 'jiraType', 'jiraLink', 'confluenceLink', 'title', 'startedAt', 'dueDate', 'actions', 'category',
  'project', 'sprint', 'closedAt', 'priority', 'cluster', 'content', 'result', 'remarks', 'jiraComponents', 'jiraLabels',
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
