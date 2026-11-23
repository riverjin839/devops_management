# NIC 적용 (2차) — 설계

> 상태: **설계(미구현)** · 작성 2026-11-23 · 선행: 1차 NIC 상태(v1.102.0, `services/nic_watch/`, 서비스 구성 ▸ NIC)
>
> 1차는 **보는 것**(본딩/LACP·링크·MTU·ring buffer·드롭·offload 판정)까지였다. 2차는 1차가 찾은 문제 중
> **운영 중 끊김 없이(또는 통제된 짧은 끊김으로) 바꿀 수 있는 값**을 PEP 에서 기대 값으로 정하고, 노드에 적용하고,
> 재부팅 뒤에도 유지되게 한다.

---

## 1. 목표와 범위

### 1.1 적용 대상 (2차 범위)

| 구분 | 키 | 바꾸는 방법(런타임) | 끊김 | 비고 |
|---|---|---|---|---|
| Ring buffer | `ring.rx`, `ring.tx` | `ethtool -G <if> rx N tx N` | **있음** — 대부분 드라이버(mlx5·i40e·ixgbe·bnxt)가 큐를 다시 만든다(수백 ms~수 초) | 값에 `max` 허용(인터페이스별 최대값) |
| 채널(큐) 수 | `channels.combined` | `ethtool -L <if> combined N` | **있음** — 큐 재생성 | `max` 허용. 드롭 원인이 큐 1개 병목일 때 |
| Offload | `offload.rx-lro`, `offload.rx-gro`, `offload.tx-tcp-segmentation`, `offload.rx-checksum`, `offload.tx-checksum-ip-generic`, `offload.tx-udp_tnl-segmentation` | `ethtool -K <if> <feature> on|off` | 드라이버에 따라 짧게 있음(LRO·checksum 은 일부 드라이버가 재설정) | `[fixed]` 기능은 건너뜀 |
| 본딩 해시 정책 | `bond.xmit_hash_policy` | `/sys/class/net/<bond>/bonding/xmit_hash_policy` | 없음(송신 해시만 바뀜) | 802.3ad·balance-xor·tlb·alb 모드만 |
| LACP rate | `bond.lacp_rate` | `…/bonding/lacp_rate` | 없음(LACPDU 주기만) | 802.3ad 만. **커널에 따라 본딩이 up 인 동안 변경을 거부**한다 → 런타임 쓰기를 시도하고, 거부되면 영구 기록만 하고 결과에 "재부팅(본딩 재기동) 후 반영"으로 남긴다(본딩을 내리지 않는다) |
| 링크 감시 | `bond.miimon` | `…/bonding/miimon` | 없음 | |

### 1.2 범위 밖 (3차 후보 · 이유)

- **MTU 변경** — 노드·스위치·overlay(CILIUM) 가 함께 맞아야 하고, 한쪽만 바뀌면 큰 패킷이 조용히 버려진다. 클러스터 단위 계획·스위치 확인이 필요해 별도 설계.
- **본딩 모드 변경·하위 인터페이스 추가/제거** — 본딩을 내려야 해서 노드 네트워크가 끊긴다.
- IRQ affinity·RSS indirection·interrupt coalescing·SR-IOV VF — 튜닝 효과가 워크로드별이라 1차 판정 근거부터 쌓은 뒤.
- 스위치 쪽 설정(LAG·LACP mode) — PEP 가 스위치에 접속하지 않는다. 판정 힌트로만 안내한다.

### 1.3 원칙

1. **새 장치를 만들지 않는다.** 서비스 구성의 설정 버전·노드 그룹·비교·되돌리기·드리프트·변경 감지·적용 실행(SSE)·적용 이력을 그대로 쓴다. NIC 는 **9번째 서비스 `nic`** 가 된다.
2. **에이전트는 읽기 전용으로 남긴다.** 에이전트는 비 root·capability 없음이라 바꿀 수 없고, 바꾸게 만들지도 않는다. 적용은 다른 서비스처럼 **요청 시 SSH(자격증명 미저장)** 로 한다.
3. **끊김이 있는 변경은 이중화를 깨지 않는 순서로만.** 본딩 하위 인터페이스는 한 번에 하나씩, 앞 인터페이스가 다시 LACP 집계에 들어온 걸 확인한 뒤 다음으로 간다.
4. **연결을 잃어도 원복된다.** 변경 전에 노드에 자동 원복 타이머를 걸고, PEP 가 다시 접속해 확인해야 타이머를 끈다(데드맨 스위치).
5. **UI-First.** 대상 인터페이스·영구 기록 방식·대기 시간·경로는 전부 적용 설정 화면 값이다. 실행될 명령은 계획 단계에서 전부 보여준다.

---

## 2. 화면

### 2.1 NIC 서비스 탭 구성

레일의 NIC 는 구분선 아래 읽기 전용 항목(`extras`)에서 **서비스 목록의 일반 항목**으로 옮긴다.

| 탭 | 내용 |
|---|---|
| **설정** | 다른 서비스와 같은 설정 표 — 키 · VALUE(편집) · 반영 방식 · 상태. 노드 그룹 재정의(GPU 노드만 ring 을 크게 등), 버전 선택·비교·되돌리기, 하단 저장 바 |
| **상태** | 1차 `NicStatusView` 그대로(경고 + 노드 × 인터페이스 표) |
| **요약** | 다른 서비스와 같은 `ServiceSummary` — 기준 버전과 다른 노드 값, 열린 알람, 최근 변경, 최근 적용 |

- 헤더 툴바: 버전 · 비교 · **적용…** · 적용 설정(NIC 구역) · 현재 값 수집 버튼 없음(에이전트가 1분마다 보고하므로).
- VALUE 의 노드 현재 값 줄: 대상 인터페이스 값이 노드 안에서 모두 같으면 그 값, 다르면 "인터페이스 N가지 값"(펼치면 `ens1f0 1024 · ens1f1 4096`). ring·channels 는 `현재/최대` 로 보여준다.
- 값 입력: ring·channels 는 숫자 또는 `max`(선택지), offload 는 on/off, 본딩은 고정 선택지. **비워 두면 "관리 안 함"** — 그 키는 적용하지 않고 드리프트도 보지 않는다(기본은 전부 비움, V1 은 "현재 값으로 만들기"로 시작).

### 2.2 적용 대화상자 (`ApplyDialog` NIC 구역)

다른 서비스 적용 대화상자와 같은 틀(변경 / 대상 / 방식 / 영향 / 명령 / SSH)에 NIC 전용 항목만 더한다.

- **변경**: 노드 × 인터페이스별 `현재 → 목표`(계획 API 가 노드 현재 값과 최대값으로 계산). `max` 는 실제 숫자로 풀어 보여준다. 이미 같은 값은 "변경 없음"으로 접는다.
- **대상**: 범위 노드 전체 / 선택 노드. 노드마다 대상 인터페이스와 **이중화 여부**(본딩 하위 2개 이상 = 이중화, 단일 업링크 = 위험) 표시.
- **방식**:
  - 롤링 N대씩(기본 1) · 노드 사이 대기 · 실패 시 중단(기본 켬)
  - 하위 인터페이스 사이 대기(기본 10초) · 재집계 대기 제한(기본 60초)
  - **단일 업링크 노드 허용**(기본 끔 — 끄면 그 노드는 끊김 있는 키를 건너뛰고 끊김 없는 키만 적용)
  - 단일 업링크 노드 cordon·drain(기본 켬, 위 항목을 켰을 때만)
  - **자동 원복 타이머**(기본 120초)
  - **영구 기록**(기본 켬) · 기록 방식 표시(노드별 자동 판별 결과 — §4)
- **명령**: 접이식 "실행될 명령 N개" — 노드 하나 기준 전체 명령(원복 스크립트 내용 포함). 비밀값 없음.
- 실행 → §12.6.1 로그 중심 실행 화면(좌 제어·진행 / 우 상단 `RunLogPanel` SSE, `useLogPref('service-config-apply')` 로그 보기 토글 / 우 하단 노드별 결과). 노드 결과는 인터페이스 단위로 펼친다.

---

## 3. 데이터 모델 — 새 테이블 없음

| 무엇 | 어디 | 비고 |
|---|---|---|
| 관리 대상 키 | `service_config_items`(service=`nic`) — `catalog_seed` 에 11개 키 추가 | `value_type`: `int_or_max`(새 형식, ring·channels) · `bool`(offload, on/off) · `enum`(본딩) |
| 의존 규칙 | `service_config_rules` | §6 |
| 기대 값(버전) | `service_config_versions`(service=`nic`) · 노드 그룹 `service_config_groups` | 기존 그대로 |
| 노드 현재 값 | `cluster_config_snapshots` component **`nic:{node}`** | NIC 보고 수신(`nic_watch.service.ingest`)이 대상 인터페이스 값을 평탄화해 `watch.store_and_watch` 로 저장 — 해시가 같으면 저장 안 함 |
| 변경 이력·알람 | `service_config_changes` + `ServiceConfigChanged`/`ServiceConfigDrift` | `store_and_watch`·`sync_drift` 가 그대로 처리. 드롭 카운터 같은 상태값은 스냅샷에 넣지 않는다(설정 키만) |
| 적용 실행 | `service_config_apply_runs`(service=`nic`) | `node_results[*].interfaces[]` 에 인터페이스별 전→후·건너뜀 사유 |
| NIC 적용 설정 | AppSetting `service_config.settings` 의 `nic_*` 키 | §7 |

### 3.1 스냅샷 평탄화 (`nic:{node}`)

```json
{
  "source": "agent", "node": "worker-2",
  "flat": {
    "ring.rx": "1024", "ring.tx": "1024", "channels.combined": "8",
    "offload.rx-lro": "off", "offload.rx-gro": "on",
    "bond.xmit_hash_policy": "layer2", "bond.lacp_rate": "slow", "bond.miimon": "100"
  },
  "per_iface": {"ens1f0": {"ring.rx": "1024", "ring.rx.max": "8192", "...": "..."}, "ens1f1": {"...": "..."}},
  "targets": ["bond0", "ens1f0", "ens1f1"]
}
```

- 키별 값: 대상 인터페이스 값이 모두 같으면 그 값, 다르면 `"mixed"`(드리프트로 본다). 상세는 `per_iface`.
- **`max` 비교 규칙**: 기대 값이 `max` 면 각 인터페이스의 현재 값 = 그 인터페이스 최대값일 때 일치. `status.py` 드리프트 비교에 서비스별 비교 함수(`nic` 만 등록)를 둔다.
- 에이전트 1차 보고에 채널 수가 없다 → 에이전트 **1.3.0** 에서 `ETHTOOL_GCHANNELS` 를 추가한다(조회 ioctl, 권한 불필요).

### 3.2 대상 인터페이스

적용 설정 `nic_target`:

| 값 | 뜻 |
|---|---|
| `bond_members`(기본) | 본딩 하위 물리 인터페이스(ring·channels·offload) + 그 본딩(본딩 키) |
| `physical_up` | 링크가 올라와 있는 물리 인터페이스 전부 + 본딩 |
| `glob` | `nic_target_glob`(쉼표 glob)에 맞는 인터페이스 |

관리용 1G NIC(`eno1` 등)가 섞여 데이터 NIC 와 다른 값을 가져야 하면 `bond_members` 로 두면 자연히 빠진다. 노드 그룹 재정의로 노드별 값을 다르게 할 수 있다.

---

## 4. 영구 기록

런타임 변경(`ethtool`·sysfs)은 재부팅하면 사라진다. **노드의 네트워크 관리 방식에 맞춰 그 설정에 기록**한다. 노드마다 자동 판별하고 적용 설정에서 강제할 수 있다(`nic_persist`: `auto|networkmanager|networkd|ifcfg|udev|none`).

| 방식 | 판별(auto) | ring·channels·offload | 본딩 키 | 적용 중 링크 영향 |
|---|---|---|---|---|
| **NetworkManager** | `nmcli -t -f GENERAL.STATE device show <if>` 가 `connected`(관리 중) | `nmcli connection modify <conn> ethtool.ring-rx N ethtool.ring-tx N ethtool.channels-combined N ethtool.feature-lro off …` — 속성 지원은 NM 버전마다 다르므로 실행 전에 `nmcli -g <속성> connection show <conn>` 로 존재를 확인하고, 없는 속성은 udev 폴백으로 기록 | `bond.options` 에서 해당 키만 교체(`nmcli -g bond.options` 로 읽어 합침) | **`connection up`·`device reapply` 를 하지 않는다**(재활성화로 링크가 내려갈 수 있음). 런타임은 ethtool·sysfs 로 이미 바꿨으므로 파일만 맞춘다 |
| **systemd-networkd** | `networkctl status <if>` 가 `configured` | 그 인터페이스에 실제 쓰인 `.link` 파일(`udevadm info` 의 `ID_NET_LINK_FILE`)의 **drop-in** `<파일>.d/99-pep-nic.conf`(`RxBufferSize=`·`TxBufferSize=`·`CombinedChannels=`·`LargeReceiveOffload=` …) | 본딩 `.netdev` 의 drop-in `[Bond]` `TransmitHashPolicy=`·`LACPTransmitRate=`·`MIIMonitorSec=` | 없음(다음 부팅·장치 추가 때 반영) |
| **ifcfg**(network-scripts) | `/etc/sysconfig/network-scripts/ifcfg-<if>` 존재 + NM 미관리 | `ETHTOOL_OPTS="-G ${DEVICE} rx N tx N; -L ${DEVICE} combined N; -K ${DEVICE} lro off"` 한 줄을 PEP 가 관리 | 본딩 ifcfg 의 `BONDING_OPTS` 에서 해당 키만 교체 | 없음 |
| **udev**(폴백) | 위 셋이 모두 아님 | `/etc/udev/rules.d/99-pep-nic.rules`: `ACTION=="add", SUBSYSTEM=="net", NAME=="<if>", RUN+="<ethtool> -G $name rx N tx N"` | **기록 불가** → 런타임만, 결과에 "본딩 키 영구 기록 안 됨(네트워크 관리 방식 미지원)" | 없음 |
| `none` | — | 런타임만 | 런타임만 | — |

- networkd `.link` 는 **처음 일치하는 파일 하나만** 쓰이므로 새 `.link` 파일을 만들지 않고, 실제 쓰인 파일의 drop-in 에 쓴다.
- 모든 파일 편집은 **백업(`<file>.pep-bak-v<기준버전>`, 디렉터리는 적용 설정) → 키 단위 줄 편집 → 다시 읽어 확인**. PEP 가 쓴 줄은 주석 `# managed by PEP (service-config nic V<n>)` 로 표시한다. 기존 줄 전체를 통째로 바꾸지 않는다(LINUX 의 PEP 전용 파일과 달리 운영자 설정과 같은 파일을 공유하므로).
- 순수 편집 함수(입력 텍스트 → 출력 텍스트)는 `apply_nodes.py` 의 containerd·kubelet 편집처럼 분리해 단위 테스트한다.

---

## 5. 적용 흐름 (노드 하나)

```
SSH 접속
 ├─ 0. 사전 확인 ─ ethtool 경로·버전, 대상 인터페이스·본딩 구조, 현재 값·최대값·[fixed], 영구 기록 방식 판별
 │                  └─ 계획과 다르면(인터페이스가 사라짐 등) 그 노드 실패·건너뜀
 ├─ 1. 원복 준비 ─ 현재 값으로 원복 스크립트 작성(/run/pep/nic-rollback.sh)
 │                  systemd-run --unit=pep-nic-rollback --on-active=<타이머>s /bin/sh /run/pep/nic-rollback.sh
 ├─ 2. 끊김 없는 키 ─ 본딩 sysfs(xmit_hash_policy·lacp_rate·miimon) → 다시 읽어 확인
 ├─ 3. 끊김 있는 키 ─ 하위 인터페이스마다 한 개씩:
 │      ethtool -G / -L / -K  →  링크 up 대기  →  본딩 MII up + 활성 Aggregator 재합류 대기(제한 시간)
 │      →  하위 인터페이스 사이 대기  →  다음
 │      (단일 업링크: 허용했을 때만, cordon·drain → 변경 → 링크 대기 → SSH 재접속 확인)
 ├─ 4. 확인 ─ SSH 재접속(새 세션) 성공 → systemctl stop pep-nic-rollback.timer  (데드맨 해제)
 │            ethtool -g/-l/-k · sysfs 다시 읽기 = 목표값?  K8S API 노드 Ready?
 ├─ 5. 영구 기록 ─ §4 방식별 백업 → 편집 → 확인(영구 기록 켬일 때)
 └─ 6. 결과 ─ 인터페이스별 전→후, 건너뜀(미지원·fixed·값 같음), 영구 기록 결과. 단일 업링크였으면 uncordon
```

- **실패 시**: 그 노드의 런타임 값을 원복 스크립트로 되돌리고(접속돼 있으면 즉시, 끊겼으면 타이머가), 영구 기록은 백업으로 복원, `실패 시 중단`이면 나머지 노드를 건너뛴다. 원복 결과도 로그·노드 결과에 남긴다.
- **미지원은 실패가 아니다**: `ethtool -G` 가 `Operation not supported`·`[fixed]` 기능 → 그 키만 "건너뜀(드라이버 미지원)".
- **최대값 초과**: 계획 단계에서 막는다(필수 규칙). 노드 그룹마다 NIC 모델이 다를 수 있으므로 계획 API 가 노드별 최대값으로 검사.
- **재집계 확인**: `/proc/net/bonding/<bond>` 에서 그 하위의 `MII Status: up` + `Aggregator ID` = 활성 Aggregator ID. 1차 파서(`node_param_agent/nic.parse_proc_bonding`)를 백엔드에서도 재사용(표준 라이브러리 함수라 그대로 import 가능).
- 실행 경로는 다른 서비스와 같은 **요청 안 SSE**(`apply.py` 패턴) — 자격증명이 Celery 브로커·DB 에 남지 않게. 클라이언트가 끊겨도 끝까지 돌고 노드마다 `ServiceConfigApplyRun` 에 커밋. 중지 요청은 노드 사이·하위 인터페이스 사이에서 확인.
- 범위 전체 성공이면 버전 `applied`, 노드 결과로 `nic:{node}` 스냅샷을 즉시 갱신(source `apply` — 변경 알람 없음). 다음 에이전트 보고가 같은 값을 확인한다.

### 5.1 명령 예 (노드 worker-2, 본딩 이중화, NetworkManager)

```bash
# 0. 사전 확인
command -v ethtool && ethtool --version
cat /proc/net/bonding/bond0
ethtool -g ens1f0; ethtool -l ens1f0; ethtool -k ens1f0
nmcli -t -f GENERAL.STATE,GENERAL.CONNECTION device show ens1f0
# 1. 원복 준비
install -D -m 700 /dev/stdin /run/pep/nic-rollback.sh <<'EOF'   # 현재 값으로 되돌리는 명령
systemd-run --unit=pep-nic-rollback --on-active=120s /bin/sh /run/pep/nic-rollback.sh
# 2. 끊김 없는 키
echo layer3+4 > /sys/class/net/bond0/bonding/xmit_hash_policy
echo fast > /sys/class/net/bond0/bonding/lacp_rate   # 거부되면 영구 기록만(재기동 후 반영)
# 3. 하위 인터페이스 하나씩
ethtool -G ens1f0 rx 8192 tx 8192        # → MII up · Aggregator 재합류 대기
ethtool -G ens1f1 rx 8192 tx 8192        # → 대기
# 4. 확인(새 SSH 세션) + 데드맨 해제
systemctl stop pep-nic-rollback.timer
# 5. 영구 기록
nmcli connection modify bond0-slave-ens1f0 ethtool.ring-rx 8192 ethtool.ring-tx 8192
nmcli connection modify bond0 bond.options "mode=802.3ad,miimon=100,lacp_rate=fast,xmit_hash_policy=layer3+4"
```

이 목록이 계획 API `commands` 로 화면 "실행될 명령"에 그대로 나간다(UI-First 4: 가시화가 편집보다 먼저).

---

## 6. 의존 규칙 (`service_config_rules`, 기존 rule_type 집합 안에서)

| 규칙 | 종류 | 내용 |
|---|---|---|
| `nic.ring_le_max` | require(계획 단계 검사) | ring·channels 가 노드 인터페이스 최대값 이하. 값 `max` 는 항상 통과 |
| `nic.lro_off_forwarding` | recommend | `offload.rx-lro` = off 권장 — K8S 노드는 패킷을 포워딩한다 |
| `nic.hash_l34` | recommend | `bond.xmit_hash_policy` = layer3+4 권장(1차 판정 기준과 같은 설정값을 읽음) |
| `nic.lacp_fast` | recommend | `bond.lacp_rate` = fast 권장 |
| `nic.queue_reset_impact` | impact | ring·channels·offload 변경 — "하위 인터페이스마다 큐 재설정, 본딩이면 끊김 없음 / 단일 업링크면 짧은 끊김" |
| `nic.tunnel_offload_cilium` | impact | `offload.tx-udp_tnl-segmentation` 을 끄면 CILIUM VXLAN/Geneve 송신 성능이 떨어진다 |

---

## 7. 적용 설정 (AppSetting `service_config.settings`, `ApplySettingsDialog` NIC 구역)

| 키 | 기본 | 설명 |
|---|---|---|
| `nic_target` / `nic_target_glob` | `bond_members` / `""` | §3.2 |
| `nic_persist` | `auto` | §4 |
| `nic_ethtool` | `ethtool` | 노드의 ethtool 경로(폐쇄망 이미지에서 다를 때) |
| `nic_rollback_timer_sec` | 120 | 데드맨 원복 타이머(30~900) |
| `nic_member_wait_sec` | 10 | 하위 인터페이스 사이 대기 |
| `nic_rejoin_timeout_sec` | 60 | 링크·LACP 재합류 대기 제한 |
| `nic_backup_dir` | `/etc/pep-backup/nic` | 영구 설정 파일 백업 위치 |
| `nic_udev_rule` | `/etc/udev/rules.d/99-pep-nic.rules` | udev 폴백 파일 |
| `nic_allow_single_uplink` | false | 적용 대화상자 기본값(실행마다 바꿀 수 있음) |

1차 `nic_watch.settings`(수집 대상·판정 기준)는 그대로 둔다 — 판정 기준(기대 해시 정책 등)과 적용 버전 값이 어긋날 수 있으므로, **버전이 있는 클러스터는 1차 판정이 버전 값을 기대 값으로 쓰게** 바꾼다(버전이 없으면 지금처럼 설정 값).

---

## 8. API

기존 서비스 구성 API 를 `service=nic` 로 그대로 쓴다 — 새 라우터 없음.

- `GET /service-config/services` 에 `nic` 추가(`collect_kinds: []`, `group_supported: true`).
- `GET|POST /service-config/clusters/{id}/nic/…` — 화면·import(V1)·versions·compare·revert·groups.
- `GET …/nic/apply/plan?version=&group_id=` — 노드별 인터페이스 목록·현재/최대·이중화 여부·영구 기록 방식(마지막 에이전트 보고 + 판별은 실행 때) · `commands`.
- `POST …/nic/apply/stream`(operator, SSE) — 옵션 `{batch_size, batch_interval_sec, stop_on_failure, member_wait_sec, rejoin_timeout_sec, allow_single_uplink, drain_single_uplink, rollback_timer_sec, persist}` + SSH.
- 감사: `service_config.apply.start|finish|stop`(기존, service 필드로 구분).

---

## 9. 구현 단계

| 단계 | 내용 | 노드 변경 |
|---|---|---|
| **2-a 버전·드리프트** | NIC 를 서비스 목록으로 승격(설정/상태/요약 탭), `catalog_seed` 키·규칙, `int_or_max` 형식, `nic:{node}` 스냅샷 + 변경 감지·드리프트 알람, `max` 비교, 에이전트 1.3.0(채널 수), 1차 판정의 기대 값 = 버전 값 | 없음 |
| **2-b 런타임 적용** | `apply_nic.py`(계획·명령·실행), 데드맨 원복, 하위 인터페이스 순차·재집계 확인, 단일 업링크 cordon·drain, SSE·이력·노드/인터페이스 결과 | **있음** |
| **2-c 영구 기록** | NM·networkd·ifcfg·udev 판별과 순수 편집 함수 + 백업·복원 | 있음 |

각 단계가 따로 릴리스 가능하다. 2-a 만으로도 "기대 값 대비 어긋난 노드"를 알람으로 받는다.

---

## 10. 테스트

- **순수 함수 단위 테스트**: 계획 계산(현재/최대/`max`/fixed/미지원/값 같음), 명령 렌더링(방식별), 영구 기록 편집(NM `bond.options` 병합, networkd drop-in, ifcfg `ETHTOOL_OPTS`·`BONDING_OPTS` 줄 교체, udev 규칙), 원복 스크립트 생성, `/proc/net/bonding` 재집계 판정.
- **실행 흐름**: 기존 적용 테스트처럼 가짜 SSH 실행기로 노드 성공·드라이버 미지원·재집계 실패 → 원복·SSH 끊김 → 타이머 원복·중지 요청·실패 시 중단을 시뮬레이션.
- **실장비 검증(필수, 릴리스 전)**: 본딩(802.3ad) + mlx5 또는 i40e 노드 1대에서 ring·offload 변경 중 본딩이 끊기지 않는지(연속 ping·`/proc/net/bonding` 관찰), 재부팅 후 영구 값 유지. 가상 환경(virtio·veth·dummy)은 ring 변경·LACP 를 재현하지 못하므로 대체 불가.

---

## 11. 위험과 대응

| 위험 | 대응 |
|---|---|
| ring/channels 변경 중 하위 인터페이스가 안 돌아옴 | 하위 하나씩 + 재집계 확인 + 실패 시 그 노드 원복·중단 |
| 단일 업링크 노드에서 SSH·kubelet 이 끊김 | 기본 건너뜀, 허용 시 cordon·drain + 데드맨 타이머 원복 |
| NM 재활성화로 링크 다운 | `connection up`/`reapply` 금지 — 런타임은 ethtool, NM 은 파일만 |
| networkd `.link` 우선순위로 설정이 무시됨 | 실제 쓰인 `.link` 의 drop-in 에만 기록, 다음 보고에서 값 확인 |
| 운영자 수동 설정과 충돌 | 키 단위 줄 편집 + 백업 + PEP 관리 주석, 변경 감지가 PEP 밖 변경을 알람 |
| NIC 모델이 섞인 클러스터 | `max` 값 + 노드 그룹 재정의 + 계획 단계 최대값 검사 |
| 드라이버 버그(특정 펌웨어에서 ring 변경 시 hang) | 1차 상태 화면의 드라이버·펌웨어로 노드 그룹을 나눠 단계적으로 적용(롤링 1대 기본) |

---

## 12. 결정이 필요한 것

1. 범위 확인: MTU·본딩 모드 변경을 2차에서 빼는 것.
2. 노드 네트워크 관리 방식: RHEL 계열 NetworkManager / Ubuntu networkd(netplan) / 구형 ifcfg 중 무엇이 주력인지 — 2-c 구현·실장비 검증 순서를 정한다.
3. 단일 업링크(본딩 없는) 노드가 운영에 있는지 — 없다면 단일 업링크 경로를 만들지 않고 "끊김 있는 키 건너뜀"만 둔다.
4. 채널 수(`ethtool -L`)를 2차에 넣을지 — 넣으면 에이전트 1.3.0 재배포가 필요하다.
