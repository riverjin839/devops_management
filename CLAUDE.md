# CLAUDE.md — DEVOPS MANAGEMENT

This file provides essential context for AI assistants (Claude and others) working on this codebase.

---

## Project Overview

**PEP (Platform Engineering Portal)** is a platform engineering tool covering:
- K8s cluster monitoring and operations (original core)
- Infrastructure management (servers, network, storage, GPU roadmap)
- Team collaboration (work items, workflows, members)
- Knowledge sharing (documentation, AI analysis, ontology)

Originally "K8s Daily Monitor" (DevOps Management), redefined as Platform Engineering Portal in May 2026.

---

## 화면 단위 명세서 (Screens Reference)

프론트엔드의 모든 화면(라우트)을 화면 단위로 UX/UI/Frontend/Backend/핵심 기능으로 정리한 문서가
**`docs/SCREENS.md`** 에 있다. 사용자가 화면별 개선 요청을 그 문서에 직접 적어두고, 이후 세션에서
"docs/SCREENS.md 의 `<화면명>` 요청사항 반영해줘" 처럼 가리켜 작업을 요청하는 용도로 관리된다.
특정 화면을 수정하기 전에 먼저 이 문서에서 해당 화면 섹션을 확인해 현재 구조(사용 hook/컴포넌트/API
엔드포인트)를 파악하고 시작할 것. 화면 구조가 크게 바뀌면 해당 섹션도 함께 갱신해준다.

---

## 참고 프로젝트 (Reference Projects)

PEP 의 문서·에디터·블록·협업/지식관리 기능을 발전시킬 때 **벤치마킹/응용 기준**으로 삼는 오픈소스 Notion 계열 프로젝트. 관련 요청(에디터 아키텍처, 블록/문서 모델, 협업/동기화, 지식베이스 UX 등)이 오면 이 두 레포를 참고 기준으로 활용한다.

| 프로젝트 | Git URL | 비고 |
|---|---|---|
| **AppFlowy** | `https://github.com/AppFlowy-IO/AppFlowy.git` | Flutter(Dart) + Rust core, grid/board/calendar DB, AppFlowy-Cloud |
| **AFFiNE** | `https://github.com/toeverything/AFFiNE.git` | TypeScript/React, 자체 BlockSuite 블록 에디터, Yjs(CRDT) 로컬-퍼스트 |

- 이 두 레포는 기본 세션 스코프(`riverjin839/devops_management`)에 없으므로, 코드 레벨 분석이 필요하면 세션에 추가하거나 웹에서 직접 가져와 분석한다.

---

## Tech Stack

### Backend (`backend/`)
| Layer | Technology |
|---|---|
| Framework | FastAPI 0.109 + Uvicorn |
| ORM | SQLAlchemy 2.0 |
| DB | PostgreSQL 15 (via psycopg2-binary) |
| Migrations | Lightweight inline (`_run_migrations()` in `main.py`) — **no Alembic CLI** |
| Task queue | Celery 5.3 + Redis 7 |
| Scheduler | Celery Beat (매분 check-matrix cron 디스패처 + 리소스 스냅샷/배치잡/트렌드 수집) |
| HTTP client | httpx (async) |
| Config | pydantic-settings (`Settings` class reads `.env`) |
| K8s checks | `subprocess` calling `kubectl` + `kubernetes==29.0.0` SDK |
| AI Agent | Ollama HTTP API (local, optional) |
| Automation | ansible-runner |
| Python | 3.11 |

### Frontend (`frontend/`)
| Layer | Technology |
|---|---|
| Framework | React 18 + TypeScript 5.3 |
| Build | Vite 5 |
| Styling | Tailwind CSS 3 + shadcn/ui (Base UI 기본 · Radix 호환) + shadcn MCP (`frontend/.mcp.json`) |
| State | Zustand 4 (client state) + TanStack Query 5 (server state) |
| HTTP | axios |
| Charts | Recharts |
| Routing | React Router v6 |
| Icons | lucide-react |
| Linting | ESLint 8 + TypeScript ESLint |

### Infrastructure
| Concern | Technology |
|---|---|
| Containerisation | Docker + Docker Compose |
| K8s manifests | Kustomize (base + overlays: dev / prod / airgap / kind) |
| Helm chart | `helm/k8s-daily-monitor/` (values-dev / values-prod / values-airgap) |
| Local K8s | kind (`scripts/kind-setup.sh`) |
| Dev loop | Skaffold (`skaffold.yaml`) |
| CI | GitHub Actions (`ci.yml`) |
| CD | GitHub Actions (`cd.yml`) → GHCR → Kustomize deploy |
| GitOps | ArgoCD (`argocd/`) |
| Jenkins | `Jenkinsfile` (phase 3 production) |

---

## Repository Layout

전체 파일 지도(기능 → 파일 위치)는 **`CODE_MAP.md`** 를 먼저 볼 것. 아래는 도메인 단위 요약이다
(개별 나열은 규모상 생략 — 라우터 65개 / 모델 52개 / 페이지 67개).

```
devops_management/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app, lifespan, CORS, _run_migrations, 라우터 마운트
│   │   ├── config.py            # pydantic-settings Settings class
│   │   ├── database.py          # SQLAlchemy engine + SessionLocal + Base
│   │   ├── celery_app.py        # Celery app + Beat (매분 check-matrix 디스패처 등 6개 스케줄, ~13개 태스크)
│   │   ├── models/              # SQLAlchemy ORM 모델 52개 — 도메인 그룹:
│   │   │   #  모니터링/점검: cluster, daily_check, check_log, check_matrix, deep_check,
│   │   │   #    ops_check, metric_card, addon, k8s_event, resource_count,
│   │   │   #    config_snapshot, os_param_change, trend
│   │   │   #  업무 관리: work_item(+comment/time_block/custom_field), sprint, project, workflow
│   │   │   #  지식: ontology, mindmap, work_guide, ops_note, voc_post, command_entry, reaction
│   │   │   #  인프라/서비스: infra_node, node_server_spec, management_server, isilon_server,
│   │   │   #    service_entry, service_category, service_topology, service_arch_doc,
│   │   │   #    topology_audit_log, lake_service, lake_service_type, cluster_item,
│   │   │   #    cluster_custom_field
│   │   │   #  플랫폼/자동화: batch_job, bottleneck_run, ansible_assets, playbook
│   │   │   #  사용자/설정: user, user_setting, user_jira_credential, user_notification, island,
│   │   │   #    app_setting, audit_log
│   │   ├── routers/             # APIRouter 64개 — 모델과 같은 도메인 그룹 + auth, health,
│   │   │   #  history, backup, notifications, release_notes, ui_settings,
│   │   │   #  terminal_appearance, k8s_resources/k8s_allocation/k8s_helm/k8s_exec/k9s_ssh,
│   │   │   #  cilium_trace/topology_trace, bottleneck, etcdctl, mc_client, bulk_exec,
│   │   │   #  commands, analyze, versions, jira, voc, promql, agent ...
│   │   ├── schemas/             # Pydantic 스키마
│   │   └── services/            # 서비스 모듈 ~40개 + 하위 패키지 7개:
│   │       ├── checkers/          # 일일점검 컴포넌트 체커 9개 (argocd/control_plane/etcd/
│   │       │                      #  jenkins/keycloak/nexus/node/system_pod + base)
│   │       ├── deep_checkers/     # 심층 점검 16종 (cert_expiry, coredns, etcd_defrag,
│   │       │                      #  isilon_nfs, oom_events, pvc_health, audit_rbac ...)
│   │       ├── lake_checkers/     # 데이터 LAKE 서비스 프로브 (airflow/spark/trino/starrocks ...)
│   │       ├── bottleneck_probes/ # dns_latency, tcp_perf, tcp_state, endpoints
│   │       ├── analyzers/         # 장애 분석기: claude / local_llm / rule_based + factory
│   │       ├── batch_jobs/        # etcdctl_defrag, shell_command(SSH) + k8s_job_cleanup(non-SSH) 실행기
│   │       └── trends/            # github/rss 수집기 + summarizer + trend_service
│   ├── tests/                   # pytest 스위트: conftest + 테스트 모듈 13개 (API, 클러스터
│   │                            #  등록/토폴로지/추이, 배치잡, deep check, 임베딩, 온톨로지 등)
│   ├── requirements.txt
│   ├── pytest.ini               # testpaths=tests, asyncio_mode=auto
│   └── Dockerfile
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # React Router — 페이지 67개, 라우트 ~92개 (진입점 `/` = HomePage,
│   │   │                        #  구 대시보드는 /cluster-overview; 레거시 경로는 redirect;
│   │   │                        #  RequireAdmin·RequireFeature 가드)
│   │   ├── main.tsx             # Entry point
│   │   ├── types/index.ts       # 공용 TypeScript 인터페이스
│   │   ├── services/api.ts      # axios 기반 API 서비스 레이어
│   │   ├── stores/              # Zustand 10개: authStore, clusterStore, themeStore, sidebarStore, islandStore,
│   │   │                        #  homeStore, debugStore, playbookStore, tableViewStore, terminalEnvStore
│   │   ├── hooks/               # TanStack Query 훅 ~55개 (도메인 리소스당 1개+)
│   │   ├── pages/               # 페이지 67개 — 화면별 명세는 docs/SCREENS.md 참고
│   │   ├── components/          # 기능별 그룹: common/(ClusterSidebar), ui/(MacCard, shadcn),
│   │   │                        #  layout/(Sidebar, navConfig.ts), dashboard/, agent/, playbooks/,
│   │   │                        #  work-items/ 등 도메인 폴더 다수
│   │   └── config/
│   ├── package.json             # version = 릴리스 버전 소스
│   └── Dockerfile               # nginx-based production image
│
├── k8s/
│   ├── base/                    # Kustomize base (backend/frontend/postgres/redis/celery/
│   │   │                        #  ollama.yaml, kubewatch, observability/)
│   ├── overlays/                # dev / prod / kind / airgap (폐쇄망 registry mirror)
│   └── superpod/                # in-cluster deep-check CronJob 매니페스트
│
├── helm/k8s-daily-monitor/      # Helm chart (values / values-dev / values-prod / values-airgap)
├── scripts/                     # kind-setup.sh, deploy-airgap.sh, init-cluster.sh,
│   │                            #  release/bump_version.py, docs/check_docs_sync.py
├── ansible/playbooks/           # Ansible playbooks run by backend
├── argocd/                      # ArgoCD Application + Project manifests
├── docs/                        # 가이드 ~19개 + 하위 폴더 — 인덱스는 docs/README.md 참고
│   │                            #  (SCREENS, DEPLOY, ADMIN_MANUAL, DEEP_CHECKER, AIRGAP_LLM_*,
│   │                            #   BACKUP_RESTORE, K8S_OPS_CHECKLIST, branch-tag-strategy ...)
│   ├── 01-plan/ 02-design/ 03-analysis/   # 기능별 계획/설계/분석 문서
│   ├── archive/                 # 완료 기능 문서 아카이브
│   └── superpowers/             # plans/specs
├── docker/ vagrant/ windows-docker/       # 로컬 실험 환경 (Vagrant/VirtualBox, Windows)
├── docker-compose.yml           # 로컬 개발 (postgres+redis+backend+frontend+celery(+beat)
│                                #  +kubewatch+grafana-renderer)
├── skaffold.yaml, Makefile, Jenkinsfile
├── CODE_MAP.md                  # 기능 → 파일 지도 (여기부터 볼 것)
├── DESIGN_SYSTEM.md             # UI 디자인 시스템 상세 (토큰/규격 원천)
├── DESIGN.md                    # UX/UI 운영 문서 — 현행화·개선포인트 백로그·고도화 로드맵·점검 이력
│                                #  (ux-ui-designer 에이전트/스킬이 관리)
└── .env.example                 # backend 환경변수 템플릿
```

---

## Development Workflows

### Local Development (Docker Compose) — Recommended for most changes

```bash
# Start all services (postgres, redis, backend, frontend, celery worker+beat, kubewatch, grafana-renderer)
docker-compose up -d

# Frontend: http://localhost:5173
# Backend API: http://localhost:8000/docs
# Stop
docker-compose down
```

### Local Development (native processes)

```bash
# Install dependencies
make install

# Run frontend + backend concurrently
make dev
# Backend: http://localhost:8000
# Frontend: http://localhost:5173

# Backend only
cd backend && uvicorn app.main:app --reload --port 8000

# Frontend only
cd frontend && npm run dev
```

### Local Kubernetes (kind)

```bash
# Create cluster, build images, deploy everything
bash scripts/kind-setup.sh up

# After code changes, rebuild and redeploy
bash scripts/kind-setup.sh reload

# Tear down
bash scripts/kind-setup.sh destroy

# URLs: http://localhost:30080 (frontend), http://localhost:30800/docs (API)
```

### Skaffold (hot-reload on K8s)

```bash
make skaffold-dev    # watches src/, rebuilds on change
```

---

## Running Tests

### Backend

```bash
cd backend
pytest -v
```

Tests require a running PostgreSQL instance. In CI, one is provided as a service container. Locally you can point to the Docker Compose postgres:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/k8s_monitor_test pytest -v
```

`pytest.ini` settings: `testpaths = tests`, `asyncio_mode = auto`.

`backend/tests/` 는 `conftest.py` + 테스트 모듈 ~13개로, API 엔드포인트·클러스터
등록/토폴로지/추이·배치잡 디스패처·deep check(node health)·agent/embedding 파이프라인·
온톨로지·자원 할당을 커버한다.

### Frontend

```bash
cd frontend
npm run lint          # ESLint (max-warnings 0 — zero tolerance)
npx tsc --noEmit      # TypeScript type check
npm run build         # Production build (also validates TS)
```

There are no Jest/Vitest unit tests currently. CI validates lint + type-check + build.

---

## Environment Variables

Copy `.env.example` → `.env` in the **backend** directory for local development.

아래 표는 `backend/app/config.py` 의 `Settings` 클래스 기준이다 (그룹별). pydantic-settings 가
`.env` 를 자동으로 읽고 변수명은 대소문자 무시.

**Core / DB / Celery**

| Variable | Default | Description |
|---|---|---|
| `APP_NAME` | `DEVOPS MANAGEMENT` | 앱 표시 이름 |
| `DEBUG` | `false` | FastAPI debug mode |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/k8s_monitor` | PostgreSQL connection string |
| `DB_POOL_SIZE` | `10` | SQLAlchemy 엔진 풀 크기. backend/celery worker/beat 가 같은 engine 코드를 공유하므로, replica 합계 × (pool_size+max_overflow) 가 Postgres `max_connections` 를 넘지 않게 배포별로 오버라이드(worker/beat 는 k8s 매니페스트에서 더 작게 설정됨) |
| `DB_MAX_OVERFLOW` | `20` | SQLAlchemy 엔진 풀의 추가 오버플로 커넥션 수 |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection |
| `CELERY_BROKER_URL` | `redis://localhost:6379/0` | Celery broker |
| `CELERY_RESULT_BACKEND` | `redis://localhost:6379/0` | Celery result store |
| `BATCH_JOBS_TIMEZONE` | `Asia/Seoul` | 배치잡 cron 해석 timezone (IANA) |

**인증 (Auth)**

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | *(change in production)* | JWT signing key |
| `ALGORITHM` | `HS256` | JWT 알고리즘 |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `1440` (24h) | 토큰 만료 |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` | `admin` / `admin` | 사용자 0명일 때 부트스트랩 관리자 |

**점검 / K8s**

| Variable | Default | Description |
|---|---|---|
| `CHECK_INTERVAL_MINUTES` | `5` | Health check interval |
| `CHECK_TIMEOUT_SECONDS` | `30` | kubectl/HTTP timeout |
| `KUBECONFIG_STORE_DIR` | `/tmp/k8s-monitor/kubeconfigs` | content 방식 kubeconfig 저장 위치 |
| `KUBEWATCH_TOKEN` | *(empty)* | kubewatch 웹훅 Bearer 토큰. **fail-closed** — 미설정 시 웹훅 수신 자체를 503 으로 거부(deep_check ingest 의 SUPERPOD_INGEST_TOKEN 과 동일 정책) |
| `MGMT_NAMESPACE` | `k8s-monitor` | 관리 네임스페이스 (K8sEvent 채널) |
| `SUPERPOD_MODE` | `centralized` | `in_cluster` \| `centralized` — deep check 실행 모드 |
| `SUPERPOD_INGEST_URL` / `SUPERPOD_INGEST_TOKEN` | *(empty)* | in-cluster CronJob 결과 push 대상 |
| `SUPERPOD_CLUSTER_ID` | *(empty)* | in_cluster 모드에서 자기 클러스터 식별자 |

**AI / LLM / Embedding**

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://ollama:11434` | Ollama base URL |
| `OLLAMA_MODEL` | `llama3` | LLM model name (airgap overlay 는 `qwen2.5-coder:7b`) |
| `OLLAMA_TIMEOUT` | `120` | LLM request timeout (s) |
| `EMBEDDING_MODEL` | `nomic-embed-text` | 임베딩 모델 (WorkItem/WorkGuide 유사 검색) |
| `EMBEDDING_DIM` | `768` | 임베딩 차원 — 모델 교체 시 함께 변경(기존 벡터 재계산 필요) |
| `EMBEDDING_TIMEOUT` | `30` | 임베딩 요청 timeout (s) |
| `ANALYZER_BACKEND` | `rule_based` | 장애 분석기: `claude` \| `local_llm` \| `rule_based` (※ Settings 가 아닌 `os.getenv` — `services/analyzers/factory.py`) |

**Prometheus / Grafana / Trends**

| Variable | Default | Description |
|---|---|---|
| `PROMETHEUS_URL` | `http://prometheus-k8s.monitoring.svc:9090` | Prometheus endpoint |
| `GRAFANA_URL` | `http://grafana.monitoring.svc:3000` | Grafana endpoint |
| `GRAFANA_RENDERER_URL` | `http://grafana-renderer:8081` | 패널 이미지 렌더러 |
| `PROMETHEUS_NODE_LABEL` | `instance` | node-exporter 노드 식별 라벨 (배포 의존) |
| `TRENDS_MAX_NODES` | `30` | 추이 조회 최대 노드 수 |
| `TRENDS_GITHUB_API_URL` | `https://api.github.com` | 트렌드 수집 GitHub API (폐쇄망: 내부 GHE) |
| `TRENDS_GITHUB_TOKEN` | *(empty)* | optional — rate limit 향상 |
| `TRENDS_COLLECT_HOUR` | `7` | 매일 자동 수집 시각 (KST) |

**알림 / 기타**

| Variable | Default | Description |
|---|---|---|
| `SLACK_WEBHOOK_URL` | *(empty)* | Slack 알림 채널 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` / `SMTP_USE_TLS` | port 587, TLS on | 메일 알림 |
| `ANSIBLE_PLAYBOOK_DIR` / `ANSIBLE_INVENTORY_DIR` | `/app/ansible/...` | Ansible 자산 경로 |
| `ALLOWED_ORIGINS` | *(empty)* | 추가 CORS origin (콤마 구분) — ※ Settings 가 아닌 `os.getenv` (`main.py`) |

---

## Backend Architecture Details

### Database / Migrations

- Tables are created automatically at startup via `Base.metadata.create_all(bind=engine)` in the `lifespan` context manager (`main.py`).
- Schema additions use a lightweight `_run_migrations()` function that inspects existing columns and runs `ALTER TABLE` as needed. **There is no Alembic migration workflow.**
- **모든 schema 변경은 반드시 `_safe_*` 헬퍼 (`main.py` 의 `_safe_add_column`, `_safe_exec`, `_safe_create_index`) 를 사용**:
  - `_safe_add_column(table, col, type)` → `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...` + 개별 try/except + 로깅. raw `ALTER` 금지.
  - `_safe_exec(sql, label=)` → `DROP NOT NULL` / `SET NOT NULL` / `ALTER TYPE ... USING` / `ADD CONSTRAINT` / backfill `UPDATE` 처럼 IF NOT EXISTS 가 없는 위험 SQL 격리용.
  - `_safe_create_index(name, table, expr)` → `CREATE INDEX IF NOT EXISTS` 단축.
- 한 마이그레이션이 실패해도 부팅이 막히지 않도록 lifespan 단계(`create_all` / `_run_migrations` / 각 `_seed_*`) 가 try/except 로 격리되어 있다. 부팅 로그에 `migration: ensured X.Y exists` / `migration: ... skipped (사유)` 로 흔적이 남는다.
- On first startup `_seed_default_metric_cards()` inserts 6 default PromQL cards if the `metric_cards` table is empty.

### Backup / Restore (DB Schema Compatibility)

JSON 기반 애플리케이션 백업이 `backend/app/services/backup_service.py` 에 있고 Settings 페이지에서 export/import 한다. 이 서비스는 **per-table fault-tolerant** 로 설계돼야 한다 — prod DB 의 한 테이블이 model 과 어긋나도 (누락된 컬럼/타입 mismatch) 전체 백업이 500 으로 죽지 않도록.

**규칙** (스키마 변경 시 반드시 함께 점검):
1. 모든 테이블 순회는 `_safe_select_rows(db, t)` 같이 per-table try/except + `db.rollback()` 패턴. 한 테이블 실패는 envelope 의 `errors` / `skipped_tables` 에 사유 기록하고 다음 테이블로 진행.
2. `export_all` / `compute_diff` / `current_meta` 모두 위 패턴을 따른다. 새 helper 추가 시 같은 패턴 강제.
3. Router 엔드포인트 (`backend/app/routers/backup.py`) 는 서비스 호출을 try/except 로 감싸 `HTTPException(500, detail=...)` 로 구체적 사유 노출. **빈 500 금지**.
4. 새 컬럼/테이블을 model 에 추가하면:
   - `_run_migrations()` 에 `_safe_add_column` 으로 보강 (구버전 DB 호환).
   - 민감 정보면 `SENSITIVE_COLUMNS` 에 등록해 default export 에서 마스킹.
   - 대용량 로그성이면 `LOG_TABLES` 에 등록해 `include_logs=False` 일 때 제외.
   - Restore (`apply_import`) 의 PK 기반 upsert / replace 로직이 새 PK / FK 변경에 영향 받는지 확인.
5. 운영자가 export 결과의 `errors` / `skipped_tables` 를 확인할 수 있도록 Settings UI 가 노출해야 함 (스키마 드리프트 조기 감지).

### Router Registration

All routers are imported from `app/routers/__init__.py` and mounted under `/api/v1` in `main.py`. To add a new router:
1. Create `backend/app/routers/my_router.py` with an `APIRouter`.
2. Export it from `backend/app/routers/__init__.py`.
3. Include it in `main.py` with `app.include_router(...)`.

### Celery Tasks

구 아침/점심/저녁(09/13/18) 하드코딩 스케줄은 **check-matrix cron 디스패처로 완전 대체**됐다.
`celery_app.py` 의 Beat 스케줄 7개:

| Beat 엔트리 | 주기 | 역할 |
|---|---|---|
| `check-matrix-dispatch` | 매분 | 각 클러스터의 `check_cron_expr`(core 번들) + `CheckMatrixSchedule` cron 평가 → due 점검 실행 |
| `check-matrix-log-purge` | 03:00 | 점검 결과 로그 정리 |
| `daily-trend-collect` | 07:00 | 기술 트렌드(GitHub/RSS) 수집 |
| `resource-count-snapshot-dispatcher` | 매분 | 리소스 카운트 스냅샷 디스패치 |
| `batch-job-dispatcher` | 매분 | 등록된 배치잡 cron 평가·실행 |
| `cluster-item-dispatcher` | 매시 :00 | 클러스터 아이템 점검 |
| `arch-doc-sync-dispatcher` | 매분 | 서비스 아키텍처 문서 현행화 (AppSetting cron 평가 → `sync_all_architecture_docs`) |

태스크는 ~16개: 디스패처류(`run_check_matrix_dispatch`, `run_batch_job_dispatcher`,
`dispatch_resource_count_snapshot`, `run_cluster_item_dispatcher`,
`dispatch_architecture_doc_sync`), 수집류(`collect_resource_counts`,
`run_trend_collect`, `sync_all_architecture_docs`), 실행류(`run_single_check`, `run_batch_job`, `run_ops_check_batch`),
AI/임베딩(`run_review_and_notify`, `compute_work_item_embedding`, `compute_work_guide_embedding`,
`generate_arch_doc_llm`) 등.
async 서비스는 `asyncio.new_event_loop()` + `loop.run_until_complete()` 로 브리지한다.

### Health Check Logic (`services/daily_checker.py`)

`DailyChecker.run_daily_check()` orchestrates four sub-checks:
1. `_check_api_server` — HTTP GET to `{cluster.api_endpoint}/{healthz,livez,readyz}` via httpx.
2. `_check_components` — `kubectl get componentstatuses -o json`.
3. `_check_nodes` — `kubectl get nodes -o json`.
4. `_check_system_pods` — `kubectl get pods -n kube-system -o json`.

Overall status precedence: `critical` > `warning` > `healthy`.

### Fail-Safe External Services

Both `AIAgentService` (`agent_service.py`) and `PrometheusService` (`prometheus_service.py`) follow the same pattern: **all exceptions are caught, returning structured offline/error dicts**. They never raise HTTP 500s. The dashboard continues to work even when Ollama or Prometheus is unavailable.

### AI Agent (Ollama)

- Endpoint: `/api/v1/agent/chat` (POST), `/api/v1/agent/health` (GET).
- Default model: `llama3` (configurable via `OLLAMA_MODEL`).
- Context dict fields: `cluster_name`, `cluster_status`, `pod_logs`, `node_status`, `error_messages`, `extra`.
- Model auto-pull is NOT done at startup; call `POST /api/v1/agent/pull-model` to trigger it.
- 장애 분석은 별도 분석기 스택(`services/analyzers/` — `claude`/`local_llm`/`rule_based`,
  `ANALYZER_BACKEND` 로 선택)이 담당하며 **분석 전용(조치 실행 없음)** 이다.
  폐쇄망 LLM 구성·아키텍처는 `docs/AIRGAP_LLM_ARCHITECTURE.md`, 모델 반입은
  `docs/AIRGAP_LLM_NEXUS.md` 참고.

### PromQL Metric Cards

- Stored in `metric_cards` PostgreSQL table.
- Seeded with 6 defaults on first run (CrashLoopBackOff pods, Failed pods, CPU/Memory usage, PVC disk, network).
- `display_type`: `value` | `gauge` | `list`.
- `thresholds`: string format `"warning:70,critical:90"`.
- Query execution: `GET /api/v1/promql/query/{card_id}` or `GET /api/v1/promql/query/all`.

---

## UI Design System

테마 3종 + 토큰 기반 시스템이다. 토큰 실측값의 원천은 `frontend/src/index.css`, 규격 근거는
`DESIGN_SYSTEM.md`, 운영(감사·백로그)은 `DESIGN.md`.

### Theme System (`stores/themeStore.ts` — `k8s:theme`, fallback `'default'`)

| `<html>` 클래스 | 성격 | 비고 |
|---|---|---|
| `html.default` | **기본값** — Anthropic Claude 브랜드 톤 (따뜻한 페이퍼 배경, `--radius` 14px, 은은한 그림자, 코랄 accent) | 신규 사용자 첫 진입 화면. 레거시 `'claude'` 값은 자동 마이그레이션 |
| `:root` / `html.light` | Databricks-leaning 라이트 — flat 표면, slate 팔레트, sky accent, **다크 네이비 사이드바**, `--radius` 8px, `--card-shadow: none` | Phase A redesign |
| `html.dark` | Databricks-leaning 다크 | DESIGN_SYSTEM.md "Ops Slate" 계열 |
| (`system`) | OS 설정 따라 light/dark 자동 | 클래스는 light/dark 중 하나로 해석됨 |

핵심 원칙: **모든 색·라운딩은 테마별로 값이 달라지므로 고정값 대신 토큰을 쓴다.**
Semantic status(`--status-healthy/warning/critical/...`), Surface Container 5단계
(`bg-surface-container-lowest~highest`), brand(`--brand-jira`), motion(`--motion-*`) 토큰이
`index.css` 에 3테마 모두 정의돼 있다.

### 라운딩 (radius 토큰)

`tailwind.config.js` 매핑: `rounded-lg` = `var(--radius)` / `rounded-md` = radius−2px /
`rounded-sm` = radius−4px — **테마 인지(theme-aware)**. `rounded-xl`/`rounded-2xl` 은 고정값.

- **카드**: `MacCard`(flat 기본, `rounded-md` 토큰) 사용 — 페이지에서 카드 div 를 직접 만들지 않는다.
- **버튼/입력**: `rounded-xl` (`ui/button.tsx` 기준). sharp corner 금지.
- 직접 `rounded-2xl` 카드는 레거시(mac variant·다이얼로그) — 신규 코드에서 사용하지 않는다.

### MacCard Component (`frontend/src/components/ui/MacCard.tsx`)

모든 주요 섹션은 `MacCard` 로 감싼다. shadcn `Card` 프리미티브의 어댑터이며 variant 2종:

- **`flat` (기본)**: 평평한 표면 + 1px 보더, 좌측 정렬 소형 대문자 라벨 헤더 (`bg-surface-container-high`), 라운딩 `rounded-md` 토큰. 신규 코드는 전부 이것.
- **`mac` (레거시 opt-in)**: 신호등 3점 + 중앙 타이틀의 구 macOS 창 스타일. 신규 사용 금지.

```tsx
import { MacCard } from '@/components/ui/MacCard';

<MacCard title="Cluster Status">{/* content */}</MacCard>
```

Props: `title?`, `variant?`('flat'|'mac', 기본 'flat'), `children`, `className?`(body),
`rootClassName?`, `bodyPadding?`(기본 flat `p-4` / mac `p-5`).
신호등 CSS 변수(`--mac-red/yellow/green`)는 mac variant 전용으로만 유지된다.

### Component Conventions

- **카드**: `MacCard` 사용, 직접 `bg-card border` div 조합 금지 (DESIGN.md D-004).
- **Shadows**: light/dark 는 `--card-shadow: none`(보더가 그림자 대체), default 테마만 은은한 depth —
  `.mac-shadow` 유틸이 토큰을 따라가므로 개별 shadow 클래스를 만들지 않는다.
- **Section titles inside MacCard**: 카드 제목을 본문 `<h2>` 로 중복하지 않는다.
- **Colors**: JSX 내 raw hex 금지 — Tailwind 토큰(`text-primary` 등) 또는 `hsl(var(--*))`.
  고정 팔레트(`text-white`, `bg-gray-*` 등)도 금지 — 테마 토큰(`text-foreground`,
  `text-muted-foreground`, `bg-card`, `bg-secondary`)을 쓴다. 차트/캔버스는 `--chart-*` 토큰 우선.
- **접근성**: 아이콘 전용 버튼은 `title` 과 함께 **`aria-label` 병행**을 표준으로 한다.

### Cluster Sidebar Standard (`ClusterSidebar`) — required for all per-cluster pages

**Component:** `frontend/src/components/common/ClusterSidebar.tsx`

페이지에 클러스터 선택 사이드바를 표시할 때는 **항상 `iconOnly` 모드**를 사용한다. 이는 메인 사이드바와 시각 일관성을 유지하기 위한 표준이며, 폭 56px 의 아이콘 레일로 렌더되고 호버 시 클러스터 이름·region·운영등급이 툴팁으로 표시된다. 시퀀스 번호(`seq`)는 어떤 모드에서도 노출하지 않는다.

**시각적 형태 (iconOnly 모드):**
```
┌────┐
│ ▦  │  ← 전체 (allowAll 시) — LayoutGrid 아이콘
├────┤
│ ✓●│  ← 클러스터 1 (status 아이콘 + 우상단 status dot)
│ ⚠●│  ← 클러스터 2 (warning)
│ ✕●│  ← 클러스터 3 (critical)
└────┘
   ↑ 호버하면 우측에 "이름 · region · 등급" 툴팁이 portal 로 표시됨
```

**사용 패턴 (3가지):**

| 시나리오 | 필수 props | 예시 페이지 |
|---|---|---|
| 단일 선택 (전체 옵션 X) | `iconOnly` + `selectedId` + `onSelect` | CiliumTracePage |
| 단일 선택 + 전체 옵션 | `iconOnly` + `allowAll` + `allLabel` + `selectedId` + `onSelect` | Dashboard |
| 다중 선택 (빈 배열 = 전체) | `iconOnly` + `multiSelect` + `selectedIds` + `onMultiSelectChange` (+ optional `allowAll` `allLabel`) | PlaybooksPage, BulkExecPage |

**예시 — 단일 선택:**
```tsx
<ClusterSidebar
  clusters={clusters}
  selectedId={clusterId || null}
  onSelect={(id) => setClusterId(id ?? '')}
  iconOnly
/>
```

**예시 — 단일 선택 + 전체:**
```tsx
<ClusterSidebar
  clusters={clusters}
  selectedId={selectedClusterId}
  onSelect={setSelectedClusterId}
  allowAll
  allLabel="전체 현황"
  iconOnly
/>
```

**예시 — 다중 선택 (PlaybooksPage 패턴):**
```tsx
<ClusterSidebar
  clusters={clusters}
  selectedId={null}
  onSelect={() => { /* multiSelect 모드라 미사용 */ }}
  allowAll
  allLabel="전체 클러스터"
  iconOnly
  multiSelect
  selectedIds={selectedClusterIds}
  onMultiSelectChange={setSelectedClusterIds}
/>
```

**레이아웃 규칙:**
- **간격 표준 (모든 per-cluster 페이지 동일)**: 보조 사이드바(클러스터/서비스)는 **메인 사이드바에 flush(좌측 공백 0)** 로 붙인다. 컨테이너 행은 좌측 패딩 없이 `py-3 pr-3 flex gap-3` (또는 `min-h-screen bg-background flex`) 로 잡는다.
  - 메인 사이드바 ↔ 보조 사이드바 = **0px(공백 없음)**, 보조 사이드바 ↔ 본문 = `gap-3`(12px) 또는 본문의 좌측 패딩으로 띄운다.
  - ❌ 행에 `mx-auto`/`max-w-[...]` 로 가운데 정렬하면 보조 사이드바가 우측으로 밀려 공백이 생긴다 — **행은 좌측 정렬**(센터링 금지). 가독성 max-width 가 필요하면 보조 사이드바가 아니라 **본문(`flex-1`)에만** 적용한다.
  - ❌ 좌측 `px-3`/`px-6`/`p-3` 처럼 행 전체에 좌측 패딩을 줘서 메인 사이드바와 보조 사이드바 사이에 틈을 만들지 않는다.
- 사이드바 옆 본문은 `<div className="flex-1 min-w-0">` 으로 감싼다.
- 사이드바는 `sticky top-4` 로 고정되어 스크롤해도 따라온다.
- `MacCard` 등 본문 wrapper 와 같은 row 에 둔다.

**금지:**
- ❌ 와이드 폼 (`iconOnly` 없이 사용) — 신규 페이지에서 절대 사용 금지. 기존 페이지도 모두 iconOnly 로 마이그레이션됨.
- ❌ `seq` 번호를 별도로 표시하는 어떤 UI 도 금지 (레거시 동작).
- ❌ 페이지 내 dropdown 형태 클러스터 선택기 (`<select>`) — 대신 좌측 사이드바를 쓴다.
- ❌ `onReorder` prop — iconOnly 에서는 정렬 토글이 노출되지 않으므로 사용 금지. 클러스터 정렬은 `/cluster-manage` 페이지에서만 한다.

### 콘솔 화면 표준 패턴 (PEP Console Pattern) — SSH/exec 실행형 화면 공통

원격 명령을 실행하고 로그(stdout/stderr)를 보여주는 화면은 모두 **같은 패턴**을 따른다.
"콘솔 패턴 반영해줘" 류 요청이 오면 아래 목록의 화면 전부에 일괄 적용한다.

**적용 화면**: 노드 일괄 실행 `/bulk-exec` · mc 클라이언트 `/mc-client` · etcdctl `/etcdctl` ·
Cilium BPF Trace `/cilium-trace` · 커널 파라미터 `/kernel-params` (+ 신규 SSH/exec 콘솔은 전부 이 패턴으로 시작)

1. **레이아웃 — 좌(컨트롤) / 우(결과) 한 로우 고정**: 10~12컬럼 grid(`grid grid-cols-1 lg:grid-cols-10 gap-4 items-start` 등)로
   컨트롤 카드(들)를 좌측(4~5), 결과/로그 카드를 우측(5~6)에 배치한다. 결과 카드는 **실행 전에도 같은 자리에
   플레이스홀더**로 존재해 레이아웃이 흔들리지 않고, 스크롤은 결과 패널 내부에서만(가로 스크롤로 페이지가 늘어나면 안 됨).
2. **stdout/stderr 는 `ExecOutputTabs`** (`components/common/ExecOutputTabs.tsx`): 두 스트림을 위아래로 쌓지 않고
   탭으로 전환한다. 탭 라벨에 결과 유무 dot(초록=stdout/빨강=stderr)과 라인 수가 표기되고, 내용이 있는 쪽이 기본 활성
   탭이다(stdout 우선). stdout/stderr 를 각각 `LogViewer` 로 직접 쌓는 코드는 신규 작성 금지.
3. **로그 출력은 항상 `LogViewer`** (`components/common/LogViewer.tsx`): plain `<pre>` 금지. 포맷 자동감지(JSON/journal/table),
   필터/복사/줄바꿈 툴바, 터미널 Appearance(색/글꼴) 가 일괄 적용된다.
4. **터미널 Appearance 자동 적용 — `useTerminalEnvSync`** (`hooks/useTerminalEnvSync.ts`): 페이지 최상단에서
   `useTerminalEnvSync(clusters, selectedId | selectedIds)` 를 호출한다. 선택 클러스터의 운영등급(`operationLevel`)이
   prod/dr 계열이면 운영(ops), 아니면 개발(dev) 프로파일이 LogViewer 에 자동 적용된다(다중 선택은 하나라도 운영이면 ops,
   페이지 이탈 시 null 초기화). **기본값: 개발=Monokai, 운영=기본(테마 색상)** — 사용자가 Settings → 터미널 Appearance 에서
   프로파일별 템플릿/색/글꼴을 저장하면(개인화) 그 값이 우선한다(백엔드 `terminal_appearance` user_setting).
5. **실행 상태 배지**: ok/error/timeout/auth_error/connect_error 는 `STATUS_META` 패턴(색 + 아이콘 pill)으로 표기,
   위험 명령은 `ConfirmDialog` `danger` 확인을 거친다.

---

## Frontend Architecture Details

### State Management

- **Zustand stores** (`stores/`) manage client-only state (selected cluster, etc.).
- **TanStack Query hooks** (`hooks/`) manage all server state with caching and background refetching.
- Do not mix Zustand with server state — use TanStack Query for anything fetched from the API.

### API Service Layer

All backend calls go through `src/services/api.ts`. It wraps axios and provides typed functions for each resource. When adding a new backend endpoint, add a corresponding function here.

### TypeScript Types

All shared interfaces live in `src/types/index.ts`. Keep backend response shapes and frontend types in sync here. Key types: `Cluster`, `Addon`, `CheckLog`, `Playbook`, `MetricCard`, `MetricQueryResult`, `AgentChatRequest/Response`.

### Component Conventions

- Components are grouped by feature under `src/components/` (`common/`, `ui/`, `layout/`, `dashboard/`, `agent/`, `playbooks/`, `work-items/` 등 도메인 폴더 다수).
- 사이드바 메뉴/네비게이션 구성은 `src/components/layout/navConfig.ts` (`NAV_MAP`, `GROUPS`) — `Sidebar.tsx` 는 이를 import 만 한다.
- Each group has an `index.ts` barrel export.
- Use shadcn/ui primitives (Base UI default, Radix compatible) for dialogs, tabs, dropdowns, toasts. Add components via the shadcn MCP so the AI reads the real registry instead of guessing props.
- Tailwind CSS only — no CSS modules or styled-components.
- Do not use inline styles.

### ESLint

`eslint . --max-warnings 0` — **zero warnings allowed**. CI will fail on any lint warning. Fix all lint issues before committing.

---

## API Reference

### Base URL
`http://localhost:8000/api/v1` (local) or `http://<node>:30800/api/v1` (K8s NodePort)

**API 는 ~65개 라우터가 `/api/v1` 아래에 마운트된다** — 아래 상세 표는 원조 코어 4개 그룹의
대표 예시일 뿐 전체가 아니다. 전체 목록은 `backend/app/routers/__init__.py`, 라이브 스펙은
`/docs`(Swagger) 를 본다. 대부분의 라우터는 JWT 인증(`_auth` dependency)이 걸려 있고, 예외
(비인증 마운트)는 `auth`, `health`, `deep_check_ingest`, `k8s_exec`, `k9s_ssh`, `k8s_events_ingest` 다
(`k8s_exec`/`k9s_ssh` 는 WebSocket 이라 핸들러가 query token 을 직접 검증).

**라우터 그룹 인덱스** (한 줄 요약):

| 그룹 | 라우터 |
|---|---|
| 인증/사용자 | `auth`, `audit_logs`, `notifications`, `ui_settings`, `terminal_appearance`, `release_notes`, `backup`, `island` |
| 모니터링/점검 | `clusters`, `daily_check`, `check_matrix`, `deep_check`(+ingest), `deep_check_definitions`, `ops_check`, `history`, `metric_trend`, `cluster_trends`, `cluster_items`, `k8s_events`(+ingest), `promql`, `health` |
| K8s 운영 | `k8s_resources`, `k8s_allocation`, `k8s_helm`, `k8s_exec`, `k9s_ssh`, `bulk_exec`, `etcdctl`, `commands`, `mc_client`, `bottleneck`, `node_labels`, `node_images` |
| 네트워크/토폴로지 | `cilium_trace`, `topology_trace`, `service_topology`, `architecture_docs` |
| 업무 관리 | `work_items`, `work_item_custom_fields`, `jira`, `projects`, `sprint`, `workflows` |
| 지식 | `work_guide`, `ops_note`, `mindmap`, `ontology`, `voc`, `reactions`, `analyze`, `trends`, `agent` |
| 인프라/서비스 | `infra_nodes`, `management_servers`, `isilon_nfs`, `node_server_specs`, `service_entries`, `service_categories`, `lake_services`, `lake_service_types`, `versions`, `cluster_custom_fields`, `batch_jobs`, `ansible_assets`, `playbooks` |

### Cluster Management
| Method | Path | Description |
|---|---|---|
| GET | `/clusters/` | List all clusters |
| POST | `/clusters/` | Create cluster |
| GET | `/clusters/{id}` | Get cluster detail |
| DELETE | `/clusters/{id}` | Delete cluster |

### Daily Health Check
| Method | Path | Description |
|---|---|---|
| POST | `/daily-check/run/{cluster_id}` | Trigger manual check |
| GET | `/daily-check/results/{cluster_id}` | All results for cluster |
| GET | `/daily-check/results/{cluster_id}/latest` | Latest result |
| GET | `/daily-check/summary` | All-cluster summary |
| PUT | `/daily-check/schedule/{cluster_id}` | Update check schedule |

### PromQL Metric Cards
| Method | Path | Description |
|---|---|---|
| GET | `/promql/cards` | List cards (filter: `category`, `enabled_only`) |
| POST | `/promql/cards` | Create card |
| PUT | `/promql/cards/{id}` | Update card |
| DELETE | `/promql/cards/{id}` | Delete card |
| GET | `/promql/query/{card_id}` | Execute card's PromQL |
| GET | `/promql/query/all` | Execute all enabled cards |
| POST | `/promql/query/test` | Test arbitrary PromQL |
| GET | `/promql/health` | Prometheus availability probe |

### AI Agent
| Method | Path | Description |
|---|---|---|
| POST | `/agent/chat` | Send question to Ollama LLM |
| GET | `/agent/health` | Ollama availability probe |
| POST | `/agent/pull-model` | Trigger model download |
| GET | `/agent/models` | List available models |

### App Health Probes (no `/api/v1` prefix)
| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/health/live` | K8s liveness probe |
| GET | `/health/ready` | K8s readiness probe (checks DB) |

---

## Database Schema

### Key Models

**`clusters`** — `id (UUID PK)`, `name`, `api_endpoint`, `kubeconfig_path`, `status (healthy/warning/critical)`, `created_at`, `updated_at`

**`daily_check_logs`** — `id`, `cluster_id (FK)`, `schedule_type`, `check_date`, `overall_status`, `api_server_status`, `api_server_response_time_ms`, `api_server_details (JSONB)`, `components_status (JSONB)`, `nodes_status (JSONB)`, `total_nodes`, `ready_nodes`, `system_pods_status (JSONB)`, `error_messages`, `warning_messages`, `check_duration_seconds`

**`check_schedules`** — `id`, `cluster_id (FK)`, `morning_time`, `noon_time`, `evening_time`, `morning_enabled`, `noon_enabled`, `evening_enabled`, `timezone`, `is_active`

**`addons`** — `id`, `cluster_id (FK)`, `name`, `type`, `icon`, `description`, `status`, `response_time`, `details (JSONB)`, `config (JSONB)`, `last_check`

**`metric_cards`** — `id`, `title`, `description`, `icon`, `promql`, `unit`, `display_type`, `category`, `thresholds`, `grafana_panel_url`, `sort_order`, `enabled`, `created_at`, `updated_at`

**`playbooks`** — `id`, `cluster_id (FK)`, `name`, `description`, `playbook_path`, `inventory_path`, `extra_vars (JSONB)`, `tags`, `status`, `show_on_dashboard`, `last_run_at`, `last_result (JSONB)`

### Additional Model Families

위 6개는 원조 모니터링 코어다. 이외 ~43개 모델이 도메인별로 존재한다 — 전체는
`backend/app/models/__init__.py` 참고:

- **점검/이벤트**: `check_matrix`(Item/Schedule/Result/ResultLog), `deep_check`, `ops_check`, `check_log`, `k8s_event`, `resource_count`, `config_snapshot`, `os_param_change`
- **업무 관리**: `work_item`(+`work_item_comment`/`work_item_time_block`/`work_item_custom_field`), `sprint`, `project`, `workflow` — `work_items.embedding` 은 pgvector
- **지식**: `ontology`, `mindmap`, `work_guide`(pgvector `embedding`), `ops_note`, `voc_post`, `command_entry`, `reaction`, `trend`
- **인프라/서비스**: `infra_node`, `node_server_spec`, `management_server`, `isilon_server`, `service_entry`, `service_category`, `service_topology`, `topology_audit_log`, `lake_service`, `lake_service_type`, `cluster_item`, `cluster_custom_field`
- **플랫폼/자동화**: `batch_job`, `bottleneck_run`, `ansible_assets`
- **사용자/설정**: `user`, `user_setting`, `user_jira_credential`, `user_notification`, `app_setting`, `audit_log`, `island`(Your Island 커스텀 화면)

---

## Deployment

### Phase 1 — Local (kind)

```bash
bash scripts/kind-setup.sh up      # build + deploy
bash scripts/kind-setup.sh reload  # after code changes
bash scripts/kind-setup.sh destroy # teardown
```

### Phase 2 — Air-gapped / Closed Network

```bash
bash scripts/deploy-airgap.sh all  # interactive: asks for registry, CLI, credentials
```

Helm values: `helm/k8s-daily-monitor/values-airgap.yaml`
Kustomize overlay: `k8s/overlays/airgap/`

### Phase 3 — Production (Jenkins + Helm + ArgoCD)

```bash
helm install k8s-monitor ./helm/k8s-daily-monitor \
  -f ./helm/k8s-daily-monitor/values-prod.yaml \
  -n k8s-monitor --create-namespace
```

See `docs/DEPLOY_GUIDE.md` for full details.

### Kubernetes Namespaces

| Environment | Namespace |
|---|---|
| dev | `k8s-monitor-dev` |
| prod | `k8s-monitor-prod` |

### Makefile Quick Reference

```bash
make help             # list all targets
make install          # pip install + npm install
make dev              # start backend + frontend (parallel)
make test             # pytest + npm run lint
make build            # npm run build
make clean            # remove build artifacts

make docker-up        # docker-compose up -d
make docker-down      # docker-compose down
make docker-rebuild   # full rebuild

make k8s-dev          # kubectl apply -k k8s/overlays/dev
make k8s-prod         # kubectl apply -k k8s/overlays/prod
make k8s-status       # show all k8s-monitor resources
make k8s-logs-dev     # tail dev logs
make skaffold-dev     # skaffold dev --profile=dev --port-forward
```

---

## CI/CD

### CI (`ci.yml`) — triggers on push/PR to `main` or `develop`

1. **Frontend**: `npm install` → lint → `tsc --noEmit` → `npm run build`
2. **Backend**: Python 3.11, `pip install -r requirements.txt` + `pytest pytest-asyncio httpx` → `pytest -v`
   - Requires: PostgreSQL 15 + Redis 7 service containers

### CD (`cd.yml`) — triggers on push to `main` or `workflow_dispatch`

1. Build + push Docker images to GHCR (`ghcr.io/<owner>/backend:<sha>`, `ghcr.io/<owner>/frontend:<sha>`)
2. `kustomize edit set image` to pin SHA tags
3. `kustomize build | kubectl apply -f -`
4. `kubectl rollout status` for backend, frontend, celery-worker

Required GitHub secrets: `KUBECONFIG_DEV`, `KUBECONFIG_PROD`

---

## 버전 관리 / CHANGELOG (필수 — 기능·패치 추가 시마다)

**기능 추가(`feat:`)나 패치(`fix:`)를 담은 PR 은 `CHANGELOG.md` 의 `## [Unreleased]` 섹션에
항목을 추가해야 한다.** PR 본문만 쓰고 CHANGELOG 갱신을 빠뜨리지 않는다 — 릴리스 버전 섹션과
사이드바 "릴리즈 노트" 패널 모두 이 섹션에서 파생된다.

- 위치: `CHANGELOG.md` 최상단 `## [Unreleased]` 아래, 변경 성격에 따라 `### Added` /
  `### Fixed` / `### Changed` 하위에 한두 줄로 추가 (기존 항목 형식 참고 — 굵게 기능명,
  이어서 사용자 관점 요약, 필요 시 `Backend:`/`Frontend:` 로 구현 포인트 짧게).
- 버전/브랜치/태그 전체 전략은 `docs/branch-tag-strategy.md` 참고. SemVer(`vMAJOR.MINOR.PATCH`),
  버전 소스는 `frontend/package.json` `version` + `backend/app/main.py` FastAPI `version`.
- **릴리스 자동화**: `feat:`/`fix:` 등 conventional commit prefix PR 이 `main` 에 머지되면
  `.github/workflows/auto-release.yml` 이 SemVer 버전을 자동으로 올리고(`feat:`→MINOR, 그
  외→PATCH) `CHANGELOG.md` 의 `[Unreleased]` 를 새 버전 섹션으로 확정한 뒤 `vX.Y.Z` 태그를
  push 한다(→ `release.yml` 이 GHCR 이미지 태깅 + GitHub Release 생성). 버전 3곳 수정과
  CHANGELOG 섹션 확정은 `scripts/release/bump_version.py` 로 자동화돼 있다. 수동 `/release`
  스킬은 hotfix 나 자동화 실패 시의 fallback 이다 — 평소엔 실행할 필요 없음.

### 사이드바 "릴리즈 노트" 패널

사이드바 하단 레일의 "릴리즈 노트" 아이콘(감사 로그가 Settings 탭으로 이동한 자리)을 클릭하면
우측 SidePane(`ReleaseNotesPanel`)에 버전별 변경 이력이 테이블(버전/날짜/요약)로 표시되고, 행을
클릭하면 섹션별(Added/Fixed/Changed 등) 상세가 펼쳐진다. Backend `GET /api/v1/release-notes`
(`release_notes` 라우터)가 `CHANGELOG.md` 를 이미지 안에서 직접 파싱해 응답하므로 **별도로
동기화해야 하는 사본 파일이 없다** — `CHANGELOG.md` 만 정확히 갱신하면 자동으로 반영된다
(`[Unreleased]` 섹션은 이 API 응답에서 제외).

---

## 문서 동기화 규칙 (필수 — 모든 기능 변경 시)

**코드가 바뀌면 문서도 같은 PR 에서 바뀐다.** CI 의 `docs-sync` job 이
`scripts/docs/check_docs_sync.py` 로 기계 검사를 하며, 어긋나면 PR 이 실패한다.
절차 상세와 "변경 유형 → 갱신 문서" 매핑표는 **`.claude/skills/docs-sync/SKILL.md`** 참고.

핵심 매핑 (요약):

| 코드 변경 | 갱신할 문서 |
|---|---|
| 새 페이지 / App.tsx 라우트 | `docs/SCREENS.md` (헤딩에 `` `/route` `` 포함), `CODE_MAP.md` |
| 새 라우터 / 모델 | `CODE_MAP.md` (+ 주요 그룹이면 CLAUDE.md API/DB 인덱스) |
| `config.py` 환경변수 | CLAUDE.md 환경변수 표, `.env.example` |
| `feat:` / `fix:` | `CHANGELOG.md` `[Unreleased]` (+ 사용자 노출 기능이면 README 핵심 기능표) |
| `docs/` 새 문서 | `docs/README.md` 인덱스 |
| 새 스킬 | `.claude/skills/README.md` |

- 로컬 선검사: `python3 scripts/docs/check_docs_sync.py`
- 의도된 예외(redirect alias 등)는 검사 스크립트의 `EXEMPT_*` 목록에 **사유 주석과 함께** 등록.
- feat/fix PR 이 앱 코드를 바꾸면서 CHANGELOG/문서를 하나도 안 건드리면 CI 가 실패한다
  (예외는 PR 제목에 `[skip-docs]`).

---

## Key Conventions

### Python

- Pydantic v2 (`model_dump()`, not `.dict()`).
- Async route handlers where I/O is involved; sync for DB-only operations via `Depends(get_db)`.
- Services are singletons instantiated at module level (e.g., `agent_service = AIAgentService()`).
- All external service calls must be fail-safe (catch all exceptions, return structured error dict).
- Use `subprocess.run(..., capture_output=True, text=True, timeout=30)` for kubectl calls.

### TypeScript / React

- Strict TypeScript — no `any` without an `eslint-disable` comment.
- All API response types defined in `src/types/index.ts`.
- Server state via TanStack Query hooks in `src/hooks/`.
- Client/UI state via Zustand stores in `src/stores/`.
- New UI components go in `src/components/<feature>/` with a barrel `index.ts`.

### Git

- Commit message convention: `feat: ...`, `fix: ...`, `refactor: ...`, `docs: ...`, `chore: ...`
- Feature branches: `feature/<short-description>`
- PRs target `main`

### Pull Request Description (Required)

**Every PR must include a description that summarises the actual changes** — never open a PR with an empty body. The PR body must contain at minimum:

1. **## Summary** — 1~5 bullets describing *what changed and why*, written from the user-visible / reviewer perspective. Reference the file/area touched (e.g., "PlaybooksPage: 사이드바로 클러스터 선택 통일") rather than the implementation tactic.
2. **## Changes** — bullet list of concrete edits grouped by area (frontend / backend / docs / infra). One bullet per logical change. Include new files, removed files, renamed exports.
3. **## Test plan** — markdown checklist of how a reviewer can verify the change locally (commands to run, UI flows to click). Mark anything skipped explicitly (e.g., "- [ ] ESLint — preexisting v9 config breakage, skipped").
4. **(optional) ## Screenshots / Notes** — when UI changed or there are caveats worth flagging (preexisting issues, follow-ups, migrations).

Always pass the body via a heredoc (`gh pr create --body "$(cat <<'EOF' … EOF)"` or the MCP equivalent) to keep markdown formatting intact. The body is what reviewers see first — treat it as the primary deliverable of the PR alongside the diff. If the user did not explicitly ask for a PR, do not create one — but when they do, the description above is mandatory.

### Adding a New Health Checker

1. Create `backend/app/services/checkers/my_checker.py` extending `base.BaseChecker`.
2. Call it from `DailyChecker.run_daily_check()` in `daily_checker.py`.
3. Add the result field to `DailyCheckLog` model and `_run_migrations()` if a new column is needed.
4. Expose the result in the daily-check router response schema.

### Adding a New Metric Card Category

Categories are free-form strings stored in `metric_cards.category`. Current values: `alert`, `resource`, `storage`, `network`. Add new ones as needed — they drive filtering in `GET /api/v1/promql/cards?category=<name>`.

---

## Troubleshooting

### Backend won't start — DB connection refused

Ensure PostgreSQL is running. With Docker Compose: `docker-compose up -d postgres`.

### Celery tasks not running

Check Redis: `redis-cli ping`. Check Beat is running: `celery -A app.celery_app beat --loglevel=info`.

### kubectl checks failing in Docker Compose

The backend container does not have `kubectl` or a kubeconfig by default in the Compose setup. K8s health checks work when deployed inside the cluster with the service account (`k8s/base/backend/serviceaccount.yaml`) or when a kubeconfig volume is mounted.

### Ollama model not available

```bash
# Trigger pull via API
curl -X POST http://localhost:8000/api/v1/agent/pull-model \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3"}'
```

### DB schema out of date

Add a column check to `_run_migrations()` in `backend/app/main.py` and restart the backend. The migration runs automatically on startup.

### PromQL cards show "offline"

Prometheus must be reachable at `PROMETHEUS_URL`. In local dev, Prometheus is not included in `docker-compose.yml` — set `PROMETHEUS_URL` to a reachable instance or deploy the full stack on K8s.
