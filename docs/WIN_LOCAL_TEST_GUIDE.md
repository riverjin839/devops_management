# Windows 로컬 테스트 가이드 (Docker Desktop)

> **목표**: Windows PC 에서 **Docker 기반 테스트 K8s 클러스터**(kind)를 만들고,
> **PEP(devops_management)** 를 docker-compose 로 기동한 뒤, 클러스터를 PEP 에 등록해 헬스 체크와
> MinIO·Host Facts 까지 확인한다. [Mac 가이드](MAC_LOCAL_TEST_GUIDE.md)의 **동일한 패턴**을
> Windows + Docker 환경으로 옮긴 문서다.
>
> Mac 은 VM(Vagrant)까지 썼지만, Windows 는 **Docker(kind)** 중심이다. RHEL10 충실도(실디스크/
> SSH/bond)가 핵심이면 VM 경로([`vagrant/kubeadm-almalinux/`](../vagrant/kubeadm-almalinux/README.md))를 쓴다.
> 이 문서는 **Windows + Docker 로컬 테스트** 전용이며, 지원 파일은 [`windows-docker/`](../windows-docker/README.md) 에 있다.

---

## 전체 구성도

```
┌──────────────────────── Windows (Docker Desktop + WSL2) ───────────────────────┐
│                                                                                 │
│   ┌─────────────── docker-compose (PEP 앱) ───────────────┐                     │
│   │  frontend:5173   backend:8000   postgres   redis        │                   │
│   │  celery-worker   celery-beat                            │                    │
│   │            (backend 가 docker 'kind' 네트워크에 연결)    │                   │
│   └───────┬──────────────────────────────┬──────────────────┘                   │
│           │ kind 네트워크 내부            │ host.docker.internal:6443            │
│           ▼                               ▼                                     │
│   ┌───────────────┐              ┌──────────────────────────┐                   │
│   │ 테스트 클러스터  │              │  Host Facts 테스트 노드    │                  │
│   │ kind (control   │              │  AlmaLinux 10 컨테이너     │                  │
│   │  + worker)      │              │  (root SSH + bond)        │                  │
│   │ MinIO + 6443    │              │  pep-node-1/2 :2221/2222  │                  │
│   └───────────────┘              └──────────────────────────┘                   │
│        ↕ C:\pep-kind\minio (MinIO 디스크 대체)                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

핵심 연결 원리 (Mac 가이드와 동일):
- **클러스터(kind)**: backend 컨테이너가 docker `kind` 네트워크에 함께 붙으면 `kind get kubeconfig --internal`
  의 `https://pep-control-plane:6443` 로 직접 접속. 또는 `host.docker.internal:6443` 로 접속(아래 4단계).
- **인증서 SAN**: kind 를 `certSANs: host.docker.internal` 로 만들어 TLS 검증 통과(`windows-docker/kind-cluster.yaml`).
- **Host Facts(SSH)**: kind 노드엔 sshd 가 없으므로, 운영 노드 흉내용 **AlmaLinux 10 컨테이너**(`node-ssh/`)를
  따로 띄워 root SSH + bond 기반 기능을 검증한다.

---

## 0. 사전 설치 (한 번만)

```powershell
# Docker Desktop (WSL2 백엔드 권장) — 설치 후 한 번 실행해 데몬 기동
winget install Docker.DockerDesktop
# kind + kubectl
winget install Kubernetes.kind
winget install Kubernetes.kubectl
```

- **WSL2 권장**: `scripts/*.sh`(bash) 와 `cilium-cli` 는 WSL2(Ubuntu) 또는 Git Bash 에서 실행한다.
  PowerShell 전용 작업(폴더 생성, kubeconfig 변환)은 `.ps1` 헬퍼로 제공한다.
- **Docker Desktop 리소스**: Settings → Resources 에서 **CPU 4+ / Memory 8GB+** 권장.
- **파일 공유**: MinIO 디스크로 쓸 `C:\pep-kind` 가 Docker Desktop 의 **Settings → Resources → File
  sharing** 에 포함돼야 한다(WSL2 백엔드면 보통 자동).

> **Cilium 까지(선택)**: Mac 가이드처럼 Cilium + Hubble 딥 트러블슈팅을 테스트하려면 WSL2 에
> cilium-cli 를 설치한다 — `CILIUM_CLI=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt); curl -sL https://github.com/cilium/cilium-cli/releases/download/$CILIUM_CLI/cilium-linux-amd64.tar.gz | sudo tar xzC /usr/local/bin`.

---

## 1. 테스트 클러스터 — kind 생성

MinIO 디스크로 쓸 Windows 폴더를 만들고, PEP 전용 kind 설정으로 클러스터를 만든다.

```powershell
cd windows-docker
New-Item -ItemType Directory -Force -Path C:\pep-kind\minio\data | Out-Null
kind create cluster --name pep --config kind-cluster.yaml
kubectl get nodes -o wide        # pep-control-plane, pep-worker 가 Ready
```

`kind-cluster.yaml` 이 하는 일: API 를 `0.0.0.0:6443` 으로 노출, 인증서 SAN 에 `host.docker.internal`
추가, worker 에 `C:\pep-kind\minio` → `/mnt/disks/minio` 마운트, MinIO NodePort(30900/30901) 포워딩.

> `kind create cluster` 가 docker **`kind` 네트워크**를 자동 생성한다. docker-compose 가 이 네트워크를
> external 로 참조하므로 **PEP 기동(3단계) 전에 이 단계를 먼저** 해야 한다.

**(선택) Cilium + Hubble** — Mac 가이드와 동일하게 하려면:
```bash
# kind-cluster.yaml 의 'disableDefaultCNI: true' 주석을 푼 뒤 클러스터 재생성, 그리고 WSL2 에서:
cilium install --version 1.16.5
cilium status --wait
cilium hubble enable --ui
```

---

## 2. Host Facts 테스트 노드 — AlmaLinux 10 컨테이너

kind 노드에는 sshd 가 없으므로, 운영 노드(RHEL10) 흉내용 AlmaLinux 10 컨테이너를 띄운다.

```powershell
cd windows-docker\node-ssh
docker compose up -d --build      # pep-node-1(:2221), pep-node-2(:2222) — root / rootpass
cd ..\..
```

- 각 컨테이너: **root SSH(비번 `rootpass`)** + (privileged 면) **dummy bond0/bond1**(10.20.0.x / 10.30.0.x).
- PEP 가 Host Facts/대량실행으로 SSH 접속해 vm/disk/NIC/bond 필드를 채우는 흐름을 검증한다.

---

## 3. PEP(devops_management) 기동 — docker-compose

> ⚠️ **반드시 1단계(kind) 이후에 실행**. `docker-compose.yml` 이 external `kind` 네트워크를
> 참조하므로, kind 클러스터가 없으면 `network kind not found` 로 실패한다.

```powershell
Copy-Item .env.example backend\.env      # 환경 변수 (최초 1회)
docker compose up -d --build             # postgres + redis + backend + frontend + celery
docker compose ps
curl http://localhost:8000/health
```

| 서비스 | URL |
|---|---|
| Frontend (대시보드) | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Swagger UI | http://localhost:8000/docs |

> **`host.docker.internal` 이 backend 컨테이너에서 안 풀릴 때**: 루트에 `docker-compose.override.yml`
> 을 만들어 `extra_hosts: ["host.docker.internal:host-gateway"]` 를 backend/celery 에 추가 후 재기동.
> (Docker Desktop 에선 보통 기본 제공돼 불필요)

---

## 4. 클러스터를 PEP 에 등록

kind 가 만든 kubeconfig 는 `server: https://0.0.0.0:6443` 라 그대로 못 쓴다. 용도별로 변환한다.

```powershell
cd windows-docker
powershell -ExecutionPolicy Bypass -File make-kubeconfigs.ps1
# → _out\admin.conf (127.0.0.1:6443), _out\pep-kubeconfig.yaml (host.docker.internal:6443)
cd ..
```

**(A) PEP UI 로 등록** — 설정 → 클러스터 → 클러스터 추가:
- **API Endpoint**: `https://host.docker.internal:6443`
- **kubeconfig**: `windows-docker\_out\pep-kubeconfig.yaml` 붙여넣기(업로드)

**(B) 스크립트로 등록** (WSL2 / Git Bash) — Mac 과 동일한 헬퍼 재사용:
```bash
bash scripts/register-local-cluster.sh \
  --name win-kind \
  --kubeconfig windows-docker/_out/pep-kubeconfig.yaml \
  --server https://host.docker.internal:6443
```

> 도달 확인(선택): `docker compose exec backend python -c "import httpx; print(httpx.get('https://host.docker.internal:6443/healthz', verify=False, timeout=5).text)"` → `ok`.

---

## 5. 검증

```powershell
# 등록된 클러스터 목록
curl http://localhost:8000/api/v1/clusters

# MinIO 설치 (worker 디스크 = C:\pep-kind\minio)
$env:KUBECONFIG = "$PWD\windows-docker\_out\admin.conf"
kubectl apply -f windows-docker\manifests\minio.yaml
kubectl -n minio rollout status deploy/minio
```

- 대시보드 http://localhost:5173 에서 클러스터가 `healthy/warning` 으로 보이면 성공.
- MinIO Console: http://localhost:30901 (`minioadmin` / `minioadmin`).
- Host Facts: PEP 노드 사양 → Host Facts 수집 → `host.docker.internal` + `2221`/`2222`, user `root`, pass `rootpass`.

---

## 6. 정리 (Teardown)

```powershell
docker compose down                          # PEP 중지 (데이터 유지; -v 로 볼륨까지)
cd windows-docker\node-ssh; docker compose down -v; cd ..\..
kind delete cluster --name pep               # ※ PEP(docker compose) 를 먼저 내린 뒤
Remove-Item -Recurse -Force C:\pep-kind, windows-docker\_out -ErrorAction SilentlyContinue
```

> 순서 주의: docker compose 가 `kind` 네트워크를 쓰는 중이면 `kind delete` 가 네트워크를 못 지운다.
> **PEP 를 먼저 내리고** kind 를 삭제한다.

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `docker compose up` → `network kind not found` | kind 클러스터를 안 만듦 | 1단계(`kind create cluster --name pep ...`) 먼저 실행 |
| 클러스터가 `pending` (connection refused) | API 포트/바인딩 | `curl -k https://127.0.0.1:6443/livez` 확인. `kind-cluster.yaml` 의 `apiServerAddress: 0.0.0.0` / `apiServerPort: 6443` 확인 |
| 클러스터가 `certificate verify failed` | SAN 누락 | `kind-cluster.yaml` 의 `certSANs: host.docker.internal` 로 생성됐는지 확인. 누락 시 클러스터 재생성 |
| backend 에서 `host.docker.internal` 미해석 | extra_hosts 누락 | 3단계의 `docker-compose.override.yml`(host-gateway) 적용 후 재기동 |
| `extraMounts` 가 비어 있음 / MinIO Pending | 파일 공유 미설정 | Docker Desktop → Settings → Resources → File sharing 에 `C:\pep-kind` 추가. 폴더 미생성이면 1단계의 `New-Item` 재실행 |
| node-ssh 의 bond 가 안 채워짐 | 컨테이너에 bonding/dummy 모듈 없음 | `privileged: true` 확인(docker-compose.yml). 그래도 없으면 WSL2 커널 한계 — bond 외 Host Facts 는 정상 |
| SSH 포트 22 고정만 받는 PEP | 포트매핑(2221/2222) 미지원 | node-ssh 컨테이너를 PEP compose 네트워크에 연결해 컨테이너명:22 로 접근(`docker network connect`) — windows-docker/README 참고 |
| kind 노드 `NotReady` | (Cilium 켰을 때) CNI 미완료 | `cilium status --wait` (WSL2). 기본(kindnet)이면 보통 즉시 Ready |
| `make-kubeconfigs.ps1` 실패 | 실행 정책 | `powershell -ExecutionPolicy Bypass -File ...` 로 실행 |

디버그 명령:
```powershell
docker network inspect kind        # backend 가 kind 네트워크에 있나
docker compose logs -f backend     # backend 로그
kubectl --context kind-pep get nodes -o wide
```

---

## 빠른 참조 (전체 흐름 한 번에)

```powershell
# 1) kind 클러스터 (MinIO 폴더 + PEP 튜닝 설정)
New-Item -ItemType Directory -Force -Path C:\pep-kind\minio\data | Out-Null
kind create cluster --name pep --config windows-docker\kind-cluster.yaml

# 2) Host Facts 노드 (AlmaLinux SSH 컨테이너)
docker compose -f windows-docker\node-ssh\docker-compose.yml up -d --build

# 3) PEP 기동
Copy-Item .env.example backend\.env
docker compose up -d --build

# 4) kubeconfig 변환 + 등록(UI 또는 스크립트)
powershell -ExecutionPolicy Bypass -File windows-docker\make-kubeconfigs.ps1
#   UI: API=https://host.docker.internal:6443 + windows-docker\_out\pep-kubeconfig.yaml

# 5) 확인 → http://localhost:5173  (MinIO: kubectl apply -f windows-docker\manifests\minio.yaml)
```
