# K8S 자원 관리(`/k8s-allocation`) 버그·효율화·개선 감사

- **감사일**: 2026-07-30
- **1차 수정 반영(2026-07-30)**: 아래 표의 **P0/P1** 항목 대부분을 이번 배치에서 코드 수정
  완료(상태 열 참고). **P2/백로그**는 아직 미착수 — 후속 작업 참고용으로 기록만 해둔다.
- **대상 화면**: K8S 자원 관리(`/k8s-allocation`, `/k8s-allocation/:clusterId`) — 노드/네임스페이스별
  request 대비 실사용량(slack) 진단, 용량 계획 화면 (`docs/SCREENS.md` §K8S 자원 관리)
- **대상 코드**:
  - Backend: `backend/app/routers/k8s_allocation.py`, `backend/app/routers/k8s_resources.py`
    (`GET /k8s/{id}/pods-summary`), `backend/app/services/snapshot_jobs.py`,
    `backend/app/services/k8s_paging.py`
  - Frontend: `frontend/src/pages/K8sAllocationPage.tsx`(단일 파일, 감사 시점 1358줄),
    `frontend/src/hooks/useK8sAllocation.ts`, `frontend/src/lib/csv.ts`

정적 코드 정독(백엔드/프론트 각각 전담 탐색 후 핵심 주장 직접 검증) 기반 감사다. 우선순위:
**P0(정확성/무결성 훼손 — slack·자원량이 실제와 어긋남) → P1(오동작·데이터 불일치·UX 결함) →
P2(효율화/리팩터링/디자인 시스템) → 백로그(더 큰 변경이 필요한 항목)**.

---

## 요약 (TL;DR)

1. **Pod 유효 request 계산이 init 컨테이너/네이티브 사이드카/`RuntimeClass overhead` 를
   전부 누락**해, 이 화면의 존재 이유인 slack(여유) 진단이 메시(Istio/Linkerd 등) 주입
   클러스터에서 항상 과대평가되고 있었다. (BE-1, **수정됨**)
2. **apiserver 5xx 나 `_continue` 토큰 만료로 절단된 스냅샷이 24시간짜리 확정 데이터처럼
   캐시**됐고, **행업(hang)된 백그라운드 집계는 새로고침으로도 영구히 복구 불가**했다.
   (BE-2/BE-3, **수정됨**)
3. **과할당 노드의 음수 여유(slack)가 초록색 "여유 -8192Mi"로 표시**되고, 사용률 배지·%R
   색상 판정이 반올림 vs 원시 비율로 서로 어긋나는 등 프론트 표시 버그가 다수 있었다.
   (FE-1/FE-3, **수정됨**)
4. 실제 K8s `pod-template-hash` 알파벳과 안 맞는 정규식으로 **워크로드 개수가 부풀려지고**,
   한글 클러스터명이 CSV 파일명에서 `-` 로 뭉개지는 등 크고작은 버그가 다수 있었다.

---

## 상태 범례

| 상태 | 의미 |
|---|---|
| **수정됨** | 이번 배치(2026-07-30)에서 코드 수정 + 테스트 반영 완료 |
| 백로그 | 이번 배치에서 다루지 않음 — 후속 작업 필요 |

---

## P0 — 정확성/무결성 (slack·집계가 실제와 어긋남)

### BE-1. Pod 유효 request 계산이 init/사이드카/overhead 를 누락 — **수정됨**

`k8s_allocation.py` 의 모든 집계 지점(`_build_overview`, `allocation_node_refresh`,
`allocation_namespace_refresh`, `allocation_workloads`)이 `_sum_resources(p.spec.containers)`
만 합산했다. K8s 스케줄러의 실제 유효 요청량 규칙은
`max(Σ(일반 + 사이드카 컨테이너), max(일반 init 컨테이너)) + spec.overhead` 다.

- **네이티브 사이드카**(init 컨테이너 중 `restartPolicy: Always`, 1.29+ GA — Istio/Linkerd/
  Vault/로그 사이드카가 흔히 이 방식)가 request 0 으로 집계 → `cpu_slack_m = cpu_alloc - rc`
  가 실제보다 과대(여유가 있는 것처럼 보임). 이 화면의 목적 자체("얼마나 더 스케줄 가능한가")가
  메시 주입 클러스터에서 거꾸로 나온다.
- 마이그레이션용 대형 `initContainer`(예: 2 코어)가 완전히 무시됨.
- `RuntimeClass`(Kata/gVisor) `spec.overhead` 미반영.

**수정**: `_pod_effective_resources(spec)` 헬퍼를 신설해 위 규칙대로 계산하고, 4개 집계
경로 전부와 `allocation_pods` 의 컨테이너 표시(사이드카 포함)에 적용. 단위 테스트
(`tests/test_k8s_allocation_quantities.py`)로 일반 컨테이너만/사이드카 합산/init 최댓값/
overhead 4가지 케이스를 고정.

### BE-2. 절단(partial) 스냅샷이 24시간 확정 데이터로 캐시됨 — **수정됨**

`k8s_paging.iter_all` 은 apiserver 5xx 나 `_continue` 토큰 만료(410 Gone, etcd compaction)
시 조용히 순회를 중단하고 partial 결과를 반환한다(대규모 클러스터에서 502 대신 graceful
degrade — 설계 의도 자체는 맞다). 문제는 `SnapshotManager` 가 완전 결과와 절단 결과를 동일한
`_OVERVIEW_TTL`(기본 24시간)로 캐시했다는 점 — 첫 페이지에서 일시적 503 을 맞으면 "노드 0개
파드" 스냅샷이 하루 종일 확정 데이터처럼 서빙될 수 있었다.

**수정**: `SnapshotManager` 에 `partial_ttl`(기본 5분, `K8S_ALLOC_PARTIAL_TTL`) 을 추가 —
결과가 `partial=True` 면 짧은 TTL 로 취급해 자동 재집계를 유도한다. `k8s_paging.iter_all` 도
절단 시 `logger.warning` 을 남기도록 해 운영 로그로 추적 가능하게 했다.

### BE-3. 행업된 빌더가 영구 wedge — refresh 로도 복구 불가 — **수정됨**

`SnapshotManager.get()` 은 `status == "computing"` 이면 `force=True` 라도 재시작하지 않는다
(폭주 방지가 목적 — 설계 의도는 맞다). 그런데 `started_at` 은 기록만 되고 아무도 읽지 않았고,
`_build_overview` 의 시간 예산(`deadline`)은 애초에 `None` 으로 고정돼 있어 **상한이 전혀
없었다**. apiserver 가 응답을 멈추면 그 클러스터의 스냅샷은 백엔드 재기동 전까지 영구히
"집계 중"으로 고정된다.

**수정**: `stuck_timeout`(기본 30분, `K8S_ALLOC_STUCK_TIMEOUT`) 을 추가 — computing 이 이
시간을 넘기면 행업으로 간주하고 새 계산으로 교체한다.

### BE-9. `ApiClient` 누수 — **수정됨**

`_api_client(cluster)` 가 반환하는 `kubernetes.client.ApiClient`(urllib3 `PoolManager` +
스레드풀 보유)를 어떤 호출부도 `.close()` 하지 않았다. 이 화면은 1.5초 폴링 + 자동갱신이
있어 누적 속도가 빠르다. `_api(cluster)` 컨텍스트매니저를 추가해 모든 엔드포인트/빌더가
`with` 블록 안에서 클라이언트를 사용하고 항상 닫도록 통일했다.

---

## P1 — 오동작 / 데이터 불일치 / UX 결함

### 백엔드

| ID | 요약 | 상태 |
|---|---|---|
| BE-4 | `_POD_USAGE_MAX`(6000) 미사용 — 대규모 클러스터 보호 미구현. 활성 Pod 수가 이 값을 넘으면 cluster-wide pod usage(metrics) 조회를 생략하도록 수정. 초대형 클러스터에서 usage 열이 영구 공백이던 문제 완화. | **수정됨** |
| BE-5 | `int()` 절삭으로 nanocores(`"451331n"`) 서브밀리코어 usage 가 소실되던 문제 — 반올림(`ROUND_HALF_UP`)으로 교체 + 파싱 실패 시 `logger.warning` 추가(이전엔 무로깅 `except: return 0`). | **수정됨** |
| BE-6 | `_strip_hash` 정규식(`[a-f0-9]{8,10}`)이 실제 K8s `pod-template-hash` 알파벳(`bcdfghjklmnpqrstvwxz2456789`, hex 아님)과 안 맞아 RS 세대별로 별개 워크로드로 집계 — 워크로드 개수가 드릴다운과 불일치. 알파벳 교정. | **수정됨** |
| BE-7 | `allocation_pods` 에 phase 필터가 없어 워크로드 목록의 `pod_count` 와 펼친 pod 행 수가 안 맞음(`Unknown` phase pod 포함). 활성 phase 필터 추가. | **수정됨** |
| BE-8 | `allocation_node_refresh` 의 pod LIST 가 무방비 — RBAC 403/필드셀렉터 오류가 502 대신 raw 500 으로 노출. try/except + 502 매핑 추가. | **수정됨** |
| BE-11 | 구조화된 `HTTPException`(422 "kubeconfig 미등록")이 백그라운드 스레드 안에서 발생하면 `snapshot_jobs.py` 가 이를 뭉개고 502 "자원 집계 실패: 422: ..." 로 재포장 — 원인 불명확 + 원시 예외 텍스트 노출. | 백로그 |
| BE-12 | 요청 스코프 SQLAlchemy 세션에서 로드한 `cluster` 객체를 백그라운드 스레드에서 접근(detached instance) — 오늘은 우연히 동작하지만 향후 커밋 경로가 추가되면 `DetachedInstanceError` 위험. | 백로그 |
| BE-14 | `_CACHE`(드릴다운 20초 TTL)가 무제한 성장 + 클러스터 삭제/kubeconfig 로테이션 시 무효화 안 됨 — raw Pod 객체를 캐시하지 않는다는 모듈 docstring과도 모순. | 백로그 |
| BE-15 | 멀티 replica(prod `replicaCount: 2`) 환경에서 `_overview_mgr`/`_CACHE` 가 프로세스 로컬 — 폴링이 서로 다른 파드에 번갈아 맞으면 진행률이 오락가락하고 apiserver 부하가 2배. | 백로그 (Redis 등 공유 캐시 필요 — 별도 설계) |
| BE-17 | `summary.namespace_count`(전체 NS)와 `items`(활성 파드 있는 NS만)의 분모가 다름, `summary.pod_count` 와 `Σ node.pod_count` 가 Pending 파드 포함 여부로 어긋남, `metrics_available` 필드가 nodes/namespaces 엔드포인트에서 서로 다른 의미로 재사용됨 — 필드 자체의 재설계가 필요해 이번 배치 범위 밖. | 백로그 |

### 프론트엔드

| ID | 요약 | 상태 |
|---|---|---|
| FE-1 | 과할당 노드의 음수 slack 이 `fmtGi`/`fmtCores` 의 양수 전용 분기를 타 "-8192Mi" 로 뒤틀리고, 항상 초록 "여유"로 표시됨 → `slackLabel`/`slackCls` 헬퍼로 부호에 따라 라벨("여유"/"부족")·색(healthy/critical) 분기. | **수정됨** |
| FE-2 | `fmtCores` 가 1코어 미만이면 단위 없는 값을 반환하고 호출부가 개별적으로 "코어"를 붙여 "500m 코어"처럼 겹침 → `fmtCores` 가 스스로 단위를 표기하도록 통일. | **수정됨** |
| FE-3 | 효율 배지(`efficiency()`, 원시 비율 비교)와 `UtilPct`(반올림 정수 비교)가 같은 값에서 색이 어긋남(예: 실비율 1.052 → 배지=위험, R%=105%=정상으로 보임) → `UtilPct` 도 원시 비율(`utilRatio`)로 판정하도록 통일, 도움말 텍스트("30–100%")도 "30–105%"로 정정. | **수정됨** |
| FE-4 | 분모(allocatable) 0/음수일 때 `ratio()` 가 0을 반환해 "0%"(정상처럼 보임)로 위장 + MEM 할당효율에 CPU와 달리 `warn` 미적용 → `ratio()` 가 `null` 반환하도록 변경, 모든 호출부 null-safe 처리, MEM 할당효율에도 CPU와 동일한 `warn` 추가. | **수정됨** |
| FE-5 | NsRankingView 정렬 comparator 가 비추이적(slack 유무 혼재 시 A>B>C>A 순환 가능) → 단일 정렬키(`slack ?? -Infinity`)로 교체. `eff` 정렬 접근자가 `Math.max(1, req)` 로 0 나눗셈을 피해 request 없는 네임스페이스가 최상단으로 정렬되면서 배지는 없는 모순 → `efficiency()` 와 동일하게 `reqM<=0` 이면 `null`. | **수정됨** |
| FE-6 | 수동 새로고침이 `useForceAllocRefresh` 내부에서 `setQueryData` 직접 호출이라 `isFetching` 이 안 올라가 스피너가 안 돎, 연타 방지 없음, 실패가 `catch {}` 로 완전히 무시됨 → `useMutation` 기반으로 재작성해 `isPending`/`isError` 노출, 버튼 disabled + 실패 시 "(실패, 재시도)" 표시, 자동갱신 tick 도 in-flight 중이면 skip. | **수정됨** |
| FE-7 | CSV 파일명 `csvCluster()` 가 `\w`(ASCII 전용)로 한글 클러스터명을 전부 `-` 로 뭉갬, `today()` 가 UTC 라 KST 오전 9시 이전 내보내기가 하루 밀림, `lib/csv.ts downloadCsv` 가 앵커를 DOM 에 붙이지 않고 즉시 revoke — Firefox/구버전 Safari 다운로드 실패 사례. 유니코드 허용 정규식 + 로컬 날짜 + DOM append/지연 revoke 로 수정. | **수정됨** |
| FE-8 | `PodScheduleCalc` 라벨이 "schedulable 노드 {fit>0 인 노드 수}/{schedulable 노드 총수}" 로 오독 → "배치 가능 노드 X / schedulable Y" 로 정정. 숫자 입력(`min="0"` 은 UI 힌트일 뿐)이 음수를 그대로 통과시켜 결과가 조용히 0으로 보이던 문제 → 계산 직전 clamp. | **수정됨** |
| FE-9 | `NsRankingView` 에 조회 실패(`isError`) 분기가 없어 502 가 "표시할 네임스페이스가 없습니다"(빈 상태)로 보임 → 다른 3개 뷰와 동일한 "조회 실패" EmptyState 추가. | **수정됨** |
| FE-10 | `POD_STATUS_META[].cls` 가 정의만 되고 렌더에 쓰이지 않아 POD 상태 카드 수치에 상태색이 전혀 안 먹음 → `Stat` 에 `valueClassName` prop 추가해 적용. 재집계 중 이전/부분 스냅샷을 보고 있다는 안내가 전혀 없던 문제 → `partial`/`stale` 배지 추가(BE-2 의 partial TTL 단축과 짝). | **수정됨** |
| B17(FE) | PodScheduleCalc 가 Ready 조건/taint 를 반영하지 않고 `podsAllocatable === 0` 을 "무제한"으로 처리 — 파싱 실패와 진짜 0 을 구분 못 함. | 백로그 |

---

## P2 — 효율화 (이번 배치 미착수, 후속 권장)

| ID | 요약 |
|---|---|
| E1 | 1.5초 computing 폴링마다 루트 컴포넌트가 `nsQ`/`nodesQ` 를 직접 구독해 페이지 전체(요약·POD 카드·활성 뷰 전부)가 리렌더된다. progress 전용 경량 셀렉터로 분리하면 완화. |
| E2 | `NodesView` 카드/테이블 뷰에 페이지네이션·가상화가 없다. 364노드급 클러스터에서 `GaugeRow`/`MeterBar`/`UtilPct` 가 매 폴링마다 전량 리렌더 — `React.memo` + 가상 스크롤 필요. |
| E5/E6 | 드릴다운 쿼리(`useAllocWorkloads`/`useAllocPods`)가 전역 `refetchOnWindowFocus:true` 를 상속해 알트탭 복귀 시 펼쳐진 행 수만큼 동시 재요청. `enabled` 인자도 항상 `true` 로 호출돼 사문화(마운트/언마운트로만 lazy 를 구현 중). |
| E7 | `usePodsSummary` 가 자동갱신/강제새로고침 대상에서 빠져 있어 POD 용량/상태 카드가 클러스터 요약 카드보다 최대 수십 초 뒤처질 수 있다. |
| E8 | `forceRefresh` 가 nodes/namespaces 두 엔드포인트를 각각 `refresh=1` 로 호출하지만 백엔드에선 동일 스냅샷 키(`{cid}:overview`)를 공유 — 사실상 1번으로 충분. |
| E3/E4/E9 | 정렬 tiebreak 의 `localeCompare` 비용, export 클로저 재생성, 1358줄 단일 파일(`NodesView`/`NamespacesView`/공용 테이블 프리미티브 분리 여지). |
| BE-1(E) | 백엔드 LIST 가 `resource_version="0"` 을 전혀 안 써서 매 스냅샷이 etcd quorum read — 대형 클러스터에서 가장 저렴한 단일 최적화. |
| BE-1(E2) | `allocation_node_refresh` 가 노드 1개 갱신에 cluster-wide metrics 를 조회(N+1) — `get_cluster_custom_object(...,"nodes",node)` 단건 조회로 대체 가능. |
| BE-1(E8) | `pods-summary`(`k8s_resources.py`)가 페이지네이션 없이 전체 Pod 를 단일 60초 타임아웃 요청으로 조회 — `k8s_paging` 재사용 권장. `/k8s-allocation` 진입 시 allocation 스냅샷과 동시에 별도의 전량 Pod 순회가 한 번 더 발생하는 구조. |

---

## 디자인 시스템 위반 (백로그 — 이번 배치 미착수)

CLAUDE.md §UI Design System / DESIGN_SYSTEM.md §12 기준. `ClusterSidebar iconOnly` 준수,
`<select>` 클러스터 선택기 없음, raw hex 없음은 확인됨. 위반 항목:

- **MacCard 미사용**(D-004): `Stat`/노드 카드/드릴다운 테이블/툴팁 패널/탭바에서 `bg-card
  border` 를 직접 조합(7곳).
- **라운딩 토큰**: 버튼/입력 다수가 `rounded-xl` 대신 `rounded-lg`/`rounded-md`/`rounded`.
- **인라인 스타일**: width% 는 동적값이라 불가피하지만 `opacity: 0.85`, `display: 'grid'` 는
  Tailwind 클래스로 대체 가능.
- **아이콘 버튼 `title` 누락**: `StatTooltip`, `PodScheduleCalc` 팝오버 트리거에 `aria-label`
  만 있고 `title` 없음(같은 파일의 다른 버튼들과 불일치). `SortableTh` 는 `aria-sort`/
  `type="button"` 도 없음.
- **서피스 토큰 우회**: `bg-card/50`, `bg-muted/40|20|10|5` 등 ad-hoc 불투명도 대신
  `bg-surface-container-*` 사다리 사용 권장.
- **차트 색상**: `NsRankingView` 가 `--chart-*` 대신 `--status-*` 토큰 사용.
- **CardHeader 중복 구현**: `MacCard` 헤더 스타일을 손으로 재구현 — `MacCard` 에
  `headerRight`/`actions` prop 을 추가하는 게 정석.

## 접근성 / i18n (백로그)

- `<tr role="button" tabIndex={0}>` 가 중첩된 인터랙티브 버튼을 감싸 스크린리더 시맨틱을
  깨뜨림 — `role="row"` + 전용 disclosure 버튼으로 교체 권장.
- `aria-hidden` 스페이서 셀이 실제 그리드 열 카운팅을 깨뜨림.
- `SearchInput` 에 `aria-label`/`<label>` 없음.
- 테이블 헤더(`Node`/`Pods`/`Workloads`/`Namespace`/`QoS` 등)만 영어, 나머지는 한글로 불일치.
- 빈 상태 문구가 뷰마다 3가지 형태로 다름.

## 테스트 커버리지 (이번 배치에서 보강)

- `tests/test_k8s_allocation_quantities.py`(신규): `_cpu_m`/`_mem_b` 파싱(반올림/실패),
  `_strip_hash`(실제 해시 알파벳), `_pod_effective_resources`(일반/사이드카/init max/overhead).
- `tests/test_snapshot_jobs.py`(신규): TTL 재사용, force 재계산, partial TTL 단축, stuck
  timeout 교체, stuck timeout 이내 미교체.
- `tests/test_allocation_overview.py`(기존, 시그니처 변경분만 반영): `_build_overview` 가
  `cid` 파라미터를 더 이상 받지 않도록 시그니처 정리(사용되지 않던 인자 제거).
- 여전히 비어있는 영역(백로그): 6개 엔드포인트의 `TestClient` 통합 테스트(refresh, computing
  응답 모양, 502 매핑), `SnapshotManager` 의 동시성(락) 테스트, `pods_summary`/
  `_classify_pod_status` 테스트.

---

## 참고 — 감사 방법론

프론트/백엔드를 각각 별도 탐색 에이전트가 전담 정독(핵심 파일 라인 단위 인용 포함)한 뒤,
가장 심각도 높은 주장(집계 로직·죽은 설정값·TTL/락 구조)을 코드 직접 열람으로 재검증하고
수정했다. 이번 배치는 **정확성·안정성에 직결되는 P0/P1** 만 다뤘고, 효율화(P2)·디자인
시스템 정합성·접근성·i18n·나머지 테스트 공백은 표에 기록만 해 두고 후속 작업으로 남긴다.
