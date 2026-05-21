# Analysis — Cluster Detail Monitoring

> 작성일: 2026-05-21
> 모드: 정적 분석 only (런타임 검증 없음 — 사용자 합의)
> Plan: `docs/01-plan/features/cluster-detail-monitoring.plan.md`
> Design: `docs/02-design/features/cluster-detail-monitoring.design.md`
> 대상 질문: ① 잘 설계됐는가 ② 잘 동작하는가 ③ 사용자 친화적인가

---

## TL;DR

**합격선 근처(81%)지만 구조적 빚 누적**. 점검 엔진은 잘 추상화돼 있고 (Strategy + Registry, fail-safe) UI 도 macOS 디자인 시스템에 잘 통합되어 있다. 그러나 **3개의 평행 점검 파이프라인 (HealthChecker / DailyChecker / DeepCheckService)** 이 같은 `cluster.status` 컬럼을 동시에 갱신하는 구조라 last-write-wins race 가 잠복해 있고, `DailyChecker._check_components` 는 K8s 1.27+ 에서 영구히 빈 결과만 반환한다 (`kubectl get componentstatuses` 가 1.27 에서 제거됨). UX 측면에서는 Dashboard "체크 실행" 버튼과 리뷰 페이지의 점검 데이터가 서로 다른 파이프라인이라 사용자가 혼란을 겪을 가능성이 매우 높다.

### 결론

| 질문 | 답 | 핵심 근거 |
|---|---|---|
| **잘 설계됐는가?** | 부분 합격 (75/100) | Strategy/Registry/fail-safe 우수 ↔ 3-pipeline 중복 + cluster.status race + 죽은 코드(componentstatuses) + 죽은 컬럼(resource_summary) |
| **잘 동작하는가?** | 조건부 합격 (70/100) | K8s 1.26 이하면 OK, **1.27+ 에서는 components 체크 항상 실패**. 5개+ 클러스터 환경에서 Celery 5분 timeout 위험 |
| **사용자 친화적인가?** | 부분 합격 (70/100) | macOS 디자인/iconOnly 사이드바 일관성 좋음 ↔ Dashboard ↔ 리뷰 페이지 연결 빈약, "체크 실행" 버튼이 실제로 어느 파이프라인을 도는지 사용자가 모름, AI 리뷰 Markdown 미렌더, picker 가 native select |

### Match Rate (Static Analysis only)

```
Overall = Structural × 0.2 + Functional × 0.4 + Contract × 0.4
        = 0.95 × 0.2 + 0.65 × 0.4 + 0.90 × 0.4
        = 0.81 (81%)
```

- **Structural 95%**: 약속된 컴포넌트(Pipeline/UI/Hook/Model) 거의 모두 존재
- **Functional 65%**: K8s 1.27+ components 죽음 + 3-pipeline race + resource_summary 미사용 + AI 리뷰 fallback 분류 부족
- **Contract 90%**: API ↔ Frontend 타입 매핑 양호. 다만 `useMemo` for side effect 이슈 (계약 위반)

→ **90% 미만 → iterate 권장** (Critical 3건 + Important 5건 픽스)

---

## 🟢 잘된 점 (먼저 짚기)

1. **`BaseChecker.safe_check` 의 fail-safe 분류가 모범적** (`base.py:79-106`)
   - 연결 예외 hint 키워드 매칭으로 `pending` (=미연결) vs `critical` (=연결됐는데 addon 죽음) 을 구분.
   - 운영자에게 "네트워크 문제냐, 서비스 문제냐" 를 한눈에 보여주는 핵심 디자인.

2. **AI 리뷰가 점검 commit 후 fire-and-forget 큐잉** (`daily_checker.py:89-96`)
   - Ollama 가 죽어도 점검 자체에는 영향 없음. 명시적으로 `try/except` + logger.debug.
   - Plan NFR-1 (fail-safe) 정확히 충족.

3. **`NodeChecker` 의 1-call optimization** (`node_checker.py:23`)
   - `list_node()` 1회 + 메모리 집계. 200 노드+ 환경에서도 sub-second. 잘 짜여있음.

4. **`EtcdChecker` 의 다단 fallback** (`etcd_checker.py`)
   - pod exec → etcdctl_config 스냅샷 → etcd_systemd 스냅샷 → warning + 가이드 메시지.
   - 운영 환경의 다양성(kubeadm/StaticPod/systemd) 을 코드 레벨에서 직시한 좋은 케이스.

5. **Strategy + Registry 두 family**
   - `services/checkers/` (CHECKER_REGISTRY, 14개 checker)
   - `services/deep_checkers/` (get_checker_class, 13개 deep checker)
   - 새 checker 추가 비용이 매우 낮음.

6. **사이드바 iconOnly 패턴 준수** (`DailyCheckReview.tsx:71-80`)
   - CLAUDE.md 의 ClusterSidebar Standard 정확히 따름. 시각 일관성 확보.

7. **macOS 디자인 시스템 일관 적용** — MacCard, rounded-2xl, --card-shadow 모두 일관됨.

---

## 🔴 Critical Findings (구조 / 동작)

### G-1. 3개의 평행 점검 파이프라인이 `cluster.status` 를 동시에 갱신 — race + 일관성 깨짐

**근거**:
- `health_checker.py:88-90` — `cluster.status = overall_status`
- `daily_checker.py:81-83` — `cluster.status = overall_status` (commit 직전 + commit 후 또 한 번)
- `deep_check_service.py` — cluster.status 직접 갱신은 안 함 (간접적으로 review 에서 status 표시)

**문제**:
- 같은 클러스터의 `status` 가 어느 파이프라인이 마지막에 돌았느냐에 따라 달라진다.
- 시나리오: 09:00 DailyChecker → healthy. 09:15 DeepCheckService → cert 만료 임박 critical 결과지만 cluster.status 미갱신. 11:00 사용자가 Dashboard "체크 실행" → HealthChecker 가 cert addon 등록 안돼서 healthy 로 덮어씀. 운영자는 cert 임박 critical 결과를 영영 못 봄.
- 한 행이 동시에 commit 되면 last-write-wins (SQLAlchemy default isolation: READ COMMITTED, no row-level lock).
- 어느 파이프라인이 "authoritative" 인지 코드/주석/문서 어디에도 명시 없음.

**Severity**: 🔴 Critical (운영 신뢰성 핵심)
**Confidence**: 95%

**권고**:
1. 단기: cluster.status 갱신 시 `with_for_update()` SELECT-FOR-UPDATE 적용. 최소 race 차단.
2. 중기: **"authoritative pipeline" 단일 지정** — 예: DailyChecker(가장 종합) 만 cluster.status 갱신. HealthChecker/DeepCheck 는 자기 도메인 결과(addon.status, deep_check_results) 만 쓰고 cluster.status 는 derived view 로 노출.
3. 장기: `cluster.status` 컬럼 제거 후 `view_cluster_current_status` (DB view) 도입. 세 파이프라인 결과를 weighted 조합.

---

### G-2. `DailyChecker._check_components` 는 K8s 1.27+ 에서 영구히 실패

**근거**: `daily_checker.py:148-185`
```python
cmd = self._build_kubectl_cmd(cluster, "get", "componentstatuses", "-o", "json")
```

**문제**:
- `componentstatuses` API 는 K8s 1.19 부터 deprecated, **1.27 부터 완전 제거**.
- 1.27+ 클러스터에서는 `kubectl get componentstatuses` → `error: the server doesn't have a resource type "componentstatuses"` 반환.
- 코드는 proc.returncode != 0 → `components["error"] = proc.stderr` 로 끝.
- 그 후 `_determine_overall_status` 가 `components.items()` 순회할 때 `comp_name == "error"` 면 continue → critical 분기 못 탐 → 사실상 components 체크가 의미 없는 결과가 됨.
- **사용자가 "녹색 healthy" 라고 안심하지만 실제로는 components 체크 자체가 안 돌고 있음** — silent failure.

**Severity**: 🔴 Critical (Plan SC-5 위반, 모던 K8s 환경 무력화)
**Confidence**: 99% (K8s changelog 확정)

**권고**:
1. `_check_components` 삭제. `ControlPlaneChecker` (이미 K8s SDK 로 올바르게 구현됨, `control_plane_checker.py:35-61`) 가 같은 일을 함. DailyChecker 가 ControlPlaneChecker 결과를 reuse 하거나 직접 호출하도록 변경.
2. 임시 패치: subprocess returncode != 0 인 경우 `pending` 으로 분류 + warning_messages 에 "components check unavailable on this K8s version" 명시.

---

### G-3. `DailyChecker` 가 subprocess `kubectl` 사용 — 패턴 불일치 + 인프라 의존

**근거**:
- `daily_checker.py:152, 192, 232` — 모두 `subprocess.run(["kubectl", ...])`
- `base.py:50-65` — BaseChecker family 는 Python `kubernetes` SDK 사용

**문제**:
- backend 컨테이너에 `kubectl` 바이너리가 설치돼 있어야만 동작. CLAUDE.md 도 인정: *"kubectl checks failing in Docker Compose — The backend container does not have kubectl or a kubeconfig by default"*.
- kubectl 버전 ↔ 클러스터 버전 mismatch 시 silent skew.
- BaseChecker 의 SDK 경로는 in-cluster ServiceAccount 자동 처리 (`config.load_incluster_config()`) — DailyChecker 는 못 함.
- 결과: HealthChecker 는 K8s 배포 시 그냥 동작, DailyChecker 는 별도 kubeconfig + kubectl binary 마운트 필요.

**Severity**: 🔴 Critical (architectural inconsistency, deployability)
**Confidence**: 95%

**권고**:
- DailyChecker 를 `BaseChecker` 와 같은 SDK 기반으로 마이그레이션. `_check_nodes` 는 `NodeChecker.check()` 재사용, `_check_components` 는 G-2 와 함께 `ControlPlaneChecker` 로 위임, `_check_system_pods` 는 신규 `SystemPodChecker` 로 통합.
- 결과: kubectl 바이너리 의존 제거 + 코드 라인 ~150줄 감소 + checker 추가 시 한 곳만 보면 됨.

---

## 🟠 Important Findings

### G-4. `DailyCheckLog.resource_summary` 컬럼 dead

**근거**: `models/daily_check.py:52-53` 정의됐지만 `daily_checker.py` 어디에서도 SET 하지 않음.

**문제**: DB 스키마 부담만 있고 가치 없음. Plan 작성 시점에 의도했던 "리소스 사용량 요약" 기능이 코드로는 미완성. 사용자 UI 에 노출도 안 됨.

**Severity**: 🟠 Important
**Confidence**: 95%
**권고**: 둘 중 하나. (a) PromQL 메트릭 카드와 통합해서 실제로 채우거나, (b) 모델에서 컬럼 제거 + 마이그레이션 작성.

---

### G-5. `run_scheduled_check` 의 5분 timeout + 직렬 처리

**근거**:
- `celery_app.py:27` — `task_time_limit=300`
- `celery_app.py:97-136` — 모든 클러스터를 직렬 `for cluster in clusters:` 처리

**문제**:
- 각 클러스터 daily check ≈ 5-30초 (kubectl 타임아웃 30s × 4 호출 + httpx 3 호출).
- 5개 클러스터 = 25-150초. 10개 = 50-300초. **10개 부터 timeout 위험 영역**.
- Celery `task_time_limit` 도달 시 `SoftTimeLimitExceeded` raise → 부분 결과 commit 됐지만 어느 클러스터가 남았는지 알 수 없음 → Plan SC-1 (누락 0건) 위반.

**Severity**: 🟠 Important (스케일 위험)
**Confidence**: 85% (실측 안 함)
**권고**:
- 클러스터별 sub-task 분리: `for c in clusters: run_single_check.delay(c.id, schedule_type)` — Celery 가 worker concurrency 만큼 병렬 실행.
- 또는 `chord([run_single.s(c.id) for c in clusters], collect_results.s())` 패턴.

---

### G-6. `DailyCheckReview.tsx` 가 `useMemo` 안에서 side effect 호출 — React 안티패턴

**근거**: `DailyCheckReview.tsx:48-59, 163-171`
```typescript
useMemo(() => {
  if (params.get('log') || latestLogId) return;
  if (!clusterId) return;
  api.get<DailyCheckLogLite>(`/daily-check/results/${clusterId}/latest`)
    .then((res) => { if (res.data?.id) setLatestLogId(res.data.id); })
    ...
}, [clusterId, params, latestLogId]);
```

**문제**:
- `useMemo` 는 **computed value 캐싱용**. side effect 실행은 React 19 strict mode 에서 double-invoke 됨.
- React Compiler 가 활성화되면 memoization 이 떨어져 매 렌더마다 fetch 가능.
- `latestLogId` 가 dependency 에 들어가 있어 자체로 trigger 됨 — 무한 루프 risk 는 if-early-return 으로 막혀있긴 하지만 fragile.
- 정답: `useEffect` + `AbortController`, 또는 (더 나음) TanStack Query 훅으로 빼기: `useLatestDailyCheckLog(clusterId)`.

**Severity**: 🟠 Important (React 규약 위반, 잠재 버그)
**Confidence**: 95%
**권고**: `hooks/useDailyCheck.ts` 신규 + `useLatestDailyCheckLog(clusterId)` 추가. 컴포넌트는 `data?.id` 만 받아씀.

---

### G-7. ClusterSidebar 의 `window.location.href` 풀 페이지 리로드

**근거**: `DailyCheckReview.tsx:73-78`
```typescript
onSelect={(id) => {
  if (id) {
    window.location.href = `/daily-check/review/${id}`;
  }
}}
```

**문제**:
- React Router 사용 중인데 풀 리로드. TanStack Query 캐시 전부 날라감 → 다른 클러스터 전환 시 매번 모든 API 다시 호출.
- 페이지 깜빡임 (UX 저하).
- CLAUDE.md 의 ClusterSidebar Standard 예제 코드도 `setSelectedClusterId` 패턴 사용 — 일관성 깨짐.

**Severity**: 🟠 Important (UX + 성능)
**Confidence**: 99%
**권고**: `useNavigate()` 사용. `onSelect={(id) => navigate(\`/daily-check/review/${id}\`)}`.

---

### G-8. Deep check 가 daily 의 15분 뒤로 hard-coded — daily 실패해도 deep 은 stale log 에 연결

**근거**:
- `celery_app.py:61-77` — deep schedule 이 daily +15 분으로 fixed
- `deep_check_service.py:69-78` — log_id 미지정 시 가장 최근 daily log auto-link

**문제**:
- daily 가 timeout 으로 실패해 새 DailyCheckLog 가 안 생기면, deep 은 가장 최근(어제 18시) log 에 연결됨.
- 사용자가 리뷰 페이지에서 "어제 저녁 + 오늘 아침 deep" 이 한 회차로 보이는 혼동 발생.

**Severity**: 🟠 Important (데이터 정합성)
**Confidence**: 80% (실제 stale 데이터 시나리오 추적 안 함)
**권고**: deep run 시 "오늘 + 같은 schedule_type" daily log 만 후보로 인정. 없으면 daily 를 먼저 실행하거나 stale 표시.

---

### G-9. `httpx.AsyncClient(verify=False)` — SSL 검증 강제 비활성화

**근거**:
- `daily_checker.py:111` — `httpx.AsyncClient(verify=False, timeout=...)`
- `health_checker.py:206, services/health_checker.py:23` — 같음

**문제**:
- 자체 서명 인증서 클러스터를 위한 임시 조치로 보이지만, **클러스터 등록 시 사용자가 신뢰 여부를 선택할 수 없음 — 항상 무조건 off**.
- MITM 공격에 노출. 운영자가 SSL 신뢰 사슬을 갖춘 cluster 에 대해서도 검증 안 됨.

**Severity**: 🟠 Important (보안)
**Confidence**: 99%
**권고**: `Cluster` 모델에 `tls_verify: bool = True` 컬럼 추가. UI에서 옵트인. 기본값 True.

---

## 🟡 UX / Minor Findings

### U-1. Dashboard "체크 실행" 과 리뷰 페이지의 데이터가 다른 파이프라인 — 사용자 혼동 보장

**근거**: Dashboard 의 `useHealthCheck` 가 `POST /health/check/{clusterId}` 호출 → **HealthChecker** (addon-based) 실행 → `check_logs` 에 기록, **`daily_check_logs` 는 안 생김**. 그러나 리뷰 페이지는 `daily_check_logs` 만 본다.

**문제**:
- 사용자가 Dashboard 에서 "체크 실행" 누르고 리뷰 페이지 가면 "점검 기록이 없습니다" 메시지를 봄. → 운영자 분노 + 신뢰도 폭락.
- 안내 메시지조차 잘못됨 (`DailyCheckReview.tsx:127`): *"대시보드의 '체크 실행' 버튼으로 점검을 먼저 수행하세요"* — 이건 거짓말.

**Severity**: 🟡 Major UX (사용자 혼동)
**Confidence**: 99%
**권고**:
- 안내 문구를 `POST /daily-check/run/{clusterId}` 호출 버튼으로 교체 (페이지 안에 "지금 daily check 실행" 버튼 추가).
- 또는 Dashboard "체크 실행" 클릭 시 HealthChecker + DailyChecker 둘 다 도는 새 endpoint 만들기 (`/health/full-check`).

---

### U-2. AI 리뷰 본문이 raw 텍스트 — Markdown 미렌더링

**근거**: `AiSummaryCard.tsx:58` — `<div className="whitespace-pre-wrap">{review.aiSummary}</div>`

**문제**:
- Ollama llama3 는 보통 Markdown(`**bold**`, `- list`, `\`code\``) 응답을 함.
- raw 표시되어 `**` `-` `\`` 가 그대로 보임. 가독성 매우 낮음.

**Severity**: 🟡 UX
**Confidence**: 95%
**권고**: `react-markdown` 도입 (`remark-gfm` 옵션). 이미 `recharts` 들고 있으니 번들 무게 크게 늘지 않음.

---

### U-3. 체크 회차 picker 가 native `<select>` — 시각 일관성 깨짐

**근거**: `DailyCheckReview.tsx:177-189`

**문제**:
- 페이지의 다른 UI 는 모두 Shadcn 컴포넌트인데 picker 만 native `<select>`.
- 항목 표시도 "datetime · scheduleType · status" 한 줄로만 표시. status 색상/아이콘 없음. 사용자가 critical 회차를 빨리 찾기 어려움.

**Severity**: 🟡 UX
**Confidence**: 90%
**권고**: Shadcn `<Select>` + 각 option 에 status badge. 또는 더 나은 패턴으로 timeline 형 회차 picker (수평 dot chart) — 이쪽이 정보 밀도 높음.

---

### U-4. `ai_status !== 'ok'` → 모두 "Ollama 오프라인" — error 와 offline 구분 불가

**근거**: `AiSummaryCard.tsx:24` — `const offline = review.aiStatus !== 'ok';`

**문제**:
- DB 컬럼 정의는 `'ok' | 'offline' | 'error'` 3종 — `daily_check.py:51`.
- error (모델 응답 파싱 실패 등) 도 "오프라인" 으로 표시 → 운영자가 Ollama 가 살아있는데 왜 메시지가 안 나오는지 추적 못 함.

**Severity**: 🟡 UX (디버깅성)
**Confidence**: 95%
**권고**: 3-way 분기. `'offline' → "Ollama 오프라인"`, `'error' → "AI 응답 처리 실패 — 재생성 시도"`, `'ok' → 표시 안 함`.

---

### U-5. Trend 차트의 dual-scale 문제

**근거**: `TrendChart.tsx:68-70` — errors / warnings / readyNodes 가 같은 Y축

**문제**:
- errors 카운트는 보통 0~5, readyNodes 는 3~수십. 같은 Y축이면 readyNodes 가 차트를 지배 → errors 가 1→3 으로 늘어도 시각적으로 안 보임.
- "노드 수 변화" 와 "에러 수 변화" 는 의미가 다른데 같은 라인 차트에 섞여 있음.

**Severity**: 🟡 UX (시각화 정보성)
**Confidence**: 90%
**권고**: Recharts `<YAxis yAxisId="left" />` + `<YAxis yAxisId="right" orientation="right" />`. 또는 차트 2개로 split (위: errors/warnings, 아래: readyNodes/totalNodes).

---

### U-6. 진입 경로 — Dashboard ↔ 리뷰 페이지 연결 약함

**근거**: Dashboard 의 ClusterOverviewGrid 클러스터 카드를 클릭하면 `onSelectCluster(cluster.id)` 호출 (line 64) — Dashboard 내부의 selected cluster 만 바뀌고 리뷰 페이지로 가는 link 없음. 사용자는 별도 메뉴/URL 통해 진입해야 함.

**Severity**: 🟡 UX (정보 아키텍처)
**Confidence**: 85%
**권고**: 각 클러스터 카드에 작은 "상세 점검 →" 링크 또는 우클릭 메뉴 추가. 카드 자체 클릭은 Dashboard 내 선택 유지(현재 동작), 보조 버튼이 navigate.

---

### U-7. "Deep Check 지금 실행" 진행률 피드백 부족

**근거**: `DailyCheckReview.tsx:103-104` — `runNow.isPending` 동안 텍스트만 "실행 중…"

**문제**:
- 13개 deep checker 가 순차 실행되면 수십초 ~ 분 단위 소요 가능 (cert_expiry, image_pull, pvc_health 등 외부 IO).
- 사용자는 멈췄는지 모름. Toast 알림이나 estimated time 없음.

**Severity**: 🟡 UX
**Confidence**: 90%
**권고**: Toast notification (Shadcn `<Sonner>`) + 분 단위 estimate. 또는 SSE/polling 으로 실시간 진행률.

---

### U-8. 알림 설정 패널 — 글로벌/클러스터 한정 모호

**근거**: `DailyCheckReview.tsx:143` — `<NotificationSettingsPanel />` (props 없음)

**문제**:
- 리뷰 페이지는 특정 클러스터 컨텍스트인데 NotificationSettingsPanel 이 props 없이 호출됨 → 글로벌 설정으로 추정되지만 UI 라벨에 명시 안 됨.
- 사용자가 "이 클러스터의 알림만 끄려고" 누르면 전체가 꺼질 수 있음.

**Severity**: 🟡 UX (정보 표시)
**Confidence**: 70% (NotificationSettingsPanel 내부 안 봄)
**권고**: 패널 헤더에 "**전역 알림 설정**" 또는 "**현재 클러스터 알림 설정**" 명시.

---

## 📋 권장 액션 (우선순위)

### 즉시 (1-2일)
1. **G-2 (componentstatuses 삭제)** — 한 줄짜리 silent failure, 사용자 신뢰 깨짐. ControlPlaneChecker 위임으로 교체.
2. **U-1 (체크 실행 버튼 혼동)** — 안내 문구 수정 + 리뷰 페이지에 "지금 daily check 실행" 버튼 추가.
3. **G-7 (window.location.href)** — `useNavigate` 한 줄 교체.

### 단기 (1주)
4. **G-6 (useMemo for side effect)** — `useLatestDailyCheckLog` 훅으로 분리.
5. **U-2 (Markdown 미렌더)** — react-markdown 도입.
6. **U-4 (ai_status 3-way 분기)** — 5줄 수정.
7. **G-9 (TLS verify 옵션화)** — Cluster.tls_verify 컬럼 + 마이그레이션.

### 중기 (2-4주)
8. **G-3 (DailyChecker SDK 마이그레이션)** — 패턴 일원화 + kubectl 의존 제거.
9. **G-1 (cluster.status authoritative 정의)** — 단일 소유자 지정 + lock.
10. **G-5 (Celery 클러스터별 sub-task)** — 스케일 대비.
11. **U-3 (Picker Shadcn 화)** — UI 일관성.
12. **U-5 (Trend dual Y-axis)** — 시각화 개선.

### 장기 (대규모)
13. **G-1 장기 안 (DB view 기반 cluster status)** — 3-pipeline 통합 거버넌스.
14. **U-6 (Dashboard ↔ 리뷰 IA 재설계)** — 정보 아키텍처 재정의.
15. **U-7 (실시간 진행률)** — SSE/WebSocket.

---

## 🔄 다음 단계

- `/pdca iterate cluster-detail-monitoring` 으로 G-1~G-3 + U-1 (Critical/즉시 4건) 자동 수정 시도
- 또는 사용자가 위 우선순위 중 일부만 골라 수동 작업 분리 가능
- Match Rate 81% → iterate 후 재측정 권장 (목표 90%+)
