# Kubernetes 배포 가이드

PEP (Platform Engineering Portal) — 구 K8s Daily Monitor — 를 Kubernetes 클러스터에 배포하기 위한 가이드입니다.

---

## 디렉토리 구조

```
k8s/
├── base/                              # 환경 공통 기본 매니페스트
│   ├── kustomization.yaml             # Kustomize 루트 설정
│   ├── namespace.yaml                 # 네임스페이스 정의
│   ├── configmap.yaml                 # (미사용) 레거시 참고용 — 실제 값은 kustomization.yaml 의 configMapGenerator 가 생성
│   ├── secret.yaml                    # (미사용) 레거시 참고용 — 실제 값은 kustomization.yaml 의 secretGenerator 가 생성
│   ├── ingress.yaml                   # NGINX Ingress 라우팅 규칙
│   ├── hpa.yaml                       # HorizontalPodAutoscaler (backend/frontend/celery)
│   ├── ollama.yaml                    # Ollama LLM 서버 (선택적 배포)
│   ├── ansible-playbooks-check_cluster.yml  # Ansible 플레이북 ConfigMap 번들
│   │
│   ├── backend/                       # FastAPI 백엔드
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   └── serviceaccount.yaml
│   ├── frontend/                      # React + Nginx 프론트엔드
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   └── nginx-configmap.yaml
│   ├── celery/                        # Celery 비동기 작업 처리
│   │   ├── worker-deployment.yaml
│   │   └── beat-deployment.yaml
│   ├── postgres/                      # PostgreSQL 영구 데이터베이스
│   │   ├── statefulset.yaml
│   │   └── service.yaml
│   ├── redis/                         # Redis 브로커 및 캐시
│   │   ├── deployment.yaml
│   │   └── service.yaml
│   │
│   ├── monitoring/                    # 메트릭 수집·시각화 스택
│   │   ├── kustomization.yaml
│   │   ├── prometheus-deployment.yaml
│   │   ├── prometheus-configmap.yaml
│   │   ├── prometheus-service.yaml
│   │   ├── prometheus-rbac.yaml
│   │   ├── grafana-deployment.yaml
│   │   ├── grafana-configmap.yaml
│   │   ├── grafana-service.yaml
│   │   ├── node-exporter.yaml
│   │   ├── kube-state-metrics.yaml
│   │   ├── blackbox-exporter.yaml
│   │   └── network-quality-servicemonitor.yaml
│   ├── observability/                 # 네트워크 텔레메트리 수집 스택
│   │   ├── kustomization.yaml
│   │   ├── namespace.yaml
│   │   ├── gnmic-telemetry.yaml
│   │   ├── openbmp-collector.yaml
│   │   ├── telegraf-snmp.yaml
│   │   └── README.md
│   ├── grafana-renderer/              # Grafana 이미지 렌더러 사이드카
│   │   ├── deployment.yaml
│   │   └── service.yaml
│   └── kubewatch/                     # K8s 이벤트 감시 및 알림
│       ├── deployment.yaml
│       ├── configmap.yaml
│       └── rbac.yaml
│
├── overlays/                          # 환경별 Kustomize 오버레이
│   ├── dev/                           # 개발 환경 (k8s-monitor-dev)
│   ├── prod/                          # 프로덕션 환경 (k8s-monitor-prod)
│   ├── kind/                          # 로컬 kind 클러스터 (NodePort 노출)
│   └── airgap/                        # 폐쇄망 배포 (내부 레지스트리 미러)
│
├── superpod/                          # SuperPod 독립 배포 모듈
│   ├── kustomization.yaml
│   ├── namespace.yaml
│   ├── cronjob.yaml
│   ├── serviceaccount.yaml
│   ├── secret.yaml.tmpl
│   └── README.md
│
└── ansible-playbooks/                 # Ansible 플레이북 소스 (ConfigMap 원본)
    └── check_cluster.yml
```

---

## 모듈별 역할 설명

### base/ — 공통 기반 리소스

#### `namespace.yaml`
네임스페이스(`k8s-monitor`)를 정의합니다. 오버레이에서 `namePrefix`로 `dev-` / `prod-` 를 붙여 환경을 분리합니다.

#### `configmap.yaml` / `secret.yaml` — ⚠️ 미사용 (고아 파일)
두 파일 모두 `kustomization.yaml` 의 `resources:` 목록에 **포함되어 있지 않아 실제로는
적용되지 않는다.** 실제 환경변수/민감값은 같은 `kustomization.yaml` 하단의
**`configMapGenerator`**(`k8s-monitor-config`)와 **`secretGenerator`**(`k8s-monitor-secret`)
가 리터럴로 생성한다 (`DATABASE_URL`, `REDIS_URL`, `OLLAMA_URL`, DB 비밀번호, JWT
`SECRET_KEY` 등). 값을 바꾸려면 이 두 generator 를 수정할 것 — `base/configmap.yaml`·
`base/secret.yaml` 을 고쳐도 반영되지 않는다. 프로덕션에서는 generator 리터럴을 External
Secrets Operator, Sealed Secrets, Vault 중 하나로 교체 검토.

#### `ingress.yaml`
NGINX Ingress Controller 기반 라우팅 규칙입니다. `/api/*` 는 backend Service 로, 나머지는 frontend Service 로 프록시합니다.

#### `hpa.yaml`
backend / frontend / celery-worker 세 Deployment 에 대해 CPU 70% 임계값 기준 HPA 를 정의합니다.

#### `ollama.yaml`
인클러스터 자체 LLM(Ollama, CPU 전용) 서버를 실행할 때 사용합니다. 모델이 이미지에
pre-baked 되어 있어 볼륨 마운트가 기본적으로 없습니다(재시작해도 이미지 안 모델은
유지됨) — 추가로 pull 한 모델을 영속화하려면 `k8s/components/ollama-pvc/` 컴포넌트를
오버레이에 추가하세요. GPU 어피니티는 포함돼 있지 않습니다 — GPU 기반 서빙(vLLM)이
필요하면 `k8s/components/vllm-gpu/` 를 참고하세요. 사내 LLM 서비스(OpenAI-호환)에
연결하는 경우 이 파일 자체가 필요 없습니다 — Settings → AI/LLM 탭에서 프로필로 등록하면
됩니다. AI 기능이 전혀 필요 없을 경우 kustomization 에서 제외할 수 있습니다.

---

### base/backend/ — FastAPI 백엔드

| 파일 | 역할 |
|---|---|
| `deployment.yaml` | FastAPI 앱 컨테이너. 포트 8000, `/health` 라이브니스·레디니스 프로브, Ansible 플레이북 볼륨 마운트 포함 |
| `service.yaml` | ClusterIP Service. 프론트엔드 Nginx 및 Ingress 에서 내부 접근 |
| `serviceaccount.yaml` | `k8s-monitor-sa` ServiceAccount + ClusterRole 바인딩. 대상 클러스터의 Pod·Node·Event 읽기 권한 부여 |

---

### base/frontend/ — React + Nginx

| 파일 | 역할 |
|---|---|
| `deployment.yaml` | 프로덕션 빌드를 서빙하는 Nginx 컨테이너. 포트 80 |
| `service.yaml` | ClusterIP Service. Ingress 에서 라우팅 |
| `nginx-configmap.yaml` | Nginx 설정. `/api/*` 리버스 프록시, SPA 폴백(`try_files`), 정적 파일 1년 캐싱 |

---

### base/celery/ — 비동기 태스크 워커

| 파일 | 역할 |
|---|---|
| `worker-deployment.yaml` | Celery Worker. 헬스 체크 태스크 실행. 동시성 2, HPA 대상 |
| `beat-deployment.yaml` | Celery Beat 스케줄러. 09:00 / 13:00 / 18:00 KST 정기 체크 트리거. 레플리카는 항상 1개로 고정(중복 방지) |

---

### base/postgres/ — 영구 데이터 저장소

| 파일 | 역할 |
|---|---|
| `statefulset.yaml` | PostgreSQL 15-alpine StatefulSet. PVC를 통한 데이터 영속성 보장. 개발 10Gi / 프로덕션 50Gi |
| `service.yaml` | ClusterIP Service. 백엔드 및 Celery 에서 `postgres:5432` 로 접근 |

---

### base/redis/ — 메시지 브로커 및 캐시

| 파일 | 역할 |
|---|---|
| `deployment.yaml` | Redis 7-alpine. Celery 브로커·결과 백엔드 겸 캐시. 메모리 정책 `allkeys-lru`, 256 MB 제한 |
| `service.yaml` | ClusterIP Service. `redis:6379` 로 접근 |

---

### base/monitoring/ — 메트릭 수집 및 시각화

Prometheus + Grafana 기반 모니터링 스택입니다. 자체 `kustomization.yaml` 을 보유하며 base 루트 kustomization 에서 선택적으로 포함합니다.

| 파일 | 역할 |
|---|---|
| `prometheus-deployment.yaml` | Prometheus 서버. PromQL 쿼리 엔진 및 메트릭 저장소 |
| `prometheus-configmap.yaml` | `prometheus.yml` scrape 설정. 백엔드·kube-state-metrics·node-exporter·blackbox 타겟 포함 |
| `prometheus-rbac.yaml` | Prometheus 가 클러스터 리소스를 스크레이핑하기 위한 ClusterRole / ClusterRoleBinding |
| `prometheus-service.yaml` | ClusterIP Service (포트 9090). 백엔드 `PrometheusService` 에서 PromQL 쿼리 |
| `grafana-deployment.yaml` | Grafana 대시보드 서버. Prometheus 를 기본 데이터소스로 설정 |
| `grafana-configmap.yaml` | Grafana datasource 및 dashboard provisioning 설정 |
| `grafana-service.yaml` | ClusterIP Service (포트 3000) |
| `node-exporter.yaml` | DaemonSet. 각 노드의 CPU·메모리·디스크·네트워크 메트릭 수집 |
| `kube-state-metrics.yaml` | Deployment + RBAC. K8s 오브젝트(Pod·Node·Deployment 등) 상태를 메트릭으로 변환 |
| `blackbox-exporter.yaml` | HTTP/TCP 엔드포인트 가용성(블랙박스) 프로브. 외부 URL 및 클러스터 내 서비스 헬스 점검 |
| `network-quality-servicemonitor.yaml` | 네트워크 품질 지표를 수집하는 ServiceMonitor 정의. Prometheus Operator 사용 시 적용 |

---

### base/observability/ — 네트워크 텔레메트리 수집

네트워크 장비(라우터·스위치)로부터 gNMI / BMP / SNMP 데이터를 수집하는 별도 네임스페이스(`network-observability`) 스택입니다.

| 파일 | 역할 |
|---|---|
| `gnmic-telemetry.yaml` | gNMIc Collector. gNMI Streaming Telemetry 로 네트워크 장비 인터페이스·BGP 상태 수집 |
| `openbmp-collector.yaml` | OpenBMP Collector. BGP Monitoring Protocol 메시지를 수신·파싱하여 Kafka 또는 PostgreSQL 에 저장 |
| `telegraf-snmp.yaml` | Telegraf SNMP input 플러그인. SNMP v2c/v3 폴링으로 네트워크 장비 메트릭 수집 후 Prometheus remote_write |
| `namespace.yaml` | `network-observability` 전용 네임스페이스 |
| `kustomization.yaml` | 하위 리소스 묶음 |

> 상세는 [base/observability/README.md](base/observability/README.md) 참고 (포트·Prometheus 연동 등).

---

### base/grafana-renderer/ — Grafana 이미지 렌더러

Grafana 패널을 PNG/PDF 이미지로 렌더링하는 사이드카 서비스입니다. 알림(Alert) 또는 리포트에 패널 스크린샷을 첨부할 때 필요합니다.

| 파일 | 역할 |
|---|---|
| `deployment.yaml` | `grafana/grafana-image-renderer` 컨테이너. 포트 8081, Grafana Deployment 와 통신 |
| `service.yaml` | ClusterIP Service. Grafana 가 `http://grafana-renderer:8081` 로 렌더 요청 전달 |

---

### base/kubewatch/ — K8s 이벤트 감시 및 알림

K8s 클러스터에서 발생하는 Pod CrashLoop, 배포 실패 등의 이벤트를 감지하여 Slack 또는 Webhook 으로 알림을 전송합니다.

| 파일 | 역할 |
|---|---|
| `deployment.yaml` | kubewatch 컨테이너. 클러스터 이벤트 구독 및 알림 발송 |
| `configmap.yaml` | kubewatch 설정 (감시 리소스 종류, Slack webhook URL 등) |
| `rbac.yaml` | ClusterRole + ClusterRoleBinding. Pod·Deployment·Service 이벤트 Watch 권한 |

---

### overlays/ — 환경별 Kustomize 오버레이

| 오버레이 | 네임스페이스 | 목적 및 주요 차이점 |
|---|---|---|
| `dev/` | `k8s-monitor-dev` (namePrefix `dev-`) | 개발 환경. 레플리카 1개, DEBUG 활성화, 체크 주기 1분, 인그레스 호스트 `k8s-monitor-dev.local` |
| `prod/` | `k8s-monitor-prod` (namePrefix `prod-`) | 프로덕션. backend/frontend/celery 각 3개 레플리카, TLS(cert-manager), HPA 활성화, 체크 주기 5분 |
| `kind/` | `k8s-monitor` | 로컬 kind 클러스터. NodePort(30080 frontend / 30800 backend) 노출. `scripts/kind-setup.sh` 와 연동 |
| `airgap/` | `k8s-monitor` | 폐쇄망. 모든 이미지를 내부 레지스트리 미러로 교체, 외부 인터넷 불필요. **레플리카 1개**(HPA 전체 삭제), `DEBUG=true`, Ingress 삭제(NodePort 노출, TLS 없음) |

---

### superpod/ — SuperPod 독립 배포

PEP 메인 스택과 별도로 배포되는 SuperPod(in_cluster deep check) CronJob 모듈입니다.
독립적인 네임스페이스와 ServiceAccount 를 가지며, 스케줄 기반으로 클러스터 점검 작업을
수행합니다. **상세 배포 절차는 [superpod/README.md](superpod/README.md) 를 신뢰할 것**
(이 표는 파일 역할 요약만).

| 파일 | 역할 |
|---|---|
| `namespace.yaml` | `k8s-monitor-agent`(SuperPod 본체) + `devops`(pod_to_pod 체커의 일회용 probe pod 용) 2개 네임스페이스 생성. ResourceQuota 없음 |
| `serviceaccount.yaml` | SuperPod 전용 ServiceAccount + ClusterRole — 노드/Pod 읽기 외에도 services/endpoints/deployments/statefulsets/RBAC 조회, `pods/exec`·`pods/proxy`·`nodes/proxy` 실행, `pods` create/delete 등 광범위한 권한 포함 |
| `cronjob.yaml` | SuperPod CronJob. 정기적으로 `python -m app.superpod.runner` 실행 (`SUPERPOD_MODE=in_cluster`) |
| `secret.yaml.tmpl` | API 키·자격증명 Secret 템플릿. `cp secret.yaml.tmpl secret.yaml` 후 값 채우고 kustomization.yaml 에서 주석 해제 → `kubectl apply -k .` (envsubst 방식 아님) |
| `kustomization.yaml` | superpod 모듈 리소스 묶음, namespace `k8s-monitor-agent` |

---

### ansible-playbooks/ — Ansible 플레이북 소스

백엔드 Celery Worker 가 마운트하는 Ansible 플레이북 원본 파일입니다.

| 파일 | 역할 |
|---|---|
| `check_cluster.yml` | 대상 클러스터에 SSH 접속하여 노드 상태, 시스템 리소스, 서비스 프로세스를 점검하고 결과를 JSON 으로 반환 |

> `k8s/base/ansible-playbooks-check_cluster.yml` 은 이 파일을 ConfigMap 으로 패키징한 K8s 리소스입니다. 백엔드 Deployment 에서 볼륨 마운트하여 `ansible-runner` 로 실행합니다.

---

## 사전 요구사항

1. **Kubernetes 클러스터** (v1.25+)
2. **kubectl** 설치
3. **Kustomize** 설치 (v5.0+)
4. **NGINX Ingress Controller** 설치
5. **StorageClass** 설정 (PostgreSQL PVC 용)

---

## 빠른 시작

### 개발 환경 배포

```bash
# 매니페스트 미리보기
kustomize build k8s/overlays/dev

# 배포
kubectl apply -k k8s/overlays/dev
```

### 프로덕션 환경 배포

```bash
# 시크릿 수정 후 배포
kubectl apply -k k8s/overlays/prod
```

### 로컬 kind 클러스터 배포

```bash
bash scripts/kind-setup.sh up      # 클러스터 생성 + 이미지 빌드 + 배포
bash scripts/kind-setup.sh reload  # 코드 변경 후 재빌드
bash scripts/kind-setup.sh destroy # 클러스터 삭제
# Frontend: http://localhost:30080
# Backend:  http://localhost:30800/docs
```

### SuperPod 독립 배포

```bash
# secret 템플릿 복사·값 채우기 → kustomization.yaml 에서 secret.yaml 주석 해제 → 배포
cp k8s/superpod/secret.yaml.tmpl k8s/superpod/secret.yaml
# secret.yaml 값 채운 뒤:
kubectl apply -k k8s/superpod/
```

> 상세 절차는 [superpod/README.md](superpod/README.md) 참고 (`envsubst` 방식이 아니다).

---

## 환경별 설정 요약

| 항목 | dev | prod | kind | airgap |
|---|---|---|---|---|
| 네임스페이스 | `k8s-monitor-dev` | `k8s-monitor-prod` | `k8s-monitor` | `k8s-monitor` |
| Backend 레플리카 | 1 | 3 | 1 | **1** |
| HPA | 비활성 | 활성 | 비활성 | **비활성**(전체 삭제) |
| TLS | X | cert-manager | X | **없음**(NodePort 평문) |
| 이미지 레지스트리 | GHCR | GHCR | 로컬 빌드 | 내부 미러 |
| 인그레스 호스트 | `k8s-monitor-dev.local` | `k8s-monitor.example.com` | NodePort | **Ingress 삭제, NodePort** |
| DEBUG 모드 | 활성 | 비활성 | 활성 | **활성** |
| 체크 주기 | 1분 | 5분 | 1분 | 5분 |

---

## 컴포넌트 포트 참조

| 컴포넌트 | 포트 | 프로토콜 | 비고 |
|---|---|---|---|
| backend | 8000 | HTTP | FastAPI, `/health`, `/api/v1/...` |
| frontend | 80 | HTTP | Nginx, SPA + `/api/*` 프록시 |
| postgres | 5432 | TCP | StatefulSet |
| redis | 6379 | TCP | |
| prometheus | 9090 | HTTP | PromQL 쿼리 엔드포인트 |
| grafana | 3000 | HTTP | 대시보드 UI |
| grafana-renderer | 8081 | HTTP | 이미지 렌더 API |
| ollama | 11434 | HTTP | LLM API (선택) |

---

## 시크릿 관리 (프로덕션)

프로덕션 환경에서는 `kustomization.yaml` 의 `secretGenerator`(`k8s-monitor-secret`) 리터럴
평문 값을 반드시 교체하세요 (`base/secret.yaml` 파일 자체는 미사용 — 위 참고).

### External Secrets Operator

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: k8s-monitor-secret
spec:
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: k8s-monitor-secret
  data:
    - secretKey: DATABASE_PASSWORD
      remoteRef:
        key: k8s-monitor/database
        property: password
```

### Sealed Secrets

```bash
# k8s-monitor-secret 리터럴을 kustomize build 로 렌더링한 뒤 실제 Secret 을 봉인
kubectl kustomize k8s/base | kubeseal --format yaml > sealed-secret.yaml
```

### HashiCorp Vault

```yaml
annotations:
  vault.hashicorp.com/agent-inject: "true"
  vault.hashicorp.com/role: "k8s-monitor"
```

---

## HPA (Horizontal Pod Autoscaler)

| 컴포넌트 | Min | Max | CPU 임계값 |
|---|---|---|---|
| Backend | 2 | 10 | 70% |
| Celery Worker | 2 | 8 | 70% |
| Frontend | 2 | 6 | 70% |

```bash
kubectl get hpa -n k8s-monitor-prod
kubectl describe hpa backend-hpa -n k8s-monitor-prod
```

---

## 모니터링 클러스터 추가

```bash
# 1. 대상 클러스터 kubeconfig Secret 생성
kubectl create secret generic kubeconfig-secret \
  --from-file=config=/path/to/target/kubeconfig \
  -n k8s-monitor

# 2. API 로 클러스터 등록
curl -X POST http://k8s-monitor.local/api/v1/clusters \
  -H "Content-Type: application/json" \
  -d '{"name": "prod-cluster", "api_endpoint": "https://k8s-api.example.com:6443", "kubeconfig_path": "/root/.kube/config"}'
```

---

## 트러블슈팅

### 파드 상태 확인

```bash
kubectl get pods -n k8s-monitor-dev
kubectl describe pod <pod-name> -n k8s-monitor-dev
kubectl logs <pod-name> -n k8s-monitor-dev
```

### 데이터베이스 연결 문제

```bash
kubectl exec -it postgres-0 -n k8s-monitor -- psql -U postgres -d k8s_monitor
```

### Celery 작업 확인

```bash
kubectl logs -l app.kubernetes.io/name=celery-worker -n k8s-monitor --tail=100
kubectl exec -it $(kubectl get pod -l app.kubernetes.io/name=redis -o jsonpath='{.items[0].metadata.name}' -n k8s-monitor) -n k8s-monitor -- redis-cli ping
```

### Prometheus 미연결

```bash
# 백엔드에서 Prometheus 연결 상태 확인
curl http://localhost:8000/api/v1/promql/health
```

### Grafana 이미지 렌더링 실패

grafana-renderer Deployment 가 Running 상태인지 확인 후 Grafana ConfigMap 의 `GF_RENDERING_SERVER_URL` 값을 점검합니다.

```bash
kubectl logs -l app=grafana-renderer -n k8s-monitor
```

---

## CI/CD

### 필요한 GitHub Secrets

| Secret | 설명 |
|---|---|
| `KUBECONFIG_DEV` | 개발 클러스터 kubeconfig (base64 인코딩) |
| `KUBECONFIG_PROD` | 프로덕션 클러스터 kubeconfig (base64 인코딩) |

```bash
cat ~/.kube/config | base64 -w 0
```

### 이미지 업데이트 및 롤링 배포

```bash
kustomize edit set image ghcr.io/your-repo/backend=ghcr.io/your-repo/backend:v1.2.0
kubectl apply -k k8s/overlays/prod
kubectl rollout status deployment/prod-backend -n k8s-monitor-prod
```

### 롤백

```bash
kubectl rollout undo deployment/prod-backend -n k8s-monitor-prod
kubectl rollout undo deployment/prod-frontend -n k8s-monitor-prod
```

---

## 리소스 정리

```bash
kubectl delete -k k8s/overlays/dev
kubectl delete -k k8s/overlays/prod
kubectl delete -k k8s/superpod/
# 또는 네임스페이스 전체 삭제 (kind/airgap 은 둘 다 k8s-monitor 공유 — 함께 삭제됨)
kubectl delete namespace k8s-monitor-dev k8s-monitor-prod k8s-monitor k8s-monitor-agent devops
```
