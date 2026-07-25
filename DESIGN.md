# DESIGN.md — UX/UI 운영 문서

> **역할**: PEP 의 UX/UI 를 **현행화 → 개선포인트 → 고도화** 사이클로 운영하는 단일 관리 문서.
> **운영 주체**: `.claude/agents/ux-ui-designer.md` (전담 UX/UI 디자이너 에이전트) — 절차는
> `.claude/skills/ux-ui-designer/SKILL.md` 를 따른다.
> **규격 원천과의 관계**: 토큰/팔레트/컴포넌트 **규격**은 `DESIGN_SYSTEM.md`, 화면 **명세**는
> `docs/SCREENS.md`. 이 문서는 그 규격이 실제 코드에 얼마나 적용돼 있는지 **점검·기록·운영**한다.

사용법 예시: "DESIGN.md 현행화해줘" / "디자인 감사 돌려줘" / "D-003 처리해줘".

---

## 1. 현행화 (Current State)

_최근 감사일: **2026-07-19** (1회차 — `frontend/src` 전수 grep 집계 + 구조 점검. pages 63 / components 도메인 폴더 33 / tsx·ts 384파일)_

### 1.1 디자인 시스템 요약

- **테마**: 다크 모드 "Ops Slate" (slate-900 배경 + status 4색) 기본, 라이트 macOS 팔레트 보조.
- **레이아웃**: MacCard 섹션 카드 + ClusterSidebar(iconOnly, 56px 레일) + 12-col Bento Health Hero.
- **타이포**: Inter(+Pretendard fallback) 본문 / JetBrains Mono 숫자·코드.
- **차트**: Bullet Chart(SVG) · Sparkline · CheckHistoryHeatmap — Gauge/Pie 비추천.
- **DESIGN_SYSTEM.md 적용 로드맵 상태**: W3(Health Hero)·W4(접근성 패스)·W5(차트 교체) 완료,
  W1(raw hex 전수 치환)·W2(shadcn 5종 도입) 진행 중.

### 1.2 정량 준수 지표 (스냅샷)

| 지표 | 건수 (2026-07-19) | 목표 | 비고 |
|---|---|---|---|
| JSX 내 raw hex 색상 | 130건 / 22파일 → Recharts/SVG 계열 이관 완료 | 화이트리스트 외 0 | D-005 처리: `--chart-1~8` 신설 + 4파일 이관. 잔존은 캔버스/three.js 허용 예외 |
| 인라인 `style={{...}}` | 220건 / 71파일 | 동적 계산 외 0 | 상위 파일은 그래프/캔버스 좌표 계산으로 정당. 색·배경 하드코딩성 인라인 혼재 (D-008) |
| 고정 팔레트(`text/bg-white·black·gray-*`) | ~~338건~~ **오탐 정정** → 실측 110건 (스크림 62 · 유색 배경 위 text-white 등 43 · gray-* 5) | gray-* 0 | D-003 처리: gray-* 5건 토큰 치환 완료. 스크림·유색 배경 위 text-white 는 허용 예외 |
| 카드/버튼의 컨벤션 외 라운딩 | 해소 | 토큰 기준 준수 | D-002 판정: `rounded-md`=radius 토큰이 정본, 문서를 현행화. D-006: button `sm` 라운딩 base 통일 |
| ClusterSidebar 비-iconOnly | **0건** (26개 사용처 전부 준수) | 0 | ✅ 완전 준수 |
| 페이지 내 `<select>` 클러스터 선택기 | **0건** | 0 | ✅ 완전 준수 (pages 의 select 40여 개는 전부 필터/폼/페이지네이션용) |
| MacCard 미사용 수제 카드 div | 116줄 / 약 20개 페이지 → 1차 트랜치 8개 카드 전환 | 수렴 | D-004 1차: Settings·InfraTopology·NodeImages 완료. 잔여는 2회차 감사에서 재산정 |
| 접근성 (`aria-*` / 아이콘 버튼 라벨) | 공용 컴포넌트 폴더 아이콘 버튼 100% 라벨 보유 | aria-label 병행 | D-007 처리: 공용 4개 폴더 전수 보강(33건). pages/ 하위는 2회차 감사에서 점검 |

### 1.3 허용 예외 (위반으로 세지 않음)

| 예외 | 사유 |
|---|---|
| three.js/canvas/Recharts 계열 파일의 hex (`FlowGraph3D`, `Topology*`, `*Chart*`, `*Timeline`, `KanbanSummaryCharts`) | CSS class 를 받을 수 없는 렌더러 — DESIGN_SYSTEM.md W1 화이트리스트 |
| 컬러픽커 기본값 prop (`defaultBg="#..."`) | 색상 값 자체가 데이터 |
| 외부 서비스 고유색 (Jira `#0052CC` 등) | `brand.*` 토큰 경유로 관리 |
| portal/tooltip 위치 계산 인라인 스타일 | 런타임 좌표 — Tailwind 로 표현 불가 |
| `bg-black/60` 모달 스크림 (~62건/20파일) | 레포 공통 모달 백드롭 컨벤션 — 테마 중립(양 테마 성립) |
| 유색 배경(status/primary) 위 `text-white` | 대비가 배경색으로 보장됨 |
| WebGL(ForceGraph3D) 엣지 alpha-hex (`#ffffff55` 등) | WebGL 링크 블렌딩이 alpha-hex 직접 파싱 — 토큰 이관 시 동작 보장 불가 (코드 주석 명시) |

---

## 2. 개선포인트 백로그 (Backlog)

상태: `대기` → `진행중` → `완료`/`보류`. ID 는 재사용 금지(행 삭제 금지, 상태만 갱신).
심각도: `높음`(사용성·접근성 실질 저해) / `중간`(일관성 훼손) / `낮음`(cosmetic).

| ID | 영역 | 문제 | 사용자 영향 | 심각도 | 상태 | 비고 |
|---|---|---|---|---|---|---|
| D-001 | 문서 정합성 | CLAUDE.md UI 섹션은 "macOS 라이트 기본"으로, DESIGN_SYSTEM.md 는 "다크 기본(Ops Slate)"으로 서술 — 기본 테마 서술 충돌 | 신규 화면 작업 시 기준 혼선 → 화면 간 톤 불일치 유발 | 중간 | 완료 | 실측: 기본값은 `'default'`(Claude 브랜드 톤), light/dark 는 Databricks 계열 대안. 양쪽 문서 서술 통일 (`6bac1cf`) |
| D-002 | 컴포넌트-문서 불일치 | `MacCard` 기본 'flat' variant 가 `rounded-md` 렌더 (`MacCard.tsx:66`) — 문서 컨벤션(카드 `rounded-2xl`, 기반 `card.tsx` 는 2xl)과 충돌 | 페이지마다 카드 라운딩이 달라져 시각 일관성 훼손. 신규 작업 시 기준 혼선 | 중간 | 완료 | 판정: `rounded-md` 는 `var(--radius)` 기반 **테마 인지 토큰**이라 코드가 규격상 옳음 → 문서 현행화로 해소. CLAUDE.md UI 섹션 전면 갱신 + frontend-page 스킬 문구 갱신 (`6bac1cf`) |
| D-003 | 다크모드 | 고정 팔레트(`text/bg-white·black·gray-*`) 338건/106파일 — `LakeServiceTypeManager`(18) `ServiceCategoryManager`(13) `WorkItemTableRow`(12) `WorkItemBoardPage`(10) 등 설정·워크아이템·서비스 도메인에 집중 | 다크모드에서 대비 저하·가독성 손상 가능 | 높음 | 완료 | **1차 감사 338건은 과대집계 오탐** — 상위 파일들은 기존 작업에서 이미 토큰화 완료 상태였음. 실측 잔존 gray-* 5건(3파일)만 `status-unknown` 토큰으로 치환 (`4c8ab30`). `bg-black/60` 모달 스크림 62건은 허용 예외 등재 |
| D-004 | 일관성 | 약 20개 페이지가 MacCard 없이 수제 카드 div(`bg-card border rounded-*`) 사용 — `SettingsPage`(9) `InfraTopologyPage`(7) `NodeImagesPage`(6) 등 | 카드 헤더·라운딩·구분선이 페이지마다 달라짐 | 중간 | 완료 | 1차 트랜치: Settings(4)·InfraTopology(1)·NodeImages(3) 섹션 카드 8개 전환 (`2868cb5`). stat 타일/리스트 행/모달 내부는 컨벤션대로 유지. 잔여 페이지는 2회차 감사에서 재산정 |
| D-005 | 시각화 토큰 | 차트·다이어그램 raw hex 130건/22파일 (`MindMapPage` 33 · `OntologyPage` 15 · `KanbanSummaryCharts` 9 등) — 허용 예외이나 색이 테마와 무관하게 고정 | 다크/라이트 전환 시 차트 대비 불균형 | 중간 | 완료 | `--chart-1~8` 토큰 신설(3테마) + Kanban/ClusterTrends/WeeklyTimeline/VersionGraph 이관, three.js 는 `chartTokenColor()` computed-style 헬퍼 (`7886815`). MindMap/Ontology/FlowGraph3D 캔버스는 허용 예외 유지 |
| D-006 | 컴포넌트 규격 | `button.tsx:22` `sm` variant 가 `rounded-lg` (base 는 `rounded-xl`) — 소형 버튼이 시스템 차원에서 라운딩 이탈 | 소형 버튼 톤 불일치 (경미) | 낮음 | 완료 | `sm` 의 `rounded-lg` 오버라이드 제거 → base `rounded-xl` 상속으로 통일 (`6bac1cf`) |
| D-007 | 접근성 | 아이콘 전용 버튼이 `title` 위주(718/1084) — `aria-label` 병행이 표준화돼 있지 않음 | `title` 은 스크린리더 지원 신뢰도가 낮아 보조기기 사용성 저하 | 중간 | 완료 | 규칙을 CLAUDE.md 컨벤션에 명문화 + 공용 컴포넌트 4개 폴더(common/layout/ui/dashboard) 전수 적용 — 18파일 33건 추가(기존 title 복제 21 + 신규 12). WorkCalendar 날짜 셀 `role="button"` 은 구조 리스크로 보류 기록 |
| D-009 | 일관성 | D-004 잔여 — MacCard 미사용 페이지 2차 트랜치: NodeLabels·KernelParams·McClient·TrendDigest·TodoToday·Versions·EtcdCtl·KnowledgeHub·JiraExcelImport (9개) | 카드 스타일 페이지별 상이 | 중간 | 완료 | 9개 페이지 섹션 카드 28건 전환 (`6b65c05`·`3d79624`·`a8256bd`). 보드/캔버스형(MindMap·Workflow·Ontology·PacketFlow·WbsFlow)과 HomePage 는 구조 리스크로 보류 — 별도 정성 리뷰(R-4)에서 판단 |
| D-010 | 접근성 | D-007 잔여 — pages/ 하위 아이콘 전용 버튼 aria-label 미병행 | 보조기기 사용성 저하 | 중간 | 완료 | pages/ 전수 스윕 완료 — 25파일 83건 추가 (A~J 17 · K~Z 59 · 잔여 9페이지 7). `IconBtn`(K8sManage) 공용 컴포넌트에 aria-label 기본 배선. 클릭 가능한 `<tr>`/`<th>` 행 네비게이션은 키보드 접근 불가로 보고만 — R-3 후보 |
| D-008 | 인라인 스타일 | 시각화 외 파일의 색·배경 인라인 하드코딩 혼재 (예: `MacCard.tsx:48` `style={{ background:'var(--mac-red)' }}` 류) | 토큰 우회 경로가 남아 테마 관리 어려움 | 낮음 | 완료 | MacCard 신호등 인라인 → Tailwind arbitrary 클래스, ViewModeBar 의 깨진 `color: var(--muted-foreground)` (HSL triplet 원시 사용 버그) 수정 (`6bac1cf`). 동적 좌표 계산은 허용 예외 유지 |

### R-4 1차 라운드 발견 (홈·대시보드·운영점검·업무 — 2026-07-20)

| ID | 영역 | 문제 | 사용자 영향 | 심각도 | 상태 | 비고 |
|---|---|---|---|---|---|---|
| D-011 | 상태색 토큰 | **상태색 고정 팔레트(`-400/-500`)가 4화면 전부에 재발** — Dashboard `statusColor`(59-64)·AddonCard 전반·툴바 버튼, HomePage KpiPill accent·DayScheduleBoard `STATUS_STYLE`(57-63), OpsCheckConsole `text-emerald-500`(305), WorkItemTableRow `KS_DOT/KS_TEXT/PRI_STYLES`·담당자칩·헤더배지 | `-400` 톤은 다크 기준이라 라이트/default 테마에서 대비 급락 + 화면마다 "같은 정상색"이 달라 스캔 학습 붕괴 | 높음 | 완료 | 4화면 전부 `--status-*` 토큰 전환 — Dashboard/AddonCard(`1d32d7e`), HomePage/DayScheduleBoard/WeeklyTimeline(`1d32d7e`), OpsCheck(`b31714d`), WorkItemBoard/Row(`f42ae63`). 무의미 구분색은 중립/`--chart-*`, Jira 브랜드색은 유지 |
| D-012 | 에러 상태 | API 실패를 빈 상태로 위장 — HomePage/DayScheduleBoard/WeeklyStatusTimeline `isError` 미처리, OpsCheckConsole 카탈로그 `isError` 무시하고 "항목 없음"(42,213) | 백엔드 장애·인증만료를 "정상이라 비어있음"으로 오인 → 실이슈 누락 | 높음 | 완료 | HomePage KpiPill·DayScheduleBoard·WeeklyTimeline·OpsCheck 카탈로그에 isError 분기(배너+재시도) 추가. 빈 상태는 성공+빈 배열일 때만 (`1d32d7e`·`b31714d`) |
| D-013 | 접근성 | 인라인 편집/클릭 요소 키보드 접근 불가 — WorkItemTableRow `EditableCell`(101-109) `td onClick`·담당자칩 span, (R-3 후보였던 클릭 `<tr>`/`<th>` 포함) | 마우스 없이 편집·행 이동 불가 — 핵심 워크플로가 키보드/스크린리더에 닫힘 | 높음 | 완료 | WorkItemTableRow EditableCell·담당자칩에 `role=button+tabIndex+onKeyDown(Enter/Space)+aria-label+focus:ring` (`f42ae63`). 클릭 `<tr>`/`<th>` 행 네비게이션은 R-3 로 이관 |
| D-014 | 인터랙션/안전 | OpsCheckConsole SSH(`batch_job`)·Ansible(`playbook`) 실행이 확인 없이 즉시 트리거(114-123,280) — 조회성 deep_check 와 동일 무확인 버튼 | 오클릭 시 실서버에 원격 명령. 전체선택 일괄실행 시 위험 규모 큼 | 높음 | 완료 | 사용자 결정: **모든 실행을 운영 위험 레벨로 간주**. 개별·선택 실행 전 ConfirmDialog(danger) — 클러스터명·건수 + 소스별(SSH/Ansible/점검/애드온) 대상 목록 요약. 즉시 실행 경로 제거 |
| D-015 | 접근성 | 색 단독 상태 전달 — OpsCheckConsole `lastStatus` StatusDot 만(267, 옆 텍스트는 시각뿐), CheckHistoryHeatmap 색만+화면 범례 없음(107) | 색맹·스크린리더 사용자가 과거 결과 정상/위험 판별 불가 | 중간 | 완료 | OpsCheck lastStatus 를 StatusBadge 로 교체(`b31714d`) + CheckHistoryHeatmap 상시 범례(색+라벨) 추가(색맹 안전). **완료** |
| D-016 | 일관성/레이아웃 | MacCard·ClusterSidebar 표준 이탈 — WorkItemBoardPage 3 wrapper 직접 `bg-card border rounded-xl`(610,622,643), Dashboard 행 `mx-auto px-3`(351)로 보조 사이드바 flush 규칙 위반 | 카드·레일 위치가 다른 화면과 어긋나 전환 시 점프 | 중간 | 완료 | WorkItemBoard wrapper 3곳 MacCard 전환(`f42ae63`), Dashboard 행 `mx-auto px-3`→`pr-3`(`1d32d7e`) |
| D-017 | 로딩 상태 | 로딩 비일관 — HomePage `useWorkItems` `isLoading` 미반영해 3필 "0"으로 튐(73), PlatformStatusMatrix 텍스트 로딩(170), WorkItemBoard skeleton 컬럼 미반영(621), HealthHero 스켈레톤 `rounded-2xl` 시프트 | 로딩→로드 전환 시 오정보·레이아웃 시프트 | 중간 | 완료 | HomePage `useWorkItems` isLoading 반영해 KPI 필 "…" 통일(`1d32d7e`). PlatformStatusMatrix 텍스트 로딩→매트릭스 구조 skeleton, WorkItemBoard 칸반 skeleton 을 실제 5컬럼(헤더+카드) 구조로, HealthHero 스켈레톤 `rounded-2xl`→`rounded-md` 토큰. **완료** |
| D-018 | 접근성/일관성 | OpsCheckConsole 상세 모달이 raw `fixed inset-0`(341) — Escape·포커스트랩·`role=dialog` 없음, `rounded-2xl` 레거시 | 키보드로 모달 열고닫기 불가, 배경 포커스 누수 | 중간 | 보류 | shadcn `Dialog` 로 교체(R-2 연계) — 리팩터 규모로 다음 라운드 |
| D-019 | 반응형/정확성 | 기타: HomePage work 모드 xl 미만 스크롤 중첩(171), OpsCheckConsole 테이블 `overflow-x` 컨테이너 부재(218), CheckHistoryHeatmap UTC `dayKey`(30-42)로 KST 날짜 경계 오프셋, 삭제 다이얼로그 문구/빈 따옴표(733), WIP 배지 ⚠ 이모지 의존(390) | 랩톱 폭 밀도 저하, 심야 점검 이력 오배치, 삭제 대상 오인 | 중간 | 완료 | 히트맵 KST dayKey(`62be648`)·삭제 다이얼로그 문구/빈 따옴표(`f42ae63`) 처리. HomePage work 모드 그리드 높이 채움을 xl 이상만 적용(xl 미만 패널 min-h+단일 스크롤)로 이중 스크롤 해소, OpsCheck 테이블 `overflow-x-auto`+min-w 래핑, WIP ⚠ 이모지→`AlertTriangle`(aria-label) 2곳(+Kanban WIP 배지 고정팔레트→status 토큰). **완료** |

### R-4 2차 라운드 발견 (K8s상세관리·K8s자원관리·일일점검리뷰·LAKE — 2026-07-20)

| ID | 영역 | 문제 | 사용자 영향 | 심각도 | 상태 | 비고 |
|---|---|---|---|---|---|---|
| D-020 | 상태색 토큰 | **상태색 고정 팔레트가 4화면 전부 재발** — K8sManage `CELL_BG/STATUS_TEXT`(30-35)·노드점·배지, K8sAllocation `EFF_BADGE`/`UtilPct`/`MeterBar`/`GaugeRow`/QoS·`text-white` 탭·Recharts hex(712)·축/툴팁 기본색, DailyCheckReview 하위 전 컴포넌트(DeepCheckGrid/TrendChart 범례·라인 hex/DiffPanel/배지/ExecutionStepsTimeline/ResourceTrendChecklist), LAKE `HealthBadge`(고정 emerald/amber/red) | 다크/라이트 톤 어긋남, 상태 판독성 저하 | 높음 | 완료 | 4화면 전부 `--status-*`/`--chart-*` 토큰 전환(K8sManage `38c089e`, 일일점검 `680ed2b`, K8sAllocation `5eab85a`, LAKE `242583e`). LAKE HealthBadge→공용 StatusBadge 래퍼. Recharts 색·축·툴팁 토큰화 |
| D-021 | 에러 상태 | API 실패를 정상 빈/점검 상태로 위장 — K8sManage `OverviewPanel`(578-606) isError 미처리→"노드 0·상태 점검", K8sAllocation `SummarySection`(387-398)·`PodScheduleCalc` isError 무시, DailyCheckReview review/trend isError 미처리→섹션 통째 사라짐 | 백엔드/인증 장애를 정상으로 오판 | 높음 | 완료 | K8sManage OverviewPanel·K8sAllocation SummarySection/PodScheduleCalc·DailyCheckReview review/trend 에 isError 분기 추가 — 빈/점검 위장 제거 (`38c089e`·`5eab85a`·`680ed2b`) |
| D-022 | 인터랙션/안전 | K8sManage 위험 동작이 브라우저 native — scale `window.prompt`(192), restart/delete/drain `window.confirm`(203/211/226). 테마·포커스·검증 UX 없음 | 되돌릴 수 없는 삭제/드레인/스케일이 무검증 native 팝업 — 오조작 위험 | 높음 | 완료 | scale/restart/delete/drain 모두 ConfirmDialog(danger, 대상 kind/ns/name 강조)로 교체, scale 은 다이얼로그 내 정수 입력. cordon/uncordon 은 되돌릴 수 있는 토글이라 즉시 실행 유지 (`d2979b0` 이후 커밋) |
| D-023 | 접근성 | 클릭 요소 키보드 미접근 — K8sAllocation 확장 `<tr>`(1054/1142) role/tabIndex/onKeyDown 없음, LAKE 카드 `<button>` 안에 `<span role=button>` 중첩(LakeServiceCard 60-79), K8sManage DetailDrawer(775) Escape/포커스트랩 없음 | 키보드/스크린리더로 드릴다운·드로어 조작 불가 | 중간 | 완료 | K8sAllocation 확장 tr(`5eab85a`)·LAKE 카드(`242583e`) + K8sManage DetailDrawer 에 `useModalA11y`(Escape·포커스 트랩) 적용. **완료** |
| D-024 | 접근성 | 색 단독 상태 — K8sManage 노드 Ready 점(988)·컨테이너 색칸(1103)이 색만(상태 텍스트는 title 툴팁뿐) | 색맹 사용자가 노드/컨테이너 정상·오류 구분 불가 | 중간 | 완료 | 노드 Ready 점→아이콘+aria-label, 컨테이너 색칸→role=img+aria-label (`38c089e`) |
| D-025 | 반응형 | 다열 테이블 overflow-x 부재(K8sManage Pods/Nodes/Resource grid), K8sAllocation 노드 카드 그리드 고정 열수(853)로 좁은 폭 짓눌림 | 좁은 뷰포트·다컬럼 시 판독 불가 | 중간 | 완료 | K8sManage 테이블 overflow-x-auto(`38c089e`) + K8sAllocation 노드 카드 그리드를 `minmax(min(220px,100%),1fr)`+가로 스크롤로 좁은 폭 대응. **완료** |
| D-026 | 접근성/일관성 | 자체 모달 raw `fixed inset-0`+`bg-black/40`+`rounded-2xl` (25파일/67곳) — Escape/포커스트랩/aria 부재, 테마 미적용 | 키보드로 모달 열고닫기 불가, 배경 포커스 누수 | 중간 | 완료 | **재사용 접근성 훅 `useModalA11y`(Escape·포커스 트랩·초점 이동/복원) 신설** + 공용 `ConfirmDialog`(앱 전역 확인 다이얼로그) 에 적용(role=dialog·aria-modal·aria-labelledby, main 과 독립 토큰화 병합)·운영점검 상세·일일점검 Schedule/Items 모달에 적용. **확산 완료: 폼/다이얼로그형 전용 모달 20종에 `useModalA11y` 부착(수동 Escape effect 제거·role=dialog/aria-modal/aria-labelledby 부여) — 1차 8종(AddLakeServiceModal·AddServiceInstanceModal·ProjectFormModal·ClusterUpdateDiffDialog·ImageDistributeDialog·PlaybookLogDialog·CreateBatchJobWizard·BatchJobSlideOver overlay) + 2차 페이지형/공용(Sprints 2·Users 2·InfraTopology 2(폼+삭제확인)·Settings 2·NodeSpec HostFacts·MindMap NodeEditor·LakeServiceTypeManager·ServiceCategoryManager·공용 SidePane). `useModalA11y` 사용 파일 38→55. 남은 `fixed inset-0` 16곳은 전부 드롭다운/팝오버 click-catcher·터미널(K9s/Pod)·캔버스·Base UI Dialog 프리미티브로 모달 아님(포커스 트랩 미대상). **완료** |
| D-027 | 로딩 상태 | 로딩이 "불러오는 중…" 텍스트뿐 — K8sManage 전 패널·DailyCheckReview 섹션. skeleton 부재로 레이아웃 점프 | 로딩→로드 시 시프트, 상태 인지 지연 | 낮음 | 완료 | K8sManage 에 공용 Skeleton 기반 `RowsSkeleton`(헤더 그리드 아래 행 자리표시) 신설 후 리소스/Nodes/Pods/Helm/CRD(목록·오브젝트) 패널 로더에 적용, 개요 패널은 3-스탯 카드 skeleton, DailyCheckReview AI 리뷰 로더는 텍스트 라인 skeleton 으로 교체. **완료** |
| D-028 | 잔여(낮음) | LAKE 인라인 style 그리드(136/158)·`hover:shadow-md`(22)·버튼 `rounded-lg`(222/231), DailyCheckReview 새로고침/삭제 aria-label 누락·`checkedAt` 툴팁 UTC 원본(129), K8sAllocation hover 전용 툴팁 키보드/터치 미접근(549/582) | 소소한 정합/접근성 이탈 | 낮음 | 완료 | LAKE 인라인 grid/shadow/rounded·일일점검 aria-label/KST(`242583e`·`680ed2b`) + K8sAllocation hover 툴팁을 button+group-focus-within 으로 키보드/터치 접근화. **완료** |
| D-029 | 내비게이션 | **전역 뒤로가기 버튼 부재** — 앱 셸이 사이드바만 있고 공통 헤더/뒤로가기 없음. 상세·폼의 "목록으로"는 고정 경로라 진짜 back 아님, 모달은 브라우저 히스토리 미연동 | 사용자가 이전 화면으로 돌아갈 전역 수단이 없음 (AI 생성 SPA 흔한 취약) | 중간 | 부분완료 | ① 사이드바 로고 하단에 전역 뒤로가기 버튼 — `navigate(-1)`(history.state.idx>0), 딥링크 진입 시 홈 fallback, 홈에선 숨김. ② `useModalA11y` 에 `historyClose` opt-in 추가 — hash 기반(React Router 협조, 인스턴스별 고유 hash+POP 판별로 중첩 안전)으로 **뒤로가기가 모달만 닫도록** 연동, 운영점검 상세·일일점검 Schedule/Items 모달에 적용. ③ **모달 접근성 확산 — 전용 모달 32개에 `useModalA11y`(Escape·포커스 트랩·role=dialog·aria-labelledby) 일괄 부착**(대다수 모달이 Escape 로도 못 닫히던 것 해소). **후속: `historyClose` 를 파일럿 3개 실측 후 확산분에도 일괄 플립, 목록 필터/탭 URL 저장** |
| D-030 | 정보구조/네이밍 | 사용자 제보 3건 — ① Settings "LAKE 타입" 탭명이 "LAKE" 라는 비일반적 용어 사용 ② "관리 서비스"(구 LAKE 타입) 안 "PEP 서비스" 서브탭 콘텐츠(빌트인 8종+카테고리4개, 전부 domain='pep' 하드코딩 시드)가 실제로는 "APP 서비스"에 해당 ③ Settings 최상위 "서비스"(PEP 서비스, `ServiceCatalogManager`)를 "관리 서비스→PEP 서비스" 서브탭으로 이동 | 탭 이름·정보구조가 실제 데이터/의미와 어긋나 혼란 | 중간 | 완료 | ①**완료** — 탭 id `lake-types`→`mgmt-service`, 라벨→"관리 서비스". ②**완료** — PEP=DevOps 관리 인프라(K8s/Cilium/Linux/Keycloak/Nexus/CI-CD/Prometheus/Grafana/AIStor/Network 10종 신규, 평면 목록), APP=사용자 서비스(기존 8종 domain pep→app 재배정 + DataHub 추가, 카테고리 Runtime/Catalog/Workbench/AI Ready). 백엔드 `_seed_default_service_categories` 를 멱등 마이그레이션(domain='pep' 인 것만 1회 전환 → 재시작 강제복원 제거)으로 재작성, 레거시 pep 카테고리 정리. PepServices/AppServices/문서 문구 동기화. ③**완료** — 최상위 "서비스"(PEP 서비스) 탭 제거, `ServiceCatalogManager` 를 "관리 서비스" 탭 내부 서브탭("서비스 타입"=LakeServiceType / "서비스 카탈로그"=ui_settings.serviceCatalog)으로 이동. 레거시 `?tab=service`→mgmt-service 리다이렉트. |

### R-4 3차 라운드 발견 (클러스터 정보 수정 `/cluster-manage/:id/edit` — 2026-07-25)

`ClusterMetaFormPage.tsx`(433행) 단일 화면 정성 리뷰 + 백엔드(`routers/clusters.py` `update_cluster`,
`schemas/cluster.py` `ClusterUpdate`) 대조. 사용자 요청("UX/UI 디자인 및 기능 버그 개선 점검").

| ID | 영역 | 문제 | 사용자 영향 | 심각도 | 상태 | 비고 |
|---|---|---|---|---|---|---|
| D-031 | 기능 버그 | **입력값을 지워서 저장할 수 없음** — `handleSubmit`(120-146)이 빈 문자열을 전부 `undefined` 로 직렬화(`region.trim() \|\| undefined` 등 22개 필드). `JSON.stringify` 가 `undefined` 키를 제거하고, 백엔드 `update_cluster` 는 `model_dump(exclude_unset=True)`(412행)라 **해당 필드를 아예 미수신 → 기존 값 유지**. 화면상으론 지워졌는데 저장 후 되돌아옴 | 잘못 입력한 CIDR/MAC/호스트명/설명을 **해제할 방법이 없음**. v1.13.0 에서 Batch Jobs 편집 폼에 대해 고친 것과 **동일한 버그 클래스** | 높음 | 완료 | 빈 입력을 `orNull()` 로 `null` 전송하도록 교체(24필드) + `ClusterManageUpdate` 타입에 `\| null` 반영. 요청 인터셉터 `convertKeysToSnake` 가 `null` 은 보존하고 `undefined` 만 유실되는 것, 대상 컬럼 24개가 전부 `nullable=True` 인 것 확인. 대조군: `bgpEnabled`/`prometheusEnabled` 는 boolean 이라 원래도 정상 동작 — 진단 확증 |
| D-032 | 기능 버그 | **로딩 상태 미처리로 입력 유실** — `useClusters()`(24행) 반환값을 버려 `isLoading`/`isError` 미사용. 스토어가 비면 `cluster` 가 undefined 인 채 **빈 폼이 그대로 렌더**되고(찾을 수 없음 분기는 `clusters.length > 0` 조건), 사용자가 입력하는 도중 목록이 도착하면 `hydrated=false` 라 hydration effect(62-90)가 **입력값을 서버값으로 덮어씀**. 이 시점 저장 버튼은 `if (!cluster) return`(116행)으로 **무반응** | 딥링크·느린 API 진입 시 입력이 소리 없이 사라지고 저장이 먹통. 조회 실패해도 에러 없이 빈 폼만 표시 | 높음 | 완료 | `useClusters()` 의 `isLoading`/`isError`/`refetch` 를 사용해 **로딩/조회실패/미발견 3분기** 신설 — 데이터 확정 전에는 폼 대신 폼 구조를 흉내낸 skeleton 을 렌더하므로 입력 유실·저장 무반응 경로가 사라짐. 조회 실패 시 "다시 시도" + 목록 이동 제공 |
| D-033 | 기능/에러 | **저장 실패 사유 은폐 + 입력 검증 부재** — `catch { setError('저장에 실패했습니다...') }`(150-152)가 실제 API 오류를 폐기(앱 공용 `formatApiError` 미사용). 동시에 CIDR/IP/MAC/AS Number 가 전부 자유 텍스트로 `pattern`·형식 검증 없음 | 잘못된 CIDR 로 422 를 받아도 무엇이 왜 틀렸는지 알 수 없어 수정 불가 | 높음 | 완료 | `formatApiError(err, fallback)` 로 교체해 백엔드 detail 노출 + **제출 시 형식 검증 15필드**(CIDR 3·IPv4 6·IP\|CIDR 2·MAC 2·AS Number) 신설 — 값이 있을 때만 검사(빈 값=해제는 통과), 실패 필드는 `aria-invalid`+테두리 강조+인라인 사유, 오류가 있는 첫 필드의 탭으로 자동 전환. 검증 규칙은 앱 기존 `parseCidrRange`(겹침 검사)와 동일 형식이라, 통과하는 값 = CIDR 계산기가 인식하는 값 |
| D-034 | 디자인 토큰 | **고정 팔레트 8곳** — N/W CIDR 탭 3개 섹션(`border-sky-500/20 bg-sky-500/5 text-sky-600`, `emerald-500`+`text-emerald-400`, `violet-500`+`text-violet-400`)과 기타 탭 Prometheus 섹션(`cyan-500`). 특히 `text-emerald-400`/`text-violet-400` 은 **다크 전용 톤**이라 default/light 테마에서 대비 부족 | 3테마 전환 시 이 화면만 톤이 어긋나고 섹션 라벨 판독성 저하 | 높음 | 완료 | 네트워크 도메인 3종(INTERNAL_IP/Pod/Service)+Prometheus 섹션을 categorical `chart-1~4` 토큰으로 전환(`border-chart-N/20 bg-chart-N/5 text-chart-N`) — 범주 구분이지 의미색이 아니므로 status 가 아닌 chart 계열 선택. 고정 팔레트 스캔 8건→**0건** |
| D-035 | 일관성 | **MacCard 미사용 + 라운딩/버튼 컨벤션 이탈** — 폼 전체가 손수 만든 `bg-card border border-border rounded-xl`(177행) 카드(CLAUDE.md D-004 금지 규칙), 입력·버튼 13곳이 `rounded-lg`(표준: 버튼/입력 `rounded-xl`, 카드 `MacCard`=`rounded-md`), 취소/저장이 shadcn `Button` 대신 raw `<button>` | 다른 화면과 카드 표면·모서리·버튼 높이가 어긋나 전환 시 점프 | 중간 | 완료 | 손수 만든 카드 div → `MacCard`(`bodyPadding="p-0"`) 전환, 입력 `rounded-lg`→`rounded-xl`(버튼/입력 표준)·내부 그룹 박스→`rounded-md`(테마 인지)로 정리, 취소/저장/재시도/뒤로가기를 shadcn `Button`(secondary/ghost/icon)으로 교체. `rounded-lg` 잔여 **0건**, raw `<button>` 은 자체 밑줄 스타일이 필요한 탭 1곳만 유지 |
| D-036 | 접근성 | **탭 ARIA 전무 + 에러 미고지** — 탭(200-219)에 `role="tablist"/"tab"/"tabpanel"`·`aria-selected`·좌우 화살표 이동 없음(그냥 `<button>` 3개), 에러 배너(222-226)에 `role="alert"` 없고 포커스 이동도 없음, `text-[10.5px]`(314행)은 임의 소수점 폰트크기 | 스크린리더가 탭 구조·저장 실패를 인지 못함, 11px 미만 텍스트 판독성 저하 | 중간 | 완료 | 탭에 WAI-ARIA tabs 패턴 적용 — `role=tablist/tab/tabpanel`·`aria-selected`·`aria-controls`/`aria-labelledby`·roving tabindex + ←/→·Home/End 키 이동. 에러 배너에 `role="alert"` 부여(저장 실패·검증 오류가 스크린리더에 즉시 고지), `text-[10.5px]`→`text-xs`. 임의 폰트크기 **0건** |
| D-037 | 데이터 안전 | **미저장 변경 이탈 경고 없음 + 저장 성공 피드백 없음** — 22개 필드 3탭 장문 폼인데 취소/뒤로가기/사이드바 이동 시 경고 없이 소실. 저장 성공 시 toast 없이 목록으로 즉시 이동(앱 공용 `useToast` 미사용) | 실수로 이탈하면 입력 전체 소실, 저장이 됐는지 확신 불가 | 중간 | 대기 | dirty 추적 → `ConfirmDialog` 이탈 확인 + 성공 toast |
| D-038 | 상태/URL | **활성 탭이 URL 에 없음** — `useState<TabId>('node')`(56행). 새로고침·공유·뒤로가기 시 항상 `노드 스펙` 탭으로 복귀 | 특정 탭을 공유/북마크 불가, 저장 실패 후 새로고침하면 작업 탭 잃음 | 중간 | 대기 | `useSearchParams` 로 `?tab=` 영속화 — **D-029 후속(필터·탭 URL 저장)과 동일 과제** |
| D-039 | 기능 버그(잠재) | **`hydrated` 가 클러스터 변경에 반응하지 않음** — 라우트(`App.tsx` 158행)에 `key` 가 없어 `/cluster-manage/A/edit` → `/cluster-manage/B/edit` 이동 시 컴포넌트가 재사용되고 `hydrated=true` 가 남아 **A 의 값이 표시된 채 B 를 저장**할 수 있음 | 브라우저 앞/뒤 이동·URL 직접 편집 경로에서 타 클러스터 값 덮어쓰기 위험 | 중간 | 대기 | hydration effect 의존성을 `cluster.id` 기준으로 바꾸거나 라우트에 `key={id}` 부여. UI 동선상 직접 이동 경로가 없어 재현 확률은 낮음(잠재) |
| D-040 | 문서 정합 | **SCREENS.md 가 존재하지 않는 기능을 기술** — "클러스터 정보 수정" 절(560·563·569행)이 Coroot APM 연동(`coroot_project`/`coroot_url`/`coroot_enabled` 매핑·토글)을 명시하지만, 해당 필드가 **백엔드 모델·스키마·프론트 타입·화면 어디에도 없음**(grep 0건) | 문서를 믿고 접근하는 후속 작업자가 없는 기능을 찾게 됨 | 낮음 | 완료 | SCREENS.md 에서 Coroot 기술 3곳 제거(목적/Backend 컬럼 목록/핵심 기능). 아울러 이번 라운드로 바뀐 화면 구조(MacCard·탭 ARIA·chart 토큰·로딩/에러 분기·null 해제·검증 15필드)를 같은 절에 현행화 |

---

## 3. 고도화 로드맵 (Roadmap)

| 테마 | 내용 | 선행 조건 | 상태 |
|---|---|---|---|
| R-1 토큰 정합 완결 | DESIGN_SYSTEM.md W1 마무리 — raw hex 전수 치환(화이트리스트 외 0건) | 백로그의 hex 관련 항목 처리 | 진행 중 |
| R-2 shadcn/ui 확산 | W2 — Button/Card/Badge/Tooltip/Dialog 5종 우선 도입, 기존 자체 컴포넌트 어댑터화 | R-1 | 진행 중 |
| R-3 접근성 상시화 | W4 성과(jsx-a11y 룰 상시화) 위에 sr-only 데이터 표·Lighthouse 정량 측정 추가 | - | 대기 |
| R-4 화면 단위 UX 리뷰 | docs/SCREENS.md 기준 주요 화면 순회 정성 리뷰 | 감사 1회차 완료 ✅ | 진행중 — 1차(홈·대시보드·운영점검·업무, D-011~D-019) 처리 완료(D-018 모달→Dialog 리팩터만 보류), 2차(K8s상세/자원관리·일일점검·LAKE, D-020~D-028) 완료. **3차(클러스터 정보 수정, D-031~D-040) 발견 등재 — 처리 대기**. 다음 라운드 후보: 클러스터 관리 목록·인프라 토폴로지·서비스 토폴로지·Pod 병목·Deep Check 정의 관리 등 |

---

## 4. 점검 이력 (Audit Log)

| 일자 | 범위 | 신규 | 해결 | 수행 | 비고 |
|---|---|---|---|---|---|
| 2026-07-19 | 체계 구축 + 1회차 전수 감사 (`frontend/src` grep 정량 + 구조 점검) | 8 (D-001~D-008) | 0 | ux-ui-designer | ClusterSidebar iconOnly·클러스터 select 금지 완전 준수 확인. 우선순위: D-002 → D-003 → D-004 → D-005 |
| 2026-07-19 | 백로그 전량 처리 (D-001~D-008) | 0 | 8 | ux-ui-designer | 문서 현행화(D-001/002)·차트 토큰 신설(D-005)·MacCard 수렴 1차(D-004)·aria-label 33건(D-007) 등. D-003 은 감사 오탐 정정 후 잔존 5건 처리. lint/tsc/build 전체 게이트 통과. PR #478 (머지, v1.7.0) |
| 2026-07-20 | 미진행분 2차 처리 (D-009·D-010) | 2 | 2 | ux-ui-designer | MacCard 2차 수렴 9페이지 28건 + pages aria-label 83건. 보류: 보드/캔버스형 페이지 MacCard(R-4 연계), 행 네비게이션 키보드 접근(R-3 연계). lint/tsc/build 게이트 통과 |
| 2026-07-20 | R-4 1차 라운드 — 화면 정성 리뷰 4화면 + 처리 (D-011~D-019) | 9 | 5.5 | ux-ui-designer | 홈·대시보드·운영점검·업무 리뷰로 32건 발견→9항목 등재. **완료** D-011(상태색 토큰 4화면)·D-012(에러상태)·D-013(편집셀 a11y)·D-016(MacCard/레이아웃)·D-019(KST·삭제문구). **부분** D-015·D-017. **보류** D-014(위험실행 확인·사용자 판단 필요)·D-018(모달 리팩터). lint/tsc/build 통과. 병렬 에이전트가 공유 워킹트리에서 `git stash` 로 충돌 → stash 복구로 무손실 수습(교훈: 다중 에이전트 파일수정은 worktree 격리 필요) |
| 2026-07-20 | D-014 처리 (사용자 결정: 모든 실행 = 운영 위험) | 0 | 1 | ux-ui-designer | 운영 점검 개별·선택 실행에 ConfirmDialog(danger, 대상·건수·소스 요약) 게이팅. lint/tsc/build 통과 |
| 2026-07-20 | R-4 2차 라운드 — 화면 정성 리뷰 4화면 + 처리 (D-020~D-028) | 9 | 6 | ux-ui-designer | K8s상세관리·K8s자원관리·일일점검·LAKE 리뷰로 발견 9항목 등재. **완료** D-020(상태색 토큰 4화면)·D-021(에러상태)·D-022(위험동작 ConfirmDialog)·D-024(색 단독). **부분** D-023·D-025·D-028. **보류** D-026(모달→Dialog)·D-027(skeleton). git 금지 조건으로 파일 소유 분리 병렬 처리 → 1차 stash 충돌 재발 없음. lint/tsc/build 통과 |
| 2026-07-20 | 잔여 중요항목 처리 — D-026 모달 접근성 | 0 | 0.5 | ux-ui-designer | 재사용 훅 `useModalA11y`(Escape·포커스 트랩·초점 복원) 신설 후 앱 전역 `ConfirmDialog`+운영점검 상세·일일점검 Schedule/Items 모달에 적용(role/aria-modal/aria-labelledby). PR #491 머지로 브랜치를 최신 main(v1.8.1) 재시작 후 재적용 — main 이 독립적으로 진행한 ConfirmDialog 토큰화와 충돌 1건(danger 색)은 main 선택(status-critical)으로 통일. 나머지 raw 모달 22곳은 점진 확산. lint/tsc/build 통과 |
| 2026-07-21 | 사용자 제보 — 전역 뒤로가기 부재 (D-029) | 1 | 0.5 | ux-ui-designer | 진단: 모달 히스토리 미연동(popstate 0건)·back 버튼 36개 중 navigate(-1) 2개·필터 URL 저장 10/63페이지. 1차 처리: 사이드바에 전역 뒤로가기 버튼 추가(history.state.idx 기반, 홈 fallback). 모달-히스토리 연동은 후속. lint/tsc/build 통과 |
| 2026-07-24 | 사용자 제보 — Settings 서비스 정보구조 (D-030) | 1 | 1 | ux-ui-designer | ①탭 개칭(LAKE 타입→관리 서비스) ②PEP/APP 도메인 재편(PEP=인프라 10종·APP=사용자서비스 4카테고리, 멱등 마이그레이션) — PR #525 머지. ③최상위 "서비스" 탭을 "관리 서비스" 내부 서브탭(서비스 타입/서비스 카탈로그)으로 이동. backend 테스트 순서의존 버그(pgvector)도 함께 수정. 전 게이트 통과 |
| 2026-07-24 | R-4 잔여 부분완료 항목 마무리 (D-015·D-023·D-025·D-028) | 0 | 4 | ux-ui-designer | 접근성/반응형 잔여분 완결: CheckHistoryHeatmap 상시 범례(색+라벨) 추가(D-015), K8sManage DetailDrawer 에 useModalA11y(Escape·포커스트랩·role=dialog) 적용(D-023), K8sAllocation 노드 카드 그리드 `minmax(min(220px,100%),1fr)`+가로 스크롤(D-025), K8sAllocation hover 툴팁(StatTooltip/PodScheduleCalc)을 button+group-focus-within 으로 키보드/터치 접근화(D-028). 네 항목 모두 완료 처리. lint/tsc/build 통과 |
| 2026-07-24 | R-4 잔여 로딩/반응형 항목 마무리 (D-017·D-019) | 0 | 2 | ux-ui-designer | 로딩 skeleton 구조화 — PlatformStatusMatrix 텍스트→매트릭스 구조 skeleton, WorkItemBoard 칸반→실제 5컬럼(헤더+카드) skeleton, HealthHero skeleton rounded-2xl→rounded-md(D-017). 반응형/a11y — HomePage work 모드 xl 미만 이중 스크롤 해소(그리드 높이 채움 xl 한정+패널 min-h), OpsCheckConsole 테이블 overflow-x-auto 래핑, WIP ⚠ 이모지→AlertTriangle(aria-label) 2곳+Kanban WIP 배지 고정팔레트→status 토큰(D-019). 두 항목 완료 처리. lint/tsc/build 통과 |
| 2026-07-24 | K8s상세관리·일일점검 로딩 skeleton (D-027) | 0 | 1 | ux-ui-designer | K8sManage 에 공용 Skeleton 기반 `RowsSkeleton`(헤더 그리드 아래 행 자리표시) 신설 후 리소스/Nodes/Pods/Helm/CRD(목록·오브젝트) 패널 로더 교체, 개요 패널은 3-스탯 카드 skeleton, DailyCheckReview AI 리뷰 로더는 텍스트 라인 skeleton. 텍스트 "불러오는 중…"→구조 skeleton 으로 레이아웃 시프트 감소. 항목 완료 처리. lint/tsc/build 통과 |
| 2026-07-24 | 모달 접근성 확산 1차 (D-026) | 0 | 0.3 | ux-ui-designer | 폼/다이얼로그형 전용 모달 8종(AddLakeServiceModal·AddServiceInstanceModal·ProjectFormModal·ClusterUpdateDiffDialog·ImageDistributeDialog·PlaybookLogDialog·CreateBatchJobWizard·BatchJobSlideOver overlay)에 useModalA11y 적용 + role/aria-modal/aria-labelledby 부여, 수동 Escape effect 통합 제거. useModalA11y 사용 파일 38→46. 남은 fixed inset-0 다수는 드롭다운/팝오버/터미널로 모달 아님. 잔여 페이지형 모달·SidePane 은 다음 라운드. lint/tsc/build 통과 |
| 2026-07-25 | 클러스터 정보 수정 — 디자인 시스템·접근성·문서 처리 (D-034·D-035·D-036·D-040) | 0 | 4 | ux-ui-designer | 표현·접근성 계열 일괄 처리. 고정 팔레트 4섹션→categorical `chart-1~4` 토큰(스캔 8건→0), 수제 카드→`MacCard`+입력 `rounded-xl`/그룹박스 `rounded-md`+shadcn `Button`(`rounded-lg` 잔여 0), 탭 WAI-ARIA(tablist/tab/tabpanel·roving tabindex·←/→·Home/End)+에러 `role="alert"`+`text-[10.5px]`→`text-xs`(임의 폰트 0). SCREENS.md 의 Coroot 오기재 3곳 제거 + 이번 라운드 화면 구조 현행화. lint/tsc/build 통과 |
| 2026-07-25 | 클러스터 정보 수정 — 기능 버그 3건 처리 (D-031·D-032·D-033) | 0 | 3 | ux-ui-designer | 3차 라운드 중 심각도 높음 3건을 한 배치로 수정(같은 파일·상호 연관). ①빈 입력 `undefined`→`null` 24필드(타입도 `\| null`) — 값 해제가 실제로 저장됨 ②로딩/조회실패/미발견 3분기 + skeleton — 입력 유실·저장 무반응 제거 ③`formatApiError` + 형식 검증 15필드(인라인 오류·오류 탭 자동 전환). 사전 검증: 인터셉터가 `null` 보존, 대상 컬럼 전부 nullable, 검증 규칙이 기존 `parseCidrRange` 와 동일 형식. lint/tsc/build 통과 |
| 2026-07-25 | R-4 3차 라운드 — 클러스터 정보 수정(`/cluster-manage/:id/edit`) 정성 리뷰 (D-031~D-040) | 10 | 0 | ux-ui-designer | 사용자 요청 점검. 화면 코드(433행) + 백엔드 `update_cluster`/`ClusterUpdate` 스키마 대조로 **확인된 기능 버그 3건(높음)**: ①빈 값 저장 불가(undefined 직렬화 × `exclude_unset=True`) ②로딩 미처리로 입력 유실·저장 무반응 ③실패 사유 은폐+검증 부재. 그 외 고정 팔레트 8곳(다크 전용 톤 포함)·MacCard/라운딩 이탈·탭 ARIA 전무·이탈 경고 없음·탭 URL 미저장·`hydrated` 클러스터 미반응(잠재)·SCREENS.md Coroot 기술 오류(코드 0건). 코드 변경 없음 — 등재만 |
| 2026-07-24 | 모달 접근성 확산 2차 — D-026 완료 | 0 | 0.7 | ux-ui-designer | 페이지형/공용 모달 12종(Sprints 2·Users 2·InfraTopology 폼+삭제확인·Settings 클러스터/관리서버·NodeSpec HostFacts·MindMap NodeEditor·LakeServiceTypeManager·ServiceCategoryManager·공용 SidePane)에 useModalA11y 적용. SidePane 은 disableEscape 존중 래핑. InfraTopology 삭제확인의 red 고정팔레트도 status 토큰화. useModalA11y 사용 파일 46→55, 남은 fixed inset-0 16곳은 전부 비모달(드롭다운/팝오버/터미널/Dialog 프리미티브) 확인 → D-026 완료. lint/tsc/build 통과 |
