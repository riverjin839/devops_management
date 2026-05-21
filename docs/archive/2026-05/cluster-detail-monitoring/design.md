# Design — Cluster Detail Monitoring (Reverse-Engineered)

> 작성일: 2026-05-21
> 모드: 리버스 PDCA — 현재 코드 베이스에서 역추출한 설계
> Plan: `docs/01-plan/features/cluster-detail-monitoring.plan.md`

## Context Anchor (Plan 복사본)

| Key | Value |
|---|---|
| **WHY** | 다수 클러스터 매일 3회 자동 점검 + AI 요약/diff/추이로 인지 부하 절감 |
| **WHO** | DevOps/SRE 운영자, 09:00 출근 직후 점검 루틴 |
| **RISK** | 점검 시스템 자체가 신뢰 잃으면 도구 가치 zero |
| **SUCCESS** | 누락 0건 + 일관된 status + 3초 첫 렌더 + offline 견고 + K8s 1.27+ 호환 |
| **SCOPE** | daily/deep checker + Celery Beat + DailyCheckLog/DeepCheckResult + `/daily-check/review/:clusterId` |

## 1. Overview — 현재 구조 (As-Is)

본 기능은 **3개의 평행 점검 파이프라인** 을 사용한다:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Trigger Sources                             │
│   Celery Beat (09/13/18시)    Dashboard 버튼      Review 페이지     │
│         │                          │                    │           │
│         ▼                          ▼                    ▼           │
│  ┌─────────────────┐      ┌─────────────────┐   ┌────────────────┐ │
│  │  DailyChecker   │      │  HealthChecker  │   │ DeepCheckSvc   │ │
│  │  (subprocess +  │      │  (BaseChecker   │   │ (deep_checkers │ │
│  │   kubectl)      │      │   registry)     │   │  registry)     │ │
│  └────────┬────────┘      └────────┬────────┘   └────────┬───────┘ │
│           │                        │                     │         │
│           ▼                        ▼                     ▼         │
│   daily_check_logs            check_logs +         deep_check_     │
│   + cluster.status            addons.status        results +       │
│           │                   + cluster.status     daily_check_    │
│           │                                        log_id (link)   │
│           ▼                                              │         │
│   Celery: run_review_and_notify  ←──────────────────────┘         │
│           │                                                        │
│           ▼                                                        │
│   AI 리뷰 (Ollama) 채우기 → daily_check_logs.ai_*                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.1 3개 파이프라인의 관할 매핑

| 파이프라인 | 트리거 | 데이터 소스 | 결과 저장 | cluster.status 갱신? |
|---|---|---|---|:---:|
| **HealthChecker** | Dashboard "체크 실행" 버튼 | DB `addons` 행 + Strategy via `CHECKER_REGISTRY` | `check_logs` + `addons.status/details` | ✅ |
| **DailyChecker** | Celery Beat 09/13/18시 + 수동 POST `/daily-check/run` | `subprocess kubectl` (componentstatuses/nodes/pods) + httpx `/healthz` | `daily_check_logs` | ✅ |
| **DeepCheckService** | Celery Beat 09:15/13:15/18:15 + 수동 POST `/deep-check/run` + super pod ingest | DB `deep_check_definitions` + `deep_checkers/*` registry | `deep_check_results` (FK → daily_check_logs.id) | ❌ (직접 안 함) |

### 1.2 사용자 워크플로우 (As-Is)

```
사용자 → 사이드바 메뉴 "일일 점검 리뷰" 클릭
       → /daily-check/review (clusterId 없음)
       → useEffect 가 clusters[0] 로 자동 라우팅
       → /daily-check/review/{clusters[0].id}
       → useMemo 가 GET /daily-check/results/{clusterId}/latest 호출
       → 최신 dailyCheckLogId 얻으면 setLatestLogId
       → useDeepCheckReview(dailyCheckLogId) 가
         GET /deep-check/review/{dailyCheckLogId} 호출
       → AI 요약 + Deep 결과 + Diff + Trend 렌더링
       → (옵션) "Deep Check 지금 실행" 클릭
       → POST /deep-check/run/{clusterId}
       → React Query invalidate → 자동 refetch
```

## 2. Architecture Decisions (As-Implemented)

| 영역 | 결정 | 코드 근거 | 평가 |
|---|---|---|---|
| **점검 엔진 패턴** | Strategy Pattern + Registry (`BaseChecker` + `CHECKER_REGISTRY` for addon-based; `DeepCheckBase` + `get_checker_class` for deep) | `services/checkers/base.py`, `services/deep_checkers/registry.py` | ✅ 좋음 — 새 checker 추가 비용 낮음 |
| **K8s 통신** | 두 가지 병행: ① subprocess kubectl (DailyChecker), ② Python `kubernetes` SDK (BaseChecker family) | `daily_checker.py:_build_kubectl_cmd` vs `base.py:_get_k8s_client` | ❌ 일관성 깨짐 (분석 §G-1) |
| **AI 리뷰** | DailyChecker.run_daily_check commit 후 Celery `.delay()` 로 fire-and-forget. `run_review_and_notify` task 가 Ollama 호출 → DailyCheckLog.ai_* 채움. | `daily_checker.py:89-96`, `celery_app.py:282-315` | ✅ fail-safe 잘 짜여있음 |
| **Deep Check 연결** | DeepCheckResult.daily_check_log_id (FK) — 같은 회차 deep 결과를 daily log 와 묶음. log_id 미지정 시 가장 최근 daily log 자동 연결. | `deep_check_service.py:67-78`, `deep_check.py:151-198` | ⚠️ 자동 연결 로직이 race 가능 (분석 §G-2) |
| **스케줄러** | Celery Beat crontab. daily 09/13/18, deep 09:15/13:15/18:15, batch dispatcher 매분. | `celery_app.py:31-77` | ⚠️ deep 이 항상 daily 15분 뒤 — daily 가 5분 timeout 으로 부분 실패해도 deep 은 그냥 실행됨 |
| **fail-safe** | `BaseChecker.safe_check` 가 모든 예외를 `CheckResult` 로 변환. 연결성 예외는 `pending` 으로 분류. AI 리뷰도 best-effort. | `base.py:79-106` | ✅ 매우 좋음 |
| **사이드바 패턴** | `ClusterSidebar iconOnly` 사용 (CLAUDE.md 표준 준수) | `DailyCheckReview.tsx:71-80` | ✅ 좋음 |
| **상태 관리** | TanStack Query 훅 사용 (`useDeepCheckReview`, `useDailyCheckTrend`, `useRunDeepCheckNow`) | `hooks/useDeepCheck.ts` | ✅ 적절 |
| **클러스터 전환** | `window.location.href = ...` 풀 페이지 리로드 | `DailyCheckReview.tsx:76` | ❌ React Router navigate 사용 안 함 (분석 §U-1) |
| **체크 회차 picker** | native `<select>` element | `DailyCheckReview.tsx:152-191` | ⚠️ Shadcn `<Select>` 미사용 (분석 §U-3) |

## 3. Data Model

```sql
clusters (status: healthy|warning|critical|pending) ← 세 파이프라인이 모두 갱신

daily_check_logs (
  id, cluster_id FK,
  schedule_type, check_date,
  overall_status,
  api_server_status, api_server_response_time_ms, api_server_details JSONB,
  components_status JSONB,
  nodes_status JSONB, total_nodes, ready_nodes,
  system_pods_status JSONB,
  resource_summary JSONB,        ← ❌ 정의됐지만 미사용 (dead column, 분석 §G-3)
  error_messages JSONB, warning_messages JSONB,
  ai_summary TEXT, ai_remediation TEXT, ai_diff JSONB,
  ai_trend JSONB, ai_status, ai_generated_at
)

deep_check_results (
  id, cluster_id FK, daily_check_log_id FK NULL, definition_id FK NULL,
  check_type, status, message, details JSONB, duration_ms, checked_at
)

deep_check_definitions (
  id, cluster_id FK NULL,  ← NULL 이면 글로벌
  check_type, params JSONB, thresholds JSONB, enabled, sort_order
)

check_schedules (
  cluster_id FK, is_active,
  morning_time, morning_enabled,
  noon_time, noon_enabled,
  evening_time, evening_enabled,
  timezone
)

check_logs (HealthChecker 가 사용, addons.status 와 1:N)
addons (HealthChecker 의 target)
```

## 4. API Contracts (As-Implemented)

| Endpoint | Verb | 사용처 | 비고 |
|---|---|---|---|
| `/daily-check/run/{cluster_id}` | POST | 수동 daily check | `schedule_type=manual` 기본 |
| `/daily-check/results/{cluster_id}` | GET | DailyCheckLogPicker (limit=20) | offset/limit/date filter |
| `/daily-check/results/{cluster_id}/latest` | GET | useMemo (안티패턴) | 최신 1건 |
| `/daily-check/summary` | GET | (현재 어디서 호출하는지 분명치 않음) | N+1 query 가능 |
| `/daily-check/schedule/{cluster_id}` | GET/PUT | DeepCheckSettings 등 | 스케줄 토글 |
| `/deep-check/run/{cluster_id}` | POST | "Deep Check 지금 실행" 버튼 | best-effort review queue |
| `/deep-check/results/{cluster_id}/latest` | GET | (review 페이지에서는 review API 가 묶어서 가져옴) | 사용처 적음 |
| `/deep-check/review/{daily_check_log_id}` | GET | `useDeepCheckReview` — **핵심 엔드포인트** | AI + deep + log meta 묶음 |
| `/deep-check/review/{daily_check_log_id}/regenerate` | POST | "재생성" 버튼 | Ollama 강제 재호출 |
| `/deep-check/trend/{cluster_id}?days=7` | GET | `useDailyCheckTrend` | recent N일 |
| `/deep-check/ingest` | POST (Bearer) | in-cluster super pod | JWT 우회 |
| `/health/check/{cluster_id}` | POST | Dashboard "체크 실행" 버튼 (별개 파이프라인!) | HealthChecker (addon-based) |

## 5. Frontend Components

```
pages/DailyCheckReview.tsx          ← top-level
  ├─ ClusterSidebar (iconOnly)
  ├─ DailyCheckLogPicker (<select>)
  ├─ AiSummaryCard
  ├─ DeepCheckGrid
  ├─ DiffPanel
  ├─ TrendChart
  └─ NotificationSettingsPanel

hooks/useDeepCheck.ts
  ├─ useDeepCheckResults
  ├─ useLatestDeepCheckResults  (refetchInterval 60s)
  ├─ useDeepCheckReview          ← 핵심
  ├─ useDailyCheckTrend
  ├─ useRegenerateReview
  └─ useRunDeepCheckNow
```

## 6. 알려진 Design Trade-offs

- **TO-1.** AI 리뷰가 별도 Celery task — 리뷰 페이지 첫 진입 시 ai_* 가 NULL 일 수 있음 (worker 가 아직 못 끝낸 경우). 현재 UI 는 "아직 생성되지 않음" 으로 표시.
- **TO-2.** Deep check 가 daily 15분 뒤 고정 schedule — daily 가 timeout 나면 deep 은 stale 한 daily log 에 연결됨 (분석 §G-2).
- **TO-3.** in-cluster super pod 모드는 `/deep-check/ingest` 로 결과 push, centralized 모드는 backend 가 직접 실행. 두 모드를 동시에 켜면 결과 중복.

## 7. Non-Goals

- 점검 결과 알람 채널(Slack/email) 의 라우팅 룰 — notifier 가 책임
- 이력 데이터의 장기 보관/아카이빙 정책 — 별도 retention plan
- 클러스터 등록/kubeconfig 관리 — `/cluster-manage` 페이지 담당
