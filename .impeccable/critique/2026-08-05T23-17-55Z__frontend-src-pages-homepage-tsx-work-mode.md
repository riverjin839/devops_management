---
target: 업무 현황 (/, HomePage work mode)
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 4
timestamp: 2026-08-05T23-17-55Z
slug: frontend-src-pages-homepage-tsx-work-mode
---
Method: dual-agent (A: design-review sub-agent · B: detector+evidence sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | `WorkCalendar`/`MemberTodayTodos`는 로딩·에러를 구분하지 않아 API 장애가 "데이터 없음"으로 보임 |
| 2 | Match System / Real World | 2 | "다음 일정" KPI가 전사 기준인데 바로 옆 "내 할일"은 개인화 — 같은 카테고리처럼 보이지만 모집단이 다름 |
| 3 | User Control and Freedom | 2 | 시간 블록 삭제가 확인 절차 없이 즉시 실행, 드래그 중 취소 경로 없음 |
| 4 | Consistency and Standards | 1 | 동일 `KanbanStatus` 값이 컴포넌트마다 다른 색 토큰(status-* vs chart-*)에 매핑, `MemberTodayTodos`만 고정 팔레트 잔존 |
| 5 | Error Prevention | 2 | 삭제 확인 부재(3번과 동일 근거) |
| 6 | Recognition Rather Than Recall | 3 | 계정별 표시 밀도 기억은 좋으나 리사이즈 핸들/삭제 버튼이 hover 전엔 안 보임 |
| 7 | Flexibility and Efficiency of Use | 3 | 담당자 순환, 탭 키보드 이동, 표시 인원 커스터마이즈 등 파워유저 기능 풍부 |
| 8 | Aesthetic and Minimalist Design | 3 | 대체로 정돈됐으나 `MemberTodayTodos`의 메모지 스타일이 다른 패널과 이질적 |
| 9 | Error Recovery | 2 | `DayScheduleBoard`/`WeeklyStatusTimeline`은 재시도 버튼 있음, `WorkCalendar`/`MemberTodayTodos`는 에러 인지 자체가 불가 |
| 10 | Help and Documentation | 2 | 아이콘 title/aria-label은 대체로 준수, 범례도 있으나 4개 패널의 서로 다른 인터랙션 모델에 대한 온보딩 없음 |
| **Total** | | **22/40** | **Acceptable (20-27)** |

## Design Specificity Verdict

**LLM 평가**: 일반적인 admin 대시보드가 아니라 PEP 실사용 흐름을 반영해 반복적으로 다듬어진 화면이다 — 코드 곳곳에 `D-005`/`D-011`/`D-054`/`D-060` 같은 과거 디자인 결정 번호 주석이 남아있어 실사용 피드백 기반 개선 이력을 보여준다. "공통"(담당자 미지정) 업무를 항상 최상단에 별도 노출하는 로직, 로그인 사용자를 목록 최상단에 고정하는 정렬, 표시 인원/인당 표시 개수를 계정별로 기억하는 것 모두 "다인원 운영팀이 여러 클러스터를 담당"하는 이 조직의 실제 운영 맥락(PRODUCT.md §Users)에서 나온 설계다. 예외적으로 `MemberTodayTodos.tsx`의 "메모지" 스타일(amber/red 하드코딩)은 이 서사에서 벗어난 장식으로, 근거 없이 튀는 처리다.

**결정론적 스캔**: `detect.mjs`가 대상 5개 파일에서 0건을 보고했다. 원인을 추적한 결과, 이 스캐너는 완전한 HTML 문서("full page")를 전제로 한 "AI-slop 시각 패턴"(그라디언트 텍스트/marquee/과대 h1 등) 탐지가 주력이라 React 컴포넌트 소스 자체나 이 프로젝트 고유의 디자인 토큰 위반은 원천적으로 탐지 범위 밖이다 — 알려진 `bg-red-*` 위반 파일(`CronBadge.tsx`)로 sanity check해도 동일하게 0건이 나와 **탐지 범위 갭이지 화면이 깨끗하다는 근거가 아니다.** 실제 팔레트 위반은 수동 검증에서만 발견됐다(아래 참조).

## Overall Impression

두 어세스먼트가 독립적으로 도달한 가장 큰 문제는 **같은 카드(담당자별 진행 현황)의 세 탭이 같은 상태값에 서로 다른 색 토큰을 쓴다**는 것이다 — `DayScheduleBoard`/`MemberTodayTodos`는 `status-*`, `WeeklyStatusTimeline`은 `chart-*`를 쓰며, 탭만 바꿔도 "따뜻한 색=주의 필요"라는 스캔 규칙이 깨진다. 두 번째로 두 어세스먼트가 합치한 문제는 **`WorkCalendar`/`MemberTodayTodos`의 에러 상태 부재**(API 장애가 "정상 빈 화면"으로 보임)와 **시간 블록 삭제의 확인 절차 부재**다. 기능은 풍부하고 제품 특화 설계가 우세하지만, 4개 하위 패널이 각자 독립적으로 진화하면서 하나의 시각 언어로 묶는 마무리가 부족하다.

## What's Working

1. `DayScheduleBoard`/`WeeklyStatusTimeline`의 3단(loading/error+재시도/empty) 상태 분기 — 레이아웃 시프트 없이 명확.
2. 표시 인원/인당 표시/scope 등 사용자별 `localStorage` 개인화 — 다인원 팀 운영 맥락을 반영.
3. `WeeklyStatusTimeline`의 `StatusGlyph`(아이콘+색+범례 3중 신호) — 색맹 접근성을 이미 올바르게 처리한 레퍼런스 패턴이 같은 화면 안에 존재.

## Priority Issues

**[P0] 하드코딩 팔레트 색상 — `MemberTodayTodos.tsx`만 토큰 마이그레이션에서 누락 (양쪽 독립 합치)**
- 근거: `MemberTodayTodos.tsx:306`(`border-amber-100 bg-amber-50/60 ... before:bg-red-300/60`), `:313`(`border-amber-200/70 hover:bg-amber-100/50`). 같은 카드의 다른 두 탭(`DayScheduleBoard`/`WeeklyStatusTimeline`)은 이미 `status-*`/`chart-*` 토큰만 쓰고 있어 이 탭 하나만 CLAUDE.md 불변 규칙(고정 팔레트 금지)을 벗어난다. `dark:` variant만 있어 comfort/light 테마에서는 색이 검증되지 않았다.
- Fix: amber 계열을 세만틱 토큰(`bg-secondary`/`border-border` 또는 신규 노트 전용 토큰)으로 교체.
- Suggested command: `/impeccable harden`

**[P1] 같은 카드의 세 탭이 같은 상태값에 서로 다른 색을 쓴다 (양쪽 독립 합치 — 색맹 접근성과도 연결)**
- 근거: `DayScheduleBoard.tsx:62-68`(`STATUS_STYLE`: todo=status-info, in_progress=status-warning, backlog=status-unknown) vs `WeeklyStatusTimeline.tsx:48-54`(`STATUS_BAR`: todo=chart-7, in_progress=chart-1, backlog=chart-8) vs `MemberTodayTodos.tsx:38-44`(`STATUS_TEXT`: DayScheduleBoard와 동일). "담당자별 진행 현황" 카드의 주간/월간/담당자 탭을 오가는 것만으로 동일 상태의 색 의미가 바뀐다.
- Fix: 상태→색 매핑을 공용 유틸로 추출해 세 컴포넌트가 동일 소스 참조.
- Suggested command: `/impeccable harden`

**[P1] `WorkCalendar`·`MemberTodayTodos` — 에러 상태가 "데이터 없음"으로 뭉개짐 (양쪽 독립 합치)**
- 근거: `WorkCalendar.tsx:77` `useHomeWorkItems()`에서 `isLoading`/`isError` 미사용, `MemberTodayTodos.tsx:84-89` `useQuery`에서 `isError` 미사용 — API 장애 시에도 정상 빈 상태 문구("등록된 업무가 없습니다")가 그대로 뜬다. 같은 카드의 `DayScheduleBoard`/`WeeklyStatusTimeline`은 이미 재시도 버튼까지 갖춘 3단 분기가 있어 격차가 뚜렷하다.
- Fix: 두 컴포넌트에 동일한 `isError`+재시도 패턴 적용.
- Suggested command: `/impeccable harden`

**[P1] 시간 블록 삭제 — 확인 절차 없이 즉시 실행 (양쪽 독립 합치)**
- 근거: `DayScheduleBoard.tsx:410-415`(`removeBlock`), `:652-660`(Trash2 클릭 즉시 `onDelete()`) — `window.confirm`조차 거치지 않고 바로 삭제. 삭제 버튼이 `opacity-0 group-hover:opacity-100`으로만 나타나 드래그 중 실수 클릭 위험도 있다.
- Fix: `ConfirmDialog(danger)`로 삭제 전 확인 단계 추가.
- Suggested command: `/impeccable harden`

**[P1] "다음 일정" KPI가 비개인화 — 바로 옆 "내 할일"과 다른 모집단**
- 근거: `HomePage.tsx:141`(`allSchedulable`, 전체 담당자) → `:153` `nextDueTask(allSchedulable)` → `:226-234` 렌더. 바로 왼쪽 `:146-149` "내 할일"은 개인화(`isMyDueTodo`)돼 있어 나란한 두 pill이 서로 다른 데이터 범위를 갖는데 UI가 이를 구분해 알려주지 않는다.
- Fix: 라벨을 "다음 일정(전체)"로 명시하거나 `myName` 기준으로 필터링.
- Suggested command: `/impeccable clarify`

**[P2] 상태를 색상만으로 구분 — 색맹 사용자 접근 불가**
- 근거: `MemberTodayTodos.tsx:38-44,316-320`(`STATUS_TEXT`, `Square` 아이콘 하나에 색만 다르게), `DayScheduleBoard.tsx:62-68`(dot/bar 색만). 같은 화면의 `WeeklyStatusTimeline.tsx:77-82`(`StatusGlyph`, 아이콘+라벨+범례)는 이미 올바른 패턴을 갖고 있다.
- Fix: 나머지 두 컴포넌트도 상태별 아이콘 또는 라벨 추가.
- Suggested command: `/impeccable clarify`

**[P2] 키보드 포커스 시 삭제 버튼이 보이지 않음**
- 근거: `DayScheduleBoard.tsx:656` `opacity-0 group-hover:opacity-100`에 `focus:opacity-100`/`group-focus-within:opacity-100` 짝 없음. 같은 화면 `WorkCalendar.tsx:297`는 이미 `focus:opacity-100`을 붙여 올바르게 구현.
- Fix: `focus:opacity-100 group-focus-within:opacity-100` 추가.
- Suggested command: `/impeccable harden`

**[P2] 탭 라벨 "내 업무"와 실제 기본 콘텐츠(팀 전체) 불일치**
- 근거: `HomePage.tsx:169` 탭 라벨 "내 업무" — 그러나 기본 뷰(`WeeklyStatusTimeline` `viewMode='assignee'`, :158)는 전체 담당자 스윔레인을 기본 노출.
- Fix: 탭 라벨을 "업무 현황"처럼 중립화하거나 기본 뷰를 실제로 개인화.
- Suggested command: `/impeccable clarify`

**[P2] 동일 목적지로 가는 CTA 라벨이 컴포넌트마다 다름**
- 근거: `/todo-today`로 이동하는 버튼이 `WorkCalendar.tsx:541-546`("오늘 할일 상세"), `WeeklyStatusTimeline.tsx:374-380`("Work To Do"), `MemberTodayTodos.tsx:360-365`("담당자별 상세 보기")로 각각 다름.
- Fix: 라벨 통일(예: "오늘 할일 전체 보기").
- Suggested command: `/impeccable clarify`

**[P2] 시간 블록 드래그 이동/리사이즈 — 키보드 대체 수단 없음 (양쪽 독립 합치)**
- 근거: `DayScheduleBoard.tsx:326-397,642-676` 전부 `onMouseDown` 기반, 리사이즈 핸들이 포커스 가능 요소가 아님.
- Fix: 최소한 상세 페이지(시간 텍스트 편집)로의 링크를 눈에 띄게 노출하거나, 핸들에 키보드 조작 추가.
- Suggested command: `/impeccable harden`

**[P2] 담당자 스윔레인이 업무량이 아닌 이름순 정렬**
- 근거: `WeeklyStatusTimeline.tsx:226-236` 본인만 최상단 고정, 나머지는 가나다순 — "누가 바쁜지" 확인이 이 패널의 핵심 목적인데 업무량 정렬 옵션이 없다.
- Fix: 정렬 기준 토글(이름순/업무량순) 추가.
- Suggested command: `/impeccable clarify`

**[P2] `MemberTodayTodos`의 "메모지" 시각 스타일이 나머지 3개 패널과 이질적**
- 근거: `MemberTodayTodos.tsx:305-306` — MacCard 기반 flat 카드 언어를 쓰는 다른 패널과 달리 이 탭만 "종이" 메타포(P0의 팔레트 문제와는 별개로 스타일 통일성 문제).
- Fix: 종이 컨셉을 유지하려면 토큰화 후 일관 적용, 아니면 flat 스타일로 되돌림.
- Suggested command: `/impeccable polish`

**[P2] 카드 전부 손수 조합 — `MacCard` 미사용 + 이중 중첩**
- 근거: `HomePage.tsx:298,311`, `WeeklyStatusTimeline.tsx:391`(부모가 이미 `bg-card border`인 안쪽에 또 `bg-card border rounded-2xl` — 이중 카드), `MemberTodayTodos.tsx:263`(`rounded-xl` 미니카드). CLAUDE.md D-004("카드는 MacCard") 위반, 라운딩도 카드 규격(`rounded-md`)과 불일치.
- Fix: `HomePage.tsx` 패널 wrapper와 두 컴포넌트를 `MacCard`로 전환, `WeeklyStatusTimeline`은 자체 카드 래핑 제거해 중첩 해소.
- Suggested command: `/impeccable polish`

**[P2] 아이콘 전용 버튼 title 누락 2건**
- 근거: `DayScheduleBoard.tsx:714`(`AddBlockMenu` 닫기, aria-label만), `WorkCalendar.tsx:463-469`(`DayDetailPopover` 닫기, aria-label만).
- Fix: 두 버튼에 `title="닫기"` 추가.
- Suggested command: `/impeccable harden`

**[P3] localStorage 키 접두어가 구 브랜드명(K8s Daily Monitor) 잔재**
- 근거: `DayScheduleBoard.tsx:175`(`k8s:dayScheduleScope:`), `WeeklyStatusTimeline.tsx:109`(`k8s:weekTimeline:rowsLimit`), `MemberTodayTodos.tsx:20`(`k8s:memberToday:itemLimit`) — `homeStore.ts`는 이미 `pep:` 접두어 사용.
- Suggested command: 다음 리브랜딩 정리 라운드로 이월.

**[P3] 네이티브 `<select>` 사용 — shadcn 컨벤션 이탈**
- 근거: `WeeklyStatusTimeline.tsx:354-362`("표시 인원"), `MemberTodayTodos.tsx:226-234`("인당 표시").
- Suggested command: `/impeccable polish`

**[P3] `status-critical` 토큰을 일요일 표기(장식용)에 재사용**
- 근거: `WorkCalendar.tsx:227,249` — 같은 화면 KPI의 "미해결 이슈"도 `status-critical`을 쓰므로 "빨강=경고" 스캔 규칙이 옅어진다.
- Suggested command: `/impeccable clarify`

## Persona Red Flags

**신규 입사자**: 4개 패널이 드래그/팝오버/펼치기/순환 등 서로 다른 인터랙션 모델을 쓰는데 온보딩 힌트가 없고, 리사이즈 핸들·삭제 버튼이 hover 전엔 보이지 않는다.

**온콜 엔지니어(시간에 쫓김)**: "오늘 내 일정만" 보는 기본 경로는 적절하지만, "다음 일정" KPI가 본인 것이 아닌 전사 데이터 기준이라 확인 차 열어보는 시간 낭비가 생길 수 있다.

**(프로젝트 특화) 운영 리드** (PRODUCT.md — 여러 클러스터/팀을 관리하는 operator/admin): "누가 과부하인가"를 확인하려면 이름순 스윔레인을 전부 스캔해야 하고, 색 매핑이 탭마다 달라 인지 부담이 배가된다. 표시 인원 옵션이 50명까지 있어 팀 규모가 커질수록 이 문제는 악화된다.

**Riley(키보드/스크린리더)**: 시간 블록 삭제/리사이즈에 키보드 경로가 전혀 없고, 삭제 버튼 자체가 포커스 시 시각적으로 나타나지 않는다.

## Minor Observations

- `detect.mjs`가 이번에도 대상 파일 전체에서 0건을 보고했다 — Assessment B가 원인을 추적한 결과, 이 스캐너는 풀페이지 HTML 기준 "AI-slop 시각 패턴" 위주로 설계돼 React 컴포넌트 소스나 이 프로젝트 고유의 토큰 위반은 탐지 범위 밖이다(`CronBadge.tsx`의 알려진 위반으로 sanity check해도 0건). 향후 라운드에서도 "0건 = 클린"으로 해석하면 안 된다.
- `schedule-bg-white`(`HomePage.tsx:291`)는 raw `bg-white`가 아니라 `index.css`에 정의된 테마 인식 커스텀 클래스로 확인됨 — 오탐 아님, 정상.
- 담당자 순환 화살표·표시 인원 설정 등 파워유저 기능은 풍부하나 온보딩 부재로 발견성이 낮다.

## Questions to Consider

- "업무 현황" 탭이 실제로 팀 전체를 보여주는 게 의도인지, 개인화가 기본이어야 하는지 — 라벨/기본값 중 하나를 정합성 있게 정해야 한다.
- `MemberTodayTodos`의 메모지 스타일은 의도된 차별화 디자인 결정인가, 아니면 마이그레이션 누락인가?
- 담당자 스윔레인 정렬을 업무량순으로 바꿀 경우 "본인 항상 최상단" 규칙과 어떻게 공존시킬 것인가?
