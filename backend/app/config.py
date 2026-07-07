from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # App
    app_name: str = "DEVOPS MANAGEMENT"
    debug: bool = False
    
    # Database
    database_url: str = "postgresql://postgres:postgres@localhost:5432/k8s_monitor"
    
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

    # AI Agent (Ollama)
    ollama_url: str = "http://ollama:11434"
    ollama_model: str = "llama3"
    ollama_timeout: int = 120

    # Embedding (Ollama /api/embeddings) — WorkItem / WorkGuide 유사 검색용.
    # 폐쇄망 로컬 추론 전제 — Nexus 로 반입 (docs/AIRGAP_LLM_NEXUS.md 참고).
    # nomic-embed-text 기준 차원(768). 모델 교체 시 embedding_dim 도 함께 맞춰야 한다
    # (차원이 다르면 기존에 저장된 임베딩과 비교 불가 — 재계산 필요).
    embedding_model: str = "nomic-embed-text"
    embedding_dim: int = 768
    embedding_timeout: int = 30

    # OpenClaw Alert Channels
    telegram_bot_token: str = ""
    telegram_chat_id: str = ""
    slack_webhook_url: str = ""

    # Prometheus / Grafana
    prometheus_url: str = "http://prometheus-k8s.monitoring.svc:9090"
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

    # Coroot (application APM / observability) — 별도 배포 서비스.
    # 비어있으면 기능 전체가 offline 으로 우아하게 비활성화된다 (Prometheus/Ollama 와 동일 패턴).
    # per-cluster 매핑(coroot_project)은 clusters 테이블에 저장하고, base URL 은 전역으로 둔다.
    coroot_url: str = ""
    coroot_api_key: str = ""        # 선택 — coroot API 키 인증 사용 시
    coroot_timeout: int = 10

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
    # SLACK_WEBHOOK_URL 은 위 OpenClaw 와 공유.
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
