# 노드 OS 파라미터 에이전트 (node-param-agent)

대상 클러스터의 **노드마다 1개** 떠서 감시 대상 커널 파라미터(sysctl)의 값을 PEP 로 보고하는 DaemonSet 입니다.
PEP 는 값이 바뀌거나, 기준값을 벗어나거나, 현재 값이 영구 설정(`/etc/sysctl.d` 등)과 다르면 **알람 인박스**로 알립니다.
화면: K8s 허브 ▸ 점검 ▸ **OS 파라미터 감시** (`/k8s/<클러스터>/os-param-watch`).

- 이미지는 전용 에이전트 이미지 `ghcr.io/riverjin839/devops_management/node-agent`(정적 Rust 바이너리, distroless,
  amd64/arm64, 소스 `agent-rs/`)입니다. backend 이미지를 쓰던 기존 설치는 PEP 화면이 Python 에이전트
  (`python -m app.node_param_agent`) 방식으로 렌더하므로 그대로 동작하고, 이미지만 `…/node-agent` 로 바꾸면 전환됩니다.
  폐쇄망이면 사내 레지스트리 경로로 바꿉니다.
- **무엇을 읽을지는 PEP 화면의 감시 규칙이 정합니다.** 에이전트는 보고 응답으로 감시 목록과 보고 주기를 받으므로
  규칙을 바꿀 때 에이전트를 다시 배포할 필요가 없습니다.
- PEP 화면 ▸ 에이전트 설치 탭이 이 디렉터리와 같은 매니페스트를 클러스터 UUID·주소를 채워 보여줍니다.
  바로 붙여 넣어 쓰려면 그쪽이 편하고, GitOps 로 관리하려면 이 디렉터리를 씁니다.

## 설치

```bash
# 0) PEP backend 에 NODE_PARAM_INGEST_TOKEN 설정 (미설정 시 보고가 503 으로 거부된다)
python -c "import secrets; print(secrets.token_urlsafe(32))"

# 1) 시크릿 채우기
cp secret.yaml.tmpl secret.yaml
$EDITOR secret.yaml
#   PEP_API_URL             = https://<PEP 주소>/api/v1   (노드에서 닿는 주소)
#   PEP_CLUSTER             = PEP 에 등록된 이 클러스터의 UUID(또는 이름)
#   NODE_PARAM_INGEST_TOKEN = 0) 의 값
#   PEP_TLS_VERIFY          = 사설 인증서면 "false" (또는 CA 를 마운트하고 PEP_CA_FILE 지정)

# 2) kustomization 에 secret 포함
sed -i 's|# - secret.yaml|- secret.yaml|' kustomization.yaml

# 3) 배포
kubectl apply -k .

# 4) 확인 — 한 주기마다 보고 결과가 한 줄씩 찍힌다
kubectl -n k8s-monitor-agent rollout status ds/node-param-agent
kubectl -n k8s-monitor-agent logs ds/node-param-agent --tail=20
```

노드에서 무엇을 읽는지 보내지 않고 확인하려면:

```bash
# Rust 이미지(distroless)는 셸이 없어 exec 대신 debug 로 같은 이미지를 한 번 더 띄운다
kubectl -n k8s-monitor-agent debug -it ds/node-param-agent --image=<node-agent 이미지> --target=agent -- \
  /pep-node-agent --dry-run --nic --param net.core.somaxconn --param vm.swappiness
# (backend 이미지를 쓰는 설치) kubectl exec ds/node-param-agent -- python -m app.node_param_agent --dry-run ...
```

## 권한 (최소화)

| 항목 | 값 | 이유 |
|---|---|---|
| privileged · hostPID | 없음 | 필요 없음 |
| 사용자 | 65534(nobody), 루트 파일시스템 읽기 전용, capability 전부 제거 | `/proc/sys` 와 sysctl 설정 파일은 일반 사용자가 읽을 수 있다 |
| `hostNetwork: true` | 켬 | `net.*` 는 네트워크 네임스페이스마다 값이 따로 있어, 끄면 노드가 아니라 파드의 값을 읽는다 |
| `hostIPC: true` | 켬 | `kernel.shm*`·`kernel.msg*` 는 IPC 네임스페이스마다 값이 따로 있다 |
| 호스트 경로 | `/etc/sysctl.conf`, `/etc/sysctl.d`, `/run/sysctl.d`, `/usr/lib/sysctl.d` · `/etc/containerd`, `/var/lib/kubelet` 읽기 전용 | 영구 설정 값 계산 · 서비스 구성 변경 감지(설정 파일). `/etc` 전체는 마운트하지 않는다 |
| 서비스어카운트 토큰 | 마운트 안 함 | 쿠버네티스 API 를 쓰지 않는다 |

## 서비스 구성 설정 파일 보고 (에이전트 1.1.0+)

PEP 서비스 구성의 변경 감지·알람용으로 containerd `config.toml` 과 kubelet `config.yaml` 도 읽어 보고합니다.
읽을 경로는 보고 응답(`files`)으로 받으며 PEP 서비스 구성 ▸ 설정(적용 설정의 containerd·kubelet 설정 파일)에서 바꿉니다.
파일 해시가 바뀐 때만 내용을 보내고(256 KB 상한), 나머지 보고에는 해시만 실립니다.

- DaemonSet 이 `/etc/containerd` · `/var/lib/kubelet` 를 **읽기 전용**으로 마운트합니다(경로를 바꿨다면 화면의 설치 안내 매니페스트를 다시 받아 적용).
- 에이전트는 비 root(65534)라 권한 600 파일(kubelet 인증서 키 등)은 읽지 못합니다 — 설정 파일(보통 644)만 읽습니다.
- 이전 버전(1.0.x) 에이전트는 파일을 보고하지 않습니다 — 이 매니페스트로 **재배포**해야 CONTAINERD·KUBELET 변경 감지가 동작합니다.

## NIC 상태 보고 (에이전트 1.2.0+)

PEP 서비스 구성 ▸ **NIC** 화면용으로 노드 인터페이스 상태를 함께 보고합니다 — 본딩/LACP(`/proc/net/bonding`),
링크 속도·duplex·MTU·carrier 변화·통계 카운터(`/sys/class/net`), ring buffer·드라이버·offload·드라이버 통계(ethtool 조회 ioctl).

- **추가 마운트·권한이 필요 없습니다.** `hostNetwork` 라 노드 인터페이스가 보이고, ethtool 조회(GET) 명령은 커널이
  권한 없이 허용합니다(`ethtool` 바이너리·`CAP_NET_ADMIN` 불필요). 드라이버가 지원하지 않는 항목은 비워 보냅니다.
- 수집 대상(인터페이스 종류·포함/제외 이름)과 켜기/끄기는 보고 응답(`nic`)으로 받습니다 — PEP 화면 ▸ NIC 설정에서 바꿉니다.
- 1.1.x 이하 에이전트는 NIC 를 보고하지 않습니다 — 이미지 태그를 올려 **재배포**하면 됩니다(매니페스트 변경 없음).
- 점검: `python -m app.node_param_agent --dry-run --nic` — 보내지 않고 읽은 NIC 상태를 출력합니다.

## Python → Rust 전환 (canary)

노드가 많으면(수백 대) 한 번에 바꾸지 말고 일부 노드에서 **같은 값을 보고하는지** 확인한 뒤 넓힙니다. 보고 프로토콜이 같아 PEP 서버는 바꾸지 않으며,
되돌리려면 라벨만 지우면 됩니다. 같은 노드에서 두 에이전트가 동시에 보고하지 않도록 DaemonSet 을 노드 라벨로 나눕니다.

1. **이미지 확인** — Rust 이미지(`…/node-agent`, 릴리스 1.106.0 이상)가 레지스트리에 있는지 확인합니다. 폐쇄망이면 `docs/DEPLOY_GUIDE.md` 방법 C 로 먼저 반입합니다.
2. **canary 노드 라벨** — 노드 2~3대(가능하면 본딩·단일 NIC·구형 커널이 섞이게)에 라벨을 붙입니다.
   ```bash
   kubectl label node <노드1> <노드2> pep.io/node-agent=rust
   ```
3. **DaemonSet 분리** — 기존(Python) DaemonSet 은 라벨이 없는 노드에만, Rust DaemonSet 은 라벨이 있는 노드에만 뜨게 합니다.
   ```bash
   # Python(기존): 라벨 노드 제외
   kubectl -n k8s-monitor-agent patch ds node-param-agent --type merge -p \
     '{"spec":{"template":{"spec":{"affinity":{"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":{"nodeSelectorTerms":[{"matchExpressions":[{"key":"pep.io/node-agent","operator":"DoesNotExist"}]}]}}}}}}}'
   # Rust(신규): PEP 설치 화면에서 받은 매니페스트의 DaemonSet 이름을 node-param-agent-rs 로, spec.template.spec 에 같은 형식으로
   #   nodeSelector: { pep.io/node-agent: rust } 를 넣어 적용 (Secret·Namespace 는 기존 것을 그대로 쓴다)
   ```
4. **출력 비교** — canary 노드에서 같은 입력에 대한 두 에이전트의 읽기 결과를 비교합니다(보내지 않는 점검).
   ```bash
   P='--param net.core.somaxconn --param vm.swappiness --param net.ipv4.tcp_rmem'
   kubectl -n k8s-monitor-agent debug -it <rust 파드> --image=<node-agent 이미지> --target=agent -- /pep-node-agent --dry-run --nic $P > rust.json
   # Python 이미지로 같은 노드에서(임시 파드): python -m app.node_param_agent --dry-run --nic $P > py.json
   diff <(jq -S . py.json) <(jq -S . rust.json)    # 카운터 값만 조금 다르면 정상(실시간 값)
   ```
   물리 NIC 의 `ring`·`driver`·`features`, 본딩 `slave_state`, `lacp` 항목이 같은지 봅니다(가상 NIC 만 있는 환경에서는 ethtool 항목이 비는 것이 정상).
5. **PEP 화면 확인** — OS 파라미터 감시에서 canary 노드의 에이전트 버전이 `2.x` 이고 '보고 중' 인지, 서비스 구성 ▸ NIC 에서 인터페이스·본딩이 Python 때와 같은지,
   containerd·kubelet 설정 파일을 바꿨을 때 **보고 주기를 기다리지 않고 바로**(수 초 안) 변경 이력이 생기는지 확인합니다.
6. **TLS 확인** — 사설 CA 를 쓰면 `PEP_CA_FILE` 로 CA 를 마운트하고, 검증을 끄는 설정(`PEP_TLS_VERIFY=false`)을 쓰는 클러스터는 canary 에서 먼저 동작하는지 봅니다.
7. **확대** — 이상이 없으면 라벨 노드를 늘립니다(예: 10% → 50% → 100%, 단계마다 PEP 화면 확인). 전부 옮겼으면 Python DaemonSet 을 지우고
   PEP 설치 화면의 에이전트 이미지를 node-agent 로 고정합니다.
8. **되돌리기** — `kubectl label node <노드> pep.io/node-agent-` 로 라벨을 지우면 해당 노드는 Python DaemonSet 이 다시 맡습니다.

## 영구 설정 값 계산 규칙

systemd-sysctl 과 같습니다. `sysctl.d` 디렉터리(`/etc` > `/run` > `/usr/local/lib` > `/usr/lib` > `/lib`)의 `*.conf` 를
파일 이름 순으로 적용하고(같은 이름이면 앞 디렉터리 파일만), 마지막에 `/etc/sysctl.conf` 를 적용합니다. 뒤에 적힌 값이 이깁니다.
`net.ipv4.conf.*.rp_filter` 같은 glob 키도 감시 대상에 맞춰 적용합니다. 어느 파일에도 없는 파라미터는 커널 기본값으로 보고
불일치 판정을 하지 않습니다.
