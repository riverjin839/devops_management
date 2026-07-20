# 폐쇄망 LLM 셋업 가이드 — Ollama 모델을 Nexus 로 수급하기

> 대시보드의 **AI 클러스터 상태 요약** 아이템(`ai_cluster_summary`)은 사내 **Ollama** LLM 을
> 호출해 최근 점검 데이터를 요약하고 위험도를 산출합니다. 폐쇄망에서는 인터넷
> (`registry.ollama.ai`)에 직접 접근할 수 없으므로, **Nexus** 를 통해 모델을 수급합니다.
>
> 이 문서는 Ollama 배포 → Nexus 로 모델 수급 → 백엔드 연동 → AI 아이템 사용까지의
> 전체 절차를 다룹니다.
>
> **아키텍처/기능 설계** — 내부 제공 모델(GLM-5.2)로의 전환, vLLM(OpenAI-호환) 서빙,
> K8s 로그 자동 분석(분석 전용), PEP 내부 문서 RAG 는
> [AIRGAP_LLM_ARCHITECTURE.md](AIRGAP_LLM_ARCHITECTURE.md) 를 참고하세요.
> (GLM 가중치/vLLM 이미지 반입도 본 문서의 방식 B(raw-hosted)를 그대로 적용합니다.)

---

## 0. 아키텍처

```
                        ┌──────────────────────────────────────┐
   (인터넷 빌드망)       │  registry.ollama.ai (모델 OCI 레지스트리) │
        │  pull          └──────────────────────────────────────┘
        ▼                                  ▲ proxy
┌──────────────┐   업로드/미러   ┌─────────────────────────────┐
│  Nexus       │◀───────────────│  Nexus (폐쇄망)             │
│  docker-proxy│                 │  · docker (proxy) repo      │
│  또는 raw     │                 │  · raw (hosted) repo        │
└──────────────┘                 └─────────────────────────────┘
                                          │ ollama pull
                                          ▼
                              ┌────────────────────────┐
                              │  Ollama 서버 (사내)     │  ← OLLAMA_URL
                              │  qwen2.5:7b 등 적재     │
                              └────────────────────────┘
                                          ▲ HTTP /api/generate
                                          │
                              ┌────────────────────────┐
                              │  PEP 백엔드 (FastAPI)   │  agent_service → ai_cluster_summary
                              └────────────────────────┘
```

핵심: **백엔드는 Ollama 만 바라봅니다(`OLLAMA_URL`)**. Nexus 는 "Ollama 서버가 모델을
어디서 받아오는가"의 문제이지, 백엔드 호출 경로와는 무관합니다.

---

## 1. Ollama 서버 배포

이미 저장소에 매니페스트가 있습니다.

- Kubernetes: `k8s/base/ollama.yaml` (선택적 Deployment + Service)
- Docker Compose: `OLLAMA_URL` 만 사내 Ollama 로 지정하면 됩니다.

K8s 로 배포 시 백엔드와 같은 네임스페이스에 올리면 `OLLAMA_URL=http://ollama:11434` 로
접근할 수 있습니다.

> ⚠️ **`k8s/base/ollama.yaml` 은 이미 `qwen2.5-coder:7b` 모델을 사전 적재한 커스텀 이미지**
> (`ghcr.io/riverjin839/ollama-qwen2.5-coder:7b`)를 쓰며, 매니페스트 자체에 "폐쇄망에서
> `ollama pull` 을 args 에 넣지 말 것(실패하거나 무한 대기)"이라는 주석이 있다. `k8s/overlays/
> airgap/` 도 같은 이미지를 내부 레지스트리로 경로만 바꿔 재사용한다. 즉 **이 이미지를 그대로
> 쓰면 아래 §2(Nexus 모델 수급) 절차 자체가 필요 없다** — 이미 반입돼 있다. 다른 모델로
> 바꾸거나 vanilla Ollama 이미지를 쓸 때만 §2 를 따른다.

---

## 2. Nexus 로 모델 수급 — 두 가지 방식

### 방식 A (권장) — Nexus docker(proxy) 레지스트리로 `registry.ollama.ai` 프록시

Ollama 모델은 OCI 와 유사한 레지스트리 포맷으로 배포됩니다. 따라서 Nexus 의
**docker proxy** 저장소로 `https://registry.ollama.ai` 를 프록시한 뒤, 모델 이름에 Nexus
호스트를 붙여 pull 합니다.

1. **Nexus 설정** (관리자)
   - `Repositories → Create repository → docker (proxy)`
   - Remote storage: `https://registry.ollama.ai`
   - HTTP 포트(예: `8082`) 또는 reverse-proxy 경로 부여
   - 폐쇄망에서 Nexus 가 인터넷(빌드망)으로 1회 나갈 수 있어야 캐싱됩니다. 완전
     폐쇄면 방식 B 를 쓰세요.

2. **Ollama 서버에서 pull**
   ```bash
   # 모델 이름 앞에 Nexus 호스트를 붙이면 그 레지스트리에서 받아옵니다.
   ollama pull nexus.example.com:8082/library/qwen2.5:7b

   # 백엔드가 참조할 별칭으로 복제(태그)해 두면 OLLAMA_MODEL 을 짧게 유지 가능
   ollama cp nexus.example.com:8082/library/qwen2.5:7b qwen2.5:7b
   ```

3. Nexus 가 TLS self-signed 면 Ollama 서버 호스트의 CA 신뢰 저장소에 인증서를
   추가하거나, 레지스트리를 insecure 로 허용해야 합니다.

### 방식 B (완전 폐쇄망) — 빌드망에서 받아 Nexus raw(hosted) 로 반입

인터넷이 빌드망에만 있고 운영 폐쇄망은 Nexus 만 접근 가능한 경우.

1. **빌드망에서 모델 다운로드**
   ```bash
   ollama pull qwen2.5:7b
   # 모델 blob 은 ~/.ollama/models 아래에 저장됩니다.
   tar -C ~/.ollama -czf ollama-qwen2.5-7b.tgz models
   ```

2. **Nexus raw(hosted) 저장소에 업로드**
   ```bash
   curl -u <user>:<pass> --upload-file ollama-qwen2.5-7b.tgz \
     https://nexus.example.com/repository/llm-models/ollama/ollama-qwen2.5-7b.tgz
   ```

3. **폐쇄망 Ollama 서버에서 내려받아 적재**
   ```bash
   curl -u <user>:<pass> -O \
     https://nexus.example.com/repository/llm-models/ollama/ollama-qwen2.5-7b.tgz
   tar -C ~/.ollama -xzf ollama-qwen2.5-7b.tgz
   ollama list   # qwen2.5:7b 가 보이면 성공
   ```

> 컨테이너로 Ollama 를 돌린다면 `~/.ollama` 를 PV/volume 으로 마운트하고 그 안에
> `models` 를 풀어 넣으면 됩니다.

---

## 3. 백엔드 환경변수

`backend/.env` (또는 K8s ConfigMap/Secret):

| 변수 | 예시 | 설명 |
|---|---|---|
| `OLLAMA_URL` | `http://ollama:11434` | 사내 Ollama 서버 주소 |
| `OLLAMA_MODEL` | `qwen2.5:7b` | 적재한 모델 이름 (별칭 권장). **기본값은 `llama3`**(`config.py`) — 폐쇄망 배포 시 반드시 재설정할 것 |
| `OLLAMA_TIMEOUT` | `120` | LLM 요청 타임아웃(초) |

`OLLAMA_MODEL` 은 `"qwen2.5"` 처럼 base 만 적어도 `qwen2.5:7b` 와 매칭됩니다
(`agent_service.health_check` 가 base 이름 비교를 지원).

> **Helm 폐쇄망 차트(`values-airgap.yaml`)** 는 모델을 **사전 적재한 커스텀 Ollama 이미지**를 쓰며
> 기본 `OLLAMA_MODEL=qwen2.5-coder:7b` 로 설정돼 있다. 이 이미지를 그대로 쓰면 위 2장(모델 수급)
> 절차가 필요 없다. 다른 모델을 쓰려면 `OLLAMA_MODEL` 을 바꾸고 2장 절차로 적재한다.

---

## 4. 연동 확인

백엔드 기동 후:

```bash
# 1) Ollama 가용성 + 모델 적재 확인
curl http://<backend>/api/v1/agent/health
#  → {"status":"online","model":"qwen2.5:7b"}              ← 정상
#  → {"status":"online","detail":"... model not pulled"}   ← 모델 미적재 (2장 다시)
#  → {"status":"offline", ...}                              ← OLLAMA_URL 오류

# 2) 적재된 모델 목록
curl http://<backend>/api/v1/agent/models

# 3) (선택) 모델 당겨오기 — Ollama 가 Nexus 프록시에 접근 가능할 때만
curl -X POST http://<backend>/api/v1/agent/pull-model \
  -H 'Content-Type: application/json' -d '{"model":"qwen2.5:7b"}'
```

---

## 5. AI 아이템 추가 & 사용

1. 대시보드에서 **클러스터 1개 선택** → "현황 아이템" 섹션의 **아이템 추가** 클릭.
2. **아이템 종류 = `🤖 AI 클러스터 상태 요약`** 선택.
3. **결과 수집 방식 = AI** (자동 선택됨). 자동 점검 시각(기본 06시)·카드 크기 조정.
4. 저장 후 카드의 **새로고침(수동 실행)** 버튼으로 즉시 1회 수집.
   - 결과: 한국어 1~2문장 요약 + 좌상단 위험도 dot(healthy/warning/critical).
   - LLM 미가용 시 카드에 `LLM 미가용: ...` 로 표시되며 **대시보드는 영향 없음**(fail-safe).

> AI 요약은 해당 클러스터의 **가장 최근 일일점검(`DailyCheckLog`)** 데이터를 컨텍스트로
> 사용합니다. 점검 이력이 없으면 먼저 "Run Check" 로 점검을 한 번 수행하세요.

### 자동 수집 스케줄

- 매시 정각 Celery Beat 디스패처(`run_cluster_item_dispatcher`)가 동작하며,
  아이템의 `schedule_hour`(KST)와 현재 시가 일치하고 `auto_enabled` 이면 수집합니다.
- AI 아이템(`source_mode=ai`)도 자동 수집 대상에 포함됩니다.

---

## 6. 트러블슈팅

| 증상 | 원인 / 조치 |
|---|---|
| `health` 가 `offline` | `OLLAMA_URL` 오타 / Ollama 미기동 / 네트워크 정책. 백엔드→Ollama 11434 연결 확인 |
| `online` 이지만 `model not pulled` | 모델 미적재. 2장(A 또는 B)으로 모델 반입 후 `ollama list` 확인 |
| 카드에 `LLM 미가용: ... timed out` | 모델 최초 로딩이 김 / 서버 과부하. `OLLAMA_TIMEOUT` 상향, 작은 모델 사용 |
| `ollama pull` 이 Nexus 에서 실패 | docker(proxy) 미설정 / Nexus→인터넷 차단(완전폐쇄면 방식 B) / self-signed CA 미신뢰 |
| 위험도 dot 이 회색(info) | LLM 응답에 `RISK:` 라인이 없거나 미가용. 프롬프트는 마지막 줄에 `RISK: healthy|warning|critical` 를 요구함 |

---

## 7. 임베딩 모델 — WorkItem / 지식허브 유사 검색

**PEP AI 계층 개선 Phase 1-2** 로 WorkItem(`work_items.embedding`)과 지식허브 문서
(`work_guides.embedding`)에 pgvector 기반 유사 검색이 추가되었습니다. 별도 임베딩 서빙
스택(sentence-transformers 등)을 새로 들이지 않고, **기존 Ollama 인프라를 그대로 재사용**해
`/api/embeddings` 엔드포인트로 호출합니다 — 백엔드 관점에서는 2장의 LLM 모델 반입 절차와
동일하게 Nexus 로 **임베딩 전용 모델**만 하나 더 적재하면 됩니다.

### 7.1 임베딩 모델 반입

기본값은 `nomic-embed-text` (차원 768, 경량, 다국어 양호). 2장(방식 A/B) 과 완전히 동일한
절차로 반입합니다:

```bash
# 방식 A (Nexus docker-proxy 사용 시)
ollama pull <nexus-host>:<port>/nomic-embed-text
ollama cp <nexus-host>:<port>/nomic-embed-text nomic-embed-text

# 방식 B (오프라인 tar 반입 시) — 2장 §B 절차와 동일
```

`EMBEDDING_MODEL` 환경변수로 모델명을, `EMBEDDING_DIM` 으로 차원을 지정합니다. **모델을
바꾸면 차원도 함께 맞춰야 하며, 기존에 저장된 임베딩은 새 차원과 호환되지 않으므로
재계산이 필요합니다** (WorkItem/WorkGuide 를 한 번씩 재저장하면 Celery 태스크가 자동
재계산).

### 7.2 pgvector 확장 반입 (PostgreSQL)

`work_items.embedding` / `work_guides.embedding` 컬럼은 PostgreSQL `vector` 타입(pgvector
확장)을 사용합니다. 폐쇄망 PostgreSQL 서버에 확장 패키지를 사전 반입해야 합니다.

```bash
# Ubuntu/Debian 계열 — Nexus apt(proxy) repo 를 통해 반입
apt-get install postgresql-<버전>-pgvector

# 또는 소스 빌드 (오프라인 tar 반입 시)
# https://github.com/pgvector/pgvector 릴리스 tarball 을 Nexus raw(hosted) 로 반입 후
# make && make install (PostgreSQL 서버와 동일 major 버전 devel 패키지 필요)
```

백엔드는 부팅 시 `CREATE EXTENSION IF NOT EXISTS vector` 를 자동 실행합니다
(`main.py: _ensure_pgvector_extension`). 확장이 없으면 경고 로그만 남기고 부팅은
계속되지만, `work_items`/`work_guides` 테이블이 **아직 한 번도 생성되지 않은 완전
신규 설치**라면 해당 테이블 생성 자체가 실패할 수 있으므로, 반드시 최초 배포 전에
pgvector 확장을 먼저 설치하세요. 이미 운영 중인 DB(테이블이 이미 존재)라면 확장만
나중에 설치해도 재부팅 시 `embedding` 컬럼이 자동으로 추가됩니다(`_run_migrations`).

### 7.3 동작 확인

```bash
# 임베딩 모델 응답 확인
curl -s http://<ollama-host>:11434/api/embeddings \
  -d '{"model": "nomic-embed-text", "prompt": "etcd 리더 없음"}' | jq '.embedding | length'
# → 768

# 유사 WorkItem 검색
curl -s http://localhost:8000/api/v1/work-items/<work_item_id>/similar
```

WorkItem/지식허브 문서를 생성·수정하면 응답이 온 뒤 **백그라운드에서** Celery 워커가
임베딩을 계산·저장합니다(쓰기 응답 자체는 임베딩 계산을 기다리지 않음). 임베딩 모델이
아직 반입되지 않았거나 Ollama 가 오프라인이면 `embedding` 컬럼은 `NULL` 로 남고, 유사
검색 API 는 `embedding_available: false` 를 반환합니다 — 대시보드/쓰기 경로에는 영향
없음(agent_service 와 동일한 fail-safe 원칙).

---

## 부록 — 권장 모델

폐쇄망 운영 요약 용도는 경량 모델로 충분합니다.

- `qwen2.5:7b` (권장, 한국어 양호)
- `llama3.1:8b`
- 리소스가 빠듯하면 `qwen2.5:3b` / `gemma2:2b`

모델 변경 시 `OLLAMA_MODEL` 만 교체하고 2장 절차로 해당 모델을 적재하면 됩니다.
