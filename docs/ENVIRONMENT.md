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
| `KUBECONFIG_STORE_DIR` | `/tmp/k8s-monitor/kubeconfigs` | content 방식 kubeconfig 저장 위치 |
| `KUBEWATCH_TOKEN` | *(empty)* | kubewatch 웹훅 Bearer 토큰. **fail-closed** — 미설정 시 웹훅 수신 자체를 503 으로 거부(deep_check ingest 의 `SUPERPOD_INGEST_TOKEN` 과 동일 정책) |
| `MGMT_NAMESPACE` | `k8s-monitor` | 관리 네임스페이스 (K8sEvent 채널) |
| `SUPERPOD_MODE` | `centralized` | `in_cluster` \| `centralized` — deep check 실행 모드 |
| `SUPERPOD_INGEST_URL` / `SUPERPOD_INGEST_TOKEN` | *(empty)* | in-cluster CronJob 결과 push 대상. 토큰은 fail-closed |
| `SUPERPOD_CLUSTER_ID` | *(empty)* | in_cluster 모드에서 자기 클러스터 식별자 |

## AI / LLM / Embedding

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_URL` | `http://ollama:11434` | Ollama base URL |
| `OLLAMA_MODEL` | `llama3` | LLM model name (airgap overlay 는 `qwen2.5-coder:7b`) |
| `OLLAMA_TIMEOUT` | `120` | LLM request timeout (s) |
| `EMBEDDING_MODEL` | `nomic-embed-text` | 임베딩 모델 (WorkItem/WorkGuide 유사 검색) |
| `EMBEDDING_DIM` | `768` | 임베딩 차원 — 모델 교체 시 함께 변경(기존 벡터 재계산 필요) |
| `EMBEDDING_TIMEOUT` | `30` | 임베딩 요청 timeout (s) |

## Prometheus / Grafana / Trends

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

## 알림 / 기타

| Variable | Default | Description |
|---|---|---|
| `SLACK_WEBHOOK_URL` | *(empty)* | Slack 알림 채널 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` / `SMTP_USE_TLS` | port 587, TLS on | 메일 알림 |
| `ANSIBLE_PLAYBOOK_DIR` / `ANSIBLE_INVENTORY_DIR` | `/app/ansible/...` | Ansible 자산 경로 |

---

## ⚠️ `Settings` 밖에서 읽는 변수

아래 둘은 pydantic-settings 를 거치지 않고 `os.getenv` 로 직접 읽는다 — `config.py` 를 아무리
찾아도 나오지 않으니 주의.

| Variable | Default | 읽는 곳 |
|---|---|---|
| `ANALYZER_BACKEND` | `rule_based` | `services/analyzers/factory.py` — `claude` \| `local_llm` \| `rule_based` |
| `ALLOWED_ORIGINS` | *(empty)* | `main.py` — 추가 CORS origin (콤마 구분) |
