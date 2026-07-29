# 폐쇄망 LLM 아키텍처 상세 — 사내 LLM + 자체 LLM 병행 운용 + K8s 로그 자동 분석 + PEP 지식 RAG

> 모델 파일/이미지의 **반입 절차**(Nexus)는 [AIRGAP_LLM_NEXUS.md](AIRGAP_LLM_NEXUS.md) 참고.
> 이 문서는 그 위에서의 **아키텍처/기능 설계**를 다룬다.
>
> **v2 (2026-07-29) — 프레임 전환: "마이그레이션" → "프로필 × 용도 라우팅 병행 운용".**
> v1 은 Ollama → vLLM(GLM) *전환*을 전제로 썼지만, 실제 요구는 **사내 제공 LLM 서비스
> (OpenAI-호환)와 인클러스터 자체 LLM(Ollama, ghcr.io 이미지 반입)을 동시에** 쓰는 것이다.
> 이에 따라 Phase 1 이 다음과 같이 **구현 완료**됐다:
>
> - `backend/app/services/llm/` — 모든 LLM 호출의 단일 게이트웨이.
>   **프로필**(provider `ollama`|`openai_compat` + base_url + model + api_key_ref +
>   timeout + max_concurrency) 여러 개를 등록하고, **용도**(`chat` / `incident_analysis` /
>   `review_summary` / `arch_doc` / `trends` / `embedding`)별로 primary/fallback 프로필을
>   라우팅한다. 예: 챗봇 → 사내 LLM, 임베딩/카드 요약 → Ollama.
> - 설정 원천은 AppSetting `llm_settings` (**Settings → AI/LLM 탭**, UI-First) — env
>   (`OLLAMA_URL`/`LLM_API_BASE`/…)는 행이 없을 때의 bootstrap 폴백.
> - API 키는 `llm_credentials` 테이블(EncryptedText 암호화)에 저장하고 프로필은
>   `credential:<name>` / `env:<VAR>` 참조 문자열만 갖는다.
> - `ANALYZER_BACKEND` raw env → `llm_settings.analyzer_backend` 로 이동 (§2.2 해소).
> - 시스템 프롬프트 한국어 기본(`services/llm/prompts.py`, `llm_settings.language`).
> - 호출량/오류/지연/토큰 통계를 Redis 시간버킷으로 적재 → `GET /llm/usage` (부하를
>   보면서 범위를 넓히는 점진 롤아웃의 데이터 소스).
>
> 갭 현황: **G1 해소** (OpenAI-호환 + 병행 운용). G2(알람 자동 분석)/G3(RAG)/G4(임베딩
> 확대)/G5(GPU 매니페스트)는 후속 Phase 에서 진행. 아래 v1 본문의 "GLM 전환" 서술은
> "openai_compat 프로필 추가"로 읽으면 된다 — vLLM 자체 서빙도, 사내 LLM 게이트웨이도
> 같은 프로필 형태로 붙는다.
>
> 작성 기준: v1.6.0 (2026-07-17), v2 개정 2026-07-29. 코드 참조는 각 기준.

---

## 0. 원칙 (설계 불변 조건)

1. **완전 폐쇄망**: 모든 추론은 내부망에서만. 외부 API(클라우드 LLM) 사용 금지 — `analyzers/claude_analyzer.py` 는 폐쇄망 배포에서 비활성.
2. **분석 전용 — 조치 권한 없음**: LLM 파이프라인은 로그/이벤트를 **읽고 분석**만 한다.
   kubectl 변경 명령(delete/apply/scale/rollout 등)을 실행하는 경로가 없어야 하며,
   산출물은 "조치 **가이드**"(사람이 수행)다. 백엔드의 수집 엔드포인트는 전부 read-only
   (`routers/analyze.py` — logs/describe/events 조회·스트리밍만).
3. **fail-safe**: LLM/임베딩 서버가 죽어도 PEP 는 계속 동작한다. 모든 호출은 예외를 삼키고
   구조화된 offline 응답을 반환 (`agent_service.py`, `embedding_service.py` 기존 패턴 유지).
4. **지식은 PEP 내부 데이터에서**: 조치 가이드의 근거는 PEP 에 등록된 내부 문서
   (작업 가이드 `work_guides`, DevOps Q&A `ops_notes`, 업무 이력 `work_items`, 서비스 지식)다.
   외부 지식 의존 최소화 — 모델의 일반 지식 + 내부 문서 검색(RAG) 조합.

---

## 1. 현재 상태 (as-is, v1.6.0)

```
Ollama (k8s/base/ollama.yaml — CPU 전용, 모델 pre-baked 이미지)
  ├─ /api/generate  ← agent_service.py (AI 클러스터 요약 카드, /agent/chat)
  ├─ /api/generate  ← analyzers/local_llm_analyzer.py (장애 분석, JSON 출력)
  └─ /api/embeddings ← embedding_service.py (nomic-embed-text, dim 768)
                        └─ pgvector: work_items.embedding, work_guides.embedding

이벤트 수집: kubewatch → POST /api/v1/events/kubewatch (push, Bearer 토큰)
  └─ k8s_event_classifier.py 로 severity 분류 → K8sEvent 저장
  └─ critical 이면 인앱 알림(UserNotification, 전체 공지)

로그/컨텍스트 조회(read-only): routers/analyze.py
  ├─ SSE 로그 스트리밍 (/pods/{pod}/logs/stream) → K8sLogsPage
  ├─ SSE 이벤트 watch (/events/stream)
  └─ 원클릭 컨텍스트 수집 (/pods/{pod}/context: logs+previous+describe+events)
       → IncidentAnalysisPage "자동 채우기"

장애 분석: POST /analyze/incident → get_analyzer() (ANALYZER_BACKend env)
  ├─ rule_based (기본값): 정규식 시그니처 8종 — 항상 가용한 fallback
  ├─ local_llm: Ollama /api/generate, JSON-only SRE 프롬프트  ← 폐쇄망 경로
  └─ claude: 클라우드 (폐쇄망 비활성)
```

**핵심 갭 (이 문서가 채우는 것):**

| # | 갭 | 위치 |
|---|---|---|
| G1 | GLM 계열/OpenAI-호환 서빙 미지원 — 코드가 Ollama API 에만 결합 | `agent_service.py`, `local_llm_analyzer.py` |
| G2 | 에러 발생 시 **자동** 분석이 없음 — IncidentAnalysisPage 에서 사람이 수동 실행 | `k8s_events.py` ↔ `analyze.py` 미연결 |
| G3 | RAG 부재 — 검색(`/work-items/{id}/similar`)과 생성(analyzer)이 분리돼 있고, 검색 결과가 프롬프트에 주입되지 않음 | `embedding_service.py` |
| G4 | 임베딩 대상이 WorkItem/WorkGuide 뿐 — OpsNote·Ontology 미색인, WorkGuide 는 검색 엔드포인트도 없음 | `models/ops_note.py` 등 |
| G5 | GPU 서빙 매니페스트 없음 — `ollama.yaml` 은 CPU 전용 | `k8s/base/`, `k8s/overlays/airgap/` |

---

## 2. 목표 아키텍처 (to-be)

```
                        ┌──────────────────────────────────────────────┐
                        │  내부 LLM 서빙 (GPU 노드, ns: k8s-monitor)     │
                        │  vLLM — OpenAI-호환 API (/v1/chat/completions)│
                        │  모델: GLM-5.2 (내부 제공)                     │
                        │  임베딩: 기존 Ollama(nomic-embed-text) 병행    │
                        └──────────────▲───────────────▲───────────────┘
                                       │               │
             ┌─────────────────────────┴──┐   ┌────────┴─────────────┐
             │ LLMCallerNode (swap point) │   │ embedding_service    │
             │ agent_service 파이프라인     │   │ (pgvector 색인/검색)  │
             └─────────────▲──────────────┘   └────────▲─────────────┘
                           │                           │ top-k 검색
┌─────────────┐   ┌────────┴───────────┐   ┌───────────┴────────────┐
│ kubewatch    │──▶│ 자동 분석 트리거      │──▶│ RAG 컨텍스트 조립         │
│ (이벤트 push) │   │ (critical 이벤트)    │   │ work_guides/ops_notes/ │
└─────────────┘   │ + IncidentContext  │   │ work_items 유사 문서    │
                  │   자동 수집(read-only)│   └───────────┬────────────┘
                  └────────────────────┘               │
                                          ┌────────────▼────────────┐
                                          │ local_llm analyzer      │
                                          │ (GLM-5.2, JSON 출력)     │
                                          │ → 원인/심각도/조치 가이드  │
                                          │   + 근거 문서 링크        │
                                          └────────────┬────────────┘
                                 분석 전용 — 조치 실행 없음 │
                              ┌───────────────┬─────────▼──────────┐
                              │ 인앱 알림       │ 분석 리포트 저장/조회  │
                              │ (링크 포함)     │ (IncidentAnalysis)  │
                              └───────────────┴────────────────────┘
```

### 2.1 서빙 계층 — GLM-5.2 를 어떻게 띄우나

내부 제공 모델이 GLM-5.2 라는 전제에서, 서빙 방식은 두 갈래다.

| 옵션 | 방식 | 적합 상황 |
|---|---|---|
| **A. vLLM (권장)** | GLM-5.2 정식 가중치(safetensors)를 vLLM 으로 서빙, **OpenAI-호환 API** 노출 | GPU 노드 확보 시. 동시성/처리량 우수, GLM 계열 공식 지원 |
| B. Ollama (현행 유지) | GLM 의 GGUF 양자화 빌드를 기존 Ollama 에 적재 | GPU 없이 소규모 검증, 기존 인프라 재사용 |

- 옵션 B 는 코드 변경이 0 (모델명만 교체)이지만 양자화 손실 + CPU 추론 속도 한계가 있다.
- 옵션 A 가 목표 상태다. `agent_service.py` 의 **`LLMCallerNode` 가 설계된 단일 교체 지점**
  (코드 주석에 "Phase 3 vLLM 마이그레이션, OpenAI-compatible endpoint" 로 명시)이며,
  `local_llm_analyzer.py` 의 `_call` 도 같은 방식으로 교체한다.

**vLLM 배포 스케치** (`k8s/base/llm-vllm.yaml` 신규 — airgap overlay 에서 이미지/모델 경로 치환):

```yaml
# Deployment 요점만 — 실제 매니페스트는 구현 시 작성
containers:
  - name: vllm
    image: <내부레지스트리>/vllm-openai:<버전>          # Nexus docker-hosted 로 반입
    args:
      - --model=/models/glm-5.2                        # PV 로 마운트된 가중치
      - --served-model-name=glm5.2
      - --max-model-len=32768                          # 로그 분석은 긴 컨텍스트 필요
      - --gpu-memory-utilization=0.90
    resources:
      limits:
        nvidia.com/gpu: "1"        # 모델 크기에 따라 1~4 (양자화/AWQ 시 절감)
    volumeMounts:
      - { name: models, mountPath: /models }           # PVC — 가중치는 Nexus raw 로 반입
nodeSelector: { gpu: "true" }      # GPU 노드 풀
```

**모델/이미지 반입**: AIRGAP_LLM_NEXUS.md 의 방식 B(raw-hosted) 를 그대로 적용 —
① 외부망에서 GLM-5.2 가중치 아카이브 + vLLM 이미지 tar 준비 → ② Nexus raw/docker 저장소
업로드 → ③ 내부에서 다운로드·적재. 체크섬(sha256) 검증을 반입 절차에 포함할 것.

**GPU 사이징 가이드** (개략 — 내부 제공 GLM-5.2 의 실제 파라미터 수 확인 후 확정):

| 규모 | 정밀도 | 필요 VRAM(대략) | 비고 |
|---|---|---|---|
| ~9B 급 | BF16 | ~20 GB (24GB 카드 1장) | 분석 용도 충분, 권장 시작점 |
| ~9B 급 | AWQ/INT4 | ~8 GB | GPU 여유 없을 때 |
| 30B+ 급 | BF16 | 80 GB+ (멀티 GPU) | 필요성 검증 후 |

### 2.2 백엔드 설정 계층 — 신규 환경변수 설계

`Settings`(config.py) 에 **provider 추상화**를 추가한다. 기본값이 현행과 동일해
기존 배포는 무변경으로 동작한다.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` \| `openai_compat` — 생성(추론) 경로 선택 |
| `LLM_API_BASE` | *(empty)* | openai_compat 일 때 base URL (예: `http://vllm:8000/v1`) |
| `LLM_API_KEY` | *(empty)* | vLLM `--api-key` 사용 시 |
| `LLM_MODEL` | *(empty)* | openai_compat 모델명 (예: `glm5.2`) — 비면 `OLLAMA_MODEL` 사용 |
| `ANALYZER_BACKEND` | `rule_based` | 폐쇄망 운영값: `local_llm` (Settings 편입 권장 — 현재 raw `os.getenv`) |
| `AUTO_ANALYZE_ENABLED` | `false` | critical 이벤트 자동 분석 on/off (§3) |
| `AUTO_ANALYZE_MIN_INTERVAL_SECONDS` | `600` | 같은 리소스 재분석 최소 간격 (폭주 방지) |

임베딩은 당분간 Ollama(`nomic-embed-text`) 유지 — GLM 임베딩 모델로 교체할 경우
`EMBEDDING_DIM` 이 바뀌므로 기존 벡터 전량 재계산이 필요하다(config.py 주석 참고).

---

## 3. K8s 로그 모니터링 + 에러 자동 분석 (분석 전용)

### 3.1 트리거 — 이미 있는 kubewatch 파이프라인에 연결

현재 `POST /events/kubewatch` 는 critical 이벤트에 인앱 알림만 만든다. 여기에
**자동 분석 훅**을 추가한다 (G2 해소):

```
kubewatch → /events/kubewatch (severity=critical: OOMKilling, CrashLoopBackOff,
                               NodeNotReady, Evicted, FailedCreatePodSandBox ...)
   └─ AUTO_ANALYZE_ENABLED 이면 Celery task `run_auto_incident_analysis` enqueue
        1. 디바운스: (cluster, namespace, resource) 별 최소 간격 검사 (Redis key)
        2. IncidentContext 자동 수집 — analyze.py 의 기존 read-only 수집 로직 재사용
           (current logs + previous logs + describe + 최근 events)
        3. RAG 컨텍스트 조립 (§4) — 유사 내부 문서 top-k
        4. get_analyzer().analyze(ctx) — local_llm(GLM-5.2), JSON 출력
        5. 결과 저장 (신규 모델 incident_analysis: 이벤트 FK, severity, root_cause,
           suggested_actions, related_runbooks(내부 문서 링크), confidence, model)
        6. 인앱 알림 업그레이드: "OOMKilling 발생 → AI 분석 완료" + 리포트 링크
```

- **실행 주체는 Celery worker** (LLM 추론이 느리므로 웹훅 응답 경로에서 분리).
- rule_based 분석기가 **항상 fallback**: LLM offline 이면 규칙 기반 결과라도 저장
  (`analyzed_by` 필드로 구분 — UI 배지 표기 기존 지원).

### 3.2 권한 경계 (조치 권한 없음 — 강제 장치)

| 계층 | 장치 |
|---|---|
| API | 자동 분석이 사용하는 엔드포인트/서비스 함수는 전부 조회 계열 (`read_namespaced_pod_log`, `list_namespaced_event`, describe). 변경 계열 K8s 호출을 analyzer 경로에 두지 않는다 |
| ServiceAccount | in-cluster 배포 시 분석용 SA 는 `get/list/watch` 만 가진 ClusterRole 바인딩 (기존 `k8s/base/backend/serviceaccount.yaml` 검토·분리) |
| 프롬프트/출력 | analyzer JSON 스키마에 "실행" 필드가 없음 — `suggested_actions` 는 사람이 읽는 텍스트. 출력에 포함된 명령은 UI 에서 복사만 가능(자동 실행 버튼 금지) |
| 마스킹 | 수집 컨텍스트에서 Secret/token 패턴 마스킹 후 LLM 전달 (k8s_resources 의 Secret 마스킹 로직 재사용) |

### 3.3 UI

- **IncidentAnalysisPage** (기존): 수동 분석 유지 + "자동 분석 이력" 탭 추가 —
  `incident_analysis` 목록/상세 (이벤트, 분석 결과, 근거 문서 링크).
- **K8sEventsPage** (기존): critical 이벤트 행에 "AI 분석 보기" 배지/링크.
- 알림 클릭 → 해당 분석 리포트로 딥링크.

---

## 4. PEP 내부 문서 RAG (지식 주입)

### 4.1 색인 확대 (G4 해소)

| 소스 | 테이블 | 현재 | 조치 |
|---|---|---|---|
| 작업 가이드 (지식 허브) | `work_guides` | 임베딩 O, 검색 API X | `/work-guides/search?q=` 유사 검색 엔드포인트 추가 |
| DevOps Q&A / 업무 메모 | `ops_notes` | 임베딩 X | `embedding` 컬럼(pgvector) + Celery 재계산 태스크 추가 |
| 업무 이력 | `work_items` | 임베딩 O, `/similar` O | 그대로 활용 |
| LAKE 서비스 지식 | `service_entries` 등 | 임베딩 X | 2차 확장 대상 |

색인은 기존 패턴 그대로: 저장/수정 커밋 후 `compute_*_embedding` Celery 태스크로
비동기 재계산, 실패해도 본 기능에 영향 없음.

### 4.2 검색→프롬프트 주입 (G3 해소)

신규 서비스 `rag_service.py` (설계):

```
retrieve(context_text, k=4) →
  1. embedding_service.embed(에러 reason + 로그 요약 상위 N줄)
  2. work_guides / ops_notes / work_items 에서 cosine_distance top-k (테이블별 상한)
  3. [{title, source_type, url(내부 라우트), snippet, similarity}] 반환
```

analyzer 프롬프트에 주입:

```
### 사내 관련 문서 (조치 가이드 작성 시 우선 참조)
[1] (작업 가이드) OOM 발생 시 표준 대응 — /work-guides/42
    "...메모리 limit 상향 전에 힙덤프 확보..."
[2] (Q&A) 배치 파드 OOMKilled 재발 건 — /ops-notes/17
...
위 문서와 일반 지식을 종합해 분석하되, 문서를 인용했으면 related_runbooks 에
해당 내부 링크를 반드시 포함하라.
```

`related_runbooks` 가 내부 라우트(딥링크)로 채워지므로, 운영자는 분석 리포트에서
바로 사내 문서로 이동한다. **PEP 에 문서가 쌓일수록 분석 품질이 올라가는 구조.**

---

## 5. 구현 로드맵

| Phase | 내용 | 변경 파일(예상) |
|---|---|---|
| **0. 서빙 준비** | GLM-5.2 가중치/vLLM 이미지 Nexus 반입, GPU 노드 라벨링, `k8s/base/llm-vllm.yaml` + airgap overlay | k8s/, helm/ |
| **1. Provider 추상화** | `LLM_PROVIDER=openai_compat` 지원 — `LLMCallerNode`·`local_llm_analyzer._call` 에 OpenAI-호환 chat 호출 추가 (httpx 직접, SDK 불필요), health check 확장 | config.py, agent_service.py, local_llm_analyzer.py |
| **2. 자동 분석 파이프라인** | `run_auto_incident_analysis` Celery 태스크 + 디바운스, `incident_analysis` 모델(+`_safe_*` 마이그레이션, backup LOG_TABLES 등록), 알림 연동, UI 이력 탭 | celery_app.py, k8s_events.py, models/, analyze.py, IncidentAnalysisPage |
| **3. RAG** | ops_notes 임베딩, work_guides 검색 API, `rag_service.py`, analyzer 프롬프트 주입 + related_runbooks 내부 링크 | embedding_service.py, rag_service.py(신규), ops_note.py, work_guide.py |
| **4. 품질/운영** | 분석 품질 피드백(👍/👎 — reactions 재사용), 프롬프트 튜닝, 마스킹 규칙 점검, 부하 테스트 | — |

각 Phase 는 독립 배포 가능. Phase 1 완료 시점부터 GLM-5.2 로 기존 기능(요약 카드,
수동 장애 분석)이 동작하고, Phase 2 부터 자동 분석이 켜진다.

## 6. 운영 체크리스트

- [ ] GLM-5.2 가중치 sha256 검증 후 Nexus 등록 (반입 대장 기록)
- [ ] vLLM `/v1/models` 응답에 `glm5.2` 확인 → `GET /api/v1/agent/health` OK
- [ ] `ANALYZER_BACKEND=local_llm`, `LLM_PROVIDER=openai_compat` 설정 후
      `GET /api/v1/analyze/health` 에서 backend/available 확인
- [ ] 분석용 ServiceAccount 권한이 get/list/watch 뿐인지 `kubectl auth can-i` 로 확인
- [ ] LLM 중단 시 rule_based fallback 으로 자동 분석이 계속 저장되는지 확인
- [ ] Secret 마스킹: 분석 리포트 원문에 토큰/패스워드 패턴이 없는지 샘플 점검
- [ ] `AUTO_ANALYZE_MIN_INTERVAL_SECONDS` 로 CrashLoopBackOff 폭주 시 분석 큐 안정 확인
