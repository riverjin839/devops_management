"""서비스 구성 — 서비스 정의와 관리 대상 설정 시드.

서비스 목록(``SERVICES``)은 화면 레일 순서·라벨·현재 값 출처를 정한다. 항목(``ITEMS``)은 DB(``service_config_items``)로
시드되고 운영자가 화면에서 다루는 원본은 DB 행이다 — ``seed_catalog`` 는 (service, key) 가 없을 때만 넣어
운영자가 고친 행을 덮지 않는다.

``source_keys`` — 현재 값을 어디서 읽는지:
- etcd       : ``{"flag": "<--플래그 이름>", "env": "<ETCD_ 환경변수>"}`` (정적 파드 플래그 · systemd env 파일)
- containerd : ``{"paths": ["<평탄화 경로>", ...]}`` — config v2/v3 경로 차이 때문에 후보를 차례로 본다
- cilium     : ``{"key": "<cilium-config 키>"}``
- linux      : ``{"key": "<sysctl 이름>"}``
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
]
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


def _os(section, key, label, vtype="int", default=None, help_=None, scope="immediate"):
    return {"service": "linux", "section": section, "key": key, "label": label, "value_type": vtype,
            "default_value": default, "help": help_, "restart_scope": scope, "source_keys": {"key": key}}


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
