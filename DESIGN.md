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
| JSX 내 raw hex 색상 | 130건 / 22파일 | 화이트리스트 외 0 | 거의 전량 차트·SVG·3D 시각화 색 상수(허용 예외) — 단 `--chart-*` 토큰화 시 다크모드 대비 개선 여지 (D-005) |
| 인라인 `style={{...}}` | 220건 / 71파일 | 동적 계산 외 0 | 상위 파일은 그래프/캔버스 좌표 계산으로 정당. 색·배경 하드코딩성 인라인 혼재 (D-008) |
| 고정 팔레트(`text/bg-white·black·gray-*`) | 338건 / 106파일 | 0 | 설정·워크아이템·서비스 도메인 컴포넌트에 집중 — 다크모드 대비 저하 위험 (D-003) |
| 카드/버튼의 컨벤션 외 라운딩 | 카드성 87건 · 버튼 33건 | 0 | **MacCard 기본(flat)이 `rounded-md`** 로 문서(rounded-2xl)와 불일치 (D-002), button `sm` variant `rounded-lg` (D-006) |
| ClusterSidebar 비-iconOnly | **0건** (26개 사용처 전부 준수) | 0 | ✅ 완전 준수 |
| 페이지 내 `<select>` 클러스터 선택기 | **0건** | 0 | ✅ 완전 준수 (pages 의 select 40여 개는 전부 필터/폼/페이지네이션용) |
| MacCard 미사용 수제 카드 div | 116줄 / 약 20개 페이지 | 수렴 | SettingsPage·InfraTopologyPage·NodeImagesPage 등 (D-004) |
| 접근성 (`aria-*` / 아이콘 버튼 라벨) | aria 사용 파일 43% · 버튼 1084개 중 `title` 718 | aria-label 병행 | `title` 위주 정착 — 스크린리더 신뢰도 위해 `aria-label` 병행 표준화 (D-007) |

### 1.3 허용 예외 (위반으로 세지 않음)

| 예외 | 사유 |
|---|---|
| three.js/canvas/Recharts 계열 파일의 hex (`FlowGraph3D`, `Topology*`, `*Chart*`, `*Timeline`, `KanbanSummaryCharts`) | CSS class 를 받을 수 없는 렌더러 — DESIGN_SYSTEM.md W1 화이트리스트 |
| 컬러픽커 기본값 prop (`defaultBg="#..."`) | 색상 값 자체가 데이터 |
| 외부 서비스 고유색 (Jira `#0052CC` 등) | `brand.*` 토큰 경유로 관리 |
| portal/tooltip 위치 계산 인라인 스타일 | 런타임 좌표 — Tailwind 로 표현 불가 |

---

## 2. 개선포인트 백로그 (Backlog)

상태: `대기` → `진행중` → `완료`/`보류`. ID 는 재사용 금지(행 삭제 금지, 상태만 갱신).
심각도: `높음`(사용성·접근성 실질 저해) / `중간`(일관성 훼손) / `낮음`(cosmetic).

| ID | 영역 | 문제 | 사용자 영향 | 심각도 | 상태 | 비고 |
|---|---|---|---|---|---|---|
| D-001 | 문서 정합성 | CLAUDE.md UI 섹션은 "macOS 라이트 기본"으로, DESIGN_SYSTEM.md 는 "다크 기본(Ops Slate)"으로 서술 — 기본 테마 서술 충돌 | 신규 화면 작업 시 기준 혼선 → 화면 간 톤 불일치 유발 | 중간 | 대기 | 실제 기본값(`themeStore` fallback) 확인 후 한쪽으로 통일 |
| D-002 | 컴포넌트-문서 불일치 | `MacCard` 기본 'flat' variant 가 `rounded-md` 렌더 (`MacCard.tsx:66`) — 문서 컨벤션(카드 `rounded-2xl`, 기반 `card.tsx` 는 2xl)과 충돌 | 페이지마다 카드 라운딩이 달라져 시각 일관성 훼손. 신규 작업 시 기준 혼선 | 중간 | 대기 | 문서 또는 컴포넌트 중 한쪽으로 현행화 결정 필요 — 감사 1회차 우선순위 #1 |
| D-003 | 다크모드 | 고정 팔레트(`text/bg-white·black·gray-*`) 338건/106파일 — `LakeServiceTypeManager`(18) `ServiceCategoryManager`(13) `WorkItemTableRow`(12) `WorkItemBoardPage`(10) 등 설정·워크아이템·서비스 도메인에 집중 | 다크모드에서 대비 저하·가독성 손상 가능 | 높음 | 대기 | 집중 파일부터 `text-foreground`/`bg-card`/`text-muted-foreground` 토큰으로 치환 |
| D-004 | 일관성 | 약 20개 페이지가 MacCard 없이 수제 카드 div(`bg-card border rounded-*`) 사용 — `SettingsPage`(9) `InfraTopologyPage`(7) `NodeImagesPage`(6) 등 | 카드 헤더·라운딩·구분선이 페이지마다 달라짐 | 중간 | 대기 | MacCard 로 점진 수렴 (frontend-page 스킬 컨벤션) |
| D-005 | 시각화 토큰 | 차트·다이어그램 raw hex 130건/22파일 (`MindMapPage` 33 · `OntologyPage` 15 · `KanbanSummaryCharts` 9 등) — 허용 예외이나 색이 테마와 무관하게 고정 | 다크/라이트 전환 시 차트 대비 불균형 | 중간 | 대기 | `hsl(var(--chart-*))` 토큰 체계로 이관 (DESIGN_SYSTEM.md W1 화이트리스트 축소) |
| D-006 | 컴포넌트 규격 | `button.tsx:22` `sm` variant 가 `rounded-lg` (base 는 `rounded-xl`) — 소형 버튼이 시스템 차원에서 라운딩 이탈 | 소형 버튼 톤 불일치 (경미) | 낮음 | 대기 | variant 정의 1곳 수정으로 전체 해소 가능 |
| D-007 | 접근성 | 아이콘 전용 버튼이 `title` 위주(718/1084) — `aria-label` 병행이 표준화돼 있지 않음 | `title` 은 스크린리더 지원 신뢰도가 낮아 보조기기 사용성 저하 | 중간 | 대기 | 아이콘 버튼 `aria-label` 병행을 규칙화 + 점진 적용 (R-3 연계) |
| D-008 | 인라인 스타일 | 시각화 외 파일의 색·배경 인라인 하드코딩 혼재 (예: `MacCard.tsx:48` `style={{ background:'var(--mac-red)' }}` 류) | 토큰 우회 경로가 남아 테마 관리 어려움 | 낮음 | 대기 | 폼/모달류 파일 선별 정리 — 동적 좌표 계산은 허용 예외 유지 |

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
