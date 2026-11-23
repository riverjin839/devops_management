"""서비스 구성 — 서비스 정의와 관리 대상 설정 시드.

서비스 목록(``SERVICES``)은 화면 레일 순서·라벨·현재 값 출처를 정한다. 항목(``ITEMS``)은 DB(``service_config_items``)로
시드되고 운영자가 화면에서 다루는 원본은 DB 행이다 — ``seed_catalog`` 는 (service, key) 가 없을 때만 넣어
운영자가 고친 행을 덮지 않는다.

``source_keys`` — 현재 값을 어디서 읽는지:
- etcd       : ``{"flag": "<--플래그 이름>", "env": "<ETCD_ 환경변수>"}`` (정적 파드 플래그 · systemd env 파일)
- containerd : ``{"paths": ["<평탄화 경로>", ...]}`` — config v2/v3 경로 차이 때문에 후보를 차례로 본다
- cilium     : ``{"key": "<cilium-config 키>"}``
- linux      : ``{"key": "<sysctl 이름>"}``
- kube-apiserver·kube-controller-manager·kube-scheduler : ``{"flag": "<--플래그 이름>"}`` (정적 파드 command 플래그)
- kubelet    : ``{"path": "<KubeletConfiguration 평탄화 경로>"}`` — 점이 든 키는 따옴표(``evictionHard."memory.available"``)
- nic        : ``{"key": "<평탄화 키>"}`` — ``nic:{node}`` 스냅샷(``services/nic_watch/snapshot.py``)의 ``flat`` 키
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

# 서비스 표시 정보 + 현재 값을 다시 수집하는 방법(화면의 '현재 값 수집' 버튼이 여는 수집 종류).
SERVICES: list[dict[str, Any]] = [
    {"key": "etcd", "label": "ETCD", "icon": "database",
     "description": "클러스터 상태 저장소. 정적 파드(kubeadm)면 K8S API 로, systemd 데몬이면 SSH 로 설정을 읽는다.",
     "collect_kinds": ["versions", "etcd-systemd"]},
    {"key": "containerd", "label": "CONTAINERD", "icon": "box",
     "description": "컨테이너 런타임. 노드의 containerd 설정(config.toml)을 SSH 로 읽는다.",
     "collect_kinds": ["containerd-config"]},
    {"key": "cilium", "label": "CILIUM", "icon": "network",
     "description": "CNI. kube-system 의 cilium-config ConfigMap 을 K8S API 로 읽는다.",
     "collect_kinds": ["versions"]},
    {"key": "linux", "label": "LINUX (OS)", "icon": "cpu",
     "description": "노드 커널 파라미터(sysctl). 노드 파라미터 에이전트 보고를 우선 쓰고, 없으면 SSH 수집 값을 쓴다.",
     "collect_kinds": ["kernel-params"]},
    {"key": "kube-apiserver", "label": "KUBE-APISERVER", "short": "APISERVER", "icon": "server",
     "description": "컨트롤 플레인 API 서버(정적 파드). kube-system 의 컨트롤 플레인 파드 플래그를 K8S API 로 노드별로 읽는다.",
     "collect_kinds": ["static-pods"]},
    {"key": "kube-controller-manager", "label": "KUBE-CONTROLLER-MANAGER", "short": "CONTROLLER", "icon": "cog",
     "description": "컨트롤러 매니저(정적 파드). 컨트롤 플레인 파드 플래그를 K8S API 로 노드별로 읽는다.",
     "collect_kinds": ["static-pods"]},
    {"key": "kube-scheduler", "label": "KUBE-SCHEDULER", "short": "SCHEDULER", "icon": "calendar",
     "description": "스케줄러(정적 파드). 컨트롤 플레인 파드 플래그를 K8S API 로 노드별로 읽는다.",
     "collect_kinds": ["static-pods"]},
    {"key": "kubelet", "label": "KUBELET", "icon": "boxes",
     "description": "노드 에이전트. 노드의 kubelet 설정 파일(KubeletConfiguration, 보통 /var/lib/kubelet/config.yaml)을 SSH 로 읽는다.",
     "collect_kinds": ["kubelet-config"]},
    {"key": "nic", "label": "NIC", "icon": "cable",
     "description": "노드 NIC — 본딩 하위 인터페이스의 ring buffer·채널 수·offload 와 본딩 해시·LACP rate·링크 감시. "
                    "SSH 로 읽고(현재 값 수집), 노드 파라미터 에이전트가 있으면 그 보고도 쓴다. 상태 탭은 판정·카운터.",
     "collect_kinds": ["nic"]},
]
STATIC_POD_SERVICES = ("kube-apiserver", "kube-controller-manager", "kube-scheduler")
SERVICE_KEYS = tuple(s["key"] for s in SERVICES)

_CRI2 = 'plugins."io.containerd.grpc.v1.cri"'
_CRI3_RT = 'plugins."io.containerd.cri.v1.runtime"'
_CRI3_IMG = 'plugins."io.containerd.cri.v1.images"'


def _etcd(section, key, label, vtype="string", unit=None, default=None, help_=None, options=None):
    env = "ETCD_" + key.upper().replace("-", "_")
    return {"service": "etcd", "section": section, "key": key, "label": label, "value_type": vtype, "unit": unit,
            "default_value": default, "help": help_, "options": options, "restart_scope": "restart_member",
            "source_keys": {"flag": key, "env": env}}


def _ctd(section, key, label, paths, vtype="string", default=None, help_=None, options=None):
    return {"service": "containerd", "section": section, "key": key, "label": label, "value_type": vtype,
            "default_value": default, "help": help_, "options": options, "restart_scope": "restart_service",
            "source_keys": {"paths": paths}}


def _cil(section, key, label, vtype="string", default=None, help_=None, options=None):
    return {"service": "cilium", "section": section, "key": key, "label": label, "value_type": vtype,
            "default_value": default, "help": help_, "options": options, "restart_scope": "rolling_restart_ds",
            "source_keys": {"key": key}}


def _cp(service, section, key, label, vtype="string", default=None, help_=None, options=None, unit=None):
    return {"service": service, "section": section, "key": key, "label": label, "value_type": vtype, "unit": unit,
            "default_value": default, "help": help_, "options": options, "restart_scope": "restart_static_pod",
            "source_keys": {"flag": key}}


def _api(*a, **kw):
    return _cp("kube-apiserver", *a, **kw)


def _kcm(*a, **kw):
    return _cp("kube-controller-manager", *a, **kw)


def _sch(*a, **kw):
    return _cp("kube-scheduler", *a, **kw)


def _kl(section, key, label, vtype="string", default=None, help_=None, options=None, path=None, unit=None):
    return {"service": "kubelet", "section": section, "key": key, "label": label, "value_type": vtype, "unit": unit,
            "default_value": default, "help": help_, "options": options, "restart_scope": "restart_kubelet",
            "source_keys": {"path": path or key}}


def _os(section, key, label, vtype="int", default=None, help_=None, scope="immediate"):
    return {"service": "linux", "section": section, "key": key, "label": label, "value_type": vtype,
            "default_value": default, "help": help_, "restart_scope": scope, "source_keys": {"key": key}}


def _nic(section, key, label, vtype="string", default=None, help_=None, options=None, scope="nic_queue_reset"):
    return {"service": "nic", "section": section, "key": key, "label": label, "value_type": vtype,
            "default_value": default, "help": help_, "options": options, "restart_scope": scope, "source_keys": {"key": key}}


_ONOFF = ["on", "off"]

ITEMS: list[dict[str, Any]] = [
    # ── ETCD ──
    _etcd("저장소", "quota-backend-bytes", "백엔드 DB 크기 상한", "size", "bytes", "2147483648",
          "넘으면 NOSPACE 알람으로 쓰기가 멈춘다. 권장 최대 8GiB. 바꾸면 조각모음 점검 임계값도 함께 본다."),
    _etcd("저장소", "auto-compaction-mode", "자동 압축 방식", "enum", None, "periodic", None, ["periodic", "revision"]),
    _etcd("저장소", "auto-compaction-retention", "자동 압축 보존", "string", None, "0",
          "periodic 이면 기간(예: 8h), revision 이면 보존 리비전 수."),
    _etcd("저장소", "snapshot-count", "스냅샷 주기(커밋 수)", "int", None, "10000"),
    _etcd("저장소", "max-snapshots", "보관 스냅샷 파일 수", "int", None, "5"),
    _etcd("저장소", "max-wals", "보관 WAL 파일 수", "int", None, "5"),
    _etcd("클러스터 통신", "heartbeat-interval", "리더 하트비트 간격", "int", "ms", "100",
          "멤버 간 왕복 지연(RTT) 정도로. 선출 시간은 이 값의 5~10배 이상이어야 한다."),
    _etcd("클러스터 통신", "election-timeout", "리더 선출 시간 제한", "int", "ms", "1000",
          "하트비트 간격의 10배 정도를 권장. 너무 짧으면 리더가 자주 바뀐다."),
    _etcd("클러스터 통신", "max-request-bytes", "요청 최대 크기", "size", "bytes", "1572864"),
    _etcd("클러스터 통신", "grpc-keepalive-interval", "gRPC keepalive 간격", "duration", None, "2h0m0s"),
    _etcd("관측", "listen-metrics-urls", "메트릭 수신 주소", "string", None, None,
          "Prometheus 가 etcd 지표를 긁는 주소. 비어 있으면 클라이언트 포트로만 노출."),
    _etcd("관측", "log-level", "로그 수준", "enum", None, "info", None, ["debug", "info", "warn", "error"]),
    # ── CONTAINERD ──
    _ctd("런타임", "SystemdCgroup", "runc cgroup 드라이버를 systemd 로",
         [f"{_CRI2}.containerd.runtimes.runc.options.SystemdCgroup",
          f"{_CRI3_RT}.containerd.runtimes.runc.options.SystemdCgroup"], "bool", "false",
         "kubelet 의 cgroupDriver 와 반드시 같아야 한다(systemd ↔ true). 다르면 노드가 불안정해진다."),
    _ctd("런타임", "default_runtime_name", "기본 런타임",
         [f"{_CRI2}.containerd.default_runtime_name", f"{_CRI3_RT}.containerd.default_runtime_name"], "string", "runc"),
    _ctd("런타임", "enable_unprivileged_ports", "비특권 포트 허용",
         [f"{_CRI2}.enable_unprivileged_ports", f"{_CRI3_RT}.enable_unprivileged_ports"], "bool", "false"),
    _ctd("런타임", "max_container_log_line_size", "컨테이너 로그 한 줄 최대 크기",
         [f"{_CRI2}.max_container_log_line_size", f"{_CRI3_RT}.max_container_log_line_size"], "int", "16384"),
    _ctd("이미지", "sandbox_image", "pause(샌드박스) 이미지",
         [f"{_CRI2}.sandbox_image", f"{_CRI3_IMG}.pinned_images.sandbox"], "string", None,
         "폐쇄망이면 사내 레지스트리 경로여야 한다. kubelet --pod-infra-container-image 와 맞춘다."),
    _ctd("이미지", "snapshotter", "스냅샷터",
         [f"{_CRI2}.containerd.snapshotter", f"{_CRI3_IMG}.snapshotter"], "enum", "overlayfs", None,
         ["overlayfs", "native", "zfs", "btrfs", "devmapper", "stargz"]),
    _ctd("이미지", "registry.config_path", "레지스트리 설정 디렉터리(hosts.toml)",
         [f"{_CRI2}.registry.config_path", f"{_CRI3_IMG}.registry.config_path"], "string", None,
         "미러·사설 인증서 설정이 있는 디렉터리(보통 /etc/containerd/certs.d)."),
    _ctd("이미지", "max_concurrent_downloads", "동시 레이어 다운로드 수",
         [f"{_CRI2}.max_concurrent_downloads", f"{_CRI3_IMG}.max_concurrent_downloads",
          'plugins."io.containerd.transfer.v1.local".max_concurrent_downloads'], "int", "3"),
    _ctd("데몬", "root", "데이터 디렉터리", ["root"], "string", "/var/lib/containerd"),
    _ctd("데몬", "state", "상태 디렉터리", ["state"], "string", "/run/containerd"),
    _ctd("데몬", "oom_score", "containerd OOM 점수", ["oom_score"], "int", "0"),
    _ctd("데몬", "version", "설정 파일 형식 버전", ["version"], "int", None,
         "2 = containerd 1.x, 3 = containerd 2.x. 키 경로가 버전마다 다르다."),
    # ── CILIUM ──
    _cil("데이터 경로", "routing-mode", "라우팅 방식", "enum", "tunnel",
         "native 면 ipv4-native-routing-cidr 가 필요하다.", ["tunnel", "native"]),
    _cil("데이터 경로", "tunnel-protocol", "터널 프로토콜", "enum", "vxlan", None, ["vxlan", "geneve"]),
    _cil("데이터 경로", "ipv4-native-routing-cidr", "네이티브 라우팅 CIDR", "string", None,
         "routing-mode=native 일 때 마스커레이드하지 않을 대역."),
    _cil("데이터 경로", "kube-proxy-replacement", "kube-proxy 대체", "enum", "false",
         "true 면 k8s-service-host/port 가 설정돼 있어야 한다.", ["true", "false"]),
    _cil("데이터 경로", "k8s-service-host", "API 서버 주소(kube-proxy 대체 시)", "string", None,
         "kube-proxy-replacement=true 면 cilium 이 API 서버에 직접 붙을 주소(VIP·LB). 비우면 kube-proxy 없이 동작하지 않는다."),
    _cil("데이터 경로", "k8s-service-port", "API 서버 포트(kube-proxy 대체 시)", "int", "6443"),
    _cil("데이터 경로", "enable-bpf-masquerade", "eBPF 마스커레이드", "bool", "false"),
    _cil("데이터 경로", "enable-ipv4-masquerade", "IPv4 마스커레이드", "bool", "true"),
    _cil("데이터 경로", "enable-bandwidth-manager", "대역폭 관리자", "bool", "false"),
    _cil("IPAM", "ipam", "IPAM 모드", "enum", "cluster-pool", None,
         ["cluster-pool", "kubernetes", "multi-pool", "eni", "azure"]),
    _cil("IPAM", "cluster-pool-ipv4-cidr", "파드 CIDR(cluster-pool)", "string"),
    _cil("IPAM", "cluster-pool-ipv4-mask-size", "노드당 마스크 길이", "int", "24"),
    _cil("BPF 맵", "bpf-ct-global-tcp-max", "TCP conntrack 맵 크기", "int", "524288"),
    _cil("BPF 맵", "bpf-ct-global-any-max", "비 TCP conntrack 맵 크기", "int", "262144"),
    _cil("BPF 맵", "bpf-map-dynamic-size-ratio", "맵 크기 자동 비율(메모리 대비)", "string", "0.0025"),
    _cil("관측", "enable-hubble", "Hubble", "bool", "true"),
    _cil("관측", "monitor-aggregation", "모니터 이벤트 집계 수준", "enum", "medium", None, ["none", "low", "medium", "maximum"]),
    _cil("정책", "enable-policy", "네트워크 정책 적용 방식", "enum", "default", None, ["default", "always", "never"]),
    _cil("정책", "enable-l7-proxy", "L7 프록시", "bool", "true"),
    # ── LINUX (OS) ──
    _os("네트워크", "net.ipv4.ip_forward", "패킷 포워딩", "int", "1", "CILIUM·kube-proxy 가 요구 — 1 이어야 한다."),
    _os("네트워크", "net.core.somaxconn", "listen 백로그 상한", "int", "4096"),
    _os("네트워크", "net.ipv4.tcp_max_syn_backlog", "SYN 대기열 크기", "int", "1024",
        "somaxconn 보다 작으면 SYN 대기열에서 먼저 막힌다."),
    _os("네트워크", "net.core.netdev_max_backlog", "NIC 수신 대기열", "int", "1000"),
    _os("네트워크", "net.ipv4.ip_local_port_range", "임시 포트 범위", "string", "32768 60999"),
    _os("네트워크", "net.netfilter.nf_conntrack_max", "conntrack 테이블 상한", "int", "262144",
        "가득 차면 새 연결이 버려진다(dmesg: table full)."),
    _os("네트워크", "net.ipv4.tcp_tw_reuse", "TIME_WAIT 재사용", "int", "2"),
    _os("메모리", "vm.swappiness", "스왑 사용 성향", "int", "60", "쿠버네티스 노드는 보통 낮게(0~10) 둔다."),
    _os("메모리", "vm.max_map_count", "프로세스당 메모리 맵 수", "int", "65530",
        "Elasticsearch/OpenSearch 노드는 262144 이상 필요."),
    _os("메모리", "vm.overcommit_memory", "메모리 오버커밋 정책", "int", "0"),
    _os("메모리", "vm.panic_on_oom", "OOM 시 패닉", "int", "0"),
    _os("파일시스템", "fs.file-max", "시스템 전체 열린 파일 수 상한", "int", None),
    _os("파일시스템", "fs.nr_open", "프로세스당 열린 파일 수 상한", "int", "1048576"),
    _os("파일시스템", "fs.inotify.max_user_watches", "inotify 감시 수 상한", "int", "8192",
        "부족하면 로그 수집기·kubelet 이 파일 변경을 놓친다."),
    _os("파일시스템", "fs.inotify.max_user_instances", "inotify 인스턴스 수 상한", "int", "128"),
    _os("커널", "kernel.pid_max", "PID 상한", "int", "4194304"),
    _os("커널", "kernel.panic", "패닉 뒤 재부팅 대기(초)", "int", "0"),
    _os("커널", "kernel.panic_on_oops", "oops 시 패닉", "int", "0"),
    # ── KUBE-APISERVER ──
    _api("요청 처리", "max-requests-inflight", "동시 처리 읽기 요청 상한", "int", "400",
         "넘으면 429 로 거절한다. APF(API Priority and Fairness)가 켜져 있으면 전체 동시성 예산으로 쓰인다."),
    _api("요청 처리", "max-mutating-requests-inflight", "동시 처리 쓰기 요청 상한", "int", "200"),
    _api("요청 처리", "request-timeout", "요청 제한 시간", "duration", "1m0s"),
    _api("요청 처리", "min-request-timeout", "watch 최소 제한 시간(초)", "int", "1800"),
    _api("클러스터", "service-node-port-range", "NodePort 범위", "string", "30000-32767"),
    _api("클러스터", "service-cluster-ip-range", "서비스 CIDR", "string", None,
         "바꾸면 기존 서비스 IP 와 충돌한다 — 운영 중 변경은 사실상 불가. 컨트롤러 매니저 값과 같아야 한다."),
    _api("클러스터", "event-ttl", "이벤트 보존 시간", "duration", "1h0m0s",
         "길게 잡으면 etcd 크기가 늘어난다."),
    _api("클러스터", "default-not-ready-toleration-seconds", "NotReady 노드 파드 축출 대기(초)", "int", "300"),
    _api("클러스터", "default-unreachable-toleration-seconds", "Unreachable 노드 파드 축출 대기(초)", "int", "300"),
    _api("보안", "enable-admission-plugins", "추가로 켤 어드미션 플러그인", "string", "NodeRestriction"),
    _api("보안", "anonymous-auth", "익명 요청 허용", "bool", "true"),
    _api("보안", "profiling", "/debug/pprof 프로파일링", "bool", "true", "보안 기준(CIS)은 false 를 권장한다."),
    _api("감사 로그", "audit-log-path", "감사 로그 경로", "string", None, "비어 있으면 감사 로그를 남기지 않는다."),
    _api("감사 로그", "audit-log-maxage", "감사 로그 보존 일수", "int", None),
    _api("감사 로그", "audit-log-maxbackup", "감사 로그 보관 파일 수", "int", None),
    _api("감사 로그", "audit-log-maxsize", "감사 로그 파일 최대 크기(MB)", "int", None),
    _api("감사 로그", "audit-policy-file", "감사 정책 파일", "string", None),
    # ── KUBE-CONTROLLER-MANAGER ──
    _kcm("노드 수명", "node-monitor-grace-period", "노드 무응답 → NotReady 대기", "duration", "40s",
         "kubelet 상태 보고가 이 시간 동안 없으면 노드를 NotReady 로 본다."),
    _kcm("노드 수명", "node-monitor-period", "노드 상태 확인 주기", "duration", "5s"),
    _kcm("노드 수명", "terminated-pod-gc-threshold", "끝난 파드 보존 개수", "int", "12500",
         "넘으면 오래된 Succeeded/Failed 파드부터 지운다."),
    _kcm("동시성", "concurrent-deployment-syncs", "Deployment 동시 처리 수", "int", "5"),
    _kcm("동시성", "concurrent-replicaset-syncs", "ReplicaSet 동시 처리 수", "int", "5"),
    _kcm("동시성", "concurrent-gc-syncs", "가비지 컬렉터 동시 처리 수", "int", "20"),
    _kcm("동시성", "kube-api-qps", "API 서버 호출 QPS", "int", "20"),
    _kcm("동시성", "kube-api-burst", "API 서버 호출 버스트", "int", "30"),
    _kcm("클러스터", "cluster-cidr", "파드 CIDR", "string", None),
    _kcm("클러스터", "service-cluster-ip-range", "서비스 CIDR", "string", None),
    _kcm("클러스터", "node-cidr-mask-size", "노드당 파드 CIDR 마스크", "int", "24"),
    _kcm("클러스터", "allocate-node-cidrs", "노드 CIDR 할당", "bool", "false",
         "CILIUM IPAM 이 kubernetes 모드면 true 여야 한다."),
    _kcm("인증서", "cluster-signing-duration", "서명 인증서 유효 기간", "duration", "8760h0m0s"),
    _kcm("보안", "profiling", "/debug/pprof 프로파일링", "bool", "true", "보안 기준(CIS)은 false 를 권장한다."),
    # ── KUBE-SCHEDULER ──
    _sch("동작", "config", "스케줄러 설정 파일", "string", None, "KubeSchedulerConfiguration 파일 경로(프로파일·플러그인 설정)."),
    _sch("동작", "leader-elect", "리더 선출", "bool", "true", "컨트롤 플레인이 여러 대면 true 여야 한다."),
    _sch("동작", "kube-api-qps", "API 서버 호출 QPS", "int", "50"),
    _sch("동작", "kube-api-burst", "API 서버 호출 버스트", "int", "100"),
    _sch("보안", "profiling", "/debug/pprof 프로파일링", "bool", "true", "보안 기준(CIS)은 false 를 권장한다."),
    # ── KUBELET ──
    _kl("파드", "maxPods", "노드당 최대 파드 수", "int", "110",
        "CILIUM IPAM 노드당 CIDR(마스크) 안에 들어가야 한다."),
    _kl("파드", "podPidsLimit", "파드당 PID 상한", "int", "-1"),
    _kl("파드", "serializeImagePulls", "이미지를 하나씩 받기", "bool", "true"),
    _kl("파드", "maxParallelImagePulls", "동시 이미지 받기 수", "int", None, "serializeImagePulls=false 일 때만 쓰인다."),
    _kl("런타임", "cgroupDriver", "cgroup 드라이버", "enum", "systemd",
        "containerd SystemdCgroup 과 같아야 한다(systemd ↔ true).", ["systemd", "cgroupfs"]),
    _kl("런타임", "containerRuntimeEndpoint", "컨테이너 런타임 소켓", "string", "unix:///run/containerd/containerd.sock"),
    _kl("런타임", "failSwapOn", "스왑이 켜져 있으면 기동 거부", "bool", "true"),
    _kl("자원 예약", "systemReserved.cpu", "시스템 예약 CPU", "string", None, path='systemReserved.cpu'),
    _kl("자원 예약", "systemReserved.memory", "시스템 예약 메모리", "string", None, path='systemReserved.memory'),
    _kl("자원 예약", "kubeReserved.cpu", "쿠버네티스 예약 CPU", "string", None, path='kubeReserved.cpu'),
    _kl("자원 예약", "kubeReserved.memory", "쿠버네티스 예약 메모리", "string", None, path='kubeReserved.memory'),
    _kl("축출", "evictionHard.memory.available", "메모리 여유 하한(즉시 축출)", "string", "100Mi",
        path='evictionHard."memory.available"'),
    _kl("축출", "evictionHard.nodefs.available", "노드 디스크 여유 하한", "string", "10%",
        path='evictionHard."nodefs.available"'),
    _kl("축출", "evictionHard.imagefs.available", "이미지 디스크 여유 하한", "string", "15%",
        path='evictionHard."imagefs.available"'),
    _kl("이미지·로그", "imageGCHighThresholdPercent", "이미지 정리 시작 디스크 사용률(%)", "int", "85"),
    _kl("이미지·로그", "imageGCLowThresholdPercent", "이미지 정리 목표 디스크 사용률(%)", "int", "80"),
    _kl("이미지·로그", "containerLogMaxSize", "컨테이너 로그 파일 최대 크기", "string", "10Mi"),
    _kl("이미지·로그", "containerLogMaxFiles", "컨테이너 로그 보관 파일 수", "int", "5"),
    _kl("자원 관리", "cpuManagerPolicy", "CPU 관리자 정책", "enum", "none", "static 이면 Guaranteed 파드에 CPU 를 고정한다(GPU·지연 민감 노드).",
        ["none", "static"]),
    _kl("자원 관리", "topologyManagerPolicy", "토폴로지 관리자 정책", "enum", "none", None,
        ["none", "best-effort", "restricted", "single-numa-node"]),
    _kl("자원 관리", "memoryManagerPolicy", "메모리 관리자 정책", "enum", "None", None, ["None", "Static"]),
    _kl("수명", "shutdownGracePeriod", "노드 종료 시 파드 정리 시간", "duration", "0s"),
    _kl("수명", "shutdownGracePeriodCriticalPods", "중요 파드 정리 시간", "duration", "0s"),
    _kl("인증서", "rotateCertificates", "클라이언트 인증서 자동 갱신", "bool", "true"),
    _kl("인증서", "serverTLSBootstrap", "서빙 인증서 CSR 발급", "bool", "false"),
    # ── NIC (본딩 하위 물리 인터페이스 + 본딩) — 값 '현재/최대' 는 화면 표시, 버전 값은 숫자 또는 max ──
    _nic("Ring buffer", "ring.rx", "수신 ring 크기", "int_or_max", None,
         "숫자 또는 max(인터페이스별 최대값). 작으면 버스트 트래픽에서 NIC 드롭(rx_missed·rx_out_of_buffer)이 생긴다."),
    _nic("Ring buffer", "ring.tx", "송신 ring 크기", "int_or_max", None, "숫자 또는 max."),
    _nic("채널", "channels.combined", "결합 채널(큐) 수", "int_or_max", None,
         "숫자 또는 max. 큐가 적으면 수신 처리가 CPU 코어 몇 개에 몰린다."),
    _nic("Offload", "offload.rx-lro", "large-receive-offload", "enum", "off",
         "K8S 노드는 패킷을 포워딩하므로 꺼야 한다.", _ONOFF),
    _nic("Offload", "offload.rx-gro", "generic-receive-offload", "enum", "on", None, _ONOFF),
    _nic("Offload", "offload.tx-tcp-segmentation", "tcp-segmentation-offload", "enum", "on", None, _ONOFF),
    _nic("Offload", "offload.rx-checksum", "rx-checksumming", "enum", "on", None, _ONOFF),
    _nic("Offload", "offload.tx-checksum-ip-generic", "tx-checksumming", "enum", "on", None, _ONOFF),
    _nic("Offload", "offload.tx-udp_tnl-segmentation", "터널(VXLAN·Geneve) TSO", "enum", "on",
         "CILIUM VXLAN/Geneve 송신 성능에 영향.", _ONOFF),
    _nic("본딩", "bond.xmit_hash_policy", "송신 해시 정책", "enum", "layer2",
         "layer2 는 MAC 기준이라 같은 게이트웨이로 가는 트래픽이 링크 하나에 몰린다.",
         ["layer2", "layer2+3", "layer3+4", "encap2+3", "encap3+4", "vlan+srcmac"], "immediate"),
    _nic("본딩", "bond.lacp_rate", "LACP rate", "enum", "slow",
         "802.3ad 만. slow 는 스위치 쪽 장애 감지가 최대 90초 늦다.", ["slow", "fast"], "immediate"),
    _nic("본딩", "bond.miimon", "링크 감시 주기(ms)", "int", "100", "0 이면 하위 링크 장애를 감지하지 못한다.", None, "immediate"),
]


def seed_catalog(db: Session) -> int:
    """(service, key) 가 없는 항목만 추가한다 — 운영자가 고친 행·지운 항목 판단은 덮지 않는다(지운 항목은 enabled=False 로 끈다)."""
    from app.models.service_config import ServiceConfigItem

    existing = {(s, k) for s, k in db.query(ServiceConfigItem.service, ServiceConfigItem.key).all()}
    order: dict[str, int] = {}
    added = 0
    for spec in ITEMS:
        svc = spec["service"]
        order[svc] = order.get(svc, 0) + 10
        if (svc, spec["key"]) in existing:
            continue
        db.add(ServiceConfigItem(
            service=svc, section=spec["section"], key=spec["key"], label=spec.get("label"), help=spec.get("help"),
            value_type=spec.get("value_type") or "string", unit=spec.get("unit"), options=spec.get("options"),
            default_value=spec.get("default_value"), restart_scope=spec.get("restart_scope") or "immediate",
            source_keys=spec.get("source_keys"), sort_order=order[svc], enabled=True,
        ))
        added += 1
    if added:
        db.commit()
    return added


# ── 의존 규칙 ────────────────────────────────────────────────────────────────
# rule_key 는 시드 식별자 — 같은 키가 DB 에 있으면 다시 넣지 않는다(운영자가 끈 규칙을 되살리지 않음).
RULES: list[dict[str, Any]] = [
    {"rule_key": "linux.syn_backlog_ge_somaxconn", "service": "linux", "key": "net.core.somaxconn",
     "target_service": "linux", "target_key": "net.ipv4.tcp_max_syn_backlog", "kind": "recommend", "rule_type": "min_of_key",
     "reason": "SYN 대기열이 listen 백로그보다 작으면 SYN 단계에서 먼저 막힌다 — somaxconn 이상 권장."},
    {"rule_key": "linux.file_max_ge_nr_open", "service": "linux", "key": "fs.nr_open",
     "target_service": "linux", "target_key": "fs.file-max", "kind": "recommend", "rule_type": "min_of_key",
     "reason": "시스템 전체 상한(file-max)이 프로세스 상한(nr_open)보다 작으면 프로세스 상한을 다 쓸 수 없다."},
    {"rule_key": "linux.conntrack_memory", "service": "linux", "key": "net.netfilter.nf_conntrack_max",
     "target_service": None, "target_key": None, "kind": "impact", "rule_type": "impact",
     "reason": "conntrack 항목당 약 300 B 의 커널 메모리를 쓴다 — 값을 크게 올리면 노드 메모리 여유를 확인한다."},
    {"rule_key": "cilium.requires_ip_forward", "service": "cilium", "key": "*",
     "target_service": "linux", "target_key": "net.ipv4.ip_forward", "kind": "require", "rule_type": "fixed_value",
     "params": {"value": "1"}, "reason": "CILIUM 이 노드를 거치는 파드 트래픽을 라우팅하려면 ip_forward=1 이어야 한다."},
    {"rule_key": "etcd.election_ge_5x_heartbeat", "service": "etcd", "key": "heartbeat-interval",
     "target_service": "etcd", "target_key": "election-timeout", "kind": "require", "rule_type": "multiple_of_key",
     "params": {"factor": 5}, "reason": "선출 시간이 하트비트의 5배보다 짧으면 리더가 끊임없이 바뀐다(etcd 가 기동을 거부한다)."},
    {"rule_key": "etcd.election_10x_heartbeat", "service": "etcd", "key": "heartbeat-interval",
     "target_service": "etcd", "target_key": "election-timeout", "kind": "recommend", "rule_type": "multiple_of_key",
     "params": {"factor": 10}, "reason": "선출 시간은 하트비트 간격의 10배 정도를 권장한다."},
    {"rule_key": "etcd.quota_max_8gib", "service": "etcd", "key": "quota-backend-bytes",
     "target_service": "etcd", "target_key": "quota-backend-bytes", "kind": "recommend", "rule_type": "max_value",
     "params": {"max": "8589934592"}, "reason": "8 GiB 를 넘기면 스냅샷·복구·조각모음이 크게 느려진다 — 공식 권장 최대값."},
    {"rule_key": "etcd.quota_defrag_check", "service": "etcd", "key": "quota-backend-bytes",
     "target_service": None, "target_key": None, "kind": "impact", "rule_type": "impact",
     "reason": "PEP 의 etcd 조각모음 점검 임계값(점검 매트릭스 ▸ etcd_defrag)도 새 quota 에 맞춰 확인한다."},
    {"rule_key": "containerd.systemd_cgroup_kubelet", "service": "containerd", "key": "SystemdCgroup",
     "target_service": None, "target_key": None, "kind": "impact", "rule_type": "impact",
     "reason": "kubelet 의 cgroupDriver 도 같은 값(true ↔ systemd)으로 바꿔야 한다 — 다르면 노드가 NotReady 가 될 수 있다."},
    {"rule_key": "containerd.sandbox_kubelet", "service": "containerd", "key": "sandbox_image",
     "target_service": None, "target_key": None, "kind": "impact", "rule_type": "impact",
     "reason": "kubelet --pod-infra-container-image 와 이미지를 맞추고, 폐쇄망이면 레지스트리에 이미지가 있는지 확인한다."},
    {"rule_key": "cilium.kpr_requires_host", "service": "cilium", "key": "kube-proxy-replacement",
     "target_service": "cilium", "target_key": "k8s-service-host", "kind": "require", "rule_type": "requires_when",
     "params": {"when": "true"}, "reason": "kube-proxy 를 대체하면 cilium 이 API 서버에 직접 붙을 주소가 필요하다."},
    {"rule_key": "cilium.kpr_requires_port", "service": "cilium", "key": "kube-proxy-replacement",
     "target_service": "cilium", "target_key": "k8s-service-port", "kind": "require", "rule_type": "requires_when",
     "params": {"when": "true"}, "reason": "kube-proxy 를 대체하면 API 서버 포트가 필요하다."},
    {"rule_key": "cilium.native_requires_cidr", "service": "cilium", "key": "routing-mode",
     "target_service": "cilium", "target_key": "ipv4-native-routing-cidr", "kind": "require", "rule_type": "requires_when",
     "params": {"when": "native"}, "reason": "네이티브 라우팅이면 마스커레이드하지 않을 대역(파드 CIDR)을 알아야 한다."},
    {"rule_key": "apiserver.mutating_le_readonly", "service": "kube-apiserver", "key": "max-mutating-requests-inflight",
     "target_service": "kube-apiserver", "target_key": "max-requests-inflight", "kind": "recommend", "rule_type": "min_of_key",
     "reason": "읽기 요청 상한은 보통 쓰기 요청 상한 이상으로 둔다(기본 400 : 200)."},
    {"rule_key": "apiserver.service_cidr_kcm", "service": "kube-apiserver", "key": "service-cluster-ip-range",
     "target_service": None, "target_key": None, "kind": "impact", "rule_type": "impact",
     "reason": "컨트롤러 매니저의 service-cluster-ip-range 도 같은 값이어야 한다. 운영 중 변경은 기존 서비스 IP 와 충돌한다."},
    {"rule_key": "apiserver.restart_notice", "service": "kube-apiserver", "key": "*",
     "target_service": None, "target_key": None, "kind": "impact", "rule_type": "impact",
     "reason": "API 서버를 한 대씩 재시작한다 — 컨트롤 플레인이 1대면 재시작 동안 클러스터 API 를 쓸 수 없다."},
    {"rule_key": "kcm.burst_ge_qps", "service": "kube-controller-manager", "key": "kube-api-qps",
     "target_service": "kube-controller-manager", "target_key": "kube-api-burst", "kind": "recommend", "rule_type": "min_of_key",
     "reason": "버스트는 QPS 이상이어야 의미가 있다."},
    {"rule_key": "scheduler.burst_ge_qps", "service": "kube-scheduler", "key": "kube-api-qps",
     "target_service": "kube-scheduler", "target_key": "kube-api-burst", "kind": "recommend", "rule_type": "min_of_key",
     "reason": "버스트는 QPS 이상이어야 의미가 있다."},
    {"rule_key": "kubelet.gc_high_ge_low", "service": "kubelet", "key": "imageGCLowThresholdPercent",
     "target_service": "kubelet", "target_key": "imageGCHighThresholdPercent", "kind": "require", "rule_type": "min_of_key",
     "reason": "이미지 정리 시작 사용률은 목표 사용률보다 커야 한다(kubelet 이 기동을 거부한다)."},
    {"rule_key": "kubelet.systemd_requires_containerd", "service": "kubelet", "key": "cgroupDriver",
     "target_service": "containerd", "target_key": "SystemdCgroup", "kind": "require", "rule_type": "requires_when",
     "params": {"when": "systemd", "equals": "true"},
     "reason": "kubelet cgroupDriver=systemd 면 containerd 도 SystemdCgroup=true 여야 한다 — 다르면 노드가 NotReady 가 된다."},
    {"rule_key": "containerd.systemd_requires_kubelet", "service": "containerd", "key": "SystemdCgroup",
     "target_service": "kubelet", "target_key": "cgroupDriver", "kind": "require", "rule_type": "requires_when",
     "params": {"when": "true", "equals": "systemd"},
     "reason": "containerd SystemdCgroup=true 면 kubelet cgroupDriver 도 systemd 여야 한다."},
    {"rule_key": "kubelet.restart_notice", "service": "kubelet", "key": "*",
     "target_service": None, "target_key": None, "kind": "impact", "rule_type": "impact",
     "reason": "kubelet 을 재시작한다 — 실행 중인 파드는 유지되지만 재시작 동안 노드 상태 보고·새 파드 기동이 멈춘다."},
    {"rule_key": "nic.lro_off_forwarding", "service": "nic", "key": "offload.rx-lro",
     "target_service": "nic", "target_key": "offload.rx-lro", "kind": "recommend", "rule_type": "fixed_value",
     "params": {"value": "off"}, "reason": "LRO 는 패킷을 합쳐 받아 포워딩(Pod·서비스 트래픽)을 깨뜨린다 — K8S 노드는 off."},
    {"rule_key": "nic.hash_l34", "service": "nic", "key": "bond.xmit_hash_policy",
     "target_service": "nic", "target_key": "bond.xmit_hash_policy", "kind": "recommend", "rule_type": "fixed_value",
     "params": {"value": "layer3+4"}, "reason": "IP·포트 기준이라 여러 연결이 링크에 고르게 나뉜다."},
    {"rule_key": "nic.lacp_fast", "service": "nic", "key": "bond.lacp_rate",
     "target_service": "nic", "target_key": "bond.lacp_rate", "kind": "recommend", "rule_type": "fixed_value",
     "params": {"value": "fast"}, "reason": "1초마다 LACPDU 를 보내 스위치 쪽 장애를 3초 안에 감지한다."},
    {"rule_key": "nic.queue_reset_impact", "service": "nic", "key": "*",
     "target_service": None, "target_key": None, "kind": "impact", "rule_type": "impact",
     "reason": "ring·채널·offload 는 하위 인터페이스마다 큐를 다시 만든다 — 하나씩 바꾸고 LACP 재합류를 확인하므로 본딩은 끊기지 않는다(적용은 다음 단계)."},
    {"rule_key": "nic.tunnel_offload_cilium", "service": "nic", "key": "offload.tx-udp_tnl-segmentation",
     "target_service": None, "target_key": None, "kind": "impact", "rule_type": "impact",
     "reason": "끄면 CILIUM VXLAN/Geneve 송신을 CPU 가 나눠야 해 처리량이 떨어진다."},
    {"rule_key": "cilium.restart_notice", "service": "cilium", "key": "*",
     "target_service": None, "target_key": None, "kind": "impact", "rule_type": "impact",
     "reason": "cilium-config 변경은 cilium 에이전트(DaemonSet)를 롤링 재시작해야 반영된다 — 재시작 중 노드별로 잠시 정책 갱신이 멈춘다."},
]


def seed_rules(db: Session) -> int:
    from app.models.service_config import ServiceConfigRule

    existing = {k for (k,) in db.query(ServiceConfigRule.rule_key).all()}
    added = 0
    for spec in RULES:
        if spec["rule_key"] in existing:
            continue
        db.add(ServiceConfigRule(
            rule_key=spec["rule_key"], service=spec["service"], key=spec["key"],
            target_service=spec.get("target_service"), target_key=spec.get("target_key"), kind=spec["kind"],
            rule_type=spec["rule_type"], params=spec.get("params"), reason=spec.get("reason"), enabled=True,
        ))
        added += 1
    if added:
        db.commit()
    return added
