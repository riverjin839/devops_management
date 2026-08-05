"""Audit policy / RBAC sprawl 점검.

* kube-system 의 audit policy ConfigMap 존재 여부 (없으면 warning)
* cluster-admin Role 을 부여받은 ServiceAccount / User 수가 임계 초과면 warning
"""
from __future__ import annotations

from typing import Any

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)


class AuditRbacChecker(DeepCheckerBase):
    check_type = "audit_rbac"
    display_name = "Audit / RBAC 점검"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_admins = int(ctx.thresholds.get("warning_cluster_admins", 5))
        critical_admins = int(ctx.thresholds.get("critical_cluster_admins", 15))
        audit_cm_name = ctx.params.get("audit_configmap_name", "audit-policy")

        v1 = self._v1(ctx)

        # Audit policy CM (관행: kube-system 또는 사용자 지정 ns)
        audit_ns_candidates = [
            ctx.params.get("audit_namespace") or "kube-system",
            "kube-system",
        ]
        audit_found = False
        for ns in audit_ns_candidates:
            if not ns:
                continue
            try:
                v1.read_namespaced_config_map(audit_cm_name, ns)
                audit_found = True
                break
            except Exception:
                continue

        # ClusterRoleBinding 점검 — cluster-admin 대상자 수
        from kubernetes import client

        rbac = self._wrap_api(client.RbacAuthorizationV1Api(api_client=v1.api_client))
        try:
            crbs = rbac.list_cluster_role_binding(timeout_seconds=15)
        except Exception:
            return DeepCheckOutcome(
                status=StatusEnum.pending,
                message="ClusterRoleBinding 조회 권한이 없습니다.",
                details={"reason": "rbac_list_denied"},
            )

        admins: list[dict[str, Any]] = []
        for crb in crbs.items:
            role_ref = crb.role_ref
            if not role_ref or role_ref.name != "cluster-admin":
                continue
            for subj in (crb.subjects or []):
                admins.append({
                    "kind": subj.kind,
                    "name": subj.name,
                    "namespace": getattr(subj, "namespace", None),
                    "binding": crb.metadata.name,
                })

        n = len(admins)
        status = StatusEnum.healthy
        msg_parts: list[str] = []
        if not audit_found:
            status = StatusEnum.warning
            msg_parts.append("audit policy ConfigMap 미발견")
        if n >= critical_admins:
            status = StatusEnum.critical
            msg_parts.append(f"cluster-admin {n}명")
        elif n >= warning_admins and status != StatusEnum.critical:
            status = StatusEnum.warning
            msg_parts.append(f"cluster-admin {n}명")
        else:
            msg_parts.append(f"cluster-admin {n}명")

        return DeepCheckOutcome(
            status=status,
            message=", ".join(msg_parts),
            details={
                "audit_configmap_found": audit_found,
                "audit_configmap_name": audit_cm_name,
                "cluster_admin_count": n,
                "cluster_admins": admins[:50],
            },
        )
