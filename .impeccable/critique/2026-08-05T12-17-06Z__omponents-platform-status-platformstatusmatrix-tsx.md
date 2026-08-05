---
target: 홈 플랫폼 현황 (PlatformStatusMatrix)
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-08-05T12-17-06Z
slug: omponents-platform-status-platformstatusmatrix-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector+evidence sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | 실행 스피너·폴링은 촘촘하나 그리드 전체의 "마지막 갱신 시각" 표시가 없음 |
| 2 | Match Between System and Real World | 3 | cron/kubectl 등 운영자 어휘와 잘 맞으나 `core_bundle` 같은 내부 개념이 배지로 그대로 노출 |
| 3 | User Control and Freedom | 2 | 모달은 X/Esc/backdrop로 닫히지만 큐잉된 일괄 실행에는 취소 수단이 없음 |
| 4 | Consistency and Standards | 3 | 토큰 사용은 대체로 준수하나 카드 헤더가 `MacCard` 표준 토큰을 재구현 |
| 5 | Error Prevention | 1 | 프로덕션에 실제 명령이 나가는 "클러스터/항목 전체 실행"에 확인 절차 없음 |
| 6 | Recognition Rather Than Recall | 2 | cron 상태·셀 값의 정상/경고/위험 구분이 색상에만 의존, 텍스트는 hover 전용 |
| 7 | Flexibility and Efficiency of Use | 3 | 셀/클러스터/항목 3단 실행, 드래그 재정렬, 인라인 설정 편집 등 파워유저 지원 풍부 |
| 8 | Aesthetic and Minimalist Design | 2 | 행 라벨 셀에 요소 최대 8개 밀집, 9~11px 마이크로 타이포 다수 |
| 9 | Error Recovery | 3 | 실패 시 raw 상세 자동 펼침은 훌륭하나 그리드 단계는 tooltip 의존 |
| 10 | Help and Documentation | 4 | `CheckMatrixHelpPanel`이 탭 구조로 화면 사용법을 충실히 내장 |
| **Total** | | **26/40** | **Acceptable (20-27)** |

## Design Specificity Verdict

**LLM 평가**: "행=점검 항목 × 열=클러스터"라는 매트릭스 골격 자체는 범용 그리드처럼 보이지만, cron 표현식 배지, 실제 kubectl/HTTP/SSH/DB 호출 종류와 mutating 여부를 구분하는 런북 뷰, Deep Check/Addon/수동입력 3원 실행 소스 모델은 명백히 K8s 운영 도구 전용 설계다. 내용의 특이성은 높지만, 시각적 표현(작은 배지·탭 모달·회색조 토큰)은 도메인 색채가 옅은 전형적 대시보드 크롬이라 "내용은 전문적, 겉모습은 평범"이라는 이중적 평가가 맞다.

**결정론적 스캔**: `detect.mjs`가 대상 파일 2건(`border-accent-on-rounded`, `side-tab`)을 검출했으나, 두 건 모두 **오탐**으로 확인됐다 — 각각 활성 탭 밑줄 표시자(테마 토큰 사용)와 사용자 지정 카테고리 색상 코딩(`--chart-*` 토큰 사용, CLAUDE.md 명시 예외)이었다. 즉 이 화면에서 "AI-slop" 성격의 장식적 패턴은 발견되지 않았다 — 두 어세스먼트가 독립적으로 도달한 이 결론은 일치한다.

**Visual overlays**: 이번 실행 환경에는 dev 서버가 기동돼 있지 않아(`devServer.running: false`) 브라우저 실측/오버레이 주입은 시도하지 않았다. 이 리포트는 소스 코드 직독 + 정적 detector 스캔에만 근거한다 — 실제 렌더 결과(레이아웃 붕괴, 실제 대비값 등)는 검증되지 않았다는 한계를 안고 읽어야 한다.

## Overall Impression

기능적으로는 매우 깊다 — 실행 방식(런북) 사전 공개, 실패 시 자동 상세 펼침, 구조화된 로딩 스켈레톤 등 "운영자가 실제로 무슨 일이 벌어지는지 알아야 한다"는 CLAUDE.md UI-First 원칙을 코드 수준에서 잘 구현했다. 하지만 정작 **위험도가 가장 높은 지점(프로덕션 클러스터에 실제 명령을 쏘는 일괄 실행)에 확인 절차가 없고**, 상태 정보 다수가 색상 단독으로 전달된다는 점이 이 화면의 가장 큰 기회다. 두 독립 평가가 서로 다른 방법(정성 리뷰 vs 코드 직독 증거 수집)으로 **같은 두 가지 결함(그리드 조회 실패 은폐, 색상 단독 상태 전달)에 독립적으로 도달**했다는 점이 이 문제들의 신뢰도를 높인다.

## What's Working

1. **로딩 스켈레톤이 실제 매트릭스 구조를 흉내내 레이아웃 시프트를 최소화**(`PlatformStatusMatrix.tsx:282-295`, `aria-busy`/`aria-label` 포함).
2. **"실행 방식" 탭이 실제 kubectl/HTTP/SSH 명령과 mutating 여부를 사전 공개**(`CheckMatrixRunbookPanel.tsx:36-62, 271-328`) — 가시화가 편집보다 먼저라는 CLAUDE.md 원칙을 정확히 구현.
3. **실패/경고 결과의 raw 상세를 자동으로 펼치는 배려**(`CheckMatrixRunLog.tsx:181-186, 217-232`).

## Priority Issues

**[P0] 프로덕션 대상 일괄 실행에 확인 절차 없음**
- Why it matters: `handleRunCluster`/`handleRunItem`(`PlatformStatusMatrix.tsx:188-212`)이 클러스터 전체·항목 전체 점검을 즉시 큐잉한다. 런북 뷰 스스로 "변경(mutating)" 배지로 위험 명령의 존재를 인정하는데(`CheckMatrixRunbookPanel.tsx:49-56`), 정작 실행 트리거에는 로컬 메타데이터 삭제(`ConfirmDialog` 적용됨, `:461-471`)보다도 마찰이 적다. 실수로 누른 ▶ 하나가 다수 프로덕션 클러스터에 즉시 영향을 준다.
- Fix: 이미 import된 `ConfirmDialog`(danger)를 클러스터/항목 단위 실행에 재사용 — 대상·건수·소스 요약 포함(D-014에서 운영 점검 화면에 적용한 것과 동일 패턴). 셀 단위 단건 실행은 마찰 유지 불필요.
- Suggested command: `/impeccable harden`

**[P0] 그리드 조회 실패가 "항목/클러스터 없음" 빈 상태로 위장됨** *(두 어세스먼트 독립 합치)*
- Why it matters: `useCheckMatrixGrid()`(`useCheckMatrix.ts:38-48`)가 `isError`를 노출하지 않고, `PlatformStatusMatrix.tsx:158`도 `isLoading`만 구조분해한다. API 실패 시 `items`/`clusters`가 빈 배열이 되어 `:296-299`의 "등록된 클러스터가 없습니다"/"점검 항목이 없습니다" 문구가 그대로 뜬다. 운영자가 백엔드 장애를 "설정 안 됨"으로 오인해 잘못된 조치(항목 재등록 등)를 취할 위험이 있다.
- Fix: `isError`/`error` 구독 후 CLAUDE.md의 Fail-Safe 외부 서비스 패턴에 맞춰 재시도 가능한 에러 배너로 분기.
- Suggested command: `/impeccable harden`

**[P1] 상태 정보가 반복적으로 색상 단독에 의존하는 시스템적 패턴** *(두 어세스먼트 독립 합치)*
- Why it matters: (a) `ClusterCronBadge`의 5가지 톤(off/running/healthy/warning/critical, `:70-121`)이 동일한 Clock 아이콘 + 배경 틴트로만 구분되고 상태 라벨은 `title` hover 전용. (b) `CellButton`(`:60-64`)도 값이 있는 셀은 상태 단어 대신 원값을 보여줘 정상/경고/위험 구분이 `StatusDot` 색상에만 의존한다. 색맹 사용자나 hover 이전 시점에는 매트릭스를 봐도 "지금 위험한 것"을 스캔할 수 없다.
- Fix: 상태별로 다른 아이콘(예: 위험=AlertOctagon, 실행중=Loader2) 또는 상시 노출 짧은 텍스트 라벨 추가.
- Suggested command: `/impeccable clarify`

**[P1] 아이콘 전용 닫기 버튼 3곳에 `title`/`aria-label` 누락** *(detector 미탐지, 수동 검증)*
- Why it matters: `CheckMatrixCellDetailModal.tsx:163-165`, `CheckMatrixItemFormModal.tsx:124-126`, `CheckMatrixSettingsModal.tsx:50-52` 의 X 닫기 버튼 모두 `<X className="w-5 h-5" />`만 있고 `title`/`aria-label`이 없다 — CLAUDE.md 불변 규칙("아이콘 전용 버튼은 title + aria-label 병행")을 직접 위반하며, 스크린리더 사용자는 버튼 목적을 알 수 없다.
- Fix: 세 버튼 모두 `aria-label="닫기"`(+선택적 `title`) 부여 — 프로젝트 내 다른 모달들의 기존 패턴을 그대로 따르면 됨.
- Suggested command: `/impeccable harden`

**[P1] 행 편집/삭제 버튼이 키보드 포커스 시 보이지 않음**
- Why it matters: `PlatformStatusMatrix.tsx:399-417`의 행별 수정/삭제 버튼이 `opacity-0 group-hover:opacity-100`으로만 노출된다. Tab으로 포커스는 가능하지만 `focus-visible:opacity-100` fallback이 없어 키보드 전용 사용자는 어떤 버튼에 포커스가 있는지 시각적으로 알 수 없다(D-052에서 클러스터 관리 화면에 이미 적용한 패턴을 이 화면은 아직 놓치고 있음).
- Fix: `group-hover:opacity-100`에 `focus-visible:opacity-100 focus-visible:ring`을 추가.
- Suggested command: `/impeccable harden`

**[P2] 행 라벨 셀 과밀 (청킹 원칙 위반)**
- Why it matters: 그립핸들·이름·영역칩·소스배지·잠금·실행·수정·삭제까지 최대 8개 요소가 `min-w-[200px]` 셀 하나에 몰림(`:349-419`). 인지부하 체크리스트의 "chunking(≤4)" 항목을 명확히 위반하고, 긴 이름+다수 배지 조합에서 터치 타깃 충돌 위험도 있다.
- Fix: 셀 내부를 2줄로 분리(이름/영역 상단, 소스·잠금·액션 하단)하거나 소스 배지를 hover 전용 정보로 전환.
- Suggested command: `/impeccable distill`

## Persona Red Flags

**Alex (조급한 파워유저)**: 클러스터 ▶ 를 누르고 곧장 로그 패널을 닫으면, `useRunCheckMatrixCluster`/`useRunCheckMatrixItem`의 `onSuccess`가 `['checkMatrixRuns']`만 무효화하고 `checkMatrixKeys.grid`는 무효화하지 않는다(`useCheckMatrix.ts:202-217`). 그리드 갱신은 `CheckMatrixRunLogPanel`이 열려 있는 동안의 배치-완료 감지에서만 일어나므로(`CheckMatrixRunLogPanel.tsx:51-56`), 패널을 닫아버리면 실행이 실제로 끝난 뒤에도 매트릭스가 최대 수십 초간 낡은 값을 보여준다 — "실행했다"는 토스트와 화면 상태가 어긋나는 구체적 버그.

**Sam (스크린리더+키보드 전용)**: `ClusterCronBadge`의 팝오버(`:112-153`)는 토글 버튼에 `aria-expanded`/`aria-haspopup`이 없고 닫기는 backdrop 클릭뿐이라 Escape가 동작하지 않는다 — 다른 모달들이 쓰는 `useModalA11y`(포커스 트랩+Escape)를 이 컴포넌트만 우회한다. 셀의 실패 사유도 `title` 속성에만 있어 스크린리더에서 신뢰성 있게 노출되지 않는다.

**Riley (엣지케이스 스트레스 테스터)**: 클러스터/항목이 많아져도 가상화 없는 순수 `<table>` + `overflow-auto`뿐이고, 영역 색 프리셋은 8개 고정(`rowColors.ts`)이라 9번째 영역부터는 색이 재사용되며 "색=영역" 규칙이 조용히 깨진다(경고 없음). cron 배지 문자열도 길이 제한이 없어 비정상적으로 긴 cron 표현식이 컬럼 정렬을 깨뜨릴 수 있다.

## Minor Observations

- `PlatformStatusMatrix.tsx:243` 카드 헤더가 `bg-muted/40`을 쓰는데 `MacCard` flat variant 표준 헤더 토큰은 `bg-surface-container-high` — 액션 슬롯 필요성은 이해되나 토큰이 미묘하게 어긋남.
- "—" 빈 셀이 미실행/건너뜀/실패-무메시지를 모두 하나의 기호로 뭉갠다 — 도움말 패널 자신도 "왜 계속 '-'인지 답은 대부분 여기 있습니다"라고 인정할 정도로 화면 자체의 설명력이 부족하다.
- 행 순서 변경(`GripVertical`)이 `draggable`/`onDragStart`만 구현돼 있고 keydown 핸들러가 없다 — 포커스 가능한 버튼이 "가능하다"고 약속하지만 실제로는 마우스 전용(WCAG 2.1.1 소지).
- cron "5분 미만 간격 불가" 제약이 도움말에는 있지만 클라이언트 사전 검증이 없어 서버 오류로만 알게 된다(`ClusterCronBadge.tsx:126-133`).
- 모달 배경 스크림에 `bg-black/50`(고정값)을 3개 파일이 공유 — 저장소 전역 88개 파일 101곳에서 동일하게 쓰이는 기존 컨벤션이라 이 화면 고유 회귀는 아니지만, 향후 W1(raw hex 전수 치환) 로드맵 대상.

## Questions to Consider

- 런북 뷰가 스스로 "변경" 배지로 위험 명령을 표시하는 마당에, 클러스터/항목 단위 일괄 실행에는 왜 확인 절차가 없는가 — 콘솔 패턴이 요구하는 "위험 명령은 ConfirmDialog danger"를 이 화면에도 적용해야 하지 않는가?
- 백엔드가 이미 미실행/건너뜀/실패를 구분해서 들고 있는데, 그리드 UI는 왜 이를 하나의 "—"로 뭉개 모든 모호한 케이스를 모달 오픈으로 떠넘기는가?
- 클러스터·점검 항목 수가 늘어날 때 가상화 없는 평면 테이블이 어디까지 버틸 수 있는가?
