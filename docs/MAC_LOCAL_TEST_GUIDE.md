# Mac 로컬 테스트 가이드 (Apple Silicon)

> **목표**: 내 맥북(Apple Silicon, M1~M4)에서 **테스트용 K8s 클러스터 2대**(kind 1 + Vagrant/VirtualBox kubeadm 3노드 1)를
> 만들고, **PEP(devops_management)** 를 docker-compose 로 기동한 뒤, 두 클러스터를 PEP 에 등록해
> 헬스 체크까지 확인한다.
>
> **CNI 는 두 클러스터 모두 Cilium + Hubble** 로 구성한다 (기본 CNI인 kindnet/flannel 대신).
> PEP 의 Cilium/Hubble 딥 트러블슈팅 기능까지 테스트하기 위함.
>
> 클러스터 B 는 **Cilium 스터디 1주차 실습 환경**([Notion](https://www.notion.so/1-Cilium-1-26d18cafd9588113b201cf769f15a835))을
> 그대로 사용한다 — VirtualBox 위에 kubeadm 으로 `k8s-ctr`/`k8s-w1`/`k8s-w2` 3노드를 띄우고
> Cilium 을 Helm 으로 설치한다.
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
│           │ kind 네트워크 내부            │ 192.168.10.100:6443         │
│           ▼                               ▼ (VirtualBox host-only)      │
│   ┌───────────────┐              ┌─────────────────────────┐           │
│   │ 테스트 클러스터 A │              │  테스트 클러스터 B        │          │
│   │ kind (3노드)    │              │  Vagrant + VirtualBox    │          │
│   │ CNI: Cilium     │              │  kubeadm 3노드           │          │
│   │ control-plane:6443│            │  k8s-ctr/w1/w2           │          │
│   └───────────────┘              │  CNI: Cilium             │          │
│                                   │  192.168.10.100/101/102  │          │
│                                   └─────────────────────────┘           │
└────────────────────────────────────────────────────────────────────────┘
```

핵심 연결 원리:
- **클러스터 A (kind)**: backend 컨테이너가 docker `kind` 네트워크에 함께 붙어 있으므로,
  `kind get kubeconfig --internal` 로 얻는 `https://<name>-control-plane:6443` 주소로 직접 접속.
- **클러스터 B (kubeadm VM)**: VirtualBox `private_network`(host-only) 위에 3노드가 뜨고,
  control-plane 은 `192.168.10.100:6443` 으로 API 를 노출한다. kubeadm 이
  `--apiserver-advertise-address=192.168.10.100` 로 init 하므로 **인증서 SAN 에 이 IP 가 포함**돼
  TLS 검증이 통과한다. Mac 호스트는 host-only 어댑터(`192.168.10.1`)로 `.100` 에 직접 도달하고,
  Docker Desktop 의 backend 컨테이너도 호스트 네트워크 스택을 경유해 `192.168.10.100` 에 접속한다.

---

## 0. 사전 설치 (한 번만)

```bash
# Homebrew 가 없다면 먼저 설치: https://brew.sh
brew install --cask docker          # Docker Desktop (실행 후 한 번 열어서 데몬 기동)
brew install kind kubectl           # kind + kubectl (클러스터 A)
brew install cilium-cli helm        # Cilium CLI + Helm (클러스터 A 설치/검증용)
brew install --cask virtualbox      # VirtualBox 7.1+ (Apple Silicon arm64 지원)
brew install --cask vagrant         # Vagrant
```

> **VirtualBox on Apple Silicon**: VirtualBox **7.1 이상**에서 Apple Silicon(arm64) 을 지원한다.
> 설치 후 버전을 확인한다 (Notion 실습 기준 `7.1.10`).
> ```bash
> VBoxManage --version   # 7.1.10r169112 형태
> vagrant version        # Installed Version: 2.4.7 형태
> ```

> **리소스 권장**: 클러스터 B 의 VM 3대(약 5GB)는 **VirtualBox** 가, 클러스터 A(kind)+PEP 컨테이너는
> **Docker Desktop** 이 각각 구동한다. 두 클러스터를 동시에 띄우려면 Mac **메모리 16GB+** 를 권장한다.
> 메모리가 빠듯하면 클러스터를 하나씩(예: 먼저 B 검증 → 정리 → A 검증) 띄운다.

---

## 1. 테스트 클러스터 A — kind + Cilium 생성

기본 CNI(kindnet) 를 비활성화하고 Cilium + Hubble 을 설치하는 헬퍼 스크립트를 쓴다.

```bash
# 3노드 kind 클러스터(disableDefaultCNI) + Cilium + Hubble
bash scripts/local-cilium-kind.sh test-a

# 확인
kubectl --context kind-test-a get nodes
cilium status --context kind-test-a
```

스크립트가 하는 일: kindnet 끈 kind 생성 → `cilium install` → `cilium status --wait` → `cilium hubble enable --ui`.

> `kind create cluster` 가 docker **`kind` 네트워크**를 자동 생성한다.
> docker-compose 가 이 네트워크를 external 로 참조하므로, **PEP 기동(3단계) 전에 이 단계를 먼저** 해야 한다.
>
> ⚠️ Cilium 설치는 인터넷에서 이미지를 받아오므로 첫 실행 시 수 분 걸릴 수 있다. Docker Desktop 메모리 **8GB+** 권장.

---

## 2. 테스트 클러스터 B — Vagrant(VirtualBox) 3노드 kubeadm + Cilium

Notion **Cilium 스터디 1주차** 실습 환경을 그대로 사용한다. VirtualBox 위에 kubeadm 으로
control-plane 1대(`k8s-ctr`) + worker 2대(`k8s-w1`, `k8s-w2`) 를 띄운다. VM 은 **CNI 미설치**
상태로 부팅되며(노드 `NotReady`), 이후 Cilium 을 Helm 으로 설치한다.

배포 사양 (gasida `vagrant-lab` 기준):
- Base box: `bento/ubuntu-24.04`
- Kubernetes `1.33.2`, containerd `1.7.27`
- `eth0` 10.0.2.15 (NAT, 모든 노드 동일 — 외부 인터넷), `eth1` 192.168.10.100/101/102 (host-only)
- `kubeadm init --pod-network-cidr=10.244.0.0/16 --service-cidr=10.96.0.0/16 --apiserver-advertise-address=192.168.10.100`

### 2-1. VM 3대 배포

```bash
mkdir -p cilium-lab && cd cilium-lab
curl -O https://raw.githubusercontent.com/gasida/vagrant-lab/refs/heads/main/cilium-study/1w/Vagrantfile
vagrant up                # VM 3대 부팅 + init_cfg.sh + kubeadm init/join 자동 실행
```

`vagrant up` 이 끝나면 control-plane 에 접속해 노드를 확인한다(아직 `NotReady` 가 정상 — CNI 미설치):

```bash
vagrant ssh k8s-ctr
# (k8s-ctr 안, root 쉘) 노드 3대가 NotReady 로 보이면 정상
kubectl get nodes -owide
```

> ⚠️ VM 3대 프로비저닝(패키지 설치 + kubeadm init/join)은 첫 실행 시 수 분 걸린다.

### 2-2. Cilium 설치 (Helm) — `k8s-ctr` 안에서

`init_cfg.sh` 가 helm 을 미리 설치해 둔다. control-plane 쉘에서 그대로 실행한다.

```bash
# (k8s-ctr 안)
helm repo add cilium https://helm.cilium.io/

# kube-proxy 대체 + native 라우팅 + cluster-pool IPAM(172.20.0.0/16)
helm install cilium cilium/cilium --version 1.17.5 --namespace kube-system \
  --set k8sServiceHost=192.168.10.100 --set k8sServicePort=6443 \
  --set kubeProxyReplacement=true \
  --set routingMode=native \
  --set autoDirectNodeRoutes=true \
  --set ipam.mode="cluster-pool" \
  --set ipam.operator.clusterPoolIPv4PodCIDRList={"172.20.0.0/16"} \
  --set ipv4NativeRoutingCIDR=172.20.0.0/16 \
  --set endpointRoutes.enabled=true \
  --set installNoConntrackIptablesRules=true \
  --set bpf.masquerade=true \
  --set ipv6.enabled=false

# Cilium CLI 설치 + 상태 확인
CILIUM_CLI_VERSION=$(curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt)
CLI_ARCH=amd64; [ "$(uname -m)" = "aarch64" ] && CLI_ARCH=arm64
curl -L --fail --remote-name-all \
  https://github.com/cilium/cilium-cli/releases/download/${CILIUM_CLI_VERSION}/cilium-linux-${CLI_ARCH}.tar.gz
tar xzvfC cilium-linux-${CLI_ARCH}.tar.gz /usr/local/bin && rm cilium-linux-${CLI_ARCH}.tar.gz

cilium status --wait          # KubeProxyReplacement: True / Native 라우팅 확인
kubectl get nodes             # 이제 3노드 모두 Ready
```

> **(선택) Hubble UI**: PEP 의 Hubble 딥 트러블슈팅 기능을 테스트하려면 Hubble 을 켠다.
> ```bash
> cilium hubble enable --ui
> cilium status --wait
> ```

### 2-3. kubeconfig 를 Mac 으로 가져오기

control-plane 의 `admin.conf` 는 이미 `server: https://192.168.10.100:6443` 으로 돼 있어 그대로 쓴다.

```bash
# (cilium-lab/ 디렉터리, Mac 쉘에서)
vagrant ssh k8s-ctr -c 'sudo cat /etc/kubernetes/admin.conf' > kubeadm-kubeconfig.yaml
cd ..
```

> **검증(선택)**: Mac 호스트는 host-only 어댑터로 `.100` 에 직접 도달한다.
> ```bash
> kubectl --kubeconfig cilium-lab/kubeadm-kubeconfig.yaml get nodes
> ```

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

> **backend 컨테이너에서 `192.168.10.100` 도달이 안 될 때(클러스터 B 등록 실패 시)**:
> 먼저 Mac 에서 `curl -k https://192.168.10.100:6443/livez` 로 호스트→VM 도달을 확인한다.
> Docker Desktop 은 컨테이너 트래픽을 호스트 네트워크 스택을 통해 내보내므로 보통 VirtualBox
> host-only 망(`192.168.10.0/24`)까지 도달한다. 그래도 안 되면 [트러블슈팅](#트러블슈팅) 참고.

---

## 4. 두 클러스터를 PEP 에 등록

등록 헬퍼 스크립트가 kubeconfig 업로드 + server 주소 보정 + 즉시 헬스체크까지 처리한다.

```bash
# 클러스터 A (kind) — internal kubeconfig 자동 사용
bash scripts/register-local-cluster.sh --name test-a --kind test-a

# 클러스터 B (Vagrant kubeadm) — control-plane host-only 주소로 등록
bash scripts/register-local-cluster.sh \
  --name vagrant-kubeadm \
  --kubeconfig cilium-lab/kubeadm-kubeconfig.yaml \
  --server https://192.168.10.100:6443
```

스크립트 동작:
1. kubeconfig 확보 (`--kind` 는 `kind get kubeconfig --internal`, `--kubeconfig` 는 파일 사용)
2. `--server` 지정 시 kubeconfig 의 `server:` 를 backend 가 도달 가능한 주소로 재작성
   (클러스터 B 는 이미 `192.168.10.100:6443` 이라 그대로지만, 명시적으로 지정해 둔다)
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

# 클러스터 B (Vagrant kubeadm) 삭제
cd cilium-lab && vagrant destroy -f && cd ..

# 클러스터 A (kind) 삭제  ※ docker-compose down 이후에
kind delete cluster --name test-a
```

> 순서 주의: docker-compose 가 `kind` 네트워크를 사용 중이면 `kind delete` 가 네트워크를 못 지운다.
> **PEP 를 먼저 내리고** kind 를 삭제한다.

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `docker-compose up` → `network kind not found` | kind 클러스터를 안 만듦 | 1단계(`scripts/local-cilium-kind.sh test-a`) 먼저 실행 |
| 클러스터 A 가 `pending` | backend 가 kind 네트워크 미연결 | `docker network inspect kind` 에 `k8s_monitor_backend` 가 있는지 확인. 없으면 `docker-compose up -d` 재실행 |
| `vagrant up` → provider 오류 | VirtualBox 미설치 / 구버전 | VirtualBox **7.1+**(Apple Silicon 지원) 설치 확인 (`VBoxManage --version`) |
| 클러스터 B 노드가 계속 `NotReady` | CNI(Cilium) 미설치/미완료 | `k8s-ctr` 안에서 2-2 의 `helm install cilium ...` 실행 후 `cilium status --wait` |
| 클러스터 B 가 `pending` (connection refused) | 호스트→VM 도달 불가 | Mac 에서 `curl -k https://192.168.10.100:6443/livez` 확인. 안 되면 `cd cilium-lab && vagrant reload` 또는 host-only 어댑터(`192.168.10.1`) 확인 |
| 클러스터 B 가 `certificate verify failed` | server 주소가 인증서 SAN 과 불일치 | `--server https://192.168.10.100:6443` 로 등록했는지 확인 (advertise-address 가 SAN 에 포함됨). 다른 주소로 접속하려면 kubeadm SAN 추가 필요 |
| 클러스터 B 가 `pending` 인데 Mac→VM 은 정상 | backend 컨테이너가 host-only 망 미도달 | Docker Desktop 재시작 후 재시도. 그래도 안 되면 Docker Desktop 의 "Use kernel networking for UDP"/네트워킹 설정 확인, 또는 PEP 를 host 네트워크 모드로 임시 기동 |
| kind 노드가 안 뜸 | Docker 리소스 부족 | Docker Desktop 메모리 8GB+ 로 상향 |
| VM 이 안 뜨거나 느림 | VirtualBox 리소스 부족 | 클러스터 A(kind)+B(VM) 동시 구동 시 Mac 16GB+ 권장. 부족하면 하나씩 띄운다 |
| Cilium 이미지 pull 지연/실패 | 인터넷/리소스 | 첫 설치는 수 분 소요. 실패 시 `cilium status` 로 파드 상태 확인, 재시도 |
| Hubble UI 보고 싶음 | — | 클러스터 A: `cilium hubble ui --context kind-test-a` / 클러스터 B: `k8s-ctr` 안에서 `cilium hubble ui` |

디버그 명령:

```bash
docker network inspect kind | grep -A3 Containers   # backend 가 kind 네트워크에 있나
docker-compose logs -f backend                       # backend 로그
cd cilium-lab && vagrant ssh k8s-ctr -c 'sudo kubectl get nodes -owide'   # 클러스터 B 상태
cd cilium-lab && vagrant ssh k8s-ctr -c 'sudo cilium status'             # 클러스터 B Cilium 상태
```

---

## 빠른 참조 (전체 흐름 한 번에)

```bash
# 1) 클러스터 A (kind + Cilium)
bash scripts/local-cilium-kind.sh test-a

# 2) 클러스터 B (Vagrant VirtualBox kubeadm 3노드)
mkdir -p cilium-lab && cd cilium-lab
curl -O https://raw.githubusercontent.com/gasida/vagrant-lab/refs/heads/main/cilium-study/1w/Vagrantfile
vagrant up
#   → k8s-ctr 안에서 2-2 의 'helm install cilium ...' 실행 (Cilium 설치)
vagrant ssh k8s-ctr -c 'sudo cat /etc/kubernetes/admin.conf' > kubeadm-kubeconfig.yaml
cd ..

# 3) PEP 기동
cp .env.example backend/.env
docker-compose up -d --build

# 4) 등록
bash scripts/register-local-cluster.sh --name test-a --kind test-a
bash scripts/register-local-cluster.sh --name vagrant-kubeadm \
  --kubeconfig cilium-lab/kubeadm-kubeconfig.yaml --server https://192.168.10.100:6443

# 5) 확인 → http://localhost:5173
```
