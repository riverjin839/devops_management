"""점검 매트릭스 런북 — "이 셀은 실제 운영 클러스터에서 무슨 명령을 어떤 순서로 도는가".

매트릭스의 셀(항목 × 클러스터)마다 다음을 조립해 UI 에 그대로 노출한다:

  - ``steps``    : 단계 흐름(메커니즘). deep_check 는 ``registry.get_step_plan`` 재사용.
  - ``commands`` : 대상 클러스터에 실제로 나가는 명령/호출. kubectl 서브프로세스,
                   K8s API(python SDK) 호출, HTTP 프로브, SSH 를 종류별로 구분한다.
  - ``inputs``   : 그 명령들에 실제로 꽂히는 파라미터/임계값(해당 클러스터 기준으로 해석).
  - ``notes``    : 사전 조건(권한/설치 여부)과 실패 시 상태 판정.

**정확성 계약** — 여기 적힌 명령은 체커 구현과 1:1 로 맞춰져 있다. 체커의 명령이 바뀌면
이 모듈의 해당 항목도 같은 커밋에서 바꾼다. 런타임에 실제로 나간 kubectl 명령은
``DeepCheckerBase._kubectl`` 이 수집해 실행 로그(``CheckMatrixRun.details._commands``)에
남으므로, 런북(설계)과 실행 로그(실측)를 나란히 비교할 수 있다.
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models import (
    Addon,
    CheckMatrixItem,
    CheckMatrixSourceType,
    Cluster,
    DeepCheckDefinition,
)

# 명령 종류 — UI 배지 색/아이콘 매핑용.
KIND_KUBECTL = "kubectl"    # backend 컨테이너에서 kubectl 서브프로세스 실행
KIND_K8S_API = "k8s_api"    # kubernetes python SDK → API 서버 REST 호출
KIND_HTTP = "http"          # httpx 로 대상 엔드포인트 직접 호출
KIND_SSH = "ssh"            # 대상 장비 SSH (Isilon 등)
KIND_DB = "db"              # 외부 호출 없이 PEP DB 만 조회


def _cmd(kind: str, command: str, description: str, *, readonly: bool = True) -> dict[str, Any]:
    return {"kind": kind, "command": command, "description": description, "readonly": readonly}


def _inputs(groups: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    """설정값을 **키가 아닌 값**으로 담은 리스트로 평탄화한다.

    프론트 axios 레이어가 응답 JSON 의 키를 전부 snake_case→camelCase 로 바꾸기 때문에,
    dict 로 내려보내면 `label_selector` 가 `labelSelector` 로 표시된다 — 운영자가 Ops Checks
    화면에서 실제로 입력해야 하는 이름과 달라져 런북의 존재 이유(사실성)를 깨뜨린다.
    이름을 값 자리에 두면 변환을 타지 않는다. 복합값은 JSON 문자열로 굳혀 같은 이유로 보호한다.
    """
    import json

    out: list[dict[str, str]] = []
    for group, values in groups.items():
        for name, value in (values or {}).items():
            if isinstance(value, (dict, list, tuple)):
                rendered = json.dumps(value, ensure_ascii=False)
            elif isinstance(value, bool):
                rendered = "true" if value else "false"
            elif value is None:
                rendered = ""
            else:
                rendered = str(value)
            out.append({"group": group, "name": str(name), "value": rendered})
    return out


# ──────────────────────────────────────────────────────────────
# core_bundle — DailyChecker.run_daily_check() 원자 실행
# ──────────────────────────────────────────────────────────────
def _core_bundle_commands(cluster: Optional[Cluster]) -> list[dict[str, Any]]:
    base = (cluster.api_endpoint if cluster and cluster.api_endpoint else "<api_endpoint>").rstrip("/")
    return [
        _cmd(KIND_HTTP, f"GET {base}/healthz",
             "API 서버 헬스 — 응답시간을 이 행의 셀 값(ms)으로 기록한다."),
        _cmd(KIND_HTTP, f"GET {base}/livez", "API 서버 liveness."),
        _cmd(KIND_HTTP, f"GET {base}/readyz", "API 서버 readiness."),
        _cmd(KIND_K8S_API,
             "list_namespaced_pod(kube-system, label_selector=component=kube-scheduler)",
             "스케줄러 파드 Running/Ready 수 — componentstatuses 가 제거된 1.27+ 대체 경로."),
        _cmd(KIND_K8S_API,
             "list_namespaced_pod(kube-system, label_selector=component=kube-controller-manager)",
             "컨트롤러 매니저 파드 Running/Ready 수."),
        _cmd(KIND_K8S_API, "list_node()", "전체 노드 Ready/NotReady 집계."),
        _cmd(KIND_K8S_API, "list_namespaced_pod(kube-system)", "kube-system 시스템 파드 상태 집계."),
    ]


_CORE_BUNDLE_STEPS = [
    {"id": "api_server", "label": "API 서버 프로브"},
    {"id": "components", "label": "컨트롤 플레인 컴포넌트"},
    {"id": "nodes", "label": "노드 상태"},
    {"id": "system_pods", "label": "kube-system 파드"},
    {"id": "verdict", "label": "종합 판정 · Cluster.status 갱신"},
]

_CORE_BUNDLE_NOTES = [
    "이 행은 `DailyChecker.run_daily_check()` 를 **원자적으로** 한 번 실행하고, 그중 "
    "/healthz 응답시간만 셀 값으로 투영한다. 네 개의 하위 점검을 따로 돌릴 수 없는 이유가 이것이다.",
    "`Cluster.status`(사이드바 클러스터 색)를 갱신하는 유일한 경로 — 그래서 항목별 cron 이 아니라 "
    "클러스터 열 헤더의 cron(`Cluster.check_cron_expr`)으로 스케줄한다.",
    "/healthz 가 200 이고 응답시간 3000ms 미만이면 정상, 200 이지만 3000ms 이상이면 경고, "
    "그 외(비200·연결 실패)는 위험.",
]


# ──────────────────────────────────────────────────────────────
# deep_check — check_type 별 실제 명령
# ──────────────────────────────────────────────────────────────
def _p(params: dict[str, Any], key: str, default: Any = "") -> Any:
    v = params.get(key, default)
    return default if v in (None, "") else v


def _deep_check_commands(check_type: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    if check_type == "cert_expiry":
        return [
            _cmd(KIND_K8S_API,
                 "list_namespaced_pod(kube-system, label_selector=component=kube-apiserver)",
                 "Running 상태인 apiserver 파드 1개를 exec 대상으로 고른다."),
            _cmd(KIND_KUBECTL,
                 "kubectl -n kube-system exec <apiserver-pod> -- kubeadm certs check-expiration",
                 "컨트롤 플레인 인증서 잔여일 출력을 파싱한다. exec 권한이나 kubeadm 이 없으면 대기(pending)."),
        ]
    if check_type == "etcd_defrag":
        return [
            _cmd(KIND_K8S_API,
                 "list_namespaced_pod(kube-system, label_selector=component=etcd)",
                 "Running etcd 파드 탐색 — 없으면 managed/external etcd 로 보고 대기 처리."),
            _cmd(KIND_KUBECTL,
                 "kubectl -n kube-system exec <etcd-pod> -- sh -c "
                 "'ETCDCTL_API=3 … etcdctl endpoint status -w json'",
                 "dbSize / dbSizeInUse 로 단편화율을 계산한다."),
            _cmd(KIND_KUBECTL,
                 "kubectl -n kube-system exec <etcd-pod> -- sh -c 'ETCDCTL_API=3 … etcdctl alarm list'",
                 "NOSPACE 등 etcd 알람 유무 확인."),
        ]
    if check_type == "cni_flow":
        return [
            _cmd(KIND_K8S_API,
                 "list_namespaced_pod(kube-system|cilium, label_selector=k8s-app=cilium)",
                 "Cilium 파드 탐색 — 없으면 미설치로 보고 대기 처리."),
            _cmd(KIND_KUBECTL,
                 f"kubectl -n kube-system exec ds/cilium -- hubble observe "
                 f"--last {_p(params, 'flow_limit', 1000)} "
                 f"--since {_p(params, 'last_seconds', 60)}s --output json",
                 "최근 관측 윈도의 플로우를 받아 DROPPED/ERROR 비율을 계산한다."),
        ]
    if check_type == "pvc_health":
        return [
            _cmd(KIND_K8S_API, "list_persistent_volume_claim_for_all_namespaces()",
                 "전체 PVC 조회 — Pending/Lost 를 집계."),
            _cmd(KIND_K8S_API, "list_persistent_volume()", "전체 PV 조회 — orphan(Released/Failed) 판별."),
        ]
    if check_type == "image_pull":
        return [
            _cmd(KIND_K8S_API, "list_pod_for_all_namespaces()",
                 "전 네임스페이스 파드의 containerStatuses 에서 ImagePullBackOff / ErrImagePull / "
                 "CrashLoopBackOff 를 집계."),
            _cmd(KIND_K8S_API,
                 f"read_namespaced_pod_log(<문제 파드>, tail_lines={_p(params, 'log_tail_lines', 20)})",
                 "문제 파드의 마지막 로그를 근거로 첨부."),
        ]
    if check_type == "audit_rbac":
        ns = _p(params, "audit_namespace", "kube-system")
        cm = _p(params, "audit_configmap_name", "audit-policy")
        return [
            _cmd(KIND_K8S_API, f"read_namespaced_config_map({cm}, {ns})",
                 "Audit policy ConfigMap 존재 확인."),
            _cmd(KIND_K8S_API, "RbacAuthorizationV1.list_cluster_role_binding()",
                 "cluster-admin 바인딩 주체 수를 세어 권한 과다(sprawl) 판정."),
        ]
    if check_type == "node_pressure":
        return [
            _cmd(KIND_K8S_API, "list_node()",
                 "노드 conditions 에서 DiskPressure / MemoryPressure / PIDPressure / "
                 "NetworkUnavailable / NotReady 를 집계."),
        ]
    if check_type == "coredns_health":
        ns = _p(params, "namespace", "kube-system")
        sel = _p(params, "label_selector", "k8s-app=kube-dns")
        return [
            _cmd(KIND_K8S_API, f"list_namespaced_pod({ns}, label_selector={sel})",
                 "CoreDNS 파드 Ready 비율 산출."),
            _cmd(KIND_K8S_API,
                 f"read_namespaced_pod_log(<coredns-pod>, {ns}, tail_lines={_p(params, 'log_tail_lines', 500)})",
                 "첫 파드 로그를 tail 해 error/failed 라인 비율을 계산."),
        ]
    if check_type == "stuck_terminating":
        return [
            _cmd(KIND_K8S_API, "list_pod_for_all_namespaces()",
                 "deletionTimestamp 가 찍힌 채 임계 시간을 넘긴 파드를 검출."),
        ]
    if check_type == "oom_events":
        return [
            _cmd(KIND_K8S_API,
                 "list_event_for_all_namespaces(field_selector=type=Warning)",
                 f"최근 {_p(params, 'window_hours', 24)}시간의 Warning 이벤트에서 "
                 "OOMKilling / Evicted / SystemOOM 을 집계."),
        ]
    if check_type == "node_health":
        node = _p(params, "node_name", "")
        ns = _p(params, "system_namespace", "kube-system")
        return [
            _cmd(KIND_K8S_API,
                 f"list_node({f'field_selector=metadata.name={node}' if node else '전체 노드'})",
                 "Ready / Pressure / Taint / Allocatable 검증."),
            _cmd(KIND_K8S_API, f"list_namespaced_pod({ns})",
                 "CNI(cilium/calico/flannel) · kube-proxy 데몬셋 파드 존재/Ready 검증."),
        ]
    if check_type == "external_to_pod":
        eps = _p(params, "endpoints", []) or []
        listed = ", ".join(str(e) for e in eps[:3]) if eps else "(미등록 → Cluster.api_endpoint 자동 사용)"
        return [
            _cmd(KIND_HTTP,
                 f"GET {listed}{'…' if len(eps) > 3 else ''} "
                 f"(probe path {_p(params, 'api_probe_path', '/healthz')}, "
                 f"timeout {_p(params, 'http_timeout_seconds', 5)}s)",
                 "PEP 백엔드(관리 클러스터)에서 대상 클러스터의 외부 노출 엔드포인트로 호출해 실패율 판정."),
        ]
    if check_type == "pod_to_pod":
        ns = _p(params, "probe_namespace", "devops")
        image = _p(params, "image", "busybox:1.36")
        return [
            _cmd(KIND_K8S_API, "list_pod_for_all_namespaces()",
                 f"워크로드 파드 중 최대 {_p(params, 'targets_max', 8)}개를 프로브 타깃으로 샘플링."),
            _cmd(KIND_KUBECTL,
                 f"kubectl run pod2pod-probe-<rand> -n {ns} --rm -i --restart=Never "
                 f"--image {image} -- sh -c 'nc -z -w {_p(params, 'per_probe_timeout', 3)} $ip $port'",
                 "**임시 파드를 생성**해 타깃 IP:포트로 TCP 프로브를 돌린다. "
                 f"{ns} 네임스페이스에 pods.create 권한이 필요하다.",
                 readonly=False),
            _cmd(KIND_KUBECTL,
                 f"kubectl delete pod pod2pod-probe-<rand> -n {ns} --ignore-not-found --wait=false",
                 "프로브 파드 정리 — timeout 으로 --rm 이 동작하지 못한 경우까지 항상 실행.",
                 readonly=False),
        ]
    if check_type == "kernel_param_drift":
        return [
            _cmd(KIND_DB,
                 "SELECT … FROM cluster_config_snapshots WHERE key LIKE 'kernel_params:%'",
                 "대상 클러스터에 접속하지 않는다 — 이미 수집돼 있는 연속 스냅샷 2개를 비교할 뿐이다. "
                 "사전에 커널 파라미터 수집이 최소 1회 필요하다."),
            _cmd(KIND_DB, "INSERT INTO os_param_changes …",
                 f"최근 {_p(params, 'recent_hours', 24)}시간 내 변경을 이력으로 기록"
                 f"({'켜짐' if _p(params, 'record_history', True) else '꺼짐'}).",
                 readonly=False),
        ]
    if check_type == "minio_health":
        eps = _p(params, "endpoints", []) or []
        listed = ", ".join(str(e) for e in eps[:3]) if eps else "(params.endpoints 미등록 → 대기)"
        return [
            _cmd(KIND_HTTP,
                 f"GET {listed}{_p(params, 'cluster_health_path', '/minio/health/cluster')}",
                 "쿼럼/degraded 판정 — 인증이 필요 없는 health 엔드포인트."),
            _cmd(KIND_HTTP,
                 f"GET {listed}{_p(params, 'live_health_path', '/minio/health/live')}",
                 "프로세스 liveness."),
        ]
    if check_type == "isilon_nfs":
        server = _p(params, "isilon_server_name", "") or "(기본 서버)"
        return [
            _cmd(KIND_SSH, f"ssh {server} 'isi nfs exports list / isi quota quotas list / isi status'",
                 "NAS 무부하를 위해 **읽기 전용 명령만** 단발 실행하고 서버별 60초 캐시한다. "
                 "수집 명령은 NFS 모니터링 화면에서 커스텀 등록할 수 있다."),
            _cmd(KIND_K8S_API, "list_persistent_volume()",
                 "spec.nfs 를 쓰는 PV 와 export 를 매칭해 K8s 가 실제로 쓰는 export 누락을 판정."),
        ]
    if check_type == "custom_http":
        eps = _p(params, "endpoints", []) or []
        listed = ", ".join(str(e) for e in eps[:5]) if eps else "(params.endpoints 미등록 → 대기)"
        return [
            _cmd(KIND_HTTP,
                 f"GET {listed}{'…' if len(eps) > 5 else ''} "
                 f"(expect {_p(params, 'expected_status', '200-399')}, "
                 f"timeout {_p(params, 'http_timeout_seconds', 5)}s)",
                 "URL 이면 HTTP status(+본문 정규식), host:port 면 TCP connect 로 성공/실패를 센다."),
        ]
    if check_type == "custom_kubectl":
        args = str(_p(params, "args", "")).strip()
        return [
            _cmd(KIND_KUBECTL,
                 f"kubectl {args}" if args else "kubectl <params.args 미설정 → 대기>",
                 f"출력을 `{_p(params, 'parse_mode', 'lines')}` 방식으로 파싱해 임계값과 비교한다. "
                 + ("읽기 전용 verb 제한이 **해제**되어 있다 — 변경 명령도 실행된다."
                    if _p(params, "allow_mutation", False)
                    else "get/describe 등 읽기 전용 verb 만 허용된다."),
                 readonly=not bool(_p(params, "allow_mutation", False))),
        ]
    if check_type == "custom_promql":
        return [
            _cmd(KIND_HTTP,
                 f"GET {_p(params, 'prometheus_url', '') or '<PROMETHEUS_URL>'}/api/v1/query"
                 f"?query={_p(params, 'query', '') or '<params.query 미설정 → 대기>'}",
                 f"instant 쿼리 결과를 `{_p(params, 'aggregate', 'max')}` 로 접어 임계값과 비교. "
                 "Prometheus 미도달은 대기(pending)."),
        ]
    return []


_DEEP_CHECK_NOTES = [
    "kubectl 계열 명령은 PEP 백엔드 컨테이너에서 `kubectl --kubeconfig <클러스터 kubeconfig> "
    "--server <api_endpoint> …` 형태로 실행된다.",
    "K8s API 항목은 kubernetes python SDK 호출이라 kubectl 바이너리 없이도 동작한다.",
    "연결 거부/타임아웃 같은 네트워크 실패는 위험이 아니라 **대기(pending)** 로 판정한다 — "
    "클러스터가 죽은 것과 PEP 가 못 닿는 것을 구분하기 위함이다.",
]


# ──────────────────────────────────────────────────────────────
# addon — Addon.type 별 HealthChecker 실제 동작
# ──────────────────────────────────────────────────────────────
def _addon_commands(addon_type: str, addon: Optional[Addon]) -> list[dict[str, Any]]:
    cfg = (addon.config if addon and isinstance(addon.config, dict) else {}) or {}

    def url(default: str) -> str:
        return str(cfg.get("url") or default).rstrip("/")

    if addon_type == "etcd-leader":
        return [
            _cmd(KIND_K8S_API, "list_namespaced_pod(kube-system, label_selector=component=etcd)",
                 "Running etcd 파드 탐색."),
            _cmd(KIND_K8S_API,
                 "connect_get_namespaced_pod_exec(<etcd-pod>, container=etcd, command=["
                 "etcdctl endpoint status --cacert=/etc/kubernetes/pki/etcd/ca.crt "
                 "--cert=…/server.crt --key=…/server.key --write-out=json])",
                 "파드 exec 스트림으로 etcdctl 을 돌려 리더/DB 크기를 읽는다. "
                 "exec 이 막히면 수집된 etcdctl 스냅샷으로 폴백한다."),
        ]
    if addon_type == "node-check":
        return [_cmd(KIND_K8S_API, "list_node()", "단 1회 호출로 전 노드 Ready/Pressure 집계.")]
    if addon_type == "control-plane":
        return [
            _cmd(KIND_K8S_API, "call_api('/livez', 'GET')",
                 "API 서버 liveness — 지연 3000ms 초과면 경고."),
            _cmd(KIND_K8S_API, "list_namespaced_pod(kube-system, label_selector=component=…)",
                 "scheduler / controller-manager 등 코어 컴포넌트 파드 Running+Ready 수."),
        ]
    if addon_type == "system-pod":
        return [
            _cmd(KIND_K8S_API, "list_namespaced_pod(kube-system, label_selector=<애드온 라벨>)",
                 "해당 시스템 컴포넌트 파드의 Running+Ready 비율. DaemonSet 이면 desired 대비로 판정."),
        ]
    if addon_type == "nexus":
        base = url("http://nexus.devops.svc:8081")
        return [
            _cmd(KIND_HTTP, f"GET {base}/service/rest/v1/status/writable", "쓰기 가능 여부."),
            _cmd(KIND_HTTP, f"GET {base}/service/rest/v1/status", "읽기 전용 상태 폴백 확인."),
        ]
    if addon_type == "jenkins":
        base = url("http://jenkins.devops.svc:8080")
        return [
            _cmd(KIND_HTTP, f"GET {base}/api/json", "Jenkins 응답/버전 — config 에 인증정보가 있으면 사용."),
            _cmd(KIND_HTTP, f"GET {base}/queue/api/json", "빌드 큐 길이."),
        ]
    if addon_type == "argocd":
        ns = str(cfg.get("namespace") or "argocd")
        return [
            _cmd(KIND_K8S_API,
                 f"list_namespaced_custom_object(argoproj.io/v1alpha1, {ns}, applications)",
                 "Application CR 을 조회해 Synced/Healthy 비율을 판정."),
        ]
    if addon_type == "keycloak":
        base = url("http://keycloak.auth.svc:8080")
        return [_cmd(KIND_HTTP, f"GET {base}/health/ready", "Keycloak readiness.")]
    return []


_ADDON_STEPS = [
    {"id": "resolve", "label": "클러스터의 애드온 인스턴스 해석"},
    {"id": "probe", "label": "애드온 프로브 실행"},
    {"id": "verdict", "label": "상태 판정 · Addon.status 갱신"},
]

_ADDON_NOTES = [
    "행의 `source_ref` 는 애드온 **타입**(논리 키)이고, 실제 대상은 실행 시점에 "
    "`Addon.type == source_ref AND Addon.cluster_id == <이 클러스터>` 로 해석된다. "
    "그 클러스터에 해당 애드온이 등록돼 있지 않으면 이 셀은 실행되지 않고 건너뜀(skipped)으로 남는다.",
    "애드온 점검은 `Addon.status` 를 갱신하고, 그 결과가 클러스터 전체 상태 재계산에 반영된다.",
    "URL 은 애드온의 `config.url` 을 쓰며, 비어 있으면 위에 적힌 클러스터 내부 기본 주소를 쓴다.",
]


# ──────────────────────────────────────────────────────────────
# 조립
# ──────────────────────────────────────────────────────────────
def _resolve_deep_check_definition(db: Session, check_type: str, cluster_id) -> Optional[DeepCheckDefinition]:
    d = (
        db.query(DeepCheckDefinition)
        .filter(DeepCheckDefinition.check_type == check_type, DeepCheckDefinition.cluster_id == cluster_id)
        .first()
    )
    if d is not None:
        return d
    return (
        db.query(DeepCheckDefinition)
        .filter(DeepCheckDefinition.check_type == check_type, DeepCheckDefinition.cluster_id.is_(None))
        .first()
    )


def build_runbook(db: Session, item: CheckMatrixItem, cluster: Cluster) -> dict[str, Any]:
    """셀(항목 × 클러스터)의 실행 계획. 실행하지 않고 조립만 한다(읽기 전용)."""
    out: dict[str, Any] = {
        "item_id": str(item.id),
        "item_name": item.name,
        "cluster_id": str(cluster.id),
        "cluster_name": cluster.name,
        "source_type": item.source_type.value,
        "source_ref": item.source_ref,
        "target": None,          # 이 클러스터에서 해석된 실제 실행 대상
        "runnable": False,       # "지금 실행" 가능 여부
        "blocked_reason": None,  # runnable=False 인 이유
        "steps": [],
        "commands": [],
        "inputs": [],
        "notes": [],
        "kubectl_prefix": None,
    }

    if item.source_type == CheckMatrixSourceType.core_bundle:
        out["target"] = f"DailyChecker.run_daily_check({cluster.name})"
        out["runnable"] = True
        out["steps"] = _CORE_BUNDLE_STEPS
        out["commands"] = _core_bundle_commands(cluster)
        out["notes"] = _CORE_BUNDLE_NOTES
        out["inputs"] = _inputs({"cluster": {
            "api_endpoint": cluster.api_endpoint,
            "tls_verify": bool(getattr(cluster, "tls_verify", False)),
            "check_cron_expr": cluster.check_cron_expr,
        }})
        return out

    if item.source_type == CheckMatrixSourceType.deep_check:
        from app.services.deep_checkers.registry import REGISTRY, get_step_plan

        entry = REGISTRY.get(item.source_ref or "")
        spec = entry[1] if entry else None
        definition = _resolve_deep_check_definition(db, item.source_ref or "", cluster.id)
        params = dict((definition.params if definition else None) or {})
        thresholds = dict((definition.thresholds if definition else None) or {})
        if spec is not None:
            params = {**(spec.default_params or {}), **params}
            thresholds = {**(spec.default_thresholds or {}), **thresholds}

        out["steps"] = get_step_plan(item.source_ref or "")
        out["commands"] = _deep_check_commands(item.source_ref or "", params)
        out["inputs"] = _inputs({"params": params, "thresholds": thresholds})
        out["notes"] = list(_DEEP_CHECK_NOTES)
        out["kubectl_prefix"] = (
            f"kubectl --kubeconfig <{cluster.name} kubeconfig>"
            + (f" --server {cluster.api_endpoint}" if cluster.api_endpoint else "")
        )
        if spec is not None:
            out["notes"].insert(0, spec.description)
        if definition is None:
            out["blocked_reason"] = (
                f"이 클러스터에 `{item.source_ref}` 점검 정의가 없습니다 — 글로벌 정의도 없습니다. "
                "운영 점검(Ops Checks) 화면에서 정의를 만들면 이 셀이 실행됩니다."
            )
        else:
            out["target"] = (
                f"DeepCheckDefinition «{definition.name}»"
                f" ({'이 클러스터 전용' if definition.cluster_id else '글로벌'}"
                f"{'' if definition.enabled else ' · 비활성'})"
            )
            out["runnable"] = True
            if not definition.enabled:
                out["notes"].append(
                    "이 정의는 비활성(enabled=false) 상태라 cron 자동 실행은 되지 않는다 — "
                    "수동 '지금 실행'은 가능하다.",
                )
        return out

    if item.source_type == CheckMatrixSourceType.addon:
        addon = (
            db.query(Addon)
            .filter(Addon.type == item.source_ref, Addon.cluster_id == cluster.id)
            .first()
        )
        out["steps"] = _ADDON_STEPS
        out["commands"] = _addon_commands(item.source_ref or "", addon)
        out["notes"] = list(_ADDON_NOTES)
        if addon is None:
            out["blocked_reason"] = (
                f"이 클러스터에 `{item.source_ref}` 타입 애드온이 등록돼 있지 않습니다 — "
                "클러스터 상세 화면에서 애드온을 등록하면 이 셀이 실행됩니다."
            )
        else:
            out["target"] = f"Addon «{addon.name}» (type={addon.type})"
            out["runnable"] = True
            out["inputs"] = _inputs({"config": addon.config or {}})
        return out

    # manual
    out["target"] = "수동 입력 (자동 실행 없음)"
    out["runnable"] = False
    out["blocked_reason"] = "수동 입력 항목입니다 — 셀 상세의 '값 입력'으로 값을 기록하세요."
    out["steps"] = [
        {"id": "input", "label": "운영자 값 입력"},
        {"id": "record", "label": "결과 upsert · 이력 append"},
    ]
    out["commands"] = [
        _cmd(KIND_DB, "INSERT INTO check_matrix_result_logs / UPSERT check_matrix_results",
             "대상 클러스터에는 아무 명령도 나가지 않는다. 운영자가 넣은 값을 그대로 셀에 기록할 뿐이다.",
             readonly=False),
    ]
    out["notes"] = [
        "PEP 에 자동 체커가 없는 대상(NAS 콘솔, 네트워크 스위치, 외주 점검 결과 등)을 "
        "같은 매트릭스 위에서 함께 보기 위한 행이다.",
        "입력한 값도 자동 점검과 똑같이 이력에 쌓이므로 추이 차트와 변경 이력이 동일하게 동작한다.",
        "cron 을 설정할 수 없다 — 값이 없으면 셀은 계속 '—'(미실행)로 남는다.",
    ]
    return out
