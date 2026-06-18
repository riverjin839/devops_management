# vagrant/ — Apple Silicon 테스트용 kubeadm 3노드 + Cilium 클러스터 (기본 경로)

PEP 가 모니터링할 **2번째 테스트 클러스터**(kubeadm control-plane 1 + worker 2 + **Cilium CNI**)를
VirtualBox VM 으로 띄운다. **Cilium 스터디 1주차 실습 환경을 레포에 고정한 것**으로,
[../docs/MAC_LOCAL_TEST_GUIDE.md](../docs/MAC_LOCAL_TEST_GUIDE.md) 의 "클러스터 B" 와 동일하다.
(upstream: [gasida/vagrant-lab](https://github.com/gasida/vagrant-lab) `cilium-study/1w`)

CNI 는 미설치 상태로 부팅(노드 `NotReady`)되고, Cilium 은 `kubeProxyReplacement + native routing +
cluster-pool IPAM` 로 Helm 설치한다 — PEP 의 Cilium/Hubble 딥 트러블슈팅 기능까지 테스트할 수 있다.

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

> Windows 사용자도 동일하게 VirtualBox + Vagrant 로 이 lab 을 쓴다(Notion 1주차 "Windows 사용자" 섹션 참고).

## 빠른 사용

```bash
# 사전: brew install --cask virtualbox vagrant   (VirtualBox 7.1+ — Apple Silicon arm64 지원)

# 1) VM 3대 부팅 (init_cfg.sh + kubeadm init/join 자동 실행, CNI 미설치라 노드는 NotReady)
vagrant up

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

- **노드가 계속 `NotReady`**: CNI(Cilium) 미설치다. `vagrant provision k8s-ctr --provision-with cilium`
  실행 후 `vagrant ssh k8s-ctr -c 'sudo cilium status --wait'`.
- **`vagrant up` → provider 오류**: VirtualBox **7.1+**(Apple Silicon 지원) 설치 확인(`VBoxManage --version`).
- **Mac→VM 도달 확인**: `curl -k https://192.168.10.100:6443/livez`. 안 되면 `vagrant reload` 또는
  host-only 어댑터(`192.168.10.1`) 확인.
- **PEP 에서 `pending`**: 위 `curl` 로 호스트→VM 부터 확인. Mac 은 되는데 컨테이너만 안 되면
  Docker Desktop 재시작. 자세한 표는 [가이드 트러블슈팅](../docs/MAC_LOCAL_TEST_GUIDE.md#트러블슈팅) 참고.
