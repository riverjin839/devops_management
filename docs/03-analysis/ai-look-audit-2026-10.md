## PEP 화면 "AI 개발티" 조합 수준 감사 (2026-10)

> 범위: `frontend/src` 전수(pages 72 · components 약 300). 수행: claude-code, 2026-10-13.
> 백로그: `DESIGN.md` R-4 10차 라운드 **D-117 ~ D-134**. 규칙: `DESIGN_SYSTEM.md` §12.12.
> 수치는 grep 집계라 ±5% 오차가 있다. 경로는 전부 `frontend/src/` 기준이다.

## 판정

PEP 는 원자 수준에서는 이미 방어선이 있다. 토큰만 쓰기, raw hex 금지, MacCard flat, ClusterSidebar iconOnly, 콘솔 패턴, 상태 팔레트 lint 가 그것이다. 카피에도 마케팅 문구("환영합니다", "효율적으로 관리하세요", "Get started")가 사실상 없다. 홈 화면은 카드 2개짜리로 담백하다.

그런데도 AI 티가 난다. 원인은 **조합 수준**에 있다. 페이지마다 같은 헤더 템플릿(아이콘 타일 + 굵은 제목 + 회색 부제)이 반복되고, KPI 타일 행이 14개 페이지에 복붙돼 있고, "정상"이 "위험"만큼 요란하게 칠해져 있고, 카테고리 구분용 무지개 팔레트가 lint 의 사각지대에서 자라났고, 카드가 한 문단과 빈 상태까지 감싸고, 콘솔과 문서가 같은 밀도로 그려지고, 빈 상태가 다섯 가지 방식으로 구현돼 있고, 이모지가 아이콘과 상태를 대신하고, 용어가 한영 혼재다. 이 중 어느 것도 `DESIGN_SYSTEM.md` §12 가 다루지 않는다. §12 는 원자(테마·라운딩·MacCard·사이드바·콘솔·권한)만 규정한다.

결론은 두 가지다. 첫째, 조합 규칙을 §12.12 로 명문화한다. 둘째, 규칙을 기계로 강제할 공용 부품(PageHeader·StatTile·EmptyState 전면 적용) 과 lint 확장을 백로그로 등재해 순서대로 처리한다.

## "AI 개발티"의 정의 (7범주)

| # | 범주 | 증상 |
|---|---|---|
| 1 | 레이아웃 | 전부 카드, 전부 그리드. KPI 타일 4개 한 줄 + 2열 그리드 + 표. 가운데 정렬 + 넉넉한 여백. 밀도 개념 없음 |
| 2 | 색 | 그라데이션·글래스. Tailwind 기본 팔레트. 색을 의미가 아니라 장식으로. 강조색 서너 개 |
| 3 | 타이포 | 위계 없음. 제목이 크고 많음. 카드 제목을 본문 h2 로 반복. 숫자 정렬·단위 무시 |
| 4 | 반복 패턴 | 아이콘 + 제목 + 설명 삼중주가 수십 번. 배지·pill 이 필요와 무관하게 부착. hover 에 scale |
| 5 | 카피 | 사람이 안 쓴 말. 이모지 제목. 빈 상태가 "없습니다 🎉". 도메인 용어 대신 일반어 |
| 6 | 일관성 | 페이지마다 다른 사람이 만든 듯 헤더·여백·버튼 위치가 다름. 한 페이지 안에서는 과하게 균일 |
| 7 | 정보 설계 | 뭘 봐야 하는지 안내 없음. 점진적 공개 없음. 정상과 비정상이 같은 비중 |

## 감사 방법

- 서브에이전트 3축으로 병렬 탐색: (1) 레이아웃·밀도·조합, (2) 색·타이포·장식·아이콘, (3) 카피·IA·문서 프로세스.
- 각 축은 grep 정량 집계 + 대표 파일 코드 읽기. 핵심 주장 10건은 본 문서 작성 전에 `grep -n` 으로 재확인했다(아이콘 타일 15회, h1 64/22종, `bg-card`+`rounded-xl` 195, 아이브로우 177, hover-lift 9, 장식 팔레트 329 등).
- 브라우저 스크린샷은 수행하지 않았다. 샌드박스에 클러스터가 없어 데이터 화면이 전부 빈 상태로만 렌더된다. 전/후 비교 절차는 §재검증 체크리스트에 남긴다.

## 발견 사항

### 1. 페이지 헤더 — 공용 컴포넌트가 없다 → D-117

- `components/` 에 PageHeader·PageTitle 이 없다. 결과: `<h1>` 64개가 **22가지 class 문자열**, 6가지 크기로 흩어져 있다.
  - `text-xl font-bold` 약 25 · `text-lg font-semibold` 약 18 · `text-xl font-semibold` 6
  - `text-3xl font-bold tracking-tight`: `pages/OpsNoteFormPage.tsx:31`, `CommandFormPage.tsx:48`, `OpsNoteDetailPage.tsx:107`
  - `text-2xl`: `WorkGuidePage.tsx:438,459` · `text-base`: `LoginPage:52`, `OntologyPage:328`, `VersionGraphPage:208`
  - `text-sm` uppercase "DEVOPS MANAGEMENT": `Dashboard.tsx:333` — D-069 로 폐기된 구 브랜드가 h1 으로 남아 있다.
- h1 이 없는 페이지 11: HomePage · ObservabilityPage(`:141` MacCard 제목이 대신) · K8sEventsPage · AlertInboxPage · ServiceArchitecturePage · WorkItemDetailPage · WorkItemFormPage · WorkflowBoardPage · MindMapPage 등. 31개 페이지는 첫 MacCard 제목이 사실상 페이지 제목 역할을 한다.
- h1 앞 아이콘 약 45/64. 그중 **동일한 아이콘 타일** `w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center` + `w-5 h-5 text-primary` 가 15회: 페이지 `BatchJobsPage.tsx:189`, `OpsNotesPage.tsx:352`, `KnowledgeHubPage.tsx:339`, `WbsFlowPage.tsx:685`, `CiliumTracePage.tsx:219` + 모달 `ConfluenceImportModal:178`, `JiraImportModal:228`, `AddAppDialog:43`, `QuickAddTaskModal:264` 등. 변형(`w-9 rounded-md`, `w-10 rounded-xl border`, `w-9 rounded-lg ring`)까지 합치면 28회/22파일.
- 회색 부제 `<p className="text-xs|text-sm text-muted-foreground">` 가 h1 바로 아래 27개 페이지. 나머지는 없다.
- 뒤로가기 헤더가 2종이다. pill 형(`rounded-xl border bg-card` + ArrowLeft): `ClusterDetailPage:62-65`, `OpsCheckConsolePage:31-34`, `DailyCheckReview:93`, `CheckItemDetailPage`, `DeepCheckSettings`, `PodBottleneckDetailPage`, `K8sLogsPage`. 텍스트 링크형: `K8sAllocationPage:91-95`(아이콘이 `text-status-warning`). `OpsCheckConsolePage:30-50` 은 `ClusterDetailPage:61-79` 의 복제다.

### 2. KPI 타일 — 14개 페이지, 로컬 구현 10종 이상, 공용 Stat 없음 → D-118

| 페이지 | 위치 | 모양 |
|---|---|---|
| Dashboard | `components/dashboard/HealthHero.tsx:107-115` | Bento. `text-5xl font-mono` 히어로 + KpiCell 4개(각각 MacCard 통째) |
| SettingsPage | `pages/SettingsPage.tsx:855-884` | **설정 탭에** 상태 KPI 4개. 아이콘이 의미와 불일치(Clock=Warning, Globe=Critical) |
| InfraTopologyPage | `:826-845` | 5개 |
| TodoTodayPage | `:375-382` | `grid-cols-4` |
| DocumentsPage | `:141-157` | 클릭 가능 4개 |
| NodeImagesPage | `:89-96` + `SummaryTile :193` | 4개 |
| OpsNotesPage | `:380-385` + `StatCell :583` | 아이콘 타일 포함 4개 |
| WbsFlowPage | `:221` + `SummaryStat :272` | 아이콘 타일 포함 4개 |
| CiliumTracePage | `:300` + `StatusCell :337` | 아이콘 타일 포함 4개 |
| ClusterLinksPage | `:563-567` + `StatTile :666` | 헤더 카드 안 3개 |
| K8sManagePage | `:729-733`, `:763-767` | Stat 이 MacCard 통째, `text-3xl` |
| CidrCalculatorPage | `:599-604` + `StatTile :199` | MacCard 안 4개 |
| K8sAllocationPage | `components/k8s-allocation/SummarySection.tsx:48`, `PodCapacityStatusCards.tsx:38,55` | 7열 + 3+3 |
| Settings 백업 탭 | `components/settings/BackupRestorePanel.tsx:154-170` | 4개 |

- `OpsNotesPage.tsx:585`, `CiliumTracePage.tsx:339`, `WbsFlowPage.tsx:274` 세 곳은 `rounded-2xl border border-border bg-card px-4 py-3 flex items-center gap-3` 로 **바이트 단위 동일**하다.
- `HealthHero.tsx:103-108` 은 KPI 셀을 항상 상태색으로 그린다. "위험 0" 도 빨간 `text-3xl` 이다.
- 반례: `WeeklyReportPage.tsx:298-317` 은 요약을 한 줄 표로 처리한다. 이쪽이 맞다.

### 3. "정상"이 "위험"만큼 시끄럽다 → D-119

- `pages/Dashboard.tsx:61-98` healthy 클러스터 카드는 초록을 다섯 번 쓴다. `border-status-healthy/40` 보더, `bg-status-healthy/10` 아이콘 타일, `text-status-healthy` 아이콘, `bg-status-healthy` 점, 초록 "정상" pill. critical 과 정확히 같은 무게다. 클러스터는 상태순 정렬이 없고, 대시보드 7개 섹션(`:412,420,449,501,525,559,570`)이 동일 무게로 쌓인다.
- `status-healthy` 토큰 사용 624회. `AddonCard.tsx` 한 파일에 healthy 색 span 14개(`:289,293` "Synced"/"Healthy" 카운트).
- 상태색이 다른 의미로 전용됐다. `components/layout/navConfig.ts:54-55` Observability 아이콘은 항상 초록, Alerts 는 항상 빨강. `:20-23,53` 은 `text-orange-500`/`text-cyan-500`. `lib/statusColors.ts:23-43` 업무 진행중=warning(amber), 완료=healthy. `Dashboard.tsx:358` "+ 메트릭" 버튼이 `brand-ai` 보라(AI 배지 전용). `K8sAllocationPage:95` 페이지 제목 아이콘이 `text-status-warning`.

### 4. 색 — 두 번째 무지개 팔레트 → D-120, D-132

- `.eslintrc.cjs:5` `STATUS_PALETTE_RE` 는 emerald·green·red·rose·amber·yellow·sky 만 막는다. 주석이 "장식용 계열(blue·violet·purple·orange·cyan 등)과 slate 콘솔 배경은 대상이 아니다" 라고 **의도적으로 제외**한다. 그래서 status 계열은 거의 0인데 나머지는 그대로다: blue 128 · orange 76 · zinc 63 · slate 49 · purple 34 · violet 31 · indigo 21 · cyan 18 · pink 16 · fuchsia 4 · teal 3. 장식 7계열만 329건.
- 카테고리 무지개: `WbsFlowPage.tsx:54-62`(keycloak 보라·nexus 주황·cilium 청록·backend 남색·frontend 분홍·monitoring 틸), `OpsNotesPage.tsx:29-44`(`bg-orange-500|blue-500|violet-500` + `text-white` 칩 `:84`), `KnowledgeHubPage.tsx:51-72`, `hooks/useOperationLevels.ts:72-78`, `components/services/serviceCatalog.ts:98-105`, `WorkflowBoardPage.tsx:34-47`, `PacketFlowPage.tsx:24-29`, `CidrCalculatorPage.tsx:237-239`, `MindMapPage.tsx:36-58`(기본색 `#6366f1` = indigo-500, 전형적 "AI 인디고"), `OntologyPage.tsx:11-17`(hex).
- 상태 의미인데 토큰을 우회한 것: `auth_error: 'bg-orange-500/10 text-orange-400 …'` 가 7곳에 복붙 — `EtcdCtlPage:21`, `McClientPage:19`, `BulkExecPage:24`, `KernelParamsPage:122`, `NodeSshPage:24`, `node-images/ImageDistributeDialog:39`, `batch-jobs/StatusPill:13`. running=`bg-blue-500`(`BatchJobFilters:38`, `PlaybookListRow:22`), pending=`bg-slate-400`(`ClusterSidebar:72`, `dashboard/StatusBadge:55`).
- 기본 라이트 테마에서 `text-blue-400` 18건, `text-orange-400` 10건은 흰 카드 위 저대비다.
- 대비 보장 토큰(`--status-*-text`)을 건너뛴 `text-[hsl(var(--status-*))]` 51회/11파일: `common/StatusBadge.tsx:39-45`, `observability/shared.tsx:7-27`, `ObservabilityPage.tsx:360-362` 등. (`AlertInboxPage` 는 D-116 이 이미 다룬다.)
- 라운딩·그림자 외 장식: 로고 `bg-gradient-to-br from-primary to-status-info text-white … hover:scale-105 active:scale-95` 가 `layout/Sidebar.tsx:374`, `LoginPage.tsx:48`(☸ 이모지 포함), `ChangePasswordPage.tsx:68`, `SettingsPage.tsx:713` 에 반복. primary(200°)와 info(199°)는 색상이 거의 같아 그라데이션 의미가 없다. 글래스 패널 `rounded-2xl bg-card/90 backdrop-blur-md`: `MindMapPage:786,964,999,1314`, `OntologyPage:477`, `ServiceTopologyPage:586`. (모달 스크림 `bg-black/50 backdrop-blur-sm` 약 20건은 허용 예외.)

### 5. 라운딩·그림자·모션 → D-121

- `bg-card` 와 결합한 라운딩: `rounded-xl` **195** · `rounded-lg` 80 · `rounded-2xl` 75 · `rounded-md` **34**. 규칙값이 꼴찌다. 예: `CommandFormPage:56`, `WorkItemDetailPage:127,136`, `OpsNoteDetailPage:110,119`, `SprintsPage:269`, `WbsFlowPage:274`, `CiliumTracePage:339`, `Dashboard:72`, `dashboard/MetricCard:242`.
- `shadow-lg|xl|2xl` 89건 vs 허용된 `shadow-card` 71건. 모달 밖 예: `WorkflowBoardPage:914-915`, `KanbanSummaryCharts:31`, `k8s/ColumnToggle:32`(`shadow-lg shadow-card` 둘 다).
- hover-lift 9건: `Dashboard.tsx:72`(`transition-all hover:-translate-y-0.5`), `MetricCard:242`, `AddonCard:399`, `OpsNotesPage:75`(`hover:shadow-md hover:-translate-y-0.5`), `PlaybookCard:39`, 로고 `hover:scale-105` 4곳. `transition-all` 64건/42파일.
- 로딩이 아닌 pulse: `WorkflowBoardPage:724`, `BatchJobClusterGroup:34`(`bg-blue-500 animate-pulse`), `IncidentAnalysisPage:615`(`animate-ping`). 포커스가 아닌 ring 39건(`DocumentsPage:174`, `WeeklyReportPage:287`).

### 6. 카드 남용과 MacCard 의 한계 → D-122

- 단일 요소를 카드로 감싼 곳: 도움말 한 문단 `K9sPage:136,151`, `NodeSshPage:188,203`, `McClientPage:157`, `EtcdCtlPage:207`, `KernelParamsPage:324`(전부 `<MacCard className="text-sm text-muted-foreground leading-relaxed">`). EmptyState 하나 `ClusterTrendsPage:166,245`, `K8sAllocationPage:160`, `K9sPage:131`, `NodeSshPage:180`, `IsilonNfsPage:104`. 탭 한 줄 `ObservabilityPage:141`. 페이지 헤더 `ClusterLinksPage:539-541`.
- 카드 안 카드: Dashboard 가 4단이다 — `:449`→`ClusterOverviewGrid:72`(버튼이 카드), `:501`→`MetricCard:242`, `:525`→`PlaybookCard:39`, `:420`→`ClusterItemCard:94`. `OpsNotesPage:499-500` QnaCard 4열 ×3. `HealthHero:27` KPI 셀마다 MacCard. `CheckItemDetailPage:448,453` MacCard 안 `rounded-xl border p-3`.
- 페이지당 MacCard: K8sManage 10 · CiliumTrace 9 · CheckItemDetail 7 · WeeklyReport 7 · IsilonNfs 7(312줄) · Dashboard 6 · ClusterLinks 6 · CidrCalculator 6. 수제 `bg-card … border` div 는 Settings 8(+MacCard 4) · InfraTopology 8 · MindMap 8 · K8sManage 7(+10).
- 원인 하나는 `components/ui/MacCard.tsx` 의 props 가 `title | className | rootClassName | bodyPadding` 뿐이라는 것이다. 액션·헤더 슬롯이 없어 버튼이 필요한 카드는 헤더를 손으로 만들고, 그 배경이 드리프트한다: `HomePage.tsx:210,227`·`ClusterLinksPage.tsx:476,599` 는 `bg-muted/40`, 정본 `MacCard.tsx:37` 은 `bg-surface-container-high`, `TodoTodayPage:474,508` 은 배경 없음. `k8s-allocation/primitives.tsx:224` 주석이 직접 말한다: "MacCard 는 title 만 지원하므로 body 내부에 직접 구성". `bodyPadding` 오버라이드가 239회 중 122회(`p-0` 69)다.

### 7. 밀도와 폭이 갈리지 않는다 → D-123

- 루트 패딩 10종: `p-3`, `p-5`, `p-6`, `px-4 lg:px-6 py-5`, `px-4 py-6`, `px-5 md:px-8 py-6 md:py-8`, `px-6 py-6`, `px-6 py-8`, `px-8 py-8`, `px-10 py-8`. 콘솔은 `py-3 pr-3`(BulkExec `:682`, K8sManage `:296`, Observability `:130`), 문서는 `px-8 py-8`(WorkGuide `:436`, OpsNoteDetail `:103`). 여기까지는 좋다.
- 그런데 **내부 리듬은 전부 같다**: MacCard 기본 `p-4` + `space-y-3/4` + 빈 상태 `p-10`/`py-16`. `WeeklyReportPage:223` 과 `DocumentsPage:106` 은 루트까지 같다(`p-6 space-y-4`). 밀도 차이가 루트 패딩 한 겹에서 끝난다.
- `max-w-* mx-auto` 폭이 12종 이상: 800 · 1200 · 1400(18회) · 1440 · 1500 · 1600 · 1700 · 1800 · 2400 · 2xl · 3xl · 4xl · 5xl. 콘솔인 `CheckItemDetailPage:113` 이 `max-w-5xl mx-auto` 로 문서처럼 좁다. Settings(`:640`)·BatchJobs·CiliumTrace 는 `max-w-[1700px]` 를 `mx-auto` 없이 좌정렬한다.

### 8. 빈·로딩 상태 파편화 → D-124, D-129

- 공용 `components/common/EmptyState.tsx` 가 있다. 그런데 공용을 import 하는 페이지는 **10/72** 뿐이다(BulkExec·ClusterLinks·ClusterManage·ClusterTrends·Documents·IsilonNfs·K8sAllocation·K9s·NodeSsh·Versions).
- 인라인 클론: 아이콘 + 문구형(`w-12 h-12 mx-auto mb-4 text-muted-foreground/30`) 약 17 — `ClusterMetaFormPage:281`, `KnowledgeHubPage:508`, `LakeServicesPage:146`, `MemberBoardPage:521`, `OpsNotesPage:460,533`, `PlaybooksPage:373`, `SettingsPage:947,1137`, `WorkItemBoardPage:1048,1094`, `WorkItemDetailPage:33`, `JiraExcelImportPage:308`. 텍스트만 가운데 정렬 약 30/15페이지. 같은 이름의 로컬 컴포넌트 2: `ArchitecturePage.tsx:94`(로딩 문구 "상태 확인 중..." 에 오용 `:60,74`), `ServiceArchitecturePage.tsx:503`.
- "클러스터를 선택하세요" 가 13개 페이지에서 **5가지 방식**: 공용(BulkExec `:736`, K9s `:132`, NodeSsh `:182`) / MacCard 로 감싼 공용(ClusterTrends `:166`, K8sAllocation `:160`) / 로컬 컴포넌트(Architecture `:72`) / 인라인 `<p>`(KernelParams `:344`) / 인라인 div(CiliumTrace `:263`, Observability `:283`, PacketFlow `:400,411`, NodeImages `:153`, VersionGraph `:240`).
- 로딩 문구 4종: "불러오는 중…" 13 · "로딩" 10 · "불러오는 중" 5 · "불러오는 중..." 1. `Skeleton` 7페이지, 수제 `animate-pulse` 박스 11페이지. 에러는 `text-destructive` 30 vs `text-status-critical` 134 가 같은 용도로 혼용.
- 문구 품질: 대부분 "~가 없습니다" 로 끝난다(이유도 다음 행동도 없음). 좋은 예는 `ClusterManagePage:866`("아직 실행 기록이 없습니다 — … 결과가 여기에 쌓입니다"), `DeepCheckRunHistory:114`("지금 실행"으로 첫 기록을 남겨보세요). 나쁜 예는 `PlaybooksPage:376-384` 영어 카피 "No playbooks registered yet / + Register your first playbook", `TodoTodayPage:566` "처리할 할일이 없습니다 🎉", `ClusterTrendsPage:258` 제목만 "데이터 없음".
- **깨진 CTA**: `ClusterManagePage.tsx:949` 빈 상태 버튼이 `/settings?tab=clusters` 로 보내는데 탭 id 는 `cluster` 다(`SettingsPage.tsx:601,621`). 게다가 `/settings` 는 admin 전용(`App.tsx:207`). 운영자가 누르면 탭 선택 없는 빈 설정 페이지 혹은 접근 거부를 본다.
- **낡은 안내**: `DailyCheckReview.tsx:141-143` 이 "상단의 'Daily Check 실행' 버튼" 과 "Dashboard 의 '체크 실행'" 을 가리키는데, 실제 버튼은 "기본 점검 실행"/"심층 점검 실행"(`:107,120`) 과 "점검 실행"(`Dashboard.tsx:393`) 이다.

### 9. 업퍼케이스 아이브로우와 타이포 → D-125, D-131

- `text-xs font-semibold uppercase tracking-wider` 가 **177회/74파일**. MacCard 헤더에 내장된 것(`MacCard.tsx:36-42`)은 정체성이지만, 페이지 본문·버튼·탭·폼 라벨에 같은 스타일이 흘러나왔다(`HomePage:212,228`, `ClusterManagePage:845`, `EtcdCtlPage:555`, `McClientPage:321`, `KernelParamsPage:466`). 전부 대문자 제목도 있다: `CidrCalculatorPage:467` "CIDR INPUT", `:1062` "QUICK REFERENCE", `:758` "멀티 CIDR 비교 (OVERLAP CHECK)".
- StatusBadge 가 2종이다. `components/common/StatusBadge.tsx` 는 한국어 `rounded-full border`, `components/dashboard/StatusBadge.tsx:27` 은 영어 `uppercase tracking-wide font-semibold`.
- 크기 분포: `text-sm` 2941 · `text-xs` 2119 · `text-[11px]` 301 · `text-base` 49 · `text-lg` 46 · `text-xl` 44 · `text-2xl` 16 · `text-3xl` 8 · `text-4xl` 1 · `text-5xl` 1. 커스텀 타입 스케일은 없다(`index.css:1361-1366` 주석). `font-medium` 1167 · `font-semibold` 668 · `font-bold` 138.
- **폰트가 문서와 다르다.** `frontend/index.html:61` 이 Inter·JetBrains Mono 를 로드하고 `tailwind.config.js:133` 이 `sans: ["Inter", …]` 인데, `index.css:1339` body 가 `-apple-system, BlinkMacSystemFont, "SF Pro Text", … Roboto` 로 덮어쓴다. Inter 는 다운로드만 되고 본문엔 안 쓰인다. `DESIGN.md` §1.1 "Inter 본문" 서술은 틀렸다.
- 숫자: `font-mono` 757 vs `tabular-nums` 17페이지. `MetricCard.tsx:84,102`, `ClusterItemCard.tsx:180,184`(`text-4xl font-bold font-mono`) 는 숫자에 mono 를 쓴다. Dashboard 에 `tabular-nums` 0, `text-right` 0.

### 10. 이모지가 아이콘과 상태를 대신한다 → D-126

`DESIGN_SYSTEM.md` §9 가 금지하는데 주석 제외 JSX·TS 에서 162줄.

- 상태: `DailyCheckReview.tsx:193-196` 🟢🟡🔴⚪, `lib/utils.ts:132-138`.
- 아이콘 대체: `hooks/useOperationLevels.ts:12-43` 🚀✨💻🧪🛡️ → `ClusterSidebar.tsx:196` 에서 클러스터 아이콘으로 표시. `lib/clusterIcons.ts:131-181` 이모지 약 70개 피커. `ops-notes/OpsNoteReadView.tsx:8-14` 🔑🐝🏗🔄📦📋. `Dashboard.tsx:284-287` 💾🖥️🎛️🔍 + 영어 설명(`AddonCard:405` 렌더). `AddMetricCardModal.tsx:16-20` 🚨⚡💾🌐📊. `PlaybookCard:62`·`PlaybookListRow:92` 📄. `OpsNoteReadView:39` ✍.
- 본문 장식: `TodoTodayPage:566` 🎉, `IncidentAnalysisPage:378` 💡, `LoginPage:48` ☸.
- 문자 접두 ⚠/✓/✗ 약 30: `BulkExecPage:305,402`, `EtcdCtlPage:56`, `KernelParamsPage:193`, `McClientPage:53,328`, `IsilonNfsPage:137`, `SettingsPage:1017-1033`, `BatchJobFilters:30-48`, `AccessReviewPanel:73,169`.

### 11. 용어·언어 혼재 → D-127

- Dashboard 섹션 제목이 영어다: "Cluster Status"(`:449`), "Prometheus Insights"(`:501`), "Playbook Checks"(`:525`), "Recent Check History"(`:570`) 옆에 "업무 현황"(`:559`). 카운트 문구 "{n} cards"(`:504`), "{n} playbooks"(`:528`).
- D-074 가 부분 처리한 K8S/K8s 잔존: `navConfig.ts:50` 'K8S 접근 권한'(`:20,21,49,51` 은 'K8s'), `NodeImagesPage:78` "K8S 노드 이미지"(nav 는 "K8s 노드 이미지"), `NodeLabelsPage:97`, `K8sManagePage:310`.
- 분기: 파드 70/Pod 37(nav `:30` "Pod 병목 진단" vs `:26` "파드 로그") · 점검 220/체크 38(`DailyCheckReview:127` "체크 정의" vs nav "점검 항목 관리") · 설정 211/Settings 5(`ClusterLinksPage:588`, `ClusterManagePage:232,949`) · 할일 19/할 일 2(`TodoTodayPage:70` vs `:334`) · 업무 등록/업무 추가/신규 등록/추가 · 새로고침 56/갱신 71/재수집 9/현행화 5/동기화 51.
- 기호: `중...` 27 vs `중…` 119. 빈 값 `'-'` 139 vs `'—'` 26. 토스트 어미 3종("…됨" 55, "…완료" 33, "…했습니다." 29). 토스트에 raw API 에러를 제목으로 넣는 곳(`ServiceArchitecturePage:200,206`, `AlertInboxPage:114`).
- 도메인 명사 없는 제목: `DailyCheckReview:140` "안내", `K8sManagePage:739` "개요", `settings/TenantManager:219` "정보", `ClusterManagePage:874` "필터", `PlaybookLogDialog:112` "요약".

### 12. 실행 버튼 로그 규칙 잔여 위반 → D-128

CLAUDE.md 의 riverjin839 요청("모든 실행 버튼에 상세·실시간 로그 + 로그 보기 옵션")을 D-108 이 AI 분석 4종에 대해 등재했다. 그 밖에 남은 것:

- `components/versions/KubeadmCertsModal.tsx:270`, `NodeNicsCollectModal.tsx:390`, `EtcdSystemdModal.tsx:318`, `KernelParamsCollectModal.tsx:327`, `KubeletConfigCollectModal.tsx:316` "수집 실행" 5개 — 완료 후 요약만.
- `DailyCheckReview.tsx:107,120` "기본 점검 실행"/"심층 점검 실행".
- `Dashboard.tsx:393` "점검 실행" — 클러스터를 순차 실행하고 실패는 `console.error`(`:277`) 로만. `DebugLogPanel` 은 디버그 덤프다.
- `lake-services/LakeServiceCard.tsx:85`, `LakeServiceDetailPage.tsx:120` "지금 점검".
- `daily-check/ResourceTrendChecklist.tsx:83` "지금 스냅샷".
- `BatchJobsPage.tsx:248` "선택 N개 실행" — 토스트만(`:106`).
- 정본 `RunLogPanel`/`useRunLog` 사용처는 7곳(PodBottleneck·InfraTopology·ServiceTopology·CheckItemDetail·NodeVerifyModal·PlatformStatusMatrix·CheckMatrixRunLogPanel). 준수 예: `ClusterManagePage:754`, `VersionsPage:1055`, `NodeSpecPage:945`, `K8sRbacPage:104-124`, `EfficiencyRunLog:77`.

### 13. 정보 설계 — 설정과 네비 → D-130, D-133

- `SettingsPage.tsx:620-670` 평면 탭 15개 한 줄. 전부 카운트 pill 인데 15개 중 11개가 `count: 0` 하드코딩이라 항상 "0" 이 붙는다(`:663-667`). 비활성 "추후 지원" 토글이 UI 에 있다(`:684-694`). 라벨 언어 혼재("Debug", "AI / LLM", "연동 (Jira)"). 클러스터 탭은 수제 `bg-card` div KPI 4개로 연다(`:855-880`, `/cluster-manage` 와 중복).
- `navConfig.ts:105-127` 10그룹 55항목. observe 7 · inspect 5 · operate 5 · configure 6 · infra 6 · network 7 · devops 3 · collab 8 · documents 7 · system 1. 앞 4그룹은 "클러스터 · " 접두에 작업 유형 분류, 나머지는 도메인 분류로 기준이 섞였다. `/ops-checks` 는 `App.tsx:249` 에서 레거시로 표시됐는데 nav 에 남아 있다(`:25,109`). `NAV_MAP` 의 `/batch-jobs` 는 `/` 로 redirect 된다(`App.tsx:201`).
- 양호: `HomePage.tsx` 는 탭 2개(업무/플랫폼) + 카드 2개다. 웰컴 배너·기능 그리드 없음. KPI 스트립은 이미 제거됐다(`:54,93-95` 주석). `ClusterManagePage` 는 필터·로그·도구를 접어 둔다(D-051).

### 14. 문서가 코드와 다르다 → D-134

- `DESIGN_SYSTEM.md` §1(`:29-30`) 과 §4(`:273`) 가 "KPI cards row", "large KPI", Bento Health Hero 를 **권장**한다. 새 §12.12 와 충돌한다.
- `DESIGN.md` §1.1 은 "다크 Ops Slate 기본", "Inter 본문", 테마 "4종" 이라 쓰는데 실제는 `themeStore.ts:75` light 기본, body 는 system stack, `themeStore.ts:26-33` 17종(+system).

## 화면별 매트릭스

패턴 키: **H** 헤더 템플릿 · **K** KPI 타일 · **G** 정상 과잉 채색 · **P** 장식 팔레트/무지개 · **R** 라운딩·그림자·모션 · **C** 카드 남용 · **D** 밀도·폭 · **E** 빈 상태 파편 · **U** 아이브로우/대문자 · **M** 이모지 · **T** 용어/영어. 뒤의 수는 에이전트 2축 집계의 패턴 총점이다.

| 페이지 | 패턴 | 점 |
|---|---|---|
| MindMapPage | P(hex 33, 기본 indigo) R(글래스 4, 2xl 8) M | 70 |
| WbsFlowPage | H K(복붙) P(6색) R(2xl 6) D(1800) U | 61 |
| WorkflowBoardPage | P R(pulse, shadow-xl) H(h1 없음) | 41 |
| SettingsPage | K(설정 탭 KPI) C(8+4) E(인라인 2) M U T(탭 15·pill 0) | 36 |
| OpsNotesPage | H K(복붙) P(칩 text-white) R(hover-lift, 2xl) C(QnaCard 4열) E D(1600) | 36 |
| CidrCalculatorPage | H′ K P U(대문자 제목 3) D(1440) | 36 |
| OntologyPage | P(hex 15) R(글래스) H(text-base) | 35 |
| VersionsPage | U(19) | 31 |
| BulkExecPage | P(auth_error) M(⚠) U | 30 |
| Dashboard | K(Bento) G(초록 5중) C(4단) R(hover-lift) T(영어 제목·구 브랜드) M(애드온) | — |
| K8sManagePage | K(MacCard) C(10) D(p-10 ×6) E(인라인 6) T(K8S) | — |
| CiliumTracePage | H K(복붙) C(9) R(2xl) E | — |
| KnowledgeHubPage | H P(indigo·violet 칩) E | 19 |
| MemberBoardPage | P U E | 24 |
| TodoTodayPage | K D(root mx-auto) E M(🎉) T(할일/할 일) | 21 |
| KernelParamsPage | P(auth_error) U M(⚠) | 21 |
| IncidentAnalysisPage | R(ping) U(9) M(💡) H(Zap) | 20 |
| SprintsPage | R(2xl) D(1400) C(카드 그리드) | 19 |
| InfraTopologyPage | K(5) C(8 인라인) H′ | — |
| DailyCheckReview | M(🟢🟡🔴) T(체크/점검, 낡은 안내) 실행 로그 없음 | — |
| K9s·NodeSsh·McClient·EtcdCtl | C(도움말 카드) E(혼합) P(auth_error) | — |
| OpsNoteDetail·OpsNoteForm·CommandForm | H(text-3xl) R(2xl) D(1200~1400) | — |
| PlaybooksPage | C(카드 그리드 4열) E(영어 카피) M(📄) | — |
| ClusterLinksPage | H′ K C(헤더 카드) D(1600) | — |
| HomePage | 양호 — 수제 카드 헤더 2곳(`bg-muted/40`)만 | — |

## 근본 원인

1. **조합 규칙이 없다.** §12 는 원자만 규정한다. "카드를 몇 개 쓰나", "KPI 타일을 또 깔았나", "정상에 색을 주나", "폭은 얼마냐"에 답하는 조항이 없으니 페이지마다 가장 흔한 평균(= AI 템플릿)으로 수렴했다.
2. **공용 부품이 없다.** PageHeader·StatTile 이 없고, MacCard 에 액션 슬롯이 없고, EmptyState 는 있지만 안 쓴다. 부품이 없으면 복붙이 규칙을 대신한다. 복붙 3곳이 바이트 동일한 것이 증거다.
3. **lint 가 장식 팔레트를 의도적으로 뺐다.** 상태 팔레트만 막으니 그 바로 옆 blue·orange·violet 로 무지개가 옮겨갔다. 기계가 안 막는 것은 반드시 늘어난다.
4. **페이지 단위 독립 생성.** 뒤로가기 헤더 복제, "클러스터를 선택하세요" 5종, 루트 패딩 10종, 폭 12종은 전역을 보는 주체가 없었다는 뜻이다.
5. **"정상도 칠한다"는 관성.** 상태색 4단계 체계가 잘 돼 있어서 오히려 healthy 까지 늘 칠하게 됐다. 운영 도구에서 색은 예외에만 줘야 비정상이 튄다.

## 개선 계획

| Phase | 내용 | 백로그 |
|---|---|---|
| **0 (이 PR)** | 본 보고서, DESIGN.md 10차 라운드 등재, DESIGN_SYSTEM §12.12 조합 규칙, 정량 지표 추가 | D-117~D-134 등재 |
| **1 소폭·고효과** | 깨진 CTA·낡은 안내·레거시 nav 4건 수정 · `PageHeader` 신설 + 아이콘 타일/뒤로가기 패턴 페이지 12개 이관 · `StatTile` 신설 + 복붙 3곳 교체 · `EmptyState` 전면 적용 + 로컬 중복 삭제 + "클러스터 선택" 단일화 · Dashboard 영어 제목·구 브랜드·K8S 잔존 · lint `STATUS_PALETTE_RE` 에 장식 계열 추가(allowlist 로 단계 적용) | D-129 D-117 D-118 D-124 D-127 D-120 |
| **2 시각 정리** | 정상 중립화(Dashboard·HealthHero·nav 아이콘·statusColors) · 라운딩/그림자/모션/글래스 sweep · 이모지→lucide · 아이브로우 회수 + StatusBadge 통합 · 대비 토큰 우회 수렴 | D-119 D-121 D-126 D-125 D-132 |
| **3 구조** | 밀도 클래스 3종 적용 + 폭 정규화 · MacCard 헤더/액션 슬롯 + 카드 회수 · 실행 버튼 12개 RunLogPanel · Settings 탭 재편 · 폰트 결정 · nav 재편 · 문서 완결 | D-123 D-122 D-128 D-130 D-131 D-133 D-134 |

각 Phase 끝에 아래 지표를 재집계하고 Playwright 스크린샷 전/후를 `DESIGN.md` §4 에 남긴다.

## 정량 지표와 목표

`frontend/src` 에서 실행. 2026-10-13 값.

| 지표 | 명령 | 현재 | 목표 |
|---|---|---|---|
| h1 class 문자열 종류 / h1 없는 페이지 | `grep -rho '<h1 className="[^"]*"' pages \| sort -u \| wc -l` / 페이지별 `<h1` 부재 | 22 / 11 | 1 / 0 |
| 동일 아이콘 타일 헤더 | `grep -rc 'w-10 h-10 rounded-2xl bg-primary/10' --include=*.tsx .` | 15 | 0 |
| KPI 타일 로컬 구현 | 수동(§2 표) | 10+ / 14페이지 | 공용 1 |
| `bg-card` + `rounded-xl` / `2xl` / `lg` | `grep -rE "bg-card[^\"']*rounded-xl\b\|rounded-xl\b[^\"']*bg-card"` 등 | 195 / 75 / 80 | 0 / 0 / 0 |
| `shadow-lg\|xl\|2xl` | `grep -rE 'shadow-(lg\|xl\|2xl)\b' --include=*.tsx .` | 89 | 모달 외 0 |
| `backdrop-blur` (모달 스크림 `bg-black/` 제외) | `grep -r backdrop-blur --include=*.tsx . \| grep -v 'bg-black/'` | 24 | 0 |
| hover-lift | `grep -rE 'hover:(-translate-y\|scale)' --include=*.tsx .` | 9 | 0 |
| 장식 고정 팔레트 7계열 | `grep -rEo '(text\|bg\|border\|ring\|from\|to\|via)-(blue\|orange\|purple\|violet\|indigo\|cyan\|pink\|fuchsia\|teal)-[0-9]{2,3}' --include=*.tsx --include=*.ts .` | 329 | 0 (`--chart-*` 이관) |
| uppercase 아이브로우 | `grep -rc 'uppercase tracking-wider' --include=*.tsx .` 합 | 177 | MacCard 내장 1 |
| 이모지 (주석 제외 JSX/TS 줄) | 유니코드 범위 python 집계 | 162 | 0 (`clusterIcons` 데이터 예외는 D-126 판정) |
| EmptyState 공용 import 페이지 | `grep -l "common/EmptyState\|from '@/components/common'" pages/*.tsx \| xargs grep -l EmptyState` | 10/72 | 빈 상태 있는 페이지 전부 |
| "클러스터를 선택하세요" 구현 방식 | 수동(§8) | 5 | 1 |
| 페이지 루트 `max-w-*` 폭 종류 | `grep -rhoE 'max-w-(\[[0-9]{3,4}px\]\|[0-9]?xl)' pages \| sort -u` | 12+ | 3 |
| 실행 버튼 로그 미구현 | 수동(§12) | 12 | 0 |
| `RunLogPanel`/`useRunLog` 사용처 | `grep -rl 'RunLogPanel\|useRunLog' --include=*.tsx .` (정본 제외) | 7 | 실행 버튼 전부 |

## 재검증 체크리스트

**스크린샷 비교(Phase 1 부터).** Playwright 1.56.1 이 `/opt/node22/bin/playwright` 에, 브라우저가 `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` 에 있다. `cd frontend && npm install && npm run dev` 후 로그인 → 아래 화면을 1440×900 라이트/다크로 캡처해 전/후를 나란히 둔다. 샌드박스엔 클러스터가 없으니 빈 상태 화면이 곧 비교 대상이다(그 자체가 D-124 검증이다).

- `/`(홈 두 탭) · `/cluster-overview` · `/cluster-manage` · `/settings` · `/ops-notes` · `/wbs` · `/cilium-trace` · `/batch-jobs` · `/k8s-manage/:id` · `/bulk-exec` · `/documents` · `/work-guide`

**화면별 체크 항목(리뷰어용).**

1. 페이지 제목이 하나이고 `PageHeader` 인가. 아이콘 타일이 없는가.
2. KPI 타일 행이 있는가. 있다면 Health Hero 인가, 아니면 표로 바꿀 수 있는가.
3. 정상 항목에 색이 있는가. 비정상만 튀는가. 0 이 상태색인가.
4. Tailwind 색상명(blue·orange·violet…)이 class 에 있는가.
5. `bg-card` 가 `rounded-md` 인가. hover 에 움직이는가. 그림자가 `shadow-card` 뿐인가.
6. 카드가 한 문단·빈 상태·탭 줄을 감싸고 있는가. 카드 안에 카드가 있는가.
7. 루트가 콘솔/허브/문서 셋 중 하나인가. `max-w` 가 그 셋 밖인가.
8. 빈 상태가 `EmptyState` 인가. 문구에 이유와 다음 행동이 있는가. 이모지·영어가 있는가.
9. 본문에 uppercase 라벨이 있는가. 전부 대문자 제목이 있는가.
10. 이모지·⚠✓✗ 문자가 아이콘 자리에 있는가.
11. K8S·Pod·체크·Settings·할 일·`...`·`-` 가 보이는가. 섹션 제목이 "안내/개요/정보" 인가.
12. 실행 버튼을 누르면 `RunLogPanel` 이 뜨고 "로그 보기" 토글이 있는가.
