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
특정 화면을 수정하기 전에 먼저 해당 화면 섹션을 확인해 현재 구조(사용 hook/컴포넌트/API
엔드포인트)를 파악하고 시작할 것. 화면 구조가 크게 바뀌면 해당 섹션도 함께 갱신해준다.

**⚠️ 읽는 방법 — 통째로 Read 하지 말 것.** 이 문서는 130KB(≈60k 토큰)라 전체를 읽으면 컨텍스트의
1/3 이 한 번에 소모된다. 화면 섹션은 라우트가 백틱으로 박힌 `### 제목 (`/route`)` 헤딩으로
구분돼 있고 각 20줄 내외이므로, **`grep -n '/route' docs/SCREENS.md` 로 줄번호를 찾아
`offset`/`limit` 으로 해당 섹션만 읽는다.**

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

**기능 → 파일 매핑은 `CODE_MAP.md` 가 원천이다** (라우터·페이지 전수 나열 + 자주 하는 작업
Recipes). 아래는 디렉터리 골격만 — 파일을 찾는 중이라면 여기가 아니라 `CODE_MAP.md` 를 본다.

```
devops_management/
├── backend/app/
│   ├── main.py          # FastAPI app, lifespan, CORS, _run_migrations, 라우터 마운트
│   ├── config.py        # pydantic-settings Settings (전체 변수 → docs/ENVIRONMENT.md)
│   ├── database.py      # SQLAlchemy engine + SessionLocal + Base
│   ├── celery_app.py    # Celery app + Beat 스케줄 + 태스크 (§Celery Tasks)
│   ├── models/          # SQLAlchemy ORM — 도메인 그룹은 §Database Schema
│   ├── routers/         # APIRouter — 전부 /api/v1 마운트, 그룹 인덱스는 §API Reference
│   ├── schemas/         # Pydantic 스키마
│   └── services/        # 서비스 모듈 + 하위 패키지:
│       #  checkers/(일일점검 컴포넌트)  deep_checkers/(심층 점검)  lake_checkers/(LAKE 프로브)
│       #  bottleneck_probes/  analyzers/(claude|local_llm|rule_based)  batch_jobs/  trends/
├── backend/tests/       # pytest (pytest.ini: testpaths=tests, asyncio_mode=auto)
├── frontend/src/
│   ├── App.tsx          # React Router — `/` = HomePage, 구 대시보드는 /cluster-overview,
│   │                    #   레거시 경로 redirect, RequireAdmin·RequireFeature 가드
│   ├── services/api.ts  # axios 기반 API 레이어 — 모든 백엔드 호출의 단일 창구
│   ├── types/index.ts   # 공용 TypeScript 인터페이스
│   ├── stores/          # Zustand (client state)      hooks/  # TanStack Query (server state)
│   ├── pages/           # 화면별 명세는 docs/SCREENS.md
│   └── components/      # common/(ClusterSidebar) ui/(MacCard, shadcn)
│                        #   layout/(Sidebar, navConfig.ts) + 도메인 폴더
├── k8s/                 # Kustomize base + overlays(dev/prod/kind/airgap) + superpod/(CronJob)
├── helm/k8s-daily-monitor/   # values / -dev / -prod / -airgap
├── scripts/             # kind-setup.sh, deploy-airgap.sh, init-cluster.sh,
│                        #   release/bump_version.py, docs/check_docs_sync.py
├── ansible/playbooks/  argocd/  docker/ vagrant/ windows-docker/
├── docs/                # 인덱스는 docs/README.md (01-plan/ 02-design/ 03-analysis/
│                        #   archive/ superpowers/ 하위 폴더 포함)
├── docker-compose.yml  skaffold.yaml  Makefile  Jenkinsfile
├── CODE_MAP.md          # 기능 → 파일 지도 (여기부터 볼 것)
├── DESIGN_SYSTEM.md     # UI 규격·구현 표준 원천 (§12 구현 표준)
├── DESIGN.md            # UX/UI 운영 — 백로그·로드맵·점검 이력 (ux-ui-designer 가 관리)
└── .env.example         # backend 환경변수 템플릿 (전체 목록은 docs/ENVIRONMENT.md)
```

> 파일 개수(라우터/모델/페이지 N개)는 커밋마다 바뀌므로 이 문서에 적지 않는다. 필요하면
> `ls backend/app/routers/*.py | wc -l` 처럼 직접 센다.

---

## Development & Tests

| 목적 | 명령 | 접속 |
|---|---|---|
| **전체 스택 (권장)** | `docker-compose up -d` / `down` | FE `:5173` · API `:8000/docs` |
| 네이티브 | `make install` → `make dev` | 동일 |
| 백엔드만 | `cd backend && uvicorn app.main:app --reload --port 8000` | |
| 프론트만 | `cd frontend && npm run dev` | |
| kind 로컬 K8s | `bash scripts/kind-setup.sh up｜reload｜destroy` | FE `:30080` · API `:30800/docs` |
| K8s 핫리로드 | `make skaffold-dev` | |

그 외 타깃은 `make help`. Compose 는 postgres+redis+backend+frontend+celery(worker/beat)
+kubewatch+grafana-renderer 를 띄운다.

**머지 전 게이트 (CI 와 동일 — 전부 통과해야 함):**

```bash
cd frontend && npm run lint && npx tsc --noEmit && npm run build   # lint 는 --max-warnings 0
cd backend  && pytest -v                                           # 실행 중인 PostgreSQL 필요
python3 scripts/docs/check_docs_sync.py                            # 문서 동기화 검사
```

- 로컬 DB 를 따로 쓰려면 `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/k8s_monitor_test pytest -v`.
- 프론트엔드 단위 테스트(Jest/Vitest)는 없다 — CI 는 lint + type-check + build 로만 검증한다.

---

## Environment Variables

로컬 개발은 `.env.example` → `backend/.env` 로 복사. pydantic-settings 가 자동 로드하며 변수명은
대소문자를 구분하지 않는다.

**전체 목록·기본값·설명은 `docs/ENVIRONMENT.md`, 코드상 원천은 `backend/app/config.py` 의
`Settings` 클래스다.** 자주 건드리는 것만 추리면:

| Variable | Default | Note |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/k8s_monitor` | |
| `SECRET_KEY` | *(운영에서 반드시 교체)* | JWT 서명키 |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | `10` / `20` | replica 합계 × (pool+overflow) ≤ Postgres `max_connections` 이 되게 배포별 오버라이드 |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://ollama:11434` / `llama3` | 폐쇄망 overlay 는 `qwen2.5-coder:7b` |
| `PROMETHEUS_URL` | `http://prometheus-k8s.monitoring.svc:9090` | 미도달 시 카드가 offline 표시 |
| `KUBEWATCH_TOKEN` · `SUPERPOD_INGEST_TOKEN` | *(empty)* | **fail-closed** — 미설정 시 웹훅 수신을 503 으로 거부 |
| `SUPERPOD_MODE` | `centralized` | `in_cluster` \| `centralized` — deep check 실행 모드 |

⚠️ `ANALYZER_BACKEND`(`services/analyzers/factory.py`) 와 `ALLOWED_ORIGINS`(`main.py`) 는
`Settings` 가 아니라 `os.getenv` 로 직접 읽는다 — `config.py` 에서 찾으면 안 나온다.

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
`celery_app.py` 의 `beat_schedule` 엔트리 (전수 — 추가 시 여기도 갱신):

| Beat 엔트리 | 주기 | 역할 |
|---|---|---|
| `check-matrix-dispatch` | 매분 | 각 클러스터의 `check_cron_expr`(core 번들) + `CheckMatrixSchedule` cron 평가 → due 점검 실행 |
| `check-matrix-log-purge` | 03:00 | 점검 결과 로그 정리 |
| `deep-check-results-purge` | 03:10 | 심층 점검 결과 보존기간 초과분 정리 |
| `log-tables-purge` | 03:20 | 대용량 로그성 테이블 정리 |
| `daily-trend-collect` | 07:00 | 기술 트렌드(GitHub/RSS) 수집 |
| `resource-count-snapshot-dispatcher` | 매분 | 리소스 카운트 스냅샷 디스패치 |
| `batch-job-dispatcher` | 매분 | 등록된 배치잡 cron 평가·실행 |
| `cluster-item-dispatcher` | 매시 :00 | 클러스터 아이템 점검 |
| `arch-doc-sync-dispatcher` | 매분 | 서비스 아키텍처 문서 현행화 (AppSetting cron 평가 → `sync_all_architecture_docs`) |

태스크 성격별로 디스패처류(`run_check_matrix_dispatch`, `run_batch_job_dispatcher`,
`dispatch_resource_count_snapshot`, `run_cluster_item_dispatcher`,
`dispatch_architecture_doc_sync`), 수집류(`collect_resource_counts`, `run_trend_collect`,
`sync_all_architecture_docs`), 실행류(`run_single_check`, `run_batch_job`, `run_ops_check_batch`),
AI/임베딩(`run_review_and_notify`, `compute_work_item_embedding`, `compute_work_guide_embedding`,
`generate_arch_doc_llm`), 정리류(purge)가 있다 — 전수는 `celery_app.py` 의 `@celery_app.task`.
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

테마 3종(`default` 기본 / `light` / `dark` + `system`) + 토큰 기반 시스템이다.

- **규격·구현 표준의 원천 = `DESIGN_SYSTEM.md` §12 구현 표준** — 테마 매트릭스, radius 토큰,
  MacCard props, ClusterSidebar 사용 패턴 3종 + 레이아웃 규칙, 콘솔 패턴 5개 항목이 전부 거기 있다.
- 토큰 **실측값** 은 `frontend/src/index.css` (테마별 상이), 운영(감사·백로그)은 `DESIGN.md`.

아래는 **위반 시 리뷰 반려되는 불변 규칙**이다. props·예시 코드·세부 레이아웃이 필요하면
`DESIGN_SYSTEM.md` §12 를 읽는다.

- **토큰만 쓴다.** JSX 내 raw hex 금지, 고정 팔레트(`text-white`, `bg-gray-*`) 금지 —
  `text-foreground` / `text-muted-foreground` / `bg-card` / `bg-secondary` 등 테마 토큰을 쓴다.
  차트·캔버스는 `--chart-*` 우선. 색과 라운딩은 테마마다 값이 달라지므로 고정값이 곧 버그다.
- **카드는 `MacCard`(flat).** 페이지에서 `bg-card border` div 를 직접 조합하지 않는다
  (DESIGN.md D-004). 카드 제목을 본문 `<h2>` 로 중복하지 않는다.
- **라운딩**: 카드 `rounded-md`(토큰) · 버튼/입력 `rounded-xl`. sharp corner 금지.
  `rounded-lg|md|sm` 은 theme-aware, `rounded-xl|2xl` 은 고정값.
- **per-cluster 페이지는 `ClusterSidebar` `iconOnly` 필수.** 페이지 내 `<select>` 클러스터
  선택기 금지, `seq` 노출 금지, `onReorder` 금지. 보조 사이드바는 메인 사이드바에 flush
  (좌측 공백 0) — 행 전체에 좌측 패딩이나 `mx-auto` 를 주지 않는다.
- **SSH/exec 콘솔은 콘솔 패턴 필수.** 좌(컨트롤)/우(결과) 한 로우, stdout/stderr 는
  `ExecOutputTabs`, 로그는 `LogViewer`(plain `<pre>` 금지), 최상단에서 `useTerminalEnvSync` 호출.
  적용 화면: `/bulk-exec` `/mc-client` `/etcdctl` `/cilium-trace` `/kernel-params` (+ 신규 콘솔 전부).
- **접근성**: 아이콘 전용 버튼은 `title` + `aria-label` 병행.
- **Tailwind 만.** 인라인 스타일·CSS modules·styled-components 금지.

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

**Base URL**: `http://localhost:8000/api/v1` (local) · `http://<node>:30800/api/v1` (K8s NodePort)

**엔드포인트 시그니처의 원천은 `/docs`(Swagger)다** — 개별 경로·파라미터를 알아야 하면 거기서
확인하거나 해당 라우터 파일을 읽는다. 마운트 목록은 `backend/app/routers/__init__.py`.

대부분의 라우터는 JWT 인증(`_auth` dependency)이 걸려 있고, **비인증 마운트 예외는
`auth`, `health`, `deep_check_ingest`, `k8s_exec`, `k9s_ssh`, `k8s_events_ingest`** 다
(`k8s_exec`/`k9s_ssh` 는 WebSocket 이라 핸들러가 query token 을 직접 검증).
앱 헬스 프로브만 `/api/v1` 접두사가 없다 — `GET /health` · `/health/live` · `/health/ready`(DB 확인).

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

위 6개는 원조 모니터링 코어다. 이외 모델은 도메인별로 아래처럼 묶인다 — 전수와 컬럼 정의는
`backend/app/models/__init__.py` 와 각 모델 파일을 본다:

- **점검/이벤트**: `check_matrix`(Item/Schedule/Result/ResultLog/**Run**=수행 로그), `deep_check`, `ops_check`, `check_log`, `k8s_event`, `resource_count`, `config_snapshot`, `os_param_change`
- **업무 관리**: `work_item`(+`work_item_comment`/`work_item_time_block`/`work_item_custom_field`), `sprint`, `project`, `workflow` — `work_items.embedding` 은 pgvector
- **지식**: `ontology`, `mindmap`, `work_guide`(pgvector `embedding`), `ops_note`, `voc_post`, `command_entry`, `reaction`, `trend`
- **인프라/서비스**: `infra_node`, `node_server_spec`, `management_server`, `isilon_server`, `service_entry`, `service_category`, `service_topology`, `topology_audit_log`, `lake_service`, `lake_service_type`, `cluster_item`, `cluster_custom_field`
- **플랫폼/자동화**: `batch_job`, `bottleneck_run`, `ansible_assets`
- **사용자/설정**: `user`, `user_setting`, `user_jira_credential`, `user_notification`, `app_setting`, `audit_log`, `island`(Your Island 커스텀 화면)

---

## Deployment

**전체 절차는 `docs/DEPLOY_GUIDE.md`.** 3단계 요약:

| Phase | 대상 | 진입 명령 | 설정 |
|---|---|---|---|
| 1 | 로컬 kind | `bash scripts/kind-setup.sh up｜reload｜destroy` | `k8s/overlays/kind/` |
| 2 | 폐쇄망(air-gap) | `bash scripts/deploy-airgap.sh all` (registry·CLI·인증정보 대화형 입력) | `values-airgap.yaml` · `k8s/overlays/airgap/` |
| 3 | 프로덕션 | `helm install k8s-monitor ./helm/k8s-daily-monitor -f .../values-prod.yaml -n k8s-monitor --create-namespace` | `values-prod.yaml` · Jenkins + ArgoCD |

네임스페이스: dev = `k8s-monitor-dev`, prod = `k8s-monitor-prod`.
Makefile 타깃(`make k8s-dev`, `make docker-rebuild` 등)은 `make help` 로 확인한다.

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
| `config.py` 환경변수 | `docs/ENVIRONMENT.md`, `.env.example` |
| Celery Beat 스케줄 | CLAUDE.md §Celery Tasks 표 (전수 기재 — CI 가 개수 검증) |
| UI 구현 표준(컴포넌트·레이아웃) | `DESIGN_SYSTEM.md` §12 (CLAUDE.md 는 불변 규칙 요약만) |
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

### Git / PR

브랜치·커밋·PR 규칙의 원천은 **`CONTRIBUTING.md`** (+ 상세 전략 `docs/branch-tag-strategy.md`).
요약: `main` 은 직접 push 금지(PR 로만 병합), 작업 브랜치는 `feat/` `fix/` `docs/` `refactor/`
`chore/` `hotfix/`, 커밋은 Conventional Commits — 이 prefix 가 SemVer·CHANGELOG 의 근거다.

PR 본문은 `.github/PULL_REQUEST_TEMPLATE.md` 의 **Summary / Changes / Test plan** 을 반드시
채운다(빈 본문 금지). 사용자가 PR 을 명시적으로 요청하지 않았으면 만들지 않는다.

### 자주 하는 작업 (Recipes)

새 엔드포인트/페이지/컬럼/체커 추가 절차는 **`CODE_MAP.md` §Recipes** 가 원천이고, 더 긴
플레이북은 `.claude/skills/` 에 있다(`backend-feature`, `frontend-page`, `add-deep-checker`,
`editor-docs`, `release`, `docs-sync`). 여기서 절차를 재서술하지 않는다.

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
