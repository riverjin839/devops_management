# LLM 에이전트로 K8s 운영하기 — GPU 서빙 모델 연결 · 자동화 단계 · 설정 가이드

B300 GPU 서버의 `ai-serving` 네임스페이스에 떠 있는 모델들을 PEP 에 연결하고,
K8s 운영을 **관찰 → 분석 → 제안 → 승인 실행 → 제한적 자동 실행** 순서로 LLM 에이전트에 넘기는 방법을 정리한다.

> 관련 문서 — 아키텍처: [AIRGAP_LLM_ARCHITECTURE.md](AIRGAP_LLM_ARCHITECTURE.md) ·
> 챗봇 트러블슈팅: [LLM_CHATBOT_SETUP.md](LLM_CHATBOT_SETUP.md) · 모델 반입: [AIRGAP_LLM_NEXUS.md](AIRGAP_LLM_NEXUS.md)

---

## 0. 한 장 요약

| 질문 | 답 |
|---|---|
| 모델을 어떻게 붙이나 | 각 모델의 OpenAI 호환 엔드포인트를 PEP **Settings → AI/LLM** 에 `openai_compat` 프로필로 등록한다. 코드 수정 없음. |
| 어떤 주소로 붙이나 | PEP 와 같은 클러스터면 **클러스터 내부 Service DNS**, 다른 클러스터면 **HTTPRoute + 인증**. 외부 공개 주소를 그대로 쓰지 않는다. |
| 지금 바로 되는 것 | 챗봇(질의응답), 알람·K8s 이벤트 **자동 원인 분석**(읽기 전용), 리뷰 요약, 트렌드 요약, 임베딩 RAG. |
| 아직 없는 것 | LLM 이 **도구를 호출해 클러스터를 직접 조회·조치하는 에이전트**. PEP 의 분석기는 설계상 조치 권한이 없다. §5 의 단계로 새로 만든다. |
| 핵심 원칙 | LLM 은 **제안**하고, 실행은 PEP 에 등록된 **런북(배치잡·플레이북·스크립트)** 만, **사람 승인** 후에. 자동 실행은 검증된 소수 런북에만 단계적으로 연다. |

```
                ┌──────────── ai-serving (B300) ────────────┐
                │ deepseek-v4.1-flash  glm-5.3-flash         │
 PEP backend ──▶│ gpt-oss-20b          qwen3.6-36b           │  OpenAI 호환 /v1/*
 (LLM 게이트웨이)│ paddleocr                                  │
                └────────────────────────────────────────────┘
      ▲   용도(purpose)별 primary → fallback 라우팅
      │
 ┌────┴───────────────────────────────────────────────────────────────┐
 │ 입력: Alertmanager · kubewatch · 점검 매트릭스 결과 · 사용자 채팅      │
 │ L0 관찰/분석(지금)  →  L1 도구 조회  →  L2 런북 제안+승인  →  L3 제한 자동 │
 └────────────────────────────────────────────────────────────────────┘
      │ 실행은 PEP 런북 경로만 (배치잡 · 플레이북 · 스크립트) — 실행 로그·감사 로그 남음
      ▼
   대상 K8s 클러스터 (용도별로 분리된 ServiceAccount 권한)
```

---

## 1. 1단계 — 서빙 엔드포인트 점검

PEP 를 붙이기 전에 각 모델이 **OpenAI 호환 API** 로 응답하는지, **도구 호출(tool calling)** 이 켜져 있는지 확인한다.

### 1.1 주소 정하기

| PEP 위치 | 쓸 주소 | 이유 |
|---|---|---|
| 같은 클러스터 | `http://<svc>.ai-serving.svc.cluster.local:<port>` | 게이트웨이 홉·TLS·외부 노출이 없다. 가장 빠르고 안전. |
| 다른 클러스터 | HTTPRoute 호스트 (`https://llm.<사내도메인>/<모델>`) | 반드시 인증(API 키 또는 mTLS) + 소스 IP 제한을 건다. |

> PEP 프로필의 `base_url` 에는 **`/v1` 을 붙이지 않는다** — provider 가 `/v1/chat/completions` 를 붙인다.
> HTTPRoute 가 경로 접두사로 모델을 나눈다면(`/deepseek/v1/...`) `base_url` 은 `https://llm.<도메인>/deepseek` 까지다.

### 1.2 확인 명령

```bash
kubectl -n ai-serving get pods,svc,httproute -o wide
```

```bash
kubectl -n ai-serving run llm-probe --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s http://<svc>.ai-serving.svc.cluster.local:<port>/v1/models
```

도구 호출 지원 여부 — 응답에 `tool_calls` 가 오면 통과다.

```bash
curl -s http://<svc>:<port>/v1/chat/completions -H 'Content-Type: application/json' -d '{
  "model": "<served-model-name>",
  "messages": [{"role": "user", "content": "default 네임스페이스 파드 목록을 보여줘"}],
  "tools": [{"type": "function", "function": {
    "name": "list_pods", "description": "네임스페이스의 파드 목록",
    "parameters": {"type": "object", "properties": {"namespace": {"type": "string"}}, "required": ["namespace"]}}}],
  "tool_choice": "auto"
}' | jq '.choices[0].message'
```

- `tool_calls` 대신 본문에 JSON 텍스트가 오면 서빙 엔진의 **도구 호출 파서가 꺼져 있거나 모델과 맞지 않는** 것이다.
  vLLM 계열이면 `--enable-auto-tool-choice` 와 모델 계열에 맞는 `--tool-call-parser` 를 켠다
  (파서 이름은 엔진 버전·모델마다 다르다 — 쓰는 버전의 문서에서 확인).
- `/v1/models` 의 `id` 가 PEP 프로필 `model` 에 넣을 이름이다(`--served-model-name`).
- 스트리밍을 쓰므로 HTTPRoute 의 요청 타임아웃을 응답 생성 시간보다 길게(예: 300s) 잡는다. 짧으면 긴 분석이 중간에 끊긴다.

### 1.3 모델별 역할 (초안 — §7 평가로 확정)

| 모델 | 1순위 용도 | 메모 |
|---|---|---|
| **gpt-oss-20b** | 빠른 1차 분류·요약, 챗 fallback | 가볍고 빠름. 알람 폭주 때 1차 분류를 맡겨 큰 모델 부하를 줄인다. |
| **glm-5.3-flash** | 에이전트 주력(도구 호출·다단계 추론), 장애 분석 | 도구 호출 정확도를 §7 에서 먼저 확인. |
| **deepseek-v4.1-flash** | 장애 분석 primary 또는 glm 의 fallback | 두 모델을 primary/fallback 으로 교차 배치해 한쪽 장애에 대비. |
| **qwen3.6-36b** | 매니페스트·스크립트·PromQL 작성, 코드 리뷰 요약 | 런북 초안·YAML diff 설명에 쓴다. 직접 실행은 하지 않는다. |
| **paddleocr** | 문서·스크린샷 OCR → 지식 색인 | LLM 프로필이 아니다. 장애 캡처·랙 사진·벤더 PDF 를 텍스트로 바꿔 RAG 에 넣는 전처리로 쓴다. |

---

## 2. 2단계 — PEP 에 연결 (코드 수정 없음)

PEP 의 LLM 게이트웨이(`backend/app/services/llm/service.py`)는 **프로필 × 용도** 라우팅을 이미 지원한다.
설정 원천은 **Settings → AI/LLM** (AppSetting `llm_settings`) 이고, 저장하면 환경변수 초기값을 덮는다.

### 2.1 프로필 등록

Settings → AI/LLM → 프로필 추가 — 모델 하나당 프로필 하나.

| 이름 | provider | base_url | model | 타임아웃 | 동시성 |
|---|---|---|---|---|---|
| `gpt-oss-20b` | openai_compat | `http://<svc>.ai-serving.svc.cluster.local:<port>` | `/v1/models` 의 id | 60s | 8 |
| `glm-5.3-flash` | openai_compat | 〃 | 〃 | 180s | 4 |
| `deepseek-v4.1-flash` | openai_compat | 〃 | 〃 | 180s | 4 |
| `qwen3.6-36b` | openai_compat | 〃 | 〃 | 180s | 2 |

- API 키가 필요하면 **자격증명(`llm_credentials`, 암호화 저장)** 에 넣고 프로필은 `credential:<이름>` 으로 참조한다.
  키를 프로필 값·ConfigMap 에 평문으로 넣지 않는다.
- 동시성은 프로필별 세마포어다. GPU KV 캐시 여유에 맞춰 잡고, 서빙 측 대기열 지표(§6)를 보며 조정한다.
- 저장 후 같은 화면의 **연결 진단**(health)으로 4개 프로필이 모두 온라인인지 확인한다.

### 2.2 용도별 라우팅

| 용도(purpose) | 쓰는 곳 | primary | fallback |
|---|---|---|---|
| `chat` | AI 챗봇 | glm-5.3-flash | gpt-oss-20b |
| `incident_analysis` | 알람·K8s 이벤트 자동/수동 분석 | deepseek-v4.1-flash | glm-5.3-flash |
| `review_summary` | 리뷰·업무 요약 | qwen3.6-36b | gpt-oss-20b |
| `trends` | 기술 트렌드 요약 | gpt-oss-20b | qwen3.6-36b |
| `embedding` | RAG 임베딩 | 기존 임베딩 모델 유지 | — |

- 둘 다 실패하면 분석은 **rule_based 로 자동 대체**되고(`degraded`), 챗은 오프라인 안내가 나온다 — 장애가 번지지 않는다.
- **임베딩 모델은 바꾸지 않는다.** 차원이 바뀌면 벡터 컬럼 재생성 + 전량 재계산이 필요하다.
- 테넌트별로 다른 모델을 쓰게 하려면 테넌트의 `llm_routing` 오버라이드를 쓴다(Agent 채팅에 적용).

### 2.3 자동 분석 켜기 (L0 — 지금 바로 가능)

1. **알람 수신** — Alertmanager 에 PEP 수신자를 추가한다. 토큰이 없으면 503 으로 거부(fail-closed)된다.

   ```yaml
   # alertmanager.yaml (발췌)
   receivers:
     - name: pep
       webhook_configs:
         - url: http://<pep-backend>/api/v1/observability/alerts/ingest
           send_resolved: true
           http_config:
             authorization:
               type: Bearer
               credentials_file: /etc/alertmanager/secrets/pep-ingest/token   # ALERT_INGEST_TOKEN 과 같은 값
   ```

2. **K8s 이벤트 수신** — kubewatch → `POST /api/v1/events/kubewatch` (`KUBEWATCH_TOKEN`).
3. **범위 규칙** — Settings → AI/LLM → **알람 자동 분석 범위**(AppSetting `llm_analysis_scope`, 전역 기본 꺼짐).
   처음에는 좁게 연다: `ai-serving` 네임스페이스 + `severity=critical` + 시간당 상한 20건 + 디바운스 10분.
4. 결과는 알람/이벤트 상세의 **AI 분석** 에 쌓인다(`IncidentAnalysis`). 분석은 전용 `llm` 큐의 Celery 워커가 하고,
   이 워커의 ServiceAccount 는 `get/list/watch` + `pods/log` 만 가진다(`deploy/k8s/base/celery/llm-serviceaccount.yaml`).

이 단계만으로 "새벽에 CrashLoopBackOff → 로그·이벤트·describe 수집 → 원인 후보·조치 가이드 → 인앱 알림" 이 자동으로 돈다.
**조치는 사람이 한다.**

---

## 3. 자동화 단계 정의 — 어디까지 LLM 에 맡기나

| 단계 | LLM 이 하는 일 | 사람이 하는 일 | PEP 상태 |
|---|---|---|---|
| **L0 관찰·분석** | 알람·이벤트를 받아 원인 분석, 조치 가이드 작성 | 읽고 직접 조치 | **있음** (§2.3) |
| **L1 도구 조회** | 읽기 전용 도구를 스스로 골라 호출하며 조사(로그·메트릭·이벤트·변경 이력) | 결론 확인 | 신규 (§4) |
| **L2 런북 제안 + 승인 실행** | 등록된 런북 중 하나를 골라 파라미터와 함께 **제안** | 승인/거절 → PEP 가 실행 | 신규 (§5) |
| **L3 제한 자동 실행** | 허용 목록 런북을 조건이 맞으면 승인 없이 실행 | 사후 검토, 언제든 끄기 | 신규 (§5.3) |

- 단계는 **런북마다** 따로 올린다. "파드 재시작" 은 L3, "노드 drain" 은 L2 에 영구히 머무를 수 있다.
- **LLM 이 kubectl 명령 문자열을 만들어 그대로 실행하는 구조는 만들지 않는다.** 실행 가능한 행위는 런북 목록이 전부다.

---

## 4. L1 — 읽기 전용 도구를 가진 에이전트

### 4.1 도구 목록 (전부 조회)

| 도구 | 하는 일 | 근거 데이터 |
|---|---|---|
| `get_pods(namespace, selector)` | 상태·재시작 수·노드 | K8s API |
| `get_pod_logs(namespace, pod, container, previous, tail)` | 현재/직전 로그 (마스킹 후) | K8s API |
| `describe(kind, namespace, name)` | 이벤트 포함 상세 | K8s API |
| `get_events(namespace, since)` | 최근 이벤트 | K8s API / PEP k8s_events |
| `query_prometheus(promql, range)` | 메트릭 (GPU·KV 캐시·지연) | PEP promql |
| `get_recent_changes(namespace, since)` | 최근 배포·설정 변경 | PEP 변경 이력·감사 로그 |
| `search_runbooks(query)` | 관련 내부 문서·과거 분석 | PEP RAG (업무 가이드·운영 노트) |

### 4.2 구현 위치 (제안)

- PEP 백엔드에 `services/llm/agent_tools.py` — 도구 정의(JSON Schema)와 실행기. 실행기는 **기존 조회 함수를 재사용**하고 결과는 `wrap_untrusted` + 마스킹을 거쳐 모델에 돌려준다(이미 분석기가 쓰는 방어).
- 게이트웨이의 `openai_compat` provider 에 `tools` / `tool_calls` 왕복을 추가한다(현재는 단발 생성만 지원).
- 루프 상한: 도구 호출 8회·총 120초·토큰 상한. 넘으면 그때까지 근거로 결론을 내게 한다.
- 모든 도구 호출과 결과 요약을 **실행 로그(실시간 스트림)** 로 남긴다 — 화면에서 "로그 보기" 로 에이전트가 무엇을 봤는지 그대로 확인할 수 있어야 한다.

### 4.3 권한 — 조회 전용 ServiceAccount

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: { name: llm-agent-reader, namespace: k8s-monitor-prod }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: llm-agent-reader }
rules:
  - apiGroups: ["", "apps", "batch", "networking.k8s.io", "gateway.networking.k8s.io"]
    resources: ["pods", "pods/log", "events", "services", "endpoints", "nodes",
                "deployments", "statefulsets", "daemonsets", "replicasets", "jobs",
                "httproutes", "gateways", "ingresses"]
    verbs: ["get", "list", "watch"]
  # secrets · configmaps 는 넣지 않는다 — 모델 컨텍스트로 새어 나갈 수 있다.
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: llm-agent-reader }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: llm-agent-reader }
subjects: [{ kind: ServiceAccount, name: llm-agent-reader, namespace: k8s-monitor-prod }]
```

다른 클러스터를 볼 때는 그 클러스터에서 같은 권한으로 kubeconfig 를 발급해 PEP 에 등록한다(K8s RBAC 화면에서 SA·kubeconfig 발급 가능).

---

## 5. L2·L3 — 런북 제안과 승인 실행

### 5.1 런북 = 실행 가능한 행위의 전부

PEP 에 이미 있는 실행 경로를 런북으로 쓴다 — 실행 로그·감사 로그·테넌트 동시성 상한이 그대로 붙는다.

| 런북 예 | 실행 경로 | 시작 단계 |
|---|---|---|
| 파드 재시작(`rollout restart`) — `ai-serving` 한정 | 배치잡(script 모드) | L2 → 검증 후 L3 |
| HPA/레플리카 수 조정(범위 1~N) | 배치잡 | L2 |
| 모델 서빙 파드 재배포(이미지 태그 고정값 중 선택) | 플레이북 | L2 |
| 노드 cordon / drain | 플레이북 | L2 고정 |
| 로그·덤프 수집 | 스크립트 | L3 (조회성) |

각 런북에는 다음을 적어 둔다: **허용 파라미터와 범위**(네임스페이스 목록, 레플리카 상한), **사전 조건**(예: 같은 대상 10분 내 재실행 금지),
**사후 확인**(Ready 파드 수, 에러율), **롤백 방법**.

### 5.2 승인 흐름 (L2)

```
에이전트 결론 → 제안 카드(런북 · 파라미터 · 근거 · 예상 영향 · 롤백)
  → 운영자(operator 이상) 승인/거절   ← 승인 없이는 아무것도 실행되지 않는다
  → PEP 가 런북 실행 (실시간 실행 로그 · 감사 로그)
  → 에이전트가 사후 확인 도구로 결과 검증 → 실패면 롤백 런북 제안
```

- 제안 카드는 viewer 에게도 보이되 승인 버튼은 `useCanOperate()` 로 비활성 + 사유 표시.
- 실행 주체 ServiceAccount 는 **런북별로 분리**하고 해당 네임스페이스·동사만 준다. 예: 재시작 런북은 `ai-serving` 의 `deployments` `patch` 만.

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: runbook-restart, namespace: ai-serving }
rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets"]
    verbs: ["get", "patch"]
```

### 5.3 L3 로 올리는 조건

- 같은 런북이 L2 에서 **최소 20회 승인·성공**, 거절·롤백 0~1회.
- 차단 장치: 시간당 실행 상한, 대상당 쿨다운, 업무시간 외에는 L2 로 되돌림(선택), **전역 kill switch**(한 번에 L3 전부 끄기).
- 자동 실행도 결과를 인앱 알림으로 보내고, 실패 2회 연속이면 해당 런북을 자동으로 L2 로 내린다.

---

## 6. GPU 서빙 자체를 운영 대상으로 — 무엇을 보고 언제 깨우나

에이전트가 가장 먼저 맡을 대상은 `ai-serving` 그 자체다.

| 지표 | 출처 | 경보 예 |
|---|---|---|
| GPU 사용률·메모리·온도·XID 오류 | DCGM exporter | XID 발생, 메모리 95% 10분 |
| KV 캐시 사용률 | 서빙 엔진 `/metrics` | 90% 이상 5분 (대기열 증가 전조) |
| 대기 요청 수 · 첫 토큰 지연 · 토큰/초 | 서빙 엔진 `/metrics` | 대기 > 동시성×2, TTFT p95 급증 |
| 파드 재시작·OOM·Pending | kube-state-metrics / kubewatch | CrashLoopBackOff, GPU 미할당 Pending |
| HTTPRoute 5xx·지연 | Gateway 컨트롤러 메트릭 | 5xx 비율 > 2% |

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata: { name: ai-serving, namespace: monitoring }
spec:
  groups:
    - name: ai-serving
      rules:
        - alert: AIServingPodRestarting
          expr: increase(kube_pod_container_status_restarts_total{namespace="ai-serving"}[15m]) > 2
          labels: { severity: critical }
        - alert: AIServingGpuMemoryHigh
          expr: avg by (Hostname, gpu) (DCGM_FI_DEV_FB_USED / (DCGM_FI_DEV_FB_USED + DCGM_FI_DEV_FB_FREE)) > 0.95
          for: 10m
          labels: { severity: warning }
```

> 서빙 엔진 지표 이름은 엔진·버전마다 다르다. `/metrics` 를 직접 열어 이름을 확인한 뒤 규칙을 쓴다.
> PEP 의 **PromQL 카드**(UI 에서 추가)로 같은 지표를 대시보드에 올려 두면 에이전트의 `query_prometheus` 와 사람이 같은 숫자를 본다.

**주의 — 순환 의존.** 에이전트가 쓰는 모델과 장애 대상이 같은 GPU 서버다. 서빙 전체가 죽으면 분석도 멈춘다.
fallback 에 **다른 노드의 작은 모델**(또는 rule_based)을 두고, `ai-serving` 장애 경보는 LLM 분석과 별개로 사람에게 바로 알린다.

---

## 7. 도입 전 평가 — 모델을 고르는 기준

모델 이름이나 벤치마크가 아니라 **우리 장애 데이터로** 고른다.

1. 지난 장애 30~50건(알람 + 로그 + 실제 원인 + 실제 조치)을 평가셋으로 만든다. 민감 정보는 마스킹.
2. 모델별로 L0 분석과 L1 도구 호출을 돌려 기록한다.

| 항목 | 기준 |
|---|---|
| 원인 적중 | 상위 3개 후보 안에 실제 원인 |
| 도구 호출 정확도 | 스키마 위반·없는 도구 호출 비율 < 2% |
| 불필요한 호출 | 결론까지 평균 호출 수 |
| 위험 제안 | 허용 목록 밖 행위·삭제 제안 비율 (0 이어야 함) |
| 지연 | p95 응답 시간 (알람 분석 < 60s 목표) |

3. 결과로 §2.2 라우팅을 확정하고, 분기마다 다시 돌린다(모델 교체 때도).

---

## 8. 보안 체크리스트

- [ ] 모델 엔드포인트는 내부 Service DNS 로 연결, 외부 HTTPRoute 는 인증 + 소스 제한
- [ ] API 키는 PEP 자격증명(암호화)으로만, 프로필·ConfigMap 평문 금지
- [ ] 로그·이벤트·채팅 컨텍스트는 마스킹(`services/llm/masking.py`) + `wrap_untrusted` 경계 — **로그 안의 문장이 지시처럼 보여도 따르지 않게**(프롬프트 인젝션 방어)
- [ ] 에이전트 조회 SA 에 `secrets`·`configmaps` 권한 없음
- [ ] 실행은 런북만, 런북별 최소 권한 SA, 승인자·실행 결과가 감사 로그에 남음
- [ ] L3 kill switch 와 시간당 상한
- [ ] `ai-serving` 전체 장애 시 사람에게 직접 알림(LLM 경로와 분리)
- [ ] 모델 서빙 파드에서 외부 인터넷 egress 차단(NetworkPolicy)

---

## 9. 도입 순서 (권장)

| 주차 | 할 일 | 완료 기준 |
|---|---|---|
| 1 | §1 엔드포인트·도구 호출 점검, §2.1 프로필 4개 등록 | 연결 진단 4개 온라인 |
| 1 | §2.2 라우팅, §2.3 자동 분석(`ai-serving` + critical 만) | 실제 알람 1건이 분석까지 자동 처리 |
| 2 | §6 지표·경보 규칙, PromQL 카드 | 테스트 장애(파드 kill)로 경보 → 분석 확인 |
| 2~3 | §7 평가셋으로 모델 비교 → 라우팅 확정 | 평가표 |
| 3~5 | §4 L1 도구 에이전트 구현(PEP 기능 추가) | 도구 호출 로그가 실행 로그 화면에 남음 |
| 5~7 | §5 런북 3종 + 승인 흐름(L2) | 승인 실행 20회 |
| 이후 | 조건 충족 런북부터 L3 | 런북별 승인 이력 |

§4·§5 는 PEP 신규 기능이다. 진행할 때는 `backend-feature` · `frontend-page` 스킬 절차와
"실행 버튼에는 실시간 상세 로그 + 로그 보기 옵션" 규칙을 따른다.
