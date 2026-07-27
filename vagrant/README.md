# vagrant/ — Apple Silicon 테스트용 kubeadm 3노드 + Cilium 클러스터 (기본 경로)

PEP 가 모니터링할 **2번째 테스트 클러스터**(kubeadm control-plane 1 + worker 2 + **Cilium CNI**)를
VirtualBox VM 으로 띄운다. **Cilium 스터디 1주차 실습 환경을 레포에 고정한 것**으로,
[../docs/MAC_LOCAL_TEST_GUIDE.md](../docs/MAC_LOCAL_TEST_GUIDE.md) 의 "클러스터 B" 와 동일하다.
(upstream: [gasida/vagrant-lab](https://github.com/gasida/vagrant-lab) `cilium-study/1w`)

CNI 는 미설치 상태로 부팅(노드 `NotReady`)되고, Cilium 은 `kubeProxyReplacement + native routing +
cluster-pool IPAM` 로 Helm 설치한다 — PEP 의 Cilium/Hubble 딥 트러블슈팅 기능까지 테스트할 수 있다.

> ## ⚠️ Apple Silicon 에서 가장 자주 겪는 문제 — **Mac 절전(sleep)**
>
> **Mac 뚜껑을 덮거나 절전에 들어가면 이 클러스터는 되살아나지 않는다.** VirtualBox 가 VM 을
> `HostSuspend` 사유로 일시정지(paused)하는데, Apple Silicon 빌드는 깨어난 뒤 resume 이
> `VM is paused due to host power management` 로 **실패**한다. 그 VM 을 붙잡은 VirtualBox
> 서비스(VBoxSVC)가 교착에 빠져 이후 `vagrant`/`VBoxManage` 명령이 **전부 무한 대기**하고,
> 결국 `192.168.10.100:6443` 도달 불가 → PEP 에서 클러스터가 `pending` 으로 남는다.
>
> **복구는 한 줄이다** (`up.sh` 가 자동 진단·복구한다):
> ```bash
> cd vagrant && bash up.sh --keep
> ```
> 자세한 증상별 대응은 아래 [트러블슈팅](#트러블슈팅) 참고. **테스트를 오래 돌릴 거면
> 시스템 설정 → 배터리/잠금 화면에서 절전을 꺼두는 것이 가장 확실하다.**

## 구성

| 노드 | IP (host-only `eth1`) | 역할 | 사양 |
|---|---|---|---|
| `k8s-ctr` | 192.168.10.100 | control-plane | 2 vCPU / 2048 MB |
| `k8s-w1`  | 192.168.10.101 | worker | 2 vCPU / 1536 MB |
| `k8s-w2`  | 192.168.10.102 | worker | 2 vCPU / 1536 MB |

- OS: **bento/ubuntu-24.04** / CRI: **containerd 1.7** / K8s **1.33.2** (kubeadm)
- `eth0` 10.0.2.15 (NAT, 모든 노드 동일 — 외부 인터넷)
- control-plane API: `192.168.10.100:6443` — `--apiserver-advertise-address=192.168.10.100` 라
  **인증서 SAN 에 이 IP 가 포함**된다. Mac/backend 는 host-only 망으로 직접 도달하므로
  `host.docker.internal` 포워딩·tls-san 우회가 **필요 없다**.
- CNI: **Cilium 1.17.5** (cluster-pool IPAM → PodCIDR `172.20.0.0/16`)

## 테스트 환경 선택 (3가지)

목적에 맞게 고른다. **이 디렉터리(`vagrant/`)가 기본 경로**(Ubuntu + kubeadm 3노드 + Cilium)다.

| 경로 | OS / 런타임 | 형태 | 언제 쓰나 |
|---|---|---|---|
| **`vagrant/` (여기)** | Ubuntu 24.04 + **kubeadm**(VirtualBox) | 멀티노드(ctr+w1+w2) | **Cilium 스터디 1주차** 환경으로 PEP 등록·Cilium/Hubble 확인 |
| [`vagrant/kubeadm-almalinux/`](kubeadm-almalinux/README.md) | **AlmaLinux 10**(RHEL10 호환) + kubeadm | 멀티노드(VMware/VBox) · 단일노드(QEMU) | **폐쇄망 RHEL 충실도** (CRI-O·SELinux·firewalld·실디스크·root SSH·bond) |
| [`../windows-docker/`](../windows-docker/README.md) | kind(Docker) | control+worker | **Windows / Docker** 환경에서 동일 패턴 재현 |

> RHEL 동일성·실디스크·SSH(Host Facts) 가 필요하면 AlmaLinux 경로를, Windows 면 windows-docker 를 쓴다.

## 원샷 설치 (권장)

`up.sh` 가 사전 도구 확인·설치 → 기존 VM 확인(인터랙티브) → `vagrant up` → Cilium 설치
→ DNS/이미지풀 자동 보정 → kubeconfig 추출까지 한 번에 처리한다.

```bash
cd vagrant
bash up.sh                 # 인터랙티브 원샷
bash up.sh --recreate      # 기존 VM 삭제 후 새로
bash up.sh --yes --register  # 비대화 + 끝나면 PEP 등록까지
```

| 옵션 | 동작 |
|---|---|
| (없음) | 기존 VM 있으면 `삭제재생성[r]/유지[k]/중단[a]` 를 물어봄 |
| `--recreate` | 기존 VM 강제 삭제 후 재생성 |
| `--keep` | 기존 VM 유지하고 Cilium 만 재적용 |
| `--yes` | 비대화(도구설치 자동 승인, 기존은 유지) |
| `--register` | 완료 후 PEP(`localhost:8000`)에 등록 |

## 빠른 사용 (수동 단계)

```bash
# 사전: brew install --cask virtualbox vagrant   (VirtualBox 7.1+ — Apple Silicon arm64 지원)

# 1) VM 3대 부팅 (init_cfg.sh + kubeadm init/join 자동 실행, CNI 미설치라 노드는 NotReady)
vagrant up --provider=virtualbox

# 2) Cilium 설치 (control-plane 에서 Helm) — named provisioner
vagrant provision k8s-ctr --provision-with cilium
#   → cilium status --wait 까지 끝나면 3노드 모두 Ready

# 3) kubeconfig 를 Mac 으로 추출 (admin.conf 의 server 가 이미 192.168.10.100:6443)
vagrant ssh k8s-ctr -c 'sudo cat /etc/kubernetes/admin.conf' > kubeadm-kubeconfig.yaml

# 정리
vagrant destroy -f
```

> Cilium 을 손으로 설치하며 학습하고 싶으면 `vagrant ssh k8s-ctr` 로 들어가
> [install-cilium.sh](install-cilium.sh) 의 `helm install cilium ...` 를 직접 실행해도 된다.
> (provisioner 는 같은 스크립트를 root 로 돌리는 것뿐)

## 파일

| 파일 | 설명 |
|---|---|
| `up.sh` | **원샷 설치** 스크립트(도구확인·기존VM 처리·up·Cilium·DNS보정·kubeconfig). `bash up.sh` |
| `Vagrantfile` | VirtualBox 3노드(k8s-ctr/w1/w2). bento/ubuntu-24.04, host-only 192.168.10.0/24 |
| `init_cfg.sh` | 모든 노드 공통: swap off, k8s repo, kubelet/kubeadm/kubectl + containerd + helm 설치 |
| `k8s-ctr.sh` | control-plane `kubeadm init`(pod 10.244/16, svc 10.96/16, advertise 192.168.10.100) + 편의설정 |
| `k8s-w.sh` | worker `kubeadm join` |
| `install-cilium.sh` | Cilium Helm 설치(kubeProxyReplacement/native/cluster-pool) + cilium CLI. `--provision-with cilium` 으로 실행 |

## PEP 등록

```bash
bash ../scripts/register-local-cluster.sh \
  --name vagrant-kubeadm \
  --kubeconfig kubeadm-kubeconfig.yaml \
  --server https://192.168.10.100:6443
```

> `kubeadm-kubeconfig.yaml` 은 인증 정보가 들어있으므로 커밋하지 않는다 (`*-kubeconfig.yaml` `.gitignore` 등록됨).

## 트러블슈팅

### 1분 진단 — 이 3줄부터

무슨 증상이든 아래 순서로 확인하면 원인이 어느 층인지 바로 갈린다.

```bash
VBoxManage list vms                                  # ① 몇 초 안에 안 끝나면 → VirtualBox 교착 (A)
VBoxManage showvminfo k8s-ctr --machinereadable | grep VMState   # ② paused/aborted 면 → 절전 후유증 (A)
curl -k -m5 https://192.168.10.100:6443/livez        # ③ 'ok' 가 아니면 → VM/네트워크 (B~C)
```

**막혔으면 이 한 줄이 대부분 해결한다** — `up.sh` 가 ①②를 자동 진단·복구하고 다시 띄운다:

```bash
cd vagrant && bash up.sh --keep
```

### 증상별

| 증상 | 원인 | 해결 |
|---|---|---|
| **(A)** `vagrant`/`VBoxManage` 명령이 **영원히 안 끝남**(응답 없음) | Mac 절전으로 VM 이 `HostSuspend` paused → VBoxSVC 교착 | `bash up.sh --keep` (자동 복구). 수동: 아래 "절전 후 수동 복구" |
| **(A)** `VM is paused due to host power management` <br>(`VBOX_E_INVALID_VM_STATE`) | 위와 동일 — Apple Silicon 은 **resume 이 불가능**하다 | resume 을 포기하고 **poweroff 후 재부팅**해야 한다. `bash up.sh --keep` |
| **(A)** `vagrant status` 가 `aborted` | VM 이 비정상 종료(절전/강제종료/메모리 부족) | `bash up.sh --keep` — poweroff 정리 후 다시 부팅 |
| **(B)** 노드가 계속 `NotReady` | CNI(Cilium) 미설치 | `vagrant provision k8s-ctr --provision-with cilium` 후 `vagrant ssh k8s-ctr -c 'sudo cilium status --wait'` |
| **(B)** 워커 `INTERNAL-IP` 가 전부 **10.0.2.15** | kubelet 이 NAT eth0 로 노드 등록(NodeIP 미고정). `kubectl logs/exec` 와 Cilium 노드간 라우팅이 깨진다 | 최신 `k8s-w.sh` 가 자동 고정. 기존 VM 이면 아래 "NodeIP 수동 교정" |
| **(B)** kubelet 로그에 `Could not parse some node IP(s), ignoring them` | `/etc/default/kubelet` 에 문서용 플레이스홀더(`<그_노드_사설IP>` 등)를 **문자 그대로** 넣음 | 아래 "NodeIP 수동 교정" 으로 실제 IP 를 넣는다 |
| **(C)** `vagrant up` → provider 오류 | VirtualBox 미설치/구버전 | VirtualBox **7.1+**(Apple Silicon 지원) 확인 — `VBoxManage --version` |
| **(C)** `machine with the name 'k8s-ctr' already exists` | Vagrant↔VirtualBox 상태 desync | `bash up.sh` 가 자동 정리(`purge_vbox_orphans`) |
| **(C)** Mac→VM 도달 불가 (`curl` 실패) | host-only 어댑터 문제 | `ifconfig \| grep 192.168.10.1` 로 어댑터 확인 → 없으면 `vagrant reload` |
| **(D)** PEP 에서 `pending` | 대개 (A)~(C) 의 결과 | 먼저 위 `curl` 로 호스트→VM 확인. Mac 은 되는데 컨테이너만 안 되면 Docker Desktop 재시작 |
| **(E)** `vagrant` 명령이 서로 엉킴/멈춤 | **같은 환경에 vagrant 명령 2개를 동시에** 실행함(환경 잠금 경합) | 하나씩 순차 실행한다 |
| **(E)** VM 이 자꾸 `aborted` / 부팅 실패 | 메모리 부족 (VM 3대 ≈ 5GB) | Docker Desktop 을 끄거나, kind(클러스터 A)와 **동시에 띄우지 않는다**. Mac 16GB+ 권장 |

> `hubble-relay` 만 `Pending`/`1 errors` 인 것은 **비차단**이다 — 코어 `cilium` 이 OK 면 PEP 등록을 진행해도 된다.
> 노드 IP 를 바꾼 직후라면 `vagrant ssh k8s-ctr -c 'sudo kubectl -n kube-system rollout restart deploy/hubble-relay'`.

### 절전 후 수동 복구 (up.sh 를 못 쓸 때)

```bash
pkill -9 -f 'MacOS/VBoxManage'; pkill -9 -f 'gems/vagrant-.*/bin/vagrant'
pkill -9 -f 'MacOS/VBoxHeadless'; pkill -f 'MacOS/VBoxSVC'     # 교착된 서비스까지 정리
for v in k8s-ctr k8s-w1 k8s-w2; do VBoxManage controlvm $v poweroff 2>/dev/null; done
cd vagrant && vagrant up --provider=virtualbox
```

> **예방이 최선**: 테스트를 오래 돌릴 거면 **Mac 절전을 꺼둔다**
> (시스템 설정 → 배터리/잠금 화면 → 디스플레이 끈 뒤 자동으로 잠자기: 안 함).
> 잠시 자리를 비울 거면 절전 전에 `cd vagrant && vagrant halt` 로 **정상 종료**해두면
> 깨어난 뒤 `vagrant up` 으로 깔끔하게 복귀한다.

### NodeIP 수동 교정 (기존 VM)

`kubectl get nodes -o wide` 의 `INTERNAL-IP` 가 노드마다 달라야 정상이다
(`192.168.10.100/101/102`). 전부 `10.0.2.15` 로 같거나 kubelet 이 플레이스홀더를 씹고 있으면:

```bash
cd vagrant
for n in k8s-ctr k8s-w1 k8s-w2; do
  vagrant ssh $n -c 'IP="$(ip -4 -o addr show eth1 | awk "{print \$4}" | cut -d/ -f1)"; \
    echo "KUBELET_EXTRA_ARGS=\"--node-ip=${IP}\"" | sudo tee /etc/default/kubelet; \
    sudo systemctl restart kubelet'
done
vagrant ssh k8s-ctr -c 'sudo kubectl get nodes -o wide'   # IP 3개가 서로 달라야 정상
```

자세한 표는 [가이드 트러블슈팅](../docs/MAC_LOCAL_TEST_GUIDE.md#트러블슈팅) 참고.
