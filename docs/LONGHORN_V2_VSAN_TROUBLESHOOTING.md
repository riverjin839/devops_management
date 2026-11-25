# Longhorn V2 on vSAN VM — `nvme` I/O 에러·행 걸림 원인 분석 / 해결 가이드

> 대상 환경: vSphere vSAN 위 VM 5대(K8S 노드) · 노드당 vSAN 가상 디스크 3개(`/dev/sda~c`, SCSI) ·
> Longhorn **V2 데이터 엔진(SPDK)** 블록 디스크로 등록.
> 증상: 특정 노드가 갑자기 행(D state 프로세스 누적), `dmesg` 에 `nvme ... I/O ... timeout` /
> `I/O error` 가 찍힘. 인프라 측 확인 결과 **같은 vSAN 의 다른 VM 에서는 에러 없음, 해당 노드만 발생.**

---

## 1. 결론 요약

1. **게스트 OS 에는 vSAN 캐시 티어 NVMe 가 보이지 않는다.** VM 에서 vSAN 디스크는 가상 SCSI(`sdX`)다.
   따라서 노드 `dmesg` 의 `nvme` 에러는 거의 확실히 **Longhorn V2 볼륨(`/dev/nvmeXnY`, NVMe-oF TCP)** 이다.
   "vSAN 캐시 NVMe 에러"가 아니라 **"Longhorn 볼륨 응답 없음"** 이고, 원인은 그 아래 계층에 있다.
   (예외: VM 디스크를 vNVMe 컨트롤러로 붙인 경우. `sda~c` 로 보이면 해당 없음.)
2. 다른 VM 이 정상이라면 vSAN 전체 장애가 아니라 **이 노드 고유의 원인**이다. 가장 유력한 원인은
   `spdk_tgt` 의 CPU 기아(vCPU Ready/스로틀)이고, 다음은 이 VM 디스크 경로만 느려지는 경우다
   (IOPS limit·vSCSI 큐·컴포넌트 편중). TRIM(unmap)·커널 버전·hugepage 도 함께 점검한다.
3. 근본적으로 **공유 스토리지(vSAN) 위에 분산 스토리지(Longhorn V2)를 다시 쌓은 구조**는 지연과 장애를
   증폭시킨다. VM 환경이라면 V1 엔진 전환이나 vSphere CSI 직접 사용을 검토한다(§7).

---

## 2. 동작 구조 — I/O 경로

```mermaid
flowchart TB
    subgraph POD["애플리케이션 Pod"]
        APP["App 프로세스<br/>(write/fsync)"]
    end

    subgraph NODE["K8S 노드 VM (게스트 OS)"]
        FS["ext4 / xfs"]
        NVMEDEV["/dev/nvmeXnY<br/>커널 nvme-tcp 이니시에이터<br/>(io_timeout 기본 30s)"]
        subgraph IM["instance-manager Pod (V2)"]
            SPDK["spdk_tgt<br/>NVMe-oF TCP target<br/>CPU 1코어 100% 폴링<br/>hugepage 2GiB"]
            ENGINE["Engine (RAID1 bdev)"]
            AIO["AIO bdev<br/>(unmap 미지원)"]
        end
        SD["/dev/sda · sdb · sdc<br/>가상 SCSI (PVSCSI / LSI)"]
    end

    subgraph REMOTE["다른 노드 VM ×N"]
        RREP["Replica (spdk_tgt + AIO bdev)"]
    end

    subgraph ESXI["ESXi 호스트 / vSAN"]
        VSCSI["vSCSI 큐 · 스토리지 정책<br/>(IOPS limit / FTT)"]
        CACHE["vSAN 캐시 티어<br/>(NVMe SSD)"]
        CAP["vSAN 용량 티어 SSD"]
    end

    APP --> FS --> NVMEDEV
    NVMEDEV -- "NVMe/TCP (loopback 또는 네트워크)" --> SPDK
    SPDK --> ENGINE
    ENGINE --> AIO --> SD
    ENGINE -- "NVMe/TCP 복제 트래픽" --> RREP
    SD --> VSCSI --> CACHE --> CAP
```

핵심 포인트:

- 게스트의 `nvme*` 장치는 **Longhorn 이 만든 가상 NVMe-oF 디스크**다. 물리 NVMe 가 아니다.
- vSAN 캐시 NVMe 는 ESXi 안쪽(맨 아래 계층)에 있어 게스트에서는 보이지 않는다.
- 한 번의 쓰기는 `Longhorn 레플리카 수 × vSAN FTT 미러 수` 만큼 증폭된다(3 × 2 = 6 배).

---

## 3. 장애 전파 — 왜 "행"이 걸리나

```mermaid
sequenceDiagram
    autonumber
    participant App as App (Pod)
    participant K as 커널 nvme-tcp
    participant S as spdk_tgt (V2)
    participant D as /dev/sdX (vSAN)

    App->>K: write / fsync
    K->>S: NVMe/TCP I/O 요청
    alt 원인 A: CPU 기아 (vCPU Ready / 스로틀)
        Note over S: 폴링 스레드가 스케줄되지 못함<br/>→ 요청 처리 정지
    else 원인 B: 하부 디스크 지연
        S->>D: AIO 제출
        Note over D: IOPS limit / vSCSI 큐 포화 /<br/>컴포넌트 congestion → 응답 지연
    else 원인 C: TRIM(unmap)
        K->>S: DISCARD
        Note over S: AIO bdev unmap 미지원 → I/O error
    end
    Note over K: io_timeout(30s) 초과
    K-->>K: "nvme nvmeX: I/O N QID M timeout, aborting / reset"
    K-->>App: I/O error 또는 무한 재시도
    Note over App: D state(uninterruptible) 고착<br/>kill 불가 → 노드 "행"
```

---

## 4. 원인 판별 플로우

```mermaid
flowchart TD
    START(["노드 행 / nvme I/O 에러"]) --> Q0{"dmesg 에러 장치는?"}
    Q0 -- "nvme* 만" --> A["원인 A 계열<br/>Longhorn V2 스택이 노드에서 정지"]
    Q0 -- "sd* 에도 timeout / abort" --> B["원인 B 계열<br/>이 VM 의 디스크 경로만 느림"]
    Q0 -- "ESXi 로그에 캐시 디바이스 에러" --> V["vSAN 디스크 그룹 장애<br/>벤더 / VMware 대응 우선"]

    A --> A1{"vCenter CPU Ready > 5%<br/>또는 Co-stop 높음?"}
    A1 -- 예 --> FA1["vCPU 예약 / 오버커밋 해소<br/>Latency Sensitivity High"]
    A1 -- 아니오 --> A2{"fstrim / discard 시각과 일치?"}
    A2 -- 예 --> FA2["fstrim.timer 비활성<br/>discard 마운트 옵션 제거"]
    A2 -- 아니오 --> A3{"커널 < 6.7 / hugepage 부족 /<br/>IM Pod 재시작·OOM?"}
    A3 -- 예 --> FA3["커널 업그레이드<br/>nr_hugepages 고정 · 리소스 보장"]
    A3 -- 아니오 --> A4["NIC drop / MTU, rebuild·백업 집중 여부<br/>instance-manager 로그 분석"]

    B --> B1{"VMDK 정책에 IOPS limit?"}
    B1 -- 예 --> FB1["정책 해제 / 상향"]
    B1 -- 아니오 --> B2{"컨트롤러 LSI Logic /<br/>디스크 3개가 한 컨트롤러?"}
    B2 -- 예 --> FB2["PVSCSI 로 교체<br/>컨트롤러 분산"]
    B2 -- 아니오 --> FB3["vSAN 오브젝트 배치 · 디스크 그룹<br/>congestion 확인(해당 VM 만)"]
```

---

## 5. 진단 명령

### 5.1 게스트 노드 (행 걸린 노드)

```bash
# 어느 계층 에러인가: nvme = Longhorn 볼륨, sd = vSAN 가상 디스크
dmesg -T | egrep -i "sd[a-c]|scsi|abort|reset" | tail -50
dmesg -T | egrep -i "nvme|I/O error|blocked for more than" | tail -50

# D state 프로세스
ps -eo pid,stat,wchan:32,cmd | awk '$2 ~ /D/'

# NVMe-TCP 연결 상태 / timeout
nvme list-subsys
cat /sys/class/nvme/nvme*/state
cat /sys/module/nvme_core/parameters/io_timeout

# 기본 조건 (다른 4대와 비교)
uname -r
grep -i huge /proc/meminfo
lsmod | egrep "nvme_tcp|uio|vfio"
systemctl status fstrim.timer; journalctl -u fstrim --since "-2d"
mount | grep -i discard

# 네트워크 (복제 트래픽 경로)
ethtool -S <nic> | egrep -i "drop|err|discard"
ip link show <nic> | grep mtu
```

### 5.2 Longhorn

```bash
kubectl -n longhorn-system get volumes.longhorn.io,replicas.longhorn.io -o wide
kubectl -n longhorn-system get pod -o wide | grep instance-manager
kubectl -n longhorn-system describe pod <im-pod-on-this-node> | egrep -i "restart|oom|limit"
kubectl -n longhorn-system logs <im-pod-on-this-node> --since=2h | egrep -i "error|timeout|bdev|aio"
kubectl -n longhorn-system top pod | grep instance-manager
```

### 5.3 vSphere / ESXi (인프라 팀)

- 해당 VM: Performance → **CPU Ready %, Co-stop**, Virtual Disk latency (장애 시각 기준)
- 해당 VM VMDK 스토리지 정책: **IOPS limit**, FTT, 오브젝트 / 컴포넌트 배치
- 해당 VM 이 있는 호스트 / 디스크 그룹: vSAN Performance 의 backend latency, congestion, resync
- `vmkernel.log` · `vobd.log`: 장애 시각 전후의 `nvme`, `H:0x`, `APD`, `PDL`, `congestion`

---

## 6. 복구 절차

1. **하부 안정화 우선.** vSAN 측 이상이 있으면 그것부터 해결하고 resync 완료를 기다린다.
   하부가 불안정한 상태에서 Longhorn rebuild 를 돌리면 다시 실패한다.
2. **노드 정리.** D state 는 kill 로 풀리지 않는다. `kubectl cordon` 과 `drain` 을 시도하고, 안 되면 노드를 재부팅한다.
3. **볼륨 점검.** Degraded 볼륨은 healthy 레플리카 기준으로 rebuild 한다. Faulted 볼륨은 최신 레플리카에서
   salvage 한다. 작업 전에 가능하면 스냅샷과 백업을 확보한다.
4. **파일시스템 점검.** 마운트 전에 `fsck -n` 또는 `xfs_repair -n` 으로 확인한다.

---

## 7. 재발 방지

### 7.1 설정

| 항목 | 조치 |
|---|---|
| 디스크 경로 | Longhorn 노드 디스크를 `/dev/sdX` 대신 `/dev/disk/by-id/...` 또는 `by-path` 로 재등록 (재부팅 시 이름 뒤바뀜 방지) |
| TRIM | `systemctl disable --now fstrim.timer`, StorageClass·마운트 옵션에서 `discard` 제거 (AIO bdev unmap 미지원) |
| CPU | VM vCPU Reservation 또는 Latency Sensitivity High, 오버커밋 축소, instance-manager 코어 여유 확보 |
| 커널 | 6.7 이상 (nvme-tcp ↔ SPDK IO timeout 시 kernel panic·메모리 손상 이슈 회피) |
| hugepage | `vm.nr_hugepages=1024` (2 MiB × 1024 = 2 GiB) 를 `sysctl.d` 에 고정 |
| vSCSI | PVSCSI 컨트롤러 사용, 디스크 3개를 컨트롤러 여러 개로 분산 |
| 스토리지 정책 | Longhorn 노드 VMDK 에서 IOPS limit 해제 |
| NVMe timeout | 필요 시 `nvme_core.io_timeout` 상향 (증상 완화일 뿐 원인 해결 아님) |
| Longhorn | 최신 패치 버전으로 업그레이드 (V2 수정이 지속 반영됨) |

### 7.2 아키텍처

```mermaid
flowchart LR
    NOW["현재<br/>vSAN(FTT=1) 위 Longhorn V2(레플리카 3)<br/>쓰기 6배 · 장애 도메인 미분리<br/>SPDK 가 vCPU 스케줄 지연에 민감"]
    NOW --> O1["옵션 1 (권장)<br/>Longhorn V1 엔진 전환<br/>VM 환경에서 지연에 관대"]
    NOW --> O2["옵션 2<br/>이중 복제 정리<br/>vSAN FTT=1 + Longhorn 레플리카 1~2<br/>또는 FTT=0 + 레플리카 3 + 호스트 anti-affinity"]
    NOW --> O3["옵션 3<br/>vSphere CSI 로 vSAN 직접 사용<br/>Longhorn 계층 제거"]
```

- V2 엔진은 **로컬 NVMe** 를 전제로 설계되었다. vSAN 위에서는 성능 이점이 거의 없고 지연 민감도만 커진다.
- V2 를 유지하려면 §7.1 의 CPU·커널·TRIM 항목을 반드시 적용하고, 레플리카와 FTT 조합을 재설계한다.

---

## 8. 에스컬레이션 시 수집할 자료

- 장애 시각 전후 ±10분의 `dmesg -T` (nvme · sd 양쪽)
- 해당 노드 instance-manager Pod 로그, `kubectl get volumes/replicas -o yaml`
- Longhorn support bundle (UI → Generate Support Bundle)
- vCenter: 해당 VM CPU Ready / Virtual Disk latency 차트, ESXi `vmkernel.log`
- 5대 노드의 `uname -r`, hugepage, VM 하드웨어(컨트롤러 종류·vCPU 예약) 비교표

---

## 참고

- Longhorn V2 Data Engine Prerequisites — https://longhorn.io/docs/1.11.3/v2-data-engine/prerequisites/
- Longhorn V2 data engine issues (burstable VM 에서 I/O stuck, #13585) — https://documentation.suse.com/en-us/cloudnative/storage/1.11/en/troubleshooting-maintenance/v2-data-engine-issues.html
- SUSE Virtualization — Longhorn V2 Data Engine (AIO bdev unmap 미지원) — https://documentation.suse.com/en-us/cloudnative/virtualization/v1.9/en/storage/longhorn-v2-data-engine.html
