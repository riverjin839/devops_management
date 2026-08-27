# 환경변수 레퍼런스 (Environment Variables)

`backend/app/config.py` 의 `Settings` 클래스가 **코드상 원천**이고, 이 문서는 그 전수 목록이다.
로컬 개발은 `.env.example` → `backend/.env` 로 복사해서 쓴다. pydantic-settings 가 `.env` 를
자동으로 읽으며 변수명은 대소문자를 구분하지 않는다.

> `config.py` 에 변수를 추가/변경하면 **이 문서와 `.env.example` 을 같은 PR 에서 갱신**한다
> (`.claude/skills/docs-sync/SKILL.md` 참고).

---

## Core / DB / Celery

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

## 인증 (Auth)

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | *(change in production)* | JWT signing key |
| `ALGORITHM` | `HS256` | JWT 알고리즘 |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `1440` (24h) | 토큰 만료 |
| `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` | `admin` / `admin` | 사용자 0명일 때 부트스트랩 관리자 |

## 점검 / K8s

| Variable | Default | Description |
|---|---|---|
| `CHECK_INTERVAL_MINUTES` | `5` | Health check interval |
| `CHECK_TIMEOUT_SECONDS` | `30` | kubectl/HTTP timeout |
| `LOG_STREAM_MAX_CONCURRENT` | `20` | Pod 로그/클러스터 이벤트 SSE(`analyze.py`) 프로세스당 동시 스트림 상한. kubernetes SDK 가 blocking 이라 스트림 하나가 anyio 스레드풀 슬롯을 스트림 수명 내내 점유한다 — 초과 요청은 429 |
| `LOG_STREAM_MAX_DURATION_SECONDS` | `1800` | `follow=True` pod 로그 스트림 최대 수명(초). 초과 시 정상 종료 메시지를 보내고 끊는다(프론트가 재연결) |
| `SYNC_THREADPOOL_SIZE` | `100` | sync 라우트(전체의 대다수)가 공유하는 anyio 스레드풀 총량. 기본값(40)은 kubectl subprocess·SSH·로그 스트림처럼 오래 걸리는 sync 요청 비중이 높은 이 앱에는 작아서 부팅 시 lifespan 에서 이 값으로 올린다 |
| `KUBECONFIG_STORE_DIR` | `/tmp/k8s-monitor/kubeconfigs` | content 방식 kubeconfig 저장 위치 |
| `KUBEWATCH_TOKEN` | *(empty)* | kubewatch 웹훅 Bearer 토큰. **fail-closed** — 미설정 시 웹훅 수신 자체를 503 으로 거부(deep_check ingest 의 `SUPERPOD_INGEST_TOKEN` 과 동일 정책) |
| `ALERT_INGEST_TOKEN` | *(empty)* | 인시던트 알람 수신(Alertmanager webhook · 사내 alert-forwarder) Bearer 토큰. **fail-closed** — 미설정 시 `POST /observability/alerts/ingest` 및 `/observability/snapshot/ingest` 를 503 으로 거부 |
| `MGMT_NAMESPACE` | `k8s-monitor` | 관리 네임스페이스 (K8sEvent 채널) |
| `SUPERPOD_MODE` | `centralized` | `in_cluster` \| `centralized` — deep check 실행 모드 |
| `SUPERPOD_INGEST_URL` / `SUPERPOD_INGEST_TOKEN` | *(empty)* | in-cluster CronJob 결과 push 대상. 토큰은 fail-closed |
| `SUPERPOD_CLUSTER_ID` | *(empty)* | in_cluster 모드에서 자기 클러스터 식별자 |

## AI / LLM / Embedding

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://ollama:11434` | Ollama base URL (bootstrap 기본 프로필 `local-ollama` 합성용) |
| `OLLAMA_MODEL` | `llama3` | LLM model name (airgap overlay 는 `qwen2.5-coder:7b`) |
| `OLLAMA_TIMEOUT` | `120` | LLM request timeout (s) |
| `LLM_API_BASE` | *(empty)* | 사내 OpenAI-호환 LLM 서비스 base URL. 설정 시 `internal-llm` 프로필이 bootstrap 합성됨 |
| `LLM_API_KEY` | *(empty)* | 사내 LLM API 키 — 프로필 `api_key_ref: "env:LLM_API_KEY"` 로만 참조 (AppSetting 저장 금지) |
| `LLM_MODEL` | *(empty)* | `internal-llm` 프로필 기본 모델명 |
| `LLM_TIMEOUT` | `120` | 사내 LLM request timeout (s) |
| `ANALYZER_BACKEND` | *(empty→`rule_based`)* | 장애 분석 백엔드 bootstrap 폴백 — **운영 설정은 Settings → AI/LLM 탭(AppSetting `llm_settings`)이 우선** |
| `EMBEDDING_MODEL` | `nomic-embed-text` | 임베딩 모델 (WorkItem/WorkGuide 유사 검색) |
| `EMBEDDING_DIM` | `768` | 임베딩 차원 — 모델 교체 시 함께 변경(기존 벡터 재계산 필요) |
| `EMBEDDING_TIMEOUT` | `30` | 임베딩 요청 timeout (s) |

> **LLM 운영 설정의 원천은 UI 다.** 프로필(사내 LLM/Ollama 병행)·용도별 라우팅·분석기 선택은
> AppSetting `llm_settings` (Settings → AI/LLM 탭) 에서 관리하고, 위 env 는 행이 없을 때의
> bootstrap 폴백이다. 구조는 `docs/AIRGAP_LLM_ARCHITECTURE.md` 참고.

## Prometheus / Grafana / Trends

| Variable | Default | Description |
|---|---|---|
| `PROMETHEUS_URL` | `http://prometheus-k8s.monitoring.svc:9090` | Prometheus endpoint |
| `ALERTMANAGER_URL` | `http://alertmanager-operated.monitoring.svc:9093` | Alertmanager endpoint (Observability 대시보드 전역 기본값 — 클러스터별 `clusters.alertmanager_url` 이 우선) |
| `GRAFANA_URL` | `http://grafana.monitoring.svc:3000` | Grafana endpoint |
| `GRAFANA_RENDERER_URL` | `http://grafana-renderer:8081` | 패널 이미지 렌더러 |
| `PROMETHEUS_NODE_LABEL` | `instance` | node-exporter 노드 식별 라벨 (배포 의존) |
| `TRENDS_MAX_NODES` | `30` | 추이 조회 최대 노드 수 |
| `TRENDS_GITHUB_API_URL` | `https://api.github.com` | 트렌드 수집 GitHub API (폐쇄망: 내부 GHE) |
| `TRENDS_GITHUB_TOKEN` | *(empty)* | optional — rate limit 향상 |
| `TRENDS_COLLECT_HOUR` | `7` | 매일 자동 수집 시각 (KST) |

## 알림 / 기타

| Variable | Default | Description |
|---|---|---|
| `SLACK_WEBHOOK_URL` | *(empty)* | Slack 알림 채널 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` / `SMTP_USE_TLS` | port 587, TLS on | 메일 알림 |
| `ANSIBLE_PLAYBOOK_DIR` / `ANSIBLE_INVENTORY_DIR` | `/app/ansible/...` | Ansible 자산 경로 |

---

## ⚠️ `Settings` 밖에서 읽는 변수

아래 변수들은 pydantic-settings 를 거치지 않고 `os.getenv` 로 직접 읽는다 — `config.py` 를 아무리
찾아도 나오지 않으니 주의.

| Variable | Default | 읽는 곳 |
|---|---|---|
| `ALLOWED_ORIGINS` | *(empty)* | `main.py` — 추가 CORS origin (콤마 구분) |
| `PEP_K9S_SSH_ENABLED` | `true` | `routers/k9s_ssh.py` — k9s 콘솔(SSH 웹 터미널) on/off. `false`\|`0`\|`no` 면 WS 를 4403 으로 거부 |
| `PEP_NODE_SSH_ENABLED` | `true` | `routers/node_ssh.py` — 노드 SSH 터미널 on/off (위와 동일 규칙) |
| `K8S_ALLOC_OVERVIEW_TTL` | `86400` (24h) | `routers/k8s_allocation.py` — `/k8s-allocation` 전체 스냅샷(노드+네임스페이스) 캐시 수명(초). 완전한 결과에만 적용 — 절단(partial) 결과는 `K8S_ALLOC_PARTIAL_TTL` 이 우선 |
| `K8S_ALLOC_PARTIAL_TTL` | `300` (5m) | 동일 — 부분(절단) 스냅샷의 짧은 캐시 수명(초). apiserver 5xx/`_continue` 토큰 만료로 전량 순회가 끊긴 결과가 24h 짜리 확정 데이터처럼 서빙되지 않도록 자동 재집계를 유도 |
| `K8S_ALLOC_STUCK_TIMEOUT` | `1800` (30m) | 동일 — 백그라운드 집계가 이 시간을 넘겨도 안 끝나면(행업) `refresh` 요청 시 새 계산으로 교체 |
| `K8S_ALLOC_METRICS_TIMEOUT` | `8.0` | 동일 — metrics-server(`metrics.k8s.io`) 조회 read timeout(초). 느리면 usage 생략(best-effort) |
| `K8S_ALLOC_POD_USAGE_MAX` | `6000` | 동일 — cluster-wide Pod usage 조회는 활성 Pod 수가 이 값 이하일 때만 시도(초과 시 생략 — 대형 클러스터에서 metrics 응답이 타임아웃만 반복하는 것을 방지, 드릴다운은 네임스페이스 단위로 계속 확인 가능) |
| `K8S_ALLOC_API_READ_TIMEOUT` | `12.0` | `services/k8s_paging.py` — LIST 페이지 1개당 read timeout(초). 게이트웨이 타임아웃보다 충분히 짧게 |
| `K8S_ALLOC_PAGE_LIMIT` | `500` | 동일 — LIST `_continue` 페이지네이션 페이지 크기 |
