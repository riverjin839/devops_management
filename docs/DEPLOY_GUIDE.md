# DEVOPS MANAGEMENT - 배포 가이드

> 로컬 개발 → 폐쇄망 검증 → CI/CD 운영 배포까지 3단계 가이드

## 배포 전략 개요

```
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 1: 로컬 개발 (집/사무실, 인터넷 환경)                          │
│  ┌─────────┐    ┌──────────────┐    ┌─────────────────┐             │
│  │ VSCode  │───▶│ kind 클러스터 │───▶│ 로컬 Registry   │             │
│  │ git clone│    │ (3-node)     │    │ localhost:5001  │             │
│  └─────────┘    └──────────────┘    └─────────────────┘             │
│       │                                                              │
│       ▼  git commit & push                                           │
├──────────────────────────────────────────────────────────────────────┤
│  Phase 2: 폐쇄망 검증 (회사 내부망)                                   │
│  ┌─────────┐    ┌──────────────┐    ┌─────────────────┐             │
│  │ 로컬 PC │───▶│ podman/docker│───▶│ Private Registry│             │
│  │ git copy │    │ /nerdctl     │    │ (proxy 연동)     │             │
│  └─────────┘    └──────────────┘    └────────┬────────┘             │
│                                              │                       │
│                                        ┌─────▼──────┐               │
│                                        │  dev K8s   │               │
│                                        │ helm/kustomize             │
│                                        └────────────┘               │
├──────────────────────────────────────────────────────────────────────┤
│  Phase 3: CI/CD 자동화 (운영)                                        │
│  ┌─────────┐    ┌──────────┐    ┌──────────┐    ┌────────────┐     │
│  │ Git Push│───▶│ Jenkins  │───▶│ Registry │───▶│  ArgoCD    │     │
│  │         │    │ (CI)     │    │ (Push)   │    │ (CD → K8s) │     │
│  └─────────┘    └──────────┘    └──────────┘    └────────────┘     │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 로컬 개발 빠른 시작 (K8s 없이)

K8s 클러스터 없이 앱만 띄워 개발할 때는 **Docker Compose** 가 가장 빠르다.

```bash
git clone <repo-url> && cd devops_management
cp .env.example backend/.env
docker network create kind  # backend/celery 가 kind 네트워크(external)를 참조하므로 먼저 생성
docker-compose up -d        # postgres + redis + backend + frontend + celery(worker/beat)
# Frontend  http://localhost:5173   (컨테이너 80 → 호스트 5173)
# Backend   http://localhost:8000/docs
docker-compose down         # 정리
```

> `docker-compose.yml` 의 `networks.kind` 는 `external: true` 다. 위 네트워크를 먼저
> 만들지 않으면 `docker-compose up` 이 "network kind ... not found" 로 실패한다.
> Phase 1(kind) 을 먼저 진행했다면 kind 가 이미 이 네트워크를 만들어 두므로 생략 가능.

네이티브 실행(핫리로드)·Makefile 단축 명령:

```bash
make install   # backend pip + frontend npm 설치
make dev       # uvicorn(:8000) + vite(:5173) 병렬 기동
make test      # backend pytest + frontend lint
make help      # 전체 타깃
```

> kubectl 기반 점검(노드/파드/이벤트)은 컨테이너 안에 kubeconfig 가 없으면 동작하지 않는다.
> 실제 클러스터를 붙여 테스트하려면 OS 별 가이드를 따른다:
> **Mac** → [MAC_LOCAL_TEST_GUIDE.md](MAC_LOCAL_TEST_GUIDE.md) · **Windows** → [WIN_LOCAL_TEST_GUIDE.md](WIN_LOCAL_TEST_GUIDE.md)

---

## Phase 1: 로컬 개발 (kind 클러스터)

집이나 인터넷 되는 환경의 Mac/Linux에서 git clone 후 바로 K8s 환경을 띄워서 테스트합니다.

### 사전 설치

```bash
# Mac
brew install docker kind kubectl helm
# Docker Desktop 실행 필요
```

### 한 줄로 전체 환경 구축

```bash
git clone <repo-url>
cd devops_management

bash scripts/kind-setup.sh up   # kind 노드 이미지 v1.34.0, 기본 CNI(kindnet)
```

> kind 는 기본 CNI(kindnet)로 뜬다. **Cilium/Hubble 딥 트러블슈팅**까지 로컬에서 검증하려면
> 별도 워크플로(`scripts/local-cilium-kind.sh`)나 Vagrant 클러스터를 쓴다 —
> [MAC_LOCAL_TEST_GUIDE.md](MAC_LOCAL_TEST_GUIDE.md) 참고.

이 명령이 수행하는 작업:

| 단계 | 내용 |
|------|------|
| 1 | 로컬 Docker Registry 생성 (`localhost:5001`) |
| 2 | kind 3노드 클러스터 생성 (control-plane 1 + worker 2) |
| 3 | Backend/Frontend 이미지 빌드 & Push |
| 4 | Kustomize로 K8s 배포 (`k8s/overlays/kind`, namespace `k8s-monitor`) |
| 5 | Pod 상태 대기 및 접속 URL 안내 |

### 접속 확인

| 서비스 | URL |
|--------|-----|
| Frontend (대시보드) | `http://localhost:30080` |
| Backend API | `http://localhost:30800` |
| Swagger UI | `http://localhost:30800/docs` |

### 개발 사이클

```bash
# 1. 코드 수정 (VSCode에서)

# 2. 재빌드 & 재배포
bash scripts/kind-setup.sh reload

# 3. 로그 확인
bash scripts/kind-setup.sh logs backend
bash scripts/kind-setup.sh logs frontend

# 4. 상태 확인
bash scripts/kind-setup.sh status
```

### 검증 후 커밋

```bash
# API 테스트
curl http://localhost:30800/health
curl http://localhost:30800/api/v1/clusters/

# 브라우저에서 http://localhost:30080 확인

# 문제 없으면 커밋
git add -A
git commit -m "feat: 기능 설명"
git push origin main
```

### 환경 정리

```bash
bash scripts/kind-setup.sh destroy
```

### 스크립트 전체 명령어

```bash
bash scripts/kind-setup.sh up       # 전체 환경 구축 (최초 1회)
bash scripts/kind-setup.sh build    # 이미지 빌드만
bash scripts/kind-setup.sh deploy   # K8s 배포만
bash scripts/kind-setup.sh reload   # 코드 수정 후 재빌드 & 재배포
bash scripts/kind-setup.sh status   # Pod 상태 확인
bash scripts/kind-setup.sh logs <name>  # 로그 확인 (backend/frontend/celery-worker)
bash scripts/kind-setup.sh destroy  # 전체 환경 삭제
```

---

## Phase 2: 폐쇄망 검증

회사 폐쇄망 환경에서 실제 K8s 클러스터에 배포 테스트합니다.

### 전제 조건

- Git 소스가 폐쇄망 PC에 복사됨
- 컨테이너 런타임 설치됨 (podman, nerdctl, docker 중 하나)
- Private Registry 존재 (proxy로 외부 이미지 pull 가능)
- kubectl로 타겟 K8s 클러스터 접근 가능

### 방법 A: 스크립트로 배포 (Kustomize)

```bash
cd /path/to/k8s_daily_monitor

# 전체 수행: CLI 선택 → 레지스트리 입력 → 로그인 → 빌드 → 푸시 → 배포
bash scripts/deploy-airgap.sh all
```

대화형으로 진행됩니다:

```
========================================
 컨테이너 런타임 선택
========================================
사용 가능한 컨테이너 런타임:
  1) podman  (podman version 4.x.x)
  2) nerdctl (nerdctl version 1.x.x)
선택 [1-2] (기본: 1): 1

========================================
 Private 레지스트리 설정
========================================
레지스트리 주소 (예: harbor.local:5000): 10.61.162.101:5000

========================================
 레지스트리 로그인
========================================
로그인이 필요합니까? [Y/n]: Y
사용자명: admin
비밀번호: ****
✓ 로그인 성공
```

환경변수로 한 줄에 실행도 가능:

```bash
CTR_CLI=podman REGISTRY=10.61.162.101:5000 REGISTRY_USER=admin REGISTRY_PASS=xxxx \
  bash scripts/deploy-airgap.sh all
```

### 방법 B: Helm으로 배포

```bash
# 이미지 빌드 & 푸시 (방법 A와 동일)
bash scripts/deploy-airgap.sh build
bash scripts/deploy-airgap.sh push

# Helm으로 배포
helm install k8s-monitor ./helm/k8s-daily-monitor \
  -f ./helm/k8s-daily-monitor/values-airgap.yaml \
  -n k8s-monitor --create-namespace

# 업그레이드
helm upgrade k8s-monitor ./helm/k8s-daily-monitor \
  -f ./helm/k8s-daily-monitor/values-airgap.yaml \
  -n k8s-monitor
```

### 방법 C: 이미지 파일 전송 (Registry 접근 불가 시)

인터넷 되는 PC에서:
```bash
bash scripts/deploy-airgap.sh save
# → images/ 디렉토리에 tar.gz 약 8개 생성
#   (앱: backend, frontend + DB: postgres, redis
#    + 모니터링 스택: prometheus, grafana, node-exporter, kube-state-metrics)
# USB 등으로 폐쇄망 전송
```

폐쇄망에서:
```bash
bash scripts/deploy-airgap.sh load   # tar.gz → 이미지 로드
bash scripts/deploy-airgap.sh push   # 레지스트리에 푸시
bash scripts/deploy-airgap.sh deploy # K8s 배포
```

### 배포 확인

```bash
# Pod 상태
kubectl get pods -n k8s-monitor -w

# 전체 리소스
kubectl get all -n k8s-monitor

# 헬스 체크
curl http://<NODE_IP>:30800/health
curl http://<NODE_IP>:30800/health/ready

# 브라우저 접속
# http://<NODE_IP>:30080
```

### 스크립트 전체 명령어

```bash
bash scripts/deploy-airgap.sh build    # 이미지 빌드
bash scripts/deploy-airgap.sh push     # 레지스트리 푸시 (로그인 포함)
bash scripts/deploy-airgap.sh save     # tar.gz 저장 (오프라인 전송용)
bash scripts/deploy-airgap.sh load     # tar.gz 로드
bash scripts/deploy-airgap.sh deploy   # K8s 배포
bash scripts/deploy-airgap.sh all      # 빌드 → 로그인 → 푸시 → 배포
bash scripts/deploy-airgap.sh status   # 배포 상태
bash scripts/deploy-airgap.sh check    # K8s API 서버 헬스 체크
```

### values-airgap.yaml 설정 항목

`helm/k8s-daily-monitor/values-airgap.yaml`에서 환경에 맞게 수정:

| 항목 | 기본값 | 설명 |
|------|--------|------|
| `global.imageRegistry` | `10.61.162.101:5000` | Private Registry 주소 — **반드시 자기 환경 값으로 변경** (`--set` 도 가능) |
| `secrets.databasePassword` | `postgres` | DB 비밀번호 — 운영 전 변경 |
| `secrets.secretKey` | `airgap-secret-key-change-this` | 앱 시크릿 키 — 운영 전 변경 |
| `nodePort.frontend` | `30080` | Frontend NodePort |
| `nodePort.backend` | `30800` | Backend NodePort |
| `ollama.model` | `qwen2.5-coder:7b` | 폐쇄망 LLM 모델(사전 적재 커스텀 이미지 기준). AI 점검/요약 사용 시 |

> 폐쇄망에서 **Ollama 모델을 Nexus/오프라인으로 적재**하는 방법(docker-proxy / raw repo / tar.gz)은
> [AIRGAP_LLM_NEXUS.md](AIRGAP_LLM_NEXUS.md) 참고. LLM 미설정 시 AI 기능만 offline 으로 우아하게 비활성화된다.

---

## Phase 3: CI/CD 자동화 (운영)

**기본(인터넷 연결 가능한 환경) 파이프라인은 GitHub Actions** 다 —
`.github/workflows/ci.yml`(프론트 lint/tsc/build + 백엔드 pytest) →
`cd.yml`(GHCR 이미지 빌드·푸시 → Kustomize 배포) → `release.yml`/`auto-release.yml`
(SemVer 자동 태깅 + GitHub Release, 상세는 [branch-tag-strategy.md](branch-tag-strategy.md)).
필요 GitHub secrets: `KUBECONFIG_DEV`, `KUBECONFIG_PROD`.

**폐쇄망/온프레미스 대안**으로 Jenkins(CI) + ArgoCD(CD) 조합을 아래에 설명한다 —
외부 GitHub Actions 러너 접근이 불가한 환경에서 사용한다.

### 아키텍처 (Jenkins + ArgoCD 대안)

```
개발자                Jenkins (CI)                    ArgoCD (CD)
  │                      │                               │
  │  git push            │                               │
  ├─────────────────────▶│                               │
  │                      │  1. Backend pytest             │
  │                      │  2. Frontend lint + tsc        │
  │                      │  3. Docker 이미지 빌드 (병렬)   │
  │                      │  4. Private Registry Push      │
  │                      │  5. Helm lint                  │
  │                      │  6. ArgoCD sync 트리거 ────────▶│
  │                      │                               │  7. Helm values 업데이트
  │                      │                               │  8. 타겟 K8s 배포
  │                      │                               │  9. selfHeal 활성화
```

### 필요 파일

| 파일 | 용도 |
|------|------|
| `Jenkinsfile` | CI 파이프라인 정의 |
| `helm/k8s-daily-monitor/` | Helm Chart (배포 패키지) |
| `argocd/application.yaml` | ArgoCD Application 정의 |
| `argocd/project.yaml` | ArgoCD AppProject (선택) |

### Jenkins 설정

#### 1. Credentials 등록

Jenkins 관리 → Credentials에 다음 등록:

| ID | 타입 | 용도 |
|----|------|------|
| `registry-credentials` | Username/Password | Private Registry 로그인 |
| `git-credentials` | Username/Password | 폐쇄망 Git 접근 |
| `argocd-auth-token` | Secret text | ArgoCD API 토큰 |

#### 2. Pipeline Job 생성

- New Item → Pipeline
- Pipeline → Definition: Pipeline script from SCM
- SCM: Git → Repository URL: `https://git.company.internal/devops/k8s_daily_monitor.git`
- Script Path: `Jenkinsfile`
- Branch: `*/main`

#### 3. Jenkinsfile 주요 단계

```
Checkout → Backend Test → Frontend Lint → Build Images (병렬) → Push → Helm Lint → ArgoCD Sync
```

`Jenkinsfile`에서 환경에 맞게 수정할 변수:

```groovy
environment {
    REGISTRY       = '10.61.162.101:5000'     // Private Registry 주소
    ARGOCD_SERVER  = 'argocd.company.internal' // ArgoCD 서버
    ARGOCD_APP     = 'k8s-daily-monitor'       // ArgoCD App 이름
}
```

### ArgoCD 설정

#### 1. Git Repository 등록

```bash
argocd repo add https://git.company.internal/devops/k8s_daily_monitor.git \
  --username <user> --password <pass>
```

#### 2. Application 생성

```bash
kubectl apply -f argocd/application.yaml
```

`argocd/application.yaml` 수정 필요 항목:

```yaml
spec:
  source:
    repoURL: https://git.company.internal/devops/k8s_daily_monitor.git  # Git 주소
    helm:
      parameters:
        - name: global.imageRegistry
          value: "10.61.162.101:5000"   # Registry 주소
  destination:
    server: https://kubernetes.default.svc  # 타겟 K8s API
    namespace: k8s-monitor
```

#### 3. 동기화 정책

`application.yaml`에 설정된 자동 동기화:

| 정책 | 설정 | 설명 |
|------|------|------|
| `automated.prune` | true | Git에서 삭제된 리소스 자동 삭제 |
| `automated.selfHeal` | true | K8s에서 수동 변경 시 자동 복원 |
| `retry.limit` | 3 | 실패 시 3회 재시도 |

#### 4. 확인

```bash
# ArgoCD 앱 상태
argocd app get k8s-daily-monitor

# Sync 히스토리
argocd app history k8s-daily-monitor

# 수동 Sync (필요 시)
argocd app sync k8s-daily-monitor
```

### Helm Chart 사용법

#### 환경별 values 파일

| 파일 | 용도 | 주요 차이 |
|------|------|-----------|
| `values.yaml` | 기본값 | 2 replicas, Ingress 활성화, HPA 활성화 |
| `values-dev.yaml` | 로컬 kind | 1 replica, NodePort, HPA 비활성화 |
| `values-airgap.yaml` | 폐쇄망 | Private Registry, 1 replica, NodePort |
| `values-prod.yaml` | 운영 | 2+ replicas, Ingress, HPA 활성화 |

#### Helm 명령어

```bash
# 설치
helm install k8s-monitor ./helm/k8s-daily-monitor \
  -f ./helm/k8s-daily-monitor/values-prod.yaml \
  -n k8s-monitor --create-namespace

# 업그레이드
helm upgrade k8s-monitor ./helm/k8s-daily-monitor \
  -f ./helm/k8s-daily-monitor/values-prod.yaml \
  -n k8s-monitor

# 롤백
helm rollback k8s-monitor 1 -n k8s-monitor

# 삭제
helm uninstall k8s-monitor -n k8s-monitor

# 템플릿 미리보기 (dry-run)
helm template k8s-monitor ./helm/k8s-daily-monitor \
  -f ./helm/k8s-daily-monitor/values-prod.yaml

# 검증
helm lint ./helm/k8s-daily-monitor \
  -f ./helm/k8s-daily-monitor/values-prod.yaml
```

---

## 데이터 백업 / 복구

애플리케이션 데이터(클러스터·업무·점검 정의·지식 문서·설정 등)는 **Settings → 백업 / 복구** 탭에서
JSON 단일 파일로 내보내고 되돌릴 수 있다(테이블별 fault-tolerant, 민감 컬럼 기본 마스킹).
배포·업그레이드 전 백업 권장. 상세 절차·옵션·API 는 [BACKUP_RESTORE_GUIDE.md](BACKUP_RESTORE_GUIDE.md).

> 인프라 차원(PV 스냅샷, `pg_dump`)은 별도 병행을 권장한다.

---

## 트러블슈팅

### 공통

| 증상 | 원인 | 해결 |
|------|------|------|
| `ImagePullBackOff` | 레지스트리에서 이미지 못 가져옴 | `kubectl describe pod <pod>` → 이미지 경로/태그 확인 |
| `CrashLoopBackOff` (backend) | DB 연결 실패 | postgres Pod Ready 확인, Secret의 DATABASE_URL 확인 |
| `Init:0/1` (backend) | init container에서 postgres 대기 | postgres가 먼저 올라올 때까지 대기 (정상) |
| Frontend 빈 화면 | Backend API 연결 실패 | nginx-config ConfigMap의 proxy_pass 주소 확인 |
| Celery 작업 미실행 | Redis 연결 실패 | redis Pod 상태 확인, CELERY_BROKER_URL 확인 |

### Phase 1 (kind)

```bash
# kind 클러스터 상태 확인
kind get clusters
kubectl cluster-info --context kind-k8s-monitor-dev

# 이미지가 kind에 로드되었는지 확인
docker exec kind-k8s-monitor-dev-control-plane crictl images
```

### Phase 2 (폐쇄망)

```bash
# 레지스트리 접속 확인
curl -k https://10.61.162.101:5000/v2/_catalog

# insecure registry 설정 (podman)
# /etc/containers/registries.conf 에 추가:
# [[registry]]
# location = "10.61.162.101:5000"
# insecure = true
```

### Phase 3 (CI/CD)

```bash
# Jenkins 빌드 로그
# Jenkins UI → Job → Build → Console Output

# ArgoCD 동기화 상태
argocd app get k8s-daily-monitor
argocd app diff k8s-daily-monitor

# ArgoCD 로그
kubectl logs -l app.kubernetes.io/name=argocd-application-controller -n argocd
```

---

## 프로젝트 디렉토리 구조

```
k8s_daily_monitor/
├── backend/                        # FastAPI Backend
├── frontend/                       # React Frontend
│
├── k8s/                            # Kustomize 매니페스트 (Phase 1, 2)
│   ├── base/                       # 기본 리소스
│   └── overlays/
│       ├── dev/                    # 개발 환경
│       ├── prod/                   # 운영 환경
│       └── airgap/                 # 폐쇄망
│
├── helm/k8s-daily-monitor/         # Helm Chart (Phase 2, 3)
│   ├── Chart.yaml
│   ├── values.yaml                 # 기본값
│   ├── values-dev.yaml             # kind/개발
│   ├── values-airgap.yaml          # 폐쇄망
│   ├── values-prod.yaml            # 운영
│   └── templates/                  # K8s 템플릿
│
├── scripts/
│   ├── kind-setup.sh               # Phase 1: kind 로컬 개발
│   ├── deploy-airgap.sh            # Phase 2: 폐쇄망 배포
│   └── init-cluster.sh             # 클러스터 초기 등록
│
├── Jenkinsfile                     # Phase 3: CI 파이프라인
│
├── argocd/
│   ├── application.yaml            # Phase 3: ArgoCD Application
│   └── project.yaml                # Phase 3: ArgoCD Project
│
├── docker-compose.yml              # 로컬 Docker 개발
├── skaffold.yaml                   # Skaffold 개발
└── Makefile                        # 빌드 명령어
```
