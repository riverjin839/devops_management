# OpenLens 차용 아키텍처 로드맵 — 범용 K8s 관리 + 대규모(300노드) 실시간

> 목표: PEP 의 강점(Cilium 패킷추적·AI 장애분석·Ansible 자동화·운영 점검)은 유지하고,
> OpenLens 의 강점인 **범용 리소스 탐색·실시간 반응성**을 내재화한다.
> **운영 K8s 300노드(수천~만 파드) 실제 환경**을 1순위 제약으로 둔다.

## 가드레일 (결정 사항)
- **읽기 우선(read-first)**. **YAML/Edit 적용은 보류(Phase 5)**, 도입 시에도 **admin 전용** + dry-run + 감사.
- 대상 클러스터에는 가능한 **read-only ServiceAccount** 사용(편집 권한 분리).
- 기존 코드를 엎지 않고 **역할 분리(Python 두뇌 / Go 신경망)** 로 증설.
- 모든 단계는 독립 배포·검증 가능한 작은 PR.

> ⚠️ **가드레일 이탈 기록 (v1.6.0 확인)**: 위 원칙과 달리, `routers/k8s_resources.py`
> 에 scale/restart/delete/**YAML apply**(`PUT .../resources/{kind}/{ns}/{name}/yaml`)/
> cordon/drain 이 **이미 구현·배포**되어 있다. 권한은 `require_admin` 이 아니라
> `require_operator`(admin+operator 모두 허용)이고, **dry-run 로직은 없다**. audit 로그
> 기록만 지켜지고 있다. 안전장치 보강(dry-run, admin 전용 재검토)이 후속 과제다 — 아래
> P5 섹션도 "보류"가 아니라 "완료(안전장치 미흡)" 로 다시 읽을 것.

## 현재 vs OpenLens (조사 결과 근거)
| 영역 | 현재 (파일) | 격차 |
|---|---|---|
| 리소스 커버리지 | 목적별 하드코딩(analyze.py pods/namespaces, infra_nodes, node-labels…) | **범용 탐색/Discovery 없음** |
| 로그 | `analyze.py` `read_namespaced_pod_log`(1회성, tail 200, 장애분석에 종속) | **스트리밍/follow·멀티컨테이너 없음** |
| 실시간 | SSE 제너레이터(`cilium_trace_service` monitor/hubble) — **K8s Watch 아님** | **Watch→브로드캐스트 없음** |
| 멀티클러스터 | TanStack Query 30s 폴링(`useCluster.ts`), Zustand(`clusterStore`) | 전환 시 폴링 지연·깜빡임 |
| 대용량 렌더 | ✅ `react-virtuoso` 도입 완료(`K8sManagePage.tsx` 등에서 실사용) | (해소됨 — 아래 P3 참고) |
| 권한 | `auth/deps.py` require_admin/operator/viewer | edit 은 `require_operator` 로 이미 게이팅됨(단 dry-run 없음) |
| Redis | Celery broker 전용(pub/sub·캐시 미사용) | 이벤트 버스로 확장 여지 |

## 재사용 자산 (조사 매핑)
- SSE 제너레이터 패턴: `routers/cilium_trace.py` + `services/cilium_trace_service.py` → 로그/이벤트 스트림에 재사용.
- K8s 클라이언트 팩토리: `services/kubeconfig.py`(`ensure_kubeconfig_file`) + `new_client_from_config`/`load_incluster_config`.
- 권한 게이트: `auth/deps.py` `require_admin`/`require_operator`.
- Redis(이미 존재) → pub/sub 이벤트 버스로 확장.
- 점검 프레임워크(deep checkers, ops-check) → Runbook 의 pre/post 검증에 재사용.

---

## 단계별 로드맵

### P0 — 로그 스트리밍 + 읽기전용 리소스 뷰어 MVP (Python only) — ✅ 완료 (경로는 계획과 다름)
- **로그 스트리밍**: 계획한 경로(`/k8s/{cluster}/ns/{ns}/pods/{pod}/logs/stream`)가 아니라
  실제로는 **`routers/analyze.py`** 의 `GET /analyze/clusters/{id}/namespaces/{ns}/pods/{pod}/
  logs/stream`(SSE, `follow=True`)로 구현됨. 프론트는 `K8sLogsPage.tsx`. 통합 시 경로를
  하나로 정리할지 결정 필요(현재는 `/analyze` 네임스페이스에 남아 있음).
- **읽기전용 리소스 뷰어**: `routers/k8s_resources.py`(파일 헤더에 "OpenLens P1 MVP" 로 자칭)로
  이미 상당 범위 구현. `react-virtuoso` 가상화도 적용됨(P3 조기 도입).
- 권한: viewer 이상 읽기 — 정확. (단 이 라우터에 이미 쓰기 계열도 추가돼 있음, 가드레일 절 참고)

### P1 — 동적 리소스 탐색기 (Discovery API) — 🟡 부분 구현
- 백엔드: `k8s_resources.py` 가 타입별 list/get + 일부 CRD(`CustomObjectsApi`) 를 지원하나,
  **전체 Discovery API(`/apis`, `/api/v1`) 기반 완전 동적 조회는 여전히 미구현**
  (코드 주석: "전체 Discovery/CRD 동적 조회는 후속(P1 확장)" — 이 부분만 계획대로 남아 있음).
- 프론트: 리소스 트리는 `navConfig.ts` 기반 정적 메뉴 + `K8sManagePage.tsx` 탭 — Discovery
  메타데이터로 동적 렌더하는 방식은 아직 아님.
- 리소스 상세: **Monaco 는 도입되지 않음**(`package.json` 에 `monaco-editor` 없음). 현재는
  `LogViewer`(plain text)로 YAML 을 보여준다. **YAML 편집 자체는 이미 배포됨**(P5 참고 —
  "편집 비활성(P5까지)" 전제가 깨졌다).

### P2 — 실시간 동기화 (N:1 Shared Informer → 브로드캐스트)
- **핵심 원칙**: 클라이언트마다 Watch 금지. 백엔드가 **리소스종류별 단일 Watch** 를 맺고
  Redis pub/sub 으로 다중 클라이언트에 브로드캐스트. WebSocket 라우터 신설.
- **2-트랙 구현 전략(스케일 기준)**:
  - **2a (인터림, Python)**: `kubernetes_asyncio` Watch + Redis pub/sub + FastAPI WebSocket.
    중소 규모에서 정확성 우선 확보. **300노드에서 이벤트 폭주 시 Python 이벤트루프/메모리 한계 위험**.
  - **2b (목표, Go 사이드카)**: `client-go` `SharedIndexInformer` 기반 경량 에이전트가 Watch·캐시·
    WebSocket 브로드캐스트 전담. Python 은 비즈니스 로직(AI/Ansible/DB)만. **300노드 실환경의 1순위 타깃**.
  - 권장: 2a 로 계약(프로토콜·프론트)·정확성 확정 → 부하 측정 → **300노드에서 2b(Go)로 교체**.
- 이벤트 버스: Redis Streams 또는 pub/sub. 초기 스냅샷(list) + 증분(watch) 분리.

### P3 — 프론트엔드 대용량 방어 (브라우저 보호)
- **가상화**: `react-virtuoso`(또는 react-window) 도입 — 뷰포트 행만 렌더. (P0 부터 선적용)
- **이벤트 배칭 미들웨어**: WS 이벤트를 0.5~1s 버퍼에 모아 한 번에 상태 갱신(debounce/batch).
  전용 Zustand store(`clusterStore` 고도화) — 클러스터 전환 시 **WS 컨텍스트만 스위칭, 깜빡임 없음**.
- 백프레셔: 초당 수백 이벤트 시 합치기(coalesce by uid, 최신만 유지).

### P4 — Runbook 파이프라인 (안전한 인프라 제어)
- 위험 작업(노드 drain, etcd defrag 등)에 **[사전검증 → 실행 → 사후검증 → 자동 롤백]** 단계 강제 UI.
- 재사용: `batch_job_service`(실행·결과), deep checkers/ops-check(pre/post 검증), `BatchJobRun`(이력).
- 권한: operator 이상. 각 단계 결과·승인·롤백 트리거를 DB 에 기록(감사).

### P5 — YAML 편집/적용 — ⚠️ 이미 배포됨, 안전장치는 미흡
- 원래 계획은 "보류, admin 전용 + dry-run + 감사 전까지 비활성"이었으나, `k8s_resources.py`
  에 scale/restart/delete/YAML apply/cordon/drain 이 **이미 배포되어 사용 중**이다.
  - 구현된 것: `require_operator` 게이팅(admin+operator), 쓰기 작업마다 `audit_logger` 기록.
  - **아직 없는 것**: server-side dry-run 선행 + diff 확인, admin 전용으로의 재제한 검토,
    read-only SA 와 분리된 별도 edit SA.
- 후속 과제: 위 미흡 항목을 채워 원래 가드레일 수준으로 끌어올릴 것 — 이미 배포된 기능을
  롤백하는 것이 아니라 **안전장치를 사후 보강**하는 방향.

---

## 횡단 관심사
- **권한 모델**: viewer=읽기/로그, operator=Runbook, admin=YAML 편집(P5). `require_*` 로 라우터 게이팅.
- **보안**: 대상 클러스터는 read-only SA 우선. edit 는 별도 SA·감사 필수. kubeconfig 는 `/tmp` 휘발 →
  DB 백필(`ensure_kubeconfig_file`) 유지.
- **성능 측정 게이트**: 2a→2b 전환은 "실측"으로 결정(이벤트/초, 메모리, p95 지연).
- **단계 독립성**: P0(로그)·P3(가상화)는 즉시 가치 + 저위험 → 우선 착수 권장.

## 권장 착수 순서
1. **P0 로그 스트리밍**(저위험·즉시 체감) + **P3 가상화 라이브러리 도입**(전제).
2. **P1 동적 탐색(읽기) + Monaco 읽기전용**.
3. **P2a Python WebSocket Watch+Redis** → 측정 → **P2b Go 사이드카**(300노드 타깃).
4. **P4 Runbook**.
5. (보류) **P5 admin YAML 편집**.

## freelens 코드 분석 결과 — P2/P3 수용 기준 (2026-07 조사)

OpenLens 의 활성 포크 freelens(v1.10.4) 의 실시간 데이터 계층
(`packages/core/src/common/k8s-api/kube-object.store.ts`, `kube-api.ts`)을 분석한 결과,
P2/P3 설계 방향이 실제 구현과 일치함을 확인했다. 아래를 **P2 watch→브로드캐스트
서비스의 수용 기준**으로 삼는다:

1. **단일 watch + resourceVersion 추적**: (클러스터, 종류)당 1개 watch. list 응답의
   `metadata.resourceVersion` 을 네임스페이스별로 저장하고 watch 재개 시 사용.
2. **410 Gone → 재list + 스냅샷 재브로드캐스트**: stale resourceVersion(410) 수신 시
   전체 재list 후 watch 재시작 (freelens `watchNamespace()` 의 resync 패턴).
3. **1s debounce 이벤트 버퍼**: watch 이벤트를 즉시 반영하지 않고 1초 버퍼에 모아
   uid 기준 coalesce(같은 오브젝트는 최신만) 후 일괄 반영. freelens 는
   `eventsBuffer` + MobX reaction(1000ms) 으로 동일 구현. → **프론트는
   `EventsStream.tsx` 에 이미 적용됨(P3 선행)**.
4. **store 상한**: 종류당 최대 50k 오브젝트로 캡(oldest 버림) — 브라우저/메모리 보호.
5. **재연결**: watch 스트림 종료 시 고정 지연(freelens: 1s/5s) 재연결. 초기엔 고정
   지연으로 충분하고, 300노드 부하 측정 후 백오프 도입 판단.

참고 — freelens 는 로그를 **10초 HTTP 폴링(sinceTime 증분)** 으로 구현했으나 PEP 는
SSE follow 스트림이 이미 우월하므로 유지한다. freelens 의 로그 뷰어 UX(컨테이너
드롭다운/previous/검색/다운로드/가상화)와 xterm TTY 터미널, CRD printer columns,
Pods 사용량·warning 컬럼, 드로어 이벤트 탭, 커버리지 확장(Leases/EndpointSlices/
RuntimeClasses/Webhook configs/VAP)은 2026-07 에 차용 완료.

## 비고
- 현재 파드 로그 기능은 `analyze.py` 의 1회성 조회로 존재(스트리밍 아님) → P0 에서 확장.
- Go 사이드카는 "기존 코드 교체"가 아니라 **Watch/브로드캐스트 전담 추가** — Python 자산은 보존.
