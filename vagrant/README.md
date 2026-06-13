# vagrant/ — Apple Silicon 테스트용 k3s 클러스터 (기본/빠른 경로)

PEP 가 모니터링할 **2번째 테스트 클러스터**(단일 노드 k3s + **Cilium CNI**)를 Vagrant VM 으로 띄운다.
flannel 대신 Cilium + Hubble 을 설치해 PEP 의 딥 트러블슈팅 기능까지 테스트할 수 있다.
전체 흐름은 [../docs/MAC_LOCAL_TEST_GUIDE.md](../docs/MAC_LOCAL_TEST_GUIDE.md) 참고.

## 테스트 환경 선택 (3가지)

목적에 맞게 고른다. **이 디렉터리(`vagrant/`)는 가장 빠른 무료 경로**(Ubuntu+k3s+QEMU)다.

| 경로 | OS / 런타임 | 형태 | 언제 쓰나 |
|---|---|---|---|
| **`vagrant/` (여기)** | Ubuntu 22.04 + **k3s** (QEMU 무료) | 단일노드 | **가장 빠르게** PEP 등록·Cilium/Hubble 확인 |
| [`vagrant/kubeadm-almalinux/`](kubeadm-almalinux/README.md) | **AlmaLinux 10**(RHEL10 호환) + kubeadm | 멀티노드(VMware/VBox) · 단일노드(QEMU) | **폐쇄망 RHEL 충실도** (CRI-O·SELinux·firewalld·실디스크·root SSH·bond) |
| [`../windows-docker/`](../windows-docker/README.md) | kind(Docker) | control+worker | **Windows / Docker** 환경에서 동일 패턴 재현 |

> 셋 다 "kube-API 6443 → `host.docker.internal` 포워딩 + 인증서 SAN + MinIO" 라는 동일 패턴을
> 따른다. RHEL 동일성·실디스크·SSH(Host Facts) 가 필요하면 AlmaLinux 경로를, Windows 면
> windows-docker 를 쓴다.

## 빠른 사용

```bash
# 사전: brew install qemu vagrant && vagrant plugin install vagrant-qemu
vagrant up                                                  # VM 부팅 + k3s 설치
vagrant ssh -c 'sudo cat /etc/rancher/k3s/k3s.yaml' > k3s-kubeconfig.yaml
vagrant destroy -f                                          # 정리
```

## 파일

| 파일 | 설명 |
|---|---|
| `Vagrantfile` | QEMU(기본)/VMware/Parallels provider. 6443 포트 Mac 호스트로 포워딩, 메모리 4G |
| `provision-k3s.sh` | k3s(flannel off) + Cilium + Hubble 설치. `--tls-san host.docker.internal` 로 컨테이너 접속 대응. `K3S_CNI=flannel` 로 기본 CNI 사용 가능 |

## PEP 등록

```bash
bash ../scripts/register-local-cluster.sh \
  --name vagrant-k3s \
  --kubeconfig k3s-kubeconfig.yaml \
  --server https://host.docker.internal:6443
```

> `k3s-kubeconfig.yaml` 은 인증 정보가 들어있으므로 커밋하지 않는다 (`.gitignore` 등록됨).
