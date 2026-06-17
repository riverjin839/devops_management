# 폐쇄망 LLM 셋업 가이드 — Ollama 모델을 Nexus 로 수급하기

> 대시보드의 **AI 클러스터 상태 요약** 아이템(`ai_cluster_summary`)은 사내 **Ollama** LLM 을
> 호출해 최근 점검 데이터를 요약하고 위험도를 산출합니다. 폐쇄망에서는 인터넷
> (`registry.ollama.ai`)에 직접 접근할 수 없으므로, **Nexus** 를 통해 모델을 수급합니다.
>
> 이 문서는 Ollama 배포 → Nexus 로 모델 수급 → 백엔드 연동 → AI 아이템 사용까지의
> 전체 절차를 다룹니다.

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
| `OLLAMA_MODEL` | `qwen2.5:7b` | 적재한 모델 이름 (별칭 권장) |
| `OLLAMA_TIMEOUT` | `120` | LLM 요청 타임아웃(초) |

`OLLAMA_MODEL` 은 `"qwen2.5"` 처럼 base 만 적어도 `qwen2.5:7b` 와 매칭됩니다
(`agent_service.health_check` 가 base 이름 비교를 지원).

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

## 부록 — 권장 모델

폐쇄망 운영 요약 용도는 경량 모델로 충분합니다.

- `qwen2.5:7b` (권장, 한국어 양호)
- `llama3.1:8b`
- 리소스가 빠듯하면 `qwen2.5:3b` / `gemma2:2b`

모델 변경 시 `OLLAMA_MODEL` 만 교체하고 2장 절차로 해당 모델을 적재하면 됩니다.
