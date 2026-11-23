# NIC 적용 (2차) — 설계

> 상태: **2-a 구현됨**(설정 버전·드리프트·SSH 수집) · **2-b 미구현**(적용) · 개정 2026-11-23 · 선행: 1차 NIC 상태(v1.102.0, `services/nic_watch/`, 서비스 구성 ▸ NIC)
>
> 1차는 **보는 것**(본딩/LACP·링크·MTU·ring buffer·드롭·offload 판정)까지였다. 2차는 1차가 찾은 문제 중
> **운영 중 끊김 없이 바꿀 수 있는 값**을 PEP 에서 기대 값으로 정하고, 노드에 적용하고, 재부팅 뒤에도 유지되게 한다.

---

## 0. 결정 사항 (2026-11-23)

| 항목 | 결정 | 설계에 주는 영향 |
|---|---|---|
| MTU·본딩 모드 변경 | **2차에서 제외** | 끊김 없는 키만 다룬다 |
| 노드 네트워크 관리 방식 | **NetworkManager 주력** | 영구 기록은 NM 만 구현. NM 이 관리하지 않는 인터페이스는 런타임만 적용 + 경고 |
| 단일 업링크 노드 | **없음** | cordon·drain·단일 업링크 허용 경로를 만들지 않는다. 이중화가 확인되지 않는 인터페이스는 끊김 있는 키를 건너뛴다(안전장치) |
| 채널(큐) 수 | **포함** | `ethtool -l/-L`. SSH 수집·적용에서 처리하므로 에이전트 변경 불필요 |
| 수집 경로 | **SSH 기본, 에이전트는 선택** | 에이전트 없이도 화면·적용이 동작한다. 에이전트가 있으면 드롭 증가·플래핑·변경 알람이 추가로 켜진다 |
| 규모 | 노드 500대 클러스터 있음 | SSH 수집·적용 모두 동시 접속 상한, 화면은 서버 페이지(1차 개선에서 반영 완료) |

---

## 1. 범위

### 1.1 적용하는 키

| 구분 | 키 | 런타임 변경 | 끊김 |
|---|---|---|---|
| Ring buffer | `ring.rx`, `ring.tx` | `ethtool -G <if> rx N tx N` | 하위 인터페이스 하나가 잠깐(큐 재생성) — 본딩은 유지 |
| 채널 수 | `channels.combined` | `ethtool -L <if> combined N` | 위와 같음 |
| Offload | `offload.rx-lro` · `offload.rx-gro` · `offload.tx-tcp-segmentation` · `offload.rx-checksum` · `offload.tx-checksum-ip-generic` · `offload.tx-udp_tnl-segmentation` | `ethtool -K <if> <feature> on\|off` | 드라이버에 따라 짧게 — 하위 하나씩 |
| 본딩 해시 정책 | `bond.xmit_hash_policy` | `/sys/class/net/<bond>/bonding/xmit_hash_policy` | 없음 |
| LACP rate | `bond.lacp_rate` | `…/bonding/lacp_rate` | 없음. **커널에 따라 본딩이 up 인 동안 거부** → 영구 기록만 하고 "본딩 재기동(재부팅) 후 반영"으로 남긴다 |
| 링크 감시 | `bond.miimon` | `…/bonding/miimon` | 없음 |

- ring·channels 값은 숫자 또는 `max`(인터페이스별 최대값). 값을 비워 두면 **관리 안 함**(적용·드리프트 대상 아님).
- `[fixed]` offload 와 드라이버 미지원(`Operation not supported`)은 실패가 아니라 **건너뜀**.

### 1.2 범위 밖

MTU, 본딩 모드·하위 인터페이스 구성, IRQ affinity·RSS·coalescing·SR-IOV, 스위치 쪽 설정, NM 이 아닌 영구 기록(networkd·ifcfg·udev).

---

## 2. 수집 — SSH 기본, 에이전트 선택

| | SSH 수집(기본) | 에이전트(선택) |
|---|---|---|
| 설치 | 없음 | 클러스터마다 노드 파라미터 에이전트 DaemonSet |
| 언제 | 사람이 **현재 값 수집** 을 누를 때(자격증명 미저장이라 자동 주기 없음) | 1분마다 |
| 설정 값(ring·channels·offload·본딩) | 됨 | 됨(채널 수는 에이전트에 아직 없음 — 필요해지면 1.3.0) |
| 드롭·CRC 증가·플래핑 | 두 번 수집한 사이의 증가량만 | 계속 |
| PEP 밖 변경 알람 | 다음 수집 때 | 바로 |

### 2.1 SSH 「현재 값 수집」

- 버튼 위치: NIC 서비스 헤더(다른 서비스의 SSH 수집 버튼과 같은 자리). 클릭 → 수집 대화상자: 대상(범위 노드 전체 / 노드 그룹 / 노드 선택) · **동시 접속 수(기본 20, 1~50)** · SSH 사용자·포트·비밀번호|키·sudo(저장 안 함).
- **실행 로그 필수**: 화면 안 `RunLogPanel`(SSE 실시간) + 로그 보기 토글 `useLogPref('service-config-collect')` — 다른 수집과 같은 토글을 쓴다. 노드마다 `연결 → 읽기 → 저장` 단계와 실패 사유(인증·시간 초과·ethtool 없음)를 남긴다.
- 노드에서 실행하는 것은 **조회 명령만**: `cat /sys/class/net/*/{operstate,carrier,speed,duplex,mtu,carrier_changes,statistics/*}`, `readlink …/master`·`lower_*`, `cat /proc/net/bonding/*`, `cat /sys/class/net/<bond>/bonding/*`, 대상 인터페이스별 `ethtool -i/-g/-l/-k/-S`. 한 번의 SSH 세션에서 셸 스크립트 하나로 구분자를 붙여 출력하고, **파싱은 백엔드**가 한다(노드에 python 불필요).
- 결과는 에이전트와 **같은 `NodeNicState` 행**(source `ssh`)으로 저장한다 → 1차 상태 화면·판정이 그대로 동작한다. 에이전트가 보고 중인 노드는 에이전트 값이 우선(더 최신)이다.
- 500대 기준: 동시 20 × 노드당 1~3초 → 약 1분. 수집 중지 가능. 실행은 다른 SSH 수집처럼 **요청 안 SSE**(자격증명이 Celery·DB 에 남지 않게).
- 스크립트 파싱기는 에이전트 파서(`node_param_agent/nic.py` — 표준 라이브러리)와 같은 결과 형태를 만들고, `/proc/net/bonding` 해석은 그 함수를 그대로 재사용한다.

### 2.2 에이전트가 있으면

1차 그대로 1분마다 보고. 화면 상단에 수집 출처(`에이전트 · 1분 전` / `SSH 수집 · 3시간 전`)를 노드 기준으로 요약해 보여주고, 에이전트가 없는 클러스터에는 "에이전트를 설치하면 드롭·플래핑 감시가 켜집니다" 한 줄만 안내한다.

---

## 3. 화면

NIC 는 레일 구분선 아래 읽기 전용 항목에서 **서비스 목록의 일반 항목**(9번째 서비스 `nic`)으로 옮긴다.

| 탭 | 내용 |
|---|---|
| **설정** | 다른 서비스와 같은 설정 표(키 · VALUE · 반영 방식 · 상태), 노드 그룹 재정의, 버전 선택·비교·되돌리기, 하단 저장 바 |
| **상태** | 1차 `NicStatusView`(경고 + 노드 × 인터페이스 표 — 서버 필터·페이지) |
| **요약** | `ServiceSummary` — 기준 버전과 다른 노드 값, 열린 알람, 최근 변경, 최근 적용 |

- 툴바: 버전 · 비교 · **적용…** · 적용 설정(NIC 구역만) · **현재 값 수집(SSH)**.
- VALUE 아래 노드 현재 값 줄: 대상 인터페이스 값이 노드 안에서 모두 같으면 그 값, 다르면 "인터페이스 N가지 값". ring·channels 는 `현재/최대`.
- 500노드에서 노드별 값 펼침은 "값별 노드 수"로 묶고 노드 이름은 앞 20개 + "외 N대"(설정 표 공통 동작과 같게).

### 3.1 적용 대화상자 (`ApplyDialog` NIC 구역)

- **변경**: 노드 × 인터페이스별 `현재 → 목표`(`max` 는 실제 숫자로). 노드가 많으면 "변경 있는 노드 N대 · 인터페이스 M개" 요약 + 펼침.
- **대상**: 범위 노드 전체 / 선택 노드.
- **방식**: 동시 노드 수(기본 1, 최대 20) · 노드 사이 대기 · 실패 시 중단(기본 켬) · 하위 인터페이스 사이 대기(10초) · 재집계 대기 제한(60초) · 자동 원복 타이머(120초) · 영구 기록(NM, 기본 켬).
- **명령**: 접이식 "실행될 명령 N개"(노드 하나 기준, 원복 스크립트 포함, 비밀값 없음).
- 실행 → §12.6.1 로그 중심 실행 화면(SSE, 로그 보기 토글 `useLogPref('service-config-apply')`, 노드별·인터페이스별 결과).

---

## 4. 데이터 — 새 테이블 없음

| 무엇 | 어디 |
|---|---|
| 관리 대상 키 | `service_config_items`(service=`nic`) 11개 — 새 값 형식 `int_or_max` |
| 의존 규칙 | `service_config_rules` (§7) |
| 기대 값 | `service_config_versions` · 노드 그룹 `service_config_groups` |
| 노드 상태(원본) | `node_nic_states` — 에이전트·SSH 수집 공용(1차 테이블). `source` 는 `interfaces` 옆 JSONB 메타로 둔다(컬럼 추가 없이 `errors` 와 같은 수준의 키) |
| 노드 현재 값(설정 키) | `cluster_config_snapshots` component **`nic:{node}`** — `nic_watch` 저장 직후 대상 인터페이스 값을 평탄화해 `watch.store_and_watch` 로 저장(해시 같으면 저장 안 함). 카운터는 넣지 않는다 |
| 변경 이력·알람 | `service_config_changes` · `ServiceConfigChanged`/`ServiceConfigDrift` — 기존 `store_and_watch`·`sync_drift` |
| 적용 실행 | `service_config_apply_runs`(service=`nic`), `node_results[*].interfaces[]` 에 인터페이스별 전→후·건너뜀 사유 |

- 평탄화: 키별 값이 대상 인터페이스에서 모두 같으면 그 값, 다르면 `mixed`(드리프트). 인터페이스별 원값은 스냅샷 `per_iface`.
- **`max` 비교**: 기대 값 `max` = 각 인터페이스 현재 값이 그 인터페이스 최대값과 같으면 일치. `status.py` 드리프트 비교에 서비스별 비교 함수(`nic` 만)를 둔다.
- 대상 인터페이스(NIC 설정 `nic_watch.settings` 의 `target_mode`·`target_glob` — 2-a 구현): `bond_members`(기본 — 본딩 하위 물리 인터페이스 + 그 본딩, 본딩이 없으면 링크가 올라온 물리 인터페이스) | `glob`. 관리용 1G NIC 는 본딩에 없으면 자연히 빠진다.
- 2-a 구현 메모: 평탄화·`max` 비교는 `services/nic_watch/snapshot.py`·`service_config/current.same_value`, SSH 수집은 `routers/versions.py` `collect-nic`(스크립트·파서 `services/nic_watch/ssh_collect.py`), 출처는 `node_nic_states.source`(ssh 는 보고 끊김 판정 제외). 채널 수는 에이전트 1.3.0 부터 보고하고, 보고하지 않는 출처는 이전 값을 유지한다.

---

## 5. 적용 흐름 (노드 하나, SSH)

```
0. 사전 확인  ethtool 경로, 대상 인터페이스·본딩 구조, 현재 값·최대값·[fixed], NM 관리 여부(nmcli device show)
              이중화 확인: 대상 물리 인터페이스가 활성 하위 2개 이상인 본딩에 속하는가
              → 아니면 그 인터페이스의 끊김 있는 키(ring·channels·offload) 건너뜀 "이중화 없음"
1. 원복 준비  현재 값으로 원복 스크립트 → /run/pep/nic-rollback.sh
              systemd-run --unit=pep-nic-rollback --on-active=<타이머>s /bin/sh /run/pep/nic-rollback.sh
2. 끊김 없는 키  본딩 sysfs(xmit_hash_policy·miimon·lacp_rate) → 다시 읽어 확인(lacp_rate 거부는 '재기동 후 반영')
3. 끊김 있는 키  하위 인터페이스마다 하나씩:
              ethtool -G / -L / -K → 링크 up → /proc/net/bonding 에서 MII up + 활성 Aggregator 재합류(제한 시간)
              → 하위 사이 대기 → 다음 하위
4. 확인        새 SSH 세션 접속 성공 → systemctl stop pep-nic-rollback.timer (데드맨 해제)
              ethtool·sysfs 다시 읽기 = 목표, K8S API 노드 Ready
5. 영구 기록   NM 관리 인터페이스만 nmcli connection modify (connection up·device reapply 하지 않음)
6. 결과        인터페이스별 전→후 / 건너뜀(미지원·fixed·값 같음·이중화 없음·NM 미관리 → 런타임만)
```

- **실패 시**: 그 노드 런타임 값을 원복 스크립트로 즉시 되돌리고(접속 불가면 타이머가), NM 은 이전 값으로 다시 modify, `실패 시 중단`이면 남은 노드 건너뜀. 원복 결과도 로그·결과에 남긴다.
- **데드맨 타이머는 남긴다**: 단일 업링크가 없어도 드라이버 문제로 두 하위가 같이 안 돌아오면 SSH 로 복구할 길이 없다. 비용은 명령 몇 줄.
- 실행 경로는 다른 서비스 적용과 같은 **요청 안 SSE**(`apply.py` 패턴). 노드마다 `ServiceConfigApplyRun` 커밋, 중지 요청은 노드·하위 인터페이스 사이에서 확인.
- **동시 노드 수**: 기본 1. 500대 클러스터에서 1대씩이면 노드당 약 30~60초(하위 2개 × 재집계 대기) → 4~8시간이므로, 노드 그룹 단위로 나눠 실행하거나 동시 수를 올린다(최대 20). 동시 실행에서도 **노드 안**의 하위 인터페이스는 항상 하나씩이다.
- 범위 전체 성공이면 버전 `applied`, 노드 결과로 `nic:{node}`·`node_nic_states` 를 즉시 갱신(source `apply` — 변경 알람 없음).

### 5.1 영구 기록 — NetworkManager

- 대상 connection: `nmcli -t -f GENERAL.CONNECTION device show <if>`.
- ring·channels·offload: `nmcli connection modify <conn> ethtool.ring-rx N ethtool.ring-tx N ethtool.channels-combined N ethtool.feature-lro off …` — 속성 지원은 NM 버전마다 다르므로 실행 전에 `nmcli -g <속성> connection show <conn>` 로 존재를 확인하고, 없는 속성은 "NM 미지원 — 런타임만"으로 결과에 남긴다.
- 본딩: `nmcli -g bond.options connection show <bond-conn>` 로 읽어 해당 키만 바꿔 다시 modify(나머지 옵션 보존).
- **`nmcli connection up`·`device reapply` 는 하지 않는다** — 재활성화로 링크가 내려갈 수 있다. 런타임은 이미 ethtool·sysfs 로 바꿨으므로 파일만 맞춘다(다음 부팅·재활성화 때 같은 값).
- 실행 전 `nmcli -t connection show <conn>` 출력을 백업(`<backup_dir>/<conn>.pep-bak-v<기준버전>`)해 원복에 쓴다.
- NM 이 관리하지 않는 인터페이스(`unmanaged`): 런타임만 적용하고 결과·요약에 "재부팅 시 원복됨" 경고.

### 5.2 명령 예 (노드 하나, 본딩 이중화, NM)

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
ethtool -G ens1f0 rx 8192 tx 8192 && ethtool -L ens1f0 combined 16   # → MII up · Aggregator 재합류 대기
ethtool -G ens1f1 rx 8192 tx 8192 && ethtool -L ens1f1 combined 16   # → 대기
# 4. 확인(새 SSH 세션) + 데드맨 해제
systemctl stop pep-nic-rollback.timer
# 5. 영구 기록
nmcli connection modify bond0-slave-ens1f0 ethtool.ring-rx 8192 ethtool.ring-tx 8192 ethtool.channels-combined 16
nmcli connection modify bond0 bond.options "mode=802.3ad,miimon=100,lacp_rate=fast,xmit_hash_policy=layer3+4"
```

이 목록이 계획 API `commands` 로 화면 "실행될 명령"에 그대로 나간다(UI-First 4: 가시화가 편집보다 먼저).

---

## 6. 적용 설정 (AppSetting `service_config.settings`, `ApplySettingsDialog` NIC 구역)

| 키 | 기본 | 설명 |
|---|---|---|
| `nic_target` / `nic_target_glob` | `bond_members` / `""` | §4 |
| `nic_persist_nm` | true | NM 영구 기록 사용 |
| `nic_ethtool` | `ethtool` | 노드의 ethtool 경로 |
| `nic_collect_concurrency` | 20 | SSH 수집 동시 접속 수(1~50) |
| `nic_apply_concurrency` | 1 | 적용 동시 노드 수 기본값(1~20, 실행마다 바꿀 수 있음) |
| `nic_rollback_timer_sec` | 120 | 데드맨 원복 타이머(30~900) |
| `nic_member_wait_sec` | 10 | 하위 인터페이스 사이 대기 |
| `nic_rejoin_timeout_sec` | 60 | 링크·LACP 재합류 대기 제한 |
| `nic_backup_dir` | `/etc/pep-backup/nic` | NM connection 백업 위치 |

1차 판정 기준(`nic_watch.settings` 의 기대 해시 정책·LACP rate·offload 기대 값)은 **버전이 있는 클러스터에서는 버전 값을 기대 값으로** 쓴다(버전이 없으면 지금처럼 설정 값). 두 곳이 어긋나 같은 노드에 반대 경고가 뜨지 않게.

---

## 7. 의존 규칙 (`service_config_rules`)

| 규칙 | 종류 | 내용 |
|---|---|---|
| `nic.ring_le_max` | require(계획 단계 노드별 검사) | ring·channels ≤ 노드 인터페이스 최대값. `max` 는 통과 |
| `nic.lro_off_forwarding` | recommend | `offload.rx-lro` = off — K8S 노드는 패킷을 포워딩한다 |
| `nic.hash_l34` | recommend | `bond.xmit_hash_policy` = layer3+4 |
| `nic.lacp_fast` | recommend | `bond.lacp_rate` = fast |
| `nic.queue_reset_impact` | impact | ring·channels·offload — 하위 인터페이스마다 큐 재설정(본딩 유지), 노드당 약 30~60초 |
| `nic.tunnel_offload_cilium` | impact | `offload.tx-udp_tnl-segmentation` off → CILIUM VXLAN/Geneve 송신 성능 저하 |

---

## 8. API — 기존 서비스 구성 API 를 `service=nic` 로

- `GET /service-config/services` 에 `nic` 추가(`collect_kinds: ["nic-ssh"]`, `group_supported: true`).
- `GET|POST /service-config/clusters/{id}/nic/…` — 화면·V1·versions·compare·revert·groups.
- **수집**: `POST /service-config/clusters/{id}/nic/collect/stream`(operator, SSE) — 본문 `{nodes|group_id, concurrency, ssh}`. 첫 이벤트 `{type:"run"}`, 노드별 `{type:"log"|"node"}`, 끝 `{type:"done", stored, failed}`. 감사 `service_config.collect`(자격증명 제외).
- **적용**: `GET …/nic/apply/plan?version=&group_id=` · `POST …/nic/apply/stream`(operator, SSE) — 옵션 `{concurrency, batch_interval_sec, stop_on_failure, member_wait_sec, rejoin_timeout_sec, rollback_timer_sec, persist}` + SSH.
- 1차 `GET /nic-watch/…` 는 상태 탭이 그대로 쓴다.

---

## 9. 구현 단계

| 단계 | 내용 | 노드 변경 |
|---|---|---|
| **2-a 수집·버전** | NIC 를 서비스로 승격(설정/상태/요약 탭) · `catalog_seed` 키·규칙 · `int_or_max` · **SSH 현재 값 수집(SSE·동시 상한·로그)** · `nic:{node}` 스냅샷 + 드리프트·변경 알람 · `max` 비교 · 1차 판정의 기대 값 = 버전 값 | 없음(조회만) |
| **2-b 적용** | `apply_nic.py` — 계획·명령·실행, 데드맨 원복, 하위 순차·재집계 확인, 이중화 없는 인터페이스 건너뜀, 동시 노드 수, NM 영구 기록·백업·원복 | **있음** |

2-a 만으로도 에이전트 없이 NIC 화면이 동작하고, 기대 값과 어긋난 노드를 볼 수 있다.

---

## 10. 테스트

- **순수 함수**: SSH 수집 출력 파서(구분자 블록 → 에이전트와 같은 형태, 드라이버별 `ethtool -g/-l/-k` 출력 샘플 포함), 평탄화·`max` 비교, 계획 계산(현재/최대/`max`/fixed/미지원/값 같음/이중화 없음), 명령 렌더링, NM `bond.options` 병합, 원복 스크립트, `/proc/net/bonding` 재집계 판정.
- **실행 흐름**: 가짜 SSH 실행기로 성공·미지원·재집계 실패 → 원복·SSH 끊김 → 타이머 원복·중지·실패 시 중단·동시 실행.
- **규모**: 500노드 가짜 SSH 수집(동시 20) 소요·DB 쓰기, 계획 API 응답 크기.
- **실장비(릴리스 전 필수)**: 802.3ad 본딩 + mlx5 또는 i40e 노드 1대에서 ring·channels·offload 변경 중 본딩 무중단(연속 ping·`/proc/net/bonding`), NM 영구 기록 후 재부팅 값 유지. 가상 NIC 로는 ring 변경·LACP 를 재현할 수 없다.

---

## 11. 위험과 대응

| 위험 | 대응 |
|---|---|
| ring·channels 변경 중 하위가 안 돌아옴 | 하위 하나씩 + 재집계 확인 + 실패 시 그 노드 원복·중단 |
| 두 하위가 모두 안 돌아와 SSH 끊김 | 데드맨 타이머가 원복 |
| NM 재활성화로 링크 다운 | `connection up`·`reapply` 금지 — 파일만 |
| 500대 수집·적용 부하 | SSH 수집 동시 상한(20), 적용 기본 1대·최대 20, 노드 그룹 단위 실행 |
| 운영자 수동 설정과 충돌 | NM 속성 단위 modify(나머지 보존) + 백업, 변경 감지가 PEP 밖 변경을 알람(에이전트 또는 다음 수집) |
| NIC 모델이 섞임 | `max` + 노드 그룹 재정의 + 계획 단계 노드별 최대값 검사 |
| 특정 펌웨어 버그 | 상태 화면의 드라이버·펌웨어로 노드 그룹을 나눠 단계 적용(기본 1대씩) |
