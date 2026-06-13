# Windows + Docker 테스트 환경 — kind 기반 PEP 클러스터 (Mac vagrant 와 동일 패턴)

Mac 의 `vagrant/`(VM) 경로와 **같은 목적·같은 흐름**을, Windows 에서는 **Docker Desktop +
kind(Kubernetes IN Docker)** 로 재현한다. PEP 에 클러스터를 등록해 모니터링하고, MinIO 를
올리고, Host Facts(SSH) 까지 테스트한다.

## Mac(vagrant) ↔ Windows(docker) 패턴 매핑

| 항목 | Mac — `vagrant/` (VM) | Windows — `windows-docker/` (Docker) |
|---|---|---|
| K8s 노드 | AlmaLinux VM (kubeadm) | **kind 노드 컨테이너** (control-plane + worker) |
| kube-API 노출 | 6443 포워딩 → `host.docker.internal` | kind `apiServerAddress 0.0.0.0:6443` → `host.docker.internal` |
| 인증서 SAN | `host.docker.internal` 포함 | kind `certSANs: host.docker.internal` |
| MinIO 디스크 | worker +10GB 실디스크(xfs) | **Windows 폴더** → 노드 `/mnt/disks/minio` (extraMounts) |
| MinIO 노출 | NodePort 30900/30901 | kind extraPortMappings → `localhost:30900/30901` |
| Host Facts(SSH) | VM 노드 root SSH + bond | **별도 AlmaLinux 10 컨테이너**(`node-ssh/`) root SSH + bond |

> **왜 Host Facts 만 별도 컨테이너인가:** kind 노드 컨테이너에는 sshd 가 없고 운영처럼
> SSH 로 들어가는 대상이 아니다. 그래서 "운영 노드 흉내" 용 AlmaLinux 10 컨테이너를 따로
> 띄워 SSH/bond 기반 기능(Host Facts·대량실행)을 검증한다. (Mac 도 본질은 같다 — VM 이라
> 한 노드가 두 역할을 겸할 뿐.)

## 요구사항

- **Docker Desktop for Windows** (WSL2 백엔드 권장)
- **kind** + **kubectl** (PowerShell):
  ```powershell
  winget install Kubernetes.kind
  winget install Kubernetes.kubectl
  ```
- PowerShell 5+ (Windows 기본). 아래 명령은 모두 PowerShell 기준.

## 1) 클러스터 생성

```powershell
cd windows-docker

# MinIO 디스크로 쓸 Windows 폴더 생성 (Docker Desktop 파일 공유 대상이어야 함)
New-Item -ItemType Directory -Force -Path C:\pep-kind\minio\data | Out-Null

kind create cluster --name pep --config kind-cluster.yaml
kubectl get nodes -o wide        # pep-control-plane, pep-worker 가 Ready
```

> `C:\pep-kind` 가 Docker Desktop 의 **Settings → Resources → File sharing** 에 포함돼야
> extraMounts 가 동작한다(WSL2 백엔드면 보통 자동).

## 2) 용도별 kubeconfig 만들기

kind 의 kubeconfig 는 `server: https://0.0.0.0:6443` 라 그대로는 못 쓴다. 호스트용/PEP용으로 복제:

```powershell
powershell -ExecutionPolicy Bypass -File make-kubeconfigs.ps1
# → _out\admin.conf (127.0.0.1:6443), _out\pep-kubeconfig.yaml (host.docker.internal:6443)
```

호스트 kubectl 확인:
```powershell
$env:KUBECONFIG = "$PWD\_out\admin.conf"
kubectl get nodes
```

## 3) PEP 에 등록

1. PEP 풀스택 기동(`docker compose up -d --build`) 후 로그인.
2. **설정 → 클러스터 → 클러스터 추가**:
   - **API Endpoint**: `https://host.docker.internal:6443`
   - **kubeconfig**: `_out\pep-kubeconfig.yaml` 붙여넣기(업로드)
3. 도달 확인(선택):
   ```powershell
   docker compose exec backend python -c "import httpx; print(httpx.get('https://host.docker.internal:6443/healthz', verify=False, timeout=5).text)"
   ```
   `ok` 면 PEP 컨테이너에서 API 도달 성공. SAN 에 `host.docker.internal` 이 있어 TLS 검증도 정상.

## 4) MinIO 설치

```powershell
$env:KUBECONFIG = "$PWD\_out\admin.conf"
kubectl apply -f manifests\minio.yaml
kubectl -n minio rollout status deploy/minio
```

- API: http://localhost:30900 / Console: http://localhost:30901 (`minioadmin` / `minioadmin`)
- 데이터는 `C:\pep-kind\minio\data` (Windows 폴더)에 저장된다.

## 5) Host Facts / SSH 기능 테스트 (운영 노드 흉내 컨테이너)

```powershell
cd node-ssh
docker compose up -d --build      # AlmaLinux 10 노드 2대 (pep-node-1:2221, pep-node-2:2222)
cd ..
```

PEP **노드 사양 → Host Facts 수집**:
- 대상 호스트/포트: `host.docker.internal` + **2221 / 2222**
- user `root`, password `rootpass`
- → vm/disk/NIC + (privileged 면) bond0/bond1(10.20.0.x / 10.30.0.x) 필드까지 채워짐

> **포트 주의:** PEP 가 호스트명만 받고 포트는 22 고정이라면, 노드 컨테이너를 PEP 와 같은
> Docker 네트워크에 붙여 **컨테이너명(`pep-node-1`):22** 로 직접 접근하게 하는 편이 깔끔하다
> (이 경우 `host.docker.internal`/포트매핑 불필요). 네트워크 연결:
> ```powershell
> docker network connect <pep_compose_network> pep-node-1
> docker network connect <pep_compose_network> pep-node-2
> ```
> `<pep_compose_network>` 는 `docker network ls` 에서 PEP compose 네트워크명 확인.

## 정리

```powershell
kind delete cluster --name pep
cd node-ssh; docker compose down -v; cd ..
Remove-Item -Recurse -Force _out, C:\pep-kind  -ErrorAction SilentlyContinue
```

## 한계 / 주의 (Docker vs VM)

- **실디스크 없음**: MinIO 스토리지는 Windows 폴더 마운트로 대체(용량/성능 특성은 다름).
- **bond 는 privileged + 호스트 커널 모듈 의존**: Docker Desktop(WSL2) 에 bonding/dummy
  모듈이 없으면 bond 필드는 비고, 나머지 Host Facts 는 정상 수집된다.
- **CRI/커널**: kind 노드는 containerd + Docker Desktop(WSL2) 커널 → 폐쇄망 RHEL 과 커널/CRI 가
  다르다. kube-API 관점 모니터링·체커 검증엔 충분하지만, OS 레벨 충실도는 `node-ssh` 컨테이너
  (AlmaLinux 10)가 담당한다.
- **kind 노드명**: 클러스터명 `pep` 기준 `pep-control-plane`, `pep-worker`. 매니페스트의
  `nodeAffinity`/`nodeSelector` 가 `pep-worker` 로 맞춰져 있다(클러스터명 바꾸면 함께 수정).
