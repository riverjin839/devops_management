---
target: K8S 자원 관리 (/k8s-allocation)
total_score: 30
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-08-06T04-54-39Z
slug: frontend-src-pages-k8sallocationpage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector+evidence sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | 진행률 바·partial/stale 배지·개별 새로고침 스피너 등 상태 커뮤니케이션이 촘촘함 |
| 2 | Match System / Real World | 3 | k9s 스타일 %R/%L, QoS 등 K8s 운영자 용어를 그대로 사용 — 타깃에는 맞으나 신규 입사자에겐 해독 부담 |
| 3 | User Control and Freedom | 3 | 검색/정렬/뷰전환/CSV 등 자유도는 높으나 스케줄 계산기 결과를 고정(pin)할 방법이 없음 |
| 4 | Consistency and Standards | 2 | `NsRankingView`만 "집계 중" 분기 없음(상단 배너와 본문이 모순), CPU 사용효율 경고 로직이 자체 툴팁 설명과 불일치 |
| 5 | Error Prevention | 3 | 음수 입력 clamp, 분모 0 분리 등 방어 코드는 세심하나 포커스 인디케이터 누락은 실수 유발 |
| 6 | Recognition Rather Than Recall | 2 | 요약 카드는 `StatTooltip`으로 친절하나 테이블/카드 뷰의 R/L 설명은 title 속성 하나뿐 — 도움말 접근성이 화면 안에서 들쭉날쭉 |
| 7 | Flexibility and Efficiency of Use | 4 | CSV 내보내기, 열 수/페이지 조절, 정렬, 자동갱신 간격 등 파워유저 기능 풍부 |
| 8 | Aesthetic and Minimalist Design | 2 | "스케줄 가능 Pod" 수치가 요약카드·PodCapacityStatusCards 두 곳에서 중복 노출 |
| 9 | Error Recovery | 4 | 에러/빈 상태를 대부분의 뷰에서 명확히 구분, 서버 에러 메시지 그대로 노출 |
| 10 | Help and Documentation | 3 | `StatTooltip` 패턴은 훌륭하나 아이콘 자체에 `title` 누락 + 설명 패널이 `aria-describedby`로 연결 안 됨 |
| **Total** | | **30/40** | **Good (28-35)** |

## Design Specificity Verdict

**LLM 평가**: 일반적인 admin-dashboard가 아니라 K8s 리소스 관리 도메인 워크플로에 강하게 맞춰진 설계다 — "CPU/MEM 요청량 → 몇 개 스케줄 가능한가" 계산기(max-pods 제약 포함), 노드 기본 정렬을 slack(여유) 내림차순으로 잡아 진입 즉시 "여유 많은 노드"가 최상단에 오게 한 것, "할당효율(스케줄러 관점)"과 "사용효율(실사용 관점)"을 의도적으로 분리해 각각 설명한 것 모두 이 도메인 특유의 통찰을 UI화한 것이다. 다만 **용량 계획(capacity planning) 워크플로에는 강하지만 장애 진단(Pending 원인 조사) 워크플로에는 약하다** — API에 이미 있는 파드 `phase` 필드가 화면 어디에도 렌더링되지 않아, "PEP 안에서 점검부터 조치까지 끝낸다"는 포지셔닝과 어긋나는 지점이 하나 발견됐다.

**결정론적 스캔**: `detect.mjs`가 0건을 보고했다. Assessment B가 CLI 내부를 직접 확인해 이 파일의 raw hex·고정 팔레트·`window.confirm`류 패턴이 실제로 없어 나온 **진짜 0건**임을 검증했다(은폐나 설정 필터링이 아님). 다만 이 스캐너는 포커스 상태·ARIA 연결·색상-단독 시그널링 같은 구조적 문제는 애초에 탐지 대상이 아니라서, 수동 검증에서 실질적 이슈가 다수 나왔다(아래 참조) — "탐지기 클린 = 화면 클린"이 아님을 이번에도 확인.

## Overall Impression

두 어세스먼트가 독립적으로 도달한 가장 큰 문제는 **`NsRankingView`만 "집계 중(computing)" 상태 분기가 빠져 상단 배너("집계 중")와 탭 본문("데이터 없음")이 동시에 모순된 메시지를 낼 수 있다**는 것과, **경고(warn) 신호가 색상에만 의존**한다는 것이다. 여기에 Assessment B가 단독으로 찾아낸 **CPU 사용효율 경고 로직이 자체 툴팁이 설명하는 "스로틀 위험(105% 초과)" 케이스를 실제로는 반영하지 않는 버그**와, **PageSizeSelect 등 5개 폼 컨트롤에 키보드 포커스 인디케이터가 전혀 없는 문제**(전역 CSS가 outline을 지운 뒤 로컬 보완이 빠짐)가 이번 라운드에서 가장 심각한 결함이다. 반면 Assessment A가 지적한 **파드 `phase` 필드 누락**은 이 화면의 두 번째 자연스러운 유스케이스(장애 진단)를 완결하지 못하게 만드는 기능적 공백이다.

## What's Working

1. Pod 스케줄 가능 수 계산기(CPU/MEM/max-pods 반영) — 이 도메인에만 있는 실질적 의사결정 도구.
2. 로딩/에러/빈 상태 3~4단 분기가 `SummarySection`/`NodesView`/`NamespacesView`에서 매우 꼼꼼함(서버 에러 메시지 그대로 노출, 재시도 유도).
3. 하드코딩 팔레트·raw hex·`window.confirm` 전무 — 디자인 토큰 준수가 이 화면의 명확한 강점.

## Priority Issues

**[P0] 없음** — 데이터 손실·보안·화면 전체 마비 수준의 결함은 발견되지 않음.

**[P1] `NsRankingView`만 "집계 중(computing)" 분기 없음 — 상단 배너와 본문 메시지 모순 (양쪽 독립 합치)**
- 근거: `K8sAllocationPage.tsx` `NodesView`(968-975)·`NamespacesView`(1195-1202)는 `data?.status === 'computing' && !items.length`일 때 `SnapshotProgressCard`를 렌더링하지만, 같은 `useAllocNamespaces` 쿼리를 쓰는 `NsRankingView`(820-914)에는 이 분기가 없어 `nsQ.isLoading`만 체크(885)하고 집계 중이면 그냥 "데이터 없음"(887-888)으로 떨어진다. 페이지 상단(386-393)은 동시에 "자원 누적 집계 중" 배너를 보여준다.
- Fix: `NodesView`/`NamespacesView`와 동일하게 `computing && !nsRanked.length` 분기에서 `SnapshotProgressCard` 추가.
- Suggested command: `/impeccable harden`

**[P1] CPU 사용효율 경고 로직이 "스로틀 위험(105% 초과)" 케이스를 반영하지 않음**
- 근거: `K8sAllocationPage.tsx:528` `warn={useEff != null && useEff < 0.3}` — 30% 미만(낭비)만 경고로 잡고, 같은 카드 툴팁(537)이 명시한 "105% 초과 → 실사용이 request 초과(스로틀 위험)" 케이스는 `warn` 계산에서 완전히 빠져 있다. 같은 파일의 `efficiency()`/`EffBadge`(182-204)는 over/ok/under 3분류를 이미 올바르게 구현해두고도 요약 Stat 카드에는 절반만 이식됐다.
- Fix: `warn={useEff != null && (useEff < 0.3 || useEff > 1.05)}`로 수정하고 over 케이스 색상도 `text-status-critical`로 분리.
- Suggested command: `/impeccable harden`

**[P1] 폼 컨트롤 5개에 키보드 포커스 인디케이터 전혀 없음**
- 근거: `frontend/src/index.css:512-516`이 `input/select/textarea:focus-visible`의 기본 outline을 전역 제거하는데, `PageSizeSelect`(118-125)·자동갱신 select(371-380)·열 수 select(1009-1017)·`PodScheduleCalc`의 CPU/MEM 숫자 입력 2개(624, 629)는 대체 `focus:ring` 클래스가 없다. 같은 파일 `SearchInput`(297-302)은 `focus:outline-none focus:ring-1 focus:ring-primary`로 올바르게 구현돼 대조된다. WCAG 2.4.7 위반.
- Fix: 5개 컨트롤에 `SearchInput`과 동일한 focus ring 클래스 적용(반복되므로 공용 클래스 상수로 통일 권장).
- Suggested command: `/impeccable harden`

**[P1] 파드 상태(phase)가 API에 있는데 화면 어디에도 렌더링되지 않음**
- 근거: `frontend/src/types/index.ts:3846` `AllocPodRow.phase: string` 필드 존재, `K8sAllocationPage.tsx` 전체에서 `phase` 사용처 0건. `PodsDrill`(1386-1443)은 Pod/Container·QoS·Node·CPU/MEM만 렌더링하고 Running/Pending/Failed 등 상태를 표시하지 않아, `PodCapacityStatusCards`의 Pending 카운트(763-773)와 드릴다운이 사실상 끊겨 있다.
- Fix: `PodsDrill` 테이블에 상태 배지 컬럼 추가, 나아가 Pending 카운트를 클릭 가능하게 만들어 해당 네임스페이스/워크로드로 바로 이동시키는 것을 검토.
- Suggested command: `/impeccable harden`

**[P2] Stat 컴포넌트의 warn 신호가 색상 단독(아이콘/라벨 없음) (양쪽 독립 합치)**
- 근거: `Stat` 컴포넌트(693-707)의 `warn` prop은 값 텍스트 색만 바꿀 뿐 아이콘·라벨이 없다. CPU/MEM 할당효율·CPU 사용효율 3곳 모두 해당. PRODUCT.md §Accessibility & Inclusion이 "색상 단독 정보 전달 금지"를 명시한 자사 원칙임에도 위반.
- Fix: `warn=true`일 때 `AlertTriangle` 아이콘 병기 또는 라벨에 "(주의)" 텍스트 추가.
- Suggested command: `/impeccable clarify`

**[P2] NodesView(카드/테이블)만 텍스트 배지 없이 색상 단독 — Namespaces/Workloads 뷰와 비대칭**
- 근거: `NodesView` 카드(1044-1071)·테이블(1091-1126)에는 `UtilPct`의 R/L 색상만 있고 `EffBadge` 텍스트 배지가 없다. 반면 `NamespacesView`(1280)·`WorkloadsDrill`(1367)은 동일 지표에 `EffBadge`를 병기한다.
- Fix: `GaugeRow`/`MeterBar` 옆에 `EffBadge(efficiency(req, usage))`를 작게 추가하거나 최소한 위험 케이스에 아이콘 병기.
- Suggested command: `/impeccable clarify`

**[P2] 툴팁 접근성이 컴포넌트마다 다른 수준으로 혼재**
- 근거: `UtilPct`(268-288)의 R/L 설명은 네이티브 `title` 하나뿐(키보드 접근 불가)인 반면, 화면 내 이미 존재하는 `StatTooltip`(673-691)은 버튼+포커스 가능 패널 방식이면서도 정작 그 버튼 자체엔 `title`이 없고(679-681) 설명 패널이 `aria-describedby`로 연결돼 있지 않아 스크린리더가 내용을 자동 낭독하지 않는다.
- Fix: `UtilPct`를 `StatTooltip` 패턴으로 통일하고, `StatTooltip` 버튼에 `title` 추가 + 버튼·패널을 `aria-describedby`로 연결.
- Suggested command: `/impeccable harden`

**[P2] 요약 그리드에 "MEM 사용효율" 슬롯 자체가 없음(CPU만 존재)**
- 근거: 476-544의 6개 Stat 슬롯(노드/네임스페이스/파드(활성)/CPU 할당효율/MEM 할당효율/CPU 사용효율)에 MEM 사용효율이 빠져 있어, CPU/MEM 대칭이 깨지고 메모리 낭비/스로틀 위험이 요약 화면에서 전혀 드러나지 않는다.
- Fix: `lg:grid-cols-7`로 확장하거나 CPU/MEM 사용효율을 한 슬롯에 묶어 표시.
- Suggested command: `/impeccable clarify`

**[P2] "스케줄 가능 Pod" 수치가 요약카드와 PodCapacityStatusCards 두 곳에서 중복 노출**
- 근거: `SummarySection`의 "파드 (활성)" `sub` 텍스트 "여유 {cap.schedulableFreeSlots}개"(482)와 `PodCapacityStatusCards`의 "스케줄 가능 Pod"(755)가 동일 값을 반복 표시.
- Fix: 한쪽에서 제거하거나 두 카드를 통합.
- Suggested command: `/impeccable distill`

**[P3] Pod 스케줄 계산기에 실제 스케줄러 제약(affinity/taint/PVC) 관련 디스클레이머 부재**
- 근거: `PodScheduleCalc`(582-671)는 CPU/MEM/max-pods만 반영하며 결과 문구(663)도 그 세 가지만 언급 — 배포 프리즈 전 확인 용도로 과신하면 거짓 안심(false confidence) 위험.
- Fix: "※ 개략치이며 node affinity/taint/PVC 등은 반영하지 않습니다" 같은 짧은 주석 추가.
- Suggested command: `/impeccable clarify`

**[P3] 자동갱신 간격 select — 시각적 label 없이 title에만 의존 (양쪽 독립 합치)**
- 근거: 371-380, `PageSizeSelect`(116-128)·열 수 select(1007-1017)는 `<label>`로 감싸는데 이 select만 `title`(375) 하나로 접근성 이름을 대체.
- Fix: `<label className="sr-only">자동 갱신 간격</label>` 또는 `aria-label` 추가.
- Suggested command: `/impeccable harden`

## Persona Red Flags

**온콜 SRE(시간에 쫓김)**: Pending 원인을 이 화면 안에서 못 찾고(phase 누락) 결국 다른 화면(K8s 이벤트)으로 이탈해야 한다 — 온콜 상황에서 특히 아쉬운 지점.

**신규 입사자**: req/use/R/L/eff/slack/QoS/max-pods 등 약어가 쏟아지는데 툴팁 커버리지가 컴포넌트마다 달라(UtilPct는 title, StatTooltip은 클릭형) 학습 곡선이 고르지 않다.

**(프로젝트 특화) 배포 전 용량 계획을 하는 운영자** (PRODUCT.md): 스케줄 계산기가 정확히 이들을 위한 기능이지만, affinity/taint 미반영 디스클레이머가 없어 "여유 있음" 표시를 과신했다가 실제 배포 시 스케줄 실패를 겪을 위험이 있다.

**(프로젝트 특화) 색각 이상 운영자**: warn 신호가 색상 단독인 지점(Stat 컴포넌트, NodesView)에서 임계값 초과 여부를 구분하기 어렵다.

## Minor Observations

- `detect.mjs` 0건은 이번엔 진짜 클린(Assessment B가 CLI 내부까지 확인) — 다만 포커스/ARIA/색상단독 같은 구조적 이슈는 원래 탐지 범위 밖이라는 점은 이전 라운드들과 동일.
- 버튼/입력 다수가 `rounded-lg`(DESIGN_SYSTEM.md §12.2는 `rounded-xl` 요구)지만, 저장소 전반(WorkItemBoardPage/SprintsPage/ClusterManagePage 등)에 이미 광범위한 기존 관행이라 이 화면 단독 우선순위는 낮음 — 별도 저장소 전체 라운딩 정리 작업으로 남겨두는 게 적절.
- Stat 타일/노드 카드/드릴다운 래퍼가 `MacCard` 대신 hand-rolled `bg-card border` div(최상위 섹션은 이미 전부 `MacCard`라 경미).

## Questions to Consider

- Pod `phase` 를 드릴다운에 노출하는 것 외에, "이 화면에서 장애 진단까지 끝낼지 vs K8s 이벤트 화면으로 안내할지" 제품 방향을 정할 필요가 있는가?
- MEM 사용효율을 요약 그리드에 추가하면 6→7 슬롯이 되는데, 반응형 레이아웃(현재 `grid-cols-6`)을 어떻게 재배치할지?
- CPU 사용효율 경고 로직 수정(105% 포함)이 기존 대시보드에 이미 익숙해진 운영자에게 "갑자기 경고가 늘었다"는 인상을 줄 수 있는데, 별도 공지가 필요한가?
