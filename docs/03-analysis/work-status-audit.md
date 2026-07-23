# 업무 현황(홈 work 모드) 버그·개선사항 감사

- **감사일**: 2026-07-23
- **대상 화면**: 홈 `/` 업무 현황(work) 모드 — KPI 스트립 + 업무 알람 벨 + 당일 스케줄 + 담당자별 진행 현황(주간/월간/담당자)
- **대상 코드**:
  - `frontend/src/pages/HomePage.tsx`
  - `frontend/src/components/dashboard/{DayScheduleBoard,WeeklyStatusTimeline,WorkCalendar,MemberTodayTodos,QuickAddTaskModal}.tsx`
  - `frontend/src/components/layout/WorkAlarmBell.tsx`
  - `frontend/src/components/work-items/WorkItemForm.tsx` (날짜 직렬화 관련)
  - `frontend/src/hooks/useWorkItems.ts`, `frontend/src/services/api.ts`
  - `backend/app/routers/work_items.py` (`GET /work-items`, `GET /work-items/today/summary`, `PUT/PATCH`)

코드 정독 기반 정적 감사 결과다. 우선순위: **P1(기능 오동작·데이터 왜곡) → P2(조건부 오동작·화면 간 불일치) → P3(엣지/의미 오류) → 개선(UX/설계)**.

---

## 요약 (TL;DR)

1. **홈의 모든 업무 집계가 "최근 100건"으로 조용히 잘린다** — 업무가 100건을 넘는 순간 KPI/알람/달력이 모두 부분 데이터 기준이 된다. (P1-1)
2. **KPI 필 2개("미해결 이슈", "다음 일정")의 링크 `/items` 가 존재하지 않는 라우트**라 클릭해도 홈으로 되돌아온다. (P1-2)
3. **날짜/타임존 규약이 화면·저장 경로마다 달라** 이른 아침(00:00~08:59 KST) 일정이 전날로 분류되거나 "1일 지연" 오탐이 나고, 정식 폼으로 입력한 시각은 +9h 시프트되어 표시될 수 있다. (P1-3 계열)

---

## P1 — 기능 오동작 / 데이터 왜곡

### P1-1. 홈 업무 데이터가 최근 100건으로 잘림 (pagination 미인지)

- `GET /work-items` 는 기본 `limit=100`, `started_at desc` 정렬이다 (`backend/app/routers/work_items.py:227,247`).
- 홈의 모든 소비처가 `useWorkItems()` 를 **필터/limit 없이** 호출하고 응답의 `total`/`hasMore` 를 무시한 채 `data.data` 만 쓴다:
  - `HomePage.tsx:86` (KPI: 내 할일 / 미해결 이슈 / 다음 일정)
  - `WeeklyStatusTimeline.tsx:130`, `WorkCalendar.tsx:71`, `DayScheduleBoard.tsx:215`, `WorkAlarmBell.tsx:76`
- **증상 (업무 100건 초과 시)**:
  - "미해결 이슈" KPI 과소 집계 — 오래된 미해결 이슈가 목록 밖으로 밀려남.
  - 업무 알람 벨에서 오래된 지연 업무 누락 (started_at 이 오래된 것부터 잘리므로 **지연 항목이 가장 먼저 사라짐**).
  - WorkCalendar 과거 달 / WeeklyStatusTimeline 과거 주가 비어 보임.
- **권장 수정**: 홈 소비처는 목적별 서버 필터로 좁혀 호출(예: KPI 는 `closed=false`, 주간/월간은 `startedFrom/startedTo` 범위 쿼리)하거나, 최소한 `hasMore=true` 일 때 경고 노출 + `limit` 상향. 근본적으로는 화면별 기간 스코프 쿼리가 맞다 (전체 로드는 데이터 증가에 따라 어차피 파산).

### P1-2. KPI 필 "미해결 이슈"/"다음 일정" 링크가 죽은 라우트 `/items`

- `HomePage.tsx:153,172` 가 `to="/items"` 로 링크하지만 `App.tsx` 에 `/items` 라우트가 없다. 레거시 alias 도 `/issues`, `/tasks`, `/work-items` 뿐이며, catch-all(`App.tsx:219`)이 `/` 로 되돌린다 → **클릭해도 홈으로 리다이렉트**(아무 일도 안 일어난 것처럼 보임).
- **권장 수정**: `/tasks-mgmt` 로 변경 (미해결 이슈는 `/tasks-mgmt?type=issue&closed=false` 류 딥링크가 이상적).

### P1-3. 날짜 저장·판독 규약이 3갈래로 갈라져 있음 (타임존 버그 계열의 근원)

`work_items.started_at` 은 naive `DateTime` 컬럼이고, 앱 표준 판독기(`lib/utils.ts parseUTC`, `DayScheduleBoard parseLocal`, `WorkCalendar parseDate`)는 **"tz 정보 없으면 UTC"** 로 간주해 로컬(KST)로 변환한다. 그런데:

| 경로 | 직렬화 방식 | 결과 |
|---|---|---|
| `QuickAddTaskModal.buildScheduledAtIso` (`:38-46`) | 로컬 시각 → `toISOString()` (**UTC Z**) | 표준 판독기와 일치 ✅ / `.slice(0,10)` 판독과 불일치 ❌ |
| `WorkItemForm.toApiDatetime` (`:78-83`) | **naive 로컬 문자열** 그대로 (`2026-07-23T14:00:00`) | 저장값이 KST 벽시계인데 판독기는 UTC 로 간주 → **+9h 시프트 표시** ❌ |
| 판독 측 `.slice(0,10)` (다수) | 저장 문자열의 앞 10자 = **UTC 날짜** | 로컬 날짜와 하루 어긋날 수 있음 ❌ |

구체 증상:

- **(a) QuickAdd 로 00:00~08:59 KST 일정 등록 → 전날로 분류 + "지연" 오탐.**
  `toISOString()` 이 전날 15:00~23:59Z 로 저장하므로, UTC 날짜(`slice(0,10)`) 기반 화면들이 전날로 취급한다:
  - `HomePage.tsx:98` 내 할일 KPI, `WorkAlarmBell.tsx:43,88` (등록 직후 "1일 지연" 뱃지), `WeeklyStatusTimeline.tsx:166,168` (막대가 전날 시작), `MemberTodayTodos.tsx:137-143` 공통 카드, `WorkCalendar.tsx:87` 이슈 버킷.
- **(b) 정식 폼(WorkItemForm) 입력 시각이 +9h 시프트.**
  예: 시작일 `14:00` 입력 → naive 저장 → `parseLocal` 이 Z 를 붙여 UTC 로 해석 → 당일 스케줄에 **23:00** 세션으로 표시. 날짜만 입력해도 `T00:00:00` 이 붙어 **09:00 KST 세션**으로 그려진다.
- **(c) 같은 컴포넌트 안에서도 규약이 다름.**
  `WorkCalendar.tsx` 는 작업은 로컬 날짜(`toDateKey(parseDate(...))`, `:91`), 이슈는 UTC 날짜(`slice(0,10)`, `:87`)로 버킷팅 — 같은 날 등록한 작업/이슈가 다른 칸에 놓일 수 있다.
- **권장 수정**: 규약을 하나로 통일한다 — **저장은 항상 UTC(Z 포함) ISO, 날짜 비교는 항상 "로컬 변환 후 dateKey"**.
  1. `WorkItemForm.toApiDatetime` 을 QuickAdd 와 같이 `toISOString()` 기반으로 변경(기존 naive 데이터 마이그레이션 여부 결정 필요).
  2. 프론트의 `.slice(0,10)` 비교 전부를 `dateKey(parseUTC(...))` 로 교체 (`HomePage`, `WorkAlarmBell`, `WeeklyStatusTimeline`, `MemberTodayTodos`, `WorkCalendar` 이슈 버킷).
  3. 서버 `today/summary` 는 P2-1 참조.

---

## P2 — 조건부 오동작 / 화면 간 불일치

### P2-1. 서버 `GET /work-items/today/summary` 의 날짜 경계가 UTC 기준

- `work_items.py:375-399` — `date` 파라미터(YYYY-MM-DD)를 **UTC 자정 경계**로 비교한다. KST 사용자의 "오늘" 이른 아침 업무(UTC 로 전날 15시 이후)는 전날 그룹으로 빠진다. `BATCH_JOBS_TIMEZONE`(Asia/Seoul) 같은 기준 타임존이 이 API 에는 적용되지 않는다.
- **권장 수정**: 경계 계산에 서비스 타임존(또는 클라이언트가 넘긴 오프셋)을 적용하거나, 프론트가 로컬 자정의 UTC 변환값으로 범위 질의하도록 API 를 `from/to` datetime 로 바꾼다.

### P2-2. `PUT /work-items/{id}` 로 done 저장 시 `closed_at` 자동 세팅 없음

- `PATCH /status` 만 done 이동 시 `closed_at` 자동 세팅 (`work_items.py:693-694`). 정식 폼 수정(PUT, `:615-663`)으로 `kanban_status='done'` 저장하면서 완료일을 비우면 **done + closed_at NULL** 항목이 생긴다.
- 파급: ① `HomePage.tsx:103` 미해결 이슈 KPI(`!closedAt`)에 완료 이슈가 계속 집계 ② `WeeklyStatusTimeline.tsx:170` 에서 done 인데 "진행 중(성장)" 막대로 주말까지 무한 연장 ③ `WorkCalendar.tsx:92` 완료 버킷 누락.
- 역방향도 있음: done → 다른 상태로 되돌릴 때 `closed_at` 을 지우지 않아(PATCH/PUT 모두) 재오픈 이슈가 "해결됨"으로 남는다.
- **권장 수정**: PUT 에서도 done 전이 시 `closed_at` 기본 세팅 + done 이탈 시 clear(또는 명시 입력 우선) 로직을 PATCH 와 공통 함수로 통일.

### P2-3. 멀티 담당자(콤마 "A,B") 판정이 화면마다 다름

- 서버 summary(`split_names`)·주간 타임라인(`:204`)·DayScheduleBoard(`assigneeNames`)는 콤마 분리를 지원하는데, **HomePage 내 할일 KPI(`:96`)와 WorkAlarmBell(`:86`)은 `t.assignee === myName` 정확 일치만** 검사한다.
- **증상**: `primary_assignee="A,B"` 인 업무는 A·B 누구의 KPI/알람에도 잡히지 않는다 → 담당자 탭에는 보이는데 알람은 안 오는 불일치.
- **권장 수정**: `assigneeNames()` 헬퍼를 `lib` 로 승격해 공용 사용.

### P2-4. QuickAdd 등록 직후 "담당자" 탭이 갱신되지 않음

- 담당자 탭(MemberTodayTodos)은 쿼리 키 `['items','today',viewDate]` (`:83`) 를 쓰는데, `useCreateWorkItem` 등 뮤테이션은 `['workItems']` 만 invalidate 한다 (`useWorkItems.ts:27`).
- **증상**: 홈에서 업무 등록 → 주간/월간 탭은 즉시 반영, 담당자 탭은 최대 60초(폴링 주기) 지연.
- **권장 수정**: 뮤테이션 성공 시 `['items','today']` prefix 도 invalidate (또는 summary 쿼리 키를 `workItemKeys` 체계로 편입).

### P2-5. "다음 일정" KPI 의 의미·대상 오류

- `HomePage.tsx:30-38` — 후보에 **지난 24시간 내 시작 업무를 포함**하고 오름차순 첫 건을 취해, 어제 업무가 "다음 일정"으로 표기되는 경우가 흔하다.
- 대상이 `type==='task'` 뿐이라 QuickAdd 로 등록한 **회의/교육 일정은 KPI 에 잡히지 않는다** (당일 스케줄 보드와 대상 불일치).
- **권장 수정**: `ms >= now` 인 미래 시작 건만 + 작업류(type !== 'issue') 전체 대상.

---

## P3 — 엣지 / 표기 오류

### P3-1. WorkCalendar 가 `title` 을 무시

- 칩/목록/팝오버 모두 `stripHtml(t.content) || t.category` 만 사용 (`WorkCalendar.tsx:305,312,319,476,493,507`). 다른 화면 표준은 `title?.trim() || stripHtml(content)`. QuickAdd 는 content=title 로 넣어 무관하지만, 정식 폼에서 제목·본문을 다르게 쓴 항목은 월간 뷰에서만 다른 이름으로 보인다.

### P3-2. 마일스톤(이슈)이 같은 날 여러 건이면 겹쳐 그려짐

- `WeeklyStatusTimeline.tsx:461-475` — 같은 `dayIdx` 의 마일스톤이 전부 같은 좌표(수직 중앙)에 절대배치되어 서로 완전히 겹친다. 레인 분배(packLanes 류)가 없다.

### P3-3. 날짜 문자열 파싱 방식 혼재 (`new Date('YYYY-MM-DD')`)

- `MemberTodayTodos.tsx:50,56` 은 `new Date(dateStr)`(UTC 해석), 다른 컴포넌트는 `dateStr + 'T00:00:00'`(로컬 해석). KST 에선 우연히 결과가 같지만 음수 오프셋 타임존에서 하루 밀리고, 무엇보다 규약 혼재가 P1-3 계열 버그의 온상이다. 날짜 유틸(`dateKey/addDays/fmtLabel`)이 4개 파일에 복붙되어 있어 `lib/date.ts` 로 통합할 것.

### P3-4. "시간 미지정" 버킷이 신규 데이터에서 사실상 사장

- `WorkItemForm.toApiDatetime` 이 날짜만 입력해도 `T00:00:00` 을 붙이므로 `DayScheduleBoard.hasClock`(`:37-39`)이 항상 true → 모든 폼 입력 업무가 자정(=UTC 해석 시 09:00 KST) 세션으로 그리드에 그려지고, "시간 미지정" 하단 영역은 레거시 데이터에서만 동작한다. 날짜만 입력한 항목은 시각 성분 없이 저장(또는 별도 플래그)하는 게 원래 의도에 부합.

### P3-5. 홈 화면의 "오늘" 기준이 마운트 시각에 고정

- `DayScheduleBoard.tsx:155,408`(todayStr, now 라인), `HomePage.tsx:91,118`, `WorkCalendar.tsx:59`, `MemberTodayTodos.tsx:62` — 모두 렌더 시점 `new Date()` 고정. 홈을 상시 띄워두는 운영 대시보드 특성상 자정 이후 KPI/오늘 하이라이트/now 라인이 어긋난다. 1분 tick(now 라인) + 날짜 변경 감지 재계산 권장.

---

## 개선사항 (UX / 설계)

| # | 항목 | 내용 |
|---|---|---|
| I-1 | 완료 업무의 당일 스케줄 잔존 | `DayScheduleBoard.spanItems` 가 done 을 즉시 제외(`:230`) → 완료 처리하면 오늘 일정에서 사라져 하루 회고가 안 됨. 완료 표시(체크·흐림)로 남기는 옵션 권장. |
| I-2 | 디자인 토큰 위반 (raw 팔레트) | `WorkCalendar`(blue/emerald/amber/red-*), `MemberTodayTodos`(STATUS_TEXT slate/blue/amber/purple/emerald), `WorkAlarmBell`(red/amber/blue-500), `QuickAddTaskModal`(PRIORITY dot), `DayScheduleBoard`(ASSIGNEE_PALETTE) — CLAUDE.md 의 "고정 팔레트 금지, semantic/status 토큰 사용" 규칙 위반. 테마(default/light/dark) 전환 시 톤이 어긋난다. DESIGN.md 백로그로 이관 권장. |
| I-3 | today/summary 지연 버킷에 backlog 포함 | `work_items.py:415-423` — backlog(언젠가 할 일)까지 시작일이 지나면 영구 "지연" 집계 → 지연 뱃지 인플레이션. `notin_(["done","in_progress","backlog"])` 검토. 또한 in_progress 버킷은 **미래 시작** 업무도 포함한다. |
| I-4 | today/summary 잘못된 date 파라미터를 조용히 오늘로 대체 | `work_items.py:375-379` — 형식 오류 시 fallback 대신 422/400 이 디버깅에 유리. |
| I-5 | 주간 막대 텍스트 색 기본 흰색 | `homeStore` 기본 `#ffffff` + 사용자가 막대 투명도를 낮추면(라이트 테마) 가독성 급락. 투명도 연동 자동 대비(또는 기본값을 토큰 기반) 검토. |
| I-6 | KPI "내 할일" 집계 기준과 이동 대상 페이지 불일치 가능성 | KPI 는 "내 담당 + 미완료 + 시작일 도래(또는 무기한)" 인데 `/todo-today` 페이지 집계 규칙과 완전히 동일한지 보장 장치가 없다. 집계 로직을 훅으로 공용화해 KPI·페이지가 같은 숫자를 보도록 권장. |
| I-7 | 담당자 순환(◀▶) 시작 인덱스 | `DayScheduleBoard.cycleSelectedName`(`:204-212`) — selectedName 이 목록에 없으면 0번째가 아닌 1번째부터 순환 시작(`curIdx=-1→0+dir`). 사소한 스킵. |

---

## 권장 수정 순서

1. **P1-2** (죽은 링크) — 한 줄 수정, 즉시.
2. **P1-1** (100건 잘림) — 화면별 서버 필터 도입. 데이터가 늘수록 체감 커짐.
3. **P1-3 + P2-1** (날짜 규약 통일) — 저장 규약 단일화(UTC Z) → 판독 `.slice(0,10)` 제거 → 서버 경계 타임존 반영. 한 PR 로 묶어 처리 권장 (기존 naive 데이터 보정 스크립트 포함 여부 결정 필요).
4. **P2-2** (closed_at 자동화) — 서버 공통 함수화.
5. **P2-3, P2-4, P2-5** — 소규모 프론트 수정.
6. P3/개선 항목 — 백로그로 관리 (I-2 는 DESIGN.md 백로그에 등록).
