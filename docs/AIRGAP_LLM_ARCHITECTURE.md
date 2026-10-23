# 폐쇄망 LLM 아키텍처 상세 — 사내 LLM + 자체 LLM 병행 운용 + K8s 로그 자동 분석 + PEP 지식 RAG

> 모델 파일/이미지의 **반입 절차**(Nexus)는 [AIRGAP_LLM_NEXUS.md](AIRGAP_LLM_NEXUS.md) 참고.
> 이 문서는 그 위에서의 **아키텍처/기능 설계**를 다룬다.
> 챗봇 연동 트러블슈팅·프로필 설정 예시는 [LLM_CHATBOT_SETUP.md](LLM_CHATBOT_SETUP.md).
>
> **v3 (2026-10-21) — 현행화 + 안전장치 보강.** 문서가 v1.6.0 시점에 머물러 있던 부분을 코드
> 기준으로 고쳤다(§1 as-is, §2.2 설정 계층, §6 체크리스트). 함께 반영한 구현:
>
> - **규칙 기반 대체 결과** — LLM 호출·파싱 실패 시 `RuleBasedAnalyzer` 결과로 채운다
>   (`analyzed_by=rule_based:fallback:…`, `degraded=True`). 이전엔 "LLM 분석 불가" 한 줄만 남았다.
> - **LLM 워커 전용 읽기 전용 SA** — `celery-worker-llm` 이 `k8s-monitor-llm-sa`(get/list/watch +
>   `pods/log`)를 쓴다. 공용 SA 의 exec·pod 생성/삭제·event 생성 권한을 갖지 않는다.
> - **구조화 출력** — 장애 분석 JSON 을 생성 단계에서 스키마로 강제한다(Ollama `format` /
>   OpenAI-호환 `response_format`, 미지원 서버는 HTTP 400 → 스키마 없이 자동 재시도).
> - **로그 속 지시문 방어** — 로그·이벤트·describe 를 `<<<수집 데이터 시작/끝>>>` 경계로 감싸고
>   시스템 프롬프트가 경계 안의 지시를 따르지 않게 한다(`prompts.wrap_untrusted`).
> - **Ollama 모델명 자동 해석 + 연결 진단** — `POST /llm/diagnose`(SSE 7단계), `pep-k8s-ops` 파생 모델,
>   CPU 없는 클러스터용 `deploy/k8s/components/no-ollama`.
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
> 갭 현황: **G1~G4 해소** (OpenAI-호환 병행 운용 / 알람·K8s 이벤트 양쪽 자동 분석 /
> RAG 근거 인용 / 임베딩 4종 색인 완료 — §1 갭 표 참고). G5(GPU 매니페스트)는 opt-in
> kustomize component 로 부분 해소. 아래 v1 본문의 "GLM 전환" 서술은
> "openai_compat 프로필 추가"로 읽으면 된다 — vLLM 자체 서빙도, 사내 LLM 게이트웨이도
> 같은 프로필 형태로 붙는다.
>
> 작성 기준: v1.6.0 (2026-07-17), v2 개정 2026-07-29, K8s 이벤트 직접 트리거·Ontology
> RAG 확장 반영 2026-07-30, v3 현행화 2026-10-21. 코드 참조는 각 기준.

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

## 1. 현재 상태 (as-is, 2026-10)

```
Settings → AI/LLM (AppSetting llm_settings — UI-First, env 는 행이 없을 때의 초기값)
  └─ services/llm/ 게이트웨이 — 프로필(ollama | openai_compat) × 용도(chat · incident_analysis ·
       review_summary · arch_doc · trends · embedding) 의 primary → fallback 라우팅
       ├─ ollama_provider    /api/generate · /api/embeddings · /api/tags (모델명 자동 해석)
       ├─ openai_provider    {base_url}/v1/chat/completions · /v1/embeddings · /v1/models
       ├─ masking.py         프롬프트 진입점 시크릿 마스킹
       └─ prompts.py         용도별 한국어 시스템 프롬프트 + 수집 데이터 경계(wrap_untrusted)

호출부: agent_service(/agent/chat·stream, AI 요약 카드) · analyzers/local_llm_analyzer(장애 분석,
        JSON 스키마 강제, 실패 시 rule_based 대체) · rag_service(근거 인용) · trends · arch_doc

자동 분석: 알람(AlertEvent) / K8s 이벤트(kubewatch) → analysis_hook(llm_analysis_scope 규칙·디바운스·
        레이트) → Celery `llm` 큐(celery-worker-llm, 읽기 전용 SA) → IncidentAnalysis 저장 → 알림

서빙: 인클러스터 Ollama(CPU, qwen2.5-coder:7b + pep-k8s-ops pre-baked) — opt-out 은 components/no-ollama
      GPU 서빙은 opt-in components/vllm-gpu, 사내 LLM 은 openai_compat 프로필로 연결
```

<details>
<summary>v1.6.0 시점 as-is (기록용)</summary>

```
Ollama (deploy/k8s/base/ollama.yaml — CPU 전용, 모델 pre-baked 이미지)
  ├─ /api/generate  ← agent_service.py (AI 클러스터 요약 카드, /agent/chat)
  ├─ /api/generate  ← analyzers/local_llm_analyzer.py (장애 분석, JSON 출력)
  └─ /api/embeddings ← embedding_service.py (nomic-embed-text, dim 768)
장애 분석: POST /analyze/incident → get_analyzer() (ANALYZER_BACKEND env)
```

</details>

**핵심 갭 (이 문서가 채우는 것) — 현황 (2026-07-30, Phase 1~4 반영):**

| # | 갭 | 위치 | 상태 |
|---|---|---|---|
| G1 | GLM 계열/OpenAI-호환 서빙 미지원 — 코드가 Ollama API 에만 결합 | `agent_service.py`, `local_llm_analyzer.py` | ✅ **해소** — `services/llm/` 게이트웨이(프로필×용도 라우팅), `openai_provider.py` |
| G2 | 에러 발생 시 **자동** 분석이 없음 — IncidentAnalysisPage 에서 사람이 수동 실행 | `k8s_events.py` ↔ `analyze.py` 미연결 | ✅ **해소** — `services/observability/analysis_hook.py` + `AlertNotifyRule`/`llm_analysis_scope` 매칭 → 전용 `llm` 큐. 규칙마다 `sources`(알람/K8s 이벤트) 로 적용 파이프라인 선택 — kubewatch 로 수신된 K8s 이벤트도 알람을 거치지 않고 직접 트리거(`maybe_enqueue_analysis_for_k8s_event`, `run_auto_incident_analysis_k8s_event`), 같은 대상은 공유 디바운스 키로 중복 방지 |
| G3 | RAG 부재 — 검색(`/work-items/{id}/similar`)과 생성(analyzer)이 분리돼 있고, 검색 결과가 프롬프트에 주입되지 않음 | `embedding_service.py` | ✅ **해소** — `services/rag_service.py`, `AnalysisResult.citations`, 챗봇 응답 `citations`, 프롬프트에 참고자료 블록 주입 |
| G4 | 임베딩 대상이 WorkItem/WorkGuide 뿐 — OpsNote·Ontology 미색인, WorkGuide 는 검색 엔드포인트도 없음 | `models/ops_note.py` 등 | ✅ **해소** — OpsNote 임베딩 추가(`compute_ops_note_embedding`) + `GET /llm/rag-search` 검색 엔드포인트 신설 + Ontology(`OntologyEvent`, 구성변경 영향분석 이력) 임베딩 추가(`compute_ontology_event_embedding`, `POST /ontology/impact` 커밋 직후 큐잉) — RAG 소스 4종(work_guide/work_item/ops_note/ontology_event) 전부 색인 |
| G5 | GPU 서빙 매니페스트 없음 — `ollama.yaml` 은 CPU 전용 | `deploy/k8s/base/`, `deploy/k8s/overlays/airgap/` | 🟡 **부분 해소** — opt-in kustomize component `deploy/k8s/components/vllm-gpu/`(nvidia.com/gpu + PVC) 추가, base 는 여전히 CPU 전용(의도적 — GPU 는 오버레이 opt-in) |

추가로 이번 구현에서 해소된 갭(당초 목록에 없었으나 진단에서 발견):
- **부하 제어 부재** → `llm_analysis_scope`(전역 기본 꺼짐, 디바운스+레이트) + 전용 `llm` Celery 큐 + 사용량 대시보드(`GET /llm/usage`)
- **UI-First 위반**(LLM 설정이 env 전용) → Settings → AI/LLM 탭 + AppSetting `llm_settings`
- **무실행 보증이 관례뿐** → `tests/test_no_execution_guard.py`(AST import 그래프) + `services/llm/masking.py`(프롬프트 진입점 일괄 시크릿 마스킹)
- **한국어 불일치** → `services/llm/prompts.py` 한국어 기본 시스템 프롬프트, `AgentChat.tsx` 전면 한국어화
- **(v3) LLM 장애 시 자동 분석 공백** → `LocalLLMAnalyzer._rule_based_fallback` — 규칙 기반 원인 후보·조치 가이드로 채움
- **(v3) 권한 차원의 무실행 보증 부재** → `deploy/k8s/base/celery/llm-serviceaccount.yaml`(Helm `serviceAccount.llmName`)
- **(v3) JSON 파싱 실패로 인한 degraded 결과** → `INCIDENT_ANALYSIS_SCHEMA` 구조화 출력
- **(v3) 로그 속 지시문(prompt injection)** → `prompts.wrap_untrusted` + `UNTRUSTED_DATA_RULE_*`

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
│ (이벤트 push) │   │ (알람 경유 또는      │   │ work_guides/ops_notes/ │
└─────────────┘   │  K8s 이벤트 직접)    │   │ work_items/ontology_   │
                  │ + IncidentContext  │   │ events 유사 문서        │
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
- 옵션 A 가 목표 상태다. (v3) 교체 지점은 이제 코드가 아니라 **`services/llm/` 게이트웨이의 프로필**이다 —
  vLLM 을 띄우고 Settings → AI/LLM 에 `openai_compat` 프로필을 추가해 용도별 라우팅만 바꾸면 된다.
  (v1 의 `LLMCallerNode`·`_call` 교체 계획은 게이트웨이 도입으로 해소됐다.)

**vLLM 배포 스케치** (실제 매니페스트는 opt-in 컴포넌트 `deploy/k8s/components/vllm-gpu/` — airgap overlay 에서 이미지/모델 경로 치환):

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
      - --enable-prefix-caching                        # (v3) 매 호출이 같은 시스템 프롬프트로 시작 — 첫 토큰 지연 절감
      # GPU 사양에 맞춰 --quantization=awq|fp8 검토 (VRAM 절감)
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

### 2.2 백엔드 설정 계층 (v3 현행)

v1 의 `LLM_PROVIDER` / `AUTO_ANALYZE_ENABLED` / `AUTO_ANALYZE_MIN_INTERVAL_SECONDS` 환경변수 설계는
**구현되지 않았고 앞으로도 쓰지 않는다** — UI-First 원칙에 따라 화면 설정으로 대체됐다.

| 설정 | 원천 | 비고 |
|---|---|---|
| 프로필(provider·base_url·model·키 참조·타임아웃·동시성) | Settings → AI/LLM (AppSetting `llm_settings`) | 저장 후에는 env 를 덮는다 |
| 용도별 라우팅(primary/fallback), 분석기 백엔드, 응답 언어, 임베딩 모델 | 같은 곳 | `ANALYZER_BACKEND` env 는 초기값 |
| 자동 분석 on/off·규칙·디바운스·시간당 상한 | Settings → AI/LLM → 알람 자동 분석 범위 (AppSetting `llm_analysis_scope`) | 전역 기본 꺼짐 |
| API 키 | `llm_credentials`(암호화) → 프로필은 `credential:<name>` 참조 | 원문 재표시 없음 |

환경변수는 AppSetting 행이 없을 때의 **초기값**뿐이다(전체 목록 `docs/ENVIRONMENT.md`):

| 변수 | 예시 | 주의 |
|---|---|---|
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://ollama:11434` / `qwen2.5-coder:7b` | 모델명은 `ollama list` 기준 |
| `LLM_API_BASE` | `http://vllm:8000` | **`/v1` 을 붙이지 않는다** — provider 가 `/v1/chat/completions` 를 붙인다 (v1 문서의 `.../v1` 예시는 404) |
| `LLM_API_KEY` / `LLM_MODEL` / `LLM_TIMEOUT` | — / `glm5.2` / `120` | 키는 `env:LLM_API_KEY` 참조로만 |
| `EMBEDDING_MODEL` / `EMBEDDING_DIM` | `nomic-embed-text` / `768` | 차원 변경 = 벡터 컬럼 재생성 + 전량 재계산 |

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
  (v3 현행) 트리거 판정은 `services/observability/analysis_hook.py` 의 `llm_analysis_scope` 규칙
  (알람·K8s 이벤트 공통 디바운스 키·레이트), 실행은 전용 `llm` 큐의 `run_auto_incident_analysis(_k8s_event)`,
  결과는 `IncidentAnalysis` 모델에 저장된다. 위 의사코드의 `AUTO_ANALYZE_*` env 는 쓰지 않는다.
- rule_based 분석기가 **항상 fallback** (v3 구현): LLM 호출·응답 파싱이 실패하면 규칙 기반 결과로
  원인 후보·조치 가이드를 채운다. `analyzed_by=rule_based:fallback:<원래 분석기>`,
  `degraded=True` 라 자동 분석 행은 `failed` + 사유로 남고 UI 는 "규칙 기반 (LLM 대체)" 로 표시한다.

### 3.2 권한 경계 (조치 권한 없음 — 강제 장치)

| 계층 | 장치 |
|---|---|
| API | 자동 분석이 사용하는 엔드포인트/서비스 함수는 전부 조회 계열 (`read_namespaced_pod_log`, `list_namespaced_event`, describe). 변경 계열 K8s 호출을 analyzer 경로에 두지 않는다 |
| ServiceAccount | (v3 구현) `celery-worker-llm` 은 `k8s-monitor-llm-sa` — `get/list/watch` + `pods/log get` 만 가진 ClusterRole(`deploy/k8s/base/celery/llm-serviceaccount.yaml`, Helm `serviceAccount.llmName`). 등록 클러스터를 DB kubeconfig 로 조회할 때는 그 kubeconfig 권한이 쓰이므로, 분석 대상 클러스터용 kubeconfig 도 읽기 전용 계정으로 발급하는 것을 권장한다 |
| 프롬프트/출력 | analyzer JSON 스키마(`INCIDENT_ANALYSIS_SCHEMA`, 생성 단계에서 강제)에 "실행" 필드가 없음 — `suggested_actions` 는 사람이 읽는 텍스트. 출력에 포함된 명령은 UI 에서 복사만 가능(자동 실행 버튼 금지) |
| 수집 데이터 경계 | (v3 구현) 로그·이벤트·describe·챗 컨텍스트를 `wrap_untrusted` 로 감싸고, 시스템 프롬프트가 경계 안 지시를 따르지 않게 한다. 데이터 속 경계 표지는 무력화한다 |
| 마스킹 | 수집 컨텍스트에서 Secret/token 패턴 마스킹 후 LLM 전달 (`services/llm/masking.py`, 게이트웨이 진입점 일괄 적용) |

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
| 작업 가이드 (지식 허브) | `work_guides` | 임베딩 O, 검색 API O | `GET /llm/rag-search?q=` 공용 검색 엔드포인트로 해소 |
| DevOps Q&A / 업무 메모 | `ops_notes` | 임베딩 O | `embedding` 컬럼(pgvector) + `compute_ops_note_embedding` Celery 재계산 태스크 |
| 업무 이력 | `work_items` | 임베딩 O, `/similar` O | 그대로 활용 |
| 구성변경 영향분석 이력 | `ontology_events` | 임베딩 O | `embedding` 컬럼(pgvector) + `compute_ontology_event_embedding` — `POST /ontology/impact` 커밋 직후 큐잉 |
| LAKE 서비스 지식 | `service_entries` 등 | 임베딩 X | 2차 확장 대상 |

색인은 기존 패턴 그대로: 저장/수정 커밋 후 `compute_*_embedding` Celery 태스크로
비동기 재계산, 실패해도 본 기능에 영향 없음.

### 4.2 검색→프롬프트 주입 (G3 해소)

`rag_service.py`:

```
retrieve(db, query_text, k=4) →
  1. embedding_service.embed(query_text)
  2. work_guides / work_items / ops_notes / ontology_events 에서 cosine_distance top-k (테이블별 상한)
  3. [{title, source_type, ref_id, route(내부 라우트), snippet, similarity}] 반환,
     유사도 < MIN_SIMILARITY(0.35) 는 근거로 채택하지 않음
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
| **0. 서빙 준비** | GLM-5.2 가중치/vLLM 이미지 Nexus 반입, GPU 노드 라벨링, `deploy/k8s/base/llm-vllm.yaml` + airgap overlay | k8s/, helm/ |
| **1. Provider 추상화** | `LLM_PROVIDER=openai_compat` 지원 — `LLMCallerNode`·`local_llm_analyzer._call` 에 OpenAI-호환 chat 호출 추가 (httpx 직접, SDK 불필요), health check 확장 | config.py, agent_service.py, local_llm_analyzer.py |
| **2. 자동 분석 파이프라인** | `run_auto_incident_analysis` Celery 태스크 + 디바운스, `incident_analysis` 모델(+`_safe_*` 마이그레이션, backup LOG_TABLES 등록), 알림 연동, UI 이력 탭 | celery_app.py, k8s_events.py, models/, analyze.py, IncidentAnalysisPage |
| **3. RAG** | ops_notes 임베딩, work_guides 검색 API, `rag_service.py`, analyzer 프롬프트 주입 + related_runbooks 내부 링크 | embedding_service.py, rag_service.py(신규), ops_note.py, work_guide.py |
| **4. 품질/운영** | 분석 품질 피드백(👍/👎 — reactions 재사용), 프롬프트 튜닝, 마스킹 규칙 점검, 부하 테스트 | — |

**진행 현황 (v3)**: Phase 1~3 완료(게이트웨이·자동 분석·RAG 4종), Phase 4 는 일부(마스킹·부하 제어 완료,
품질 피드백·회귀 평가 미완). 다음 단계:

| Phase | 내용 | 비고 |
|---|---|---|
| **5. RAG 기반 보강** | `work_items`·`ops_notes`·`ontology_events` 에 HNSW 인덱스(현재 `work_guides` 만), 문서 청크 분할 임베딩·청크 단위 인용 | 데이터가 쌓이면 검색 1회가 전체 스캔 |
| **6. 검색 품질** | 다국어 임베딩(예: bge-m3, 1024차원) 전환 + Postgres 전문 검색과의 하이브리드 + 재정렬(reranker) | `EMBEDDING_DIM` 변경 = 컬럼 재생성·재계산 별도 계획 |
| **7. 대화·도구** | 멀티턴 messages API(Ollama `/api/chat`), 조회 전용 도구 호출(로그·describe·events) | 도구 호출은 GPU 서빙/사내 LLM 이후, 무실행 가드 유지 |
| **8. 품질 관측** | 분석 1건 단위 프롬프트 버전·모델·근거·피드백 저장, 골든 장애 세트로 모델 교체 회귀 평가 | 모델 세대 교체의 판단 근거 |

각 Phase 는 독립 배포 가능. Phase 1 완료 시점부터 GLM-5.2 로 기존 기능(요약 카드,
수동 장애 분석)이 동작하고, Phase 2 부터 자동 분석이 켜진다.

## 6. 운영 체크리스트

- [ ] 가중치·이미지 sha256 검증 후 Nexus 등록 (반입 대장 기록)
- [ ] vLLM `/v1/models` 에 서빙 모델명 확인 → Settings → AI/LLM 에 `openai_compat` 프로필 추가
      (base_url 에 `/v1` 붙이지 않기) → 프로필 행 **연결 진단 실행** 7단계 통과
- [ ] 용도별 라우팅에서 `incident_analysis`·`chat` primary 지정, 분석기 백엔드 `local_llm`
      → `GET /api/v1/analyze/health` 에서 backend/available 확인
- [ ] `kubectl auth can-i create pods --subresource=exec --as=system:serviceaccount:<ns>:k8s-monitor-llm-sa` 가 `no` 인지 확인
- [ ] LLM 을 내린 상태에서 자동 분석 1건 → `analyzed_by=rule_based:fallback:…` 결과가 남는지 확인
- [ ] Secret 마스킹: 분석 리포트 원문에 토큰/패스워드 패턴이 없는지 샘플 점검
- [ ] 알람 자동 분석 범위의 디바운스·시간당 상한으로 CrashLoopBackOff 폭주 시 `llm` 큐 안정 확인
