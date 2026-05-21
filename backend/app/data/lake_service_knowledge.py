"""LAKE 8 OSS 서비스의 "기능 동작 특징" 가이드 컨텐츠.

main.py 의 `_seed_default_lake_service_entries()` 가 ServiceEntry kind=guide 로
전역 등록. content 는 Markdown (RichContent → DOMPurify 통과).

신규 서비스 추가 시 LAKE_SERVICE_KNOWLEDGE_ENTRIES 에 1 entry 추가.
운영자가 ServiceHub 에서 직접 수정/추가 가능 (seed 는 idempotent).
"""

_AIRFLOW = """## Apache Airflow

Python DAG 로 정의되는 **워크플로우 오케스트레이션** 엔진. LAKE 도메인에서 Spark/Trino/Iceberg
배치 job 을 시간/이벤트 트리거로 묶어 실행하는 backbone.

### 핵심 기능
- **DAG 기반 워크플로우** — Python 코드로 task 그래프 정의 (`PythonOperator`/`BashOperator`/`SparkSubmitOperator`)
- **스케줄러** — cron 식 또는 dataset-aware 트리거. catchup/depends_on_past 지원
- **Triggerer** — async sensor (DB/S3/HTTP) 가 thread 차지 없이 대기
- **Connection / Variable** — 외부 시스템 자격증명 + 환경 변수 중앙 관리
- **Web UI** — DAG 실행 history / 실패 task 재시도 / Gantt 차트

### 아키텍처
`webserver` (UI/API) + `scheduler` (DAG 파싱+task 디스패치) + `triggerer` (async sensor) +
`worker` (Celery 또는 KubernetesExecutor) + `metadata DB` (PostgreSQL) + `Redis` (Celery broker).
KubernetesExecutor 면 worker pod 가 task 별 ephemeral 생성.

### LAKE 도메인 내 역할
- Iceberg 테이블 ETL pipeline 의 orchestrator
- Spark/Trino 쿼리 batch 자동화
- Polaris catalog metadata sync
- StarRocks 적재 schedule
- SLA miss 알림 → ops-notes 연동

### 주요 의존성/통합
- PostgreSQL (metadata) / Redis (Celery) / S3 또는 PVC (DAG file 저장)
- Spark / Trino — operator 로 호출
- Slack/Email — notification

### 운영 주의점
- DAG file 변경은 scheduler 가 폴링 (`min_file_process_interval`) — 즉시 반영 안 됨
- Pool 설정 누락 시 worker 과부하
- KubernetesExecutor 의 pod cleanup 정책 확인 (`delete_worker_pods`)
- DB connection pool 고갈 — `sql_alchemy_pool_size` 적정값 유지
- `/health` 엔드포인트는 metadatabase/scheduler/triggerer 상태 반환 — devops_management LakeChecker 가 자동 점검
"""

_SPARK = """## Apache Spark

분산 메모리 컴퓨팅 엔진. LAKE 에서 대용량 ETL / 머신러닝 / 스트리밍 처리의 핵심 런타임.

### 핵심 기능
- **RDD / DataFrame / Dataset API** — Python/Scala/Java/R 다언어
- **Catalyst optimizer** — DataFrame 쿼리 실행 계획 최적화
- **Structured Streaming** — micro-batch / continuous mode
- **MLlib** — 기본 ML 알고리즘 + pipeline
- **Iceberg 통합** — Spark SQL `CREATE TABLE ... USING iceberg`

### 아키텍처
`Driver` (실행 계획 + DAG 생성) + `Executor` (task 실행 + 캐시) + `Cluster Manager`
(Standalone/YARN/K8s). K8s 모드면 Spark Operator 가 SparkApplication CR 을
받아 driver/executor pod 자동 생성. `History Server` 가 완료된 application 의 event log 보관.

### LAKE 도메인 내 역할
- Iceberg 테이블 read/write 의 주 엔진
- Airflow 의 `SparkKubernetesOperator` 로 호출
- Trino 와 같이 Iceberg 의 raw layer 처리 (Trino 는 interactive, Spark 는 batch)
- Jupyter notebook 의 백엔드 (Spark Connect)

### 주요 의존성/통합
- S3 / HDFS / 분산 storage (Iceberg metadata + data)
- Hive Metastore 또는 Iceberg REST catalog
- ZooKeeper (Standalone HA), K8s API (Operator)

### 운영 주의점
- Executor memory 설정 — 너무 작으면 OOM, 너무 크면 GC pause
- Shuffle service (External Shuffle Service) 활성화 시 executor 재시작 영향 ↓
- Iceberg 쓰기 시 `spark.sql.iceberg.handle-timestamp-without-timezone` 옵션 — null vs UTC 정책
- K8s 모드의 ServiceAccount 권한 (driver 가 executor pod 생성 가능해야)
- `/api/v1/applications` 가 master 상태 probe — devops_management LakeChecker 가 자동 호출
"""

_ICEBERG = """## Apache Iceberg

대용량 분석용 **테이블 포맷**. ACID 트랜잭션, 스키마 진화, time travel, partition pruning 을
표준 파일 (Parquet/ORC/Avro) 위에 메타데이터 layer 로 제공.

### 핵심 기능
- **ACID 트랜잭션** — snapshot 기반 격리, optimistic concurrency
- **Schema evolution** — column add/rename/drop/reorder/type-promote, ID 기반 매핑
- **Hidden partitioning** — 사용자가 partition 컬럼 명시 안 해도 query 가 자동 prune
- **Time travel** — `SELECT * FROM tbl AS OF '2026-01-01'`
- **Compaction / expiration** — 작은 파일 병합, 오래된 snapshot 제거

### 아키텍처
파일 layer (data files = Parquet/ORC) + manifest list (snapshot 의 file list) +
manifest file (각 데이터 파일의 metric/partition) + metadata.json (table 메타).
**Catalog** (REST/Hive/Glue/Polaris) 가 metadata.json 위치 관리.

### LAKE 도메인 내 역할
- Spark/Trino/StarRocks 의 공통 테이블 포맷 — 한 데이터를 여러 엔진이 동시 사용
- Polaris 가 catalog 역할 (table location + 권한)
- Airflow ETL → Iceberg write → Trino query → Superset 대시보드 흐름

### 주요 의존성/통합
- Object storage (S3/MinIO) — 데이터 + 메타데이터
- REST catalog (Polaris) 또는 Hive Metastore
- 엔진별 Iceberg client (spark-iceberg / trino-iceberg / starrocks-iceberg)

### 운영 주의점
- **작은 파일 폭증** — 빈번한 streaming write 시 compaction job 정기 실행 필수 (`rewrite_data_files`)
- Snapshot 누적 → metadata.json 크기 증가 — `expire_snapshots` schedule
- Catalog 일관성 — 같은 테이블을 여러 엔진이 동시 write 시 commit 충돌 (snapshot ID race)
- Schema evolution 시 ID-기반 매핑 — column name 변경해도 ID 동일하면 backward compat
- `/v1/config` endpoint 는 REST catalog 의 health probe (devops_management LakeChecker)
"""

_TRINO = """## Trino (formerly PrestoSQL)

분산 **interactive SQL 쿼리 엔진**. Iceberg/Hive/Kafka/MySQL/PostgreSQL 등 30+ connector 를
같은 SQL 로 join. LAKE 에서 ad-hoc 분석과 BI 대시보드 backing query 의 핵심.

### 핵심 기능
- **Federated query** — `SELECT * FROM iceberg.lake.events JOIN postgres.dim.users ...`
- **Cost-based optimizer** — table statistics 기반 join order/algorithm 선택
- **Memory pool** — query 별 memory budget + spill to disk (옵션)
- **Resource group** — 사용자/팀별 query 동시 실행 + queue
- **Pluggable connector** — Iceberg/Hive/Kafka/Elasticsearch 등

### 아키텍처
`Coordinator` (SQL parse + plan + 분배) + `Worker` (실제 execution) + `Discovery Service`
(worker 등록). Coordinator HA 미지원 — single point. Worker 는 stateless 라
auto-scaling 용이.

### LAKE 도메인 내 역할
- Iceberg 테이블의 interactive query 진입점 (Spark 는 batch, Trino 는 ad-hoc)
- Superset 대시보드의 query engine
- Polaris catalog 와 통합 (table discovery + 권한)
- StarRocks 가 hot data, Trino 가 cold/federated data 분담 패턴

### 주요 의존성/통합
- Iceberg REST catalog (Polaris) 또는 Hive Metastore
- S3 (Iceberg data files) — 직접 read
- Memory: heap + non-heap 합쳐 노드 memory 의 70% 권장
- LDAP/Kerberos/OAuth — 인증

### 운영 주의점
- **Memory limit 초과** — `query.max-memory-per-node` 초과 시 query fail. spilling 활성화 검토
- Coordinator HA 없음 — 재시작 시 in-flight query 모두 fail
- Worker 추가 시 `discovery.uri` 자동 등록 — DNS resolution 확인
- Catalog 변경 (`/etc/catalog/*.properties`) 는 worker 재시작 필요
- `/v1/info` 가 health endpoint (devops_management LakeChecker)
"""

_STARROCKS = """## StarRocks

고성능 **OLAP MPP 분석 데이터베이스**. 실시간 ingest + sub-second 쿼리. LAKE 에서
"hot data" 대시보드와 ad-hoc 분석 가속용.

### 핵심 기능
- **MPP 아키텍처** — query 가 모든 BE 노드에 병렬 분산
- **Vectorized execution** — SIMD 최적화 + columnar storage
- **Materialized View** — 자동 sync + query rewrite
- **Iceberg/Hive/JDBC catalog** — external table 직접 read (federation)
- **Stream Load / Routine Load** — Kafka/HTTP 실시간 적재

### 아키텍처
`FE (Frontend)` (metadata + query plan + 분배) + `BE (Backend)` (실제 storage + execution) +
`CN (Compute Node, optional)` (stateless compute scale-out). FE HA = 3 노드 (Raft).

### LAKE 도메인 내 역할
- Iceberg cold data 의 hot cache layer
- Superset / 사용자 dashboard 의 sub-second 응답 보장
- Stream ingest (Kafka → StarRocks) — 실시간 분석
- Trino 가 federation, StarRocks 가 local materialized — 역할 분담

### 주요 의존성/통합
- Object storage (Iceberg external table read)
- Kafka (Routine Load) — 실시간 ingest
- MySQL/PostgreSQL (JDBC catalog)
- FE HA: 3 FE 노드 + Raft consensus

### 운영 주의점
- **Compaction** — write-heavy 시 BE 의 disk IO 폭주. `cumulative_compaction_num_threads_per_disk` 조정
- BE 노드 추가 시 replica rebalance 시간 — 자동이나 monitoring 필요
- Memory 설정: `mem_limit` 단일 BE 의 hard cap
- FE leader election — 3 노드 중 majority 살아있어야
- `/api/health` endpoint (devops_management LakeChecker)
"""

_JUPYTERLAB = """## JupyterHub + JupyterLab

다중 사용자 **notebook 환경**. 데이터 사이언티스트가 Spark/Iceberg/Trino 와 상호작용하며
실험/탐색/시각화. LAKE 에서 BI 와 ML 의 첫 번째 진입점.

### 핵심 기능
- **Multi-user** — 사용자별 개별 notebook server (pod 또는 process)
- **Kernel** — Python/Scala/R/Julia + Spark Connect / PySpark
- **JupyterLab IDE** — terminal + file browser + extension + git 통합
- **Authenticator** — OAuth/LDAP/Keycloak 연동
- **Spawner** — KubeSpawner 가 사용자별 pod 동적 생성

### 아키텍처
`Hub` (인증 + 사용자 routing + spawner) + `Configurable HTTP Proxy` (HTTPS 진입점) +
사용자별 `Notebook Server` pod (Spawner 가 생성). K8s 모드면 PVC 마운트로
notebook 영속화.

### LAKE 도메인 내 역할
- Spark Connect / PySpark 클라이언트로 Iceberg 테이블 탐색
- Trino python client 로 ad-hoc query
- StarRocks 데이터 → pandas/matplotlib 시각화
- ML 모델 학습 → MLflow / Polaris (governance) 등록

### 주요 의존성/통합
- Keycloak (OAuth) — 사용자 인증
- PVC / S3 — notebook 영속화
- Spark Driver pod (사용자별 또는 공유)
- Resource quota — namespace 당 CPU/memory limit

### 운영 주의점
- **사용자 pod 누적** — idle culler (`c.JupyterHub.tornado_settings`) 설정 필수, 안 그러면 좀비 pod
- Spawner 가 PVC 생성 시 storage class 권한 확인
- Hub 가 single replica — restart 시 활성 세션 끊김 (rolling 권장)
- Image build — 사용자 환경 (pandas/numpy/spark client) lake 환경 동기화 필요
- `/hub/health` endpoint (devops_management LakeChecker)
"""

_SUPERSET = """## Apache Superset

오픈소스 **BI 대시보드** 플랫폼. SQL Lab + 시각화 + Dashboard + Alerts. LAKE 에서
운영팀/비즈니스팀에게 데이터를 노출하는 face layer.

### 핵심 기능
- **SQL Lab** — IDE 스타일 SQL 작성 + 결과 시각화 + 저장
- **Dashboard / Chart** — 50+ chart 타입 + drag-drop
- **Database connector** — Trino/StarRocks/Postgres 등 SQLAlchemy 기반 50+
- **Row-level security** — 사용자/역할별 자동 WHERE 필터
- **Alerts & Reports** — Slack/Email 정기 발송

### 아키텍처
`Web` (Flask) + `Worker` (Celery — async query, alerts) + `Beat` (스케줄러) +
`Metadata DB` (PostgreSQL) + `Cache` (Redis). 대규모면 web/worker scale-out.

### LAKE 도메인 내 역할
- Trino / StarRocks 가 backend — Superset 이 사용자 대시보드
- Iceberg 테이블의 비즈니스 가시화
- Airflow 가 데이터 신선도 보장 → Superset 이 표시
- Polaris 권한 → Superset RLS 매핑 (검토 필요)

### 주요 의존성/통합
- PostgreSQL (metadata) / Redis (cache + Celery broker)
- Trino / StarRocks (query backend)
- Keycloak (OAuth) — SSO
- SMTP — alert 발송

### 운영 주의점
- **Query timeout** — 긴 쿼리로 worker 점유 → `SQL_LAB_QUERY_TIMEOUT` 설정 + async query 활성화
- Dashboard cache (`CACHE_DEFAULT_TIMEOUT`) — 너무 길면 stale, 짧으면 backend 부하
- RLS rule 누락 → 권한 누설 위험. 신규 dataset 도입 시 정책 review 필수
- Celery beat / worker 분리 — beat 단일 인스턴스만 (중복 schedule fire 방지)
- `/health` endpoint (devops_management LakeChecker)
"""

_POLARIS = """## Apache Polaris (Incubating)

**Iceberg REST catalog** 의 오픈소스 구현. 다중 엔진 (Spark/Trino/StarRocks) 환경에서
**테이블 location + 권한 + governance** 의 단일 진실 공급원.

### 핵심 기능
- **Iceberg REST catalog spec 구현** — `/v1/{prefix}/namespaces`, `/v1/{prefix}/tables` 표준
- **Role-based access control** — namespace/table 단위 권한
- **Catalog isolation** — 환경 (dev/prod) / 팀별 catalog 분리
- **Audit log** — table 생성/수정/삭제 추적
- **Credential vending** — 사용자에게 S3 임시 자격증명 발급 (STS)

### 아키텍처
`Management REST API` (관리 작업) + `Catalog REST API` (Iceberg client 가 호출) +
`Metastore Backend` (PostgreSQL 또는 in-memory). HA 는 stateless API + 외부 DB.

### LAKE 도메인 내 역할
- Iceberg 의 catalog 역할 — Spark/Trino/StarRocks 가 모두 같은 catalog 사용 → 데이터 일관성
- 권한 정책 중앙화 — engine 별 권한 분산 회피
- Audit trail — devops_management 의 audit_logger 와 별도, table-level 추적
- Multi-environment — production catalog vs sandbox catalog 격리

### 주요 의존성/통합
- PostgreSQL (metastore)
- S3 (data files — credential vending 통해)
- IAM/STS (S3 임시 자격증명)
- Iceberg client (spark-iceberg, trino-iceberg, starrocks-iceberg)

### 운영 주의점
- **PostgreSQL HA 필수** — metastore 가 single point. read replica + 자동 failover
- Credential vending 의 TTL — 너무 짧으면 long-running query fail, 너무 길면 보안 위험
- Catalog endpoint 정책 변경 (table format/location) 은 commit 충돌 가능 — staging catalog 에서 검증
- Apache 인큐베이팅 단계 — API breaking change 가능성 모니터링
- `/api/management/v1/health` endpoint (devops_management LakeChecker)
"""


LAKE_SERVICE_KNOWLEDGE_ENTRIES: list[dict] = [
    {"service": "airflow",    "title": "Apache Airflow — 기능 동작 특징",   "category": "runtime",   "content": _AIRFLOW},
    {"service": "spark",      "title": "Apache Spark — 기능 동작 특징",     "category": "runtime",   "content": _SPARK},
    {"service": "iceberg",    "title": "Apache Iceberg — 기능 동작 특징",   "category": "catalog",   "content": _ICEBERG},
    {"service": "trino",      "title": "Trino — 기능 동작 특징",            "category": "analytics", "content": _TRINO},
    {"service": "starrocks",  "title": "StarRocks — 기능 동작 특징",        "category": "analytics", "content": _STARROCKS},
    {"service": "jupyterlab", "title": "JupyterHub — 기능 동작 특징",       "category": "analytics", "content": _JUPYTERLAB},
    {"service": "superset",   "title": "Apache Superset — 기능 동작 특징",  "category": "analytics", "content": _SUPERSET},
    {"service": "polaris",    "title": "Apache Polaris — 기능 동작 특징",   "category": "catalog",   "content": _POLARIS},
]


__all__ = ["LAKE_SERVICE_KNOWLEDGE_ENTRIES"]
