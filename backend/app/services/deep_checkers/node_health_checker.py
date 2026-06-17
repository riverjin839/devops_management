"""노드 추가 검증 — 신규/조인 노드가 정상(이상없음)인지 READ-ONLY 로 점검.

노드별로 다음을 검증한다(전부 K8s API 읽기):
- Ready 컨디션
- Pressure(DiskPressure/MemoryPressure/PIDPressure) · NetworkUnavailable
- 차단 taint(node.kubernetes.io/not-ready·unreachable·unschedulable) / spec.unschedulable
- allocatable cpu·memory > 0
- 핵심 DaemonSet(CNI: cilium/calico/flannel · kube-proxy) 파드가 그 노드에서 Running (= 네트워킹 준비)

params.node_name 이 있으면 그 노드만(노드별 '검증' 버튼 / sync 직후 자동검증), 비우면 전체 노드
(Ops-check 콘솔 / cron). 어느 쪽이든 끝까지 수행해 무결성을 보장한다.
"""
from __future__ import annotations

from typing import Any, Optional

from kubernetes.utils import parse_quantity

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)

_PRESSURE_TYPES = ("DiskPressure", "MemoryPressure", "PIDPressure")
_BLOCKING_TAINTS = (
    "node.kubernetes.io/not-ready",
    "node.kubernetes.io/unreachable",
    "node.kubernetes.io/unschedulable",
)
# CNI 데몬셋 family 탐지: (family, pod 이름 prefix 들, label 매칭(key,value) 들)
_CNI_FAMILIES = (
    ("cilium", ("cilium",), (("k8s-app", "cilium"),)),
    ("calico-node", ("calico-node",), (("k8s-app", "calico-node"),)),
    ("kube-flannel", ("kube-flannel", "flannel"), (("app", "flannel"),)),
)


def _qty_gt0(value: Optional[str]) -> bool:
    if not value:
        return False
    try:
        return parse_quantity(value) > 0
    except Exception:  # noqa: BLE001
        return False


def _pod_running_ready(pod: Any) -> bool:
    """파드가 Running 이고 컨테이너가 모두 ready 면 True (statuses 없으면 phase 만 본다)."""
    phase = pod.status.phase if pod.status else None
    if phase != "Running":
        return False
    statuses = (pod.status.container_statuses or []) if pod.status else []
    if not statuses:
        return True
    return all(bool(cs.ready) for cs in statuses)


def _pod_matches(pod: Any, prefixes: tuple, labels_match: tuple) -> bool:
    name = pod.metadata.name if pod.metadata else ""
    labels = (pod.metadata.labels or {}) if pod.metadata else {}
    for k, v in labels_match:
        if labels.get(k) == v:
            return True
    for p in prefixes:
        # cilium-operator(Deployment)는 per-node agent 가 아니므로 제외
        if name.startswith(p) and "operator" not in name:
            return True
    return False


class NodeHealthChecker(DeepCheckerBase):
    check_type = "node_health"
    display_name = "노드 추가 검증 (기본+네트워킹)"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_count = int(ctx.thresholds.get("warning_count", 1))
        critical_count = int(ctx.thresholds.get("critical_count", 1))
        node_name = (ctx.params.get("node_name") or "").strip()
        require_cni = bool(ctx.params.get("require_cni", True))
        require_kube_proxy = bool(ctx.params.get("require_kube_proxy", True))
        system_ns = ctx.params.get("system_namespace") or "kube-system"

        v1 = self._v1(ctx)

        # 1) 노드 조회 (단일 / 전체)
        with self._step("list_nodes", "노드 조회") as st:
            if node_name:
                nodes = v1.list_node(
                    field_selector=f"metadata.name={node_name}", timeout_seconds=15
                ).items
                if not nodes:
                    st.detail = f"노드 없음: {node_name}"
                    return DeepCheckOutcome(
                        status=StatusEnum.pending,
                        message=f"노드 없음: {node_name} (아직 조인 중일 수 있음)",
                        details={"scope": "single", "node_name": node_name, "found": False,
                                 "total_nodes": 0, "nodes": []},
                    )
            else:
                nodes = v1.list_node(timeout_seconds=15).items
            st.detail = f"{len(nodes)}개 노드"

        # 2) kube-system 파드 1회 조회 → node 별 그룹핑 (네트워킹 데몬셋 판정용)
        with self._step("list_system_pods", "kube-system 파드 조회") as st:
            pods = v1.list_namespaced_pod(system_ns, timeout_seconds=15).items
            by_node: dict[str, list[Any]] = {}
            for p in pods:
                nn = p.spec.node_name if p.spec else None
                if nn:
                    by_node.setdefault(nn, []).append(p)
            st.detail = f"{len(pods)}개 파드 ({system_ns})"

        # 3) 노드별 평가
        with self._step("evaluate", "Ready/Pressure/Taint/Allocatable/네트워킹 평가"):
            checklist = [
                self._evaluate_node(n, by_node, require_cni, require_kube_proxy)
                for n in nodes
            ]

        # 4) 판정
        with self._step("verdict", "임계 비교") as st:
            unhealthy = [c for c in checklist if not c["ok"]]
            any_not_ready = any(not c["ready"] for c in checklist)
            if not unhealthy:
                status = StatusEnum.healthy
            elif len(unhealthy) >= critical_count or any_not_ready:
                status = StatusEnum.critical
            elif len(unhealthy) >= warning_count:
                status = StatusEnum.warning
            else:
                status = StatusEnum.healthy
            st.detail = f"이상 {len(unhealthy)}/{len(checklist)}"

        if node_name:
            entry = checklist[0]
            msg = f"{node_name}: 정상" if entry["ok"] else f"{node_name}: 이상 — {self._reasons(entry)}"
        else:
            msg = f"노드 {len(checklist)} 중 이상 {len(unhealthy)}개"

        return DeepCheckOutcome(
            status=status,
            message=msg,
            details={
                "scope": "single" if node_name else "all",
                "node_name": node_name or None,
                "total_nodes": len(checklist),
                "unhealthy_count": len(unhealthy),
                "warning_count": warning_count,
                "critical_count": critical_count,
                "nodes": checklist,
            },
        )

    # ── 내부 ──────────────────────────────────────────────────────────
    def _evaluate_node(self, n: Any, by_node: dict, require_cni: bool,
                       require_kube_proxy: bool) -> dict[str, Any]:
        name = n.metadata.name if n.metadata else "unknown"
        conditions = (n.status.conditions or []) if n.status else []
        ready = False
        pressure: list[str] = []
        for c in conditions:
            if c.type == "Ready":
                ready = (c.status == "True")
            elif c.type in _PRESSURE_TYPES and c.status == "True":
                pressure.append(c.type)
            elif c.type == "NetworkUnavailable" and c.status != "False":
                pressure.append("NetworkUnavailable")

        taints: list[str] = []
        spec = n.spec
        for t in (spec.taints or []) if spec else []:
            if t.key in _BLOCKING_TAINTS:
                taints.append(t.key)
        if spec and spec.unschedulable:
            taints.append("spec.unschedulable")

        alloc = (n.status.allocatable or {}) if n.status else {}
        cpu_q, mem_q = alloc.get("cpu"), alloc.get("memory")
        allocatable_ok = _qty_gt0(cpu_q) and _qty_gt0(mem_q)

        net = self._networking(by_node.get(name, []), require_cni, require_kube_proxy)

        ok = (
            ready and not pressure and not taints and allocatable_ok
            and (not require_cni or net["cni"])
            and (not require_kube_proxy or net["kube_proxy"])
        )
        return {
            "node": name,
            "ready": ready,
            "pressure": pressure,
            "taints": taints,
            "allocatable_ok": allocatable_ok,
            "allocatable": {"cpu": cpu_q, "memory": mem_q},
            "networking": net,
            "ok": ok,
        }

    def _networking(self, node_pods: list[Any], require_cni: bool,
                    require_kube_proxy: bool) -> dict[str, Any]:
        cni_ok = False
        cni_family: Optional[str] = None
        for family, prefixes, labels_match in _CNI_FAMILIES:
            matched = [p for p in node_pods if _pod_matches(p, prefixes, labels_match)]
            if matched:
                running = any(_pod_running_ready(p) for p in matched)
                if running and not cni_ok:
                    cni_ok, cni_family = True, family
                elif cni_family is None:
                    cni_family = family  # 발견했으나 미실행

        kp_pods = [
            p for p in node_pods
            if _pod_matches(p, ("kube-proxy",), (("k8s-app", "kube-proxy"),))
        ]
        kube_proxy = any(_pod_running_ready(p) for p in kp_pods)

        present: list[str] = []
        if cni_ok and cni_family:
            present.append(cni_family)
        if kube_proxy:
            present.append("kube-proxy")
        missing: list[str] = []
        if require_cni and not cni_ok:
            missing.append(f"cni:{cni_family}" if cni_family else "cni")
        if require_kube_proxy and not kube_proxy:
            missing.append("kube-proxy")

        return {
            "cni": cni_ok,
            "cni_family": cni_family,
            "kube_proxy": kube_proxy,
            "present": present,
            "missing": missing,
        }

    @staticmethod
    def _reasons(entry: dict[str, Any]) -> str:
        r: list[str] = []
        if not entry["ready"]:
            r.append("NotReady")
        if entry["pressure"]:
            r.append("Pressure(" + ",".join(entry["pressure"]) + ")")
        if entry["taints"]:
            r.append("Taint(" + ",".join(entry["taints"]) + ")")
        if not entry["allocatable_ok"]:
            r.append("allocatable")
        if entry["networking"]["missing"]:
            r.append("net(" + ",".join(entry["networking"]["missing"]) + ")")
        return ", ".join(r) or "unknown"
