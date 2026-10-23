## Ollama 챗봇 연동 트러블슈팅 + K8s 운영 전용 모델 셋팅 가이드

Ollama 이미지를 파드로 띄웠는데 PEP 의 AI 챗봇이 응답하지 않는 경우를 정리한다.
원인을 아래 계층부터 하나씩 확인하는 순서, K8s 운영 전용 모델(`pep-k8s-ops`) 만드는 법,
PEP 쪽 설정 순서를 한 문서에 모은다.

> 관련 문서 — 반입 절차: [AIRGAP_LLM_NEXUS.md](AIRGAP_LLM_NEXUS.md) ·
> 아키텍처: [AIRGAP_LLM_ARCHITECTURE.md](AIRGAP_LLM_ARCHITECTURE.md) ·
> 구성도: [diagrams/llm-chatbot-flow.drawio](diagrams/llm-chatbot-flow.drawio)

---

### 1. 요청이 지나가는 길

```
AI 챗봇(브라우저)
  → backend  POST /api/v1/agent/chat/stream
  → LLM 게이트웨이 (services/llm) — 용도 'chat' 의 primary → fallback 프로필
  → Service  http://ollama:11434        (프로필 base_url)
  → Ollama 파드  POST /api/generate {model: <프로필 model>}
```

- 챗봇이 쓰는 엔드포인트·모델은 **환경변수가 아니라 프로필**이 정한다.
  Settings → AI/LLM 에 한 번이라도 저장했다면 그 DB 값(AppSetting `llm_settings`)이 원천이고,
  `OLLAMA_URL` / `OLLAMA_MODEL` 은 저장값이 없을 때만 쓰는 초기값이다.
- 그래서 "ConfigMap 의 OLLAMA_MODEL 을 바꿨는데 그대로다" 는 흔한 함정이다.

---

### 2. 원인 후보 — 자주 걸리는 순서

| # | 원인 | 증상 | 확인 |
|---|---|---|---|
| 1 | **모델이 안 구워진 이미지** | 서버는 뜨는데 `ollama list` 가 빈 목록 | `kubectl exec deploy/ollama -- ollama list` |
| 2 | **모델 태그 불일치** | health 는 온라인, 챗봇만 "모델을 사용할 수 없습니다" | `ollama list` 이름 vs 프로필 model |
| 3 | DB 저장 설정이 env 를 덮음 | ConfigMap 을 바꿔도 반영 안 됨 | Settings → AI/LLM 프로필의 모델명 |
| 4 | Service 없음 / 이름·네임스페이스 다름 | "연결할 수 없습니다"(connect_error) | `kubectl get svc,endpoints -A \| grep ollama` |
| 5 | CPU 콜드 로딩 타임아웃 | 첫 질문만 "시간 내에 도착하지 않았습니다" | 진단의 "모델 로딩 N초" |
| 6 | 메모리 부족(OOMKilled) | 응답 도중 끊김, 파드 재시작 | `kubectl describe pod -l app=ollama` |
| 7 | `/root/.ollama` 에 emptyDir 마운트 | 구운 모델이 사라짐 | 파드 spec 의 volumeMounts |

#### 2.1 이미지 이름부터 본다

- `riverjin839/ollama-qwen2.5-coder:*` (저장소 경로 없는 이름)는 예전에 손으로 만든 이미지다.
  **모델이 구워지지 않은 채 배포된 이력이 있다** (`/root/.ollama/models` 자체가 없음).
- 지금 쓰는 이미지는 `ghcr.io/riverjin839/devops_management/ollama-qwen2.5-coder:7b` 다.
  `.github/workflows/ollama-qwen2.5-coder.yml` 이 빌드하고, Dockerfile 이 빌드 중에
  `ollama list` 로 모델 존재를 검사하므로 빈 이미지는 나오지 않는다.
- qwen2.5-coder 에는 5B 크기가 없다(0.5b·1.5b·3b·7b·14b·32b). `:5b` 는 이미지 태그일 뿐이고,
  안에 든 모델 이름은 따로 확인해야 한다. **기준은 언제나 `ollama list` 출력이다.**

#### 2.2 모델 태그 불일치가 왜 "온라인인데 안 되는" 상태를 만드나

- Ollama 는 태그 없는 이름을 `:latest` 로 읽는다. 프로필 모델이 `qwen2.5-coder` 이고 서버에
  `qwen2.5-coder:7b` 만 있으면 `/api/generate` 는 404 다.
- 예전 health 검사는 `:` 앞 이름만 비교해서 이 상태를 **정상(온라인)** 으로 판정했다. 화면은 초록인데
  챗봇만 실패하니 원인을 찾기 어려웠다 → 이번에 고쳤다(§6).

---

### 3. 클러스터에서 직접 확인하는 명령

```bash
NS=k8s-monitor          # Ollama 를 띄운 네임스페이스

# 파드·서비스·엔드포인트 — 엔드포인트가 비어 있으면 selector/Ready 문제
kubectl -n $NS get pod -l app=ollama -o wide
kubectl -n $NS get svc ollama
kubectl -n $NS get endpoints ollama

# 이미지 안에 실제로 든 모델
kubectl -n $NS exec deploy/ollama -- ollama list

# backend 파드 안에서 Service 이름이 풀리고 응답하는지
kubectl -n $NS exec deploy/backend -- python -c \
  "import httpx;print(httpx.get('http://ollama:11434/api/tags',timeout=5).text)"

# 생성까지 되는지 (모델명은 ollama list 에 나온 그대로)
kubectl -n $NS exec deploy/ollama -- ollama run qwen2.5-coder:7b "한 단어로: 정상"

# 재시작·OOM 이력
kubectl -n $NS describe pod -l app=ollama | grep -E "Last State|Reason|Limits" -A2
```

- Ollama 를 PEP 와 다른 네임스페이스에 띄웠다면 base_url 을
  `http://ollama.<ns>.svc.cluster.local:11434` 로 적는다.
- Deployment 만 만들고 Service 를 안 만들었으면 `deploy/k8s/base/ollama.yaml` 의 Service 블록을 그대로 쓴다.

---

### 4. PEP 쪽 설정 순서

1. **Settings → AI/LLM → LLM 엔드포인트 프로필** 에서 `local-ollama` 를 연다.
2. base_url = `http://ollama:11434` (네임스페이스가 다르면 FQDN), 모델 = `ollama list` 에 나온 이름.
   편집 창의 모델 목록 버튼으로 서버 목록에서 고르면 오타가 없다.
3. 타임아웃은 CPU 7B 기준 **300초**로 올린다(첫 로딩이 수십 초~수 분).
4. **용도별 LLM 라우팅** 에서 `AI 챗봇` 의 primary 를 이 프로필로 둔다.
5. 프로필 행의 **연결 진단 실행**(청진기 아이콘)을 누른다. 실행 로그에 7단계가 실시간으로 쌓인다.

| 단계 | 확인하는 것 | 실패하면 |
|---|---|---|
| 설정 원천 | DB 저장값이 env 를 덮는지, 모델명 비었는지 | 이 화면에서 모델명을 고친다 |
| DNS 조회 | backend 파드에서 Service 이름이 풀리는지 | Service 생성 / FQDN 사용 |
| 포트 연결 | 11434 TCP 연결 | endpoints·selector·NetworkPolicy·`OLLAMA_HOST=0.0.0.0` |
| Ollama 서버 | `GET /`, `/api/version` | base_url 이 Ollama 를 가리키는지 |
| 모델 확인 | `/api/tags` + 모델명 해석 | 모델 없는 이미지 교체 / 모델명 수정 |
| 모델 정보 | 크기·양자화·context·`num_ctx`·내장 시스템 프롬프트 | `num_ctx` 기본(2048)이면 경고 |
| 응답 테스트 | 실제 생성 · 로딩 시간 · tok/s | 타임아웃·KEEP_ALIVE·CPU/메모리 |

- 진단이 "설정 `qwen2.5-coder` → `qwen2.5-coder:7b` 로 자동 해석" 을 찾으면 로그 패널에
  **모델명을 … 로 저장** 버튼이 뜬다. 누르면 프로필이 정확한 이름으로 저장된다.
- 로그를 펼칠지는 **로그 보기** 토글로 정하고, 선택은 화면별로 기억된다.

---

### 5. K8s 운영 전용 모델 — `pep-k8s-ops`

#### 5.1 무엇이 다른가

가중치를 새로 학습한 모델이 아니다. `qwen2.5-coder:7b` 위에 **운영용 파라미터와 기본 시스템
프롬프트를 고정한 파생 모델**이다. 베이스 블롭을 공유하므로 이미지는 수 KB 만 커진다.

| 항목 | 베이스 기본값 | pep-k8s-ops | 이유 |
|---|---|---|---|
| `temperature` | 0.7 계열 | 0.2 | 운영 답변은 재현성이 우선 |
| `num_ctx` | 2048 | 8192 | `describe`·로그 수십 줄이 잘리지 않게 |
| `num_predict` | 무제한 | 1024 | 답변이 늘어지지 않게 |
| `repeat_penalty` | 1.1 | 1.1 | 같은 명령 반복 억제 |
| SYSTEM | 코딩 어시스턴트 | K8s 운영 규칙 6줄 | 읽기 전용 명령 우선, 변경 명령 표시, 근거 인용 |

- PEP 게이트웨이는 호출마다 용도별 system 을 보낸다(`services/llm/prompts.py`). 그래서 SYSTEM 은
  `ollama run pep-k8s-ops` 처럼 직접 쓸 때의 기본값이고, **PARAMETER 는 PEP 에서도 항상 적용된다.**
- `num_ctx 8192` 는 7B·CPU 에서 메모리를 1~2GiB 더 쓴다. Ollama 파드 memory limit 은 12Gi 이상을 권장한다.

#### 5.2 이미지로 굽기 (권장)

`docker/ollama-qwen2.5-coder/Modelfile.k8s-ops` 가 정의 파일이고, 같은 폴더의 Dockerfile 이
베이스 pull 직후 같은 레이어에서 `ollama create pep-k8s-ops` 를 실행한다. 이미지에는 두 이름이 함께 들어간다.

```
qwen2.5-coder:7b
pep-k8s-ops:latest
```

- `main` 에 이 폴더 변경이 머지되면 워크플로가 이미지를 다시 굽는다(수동 실행도 가능).
- 다른 베이스를 쓰려면 빌드 인자만 바꾼다.

```bash
docker build docker/ollama-qwen2.5-coder \
  --build-arg OLLAMA_MODEL=qwen2.5-coder:3b \
  --build-arg OPS_MODEL_NAME=pep-k8s-ops \
  -t <registry>/ollama-qwen2.5-coder:3b
```

- 폐쇄망은 `scripts/deploy/deploy-airgap.sh` 로 내부 레지스트리에 미러링한다.

#### 5.3 이미 떠 있는 파드에서 바로 만들기 (임시)

이미지를 다시 굽기 어렵다면 실행 중인 파드에서 만든다. **PVC 가 없으면 파드 재시작 시 사라진다.**

```bash
kubectl -n $NS cp docker/ollama-qwen2.5-coder/Modelfile.k8s-ops \
  $(kubectl -n $NS get pod -l app=ollama -o name | head -1 | cut -d/ -f2):/tmp/Modelfile
kubectl -n $NS exec deploy/ollama -- ollama create pep-k8s-ops -f /tmp/Modelfile
kubectl -n $NS exec deploy/ollama -- ollama list
```

- Modelfile 의 `FROM` 줄을 `ollama list` 에 있는 베이스 이름으로 맞춘다.

#### 5.4 PEP 에서 전환

Settings → AI/LLM → `local-ollama` 프로필의 모델을 `pep-k8s-ops` 로 바꾸고 **연결 진단 실행** 으로
"모델 정보" 단계에 `num_ctx=8192` 가 나오는지 본다. ConfigMap 기본값(`OLLAMA_MODEL`)은
새 이미지가 모든 환경에 반입되기 전까지 `qwen2.5-coder:7b` 로 둔다.

---

### 6. 모델 크기 고르기 (CPU 노드 기준)

| 모델 | 메모리(q4) | CPU 8코어 체감 | 쓰임 |
|---|---|---|---|
| qwen2.5-coder:3b | ~3 GiB | 빠름 (10+ tok/s) | 노드가 작을 때, 요약·분류 |
| **qwen2.5-coder:7b** | ~5–6 GiB | 보통 (4–8 tok/s) | **기본값** — 챗봇·장애 분석 |
| qwen2.5-coder:14b | ~10 GiB | 느림 (2–3 tok/s) | CPU 에서는 비추천 |
| 14b 이상 | GPU 필요 | — | vLLM(`deploy/k8s/components/vllm-gpu`) + openai_compat 프로필 |

- 진단의 "응답 테스트" 가 3 tok/s 미만이면 경고를 띄운다. CPU limit 을 늘리거나 한 단계 작은 모델로 내린다.

---

### 7. CPU 자원이 없을 수도 있을 때 — 로컬 AI 는 선택지 중 하나다

인클러스터 Ollama 는 결국 **로컬 AI** 다. 데이터가 클러스터 밖으로 나가지 않는 대신 모델을 돌릴
CPU·메모리를 클러스터가 직접 낸다. 자원이 있을 수도 없을 수도 있으니, PEP 는 LLM 이 **어디에 있든
같은 프로필로 붙고, 없어도 화면이 죽지 않게** 짜여 있다.

| 상황 | 배포 | Settings → AI/LLM 라우팅 | 챗봇 동작 |
|---|---|---|---|
| CPU 여유 충분 (8코어·12Gi+) | Ollama 7B (`pep-k8s-ops`) | 챗봇 primary = local-ollama | 로컬 AI 응답 |
| CPU 빠듯 (4코어·6Gi) | Ollama 3B (`OLLAMA_MODEL=qwen2.5-coder:3b` 빌드), requests 낮춤 | 동일 | 느리지만 응답 |
| 사내 LLM 있음 + CPU 없음 | `deploy/k8s/components/no-ollama` / Helm `ollama.enabled=false` | 챗봇 primary = 사내 LLM(openai_compat) | 사내 LLM 응답 |
| 둘 다 있음 | Ollama + 사내 LLM | primary = 사내 LLM, fallback = local-ollama | 사내 LLM 장애 시 로컬로 자동 전환 |
| 아무 LLM 도 없음 | no-ollama | — | 오프라인 안내문, 장애 분석은 `rule_based` |

- 자원이 없는데 base 그대로 배포하면 Ollama 파드가 `Pending`(Insufficient cpu) 으로 남고 Service
  엔드포인트가 비어 챗봇은 "연결할 수 없습니다" 가 된다. 연결 진단의 **포트 연결** 단계가 이 경우를 짚어 준다.
- 파드가 떠 있어도 다른 워크로드와 CPU 를 다투면 tok/s 가 떨어진다. 진단의 **응답 테스트** 가
  3 tok/s 미만이면 경고한다 — 이때가 3B 로 내리거나 사내 LLM 으로 넘길 시점이다.
- primary/fallback 라우팅은 Settings 에서 바로 바꾸고 1분 안에 반영된다. 재배포가 필요 없다.

---

### 8. CPU 없는 환경 — 사내 LLM 프로필 설정 예시

CPU 를 못 쓰는 클러스터는 로컬 AI 를 빼고 모든 용도를 사내 LLM(OpenAI 호환 API)으로 보낸다.
아래 값은 예시다 — 주소·모델명·키 이름은 사내 LLM 서비스 안내에 맞춰 바꾼다.

#### 8.1 배포 — Ollama 빼기

```yaml
# kustomize: deploy/k8s/overlays/<env>/kustomization.yaml
components:
  - ../../components/no-ollama
```

```yaml
# Helm: values-<env>.yaml
ollama:
  enabled: false
llm:
  apiBase: ""   # 비워 둔다 — 프로필은 화면에서 등록한다(키를 values 에 두지 않는다)
```

- `LLM_API_BASE`/`LLM_API_KEY` 환경변수를 주면 `internal-llm` 프로필이 자동으로 생긴다. 다만 라우팅
  기본값은 여전히 `local-ollama` 다. 환경변수는 초기값일 뿐이고, 실제 전환은 아래 화면 설정으로 한다.

#### 8.2 API 키 등록 — Settings → AI/LLM → API 키

| 항목 | 예시 |
|---|---|
| 이름 | `corp-llm-key` |
| API 키 | 사내 LLM 포털에서 발급한 키 |

- 키는 `llm_credentials` 테이블에 암호화돼 저장되고, 저장 뒤 원문은 다시 보이지 않는다.
- 프로필에는 키 원문이 아니라 참조 문자열 `credential:corp-llm-key` 만 들어간다.

#### 8.3 프로필 — Settings → AI/LLM → 프로필 추가

| 항목 | 예시 | 설명 |
|---|---|---|
| 이름 | `corp-llm` | 라우팅에서 고를 이름 |
| provider | `OpenAI 호환` (`openai_compat`) | |
| 엔드포인트 URL | `https://llm-gw.corp.local` | **`/v1` 을 붙이지 않는다** — PEP 가 `/v1/chat/completions` 를 붙인다 |
| 모델 | `corp-chat-32b` | 모델 목록 버튼(`/v1/models`)으로 고르면 오타가 없다 |
| API 키 참조 | `credential:corp-llm-key` | 환경변수를 쓰면 `env:LLM_API_KEY` |
| 타임아웃 | `120` | 사내 GPU 서빙이면 120초로 충분하다 |
| 동시 호출 | `4` | 사내 서비스의 호출 한도(rate limit)보다 작게 잡는다 |
| 활성 | 켬 | |

- 같은 서비스에서 가벼운 모델을 따로 주면 `corp-llm-fast`(예: 8B) 프로필을 하나 더 만들어 요약·트렌드에 쓴다.
- `local-ollama` 프로필은 **비활성으로 끈다**. 켜 두면 상태가 계속 "오프라인" 으로 보이고,
  fallback 으로 지정됐을 때 매번 연결 시도로 응답이 늦어진다.

#### 8.4 용도별 라우팅

| 용도 | primary | fallback | 비고 |
|---|---|---|---|
| AI 챗봇 | `corp-llm` | `corp-llm-fast` | |
| 장애 분석 | `corp-llm` | — | JSON 응답이라 큰 모델이 안정적이다 |
| 점검 리뷰/요약 | `corp-llm-fast` | `corp-llm` | 호출이 잦다 |
| 아키텍처 문서 | `corp-llm` | — | |
| 기술 트렌드 요약 | `corp-llm-fast` | — | |
| 임베딩 | 아래 8.5 참고 | — | |

- 분석기 백엔드는 `LLM 분석 (local_llm)` 으로 둔다. 이름과 달리 "라우팅된 프로필을 쓰는 LLM 분석" 이라는 뜻이라
  사내 LLM 에도 그대로 쓰인다. LLM 호출이 모두 실패하면 분석 결과는 "LLM 분석 불가 — 수동 확인" 으로
  남는다(성능 저하 사유 표시). 사내 LLM 이 자주 끊기는 환경이면 `규칙 기반` 으로 두는 편이 낫다.

#### 8.5 임베딩 — 차원을 먼저 맞춘다

- 유사 검색(RAG) 벡터 컬럼은 배포 시 `EMBEDDING_DIM`(기본 768, `nomic-embed-text` 기준)으로 고정된다.
- 사내 서비스의 임베딩 모델이 **768 차원**이면 임베딩 primary 를 `corp-llm` 으로 두고, 임베딩 모델명을
  그 모델로 바꾼 뒤 재계산(백필)한다.
- 차원이 다르면(1024 등) 그대로 연결하지 않는다. `EMBEDDING_DIM` 을 바꾸면 기존 벡터 컬럼을 다시
  만들어야 하므로 별도 작업으로 계획한다.
- 임베딩을 연결하지 않아도 챗봇·분석은 동작한다. 유사 문서 인용만 빠진다.

#### 8.6 확인

1. `corp-llm` 행의 **연결 진단 실행** → DNS · 포트 · 모델 확인(`/v1/models`) · 응답 테스트가 모두 통과하는지 본다.
   - 모델 확인에서 HTTP 401/403 이 나오면 키 참조를 확인한다.
2. 화면 아래 AI 챗봇 버튼을 열어 질문 하나를 던져 답이 오는지 본다.
3. 하루 뒤 **최근 24h 사용량** 에서 용도별 호출 수·오류·지연을 보고 동시 호출 한도를 조정한다.

> 사내 LLM 으로 나가는 프롬프트는 게이트웨이에서 시크릿(토큰·비밀번호 패턴)을 마스킹한 뒤 전송된다.
> 그래도 로그 원문이 사내 LLM 서비스에 전달되므로, 서비스의 데이터 보관 정책을 한 번 확인해 둔다.

---

### 9. 이번에 고친 것

- **모델명 자동 해석** — 설정 모델이 서버에 정확히 없으면(404) `/api/tags` 에서
  `정확 일치 → name:latest → 같은 이름의 다른 태그` 순으로 찾아 1회 재시도하고 결과를 기억한다.
  `qwen2.5-coder` / `qwen2.5-coder:5b` 로 적어도 서버의 `qwen2.5-coder:7b` 로 응답한다.
- **health 판정 수정** — 호출이 실제로 성공할 이름이 없으면 "모델 미준비" 로 표시한다.
  자동 해석 중이면 "온라인 · `<모델>` 로 자동 해석" 으로 보여준다.
- **연결 진단 실행 버튼** — `POST /api/v1/llm/diagnose`(SSE). 7단계 결과·조치 힌트를 실시간 로그로 남긴다.
- **K8s 운영 전용 모델** — `Modelfile.k8s-ops` + Dockerfile 이 `pep-k8s-ops` 를 함께 굽는다.
- **`deploy/k8s/components/no-ollama`** — CPU 자원이 없는 클러스터에서 Ollama 를 빼는 opt-in 컴포넌트.
- **매니페스트 보정** — kustomize base 에 `OLLAMA_MODEL` 키가 없어 backend 파드의 configMapKeyRef 가
  풀리지 않던 문제를 고쳤고(base 이미지와 같은 `qwen2.5-coder:7b`), Ollama 에 `OLLAMA_KEEP_ALIVE=24h` 를 줬다.

---

### 10. 한 장 요약

- 챗봇 모델은 **Settings → AI/LLM 프로필**이 정한다. DB 에 저장된 뒤에는 ConfigMap 을 바꿔도 소용없다.
- 모델 이름의 기준은 **`ollama list`** 다. 이미지 태그(`:5b`)는 모델 태그가 아니다.
- 저장소 경로 없는 `riverjin839/ollama-qwen2.5-coder` 이미지는 모델이 비어 있을 수 있다 →
  `ghcr.io/riverjin839/devops_management/ollama-qwen2.5-coder:7b` 를 쓴다.
- 안 되면 프로필 행의 **연결 진단 실행** 을 누르고, 처음 실패한 단계의 "조치" 줄대로 고친다.
- 운영 질의에는 `pep-k8s-ops`(temperature 0.2 · num_ctx 8192)를 쓰고, CPU 노드는 7B 까지가 현실선이다.
- 로컬 AI 는 선택지다. CPU 가 없으면 `no-ollama` 로 빼고 사내 LLM 프로필(§8, URL 에 `/v1` 빼기)로 라우팅하면 되고, 아무것도 없어도 화면은 오프라인 안내로 버틴다.
