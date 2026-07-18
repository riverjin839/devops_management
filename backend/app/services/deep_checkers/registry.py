"""Deep checker 레지스트리.

``check_type`` 문자열을 클래스에 매핑하고, UI 가 동적 form 을 그릴 수 있도록
파라미터/임계값 스키마를 함께 노출한다.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.services.deep_checkers.audit_rbac_checker import AuditRbacChecker
from app.services.deep_checkers.base import DeepCheckerBase
from app.services.deep_checkers.cert_expiry_checker import CertExpiryChecker
from app.services.deep_checkers.cni_flow_checker import CniFlowChecker
from app.services.deep_checkers.coredns_health_checker import CoreDnsHealthChecker
from app.services.deep_checkers.custom_http_checker import CustomHttpChecker
from app.services.deep_checkers.custom_kubectl_checker import CustomKubectlChecker
from app.services.deep_checkers.custom_promql_checker import CustomPromqlChecker
from app.services.deep_checkers.etcd_defrag_checker import EtcdDefragChecker
from app.services.deep_checkers.external_to_pod_checker import ExternalToPodChecker
from app.services.deep_checkers.image_pull_checker import ImagePullChecker
from app.services.deep_checkers.isilon_nfs_checker import IsilonNfsChecker
from app.services.deep_checkers.kernel_param_drift_checker import KernelParamDriftChecker
from app.services.deep_checkers.minio_health_checker import MinioHealthChecker
from app.services.deep_checkers.node_health_checker import NodeHealthChecker
from app.services.deep_checkers.node_pressure_checker import NodePressureChecker
from app.services.deep_checkers.oom_events_checker import OomEventsChecker
from app.services.deep_checkers.pod_to_pod_checker import PodToPodChecker
from app.services.deep_checkers.pvc_health_checker import PvcHealthChecker
from app.services.deep_checkers.stuck_terminating_checker import StuckTerminatingChecker


@dataclass
class DeepCheckFieldSpec:
    name: str
    type: str  # "int" | "float" | "string" | "boolean" | "list"
    label: str
    default: Any = None
    help: str | None = None


@dataclass
class DeepCheckTypeSpec:
    check_type: str
    display_name: str
    description: str
    threshold_fields: list[DeepCheckFieldSpec] = field(default_factory=list)
    param_fields: list[DeepCheckFieldSpec] = field(default_factory=list)
    default_thresholds: dict[str, Any] = field(default_factory=dict)
    default_params: dict[str, Any] = field(default_factory=dict)
    # 운영 점검 콘솔 그룹핑용 도메인 — os | k8s | storage | network | app.
    # 신규 checker 는 자신의 도메인을 선언만 하면 콘솔 카탈로그에 자동 분류된다.
    category: str = "k8s"
    # 기본 시드 시 enabled 여부 — 위험/무거운 점검은 False 로 등록만 해두고 운영자가 켠다.
    default_enabled: bool = True
    # False 면 부팅 시 글로벌 정의/체크매트릭스 자동 시드에서 제외 — custom_* 처럼
    # "같은 check_type 으로 여러 인스턴스를 admin 이 직접 만드는" 템플릿형 체커용.
    seed_default: bool = True


REGISTRY: dict[str, tuple[type[DeepCheckerBase], DeepCheckTypeSpec]] = {
    "cert_expiry": (
        CertExpiryChecker,
        DeepCheckTypeSpec(
            check_type="cert_expiry",
            display_name="K8s 인증서 만료",
            description="kubeadm certs check-expiration 으로 컨트롤 플레인 인증서 잔여일 점검",
            threshold_fields=[
                DeepCheckFieldSpec("warning_days", "int", "경고 (일)", 30,
                                   help="잔여일이 이 값 이하면 warning"),
                DeepCheckFieldSpec("critical_days", "int", "심각 (일)", 7,
                                   help="잔여일이 이 값 이하면 critical"),
            ],
            default_thresholds={"warning_days": 30, "critical_days": 7},
            default_params={},
        ),
    ),
    "etcd_defrag": (
        EtcdDefragChecker,
        DeepCheckTypeSpec(
            check_type="etcd_defrag",
            display_name="etcd 단편화 / 알람",
            description="etcdctl endpoint status + alarm list 로 단편화율과 alarm 점검",
            threshold_fields=[
                DeepCheckFieldSpec("warning_fragmentation_pct", "float", "단편화 경고 (%)", 30),
                DeepCheckFieldSpec("critical_fragmentation_pct", "float", "단편화 심각 (%)", 50),
            ],
            default_thresholds={
                "warning_fragmentation_pct": 30,
                "critical_fragmentation_pct": 50,
            },
            default_params={},
        ),
    ),
    "cni_flow": (
        CniFlowChecker,
        DeepCheckTypeSpec(
            check_type="cni_flow",
            display_name="Cilium Hubble flow",
            description="최근 N초간 Hubble 플로우 중 DROPPED/ERROR 비율 점검",
            threshold_fields=[
                DeepCheckFieldSpec("warning_drop_pct", "float", "drop 경고 (%)", 2),
                DeepCheckFieldSpec("critical_drop_pct", "float", "drop 심각 (%)", 5),
            ],
            param_fields=[
                DeepCheckFieldSpec("last_seconds", "int", "관측 윈도 (초)", 60),
                DeepCheckFieldSpec("flow_limit", "int", "최대 flow 수", 1000),
            ],
            default_thresholds={"warning_drop_pct": 2, "critical_drop_pct": 5},
            default_params={"last_seconds": 60, "flow_limit": 1000},
            category="network",
        ),
    ),
    "pvc_health": (
        PvcHealthChecker,
        DeepCheckTypeSpec(
            check_type="pvc_health",
            display_name="PVC / PV 상태",
            description="Pending/Lost PVC 와 orphan PV 점검",
            threshold_fields=[
                DeepCheckFieldSpec("warning_pending", "int", "Pending 경고 (건)", 1),
                DeepCheckFieldSpec("critical_pending", "int", "Pending 심각 (건)", 5),
            ],
            default_thresholds={"warning_pending": 1, "critical_pending": 5},
            default_params={},
            category="storage",
        ),
    ),
    "image_pull": (
        ImagePullChecker,
        DeepCheckTypeSpec(
            check_type="image_pull",
            display_name="ImagePull / CrashLoop",
            description="ImagePullBackOff / ErrImagePull / CrashLoopBackOff 카운트",
            threshold_fields=[
                DeepCheckFieldSpec("warning_pull_failures", "int", "이미지 풀 경고 (건)", 1),
                DeepCheckFieldSpec("critical_pull_failures", "int", "이미지 풀 심각 (건)", 5),
                DeepCheckFieldSpec("warning_crash_loops", "int", "CrashLoop 경고 (건)", 1),
                DeepCheckFieldSpec("critical_crash_loops", "int", "CrashLoop 심각 (건)", 5),
            ],
            param_fields=[
                DeepCheckFieldSpec("log_tail_lines", "int", "로그 tail 라인 수", 20),
            ],
            default_thresholds={
                "warning_pull_failures": 1,
                "critical_pull_failures": 5,
                "warning_crash_loops": 1,
                "critical_crash_loops": 5,
            },
            default_params={"log_tail_lines": 20},
        ),
    ),
    "audit_rbac": (
        AuditRbacChecker,
        DeepCheckTypeSpec(
            check_type="audit_rbac",
            display_name="Audit / RBAC sprawl",
            description="Audit policy ConfigMap 존재와 cluster-admin 수 점검",
            threshold_fields=[
                DeepCheckFieldSpec("warning_cluster_admins", "int", "cluster-admin 경고 (명)", 5),
                DeepCheckFieldSpec("critical_cluster_admins", "int", "cluster-admin 심각 (명)", 15),
            ],
            param_fields=[
                DeepCheckFieldSpec("audit_namespace", "string", "Audit ConfigMap 네임스페이스", "kube-system"),
                DeepCheckFieldSpec("audit_configmap_name", "string", "Audit ConfigMap 이름", "audit-policy"),
            ],
            default_thresholds={
                "warning_cluster_admins": 5,
                "critical_cluster_admins": 15,
            },
            default_params={
                "audit_namespace": "kube-system",
                "audit_configmap_name": "audit-policy",
            },
        ),
    ),
    "node_pressure": (
        NodePressureChecker,
        DeepCheckTypeSpec(
            check_type="node_pressure",
            display_name="노드 Pressure / Condition",
            description="DiskPressure / MemoryPressure / PIDPressure / NetworkUnavailable / NotReady 점검",
            threshold_fields=[
                DeepCheckFieldSpec("warning_count", "int", "영향 노드 경고 (개)", 1),
                DeepCheckFieldSpec("critical_count", "int", "영향 노드 심각 (개)", 3),
            ],
            default_thresholds={"warning_count": 1, "critical_count": 3},
            default_params={},
        ),
    ),
    "coredns_health": (
        CoreDnsHealthChecker,
        DeepCheckTypeSpec(
            check_type="coredns_health",
            display_name="CoreDNS 상태",
            description="kube-dns 파드 Ready 비율 + 최근 로그에서 error/failed 라인 비율",
            threshold_fields=[
                DeepCheckFieldSpec("warning_error_rate_pct", "float", "에러율 경고 (%)", 1),
                DeepCheckFieldSpec("critical_error_rate_pct", "float", "에러율 심각 (%)", 5),
            ],
            param_fields=[
                DeepCheckFieldSpec("namespace", "string", "네임스페이스", "kube-system"),
                DeepCheckFieldSpec("label_selector", "string", "Pod label selector", "k8s-app=kube-dns"),
                DeepCheckFieldSpec("log_tail_lines", "int", "로그 tail 라인 수", 500),
            ],
            default_thresholds={
                "warning_error_rate_pct": 1,
                "critical_error_rate_pct": 5,
            },
            default_params={
                "namespace": "kube-system",
                "label_selector": "k8s-app=kube-dns",
                "log_tail_lines": 500,
            },
        ),
    ),
    "stuck_terminating": (
        StuckTerminatingChecker,
        DeepCheckTypeSpec(
            check_type="stuck_terminating",
            display_name="Stuck Terminating Pods",
            description="Terminating 상태로 N분 이상 머무는 pod 검출",
            threshold_fields=[
                DeepCheckFieldSpec("warning_minutes", "int", "경고 (분)", 5),
                DeepCheckFieldSpec("critical_minutes", "int", "심각 (분)", 30),
            ],
            default_thresholds={"warning_minutes": 5, "critical_minutes": 30},
            default_params={},
        ),
    ),
    "oom_events": (
        OomEventsChecker,
        DeepCheckTypeSpec(
            check_type="oom_events",
            display_name="OOM / Evicted 이벤트",
            description="최근 N시간 Warning 이벤트 중 OOMKilling / Evicted / SystemOOM 카운트",
            threshold_fields=[
                DeepCheckFieldSpec("warning_count", "int", "경고 (건)", 1),
                DeepCheckFieldSpec("critical_count", "int", "심각 (건)", 5),
            ],
            param_fields=[
                DeepCheckFieldSpec("window_hours", "int", "관측 윈도 (시간)", 24),
            ],
            default_thresholds={"warning_count": 1, "critical_count": 5},
            default_params={"window_hours": 24},
        ),
    ),
    "external_to_pod": (
        ExternalToPodChecker,
        DeepCheckTypeSpec(
            check_type="external_to_pod",
            display_name="외부 → 내부 Pod 호출",
            description=(
                "관리 backend (DevOps Management 가 기동된 클러스터) 에서 대상 클러스터의 "
                "외부 노출 endpoint (URL 또는 host:port) 로 호출을 시도해 실패율 점검. "
                "endpoints 가 비면 Cluster.api_endpoint + api_probe_path 를 자동 사용."
            ),
            threshold_fields=[
                DeepCheckFieldSpec("warning_failure_pct", "float", "실패율 경고 (%)", 10),
                DeepCheckFieldSpec("critical_failure_pct", "float", "실패율 심각 (%)", 30),
            ],
            param_fields=[
                DeepCheckFieldSpec("endpoints", "list", "추가 endpoint (URL 또는 host:port, 줄바꿈 구분)", []),
                DeepCheckFieldSpec("api_probe_path", "string", "api_endpoint 자동 probe 경로", "/healthz"),
                DeepCheckFieldSpec("http_timeout_seconds", "int", "HTTP/TCP timeout (초)", 5),
                DeepCheckFieldSpec("per_endpoint_retries", "int", "endpoint 당 재시도 횟수", 0),
                DeepCheckFieldSpec("verify_tls", "boolean", "TLS 인증서 검증", False),
                DeepCheckFieldSpec("caller_label", "string", "호출자(외부) 라벨", "management-cluster (devops_management)"),
            ],
            default_thresholds={"warning_failure_pct": 10, "critical_failure_pct": 30},
            default_params={
                "endpoints": [],
                "api_probe_path": "/healthz",
                "http_timeout_seconds": 5,
                "per_endpoint_retries": 0,
                "verify_tls": False,
                "caller_label": "management-cluster (devops_management)",
            },
            category="network",
        ),
    ),
    "pod_to_pod": (
        PodToPodChecker,
        DeepCheckTypeSpec(
            check_type="pod_to_pod",
            display_name="Pod-to-pod 연결성",
            description=(
                "일회용 busybox 파드를 띄워 무작위 워크로드 파드 IP:포트 로 "
                "nc TCP probe 를 돌려 실패율 점검 (pods.create 권한 필요)"
            ),
            threshold_fields=[
                DeepCheckFieldSpec("warning_failure_pct", "float", "실패율 경고 (%)", 10),
                DeepCheckFieldSpec("critical_failure_pct", "float", "실패율 심각 (%)", 30),
            ],
            param_fields=[
                DeepCheckFieldSpec("targets_max", "int", "샘플링할 타깃 pod 개수", 8),
                DeepCheckFieldSpec("per_probe_timeout", "int", "probe 1건 timeout (초)", 3),
                DeepCheckFieldSpec("probe_namespace", "string", "probe pod 가 생성될 namespace", "devops"),
                DeepCheckFieldSpec("image", "string", "probe 컨테이너 이미지", "busybox:1.36"),
                DeepCheckFieldSpec("skip_host_network", "boolean", "hostNetwork pod 제외", True),
                DeepCheckFieldSpec("namespaces", "list", "대상 namespace 화이트리스트 (빈값=전체)", []),
            ],
            default_thresholds={"warning_failure_pct": 10, "critical_failure_pct": 30},
            default_params={
                "targets_max": 8,
                "per_probe_timeout": 3,
                "probe_namespace": "devops",
                "image": "busybox:1.36",
                "skip_host_network": True,
                "namespaces": [],
            },
            category="network",
        ),
    ),
    "kernel_param_drift": (
        KernelParamDriftChecker,
        DeepCheckTypeSpec(
            check_type="kernel_param_drift",
            display_name="OS 파라미터 변경 점검",
            description=(
                "노드별 sysctl/커널 파라미터가 직전 수집 대비 바뀌었는지 점검. "
                "SSH·파드 없이 이미 수집된 ClusterConfigSnapshot(kernel_params:{host})의 "
                "연속 스냅샷만 비교하고, 변경 내역을 OsParamChange 이력에 기록한다. "
                "사전에 커널 파라미터 수집이 한 번 이상 필요."
            ),
            threshold_fields=[
                DeepCheckFieldSpec("warning_changes", "int", "경고 (최근 변경 건수)", 1),
                DeepCheckFieldSpec("critical_changes", "int", "심각 (최근 변경 건수)", 20),
            ],
            param_fields=[
                DeepCheckFieldSpec("recent_hours", "int", "최근 변경 판정 윈도 (시간)", 24),
                DeepCheckFieldSpec("record_history", "boolean", "변경 이력 DB 기록", True),
                DeepCheckFieldSpec("max_report", "int", "결과에 표시할 최대 변경 수", 50),
            ],
            default_thresholds={"warning_changes": 1, "critical_changes": 20},
            default_params={"recent_hours": 24, "record_history": True, "max_report": 50},
            category="os",
            default_enabled=False,
        ),
    ),
    "minio_health": (
        MinioHealthChecker,
        DeepCheckTypeSpec(
            check_type="minio_health",
            display_name="MinIO 스토리지 health",
            description=(
                "MinIO 의 인증 불필요 health 엔드포인트(/minio/health/cluster·live)를 호출해 "
                "쿼럼/degraded 여부 점검. params.endpoints 에 MinIO base URL 등록 필요. "
                "drive/capacity 상세는 mc admin/Prometheus 연동(후속)."
            ),
            threshold_fields=[
                DeepCheckFieldSpec("warning_failure_pct", "float", "경고 실패율 (%)", 1),
                DeepCheckFieldSpec("critical_failure_pct", "float", "심각 실패율 (%)", 50),
            ],
            param_fields=[
                DeepCheckFieldSpec("endpoints", "list", "MinIO base URL 목록", []),
                DeepCheckFieldSpec("cluster_health_path", "string", "cluster health 경로", "/minio/health/cluster"),
                DeepCheckFieldSpec("live_health_path", "string", "live health 경로", "/minio/health/live"),
                DeepCheckFieldSpec("http_timeout_seconds", "int", "timeout (초)", 5),
                DeepCheckFieldSpec("verify_tls", "boolean", "TLS 검증", False),
            ],
            default_thresholds={"warning_failure_pct": 1, "critical_failure_pct": 50},
            default_params={
                "endpoints": [],
                "cluster_health_path": "/minio/health/cluster",
                "live_health_path": "/minio/health/live",
                "http_timeout_seconds": 5,
                "verify_tls": False,
            },
            category="storage",
            default_enabled=False,
        ),
    ),
    "isilon_nfs": (
        IsilonNfsChecker,
        DeepCheckTypeSpec(
            check_type="isilon_nfs",
            display_name="Isilon NFS (NAS)",
            description=(
                "Isilon(OneFS) NAS 에 SSH 접속해 isi 명령으로 NFS export 가용성·쿼터 사용률·"
                "노드/서비스 health 를 수집하고 K8s PV(spec.nfs) 와 매칭해 판정. "
                "NAS 무부하 위해 읽기전용 명령만·단발 실행·서버별 60s 캐시. "
                "수집 명령은 NFS 모니터링 페이지에서 커스텀 등록 가능. "
                "접속정보 미설정이면 pending. 권장 스케줄 15~30분."
            ),
            threshold_fields=[
                DeepCheckFieldSpec("warning_quota_pct", "float", "쿼터 경고 (%)", 80),
                DeepCheckFieldSpec("critical_quota_pct", "float", "쿼터 심각 (%)", 95),
            ],
            param_fields=[
                DeepCheckFieldSpec("isilon_server_name", "string", "Isilon 서버 이름(비우면 기본)", ""),
                DeepCheckFieldSpec("nfs_pv_only", "boolean", "K8s 가 쓰는 export 누락만 critical 판정", True),
            ],
            default_thresholds={"warning_quota_pct": 80, "critical_quota_pct": 95},
            default_params={"isilon_server_name": "", "nfs_pv_only": True},
            category="storage",
            default_enabled=False,
        ),
    ),
    "node_health": (
        NodeHealthChecker,
        DeepCheckTypeSpec(
            check_type="node_health",
            display_name="노드 추가 검증 (기본+네트워킹)",
            description="신규/조인 노드의 Ready·Pressure·Taint·Allocatable 과 CNI/kube-proxy 데몬셋을 "
                        "READ-ONLY 로 검증. node_name 비우면 전체 노드.",
            threshold_fields=[
                DeepCheckFieldSpec("warning_count", "int", "이상 노드 경고 (개)", 1,
                                   help="이상 노드 수가 이 값 이상이면 warning"),
                DeepCheckFieldSpec("critical_count", "int", "이상 노드 심각 (개)", 1,
                                   help="이상 노드 수가 이 값 이상이면 critical (NotReady 는 항상 critical)"),
            ],
            param_fields=[
                DeepCheckFieldSpec("node_name", "string", "대상 노드(비우면 전체)", "",
                                   help="특정 노드만 검증할 때 노드명"),
                DeepCheckFieldSpec("require_cni", "boolean", "CNI 데몬셋 필수", True),
                DeepCheckFieldSpec("require_kube_proxy", "boolean", "kube-proxy 필수", True),
                DeepCheckFieldSpec("system_namespace", "string", "시스템 네임스페이스", "kube-system"),
                DeepCheckFieldSpec("cni_label_selectors", "list", "CNI label 셀렉터",
                                   ["k8s-app=cilium", "k8s-app=calico-node", "app=flannel"]),
            ],
            default_thresholds={"warning_count": 1, "critical_count": 1},
            default_params={
                "node_name": "",
                "require_cni": True,
                "require_kube_proxy": True,
                "system_namespace": "kube-system",
                "cni_label_selectors": ["k8s-app=cilium", "k8s-app=calico-node", "app=flannel"],
            },
            category="k8s",
            default_enabled=True,
        ),
    ),
    # ── 커스텀(템플릿형) 체커 — admin 이 UI 에서 params 만으로 새 점검을 정의 ──
    "custom_http": (
        CustomHttpChecker,
        DeepCheckTypeSpec(
            check_type="custom_http",
            display_name="커스텀 HTTP/TCP 프로브",
            description=(
                "params.endpoints 의 URL(http/https)/host:port 를 프로브해 실패율·지연을 "
                "판정하는 범용 점검. 같은 타입으로 대상별 정의를 여러 개 만들어 쓴다."
            ),
            threshold_fields=[
                DeepCheckFieldSpec("warning_failure_pct", "float", "실패율 경고 (%)", 1),
                DeepCheckFieldSpec("critical_failure_pct", "float", "실패율 심각 (%)", 50),
                DeepCheckFieldSpec("warning_latency_ms", "int", "지연 경고 (ms, 0=미사용)", 0),
                DeepCheckFieldSpec("critical_latency_ms", "int", "지연 심각 (ms, 0=미사용)", 0),
            ],
            param_fields=[
                DeepCheckFieldSpec("endpoints", "list", "대상 endpoint (URL 또는 host:port)", []),
                DeepCheckFieldSpec("expected_status", "string", "기대 HTTP status 범위", "200-399",
                                   help='예: "200-399" 또는 "200"'),
                DeepCheckFieldSpec("body_regex", "string", "본문 정규식 (선택)", "",
                                   help="지정 시 응답 본문이 이 정규식과 매치해야 성공"),
                DeepCheckFieldSpec("http_timeout_seconds", "int", "timeout (초)", 5),
                DeepCheckFieldSpec("verify_tls", "boolean", "TLS 인증서 검증", False),
            ],
            default_thresholds={
                "warning_failure_pct": 1,
                "critical_failure_pct": 50,
                "warning_latency_ms": 0,
                "critical_latency_ms": 0,
            },
            default_params={
                "endpoints": [],
                "expected_status": "200-399",
                "body_regex": "",
                "http_timeout_seconds": 5,
                "verify_tls": False,
            },
            category="network",
            default_enabled=False,
            seed_default=False,
        ),
    ),
    "custom_kubectl": (
        CustomKubectlChecker,
        DeepCheckTypeSpec(
            check_type="custom_kubectl",
            display_name="커스텀 kubectl 점검",
            description=(
                "params.args 의 kubectl 명령(기본 읽기 전용 verb 만)을 대상 클러스터에서 "
                "실행하고 출력(라인 수/숫자/정규식 매치 수)을 임계값과 비교하는 범용 점검."
            ),
            threshold_fields=[
                DeepCheckFieldSpec("warning_value", "float", "경고 임계값", 1),
                DeepCheckFieldSpec("critical_value", "float", "심각 임계값", 5),
                DeepCheckFieldSpec("compare", "string", "비교 방향 (gte|lte)", "gte",
                                   help="gte: 값이 임계 이상이면 이상 / lte: 값이 임계 이하이면 이상"),
            ],
            param_fields=[
                DeepCheckFieldSpec("args", "string", "kubectl 인자", "",
                                   help="예: get pods -A --field-selector=status.phase=Failed -o name"),
                DeepCheckFieldSpec("parse_mode", "string", "파싱 방식 (lines|number|regex_count)", "lines"),
                DeepCheckFieldSpec("pattern", "string", "정규식 (regex_count 용)", ""),
                DeepCheckFieldSpec("timeout_seconds", "int", "timeout (초)", 30),
                DeepCheckFieldSpec("allow_mutation", "boolean", "읽기 전용 verb 제한 해제", False,
                                   help="켜면 get/describe 외 verb 도 허용 — 주의해서 사용"),
            ],
            default_thresholds={"warning_value": 1, "critical_value": 5, "compare": "gte"},
            default_params={
                "args": "",
                "parse_mode": "lines",
                "pattern": "",
                "timeout_seconds": 30,
                "allow_mutation": False,
            },
            category="k8s",
            default_enabled=False,
            seed_default=False,
        ),
    ),
    "custom_promql": (
        CustomPromqlChecker,
        DeepCheckTypeSpec(
            check_type="custom_promql",
            display_name="커스텀 PromQL 점검",
            description=(
                "params.query 의 PromQL instant 쿼리 결과를 aggregate(max/min/sum/avg/count) 로 "
                "접어 임계값과 비교하는 범용 점검. Prometheus 도달 불가는 pending."
            ),
            threshold_fields=[
                DeepCheckFieldSpec("warning_value", "float", "경고 임계값", 1),
                DeepCheckFieldSpec("critical_value", "float", "심각 임계값", 5),
                DeepCheckFieldSpec("compare", "string", "비교 방향 (gte|lte)", "gte",
                                   help="gte: 값이 임계 이상이면 이상 / lte: 값이 임계 이하이면 이상"),
            ],
            param_fields=[
                DeepCheckFieldSpec("query", "string", "PromQL 쿼리", "",
                                   help='예: sum(kube_pod_status_phase{phase="Failed"})'),
                DeepCheckFieldSpec("aggregate", "string", "집계 (max|min|sum|avg|count)", "max"),
                DeepCheckFieldSpec("prometheus_url", "string", "Prometheus URL (비우면 기본)", ""),
                DeepCheckFieldSpec("timeout_seconds", "int", "timeout (초)", 10),
            ],
            default_thresholds={"warning_value": 1, "critical_value": 5, "compare": "gte"},
            default_params={
                "query": "",
                "aggregate": "max",
                "prometheus_url": "",
                "timeout_seconds": 10,
            },
            category="app",
            default_enabled=False,
            seed_default=False,
        ),
    ),
}


def get_checker_class(check_type: str) -> type[DeepCheckerBase] | None:
    entry = REGISTRY.get(check_type)
    return entry[0] if entry else None


def list_check_types() -> list[dict[str, Any]]:
    """UI 에서 동적 form 을 그리기 위한 직렬화."""
    out: list[dict[str, Any]] = []
    for ct, (_, spec) in REGISTRY.items():
        out.append({
            "check_type": ct,
            "display_name": spec.display_name,
            "description": spec.description,
            "category": spec.category,
            "threshold_fields": [_field_to_dict(f) for f in spec.threshold_fields],
            "param_fields": [_field_to_dict(f) for f in spec.param_fields],
            "default_thresholds": spec.default_thresholds,
            "default_params": spec.default_params,
            # UI 그룹핑용 — False 면 admin 이 인스턴스를 직접 만드는 커스텀(템플릿형) 타입.
            "seed_default": spec.seed_default,
        })
    return out


def _field_to_dict(f: DeepCheckFieldSpec) -> dict[str, Any]:
    return {
        "name": f.name,
        "type": f.type,
        "label": f.label,
        "default": f.default,
        "help": f.help,
    }


# ── 메커니즘(단계 plan) — 각 check_type 이 내부적으로 무슨 일을 하는지 문서화 ──────
# 계측되지 않은 체커도 이 plan 으로 "어떻게 동작하는지"를 UI 에 항상 보여줄 수 있다.
# 계측된 체커는 실시간 step(id 일치) 상태가 plan 위에 덧칠된다.
STEP_PLANS: dict[str, list[tuple[str, str]]] = {
    "cert_expiry": [
        ("locate_pod", "컨트롤플레인 파드 탐색"),
        ("exec_kubeadm", "kubeadm certs check-expiration 실행"),
        ("parse", "인증서 잔여일 파싱"),
        ("verdict", "최소 잔여일 임계 비교"),
    ],
    "etcd_defrag": [
        ("locate_pod", "etcd 파드 탐색"),
        ("exec_status", "etcdctl endpoint status 실행"),
        ("exec_alarm", "etcdctl alarm list 실행"),
        ("parse", "db size 파싱 · 단편화율 계산"),
        ("verdict", "단편화/알람 임계 비교"),
    ],
    "pvc_health": [
        ("list_pvc", "PVC 전체 조회"),
        ("list_pv", "PV 전체 조회"),
        ("filter", "Pending/Lost PVC · orphan PV 필터"),
        ("verdict", "임계 비교"),
    ],
    "pod_to_pod": [
        ("list_pods", "워크로드 파드 조회"),
        ("sample", "프로브 대상 샘플링"),
        ("probe_pod", "임시 프로브 파드 생성"),
        ("probe", "대상 파드 nc 프로브"),
        ("parse", "성공/실패 집계"),
        ("verdict", "실패율 임계 비교"),
    ],
    "image_pull": [("list_pods", "파드 조회"), ("scan", "ImagePullBackOff/ErrImagePull 스캔"), ("verdict", "임계 비교")],
    "node_pressure": [("list_nodes", "노드 조회"), ("scan", "Memory/Disk/PID Pressure 컨디션 스캔"), ("verdict", "임계 비교")],
    "node_health": [
        ("list_nodes", "노드 조회"),
        ("list_system_pods", "kube-system 파드 조회"),
        ("evaluate", "Ready/Pressure/Taint/Allocatable/네트워킹 평가"),
        ("verdict", "임계 비교"),
    ],
    "oom_events": [("list_events", "이벤트 조회"), ("scan", "OOMKilled 집계"), ("verdict", "임계 비교")],
    "stuck_terminating": [("list_pods", "파드 조회"), ("scan", "Terminating 지연 스캔"), ("verdict", "임계 비교")],
    "coredns_health": [("locate", "CoreDNS 파드 탐색"), ("probe", "DNS 질의 프로브"), ("verdict", "응답 임계 비교")],
    "audit_rbac": [("list_rbac", "RBAC 조회"), ("scan", "과도 권한/위험 바인딩 스캔"), ("verdict", "판정")],
    "cni_flow": [("locate", "CNI 파드 탐색"), ("probe", "flow/연결 점검"), ("verdict", "판정")],
    "external_to_pod": [("resolve", "외부→파드 경로 해석"), ("probe", "도달성 프로브"), ("verdict", "판정")],
    "kernel_param_drift": [("collect", "노드 sysctl 수집"), ("compare", "기준값 대비 드리프트"), ("verdict", "판정")],
    "minio_health": [("connect", "MinIO 연결"), ("probe", "health/버킷 점검"), ("verdict", "판정")],
    "isilon_nfs": [
        ("ssh_connect", "Isilon 서버 조회 · SSH 수집(캐시)"),
        ("match_k8s_pv", "K8s NFS PV ↔ export 매칭"),
        ("verdict", "가용성 · 쿼터 · health 판정"),
    ],
    "custom_http": [
        ("resolve", "대상 endpoint 해석"),
        ("probe", "endpoint 프로브"),
        ("verdict", "실패율 · 지연 임계 비교"),
    ],
    "custom_kubectl": [
        ("validate", "명령 검증"),
        ("exec", "kubectl 실행"),
        ("parse", "출력 파싱"),
        ("verdict", "임계 비교"),
    ],
    "custom_promql": [
        ("query", "PromQL instant 쿼리"),
        ("parse", "결과 집계"),
        ("verdict", "임계 비교"),
    ],
}


def get_step_plan(check_type: str) -> list[dict[str, str]]:
    """check_type 의 단계 plan(메커니즘). 미정의면 빈 리스트."""
    return [{"id": sid, "label": lbl} for sid, lbl in STEP_PLANS.get(check_type, [])]
