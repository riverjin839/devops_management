# CLAUDE.md — DEVOPS MANAGEMENT

This file provides essential context for AI assistants (Claude and others) working on this codebase.

---

## Project Overview

**DEVOPS MANAGEMENT** (originally "K8s Daily Monitor") is a DevOps-focused Kubernetes cluster health monitoring dashboard. It performs automated daily health checks at 09:00, 13:00, and 18:00 KST across multiple clusters and surfaces results in a React dashboard.

Core capabilities:
- Multi-cluster management (add, remove, check any Kubernetes cluster)
- Scheduled health checks via Celery Beat (API server, components, nodes, system pods)
- Real-time PromQL metric cards queried against Prometheus
- AI Agent chat powered by a local Ollama LLM (optional, fail-safe)
- Ansible Playbook execution per cluster
- Air-gapped / closed-network deployment support

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
| Scheduler | Celery Beat (crontab: 09:00 / 13:00 / 18:00 KST) |
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
| Styling | Tailwind CSS 3 + shadcn/ui (Radix primitives) |
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

```
k8s_daily_monitor/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app, lifespan, CORS, router registration
│   │   ├── config.py            # pydantic-settings Settings class
│   │   ├── database.py          # SQLAlchemy engine + SessionLocal + Base
│   │   ├── celery_app.py        # Celery app + Beat schedule (3x/day)
│   │   ├── models/              # SQLAlchemy ORM models
│   │   │   ├── cluster.py       # Cluster, StatusEnum
│   │   │   ├── daily_check.py   # DailyCheckLog, CheckSchedule, CheckScheduleType
│   │   │   ├── addon.py         # Addon (per-cluster add-ons e.g. Nexus, Keycloak)
│   │   │   ├── check_log.py     # CheckLog
│   │   │   ├── metric_card.py   # MetricCard (PromQL dashboard builder)
│   │   │   └── playbook.py      # Playbook (Ansible)
│   │   ├── routers/             # FastAPI APIRouter modules
│   │   │   ├── clusters.py      # /api/v1/clusters
│   │   │   ├── daily_check.py   # /api/v1/daily-check
│   │   │   ├── health.py        # /api/v1/health (per-cluster)
│   │   │   ├── history.py       # /api/v1/history
│   │   │   ├── playbooks.py     # /api/v1/playbooks
│   │   │   ├── agent.py         # /api/v1/agent (Ollama AI)
│   │   │   └── promql.py        # /api/v1/promql (PromQL cards + queries)
│   │   └── services/
│   │       ├── daily_checker.py          # DailyChecker: orchestrates health checks
│   │       ├── health_checker.py         # Addon/cluster health checks
│   │       ├── agent_service.py          # AIAgentService (Ollama wrapper)
│   │       ├── prometheus_service.py     # PrometheusService (PromQL queries)
│   │       ├── playbook_executor.py      # Ansible playbook execution
│   │       └── checkers/                # Modular checkers (one per component)
│   │           ├── base.py
│   │           ├── argocd_checker.py
│   │           ├── control_plane_checker.py
│   │           ├── etcd_checker.py
│   │           ├── jenkins_checker.py
│   │           ├── keycloak_checker.py
│   │           ├── nexus_checker.py
│   │           ├── node_checker.py
│   │           └── system_pod_checker.py
│   ├── tests/
│   │   └── test_api.py          # pytest tests for root / health endpoints
│   ├── requirements.txt
│   ├── pytest.ini               # testpaths=tests, asyncio_mode=auto
│   └── Dockerfile
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx              # React Router setup (Dashboard + PlaybooksPage)
│   │   ├── main.tsx             # Entry point
│   │   ├── types/index.ts       # All shared TypeScript interfaces
│   │   ├── services/api.ts      # axios-based API service layer
│   │   ├── stores/
│   │   │   ├── clusterStore.ts  # Zustand: cluster selection state
│   │   │   └── playbookStore.ts # Zustand: playbook state
│   │   ├── hooks/
│   │   │   ├── useCluster.ts    # TanStack Query: clusters data
│   │   │   ├── useMetricCards.ts# TanStack Query: PromQL cards
│   │   │   └── usePlaybook.ts   # TanStack Query: playbooks
│   │   ├── pages/
│   │   │   ├── Dashboard.tsx    # Main monitoring dashboard
│   │   │   └── PlaybooksPage.tsx
│   │   ├── components/
│   │   │   ├── dashboard/       # ClusterTabs, MetricCard, AddonCard, StatusBadge…
│   │   │   ├── agent/           # AgentChat (Ollama AI sidebar)
│   │   │   ├── playbooks/       # PlaybookCard, AddPlaybookModal
│   │   │   └── layout/          # Header
│   │   └── config/
│   │       └── addons.config.ts # Static list of supported addon types
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   └── Dockerfile               # nginx-based production image
│
├── k8s/
│   ├── base/                    # Base Kustomize resources
│   │   ├── backend/, frontend/, postgres/, redis/, celery/
│   │   ├── ollama.yaml          # Optional Ollama deployment
│   │   └── kustomization.yaml
│   └── overlays/
│       ├── dev/                 # Namespace: k8s-monitor-dev
│       ├── prod/                # Namespace: k8s-monitor-prod
│       ├── kind/                # Local kind cluster
│       └── airgap/              # Closed-network (registry mirror)
│
├── helm/k8s-daily-monitor/      # Helm chart for production
│   ├── values.yaml              # Defaults
│   ├── values-dev.yaml
│   ├── values-prod.yaml
│   └── values-airgap.yaml
│
├── scripts/
│   ├── kind-setup.sh            # up / reload / destroy for local kind
│   ├── deploy-airgap.sh         # Interactive airgap deployment
│   └── init-cluster.sh          # Register initial cluster via API
│
├── ansible/playbooks/           # Ansible playbooks run by backend
├── argocd/                      # ArgoCD Application + Project manifests
├── docs/
│   ├── DEPLOY_GUIDE.md          # 3-phase deployment guide
│   └── PROJECT_PLAN.md
├── docker-compose.yml           # Local development (postgres + redis + backend + frontend + celery)
├── skaffold.yaml                # Skaffold dev config
├── Makefile                     # Convenience targets (see below)
├── Jenkinsfile                  # Jenkins pipeline for phase-3 production
└── .env.example                 # Template for backend environment variables
```

---

## Development Workflows

### Local Development (Docker Compose) — Recommended for most changes

```bash
# Start all services (postgres, redis, backend, frontend, celery worker + beat)
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

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/k8s_monitor` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection |
| `CELERY_BROKER_URL` | `redis://localhost:6379/0` | Celery broker |
| `CELERY_RESULT_BACKEND` | `redis://localhost:6379/0` | Celery result store |
| `SECRET_KEY` | *(change in production)* | JWT signing key |
| `DEBUG` | `false` | FastAPI debug mode |
| `CHECK_INTERVAL_MINUTES` | `5` | Health check interval |
| `CHECK_TIMEOUT_SECONDS` | `30` | kubectl/HTTP timeout |
| `OLLAMA_URL` | `http://ollama:11434` | Ollama base URL |
| `OLLAMA_MODEL` | `llama3` | LLM model name |
| `OLLAMA_TIMEOUT` | `120` | LLM request timeout (s) |
| `PROMETHEUS_URL` | `http://prometheus-k8s.monitoring.svc:9090` | Prometheus endpoint |
| `GRAFANA_URL` | `http://grafana.monitoring.svc:3000` | Grafana endpoint |
| `ALLOWED_ORIGINS` | *(empty)* | Comma-separated extra CORS origins |

The `Settings` class (`backend/app/config.py`) uses pydantic-settings and reads from `.env` automatically. All variable names are case-insensitive.

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

`celery_app.py` defines two tasks:
- `run_scheduled_check(schedule_type)` — called by Beat 3× per day; iterates all clusters.
- `run_single_check(cluster_id)` — triggered manually from the API.

Both bridge async `DailyChecker` methods using `asyncio.new_event_loop()` + `loop.run_until_complete()`.

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

### PromQL Metric Cards

- Stored in `metric_cards` PostgreSQL table.
- Seeded with 6 defaults on first run (CrashLoopBackOff pods, Failed pods, CPU/Memory usage, PVC disk, network).
- `display_type`: `value` | `gauge` | `list`.
- `thresholds`: string format `"warning:70,critical:90"`.
- Query execution: `GET /api/v1/promql/query/{card_id}` or `GET /api/v1/promql/query/all`.

---

## UI Design System

The frontend uses a **macOS-inspired light theme** (reference: weather-theme.vercel.app screenshot).

### Core Visual Identity

| Token | Value | Usage |
|---|---|---|
| `--background` | `hsl(0 0% 87%)` — `#DEDEDE` | Page background (medium gray) |
| `--card` | `hsl(0 0% 97%)` — `#F7F7F7` | Card surface (near white) |
| `--border` | `hsl(0 0% 80%)` — `#CCCCCC` | Subtle card borders |
| `--primary` | `hsl(211 100% 44%)` — `#0071E3` | macOS blue accent |
| `--muted-foreground` | `hsl(0 0% 42%)` — `#6B6B6B` | Secondary text |
| `--radius` | `0.875rem` (14 px) | Base border radius |
| `--card-shadow` | `0 2px 14px rgba(0,0,0,0.07)` | Subtle elevation |

### MacCard Component (`frontend/src/components/ui/MacCard.tsx`)

Every major UI section is wrapped in a `MacCard`. The pattern:

```
┌──────────────────────────────────────────┐
│  ● ● ●        SECTION TITLE              │  ← header: traffic lights + centered title
├──────────────────────────────────────────┤  ← 1 px divider
│                                          │
│   {children}                             │  ← body: p-5 default padding
│                                          │
└──────────────────────────────────────────┘
```

Traffic-light colors (CSS vars available anywhere):
- `--mac-red`    `#FF5F57`
- `--mac-yellow` `#FEBC2E`
- `--mac-green`  `#28C840`

**Usage:**
```tsx
import { MacCard } from '@/components/ui/MacCard';

<MacCard title="Cluster Status">
  {/* content */}
</MacCard>
```

Props: `title?`, `children`, `className?` (body extra classes), `rootClassName?`, `bodyPadding?` (default `"p-5"`).

### Theme System

Default theme: **light** (macOS palette). Dark mode available via sidebar toggle.

`themeStore.ts` applies `.light` / `.dark` class to `<html>`:
- `:root` (no class) → light macOS palette
- `html.light`       → same light palette (explicit class)
- `html.dark`        → standard dark palette

**Changing default:** `localStorage.getItem('k8s:theme')` — falls back to `'light'` if unset.

### Dashboard Layout Conventions

```
min-h-screen bg-background
  sticky top-bar (backdrop-blur)
  main (max-w-[1600px] space-y-5)
    grid 4-col SummaryStats  ← individual MacCards (no outer title)
    MacCard "Cluster Status"
    MacCard "Prometheus Insights"
    MacCard "Playbook Checks"   (conditional)
    MacCard "작업 / 이슈 현황"
    MacCard "Recent Check History"  (bodyPadding="p-0")
```

### Component Conventions (updated)

- **Rounded corners**: always `rounded-2xl` for cards, `rounded-xl` for buttons/inputs.
- **Shadows**: use `.mac-shadow` utility class (maps to `--card-shadow`).
- **Buttons**: `rounded-xl`, never sharp corners.
- **Section titles inside MacCard**: content should NOT repeat the card title as an `<h2>` — the MacCard header already carries it.
- **Colors**: avoid raw hex in JSX; prefer Tailwind tokens (`text-primary`, `bg-secondary`, etc.) or `hsl(var(--*))`.

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
- 부모는 `flex gap-3` (또는 `gap-4`) 가로 레이아웃을 잡고, 사이드바 옆에 `<div className="flex-1 min-w-0">` 으로 본문을 감싼다.
- 사이드바는 `sticky top-4` 로 고정되어 스크롤해도 따라온다.
- `MacCard` 등 본문 wrapper 와 같은 row 에 둔다.

**금지:**
- ❌ 와이드 폼 (`iconOnly` 없이 사용) — 신규 페이지에서 절대 사용 금지. 기존 페이지도 모두 iconOnly 로 마이그레이션됨.
- ❌ `seq` 번호를 별도로 표시하는 어떤 UI 도 금지 (레거시 동작).
- ❌ 페이지 내 dropdown 형태 클러스터 선택기 (`<select>`) — 대신 좌측 사이드바를 쓴다.
- ❌ `onReorder` prop — iconOnly 에서는 정렬 토글이 노출되지 않으므로 사용 금지. 클러스터 정렬은 `/cluster-manage` 페이지에서만 한다.

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

- Components are grouped by feature under `src/components/` (`dashboard/`, `agent/`, `playbooks/`, `layout/`).
- Each group has an `index.ts` barrel export.
- Use shadcn/ui (Radix) primitives for dialogs, tabs, dropdowns, toasts.
- Tailwind CSS only — no CSS modules or styled-components.
- Do not use inline styles.

### ESLint

`eslint . --max-warnings 0` — **zero warnings allowed**. CI will fail on any lint warning. Fix all lint issues before committing.

---

## API Reference

### Base URL
`http://localhost:8000/api/v1` (local) or `http://<node>:30800/api/v1` (K8s NodePort)

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
