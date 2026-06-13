# Vagrant K8s 클러스터 (PEP 등록 + MinIO)

PEP(로컬 docker-compose) 에 등록해 모니터링하고, MinIO 를 올려볼 수 있는
kubeadm 기반 테스트 클러스터를 Vagrant 로 띄웁니다.

## 구성

| 노드 | IP (host-only) | 역할 | 비고 |
|---|---|---|---|
| `k8s-control-1` | 192.168.56.10 | control-plane | API 6443 → Mac 호스트로 포워딩 |
| `k8s-worker-1`  | 192.168.56.11 | worker | **+10GB 디스크 → /mnt/disks/minio** (MinIO) |
| `k8s-worker-2`  | 192.168.56.12 | worker | +10GB 디스크 |

- K8s 1.29 / containerd / **Cilium** (Pod CIDR `10.244.0.0/16` — host-only 192.168.x 와 미충돌)
- worker 마다 10GB 추가 디스크를 `/mnt/disks/minio` 로 자동 포맷·마운트

## 요구사항

- **Vagrant 2.3+**
- **Apple Silicon(M1~) — VMware Fusion (개인용 무료, 권장):**
  1. VMware Fusion 13.5+ 설치 (개인용 무료): https://www.vmware.com/products/fusion.html
  2. Vagrant 플러그인 + 유틸리티 설치:
     ```bash
     vagrant plugin install vagrant-vmware-desktop
     brew install --cask vagrant-vmware-utility    # 또는 공식 설치 패키지
     ```
- **Intel Mac / Linux — VirtualBox 6.1+** (별도 플러그인 불필요)

> Vagrantfile 은 `vmware_desktop` 과 `virtualbox` provider 블록을 **둘 다** 정의합니다.
> 기동 시 `--provider` 로 사용할 것을 고르세요(아래).

## 실행

**Apple Silicon (VMware Fusion):**
```bash
cd vagrant
vagrant up --provider=vmware_desktop      # 5~10분 (control-plane → worker 순)
# 매번 입력이 번거로우면: export VAGRANT_DEFAULT_PROVIDER=vmware_desktop
vagrant status
```

**Intel Mac / Linux (VirtualBox):**
```bash
cd vagrant
vagrant up --provider=virtualbox
```

완료되면 `vagrant/_out/` 에 산출물이 생성됩니다:

| 파일 | 용도 |
|---|---|
| `_out/pep-kubeconfig.yaml` | **PEP 등록용** (server=`https://host.docker.internal:6443`) |
| `_out/admin.conf` | Mac 에서 kubectl 직접 사용 (server=`192.168.56.10:6443`) |
| `_out/join.sh` | worker join (자동 사용) |

### Mac 에서 kubectl 로 확인

```bash
export KUBECONFIG=$PWD/_out/admin.conf
kubectl get nodes -o wide      # control-1, worker-1, worker-2 가 Ready
```

## PEP 에 등록

1. PEP 풀스택 기동(`docker-compose up -d --build`) 후 로그인.
2. **설정 → 클러스터 → 클러스터 추가**:
   - 프로바이더: `On-Premises` (또는 적절히)
   - **API Endpoint**: `https://host.docker.internal:6443`
   - **kubeconfig**: `_out/pep-kubeconfig.yaml` 전체 붙여넣기 (또는 파일 업로드)
3. 등록 전 도달 확인(선택):
   ```bash
   docker-compose exec backend python -c \
    "import httpx; print(httpx.get('https://host.docker.internal:6443/healthz', verify=False, timeout=5).text)"
   # 'ok' 면 PEP 컨테이너에서 API 서버 도달 성공
   ```

> 포워딩 포인트: Vagrantfile 이 6443 을 `host_ip: 0.0.0.0` 으로 열어 두기 때문에
> Docker Desktop 의 `host.docker.internal` 로 접속됩니다. apiserver 인증서 SAN 에
> `host.docker.internal` 을 넣어 TLS 검증도 정상입니다(=skip-tls 불필요).

## MinIO 설치

```bash
export KUBECONFIG=$PWD/_out/admin.conf
kubectl apply -f manifests/minio.yaml
kubectl -n minio rollout status deploy/minio
```

- API: http://192.168.56.11:30900
- Console: http://192.168.56.11:30901  (`minioadmin` / `minioadmin` — 데모용, 변경 권장)

worker-1 의 10GB 디스크(`/mnt/disks/minio/data`)를 로컬 PV 로 사용합니다.

## 폐쇄망 동일 테스트 — Host Facts / SSH 기능

kind 와 달리 이 vagrant 노드는 **SSH(root+비번)·bond·실디스크**가 있어, 폐쇄망 운영 노드와
**동일한 방식으로** PEP 의 Host Facts 수집 / 대량실행(BulkExec) / 배치잡을 검증할 수 있습니다.

- 각 노드에 **root 로그인 + 비번**(`ROOT_PASSWORD`, 기본 `rootpass`)이 활성화되어 있습니다
  (운영의 root+비번 수집 흐름과 동일 — **테스트 전용**).
- 각 노드에 **dummy bond0/bond1**(10.20.0.x / 10.30.0.x)이 미리 구성되어 있어 Host Facts 의
  `bond0_ip/mac`, `bond1_ip/mac` 필드까지 운영처럼 채워집니다(k8s 트래픽과 분리, 테스트 전용).
- PEP **노드 사양 페이지 → "Host Facts 수집"**:
  - SSH user `root`, SSH password `rootpass`(=Vagrantfile 의 `ROOT_PASSWORD`)
  - 호스트: `192.168.56.11`, `192.168.56.12` (워커)
  - → bond/disk/vm 필드가 채워짐

### ⚠️ PEP 가 노드 SSH(22)에 닿게 하기 — 실행 위치가 중요

| PEP 실행 방식 | API(6443) | SSH(22, Host Facts) | 권장 |
|---|---|---|---|
| **맥 네이티브** (`make dev` / uvicorn) | `192.168.56.10:6443` 직접 | `192.168.56.x:22` 직접 | ✅ SSH 기능 테스트는 이쪽 |
| docker-compose 컨테이너 | `host.docker.internal:6443` (포워딩) | host-only 망(192.168.56.x) **직접 도달 불가** | API/모니터링만 |

> 컨테이너 PEP 는 host-only 망의 22번에 닿지 못합니다(앞서 6443 을 host.docker.internal 로
> 우회한 것과 같은 제약). **Host Facts/대량실행 같은 SSH 기반 기능은 PEP 를 맥 네이티브로
> 띄워** `192.168.56.x` 에 바로 SSH 하게 하는 것이 가장 단순하고 운영과 유사합니다.
> 네이티브로 띄우면 클러스터 등록도 `https://192.168.56.10:6443` + `_out/admin.conf` 를 그대로
> 쓰면 됩니다(host.docker.internal 불필요).

## 정리

```bash
vagrant destroy -f
rm -rf _out .vagrant
```

## 트러블슈팅

- **worker 가 NotReady**: `vagrant ssh k8s-worker-1 -c 'sudo journalctl -u kubelet -n50'`.
  Cilium pod 가 떠야 Ready 가 됩니다 (`kubectl -n kube-system get pod -l k8s-app=cilium`).
- **추가 디스크 미인식**: `vagrant ssh k8s-worker-1 -c 'lsblk'` 로 10G raw 디스크 확인.
  Vagrant 2.3+ 필요(`VAGRANT_EXPERIMENTAL=disks` 는 Vagrantfile 에서 자동 설정).
- **PEP 에서 offline**: 위 `httpx` 도달 확인부터. 타임아웃이면 6443 포워딩/방화벽,
  인증 오류(401 가 아닌 TLS 오류)면 kubeconfig 의 server/CA 확인.
- **MinIO Pending**: PVC 가 `WaitForFirstConsumer` 라 Pod 스케줄 시 바인딩됩니다.
  Pod 가 k8s-worker-1 로 안 가면 PV nodeAffinity(`k8s-worker-1`) 와 노드명 일치 확인.
