from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # App
    app_name: str = "DEVOPS MANAGEMENT"
    debug: bool = False
    
    # Database
    database_url: str = "postgresql://postgres:postgres@localhost:5432/k8s_monitor"
    # SQLAlchemy 엔진 커넥션 풀. backend(API, HPA 2~10)와 celery worker/beat(HPA 2~8 + 1)
    # 가 이 값을 공유하는 같은 engine 코드를 쓰므로, 기본값을 그대로 두면 replica 합계가
    # PostgreSQL 기본 max_connections(100)를 쉽게 넘는다(예: baseline 만도 (2+2+1)×
    # (10+20)=150). k8s worker/beat 배포는 DB_POOL_SIZE/DB_MAX_OVERFLOW 를 더 작게
    # 오버라이드해서 쓴다(k8s/base/celery/*.yaml).
    db_pool_size: int = 10
    db_max_overflow: int = 20

    # Redis
    redis_url: str = "redis://localhost:6379/0"
    
    # Celery
    celery_broker_url: str = "redis://localhost:6379/0"
    celery_result_backend: str = "redis://localhost:6379/0"
    
    # Ansible
    ansible_playbook_dir: str = "/app/ansible/playbooks"
    ansible_inventory_dir: str = "/app/ansible/inventory"
    
    # Security / Auth
    secret_key: str = "your-secret-key-change-in-production"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24  # 24 hours
    # Bootstrap: created on startup if no users exist. Skip if already present.
    initial_admin_username: str = "admin"
    initial_admin_password: str = "admin"
    
    # Health Check
    check_interval_minutes: int = 5
    check_timeout_seconds: int = 30

    # Pod 로그 / 이벤트 SSE 스트림 (analyze.py stream_pod_logs, stream_cluster_events)
    # kubernetes SDK 는 blocking urllib3 라 스트림 하나가 anyio 스레드풀 슬롯 하나를
    # 스트림 수명 내내 점유한다. follow=True 무제한 tail 이 스레드풀을 고갈시켜 나머지
    # API 전체가 멈추는 사고를 막기 위해 (1) 프로세스당 동시 스트림 수를 제한하고
    # (2) 스트림 최대 수명을 둔다 — 초과분은 429, 수명 초과는 정상 종료(프론트가 재연결).
    log_stream_max_concurrent: int = 20
    log_stream_max_duration_seconds: int = 1800

    # anyio 의 sync 라우트(전체 834개 중 744개, 89%) 실행용 스레드풀 총량. anyio 기본값
    # (40)은 범용 heuristic 이라, sync 핸들러 비중이 이례적으로 높고 그 중 다수가
    # kubectl subprocess(최대 30s)·SSH·로그 스트림처럼 오래 걸리는 이 앱에는 작다.
    # main.py lifespan 에서 이 값으로 CapacityLimiter.total_tokens 를 올린다.
    sync_threadpool_size: int = 100

    # AI Agent (Ollama)
    ollama_url: str = "http://ollama:11434"
    ollama_model: str = "llama3"
    ollama_timeout: int = 120

    # ─── LLM 게이트웨이 (services/llm) — bootstrap fallback 전용 ─────
    # 운영 설정의 원천은 AppSetting `llm_settings` (Settings → AI/LLM 탭).
    # 아래 값들은 AppSetting 행이 없을 때 기본 프로필을 합성하는 용도다.
    # LLM_API_BASE 설정 시 사내 OpenAI-호환 서비스용 `internal-llm` 프로필이 생긴다.
    llm_api_base: str = ""
    # API 키는 AppSetting JSONB 에 저장하지 않는다 — 프로필의 api_key_ref 가
    # "env:LLM_API_KEY"(이 변수) 또는 "credential:<name>"(llm_credentials 암호화
    # 테이블)을 참조한다.
    llm_api_key: str = ""
    llm_model: str = ""
    llm_timeout: int = 120
    # 장애 분석기 선택 (claude|local_llm|rule_based). AppSetting 값이 우선하고,
    # 이 env 는 레거시/bootstrap 폴백이다 (구 raw os.getenv 흡수).
    analyzer_backend: str = ""

    # Embedding (Ollama /api/embeddings) — WorkItem / WorkGuide 유사 검색용.
    # 폐쇄망 로컬 추론 전제 — Nexus 로 반입 (docs/AIRGAP_LLM_NEXUS.md 참고).
    # nomic-embed-text 기준 차원(768). 모델 교체 시 embedding_dim 도 함께 맞춰야 한다
    # (차원이 다르면 기존에 저장된 임베딩과 비교 불가 — 재계산 필요).
    embedding_model: str = "nomic-embed-text"
    embedding_dim: int = 768
    embedding_timeout: int = 30

    # Alert Channels
    slack_webhook_url: str = ""

    # 인시던트 알람 수신(Alertmanager webhook / 사내 alert-forwarder) Bearer 토큰.
    # **fail-closed** — 미설정 시 /observability/alerts/ingest 수신 자체를 503 으로 거부한다
    # (kubewatch_token / superpod_ingest_token 과 동일 정책).
    alert_ingest_token: str = ""

    # Prometheus / Grafana
    prometheus_url: str = "http://prometheus-k8s.monitoring.svc:9090"
    # Observability 대시보드의 Alertmanager 전역 기본값. 클러스터별 오버라이드는
    # clusters.alertmanager_url 이 우선한다.
    alertmanager_url: str = "http://alertmanager-operated.monitoring.svc:9093"
    grafana_url: str = "http://grafana.monitoring.svc:3000"
    grafana_renderer_url: str = "http://grafana-renderer:8081"

    # kubewatch 웹훅 인증 토큰 (미설정 시 토큰 검증 없이 수락)
    kubewatch_token: str = ""

    # Cluster Trends: node-exporter 메트릭에서 노드를 식별하는 라벨명.
    # 보통 "instance" 지만 스크랩 relabeling 에 따라 "node"/"nodename" 등일 수 있어 배포 의존 → 설정 가능.
    # 이 라벨의 값이 k8s Node.metadata.name 과 일치해야 per-node 추이가 매칭된다.
    prometheus_node_label: str = "instance"
    # 한 번에 추이 조회 가능한 최대 노드 수 (300+ 노드 과수집 방지 상한).
    trends_max_nodes: int = 30

    # Trend Digest
    # 폐쇄망: github_api_url을 내부 GitHub Enterprise 주소로 변경
    trends_github_api_url: str = "https://api.github.com"
    trends_github_token: str = ""          # optional: rate limit 향상
    trends_collect_hour: int = 7           # 매일 07:00 KST 자동 수집

    # Batch Jobs
    # Design Ref: §2.3.1 — croniter 가 cron 식을 해석할 timezone (IANA name).
    # 변경 시 기존 등록된 cron 잡들의 다음 발화 시각이 이동한다.
    batch_jobs_timezone: str = "Asia/Seoul"

    # Kubeconfig 저장 디렉토리 (content 방식으로 등록 시 사용)
    kubeconfig_store_dir: str = "/tmp/k8s-monitor/kubeconfigs"

    # ─── Super Pod / Deep check ─────────────────────────────
    # in_cluster | centralized — 같은 backend 이미지로 두 모드 모두 띄울 수 있음.
    superpod_mode: str = "centralized"
    # in-cluster CronJob 이 결과를 push 할 대상 (management cluster ingest URL).
    superpod_ingest_url: str = ""
    superpod_ingest_token: str = ""
    # in_cluster 모드일 때 자기 자신 클러스터 식별자 (UUID 문자열 또는 이름).
    superpod_cluster_id: str = ""
    # 관리 네임스페이스 — K8sEvent 채널에서 사용.
    mgmt_namespace: str = "k8s-monitor"

    # ─── 알림 채널 기본값 ───────────────────────────────────
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "k8s-monitor@example.com"
    smtp_use_tls: bool = True

    class Config:
        env_file = ".env"
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
