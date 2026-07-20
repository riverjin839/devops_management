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

---

## 3. 고도화 로드맵 (Roadmap)

| 테마 | 내용 | 선행 조건 | 상태 |
|---|---|---|---|
| R-1 토큰 정합 완결 | DESIGN_SYSTEM.md W1 마무리 — raw hex 전수 치환(화이트리스트 외 0건) | 백로그의 hex 관련 항목 처리 | 진행 중 |
| R-2 shadcn/ui 확산 | W2 — Button/Card/Badge/Tooltip/Dialog 5종 우선 도입, 기존 자체 컴포넌트 어댑터화 | R-1 | 진행 중 |
| R-3 접근성 상시화 | W4 성과(jsx-a11y 룰 상시화) 위에 sr-only 데이터 표·Lighthouse 정량 측정 추가 | - | 대기 |
| R-4 화면 단위 UX 리뷰 | docs/SCREENS.md 기준 주요 화면(홈/대시보드/업무/점검 콘솔) 순회 정성 리뷰 | 감사 1회차 완료 ✅ | 착수 가능 |

---

## 4. 점검 이력 (Audit Log)

| 일자 | 범위 | 신규 | 해결 | 수행 | 비고 |
|---|---|---|---|---|---|
| 2026-07-19 | 체계 구축 + 1회차 전수 감사 (`frontend/src` grep 정량 + 구조 점검) | 8 (D-001~D-008) | 0 | ux-ui-designer | ClusterSidebar iconOnly·클러스터 select 금지 완전 준수 확인. 우선순위: D-002 → D-003 → D-004 → D-005 |
| 2026-07-19 | 백로그 전량 처리 (D-001~D-008) | 0 | 8 | ux-ui-designer | 문서 현행화(D-001/002)·차트 토큰 신설(D-005)·MacCard 수렴 1차(D-004)·aria-label 33건(D-007) 등. D-003 은 감사 오탐 정정 후 잔존 5건 처리. lint/tsc/build 전체 게이트 통과. PR #478 (머지, v1.7.0) |
| 2026-07-20 | 미진행분 2차 처리 (D-009·D-010) | 2 | 2 | ux-ui-designer | MacCard 2차 수렴 9페이지 28건 + pages aria-label 83건. 보류: 보드/캔버스형 페이지 MacCard(R-4 연계), 행 네비게이션 키보드 접근(R-3 연계). lint/tsc/build 게이트 통과 |
