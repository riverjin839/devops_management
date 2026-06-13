# 단일노드 QEMU K8s (Apple Silicon, 무료) — AlmaLinux 10 / RHEL 10 호환

VMware Fusion 없이 **무료 QEMU(vagrant-qemu)** 로 Apple Silicon 에서 PEP 테스트용
kubeadm 클러스터를 띄운다. 상위 `../`(멀티노드 VMware/VirtualBox) 와 **같은 프로비저닝
스크립트**(`../scripts/*`)를 재사용하되, QEMU 제약상 **단일노드**로 구성한다.

## ⚠️ 왜 단일노드인가 (중요)

QEMU 무료 경로의 한계 — 결정 전에 꼭 확인:

1. **AlmaLinux 는 aarch64 용 `qemu` provider 박스를 배포하지 않는다**(VirtualBox/VMware/
   Parallels 만). → 공식 클라우드 qcow2 를 받아 `build-almalinux-box.sh` 로 **박스를 직접
   빌드**한다.
2. **vagrant-qemu 는 macOS 에서 노드 간 통신이 안 된다.** host-only 같은 L2 망(`vmnet`)은
   root 권한이 필요하고, 기본 user-mode(slirp) 망은 VM 끼리 못 만난다. → **멀티노드
   kubeadm 이 비현실적.**

그래서 여기서는 **control-plane 1대(=schedulable, 워크로드도 실행)** 로 간다.
**멀티노드 / worker 분리 디스크**가 꼭 필요하면 → 상위 `../README.md` + **VMware Fusion**
(개인용 무료 다운로드 1회) 가 정답이다.

> 이 경로는 자동 테스트가 어려워 **검증되지 않았다.** 박스 빌드 / cloud-init / QEMU 펌웨어
> 경로 등에서 한 번에 안 될 수 있고, 단계별 디버깅이 필요할 수 있다(아래 트러블슈팅).

## 구성

| 노드 | 역할 | 비고 |
|---|---|---|
| `k8s-control-1` | control-plane **+ worker**(untaint) | +10GB 디스크 → `/mnt/disks/minio` (MinIO), root SSH + dummy bond |

- OS **AlmaLinux 10**(RHEL 10 호환, 커널 6.12) / CRI **CRI-O** / K8s **1.29** / CNI **Cilium**
- 네트워킹: user-mode(slirp) + 포트포워딩

| 게스트 | → Mac 호스트 | 용도 |
|---|---|---|
| 22 | 50022 | vagrant SSH |
| 6443 | 6443 | kube-API (PEP → `host.docker.internal:6443`) |
| 30900 | 50090 | MinIO API |
| 30901 | 50091 | MinIO Console |

## 요구사항

```bash
brew install qemu                       # qemu-img, qemu-system-aarch64
vagrant plugin install vagrant-qemu     # QEMU provider
```

- Vagrant 2.3+, Apple Silicon(M1~). Intel Mac 도 됨(`ARCH=x86_64 bash build-almalinux-box.sh`
  후 Vagrantfile 의 `arch`/`machine` 을 x86_64/`q35,accel=hvf` 로 조정).

## 실행

```bash
cd vagrant/kubeadm-almalinux/qemu

# 1) AlmaLinux 10 클라우드 이미지로 qemu 박스 + cloud-init seed 빌드 (최초 1회)
bash build-almalinux-box.sh             # → pep/almalinux10-qemu 박스 + seed.iso

# 2) 단일노드 기동 (control-plane init → Cilium → untaint → MinIO 디스크)
vagrant up --provider=qemu              # 5~10분

# 3) kubeconfig 추출 (synced folder 가 꺼져 있어 SSH 로 가져옴)
bash extract-kubeconfig.sh              # → _out/{pep-kubeconfig.yaml, admin.conf}
```

### Mac 에서 kubectl 확인

```bash
export KUBECONFIG=$PWD/_out/admin.conf  # server=https://127.0.0.1:6443 (포워딩)
kubectl get nodes -o wide               # k8s-control-1 Ready (control-plane,worker 겸용)
```

## PEP 에 등록

1. PEP 풀스택 기동(`docker-compose up -d --build`) 후 로그인.
2. **설정 → 클러스터 → 클러스터 추가**:
   - **API Endpoint**: `https://host.docker.internal:6443`
   - **kubeconfig**: `_out/pep-kubeconfig.yaml` 붙여넣기(업로드)
3. 도달 확인(선택):
   ```bash
   docker-compose exec backend python -c \
    "import httpx; print(httpx.get('https://host.docker.internal:6443/healthz', verify=False, timeout=5).text)"
   ```

> apiserver 인증서 SAN 에 `host.docker.internal`, `127.0.0.1`, `localhost` 가 포함되어
> TLS 검증이 정상이다(`../scripts/control-plane.sh`).

## MinIO 설치

```bash
export KUBECONFIG=$PWD/_out/admin.conf
kubectl apply -f manifests/minio.yaml          # control-1 의 추가 디스크를 PV 로 사용
kubectl -n minio rollout status deploy/minio
```

- API: http://127.0.0.1:50090 / Console: http://127.0.0.1:50091 (`minioadmin`/`minioadmin`)

## Host Facts / SSH 기능 테스트

상위 멀티노드판과 동일하게 **root SSH(비번) + dummy bond0/bond1** 이 구성된다.

- PEP **노드 사양 → Host Facts 수집**:
  - **PEP 가 Mac 네이티브(`make dev`)** 면 → 호스트 `127.0.0.1`, **포트 `50022`**, user `root`,
    password `rootpass`(=Vagrantfile `ROOT_PASSWORD`). slirp 포워딩으로 SSH 도달.
  - **PEP 가 docker-compose** 면 → `host.docker.internal:50022` (Docker Desktop).
  - bond0/bond1(10.20.0.x / 10.30.0.x) 필드까지 운영처럼 채워진다.

> 멀티노드판은 노드가 `192.168.56.x:22` 로 직접 열리지만, QEMU 단일노드는 slirp 라
> **포워딩된 50022** 로 들어간다는 점만 다르다.

## 정리

```bash
vagrant destroy -f
rm -rf _out .vagrant minio.qcow2 seed.iso
vagrant box remove pep/almalinux10-qemu     # 박스까지 지우려면
```

## 트러블슈팅 (검증 안 된 경로 — 단계별 디버깅)

- **`vagrant up` 이 SSH 에서 멈춤(Warming up / retrying)**: cloud-init 가 seed 를 못 읽어
  vagrant 유저/키가 안 생긴 경우. `seed.iso` 라벨이 `CIDATA` 인지(빌드 로그), Vagrantfile 의
  `-device virtio-blk-pci,...serial=cidata` 가 붙었는지 확인. 콘솔 확인:
  `qe.extra_qemu_args` 에 `"-nographic"` 임시 추가 후 부팅 로그 관찰.
- **펌웨어/UEFI 오류(`edk2-aarch64-code.fd` not found)**: `brew install qemu` 재확인,
  필요시 Vagrantfile provider 에 `qe.qemu_dir = "/opt/homebrew/share/qemu"` 추가.
- **`accel=hvf` 실패**: 다른 가상화 도구(Docker Desktop 등)와 HVF 경합 가능 — 잠시 종료 후 재시도.
- **추가 디스크 미인식**: `vagrant ssh -c lsblk` 로 ~10G raw 디스크 확인. 없으면
  `minio.qcow2` 가 생성됐는지(`ls -lh minio.qcow2`) + provider `extra_qemu_args` 확인.
- **PEP 에서 offline**: 위 `httpx` 도달 확인. 6443 포워딩이 살아있는지(`lsof -i :6443`).
- **멀티노드가 필요**: 이 경로로는 불가 — 상위 `../` + VMware Fusion 사용.
