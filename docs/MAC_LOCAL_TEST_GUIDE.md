# Mac 로컬 테스트 가이드 (Apple Silicon)

> **목표**: 내 맥북(Apple Silicon, M1~M4)에서 **테스트용 K8s 클러스터 2대**(kind 1 + Vagrant/VirtualBox kubeadm 3노드 1)를
> 만들고, **PEP(devops_management)** 를 `docker compose` 로 기동한 뒤, 두 클러스터를 PEP 에 등록해
> 헬스 체크까지 확인한다. 마지막으로 협업/지식/인프라 화면을 둘러볼 샘플 데이터를 채운다.
>
> **CNI 는 두 클러스터 모두 Cilium + Hubble** 로 구성한다 (기본 CNI인 kindnet/flannel 대신).
> PEP 의 Cilium/Hubble 딥 트러블슈팅 기능까지 테스트하기 위함.
>
> 클러스터 B 는 **Cilium 스터디 1주차 실습 환경**([Notion](https://www.notion.so/1-Cilium-1-26d18cafd9588113b201cf769f15a835))을
> 그대로 사용한다 — VirtualBox 위에 kubeadm 으로 `k8s-ctr`/`k8s-w1`/`k8s-w2` 3노드를 띄우고
> Cilium 을 Helm 으로 설치한다.
>
> Intel Mac / 운영 배포는 [DEPLOY_GUIDE.md](DEPLOY_GUIDE.md) 를 참고. 이 문서는 **Apple Silicon + 로컬 테스트** 전용이다.

> ⚠️ **이 가이드의 명령은 실행 위치가 두 종류다. 헷갈리면 대부분의 오류가 여기서 난다.**
> - `bash scripts/...`, `docker compose ...`, `cp .env.example ...` → **레포 루트**(`~/devops_management`)에서.
> - `vagrant ...` (up/ssh/status/destroy) → **`vagrant/` 디렉토리**에서 (Vagrantfile 이 거기 있음).

---

## 전체 구성도

```
┌──────────────────────── macOS (Apple Silicon) ────────────────────────┐
│                                                                        │
│   ┌─────────────── docker compose (PEP 앱) ───────────────┐           │
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

**의존 순서 (중요)**: kind(A) 가 docker `kind` 네트워크를 만들고 → `docker compose` 가 그 네트워크를
external 로 참조한다. 그래서 **반드시 1단계(kind) → 3단계(PEP 기동)** 순서여야 한다.

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

> **`docker compose` (띄어쓰기) 를 쓴다.** Docker Desktop 에는 Compose v2 가 포함돼 있어
> `docker compose ...` 로 동작한다. 옛 `docker-compose`(하이픈, v1)는 설치돼 있지 않을 수 있고
> `command not found` 가 난다 — 이 가이드는 전부 `docker compose` 기준이다.

> **리소스 권장**: 클러스터 B 의 VM 3대(약 5GB)는 **VirtualBox** 가, 클러스터 A(kind)+PEP 컨테이너는
> **Docker Desktop**(Settings → Resources 에서 **CPU 4+ / Memory 8GB+** 권장) 이 각각 구동한다.
> 두 클러스터를 동시에 띄우려면 Mac **메모리 16GB+** 를 권장한다.
> 메모리가 빠듯하면 클러스터를 하나씩(예: 먼저 B 검증 → 정리 → A 검증) 띄운다.

이후 모든 단계는 레포 루트에서 시작한다:

```bash
cd ~/devops_management   # 본인 클론 경로. pwd 로 .../devops_management 확인
```

---

## 1. 테스트 클러스터 A — kind + Cilium 생성

> 📍 **레포 루트에서 실행.** 이 단계가 docker `kind` 네트워크를 만들어 3단계(PEP 기동)의
> 전제조건이 되므로 **가장 먼저** 한다.

기본 CNI(kindnet) 를 비활성화하고 Cilium + Hubble 을 설치하는 헬퍼 스크립트를 쓴다.

```bash
# 3노드 kind 클러스터(disableDefaultCNI) + Cilium + Hubble
bash scripts/local-cilium-kind.sh test-a

# 확인 (모든 노드 Ready 까지 수 분 걸릴 수 있음)
kubectl --context kind-test-a get nodes
cilium status --context kind-test-a
```

스크립트가 하는 일: kindnet 끈 kind 생성 → `cilium install` → `cilium status --wait` → `cilium hubble enable --ui`.

> ⚠️ Cilium 설치는 인터넷에서 이미지를 받아오므로 첫 실행 시 수 분 걸릴 수 있다. Docker Desktop 메모리 **8GB+** 권장.
>
> `kind create cluster` 가 docker **`kind` 네트워크**를 자동 생성한다. `docker compose` 가 이 네트워크를
> external 로 참조하므로, **이 단계 없이 PEP 를 기동하면 `network kind not found` 로 실패**한다.

---

## 2. 테스트 클러스터 B — Vagrant(VirtualBox) 3노드 kubeadm + Cilium

Notion **Cilium 스터디 1주차** 실습 환경을 그대로 사용한다. VirtualBox 위에 kubeadm 으로
control-plane 1대(`k8s-ctr`) + worker 2대(`k8s-w1`, `k8s-w2`) 를 띄운다. VM 은 **CNI 미설치**
상태로 부팅되며(노드 `NotReady`), 이후 Cilium 을 Helm 으로 설치한다.

이 lab 은 **레포의 [`vagrant/`](../vagrant/README.md) 디렉터리에 고정**돼 있다
(upstream: [gasida/vagrant-lab](https://github.com/gasida/vagrant-lab) `cilium-study/1w`). 인터넷에서
매번 받지 않고 버전 고정된 in-repo 본을 쓴다.

배포 사양 (`vagrant/Vagrantfile`):
- Base box: `bento/ubuntu-24.04`
- Kubernetes `1.33.2`, containerd `1.7.27`
- `eth0` 10.0.2.15 (NAT, 모든 노드 동일 — 외부 인터넷), `eth1` 192.168.10.100/101/102 (host-only)
- `kubeadm init --pod-network-cidr=10.244.0.0/16 --service-cidr=10.96.0.0/16 --apiserver-advertise-address=192.168.10.100`

### 2-1. VM 3대 배포

> 📍 **`vagrant/` 디렉토리에서 실행.** (`cd vagrant`) Vagrantfile 이 없는 곳에서 `vagrant ...` 를
> 치면 `A Vagrant environment ... is required` 오류가 난다.

```bash
cd vagrant
vagrant up                # VM 3대 부팅 + init_cfg.sh + kubeadm init/join 자동 실행
```

`vagrant up` 이 끝나면 control-plane 에 접속해 노드를 확인한다(아직 `NotReady` 가 정상 — CNI 미설치):

```bash
vagrant ssh k8s-ctr
# (k8s-ctr 안, root 쉘) 노드 3대가 NotReady 로 보이면 정상
kubectl get nodes -owide
```

> ⚠️ VM 3대 프로비저닝(패키지 설치 + kubeadm init/join)은 첫 실행 시 수 분 걸린다.

### 2-2. Cilium 설치 (Helm)

CNI 는 부팅 시 설치하지 않으므로 따로 설치한다. `vagrant/install-cilium.sh` 가 named provisioner
(`cilium`) 로 등록돼 있어 control-plane 에서 한 줄로 실행한다.

```bash
# (vagrant/ 디렉토리, Mac 쉘에서)
vagrant provision k8s-ctr --provision-with cilium
#   → 끝나면 cilium status --wait 통과, 3노드 모두 Ready
```

이 provisioner 가 `k8s-ctr` 안에서 실행하는 것(= Cilium 스터디 1주차 설정, kube-proxy 대체 +
native 라우팅 + cluster-pool IPAM `172.20.0.0/16`):

```bash
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
```

> 손으로 학습하고 싶으면 `vagrant ssh k8s-ctr` 로 들어가 위 명령을 직접 실행해도 된다
> (전체 내용은 [`vagrant/install-cilium.sh`](../vagrant/install-cilium.sh)).

> **(선택) Hubble UI**: PEP 의 Hubble 딥 트러블슈팅 기능을 테스트하려면 Hubble 을 켠다.
> ```bash
> vagrant ssh k8s-ctr -c 'sudo cilium hubble enable --ui'
> ```

### 2-3. kubeconfig 를 Mac 으로 가져오기

control-plane 의 `admin.conf` 는 이미 `server: https://192.168.10.100:6443` 으로 돼 있어 그대로 쓴다.

```bash
# (vagrant/ 디렉터리, Mac 쉘에서)
vagrant ssh k8s-ctr -c 'sudo cat /etc/kubernetes/admin.conf' > kubeadm-kubeconfig.yaml
cd ..
```

> **검증(선택)**: Mac 호스트는 host-only 어댑터로 `.100` 에 직접 도달한다. 직접 확인할 때는 반드시
> **`--kubeconfig` 로 이 파일을 가리킨다** — 그냥 `kubectl get nodes` 를 치면 Mac 기본 kubeconfig 를
> 보고 `The connection to the server localhost:8080 was refused` 가 난다.
> ```bash
> kubectl --kubeconfig vagrant/kubeadm-kubeconfig.yaml get nodes
> ```

---

## 3. PEP(devops_management) 기동 — docker compose

> 📍 **레포 루트에서 실행.**
> ⚠️ **반드시 1단계(kind) 이후에 실행**. `docker-compose.yml` 이 external `kind` 네트워크를
> 참조하므로, kind 클러스터(=`kind` 네트워크)가 없으면 `network kind not found` 로 실패한다.

```bash
cp .env.example backend/.env     # 환경 변수 (최초 1회). 'No such file' 이면 레포 루트가 아님 → cd ~/devops_management
docker compose up -d --build     # postgres + redis + backend + frontend + celery

# 기동 확인
docker compose ps
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

> **클러스터 A 없이 클러스터 B 만 빠르게 테스트하고 싶다면**: kind 를 안 만드는 대신 네트워크만
> 수동 생성하면 compose 가 뜬다 (클러스터 B 는 `192.168.10.100` 으로 도달하므로 kind 네트워크와 무관).
> ```bash
> docker network create kind
> docker compose up -d --build
> ```

---

## 4. 두 클러스터를 PEP 에 등록

> 📍 **레포 루트에서 실행.** 등록 헬퍼 스크립트가 kubeconfig 업로드 + server 주소 보정 +
> 즉시 헬스체크까지 처리한다. 내부적으로 `admin/admin` 으로 로그인해 Bearer 토큰을 붙인다
> (clusters 등록은 operator/admin 인증 필요).

```bash
# 클러스터 A (kind) — internal kubeconfig 자동 사용
bash scripts/register-local-cluster.sh --name test-a --kind test-a

# 클러스터 B (Vagrant kubeadm) — control-plane host-only 주소로 등록
bash scripts/register-local-cluster.sh \
  --name vagrant-kubeadm \
  --kubeconfig vagrant/kubeadm-kubeconfig.yaml \
  --server https://192.168.10.100:6443
```

스크립트 동작:
1. kubeconfig 확보 (`--kind` 는 `kind get kubeconfig --internal`, `--kubeconfig` 는 파일 사용)
2. `--server` 지정 시 kubeconfig 의 `server:` 를 backend 가 도달 가능한 주소로 재작성
   (클러스터 B 는 이미 `192.168.10.100:6443` 이라 그대로지만, 명시적으로 지정해 둔다)
3. `admin/admin` 로그인 → Bearer 토큰
4. `POST /api/v1/clusters` 로 `kubeconfig_content` 와 함께 등록
5. `POST /api/v1/daily-check/run/{id}` 로 즉시 헬스체크 실행

> 등록은 기본적으로 `skip_connectivity_check=true` 로 진행되고, **실제 도달성은 헬스체크 결과로 확인**한다.
> 등록 시점에 엄격히 검증하려면 `--check` 옵션을 추가.
>
> **스크립트가 `[2/4] 로그인 중...` 직후 멈추거나 "연결할 수 없습니다" 가 뜨면 → PEP 백엔드가 안 떠 있는 것.**
> 3단계를 먼저 끝내고 `curl http://localhost:8000/health` 로 확인 후 재실행한다.

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

## 5.5 테스트 데이터 넣기 (샘플 데이터 주입)

클러스터 2대만 등록하면 **대시보드/헬스체크**는 바로 동작하지만, 협업·지식·인프라
페이지(작업/이슈, 프로젝트, 인프라 노드, 지식 문서, 운영 메모)는 비어 있다. PEP 의
이런 기능까지 둘러보려면 샘플 데이터를 채워 넣는다.

### 자동으로 채워지는 것 (시드)

backend 가 **처음 부팅될 때** `main.py` 의 `_seed_*` 단계가 아래를 자동 생성한다 —
별도 작업이 필요 없다.

| 시드 | 내용 |
|---|---|
| `metric_cards` | 기본 PromQL 카드 6종 (CrashLoop/Failed Pod, CPU/메모리, PVC, 네트워크) |
| `playbooks` | 기본 Ansible 플레이북 |
| `deep_check_definitions` / `metric_checklist_items` | 운영 점검(Ops Checks) 항목 |
| `lake_service_types` / `lake_service_entries` | Data Lake 서비스 카탈로그 |
| `cluster_items` / `trend_sources` | 클러스터 항목·트렌드 소스 기본값 |
| `initial_admin` | 부트스트랩 관리자 계정 `admin / admin` (`INITIAL_ADMIN_*` 로 변경 가능) |

> 시드는 **테이블이 비어 있을 때만** 동작(멱등). 부팅 로그에서
> `migration: ... ` / `seed_*` 흔적으로 확인할 수 있다.

### 협업·지식·인프라 샘플 한 번에 넣기

> 📍 **레포 루트에서 실행 (백엔드가 떠 있어야 함).**

부팅 시 비어 있는 데이터(프로젝트·작업/이슈·인프라 노드·지식 문서·운영 메모)는
헬퍼 스크립트로 채운다. 내부적으로 `admin` 으로 로그인해 Bearer 토큰을 받고
(`/api/v1/auth/login`), 등록된 첫 번째 클러스터를 인프라 노드/작업에 연결한다.

```bash
# 4단계(클러스터 등록) 이후 실행 권장
bash scripts/seed-test-data.sh

# 계정/주소 변경 시
API_URL=http://localhost:8000 PEP_USER=admin PEP_PASS=admin bash scripts/seed-test-data.sh
```

생성되는 샘플:

| 영역 | API | 샘플 |
|---|---|---|
| 프로젝트 | `POST /projects` | "플랫폼 안정화 2026-Q3" 1건 |
| 작업/이슈 | `POST /work-items` | task 2 + issue 1 (위 프로젝트·클러스터 연결) |
| 인프라 노드 | `POST /infra-nodes` | master/worker/storage 4대 (클러스터 등록 시에만) |
| 지식 문서 | `POST /knowledge/pages` | "노드 NotReady 대응 런북" 1건 |
| 운영 메모 | `POST /ops-notes` | 스티키 노트 2건 |

> ⚠️ **멱등하지 않다** — 같은 이름이 있어도 API 가 중복 생성한다. 한 번만 실행하길
> 권장하고, 재실행하면 샘플이 중복으로 쌓인다(로컬 테스트라 무방).
>
> 클러스터를 아직 등록하지 않았으면 인프라 노드는 건너뛰고 나머지만 생성된다.
> 백엔드가 안 떠 있으면 "로그인 실패 — backend 기동 여부 확인" 메시지가 나온다.

### 직접 넣기 (수동)

스크립트 없이 개별로 넣고 싶으면 Swagger UI(http://localhost:8000/docs)에서
`POST /api/v1/auth/login` 으로 토큰을 받아 **Authorize** 에 붙인 뒤 각 엔드포인트를
호출하거나, curl 로:

```bash
TOKEN=$(curl -s -X POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

curl -X POST http://localhost:8000/api/v1/ops-notes \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"service":"k8s","title":"메모","content":"내용","color":"yellow"}'
```

> 쓰기 API(`/work-items`, `/projects`, `/infra-nodes`, `/knowledge`, `/ops-notes` 등)는
> operator/admin 인증이 필요하다. 토큰 없이 호출하면 401 이 난다.

---

## 6. 정리 (Teardown)

```bash
# PEP 중지 (레포 루트에서)
docker compose down              # 데이터 유지
# docker compose down -v         # 볼륨(DB)까지 삭제

# 클러스터 B (Vagrant kubeadm) 삭제
cd vagrant && vagrant destroy -f && cd ..

# 클러스터 A (kind) 삭제  ※ docker compose down 이후에
kind delete cluster --name test-a
```

> 순서 주의: `docker compose` 가 `kind` 네트워크를 사용 중이면 `kind delete` 가 네트워크를 못 지운다.
> **PEP 를 먼저 내리고** kind 를 삭제한다. (`docker network create kind` 로 만든 경우엔 `docker network rm kind`)

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `docker-compose: command not found` | v1(하이픈) 미설치 | **`docker compose`** (띄어쓰기, v2) 를 쓴다. Docker Desktop 에 포함됨 |
| `cp: .env.example: No such file or directory` | 레포 루트가 아닌 곳에서 실행 | `cd ~/devops_management` 후 재실행 (`pwd` 로 확인) |
| `vagrant ...` → `A Vagrant environment ... is required` | `vagrant/` 밖에서 실행 | `cd vagrant` 후 실행 (Vagrantfile 이 거기 있음) |
| `kubectl ...` → `localhost:8080 ... connection refused` | kubeconfig 미지정 (Mac kubectl 기본값) | `kubectl --kubeconfig vagrant/kubeadm-kubeconfig.yaml get nodes`. VM 안에선 `vagrant ssh k8s-ctr -c 'sudo kubectl ...'` |
| `docker compose up` → `network kind not found` | kind 클러스터(A)를 안 만듦 | 1단계 먼저 실행. 또는 B 만 테스트면 `docker network create kind` |
| register 스크립트가 `[2/4] 로그인` 직후 종료 / "연결할 수 없습니다" | PEP 백엔드 미기동 | 3단계 완료 후 `curl localhost:8000/health` 확인 → 재실행 |
| register 스크립트 "로그인 실패 — 계정 확인" | 잘못된 계정 | 기본 `admin/admin`, 또는 `--user/--pass` / `PEP_USER`·`PEP_PASS` |
| 클러스터 A 가 `pending` | backend 가 kind 네트워크 미연결 | `docker network inspect kind` 에 `k8s_monitor_backend` 가 있는지 확인. 없으면 `docker compose up -d` 재실행 |
| `vagrant up` → provider 오류 | VirtualBox 미설치 / 구버전 | VirtualBox **7.1+**(Apple Silicon 지원) 설치 확인 (`VBoxManage --version`) |
| 클러스터 B 노드가 계속 `NotReady` | CNI(Cilium) 미설치/미완료 | `k8s-ctr` 안에서 2-2 의 `helm install cilium ...` 실행 후 `cilium status --wait` |
| 클러스터 B 가 `pending` (connection refused) | 호스트→VM 도달 불가 | Mac 에서 `curl -k https://192.168.10.100:6443/livez` 확인. 안 되면 `cd vagrant && vagrant reload` 또는 host-only 어댑터(`192.168.10.1`) 확인 |
| 클러스터 B 가 `certificate verify failed` | server 주소가 인증서 SAN 과 불일치 | `--server https://192.168.10.100:6443` 로 등록했는지 확인 (advertise-address 가 SAN 에 포함됨). 다른 주소로 접속하려면 kubeadm SAN 추가 필요 |
| 클러스터 B 가 `pending` 인데 Mac→VM 은 정상 | backend 컨테이너가 host-only 망 미도달 | Docker Desktop 재시작 후 재시도. 그래도 안 되면 Docker Desktop 네트워킹 설정 확인, 또는 PEP 를 host 네트워크 모드로 임시 기동 |
| kind 노드가 안 뜸 | Docker 리소스 부족 | Docker Desktop 메모리 8GB+ 로 상향 |
| VM 이 안 뜨거나 느림 | VirtualBox 리소스 부족 | 클러스터 A(kind)+B(VM) 동시 구동 시 Mac 16GB+ 권장. 부족하면 하나씩 띄운다 |
| `hubble-relay`/`hubble-ui` 가 `Pending` | **비차단** (부가기능) — 노드 NotReady 또는 리소스 부족 | 코어 cilium 이 Ready 면 등록 진행 가능. 노드 Ready 후 자동 해소되거나, VM 메모리(`Vagrantfile` 의 `vb.memory`)를 올리고 `vagrant reload` |
| Cilium 이미지 pull 지연/실패 | 인터넷/리소스 | 첫 설치는 수 분 소요. 실패 시 `cilium status` 로 파드 상태 확인, 재시도 |
| Hubble UI 보고 싶음 | — | 클러스터 A: `cilium hubble ui --context kind-test-a` / 클러스터 B: `k8s-ctr` 안에서 `cilium hubble ui` |

디버그 명령:

```bash
docker network inspect kind | grep -A3 Containers   # backend 가 kind 네트워크에 있나
docker compose logs -f backend                       # backend 로그 (레포 루트)
cd vagrant && vagrant ssh k8s-ctr -c 'sudo kubectl get nodes -owide'   # 클러스터 B 상태
cd vagrant && vagrant ssh k8s-ctr -c 'sudo cilium status'             # 클러스터 B Cilium 상태
```

---

## 빠른 참조 (전체 흐름 한 번에)

```bash
cd ~/devops_management            # 레포 루트 (vagrant 명령만 vagrant/ 에서)

# 1) 클러스터 A (kind + Cilium) — docker 'kind' 네트워크 생성 = compose 전제조건
bash scripts/local-cilium-kind.sh test-a

# 2) 클러스터 B (Vagrant VirtualBox kubeadm 3노드 — in-repo vagrant/)
cd vagrant
vagrant up                                          # VM 3대 (CNI 미설치 → NotReady)
vagrant provision k8s-ctr --provision-with cilium   # Cilium 설치 → 3노드 Ready
vagrant ssh k8s-ctr -c 'sudo cat /etc/kubernetes/admin.conf' > kubeadm-kubeconfig.yaml
cd ..

# 3) PEP 기동 (docker compose v2)
cp .env.example backend/.env
docker compose up -d --build
curl http://localhost:8000/health

# 4) 등록
bash scripts/register-local-cluster.sh --name test-a --kind test-a
bash scripts/register-local-cluster.sh --name vagrant-kubeadm \
  --kubeconfig vagrant/kubeadm-kubeconfig.yaml --server https://192.168.10.100:6443

# 5) 샘플 데이터 주입 (선택) — 협업/지식/인프라 페이지 둘러보기용
bash scripts/seed-test-data.sh

# 6) 확인 → http://localhost:5173
```
