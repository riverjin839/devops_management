# Mac 로컬 테스트 가이드 (Apple Silicon)

> **목표**: 내 맥북(Apple Silicon, M1~M4)에서 **테스트용 K8s 클러스터 2대**(kind 1 + Vagrant/k3s 1)를
> 만들고, **PEP(devops_management)** 를 docker-compose 로 기동한 뒤, 두 클러스터를 PEP 에 등록해
> 헬스 체크까지 확인한다.
>
> Intel Mac / 운영 배포는 [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md) 를 참고. 이 문서는 **Apple Silicon + 로컬 테스트** 전용이다.

---

## 전체 구성도

```
┌──────────────────────── macOS (Apple Silicon) ────────────────────────┐
│                                                                        │
│   ┌─────────────── docker-compose (PEP 앱) ───────────────┐           │
│   │  frontend:5173   backend:8000   postgres   redis        │          │
│   │  celery-worker   celery-beat                            │          │
│   │            (backend 가 docker 'kind' 네트워크에 연결)    │          │
│   └───────┬──────────────────────────────┬──────────────────┘          │
│           │ kind 네트워크 내부            │ host.docker.internal:6443   │
│           ▼                               ▼                            │
│   ┌───────────────┐              ┌─────────────────────┐               │
│   │ 테스트 클러스터 A │              │  테스트 클러스터 B    │              │
│   │   kind (3노드)  │              │  Vagrant VM + k3s    │              │
│   │ control-plane:6443│            │  (QEMU, 포트포워딩)   │              │
│   └───────────────┘              └─────────────────────┘               │
└────────────────────────────────────────────────────────────────────────┘
```

핵심 연결 원리:
- **클러스터 A (kind)**: backend 컨테이너가 docker `kind` 네트워크에 함께 붙어 있으므로,
  `kind get kubeconfig --internal` 로 얻는 `https://<name>-control-plane:6443` 주소로 직접 접속.
- **클러스터 B (k3s VM)**: VM 의 6443 을 Mac 호스트로 포워딩하고, backend 컨테이너는
  `host.docker.internal:6443` 으로 접속. k3s 를 `--tls-san host.docker.internal` 로 설치해 TLS 검증 통과.

---

## 0. 사전 설치 (한 번만)

```bash
# Homebrew 가 없다면 먼저 설치: https://brew.sh
brew install --cask docker          # Docker Desktop (실행 후 한 번 열어서 데몬 기동)
brew install kind kubectl           # kind + kubectl
brew install qemu                   # Vagrant QEMU provider 용 (Apple Silicon)
brew install --cask vagrant         # Vagrant
vagrant plugin install vagrant-qemu # QEMU provider 플러그인
```

> **Docker Desktop 리소스**: Settings → Resources 에서 **CPU 4+ / Memory 8GB+** 권장
> (kind 3노드 + PEP 컨테이너 + k3s VM 동시 구동).

> **Vagrant provider 대안**: QEMU 가 가장 간단(무료·CLI)하지만, GUI 가상화를 선호하면
> VMware Fusion 13(개인용 무료) + `vagrant-vmware-desktop`, 또는 Parallels(유료) +
> `vagrant-parallels` 도 가능하다. `vagrant/Vagrantfile` 상단 주석 참고.

---

## 1. 테스트 클러스터 A — kind 생성

PEP 의 kind 스크립트는 PEP 자체까지 kind 에 배포하지만, 여기서는 **순수 테스트 클러스터로만**
쓰기 위해 클러스터만 만든다.

```bash
# 3노드 kind 클러스터 생성 (control-plane 1 + worker 2)
kind create cluster --name test-a --image kindest/node:v1.34.0

# 확인
kubectl --context kind-test-a get nodes
```

> `kind create cluster` 가 docker **`kind` 네트워크**를 자동 생성한다.
> docker-compose 가 이 네트워크를 external 로 참조하므로, **PEP 기동(3단계) 전에 이 단계를 먼저** 해야 한다.

---

## 2. 테스트 클러스터 B — Vagrant + k3s 생성

```bash
cd vagrant
vagrant up                # QEMU VM 부팅 + provision-k3s.sh 가 k3s 설치
```

`vagrant up` 이 끝나면:
- VM 안에 단일 노드 k3s 가 `--tls-san host.docker.internal` 로 설치됨
- VM 의 6443 → Mac 호스트 `127.0.0.1:6443` 으로 포워딩됨

kubeconfig 를 Mac 으로 가져오기:

```bash
# (여전히 vagrant/ 디렉토리에서)
vagrant ssh -c 'sudo cat /etc/rancher/k3s/k3s.yaml' > k3s-kubeconfig.yaml
cd ..
```

> **검증(선택)**: `kubectl --kubeconfig vagrant/k3s-kubeconfig.yaml --server https://127.0.0.1:6443 get nodes`
> 로 Mac 에서 직접 접속되는지 확인 가능.

---

## 3. PEP(devops_management) 기동 — docker-compose

> ⚠️ **반드시 1단계(kind) 이후에 실행**. `docker-compose.yml` 이 external `kind` 네트워크를
> 참조하므로, kind 클러스터가 없으면 `network kind not found` 로 실패한다.

```bash
cp .env.example backend/.env     # 환경 변수 (최초 1회)
docker-compose up -d --build     # postgres + redis + backend + frontend + celery

# 기동 확인
docker-compose ps
curl http://localhost:8000/health
```

| 서비스 | URL |
|---|---|
| Frontend (대시보드) | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Swagger UI | http://localhost:8000/docs |

> **`host.docker.internal` 이 backend 컨테이너에서 안 풀릴 때(클러스터 B 등록 실패 시)**:
> 프로젝트 루트에 `docker-compose.override.yml` 을 만들어 host-gateway 를 명시한다.
> ```yaml
> services:
>   backend:
>     extra_hosts: ["host.docker.internal:host-gateway"]
>   celery:
>     extra_hosts: ["host.docker.internal:host-gateway"]
> ```
> 이후 `docker-compose up -d` 재실행. (Docker Desktop 에선 보통 기본 제공돼 불필요)

---

## 4. 두 클러스터를 PEP 에 등록

등록 헬퍼 스크립트가 kubeconfig 업로드 + server 주소 보정 + 즉시 헬스체크까지 처리한다.

```bash
# 클러스터 A (kind) — internal kubeconfig 자동 사용
bash scripts/register-local-cluster.sh --name test-a --kind test-a

# 클러스터 B (Vagrant k3s) — Mac 호스트 포워딩 주소로 등록
bash scripts/register-local-cluster.sh \
  --name vagrant-k3s \
  --kubeconfig vagrant/k3s-kubeconfig.yaml \
  --server https://host.docker.internal:6443
```

스크립트 동작:
1. kubeconfig 확보 (`--kind` 는 `kind get kubeconfig --internal`, `--kubeconfig` 는 파일 사용)
2. `--server` 지정 시 kubeconfig 의 `server:` 를 backend 가 도달 가능한 주소로 재작성
3. `POST /api/v1/clusters` 로 `kubeconfig_content` 와 함께 등록
4. `POST /api/v1/daily-check/run/{id}` 로 즉시 헬스체크 실행

> 등록은 기본적으로 `skip_connectivity_check=true` 로 진행되고, **실제 도달성은 4번의 헬스체크 결과로 확인**한다.
> 등록 시점에 엄격히 검증하려면 `--check` 옵션을 추가.

---

## 5. 검증

```bash
# 등록된 클러스터 목록
curl -s http://localhost:8000/api/v1/clusters | python3 -m json.tool

# 각 클러스터 최신 헬스체크 결과 (대시보드에서도 확인 가능)
# 브라우저: http://localhost:5173
```

대시보드(http://localhost:5173)에서 **클러스터 2개**가 보이고, 헬스 상태가
`healthy/warning` 으로 표시되면 성공. `pending`(미연결)이면 [트러블슈팅](#트러블슈팅) 참고.

---

## 6. 정리 (Teardown)

```bash
# PEP 중지
docker-compose down              # 데이터 유지
# docker-compose down -v         # 볼륨(DB)까지 삭제

# 클러스터 B (Vagrant) 삭제
cd vagrant && vagrant destroy -f && cd ..

# 클러스터 A (kind) 삭제  ※ docker-compose down 이후에
kind delete cluster --name test-a
```

> 순서 주의: docker-compose 가 `kind` 네트워크를 사용 중이면 `kind delete` 가 네트워크를 못 지운다.
> **PEP 를 먼저 내리고** kind 를 삭제한다.

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `docker-compose up` → `network kind not found` | kind 클러스터를 안 만듦 | 1단계(`kind create cluster --name test-a`) 먼저 실행 |
| 클러스터 A 가 `pending` | backend 가 kind 네트워크 미연결 | `docker network inspect kind` 에 `k8s_monitor_backend` 가 있는지 확인. 없으면 `docker-compose up -d` 재실행 |
| 클러스터 B 가 `pending` (connection refused) | 포트포워딩/방화벽 | Mac 에서 `curl -k https://127.0.0.1:6443/livez` 확인. 안 되면 `cd vagrant && vagrant reload` |
| 클러스터 B 가 `certificate verify failed` | tls-san 누락 | k3s 가 `--tls-san host.docker.internal` 로 설치됐는지 확인 (`vagrant ssh -c 'sudo cat /etc/systemd/system/k3s.service'`). 누락 시 `vagrant destroy -f && vagrant up` |
| 클러스터 B 가 `pending` 인데 A 는 정상 | backend 컨테이너에서 `host.docker.internal` 미해석 | 3단계의 `docker-compose.override.yml`(extra_hosts) 적용 후 재기동 |
| `vagrant up` → provider 오류 | QEMU 플러그인 미설치 | `vagrant plugin install vagrant-qemu`, `brew install qemu` 확인 |
| kind 노드가 안 뜸 | Docker 리소스 부족 | Docker Desktop 메모리 8GB+ 로 상향 |

디버그 명령:

```bash
docker network inspect kind | grep -A3 Containers   # backend 가 kind 네트워크에 있나
docker-compose logs -f backend                       # backend 로그
cd vagrant && vagrant ssh -c 'sudo k3s kubectl get nodes'   # k3s 상태
```

---

## 빠른 참조 (전체 흐름 한 번에)

```bash
# 1) 클러스터 A
kind create cluster --name test-a --image kindest/node:v1.34.0

# 2) 클러스터 B
cd vagrant && vagrant up && vagrant ssh -c 'sudo cat /etc/rancher/k3s/k3s.yaml' > k3s-kubeconfig.yaml && cd ..

# 3) PEP 기동
cp .env.example backend/.env
docker-compose up -d --build

# 4) 등록
bash scripts/register-local-cluster.sh --name test-a --kind test-a
bash scripts/register-local-cluster.sh --name vagrant-k3s --kubeconfig vagrant/k3s-kubeconfig.yaml --server https://host.docker.internal:6443

# 5) 확인 → http://localhost:5173
```
