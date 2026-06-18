# Mac 로컬 테스트 가이드 (Apple Silicon)

> **목표**: 내 맥북(Apple Silicon, M1~M4)에서 **테스트용 K8s 클러스터 2대**(kind 1 + Vagrant/k3s 1)를
> 만들고, **PEP(devops_management)** 를 docker-compose 로 기동한 뒤, 두 클러스터를 PEP 에 등록해
> 헬스 체크까지 확인한다.
>
> **CNI 는 두 클러스터 모두 Cilium + Hubble** 로 구성한다 (기본 CNI인 kindnet/flannel 대신).
> PEP 의 Cilium/Hubble 딥 트러블슈팅 기능까지 테스트하기 위함.
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
│           │ kind 네트워크 내부            │ host.docker.internal:6443   │
│           ▼                               ▼                            │
│   ┌───────────────┐              ┌─────────────────────┐               │
│   │ 테스트 클러스터 A │              │  테스트 클러스터 B    │              │
│   │ kind (3노드)    │              │  Vagrant VM + k3s    │              │
│   │ CNI: Cilium     │              │  CNI: Cilium         │              │
│   │ control-plane:6443│            │  (QEMU, 포트포워딩)   │              │
│   └───────────────┘              └─────────────────────┘               │
└────────────────────────────────────────────────────────────────────────┘
```

핵심 연결 원리:
- **클러스터 A (kind)**: backend 컨테이너가 docker `kind` 네트워크에 함께 붙어 있으므로,
  `kind get kubeconfig --internal` 로 얻는 `https://<name>-control-plane:6443` 주소로 직접 접속.
- **클러스터 B (k3s VM)**: VM 의 6443 을 Mac 호스트로 포워딩하고, backend 컨테이너는
  `host.docker.internal:6443` 으로 접속. k3s 를 `--tls-san host.docker.internal` 로 설치해 TLS 검증 통과.

---

## 0. 사전 설치 (한 번만)

```bash
# Homebrew 가 없다면 먼저 설치: https://brew.sh
brew install --cask docker          # Docker Desktop (실행 후 한 번 열어서 데몬 기동)
brew install kind kubectl           # kind + kubectl
brew install cilium-cli             # Cilium CLI (kind 에 Cilium 설치용)
brew install qemu                   # Vagrant QEMU provider 용 (Apple Silicon)
brew install --cask vagrant         # Vagrant
vagrant plugin install vagrant-qemu # QEMU provider 플러그인
```

> **Docker Desktop 리소스**: Settings → Resources 에서 **CPU 4+ / Memory 8GB+** 권장
> (kind 3노드 + PEP 컨테이너 + k3s VM 동시 구동).

> **Vagrant provider 대안**: QEMU 가 가장 간단(무료·CLI)하지만, GUI 가상화를 선호하면
> VMware Fusion 13(개인용 무료) + `vagrant-vmware-desktop`, 또는 Parallels(유료) +
> `vagrant-parallels` 도 가능하다. `vagrant/Vagrantfile` 상단 주석 참고.

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

## 2. 테스트 클러스터 B — Vagrant + k3s + Cilium 생성

```bash
cd vagrant
vagrant up                # QEMU VM 부팅 + provision-k3s.sh 가 k3s + Cilium 설치
```

`vagrant up` 이 끝나면:
- VM 안에 단일 노드 k3s 가 **flannel 비활성화 + Cilium** 로 설치됨 (`--tls-san host.docker.internal`)
- VM 의 6443 → Mac 호스트 `127.0.0.1:6443` 으로 포워딩됨

> Cilium 까지 설치하므로 provision 에 수 분 소요된다. flannel 기본 CNI 로 두고 싶으면
> `K3S_CNI=flannel vagrant up` (또는 `Vagrantfile` 의 provision env).

kubeconfig 를 Mac 으로 가져오기:

```bash
# (여전히 vagrant/ 디렉토리에서)
vagrant ssh -c 'sudo cat /etc/rancher/k3s/k3s.yaml' > k3s-kubeconfig.yaml
cd ..
```

> **검증(선택)**: `kubectl --kubeconfig vagrant/k3s-kubeconfig.yaml --server https://127.0.0.1:6443 get nodes`
> 로 Mac 에서 직접 접속되는지 확인 가능.

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

> **`host.docker.internal` 이 backend 컨테이너에서 안 풀릴 때(클러스터 B 등록 실패 시)**:
> 프로젝트 루트에 `docker-compose.override.yml` 을 만들어 host-gateway 를 명시한다.
> ```yaml
> services:
>   backend:
>     extra_hosts: ["host.docker.internal:host-gateway"]
>   celery:
>     extra_hosts: ["host.docker.internal:host-gateway"]
> ```
> 이후 `docker-compose up -d` 재실행. (Docker Desktop 에선 보통 기본 제공돼 불필요)

---

## 4. 두 클러스터를 PEP 에 등록

등록 헬퍼 스크립트가 kubeconfig 업로드 + server 주소 보정 + 즉시 헬스체크까지 처리한다.

```bash
# 클러스터 A (kind) — internal kubeconfig 자동 사용
bash scripts/register-local-cluster.sh --name test-a --kind test-a

# 클러스터 B (Vagrant k3s) — Mac 호스트 포워딩 주소로 등록
bash scripts/register-local-cluster.sh \
  --name vagrant-k3s \
  --kubeconfig vagrant/k3s-kubeconfig.yaml \
  --server https://host.docker.internal:6443
```

스크립트 동작:
1. kubeconfig 확보 (`--kind` 는 `kind get kubeconfig --internal`, `--kubeconfig` 는 파일 사용)
2. `--server` 지정 시 kubeconfig 의 `server:` 를 backend 가 도달 가능한 주소로 재작성
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
# PEP 중지
docker-compose down              # 데이터 유지
# docker-compose down -v         # 볼륨(DB)까지 삭제

# 클러스터 B (Vagrant) 삭제
cd vagrant && vagrant destroy -f && cd ..

# 클러스터 A (kind) 삭제  ※ docker-compose down 이후에
kind delete cluster --name test-a
```

> 순서 주의: docker-compose 가 `kind` 네트워크를 사용 중이면 `kind delete` 가 네트워크를 못 지운다.
> **PEP 를 먼저 내리고** kind 를 삭제한다.

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `docker-compose up` → `network kind not found` | kind 클러스터를 안 만듦 | 1단계(`kind create cluster --name test-a`) 먼저 실행 |
| 클러스터 A 가 `pending` | backend 가 kind 네트워크 미연결 | `docker network inspect kind` 에 `k8s_monitor_backend` 가 있는지 확인. 없으면 `docker-compose up -d` 재실행 |
| 클러스터 B 가 `pending` (connection refused) | 포트포워딩/방화벽 | Mac 에서 `curl -k https://127.0.0.1:6443/livez` 확인. 안 되면 `cd vagrant && vagrant reload` |
| 클러스터 B 가 `certificate verify failed` | tls-san 누락 | k3s 가 `--tls-san host.docker.internal` 로 설치됐는지 확인 (`vagrant ssh -c 'sudo cat /etc/systemd/system/k3s.service'`). 누락 시 `vagrant destroy -f && vagrant up` |
| 클러스터 B 가 `pending` 인데 A 는 정상 | backend 컨테이너에서 `host.docker.internal` 미해석 | 3단계의 `docker-compose.override.yml`(extra_hosts) 적용 후 재기동 |
| `vagrant up` → provider 오류 | QEMU 플러그인 미설치 | `vagrant plugin install vagrant-qemu`, `brew install qemu` 확인 |
| kind 노드가 안 뜸 | Docker 리소스 부족 | Docker Desktop 메모리 8GB+ 로 상향 |
| 노드가 계속 `NotReady` | CNI(Cilium) 미설치/미완료 | kind: `cilium status --context kind-test-a` / k3s: `vagrant ssh -c 'sudo KUBECONFIG=/etc/rancher/k3s/k3s.yaml cilium status'`. 미완료면 `cilium status --wait` |
| k3s 노드 `NotReady` (Cilium 인데) | k3s CNI 경로 mismatch | provision 은 `cni.binPath=/var/lib/rancher/k3s/data/current/bin` `cni.confPath=/var/lib/rancher/k3s/agent/etc/cni/net.d` 로 설치. 그래도 안 되면 VM 에서 `cilium install` 재실행 또는 `vagrant destroy -f && vagrant up` |
| Cilium 이미지 pull 지연/실패 | 인터넷/리소스 | 첫 설치는 수 분 소요. 실패 시 `cilium status` 로 파드 상태 확인, 재시도 |
| Hubble UI 보고 싶음 | — | kind: `cilium hubble ui --context kind-test-a` (포트포워딩) |

디버그 명령:

```bash
docker network inspect kind | grep -A3 Containers   # backend 가 kind 네트워크에 있나
docker-compose logs -f backend                       # backend 로그
cd vagrant && vagrant ssh -c 'sudo k3s kubectl get nodes'   # k3s 상태
```

---

## 빠른 참조 (전체 흐름 한 번에)

```bash
# 1) 클러스터 A (kind + Cilium)
bash scripts/local-cilium-kind.sh test-a

# 2) 클러스터 B (Vagrant k3s + Cilium)
cd vagrant && vagrant up && vagrant ssh -c 'sudo cat /etc/rancher/k3s/k3s.yaml' > k3s-kubeconfig.yaml && cd ..

# 3) PEP 기동
cp .env.example backend/.env
docker-compose up -d --build

# 4) 등록
bash scripts/register-local-cluster.sh --name test-a --kind test-a
bash scripts/register-local-cluster.sh --name vagrant-k3s --kubeconfig vagrant/k3s-kubeconfig.yaml --server https://host.docker.internal:6443

# 5) 샘플 데이터 주입 (선택) — 협업/지식/인프라 페이지 둘러보기용
bash scripts/seed-test-data.sh

# 6) 확인 → http://localhost:5173
```
