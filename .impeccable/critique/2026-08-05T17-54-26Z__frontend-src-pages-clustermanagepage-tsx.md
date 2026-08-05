---
target: 클러스터 관리 (/cluster-manage)
total_score: 30
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 4
timestamp: 2026-08-05T17-54-26Z
slug: frontend-src-pages-clustermanagepage-tsx
---
Method: dual-agent (A: design-review sub-agent · B: detector+evidence sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | 진행률·per-cluster 스피너·토스트는 훌륭하나 인라인 편집 저장 중 명시적 표시 없음 |
| 2 | Match Between System and Real World | 4 | bond0/bond1, CIDR, BGP/AS, kubeconfig 등 실제 어휘 그대로 사용 |
| 3 | User Control and Freedom | 3 | 삭제/일괄수집엔 확인 다이얼로그 있으나 이름 표준화는 되돌리기 수단 없음 |
| 4 | Consistency and Standards | 2 | 커스텀 필드 삭제는 네이티브 confirm(), 클러스터 삭제는 ConfirmDialog — 파괴적 동작 확인 UX 이원화 |
| 5 | Error Prevention | 2 | 이름 표준화가 파급 효과(업무 표시 이름 동기화)를 각주로만 고지, 즉시 실행 |
| 6 | Recognition Rather Than Recall | 3 | 컬럼 헤더 title 툴팁 우수, CIDR 겹침 배지는 상대 클러스터명 미표시 |
| 7 | Flexibility and Efficiency of Use | 4 | URL 영속 필터, 뷰 전환, 컬럼 리사이즈/커스텀, 인라인 편집 |
| 8 | Aesthetic and Minimalist Design | 2 | 13열+커스텀 컬럼+2차 텍스트로 매우 조밀(의도된 밀도지만 감점) |
| 9 | Error Recovery | 3 | 구체적 실패 사유, host별 raw stdout/stderr 노출 |
| 10 | Help and Documentation | 4 | 거의 모든 헤더/버튼에 출처 title — 자기설명적 |
| **Total** | | **30/40** | **Good (28-35)** |

## Design Specificity Verdict

**LLM 평가**: CIDR 겹침 union-find 그룹화, bond0/1 IP 압축 표기, BGP/AS 배지, kubeconfig 기반 auto-update→diff 미리보기, 클러스터명 `[업무명]-[운영타입]-[속성]` 표준화 등은 인프라 엔지니어 전용 도메인 지식이 코드에 직접 박혀 있어 일반 admin CRUD 목록으로 옮길 수 없다. 상호작용 골격(검색+필터+정렬+MacCard 프레이밍+ConfirmDialog)은 PEP 내 다른 목록 화면과 의도적으로 동일한 제네릭 패턴이며, 이는 디자인 시스템 일관성 요구에 따른 합리적 선택이다.

**결정론적 스캔**: `detect.mjs`가 1건(`side-tab`, `ClusterCard.tsx:63` 좌측 `border-l-4`)을 검출했고, 이번엔 **실제 이슈로 확인됐다** — 색상 자체는 상태 토큰이라 하드코딩 위반은 아니지만, 카드 상단에 이미 상태 dot+배지 텍스트가 있어 좌측 보더가 중복 신호이며, 동시에 이 카드가 `MacCard`를 우회하고 `bg-card border` 를 손수 재구현한 사실도 함께 드러났다(CLAUDE.md D-004 위반). 이전 PlatformStatusMatrix 라운드와 달리 이번엔 detector 발견이 오탐이 아니라 실제 결함이었다.

**Visual overlays**: dev 서버 미기동으로 브라우저 실측/오버레이는 스킵 — 정적 코드 분석 + detector 스캔에 근거한다.

## Overall Impression

이 화면은 `DESIGN.md` D-041~D-053(2026-07-29)에서 이미 한 차례 철저히 다뤄졌고, 그 수정들은 대부분 **여전히 잘 유지되고 있다**(토큰화 0건 하드코딩, sticky header, URL 필터, CIDR 겹침 로직, auto-update 레이스 방지 전부 확인됨). 하지만 두 독립 어세스먼트가 각자 다른 방법으로 그 감사의 **경계 바로 바깥**을 찔러보니, 같은 화면 안에서 같은 클래스의 문제가 형제 컴포넌트에는 반영 안 된 지점들이 여럿 나왔다 — 클러스터 삭제는 ConfirmDialog인데 커스텀 필드 삭제는 네이티브 confirm(), 빌트인 셀은 키보드 편집 가능한데 커스텀 셀은 마우스 전용, 테이블뷰 드래그 핸들은 focus-visible인데 카드뷰는 아님. **"감사가 한 컴포넌트를 고치면 형제 컴포넌트도 같이 봐야 한다"**는 교훈이 이 라운드의 핵심 발견이다. 여기에 더해 뷰어 역할 사용자에게 관리자 전용 버�는이 그대로 노출되는 구조적 간극도 새로 드러났다.

## What's Working

1. **CIDR 겹침 탐지 정합성** — union-find 그룹화 + 옥텟 범위 검증(`ClusterManagePage.tsx:40-58,305-341`) — D-053 수정이 실제로 견고하게 유지됨.
2. **동시 auto-update 레이스 방지** — 클러스터별 독립 `AbortController` + 열린 diff를 다른 응답이 덮지 않는 ref 가드(`ClusterManagePage.tsx:105-108,363-399`).
3. **컬럼 헤더의 자기설명적 툴팁** — 각 컬럼이 어떤 kubectl 명령/필드에서 왔는지 명시(`ClusterManagePage.tsx:180-207`).

## Priority Issues

**[P1] 커스텀 필드 삭제 — 네이티브 `confirm()`, 클러스터 삭제와 확인 UX 이원화** *(두 어세스먼트 독립 합치)*
- 근거: `ClusterCustomFieldsManager.tsx:102` — 모든 클러스터의 저장된 값이 함께 사라지는 파괴적 동작인데 브라우저 네이티브 `confirm()`. 같은 페이지의 클러스터 삭제(`ClusterManagePage.tsx:822-835`)는 이미 `ConfirmDialog(danger)`. D-048이 정의한 문제의 형제 버그가 감사 범위 밖에 남아 있었음.
- Fix: `ConfirmDialog(danger)`로 교체, "N개 클러스터의 저장된 값이 함께 삭제됩니다" 명시.
- Suggested command: `/impeccable harden`

**[P1] 커스텀 필드 셀 — 키보드로 편집 진입 불가 (D-052 부분 미반영)**
- 근거: `ClusterCustomCell.tsx:120-128` 읽기모드가 `<span onDoubleClick>`뿐, 버튼/`tabIndex`/`onKeyDown` 전무. 빌트인 필드용 `EditableCell`은 D-052에서 `focus-visible` 연필 버튼을 받았으나 컬럼 관리로 추가하는 정식 기능인 커스텀 컬럼은 그 대상에서 빠짐.
- Fix: `EditableCell`과 동일한 hover/focus-visible 연필 버튼 부여(공용 컴포넌트 추출 권장).
- Suggested command: `/impeccable harden`

**[P1] 모달 닫기 버튼 5곳 `title`/`aria-label` 누락**
- 근거: `CiliumConfigModal.tsx:45`, `ClusterCustomFieldsManager.tsx:134`(닫기)·`:218`(필드 삭제 Trash2), `ClusterUpdateDiffDialog.tsx:95`, `NodeNicsCollectModal.tsx:140`.
- Fix: 전부 `aria-label` 부여(프로젝트 내 이미 확립된 "닫기" 패턴 재사용).
- Suggested command: `/impeccable harden`

**[P1] viewer 역할 사용자에게 admin/operator 전용 버튼이 그대로 노출됨** *(PRODUCT.md 기반 신규 발견)*
- 근거: 백엔드 `clusters.py`의 변경성 엔드포인트는 전부 `require_operator`로 보호되지만, `App.tsx`의 `/cluster-manage` 라우트와 `ClusterManagePage.tsx`/`ClusterTableRow.tsx`/`ClusterCard.tsx` 어디에도 role 체크가 없다. viewer 역할 팀원(PRODUCT.md `## Users`가 명시하는 실제 사용자군)이 이 화면에 들어오면 삭제·일괄수집·인라인편집·이름표준화 버튼이 admin과 동일하게 활성 상태로 보이고, 클릭해야 비로소 403 토스트로 실패를 알게 된다.
- Fix: role 기반으로 변경성 버튼을 비활성/숨김 처리(다른 화면 확산 전 이 화면부터 선례 마련 검토).
- Suggested command: `/impeccable harden`

**[P2] 카드뷰 드래그 핸들 — `focus-visible` 누락 (테이블뷰와 불일치, D-049~053 부분 회귀)**
- 근거: `ClusterManagePage.tsx:78-85`(`SortableClusterCard`)는 `opacity-0 group-hover/card:opacity-100`만 있고 `focus-visible:opacity-100`이 없음. 동일 패턴의 테이블뷰(`ClusterTableRow.tsx:129`)는 이미 갖고 있음.
- Fix: 카드뷰에도 동일한 `focus-visible:opacity-100` 추가.
- Suggested command: `/impeccable harden`

**[P2] `ClusterCard`가 `MacCard`를 우회하고 `bg-card border`를 직접 조합**
- 근거: `ClusterCard.tsx:63` — `Card`/`MacCard(flat)`와 사실상 동일한 클래스를 손수 재구현. CLAUDE.md 불변 규칙(D-004) "페이지에서 bg-card border div 를 직접 조합하지 않는다" 위반.
- Fix: `MacCard`(title 없이, `bodyPadding="p-0"`, `rootClassName`으로 `border-l-4` 유지)로 교체.
- Suggested command: `/impeccable polish`

**[P2] 이름 표준화 — 확인 없이 행별 즉시 적용**
- 근거: `StandardizeClusterNamesModal.tsx:130-137` "변경" 클릭 즉시 적용, 파급 효과(업무 표시 이름 동기화)는 각주(145)로만 고지. D-048의 "확인 다이얼로그" 원칙이 이 동작에는 적용 안 됨.
- Fix: 행별 변경 전 인라인 경고 또는 전체 미리보기→일괄 적용 2단계 플로우.
- Suggested command: `/impeccable harden`

**[P2] Public/private IP 배지 — 색상 단독 표시**
- 근거: `ClusterTableRow.tsx:447-457` — 포커스 불가한 `<span>`에 색상+hover title만, 아이콘/텍스트 없음. 같은 개념을 다루는 `NodeNicsCollectModal.tsx:320-334`는 `Globe`/`Lock` 아이콘을 명시적으로 병기 — 같은 화면 생태계 내 일관성 이탈.
- Fix: `Globe`/`Lock` 아이콘 병기.
- Suggested command: `/impeccable clarify`

**[P2] `NodeNicsCollectModal` — 콘솔 패턴(§12.6) 미준수 + 에러 상태 누락**
- 근거: SSH 자격증명 → 원격 명령 실행 화면임에도 stdout/stderr를 순수 `<pre>`(397-410)로 렌더링, 좌/우 레이아웃·`useTerminalEnvSync` 없음. 또한 `nodeQ.isError`를 쓰지 않아(230-233) 노드 목록 조회 실패가 "노드 없음"으로 오인됨.
- Fix: `<pre>`→`LogViewer` 교체, `isError` 분기로 에러 배너+재시도 추가.
- Suggested command: `/impeccable adapt`

**[P3] CIDR 겹침 배지 — 정보만 주고 해결 경로 없음**
- 근거: `ClusterTableRow.tsx:258-262` "겹침" 텍스트만, 상대 클러스터명 미표시(`overlapGroupIdx`로 이미 계산돼 있음에도).
- Fix: 툴팁에 같은 그룹의 다른 클러스터명 나열.
- Suggested command: `/impeccable clarify`

## Persona Red Flags

**Alex (파워유저)**: 인라인 편집·URL 필터·컬럼 리사이즈는 잘 맞지만, 헤더 6개 버튼을 매번 훑어야 하고(청킹 위반), CIDR 겹침을 발견해도 상대 클러스터를 알려면 13열 표를 눈으로 스캔해야 함.

**Riley (실수 방지형)**: 이름 표준화에서 몇 번째까지 눌렀는지 확신이 안 서고(각주 수준 경고), 같은 페이지의 삭제·일괄수집만 확실한 확인 절차가 있어 "일관되게 안전한 화면인가"에 대한 신뢰가 흔들림.

**(프로젝트 특화) "지훈" — viewer 역할 협업 팀원** (PRODUCT.md `## Users`): 서버는 `require_operator`로 안전하지만 프론트가 role 을 전혀 조회하지 않아, 삭제·일괄수집·인라인편집·이름표준화 버튼이 admin과 동일하게 활성으로 보임 — 클릭 후 403으로만 실패를 알게 됨(오류 예방·상태 인지 모두 실패).

## Minor Observations

- 헤더 액션 6개(뷰모드바·이름표준화·컬럼관리·NIC일괄수집·너비리셋·검색필터)가 동일 무게로 나열 — 빈도 낮은 도구는 kebab 메뉴로 묶는 것 검토(D-051 범위 밖 잔존).
- `ClusterCustomFieldsManager.tsx`의 필드 순서 변경이 ▲▼ 버튼뿐인데 상단에 장식용 `GripVertical` 아이콘이 있어 드래그가 되는 것처럼 보이는 착시.
- `StandardizeClusterNamesModal.tsx:96` "변경" 버튼이 비활성일 때 왜 비활성인지 안내 없음.

## Questions to Consider

- D-048의 "확인 다이얼로그" 원칙이 적용 안 된 파괴적 동작(이름 표준화·커스텀 필드 삭제)이 이 화면에 더 있는지, 위험도별 마찰 매트릭스로 화면 전체를 재점검할 필요는?
- viewer 역할이 실제로 이 화면에 접근하는 시나리오가 있다면, role 기반 버튼 비활성/숨김을 이 화면부터 선례로 삼을지?
- `NodeNicsCollectModal`처럼 페이지 안에서 여는 SSH/exec 모달을 §12.6 "적용 화면" 목록에 공식 편입할지, 별도 예외로 둘지?
