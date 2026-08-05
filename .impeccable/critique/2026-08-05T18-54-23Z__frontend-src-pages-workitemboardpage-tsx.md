---
target: 업무 관리 게시판 (/tasks-mgmt)
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 7
timestamp: 2026-08-05T18-54-23Z
slug: frontend-src-pages-workitemboardpage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector+evidence sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | 뷰별 실제 구조를 반영한 스켈레톤은 훌륭하나 WIP 한도 표시가 헤더/칸반에서 임계값이 다름 |
| 2 | Match System / Real World | 2 | WipToast "제한됩니다" 문구가 실제로는 막지 않는 소프트 경고를 강제처럼 표현 |
| 3 | User Control and Freedom | 3 | Esc 취소, ConfirmDialog, 프로비저닝 3분기 등 탈출구 촘촘 |
| 4 | Consistency and Standards | 1 | 고정 팔레트 98건+, 칸반 카드가 MacCard 우회, 우선순위 색 체계가 테이블/칸반 간 다름 |
| 5 | Error Prevention | 3 | 필수 필드 없으면 저장 비활성, Ctrl+Enter 필요 |
| 6 | Recognition Rather Than Recall | 3 | 프로비저닝 기본값 자동 프리필은 좋으나 컬럼 드래그 핸들이 grip 아이콘 하나로만 암시 |
| 7 | Flexibility and Efficiency of Use | 4 | 컬럼 순서/폭/필터/only-mine/show-time 전부 계정별 영속 |
| 8 | Aesthetic and Minimalist Design | 1 | 필터 바 한 줄에 컨트롤 최대 15개, 프로비저닝 모달 필드 11개 동시 노출 |
| 9 | Error Recovery | 3 | 403 사유 구체화, Jira missing→링크 다이얼로그 자동 오픈은 강점. push conflict는 다음 행동 없음 |
| 10 | Help and Documentation | 1 | 온보딩 없음, 밀집 필터 바가 라벨 없이 title(hover)에만 의존 |
| **Total** | | **24/40** | **Acceptable (20-27)** |

## Design Specificity Verdict

**LLM 평가**: Jira/Confluence 양방향 동기화가 표층이 아니라 워크플로 깊숙이 박혀 있다 — Epic→Task 체인 표시, 연동 업무는 PEP 칸반 라벨 대신 Jira 원본 상태명으로 바뀌는 컬럼 이원화, 일부만 성공한 프로비저닝을 로켓 아이콘 색으로 영속 표시 후 실패한 쪽만 재시도, 죽은 Jira 링크를 찾는 "연결 점검" 탭 등은 이 제품의 Jira 통합 고통을 실제로 겪어본 설계 흔적이다. 다만 칸반/캘린더의 시각 문법 자체는 일반적인 어드민 대시보드와 구분되지 않는 제네릭한 크롬이다.

**결정론적 스캔**: `detect.mjs` 2건(`side-tab`, `WorkItemCalendar.tsx:342-343`)은 **오탐** — 캘린더 툴팁 화살표(caret)를 만드는 CSS 삼각형 트릭이지 장식적 사이드탭이 아니다. 다만 수동 검증에서 detector가 못 잡은 **고정 팔레트 위반이 화면 전역에 광범위하게 발견**됐다(아래 참조) — 이번 라운드에서 가장 심각한 결함.

## Overall Impression

Jira 연동 로직의 깊이와 개인화(필터/컬럼/뷰 상태의 계정별 영속)는 이 제품다운 강점이다. 하지만 **두 어세스먼트가 독립적으로 도달한 가장 큰 문제는 디자인 토큰 미준수**다 — 같은 화면 안에서 테이블 뷰(`WorkItemTableRow.tsx`)는 이미 `status-*` 시맨틱 토큰으로 마이그레이션됐는데, 칸반 뷰·캘린더 뷰·Jira 모달들은 여전히 `bg-red-500`류 고정 팔레트를 쓰고 있어 **같은 화면, 다른 뷰 사이에서 우선순위 색 체계가 다르다.** 두 번째로 큰 문제는 필터 바 과밀(15개 컨트롤, 그룹 구분 없음)로, 인지부하 체크리스트 8개 중 6개가 실패하는 직접 원인이다.

## What's Working

1. 뷰별 실제 구조를 반영한 로딩 스켈레톤(`WorkItemBoardPage.tsx:904-918,943-947`) — 레이아웃 시프트 없음.
2. 오류 상태의 구체성 — 삭제 403 사유 명시, Jira `missing` 결과를 자동으로 연결 다이얼로그로 이어줌(`WorkItemBoardPage.tsx:470-474,552-554`).
3. 필터·컬럼폭·컬럼순서·show-time·only-mine을 계정별 localStorage로 분리 저장 — 여러 계정이 같은 브라우저를 써도 안 섞임.

## Priority Issues

**[P0] 디자인 토�큰 미준수 — 고정 팔레트가 화면 전역에 광범위 (양쪽 독립 합치, 최우선)**
- 근거: `workItemKanbanUtils.ts:20-108`(유형/컬럼/모듈 배지), `WorkItemKanban.tsx:18-22,46,49,151,153,215`(우선순위·WipToast·담당자 배지), `WorkItemCalendar.tsx:13-17,162-164,196-199,233`(우선순위 막대·주말 헤더), `JiraIssueChip.tsx:14-16`, `JiraLinkDialog.tsx:155`(`text-white`), `WorkItemCustomFieldsManager.tsx:88`, Jira import/provision 모달 전반 — 전부 `bg-red-500`/`text-blue-400`류 고정 팔레트. **반면 같은 화면의 `WorkItemTableRow.tsx:17-35`(`PRI_STYLES`)는 이미 `status-critical/warning/info` 토큰으로 마이그레이션 완료** — 즉 테이블 뷰와 칸반/캘린더 뷰가 같은 우선순위 필드를 다른 색 체계로 그린다.
- Fix: 이미 정답 패턴인 `PRI_STYLES`를 참조해 `WorkItemKanban`/`WorkItemCalendar`/Jira 모달들의 색상 상수를 `--status-*` 토큰으로 통일.
- Suggested command: `/impeccable harden`

**[P0] 필터 바 과밀 — 컨트롤 15개, 그룹/우선순위 구분 없음**
- 근거: `WorkItemBoardPage.tsx:746-887` — 유형/상태/검색/내업무/담당자/우선순위/모듈/스프린트/기간버튼/from/to/초기화 + 표시옵션 3개가 한 줄에 동일한 pill 스타일로 나열. 인지부하 체크리스트 8개 중 6개(Chunking/Grouping/Visual hierarchy/Minimal choices/Working memory/Progressive disclosure) 실패의 직접 원인.
- Fix: 자주 쓰는 3~4개(유형/상태/검색/내 업무)만 상시 노출, 나머지는 "필터 더보기" 팝오버로 분리. 표시 옵션은 구분선으로 시각적 격리.
- Suggested command: `/impeccable distill`

**[P1] Kanban 카드 hover 전용 액션 — 키보드 포커스 시 보이지 않음 (D-052 계열 재발, 양쪽 독립 합치)**
- 근거: `WorkItemKanban.tsx:180` `opacity-0 group-hover:opacity-100`만 있고 `focus-within`/`focus:opacity-100` 없음. 같은 파일 세트인 `WorkItemCalendar.tsx:208`은 이미 `focus:opacity-100`을 붙여 이 버그를 회피했는데 Kanban 카드에는 반영 안 됨.
- Fix: `group-focus-within:opacity-100` 추가.
- Suggested command: `/impeccable harden`

**[P1] 아이콘 전용 버튼 title+aria-label 병행 위반**
- 근거: `WorkItemKanban.tsx:184-219`(이전/다음/수정/삭제 4개, title만 있고 aria-label 없음), `WorkItemTableRow.tsx:220-224`(`TextareaInline` 저장/취소 버튼, title도 aria-label도 전혀 없음 — 가장 심각).
- Fix: 전부 aria-label 부여.
- Suggested command: `/impeccable harden`

**[P1] 파괴적 작업 확인 절차 불균형 (양쪽 독립 합치)**
- 근거: `WorkItemCustomFieldsManager.tsx:59` 네이티브 `window.confirm`(같은 파일의 `WorkItemBoardPage.tsx:359` 주석이 이미 이 패턴을 교체 대상으로 명시했음에도 이 매니저만 구식으로 남음). `JiraImportModal.tsx:602-606` "업무까지 삭제"가 다건 대상임에도 확인 다이얼로그 없이 즉시 실행 — 단일 삭제 흐름들엔 다 있는 확인 절차가 오히려 폭발반경이 더 큰 벌크 삭제에 없음.
- Fix: 둘 다 `ConfirmDialog(danger)`로 전환.
- Suggested command: `/impeccable harden`

**[P1] WIP 한도 표시 불일치 + 과장된 카피**
- 근거: 헤더는 `inProgressCount >= 2`에서 critical 스타일(`WorkItemBoardPage.tsx:671-673`), 칸반 컬럼은 `wipCount > col.wipLimit`(`WorkItemKanban.tsx:272`, 즉 3부터)에서만 경고. `WipToast`(`:48`)는 "제한됩니다"라 하지만 실제로 전이를 막지 않음.
- Fix: 임계값을 단일 소스로 통일, 카피를 소프트 워닝으로 정직하게 수정.
- Suggested command: `/impeccable clarify`

**[P1] 지연 업무(overdue)가 조용히 쌓임**
- 근거: `dueDate` 컬럼(`WorkItemTableRow.tsx:603-626`)에만 빨간 텍스트색 강조가 있고 헤더 배지(WIP/Done)에는 지연 건수가 없음.
- Fix: 헤더에 "지연 N" 배지 추가, 클릭 시 지연 필터/정렬 자동 적용.
- Suggested command: `/impeccable clarify`

**[P1] CSV 추출 실패 시 사용자 피드백 없음**
- 근거: `WorkItemBoardPage.tsx:581-594` `handleExportCsv` 실패 시 `console.error`만, 다른 모든 mutation은 `toast.error` 사용.
- Fix: `toast.error` 추가.
- Suggested command: `/impeccable harden`

**[P2] Kanban 카드가 MacCard 우회**
- 근거: `WorkItemKanban.tsx:111` `bg-card border border-border rounded-lg p-3` 손수 조합. CLAUDE.md D-004 위반.
- Suggested command: `/impeccable polish`

**[P2] 색상 단독 상태 전달**
- 근거: 마감 지연이 `text-status-critical` 텍스트색 변경 하나뿐(`WorkItemTableRow.tsx:603-609`), 캘린더 멀티데이 막대(`WorkItemCalendar.tsx:217-246`)는 중간 구간 라벨이 숨겨져 우선순위가 색상에만 의존.
- Suggested command: `/impeccable clarify`

**[P1] Jira push `conflict` 시 다음 행동 부재**
- 근거: `WorkItemBoardPage.tsx:496-499` "Jira 쪽이 더 최신입니다" 토스트만 뜨고 끝 — 다른 실패 경로(missing/provision 실패)는 다 후속 액션이 있는데 이 경로만 막다른 골목.
- Fix: "다시 가져오기" 버튼 부여.
- Suggested command: `/impeccable harden`

## Persona Red Flags

**Alex(바쁜 스캐너)**: 15개 필터 컨트롤을 훑어야 하고, 지연 업무 배지가 없어 마감 임박을 놓치기 쉬우며, WIP 배지 임계값이 헤더/칸반 간 달라 "지금 위험한가"를 신뢰하기 어렵다.

**Riley(키보드/스크린리더)**: 칸반 카드 액션이 hover 전용으로 focus 시 안 보임 — 테이블 뷰의 `EditableCell`(role=button+키보드 핸들러)과 대조적으로 뷰마다 접근성 품질이 들쭉날쭉.

**Sam(신규 팀원)**: 업무 하나 등록하자마자 Jira 연동이 켜져 있으면 `JiraProvisionModal`에서 필드 11개가 동시 노출 — "나중에" 탈출구는 있지만 급격한 난이도 상승.

**(프로젝트 특화) "온콜 대응 중인 인프라 운영자"** (PRODUCT.md): 장애 대응 중 짧게 업무를 남기려 해도 `AddWorkItemRow`가 필수 필드 4개를 요구하고, 저장 직후 Jira 프로비저닝 모달까지 체이닝돼 "그냥 로그만 남기고 싶었는데" 추가 결정 부담이 생긴다.

## Minor Observations

- `WorkItemCalendar.tsx` 범례가 5개 항목을 한 줄에 나열 — 툴팁으로 축약 가능.
- `JiraImportModal`의 "연결 점검" 안내는 불확실성을 정직히 고지하는데, 정작 삭제 액션엔 확인 다이얼로그가 없어 카피의 신중함과 실제 안전장치 수준이 어긋남(위 P1과 동일 근거).
- 담당자 자유입력 필드가 등록 경로마다 datalist 유무가 달라(QuickAddTaskModal만 `useAssignees` 제안) 오타로 인한 필터 매칭 실패 가능성.
- 테이블 행/컬럼 순서 변경(dnd-kit)이 `PointerSensor`만 등록돼 마우스 전용 — 레포 전체 공통 패턴(`KeyboardSensor` 사용 0건)이라 이 화면 특정 회귀는 아니며, 별도 레포 차원 백로그로 남기는 게 적절.

## Questions to Consider

- 필터 바 15개 컨트롤의 실제 사용 빈도 데이터가 있는가? 없다면 "더보기" 설계 우선순위를 정할 근거가 필요하다.
- WIP 한도는 "권장"인가 "강제"여야 하는가 — 카피와 실제 동작 중 하나로 정합성을 맞춰야 한다.
- Jira `conflict` 상태에서 "PEP 값으로 덮어쓰기" 옵션을 제공할 계획이 있는가?
