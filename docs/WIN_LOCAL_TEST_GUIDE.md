# Windows 로컬 테스트 가이드 (폐쇄망 동일 K8s · 멀티 클러스터)

> **목표**: Windows PC 에서 **폐쇄망 운영 서버와 동일한 K8s 클러스터**(AlmaLinux 10 + kubeadm,
> 실 VM · root SSH · 서버정보 · bond · 실디스크)를 **2개** 띄우고, **PEP(devops_management)** 를
> docker-compose 로 기동한 뒤 두 클러스터를 등록해 **멀티 클러스터** 모니터링·Host Facts·MinIO 를 검증한다.
>
> kind(Docker) 노드는 SSH/서버정보가 없어 폐쇄망 충실도가 떨어진다. 그래서 Windows 도 **Vagrant +
> VirtualBox 로 진짜 VM** 을 쓴다. 더 가벼운 Docker(kind) 대안이 필요하면 [`windows-docker/`](../windows-docker/README.md) 참고.
> Mac(Apple Silicon) 은 [MAC_LOCAL_TEST_GUIDE.md](MAC_LOCAL_TEST_GUIDE.md) 를 본다 — 이 문서와 패턴은 동일하다.

---

## 전체 구성도

```
┌──────────────────────────── Windows (Docker Desktop + VirtualBox) ───────────────────────────┐
│                                                                                               │
│   ┌─────────────── docker-compose (PEP 앱) ───────────────┐                                   │
│   │  frontend:5173  backend:8000  postgres  redis  celery  │                                  │
│   └───────┬───────────────────────────┬───────────────────┘                                  │
│           │ host.docker.internal:6443  │ host.docker.internal:6444                            │
│           ▼                            ▼                                                       │
│   ┌──────────────────────────┐  ┌──────────────────────────┐                                  │
│   │ 클러스터 1 (VirtualBox VM) │  │ 클러스터 2 (VirtualBox VM) │   ← 둘 다 폐쇄망 동일            │
│   │ AlmaLinux10 + kubeadm     │  │ AlmaLinux10 + kubeadm     │     (root SSH/서버정보/bond)     │
│   │ 192.168.56.10~12          │  │ 192.168.57.10~12          │                                 │
│   │ control + worker×2, MinIO │  │ control + worker×2, MinIO │                                 │
│   └──────────────────────────┘  └──────────────────────────┘                                  │
│        ↕ root SSH(22) + dummy bond0/bond1 (Host Facts / 대량실행)                              │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

핵심 연결 원리 (Mac 가이드와 동일):
- **API 접속**: 각 VM 의 6443 을 Windows 호스트로 포워딩(클러스터1→6443, 클러스터2→**6444**, 충돌 방지).
  backend 컨테이너는 `host.docker.internal:6443` / `:6444` 로 접속하고, 인증서 SAN 에
  `host.docker.internal` 을 넣어 TLS 검증도 통과한다.
- **폐쇄망 충실도**: 노드가 진짜 VM 이라 **root+비번 SSH·dummy bond0/bond1·실 10GB 디스크(xfs)**
  가 있어 운영 노드와 동일하게 Host Facts/대량실행/MinIO 를 검증한다.

---

## 0. 사전 설치 (한 번만)

```powershell
winget install Docker.DockerDesktop      # 설치 후 한 번 실행해 데몬 기동 (WSL2 백엔드 권장)
winget install Hashicorp.Vagrant
winget install Oracle.VirtualBox         # VirtualBox 7.x
winget install Kubernetes.kubectl        # (선택) 호스트에서 kubectl
```

- **VirtualBox + Docker Desktop(WSL2) 공존**: VirtualBox **7.x** + 최신 Windows 10/11 에서
  Hyper-V/WSL2 와 공존 가능(성능 약간 저하). 충돌 시 [트러블슈팅](#트러블슈팅) 참고.
- **리소스**: VM 클러스터 2개(각 3노드) + PEP. **CPU 6+ / RAM 16GB+** 권장.
- **WSL2/Git Bash**: 등록 스크립트(`scripts/register-local-cluster.sh`)는 bash 라 WSL2 또는 Git Bash 에서 실행한다(또는 PEP UI 로 등록).

---

## 1. 클러스터 1 — AlmaLinux kubeadm VM 생성

```powershell
cd vagrant\kubeadm-almalinux
vagrant up --provider=virtualbox        # control-plane + worker×2 (CRI-O + Cilium). 5~10분
vagrant status
```

완료되면 `vagrant\kubeadm-almalinux\_out\` 에 산출물이 생성된다:

| 파일 | 용도 |
|---|---|
| `_out\pep-kubeconfig.yaml` | **PEP 등록용** (server=`https://host.docker.internal:6443`) |
| `_out\admin.conf` | 호스트에서 kubectl 직접 사용 (server=`192.168.56.10:6443`) |

```powershell
$env:KUBECONFIG = "$PWD\_out\admin.conf"
kubectl get nodes -o wide               # k8s-control-1 / k8s-worker-1 / k8s-worker-2 = Ready
```

---

## 2. 클러스터 2 — 같은 Vagrantfile, 다른 클러스터

`PEP_CLUSTER=2` + `VAGRANT_DOTFILE_PATH=.vagrant-c2` 로 **독립 상태**의 2번째 클러스터를 띄운다.
서브넷(192.168.57.x) · host 포트(6444) · VM 이름(`c2-…`) · 산출물(`_out-c2\`)이 자동 분리된다.

```powershell
cd vagrant\kubeadm-almalinux
$env:PEP_CLUSTER = "2"
$env:VAGRANT_DOTFILE_PATH = ".vagrant-c2"
vagrant up --provider=virtualbox        # 클러스터 2 생성
vagrant status                          # (이 셸에선 계속 c2 를 가리킴)
```

> ⚠️ **클러스터 2 를 다룰 땐 항상 같은 두 env 를 준 셸**에서 `vagrant` 를 실행한다
> (`up`/`status`/`ssh`/`destroy` 모두). env 가 없으면 클러스터 1 을 가리킨다.
> 새 PowerShell 창을 열면 두 변수를 다시 설정하거나, 클러스터 1 작업은 변수 없는 창에서 한다.
> 산출물: `_out-c2\pep-kubeconfig.yaml` (server=`https://host.docker.internal:6444`).

---

## 3. PEP(devops_management) 기동 — docker-compose

```powershell
Copy-Item .env.example backend\.env      # 최초 1회 (프로젝트 루트에서)
docker compose up -d --build
docker compose ps
curl http://localhost:8000/health
```

| 서비스 | URL |
|---|---|
| Frontend (대시보드) | http://localhost:5173 |
| Backend API / Swagger | http://localhost:8000 / http://localhost:8000/docs |

> **`host.docker.internal` 미해석 시**: 루트에 `docker-compose.override.yml` 을 만들어 backend/celery 에
> `extra_hosts: ["host.docker.internal:host-gateway"]` 추가 후 재기동. (Docker Desktop 은 보통 기본 제공)

---

## 4. 두 클러스터를 PEP 에 등록

**(A) PEP UI** — 설정 → 클러스터 → 클러스터 추가 (각 클러스터마다):

| 클러스터 | API Endpoint | kubeconfig |
|---|---|---|
| 1 | `https://host.docker.internal:6443` | `vagrant\kubeadm-almalinux\_out\pep-kubeconfig.yaml` |
| 2 | `https://host.docker.internal:6444` | `vagrant\kubeadm-almalinux\_out-c2\pep-kubeconfig.yaml` |

**(B) 스크립트** (WSL2 / Git Bash) — Mac 과 동일한 헬퍼 재사용:
```bash
bash scripts/register-local-cluster.sh --name alma-c1 \
  --kubeconfig vagrant/kubeadm-almalinux/_out/pep-kubeconfig.yaml \
  --server https://host.docker.internal:6443
bash scripts/register-local-cluster.sh --name alma-c2 \
  --kubeconfig vagrant/kubeadm-almalinux/_out-c2/pep-kubeconfig.yaml \
  --server https://host.docker.internal:6444
```

> 도달 확인(선택): `docker compose exec backend python -c "import httpx; print(httpx.get('https://host.docker.internal:6443/healthz', verify=False, timeout=5).text)"` → `ok`.

---

## 5. 검증

**멀티 클러스터 대시보드** — http://localhost:5173 에 클러스터 2개가 `healthy/warning` 으로 보이면 성공.

**MinIO** (각 클러스터, worker 의 10GB 실디스크 사용):
```powershell
$env:KUBECONFIG = "$PWD\vagrant\kubeadm-almalinux\_out\admin.conf"
kubectl apply -f vagrant\kubeadm-almalinux\manifests\minio.yaml
kubectl -n minio rollout status deploy/minio
# API http://192.168.56.11:30900 / Console http://192.168.56.11:30901 (minioadmin/minioadmin)
```

**Host Facts / SSH (폐쇄망 동일)** — PEP 노드 사양 → Host Facts 수집:
- 대상 호스트: `192.168.56.11`, `192.168.56.12` (c1 워커) / `192.168.57.11`, … (c2)
- SSH user `root`, password `rootpass` → vm/disk/NIC + bond0/bond1(10.20.0.x/10.30.0.x) 채워짐.

> ⚠️ **SSH(22) 도달 위치 주의** (Mac 가이드와 동일 제약): docker 컨테이너 backend 는 VirtualBox
> host-only 망(192.168.56.x)에 **직접 못 닿는다**(6443/6444 만 포워딩됨). **Host Facts/대량실행 같은
> SSH 기반 기능은 PEP 를 Windows 네이티브(uvicorn)로 띄워** 192.168.56.x 에 바로 SSH 하는 것이 가장
> 단순하다. API/모니터링만이면 docker-compose 로 충분하다.

---

## 6. 정리 (Teardown)

```powershell
docker compose down                      # PEP 중지 (데이터 유지; -v 로 볼륨까지)

cd vagrant\kubeadm-almalinux
vagrant destroy -f                       # 클러스터 1
Remove-Item -Recurse -Force _out, .vagrant -ErrorAction SilentlyContinue

$env:PEP_CLUSTER = "2"; $env:VAGRANT_DOTFILE_PATH = ".vagrant-c2"
vagrant destroy -f                       # 클러스터 2 (같은 env 필요)
Remove-Item -Recurse -Force _out-c2, .vagrant-c2 -ErrorAction SilentlyContinue
```

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `vagrant up` → `VBoxManage` / VT-x 오류 | VirtualBox ↔ Hyper-V/WSL2 충돌 | VirtualBox **7.x** 로 업데이트. 그래도 안 되면 Hyper-V 비활성화(`bcdedit /set hypervisorlaunchtype off` 후 재부팅) — 단 이러면 Docker Desktop(WSL2) 영향 |
| `vagrant up` → box `almalinux/10` 못 받음 | 박스 미존재/네트워크 | `vagrant box add almalinux/10 --provider virtualbox` 로 확인. 없으면 `BOX` env 로 다른 x86_64 박스 지정 |
| 클러스터 2 가 클러스터 1 을 건드림 | env 누락 | c2 작업 셸에 `PEP_CLUSTER=2` + `VAGRANT_DOTFILE_PATH=.vagrant-c2` 가 설정됐는지 확인 |
| 포트 6443 충돌 | 두 클러스터가 같은 host 포트 | 의도대로면 c2 는 6444 (프리셋 자동). 다른 것이 6443 점유 시 `netstat -ano \| findstr 6443` |
| 클러스터가 `pending` (connection refused) | 포워딩/방화벽 | `curl -k https://127.0.0.1:6443/livez` (c2 는 6444). 안 되면 해당 셸에서 `vagrant reload` |
| `certificate verify failed` | SAN 누락 | control-plane.sh 가 `host.docker.internal` SAN 으로 init 했는지. 누락 시 `vagrant destroy -f && vagrant up` |
| backend 에서 `host.docker.internal` 미해석 | extra_hosts 누락 | 3단계의 `docker-compose.override.yml` 적용 후 재기동 |
| worker `NotReady` | Cilium 미완료 | `vagrant ssh k8s-worker-1 -c 'sudo journalctl -u kubelet -n50'`, control 에서 `cilium status` |
| 추가 디스크 미인식 / MinIO Pending | disk attach | `vagrant ssh k8s-worker-1 -c 'lsblk'` 로 10G raw 확인. PVC 는 `WaitForFirstConsumer` 라 Pod 스케줄 시 바인딩 |
| Host Facts SSH 타임아웃 | 컨테이너 → host-only 망 미도달 | 5단계 주의 참고 — PEP 를 네이티브로 띄워 192.168.56.x 에 직접 SSH |

디버그:
```powershell
cd vagrant\kubeadm-almalinux; vagrant ssh k8s-control-1 -c 'sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get nodes -o wide'
docker compose logs -f backend
```

---

## 빠른 참조 (전체 흐름 한 번에)

```powershell
# 1) 클러스터 1
cd vagrant\kubeadm-almalinux; vagrant up --provider=virtualbox; cd ..\..

# 2) 클러스터 2 (별도 셸 또는 변수 설정)
cd vagrant\kubeadm-almalinux
$env:PEP_CLUSTER="2"; $env:VAGRANT_DOTFILE_PATH=".vagrant-c2"; vagrant up --provider=virtualbox
Remove-Item Env:\PEP_CLUSTER, Env:\VAGRANT_DOTFILE_PATH; cd ..\..

# 3) PEP 기동
Copy-Item .env.example backend\.env
docker compose up -d --build

# 4) 등록 (UI: host.docker.internal:6443 / :6444 + 각 _out*/pep-kubeconfig.yaml)
#    또는 WSL2: bash scripts/register-local-cluster.sh ... (위 4-B)

# 5) 확인 → http://localhost:5173
```
