# 노드 OS 파라미터 에이전트 (node-param-agent)

대상 클러스터의 **노드마다 1개** 떠서 감시 대상 커널 파라미터(sysctl)의 값을 PEP 로 보고하는 DaemonSet 입니다.
PEP 는 값이 바뀌거나, 기준값을 벗어나거나, 현재 값이 영구 설정(`/etc/sysctl.d` 등)과 다르면 **알람 인박스**로 알립니다.
화면: K8s 허브 ▸ 점검 ▸ **OS 파라미터 감시** (`/k8s/<클러스터>/os-param-watch`).

- 이미지는 PEP backend 이미지를 그대로 씁니다(`python -m app.node_param_agent`, 표준 라이브러리만 사용).
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
kubectl -n k8s-monitor-agent exec ds/node-param-agent -- \
  python -m app.node_param_agent --dry-run --param net.core.somaxconn --param vm.swappiness
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

## 영구 설정 값 계산 규칙

systemd-sysctl 과 같습니다. `sysctl.d` 디렉터리(`/etc` > `/run` > `/usr/local/lib` > `/usr/lib` > `/lib`)의 `*.conf` 를
파일 이름 순으로 적용하고(같은 이름이면 앞 디렉터리 파일만), 마지막에 `/etc/sysctl.conf` 를 적용합니다. 뒤에 적힌 값이 이깁니다.
`net.ipv4.conf.*.rp_filter` 같은 glob 키도 감시 대상에 맞춰 적용합니다. 어느 파일에도 없는 파라미터는 커널 기본값으로 보고
불일치 판정을 하지 않습니다.
