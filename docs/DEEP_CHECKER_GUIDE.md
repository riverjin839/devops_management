# Deep Checker 가이드 (Claude 내부 참조용)

> **목적 (이 문서)**: PEP 의 **Deep Check(심화 점검)** 서브시스템의 목적·아키텍처·데이터
> 흐름·API·확장 방법을 한곳에 정리한 **AI/개발자 참조 문서**. "deep checker 가 뭔지",
> "어디서 실행되는지", "새 항목을 어떻게 추가하는지"를 묻는 세션에서 이 문서를 먼저 읽고
> 시작한다. 새 체커를 **실제로 추가**할 때는 `.claude/skills/add-deep-checker` 스킬을 함께 사용.

---

## 1. 목적 (Why)

기존 `DailyChecker`(→ `daily_check_logs`)는 **클러스터 기본 건강 상태**(API 서버 / component
status / 노드 Ready / kube-system 파드)만 본다. 이것만으로는 "노드는 Ready 지만 인증서가
7일 뒤 만료" · "etcd 가 단편화로 곧 느려짐" · "CoreDNS 가 조용히 에러를 뱉는 중" 같은
**심층 운영 리스크**를 잡지 못한다.

**Deep Check** 는 이 공백을 메우는, **모듈화된 심화 점검 프레임워크**다.

- 점검 하나 = `DeepCheckerBase` 를 상속한 **체커 클래스 1개** = **registry 항목 1개**.
- registry 에 등록만 하면 ① 점검 매트릭스 cron ② 운영 점검 콘솔(`/ops-checks`)
  ③ Super Pod 러너에 **자동 노출**된다 (하드코딩 호출 없음).
- 임계값/파라미터는 DB(`DeepCheckDefinition`)에서 운영자가 UI 로 수정 가능하고, 각 점검은
  **fail-safe**(예외를 삼켜 구조화된 결과로 반환)라 한 점검 실패가 전체를 막지 않는다.

핵심 설계 원칙:

| 원칙 | 내용 |
|---|---|
| **운영 클러스터 무해(non-intrusive)** | 가능하면 K8s API **읽기** 또는 이미 수집된 스냅샷 비교. 파드 생성/SSH 는 신중히(권한·부하). |
| **Fail-safe** | `safe_run()` 이 모든 예외를 잡아 `critical`/`pending` 결과로 변환. HTTP 500 을 내지 않음. |
| **DB 없는 모드 대응** | in-cluster(super pod) 모드는 DB 가 없으므로 DB 비교형 체커는 `pending` 반환. |
| **자동 노출** | registry 등록 → 시드(`_seed_default_deep_check_definitions`) → 콘솔/cron 자동 등장. |

---

## 2. 핵심 개념 (도메인 모델)

```
┌ 코드 레벨 ────────────────────────────┐   ┌ DB 레벨 ──────────────────────────┐
│ DeepCheckerBase (추상)                │   │ deep_check_definitions            │
│   └ XxxChecker (check_type 별 1개)     │   │   = 운영자 편집 가능 "점검 정의"     │
│                                       │   │   (cluster_id NULL = 글로벌)       │
│ REGISTRY: check_type → (Checker, Spec)│   │                                   │
│   Spec = threshold_fields/param_fields│   │ deep_check_results                │
│         + default_*  + category       │   │   = 실행 1회의 결과 (status/msg/   │
│         + default_enabled             │   │      details/steps/duration)       │
│                                       │   │   daily_check_log_id 로 회차 묶음   │
│ DeepCheckContext                      │   │                                   │
│   = cluster? + thresholds + params    │   │ notification_channels / _logs      │
│     + in_cluster                      │   │   = 결과 알림(Slack/Email/…)        │
│ DeepCheckOutcome                      │   └───────────────────────────────────┘
│   = status + message + details + steps│
└───────────────────────────────────────┘
```

- **check_type** (`str`): registry key. `cert_expiry`, `etcd_defrag`, `node_health` 등. 코드
  (`Checker.check_type`), DB(`DeepCheckDefinition.check_type` / `DeepCheckResult.check_type`),
  API 를 잇는 논리 키.
- **DeepCheckDefinition**: UI 편집 가능한 정의. `cluster_id IS NULL` 이면 글로벌(모든
  클러스터), 값이 있으면 그 클러스터 전용. `enabled`, `thresholds`(JSONB), `params`(JSONB),
  `schedule_cron`(옵션), `sort_order`.
- **DeepCheckResult**: 실행 결과 1행. `status`(healthy/warning/critical/pending), `message`,
  `details`(JSONB — 실행 단계 `_steps` 포함), `duration_ms`, `daily_check_log_id`(회차 연결).
- **StatusEnum**: `healthy` < `warning` < `critical`, 그리고 실행 불가/연결 실패는 `pending`.

---

## 3. 아키텍처 & 데이터 흐름

### 3.1 컴포넌트 지도 (파일 맵)

| 계층 | 파일 | 역할 |
|---|---|---|
| 체커 베이스 | `backend/app/services/deep_checkers/base.py` | `DeepCheckerBase`, `DeepCheckContext`, `DeepCheckOutcome`, `_step()` 트레이스, `safe_run()` fail-safe, `_v1()`/`_kubectl()` K8s client. |
| 체커 구현 | `backend/app/services/deep_checkers/*_checker.py` | check_type 별 실제 점검 로직 (16개, §7 목록). |
| 레지스트리 | `backend/app/services/deep_checkers/registry.py` | `REGISTRY` 매핑 + `DeepCheckTypeSpec`(UI 폼 스키마) + `STEP_PLANS`(메커니즘 단계). |
| 서비스 | `backend/app/services/deep_check_service.py` | `DeepCheckService` — 정의를 읽어 체커 실행·결과 저장. `run_for_cluster` / `run_definition_once` / `run_check_type_once` / `run_node_health_once` / `persist_ingest_payload`. |
| 결과 라우터 | `backend/app/routers/deep_check.py` | 결과 조회 / 수동 실행 / ingest / AI 리뷰 / trend. |
| 정의 라우터 | `backend/app/routers/deep_check_definitions.py` | 정의 CRUD + `check-types` 스키마 + `test`(미리보기). |
| 모델 | `backend/app/models/deep_check.py` | `DeepCheckDefinition`, `DeepCheckResult`, `NotificationChannel`, `NotificationLog`. |
| 시드 | `backend/app/main.py::_seed_default_deep_check_definitions` | registry → 글로벌 정의 자동 생성 (부팅 시, idempotent). |
| 매트릭스 디스패처 | `backend/app/services/check_matrix_service.py` | cron 평가 → deep_check 항목을 `run_definition_once(persist=True)` 로 실행. |
| 운영 점검 콘솔 | `backend/app/services/ops_check_service.py` + `routers/ops_check.py` | deep_check/addon 을 공통 "점검 항목" 으로 normalize, 카탈로그/배치 실행. |
| Super Pod | `backend/app/superpod/runner.py` | `python -m app.superpod.runner` — in_cluster / centralized 두 모드. |
| Helm CronJob | `helm/k8s-daily-monitor/templates/deepcheck-cronjob.yaml` | Super Pod 를 K8s CronJob 으로 스케줄. |
| 프론트 — 정의 관리 | `frontend/src/pages/DeepCheckSettings.tsx` (`/daily-check/settings`, 메뉴 "점검 항목 관리") | 정의 CRUD + 동적 폼 + "Test now". |
| 프론트 — 운영 콘솔 | `frontend/src/pages/OpsCheckConsolePage.tsx` (`/ops-checks`, 메뉴 "운영 점검") | 카탈로그에서 항목 골라 배치 실행 + 진행률 폴링. |
| 프론트 — API/hooks | `services/api.ts`(`deepCheck*`, `opsCheck*`), `hooks/useDeepCheck.ts`, `hooks/useDeepCheckDefinitions.ts` | |

### 3.2 실행 → 저장 → 리뷰 파이프라인

```
정의(enabled) ─┐
              ├─ DeepCheckService._run_one ─ Checker.safe_run(ctx) ─ DeepCheckOutcome
Context 조립 ─┘                                     │
   (thresholds/params/cluster/in_cluster)           ▼
                                     DeepCheckResult 저장 (daily_check_log_id 로 회차 연결)
                                                     │
                              log_id 있으면 run_review_and_notify.delay(log_id)
                                                     ▼
                              ReviewService(Ollama) → DailyCheckLog.ai_* + 알림 fan-out
```

- `run_for_cluster` 는 **글로벌 + 해당 클러스터** 정의 중 `enabled=True` 만 `sort_order` 순으로
  실행. `daily_check_log_id` 미지정 시 그 클러스터의 **최신 DailyCheckLog** 에 자동 연결.
- 실행 단계(`_step`)는 `outcome.steps` 로 수집되고 `details["_steps"]` 에 보존 → 콘솔이
  실시간 로그/2D 애니메이션으로 그린다. `STEP_PLANS` 는 계측 안 된 체커도 "무엇을 하는지"를
  항상 보여주는 정적 plan.

---

## 4. 실행 경로 4가지 (언제/어디서 도는가)

| 경로 | 트리거 | 코드 진입점 | in_cluster | 저장 |
|---|---|---|---|---|
| **① 점검 매트릭스 cron** | Celery Beat 매분 디스패처가 `CheckMatrixSchedule`(deep_check 행) cron 평가 | `check_matrix_service.dispatch_due` → `DeepCheckService.run_definition_once(persist=True)` | False | ✅ |
| **② 운영 점검 콘솔** | 운영자가 `/ops-checks` 에서 항목 선택 → "실행" | `ops_check_service.OpsCheckService.execute_run` (Celery `run_ops_check_batch`) | False | ✅ |
| **③ 수동 API / Test** | `POST /deep-check/run/{cluster_id}` (전체) / `POST /deep-check/definitions/{id}/test` (미리보기) | `run_for_cluster` / `run_definition_once(persist=False)` | False | 전체=✅, Test=❌ |
| **④ Super Pod** | Helm CronJob (`deepcheck`) `python -m app.superpod.runner` | `runner._run_centralized` (DB 순회) 또는 `_run_in_cluster` (결과 push) | 모드별 | ✅ (ingest 는 `/deep-check/ingest`) |

### Super Pod 두 모드 (`SUPERPOD_MODE`)

- **centralized**: 관리 클러스터에서 실행. DB 의 모든 `Cluster` 를 순회하며 kubeconfig 로
  점검하고 **결과를 직접 DB 저장** (`run_for_cluster`). Helm 기본값.
- **in_cluster**: 대상 클러스터 **내부**에서 실행. DB 가 없으므로 registry 의 모든 check_type 을
  기본 임계/파라미터로 1회씩 돌리고, 결과를 `SUPERPOD_INGEST_URL`(`/deep-check/ingest`)로
  Bearer 토큰(`SUPERPOD_INGEST_TOKEN`) 인증 POST. 관리 backend 가 최신 회차에 자동 연결 후
  AI 리뷰 큐잉. 배포 산출물은 **`k8s/superpod/`**(CronJob + kustomization + secret 템플릿) —
  Helm CronJob(`SUPERPOD_MODE=centralized`, 기본값)과는 별도의 kustomize 번들이다.

---

## 5. 데이터 모델 (요약)

**`deep_check_definitions`** — `id`, `cluster_id (FK, NULL=글로벌)`, `check_type`, `name`,
`description`, `enabled`, `schedule_cron`, `thresholds (JSONB)`, `params (JSONB)`, `sort_order`,
`created_at`, `updated_at`.

**`deep_check_results`** — `id`, `cluster_id (FK)`, `daily_check_log_id (FK, NULL 가능)`,
`definition_id (FK, NULL 가능)`, `check_type`, `status (Enum)`, `message`, `details (JSONB)`,
`duration_ms`, `ai_summary`, `ai_remediation`, `checked_at`.

**`notification_channels`** — `channel_type (slack|email|webhook|k8s_event)`, `enabled`,
`cluster_id?`, `min_severity`, `config (JSONB)`. **`notification_logs`** — 발송 이력.

인덱스(부팅 `_run_migrations` 의 `_safe_create_index`): definitions `(cluster_id)`,`(check_type)`
/ results `(cluster_id)`,`(daily_check_log_id)`,`(checked_at DESC)`.

---

## 6. API 레퍼런스

Base: `/api/v1`

### 결과 / 실행 (`deep_check.py`)
| Method | Path | 설명 |
|---|---|---|
| POST | `/deep-check/run/{cluster_id}` | 클러스터의 enabled deep check 전체 실행 + AI 리뷰 큐잉. **operator 이상**, Celery 백그라운드(`status:"queued"`; worker 부재 시 동기 폴백 `status:"ok"`) |
| GET | `/deep-check/results/{cluster_id}` | 결과 목록(페이지네이션) |
| GET | `/deep-check/results/{cluster_id}/latest` | 최신 회차의 결과들 |
| GET | `/deep-check/review/{daily_check_log_id}` | AI 요약 + diff + trend + 해당 회차 deep 결과 |
| POST | `/deep-check/review/{daily_check_log_id}/regenerate` | AI 리뷰 강제 재생성 |
| GET | `/deep-check/trend/{cluster_id}?days=7` | 최근 N일 상태 분포 |
| POST | `/deep-check/ingest` | (별도 라우터) super pod in_cluster 결과 push — Bearer 토큰. **`SUPERPOD_INGEST_TOKEN` 미설정 시 503 거부(fail-closed)**, 비교는 상수시간 |

### 정의 (`deep_check_definitions.py`)
| Method | Path | 설명 |
|---|---|---|
| GET | `/deep-check/check-types` | registry 스키마(동적 폼용): threshold/param fields + defaults |
| GET | `/deep-check/definitions?cluster_id=&include_global=` | 정의 목록 |
| POST | `/deep-check/definitions` | 정의 생성 (check_type 은 REGISTRY 에 있어야 함) |
| GET/PUT/DELETE | `/deep-check/definitions/{id}` | 조회 / 수정·삭제(**operator 이상**) |
| POST | `/deep-check/definitions/{id}/test` | 즉시 1회 실행, **저장 안 함** (미리보기). **operator 이상** |

> **인가**: 조회(GET)는 인증된 사용자면 가능하지만, **정의 생성/수정/삭제·Test·run·
> ops-check 실행은 operator 이상**만 허용된다(컨트롤플레인 exec·파드 생성 등 강력한 동작 유발).

---

## 7. 등록된 체커 카탈로그 (registry.py 기준)

| check_type | 표시명 | category | 기본 enabled | 요지 |
|---|---|---|---|---|
| `cert_expiry` | K8s 인증서 만료 | k8s | ✅ | `kubeadm certs check-expiration` 잔여일 |
| `etcd_defrag` | etcd 단편화/알람 | k8s | ✅ | `etcdctl endpoint status`+`alarm list` 단편화율 |
| `cni_flow` | Cilium Hubble flow | network | ✅ | 최근 N초 flow 중 DROPPED/ERROR 비율 |
| `pvc_health` | PVC/PV 상태 | storage | ✅ | Pending/Lost PVC + orphan PV |
| `image_pull` | ImagePull/CrashLoop | k8s | ✅ | ImagePullBackOff/ErrImagePull/CrashLoop 카운트 |
| `audit_rbac` | Audit/RBAC sprawl | k8s | ✅ | audit policy CM 존재 + cluster-admin 수 |
| `node_pressure` | 노드 Pressure/Condition | k8s | ✅ | Disk/Memory/PID Pressure·NotReady |
| `coredns_health` | CoreDNS 상태 | k8s | ✅ | kube-dns Ready 비율 + 로그 에러율 |
| `stuck_terminating` | Stuck Terminating Pods | k8s | ✅ | Terminating N분 이상 지연 파드 |
| `oom_events` | OOM/Evicted 이벤트 | k8s | ✅ | 최근 N시간 OOMKilling/Evicted/SystemOOM |
| `external_to_pod` | 외부→내부 Pod 호출 | network | ✅ | 관리 backend 에서 노출 endpoint 도달성 |
| `pod_to_pod` | Pod-to-pod 연결성 | network | ✅ | 임시 busybox 파드로 nc TCP probe (**pods.create 필요**) |
| `node_health` | 노드 추가 검증(기본+네트워킹) | k8s | ✅ | Ready/Pressure/Taint/Allocatable + CNI/kube-proxy 데몬셋 |
| `kernel_param_drift` | OS 파라미터 변경 점검 | os | ❌ | `ClusterConfigSnapshot` 연속 스냅샷 sysctl 드리프트 |
| `minio_health` | MinIO 스토리지 health | storage | ❌ | `/minio/health/cluster·live` 쿼럼/degraded |
| `isilon_nfs` | Isilon NFS (NAS) | storage | ❌ | `isi` 명령 SSH 수집 + K8s NFS PV 매칭, export 가용성/쿼터 |

> `default_enabled=False`(kernel_param_drift, minio_health, isilon_nfs) 는 **위험/무겁거나
> 사전 준비가 필요한** 점검 — 시드로 등록만 되고 운영자가 켠다. 콘솔 카탈로그에는 비활성도
> 노출(수동 실행 가능)되지만, cron 은 `enabled=True` 만 실행한다.

각 check_type 의 `threshold_fields`/`param_fields`/기본값은 `registry.py` 를 직접 확인
(`GET /deep-check/check-types` 응답과 동일).

---

## 8. 새 deep checker 추가 (요약 — 자세히는 스킬)

> **실제 추가 작업 시 `.claude/skills/add-deep-checker` 스킬을 반드시 로드**할 것. 아래는 개요.

1. **체커 작성** — `deep_checkers/<name>_checker.py`, `class XChecker(DeepCheckerBase)`,
   클래스 속성 `check_type`/`display_name`, `run(ctx) -> DeepCheckOutcome` 구현.
   - `ctx.cluster`(Optional), `ctx.thresholds`, `ctx.params`, `ctx.in_cluster` 사용.
   - K8s 읽기(`self._v1(ctx)`/`self._kubectl(ctx, ...)`) 또는 스냅샷 비교로 **무해하게**.
   - 핵심 동작은 `with self._step("id","label") as st:` 로 감싸 로그/애니메이션 계측.
   - `ctx.cluster is None`(DB 없음/in-cluster) 이고 DB 비교형이면 `StatusEnum.pending` 반환.
   - 예외 처리는 `safe_run` 이 하므로 `run` 은 정상 경로만 신경 쓴다.
2. **registry 등록** — `registry.py` 에 import + `REGISTRY` 항목
   `(Checker, DeepCheckTypeSpec(check_type=, display_name=, description=, category=,
   threshold_fields=, param_fields=, default_thresholds=, default_params=, default_enabled=))`.
   `STEP_PLANS` 에 단계 plan 도 추가하면 콘솔이 메커니즘을 그린다.
3. **시드** — `_seed_default_deep_check_definitions()` 가 registry 를 돌며 글로벌 정의 자동
   생성(부팅 시). **별도 작업 불필요.**
4. **이력 테이블 필요 시** — `models/` 에 모델 추가 → `models/__init__.py` 등록 →
   `create_all` 이 생성, 인덱스는 `_run_migrations` 의 `_safe_create_index`. 로그성이면
   `backup_service.LOG_TABLES` 등록.

**검증**: 백엔드 `pytest`(import/기동), 또는 최소 `python -c "import ast; ast.parse(...)"`.
배포 후 `/ops-checks` 카탈로그에 새 항목이 뜨고 실행 시 결과/로그가 나오는지 확인.

---

## 9. 주의사항 / 함정

- **in_cluster 모드는 DB 가 없다** — DB 비교형(예: kernel_param_drift) 체커는 그 경우 `pending`.
- **카탈로그 ≠ cron** — 콘솔 카탈로그는 비활성 정의도 노출(수동 실행), cron 은 `enabled` 만.
- **파드 생성/SSH 형** (`pod_to_pod`) 은 `pods.create` 권한과 부하를 고려. 기본 category
  분류만으로 위험도가 드러나지 않으니 `default_enabled` 를 신중히.
- **cron 최소 간격 가드** — `check_matrix_service` 가 Ollama 리뷰/deep-check 부하 보호를 위해
  너무 짧은 평균 간격의 cron 을 거부한다.
- **스키마 변경 규칙** — deep_check 테이블에 컬럼을 추가하면 `_run_migrations` 에
  `_safe_add_column` 으로 보강하고 백업 서비스(`backup_service.py`) 호환을 점검(민감정보는
  `SENSITIVE_COLUMNS`, 대용량 로그성은 `LOG_TABLES`). CLAUDE.md 의 Backup/Restore 규칙 참조.
- **결과는 회차로 묶인다** — `daily_check_log_id` 로 DailyCheckLog 와 연결돼야 리뷰/트렌드에
  올바르게 집계된다. 미지정 push 는 최신 회차로 자동 연결하는 fallback 이 있으나, deep check 가
  daily check 보다 먼저 도는 등으로 최신 회차가 **6시간 이상 오래됐으면 연결하지 않는다**
  (과거 회차 오연결 방지, `_AUTO_LINK_MAX_AGE_HOURS`).
- **리텐션** — `deep_check_results` 는 매일 03:10 KST `run_deep_check_results_purge` 가
  check_matrix 와 동일한 보관일수(기본 90일) 초과분을 청크 삭제한다(무한 증가 방지).
- **Ingest 보안** — `/deep-check/ingest` 는 JWT 없이 마운트되므로 `SUPERPOD_INGEST_TOKEN`
  이 유일한 방어선이다. 미설정이면 503 으로 fail-closed. HTTPS ingest 시 in_cluster 러너에
  `SUPERPOD_INGEST_VERIFY_TLS=true` 로 인증서 검증을 켜 토큰 노출(MITM)을 막을 수 있다.
