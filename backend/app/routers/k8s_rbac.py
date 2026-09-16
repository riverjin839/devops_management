"""K8s RBAC 관리 — ServiceAccount / Role / ClusterRole / Binding 생성·편집·회수.

개발자가 **자기 LOCAL 에서** 클러스터에 붙어 배포하고 로그를 보게 하려면 SA·권한·바인딩·
kubeconfig 를 한 세트로 만들어 줘야 한다. 이 라우터는 그 세트를 화면에서 만들고(`/provision`),
만들어진 오브젝트를 목록·편집·삭제하고, 마지막에 "정말 되는지" 를 API server 에 물어보는
권한 점검(`/access-review`)까지 제공한다.

실행 계열(`/provision/stream`)은 SSE 로 단계별 로그를 실시간 중계한다 — 이 SSE 본문은 axios
인터셉터를 타지 않고 fetch+reader 로 직접 소비되므로 **snake_case 원문 JSON** 을 보낸다
(`agent.py` 의 `/chat/stream` 과 같은 규약).
"""
from __future__ import annotations

import json
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from kubernetes.client.rest import ApiException
from sqlalchemy.orm import Session

from app.auth.deps import require_operator
from app.database import get_db
from app.models.cluster import Cluster
from app.models.user import User
from app.schemas.k8s_rbac import (
    AccessReviewRequest,
    AccessReviewResponse,
    BindingCreateRequest,
    BindingListResponse,
    BindingResponse,
    KubeconfigRequest,
    KubeconfigResponse,
    NamespaceListResponse,
    PresetCatalogResponse,
    ProvisionRequest,
    ProvisionResult,
    RoleListResponse,
    RoleResponse,
    RoleUpsertRequest,
    ServiceAccountCreateRequest,
    ServiceAccountListResponse,
    ServiceAccountResponse,
)
from app.services import audit_logger
from app.services.k8s_rbac_presets import BINDING_MODES, PRESETS
from app.services.k8s_rbac_service import (
    RbacService,
    default_access_checks,
    map_k8s_error,
)

router = APIRouter(prefix="/clusters/{cluster_id}/rbac", tags=["k8s-rbac"])

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


def _service(cluster_id: UUID, db: Session) -> tuple[Cluster, RbacService]:
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return cluster, RbacService(cluster)


def _raise(e: Exception) -> None:
    """K8s/검증 예외를 HTTP 로 변환 — 사유를 그대로 노출한다(빈 500 금지)."""
    if isinstance(e, ValueError):
        raise HTTPException(status_code=422, detail=str(e))
    if isinstance(e, ApiException):
        status_code, detail = map_k8s_error(e)
        raise HTTPException(status_code=status_code, detail=detail)
    raise HTTPException(status_code=500, detail=str(e) or "RBAC 작업에 실패했습니다.")


# ── 카탈로그 ───────────────────────────────────────────────────────────────
@router.get("/presets", response_model=PresetCatalogResponse)
def get_presets(cluster_id: UUID):
    """권한 프리셋 + 바인딩 방식 카탈로그. 화면은 이걸 편집 가능한 규칙 표로 펼친다."""
    return PresetCatalogResponse(presets=PRESETS, binding_modes=BINDING_MODES)


@router.get("/namespaces", response_model=NamespaceListResponse)
def list_namespaces(cluster_id: UUID, db: Session = Depends(get_db)):
    _, svc = _service(cluster_id, db)
    try:
        return NamespaceListResponse(data=svc.list_namespaces())
    except Exception as e:  # noqa: BLE001
        _raise(e)


# ── ServiceAccount ────────────────────────────────────────────────────────
@router.get("/service-accounts", response_model=ServiceAccountListResponse)
def list_service_accounts(
    cluster_id: UUID,
    namespace: Optional[str] = Query(None, description="비우면 전체 네임스페이스"),
    db: Session = Depends(get_db),
):
    _, svc = _service(cluster_id, db)
    try:
        return ServiceAccountListResponse(data=svc.list_service_accounts(namespace))
    except Exception as e:  # noqa: BLE001
        _raise(e)


@router.post("/service-accounts", response_model=ServiceAccountResponse)
def create_service_account(
    cluster_id: UUID,
    payload: ServiceAccountCreateRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cluster, svc = _service(cluster_id, db)
    try:
        data = svc.create_service_account(
            payload.namespace, payload.name, payload.labels, payload.annotations
        )
    except Exception as e:  # noqa: BLE001
        _raise(e)
    audit_logger.record(
        db,
        action="k8s_rbac.service_account.create",
        actor=actor,
        target_type="cluster",
        target_id=cluster.id,
        details={"namespace": payload.namespace, "name": payload.name, "cluster": cluster.name},
        request=request,
    )
    return ServiceAccountResponse(message="ServiceAccount 를 생성했습니다.", data=data)


@router.delete("/service-accounts/{namespace}/{name}")
def delete_service_account(
    cluster_id: UUID,
    namespace: str,
    name: str,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cluster, svc = _service(cluster_id, db)
    try:
        svc.delete_service_account(namespace, name)
    except Exception as e:  # noqa: BLE001
        _raise(e)
    audit_logger.record(
        db,
        action="k8s_rbac.service_account.delete",
        actor=actor,
        target_type="cluster",
        target_id=cluster.id,
        details={"namespace": namespace, "name": name, "cluster": cluster.name},
        request=request,
    )
    return {"message": f"ServiceAccount {namespace}/{name} 를 삭제했습니다."}


# ── Role / ClusterRole ────────────────────────────────────────────────────
@router.get("/roles", response_model=RoleListResponse)
def list_roles(
    cluster_id: UUID,
    namespace: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    _, svc = _service(cluster_id, db)
    try:
        return RoleListResponse(data=svc.list_roles(namespace))
    except Exception as e:  # noqa: BLE001
        _raise(e)


@router.get("/cluster-roles", response_model=RoleListResponse)
def list_cluster_roles(
    cluster_id: UUID,
    include_system: bool = Query(False, description="system:* 빌트인 롤 포함 여부"),
    db: Session = Depends(get_db),
):
    _, svc = _service(cluster_id, db)
    try:
        return RoleListResponse(data=svc.list_cluster_roles(include_system))
    except Exception as e:  # noqa: BLE001
        _raise(e)


@router.put("/roles/{namespace}/{name}", response_model=RoleResponse)
def upsert_role(
    cluster_id: UUID,
    namespace: str,
    name: str,
    payload: RoleUpsertRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """Role 생성 또는 덮어쓰기 — 화면의 규칙 편집기가 그대로 PUT 한다."""
    cluster, svc = _service(cluster_id, db)
    try:
        data = svc.upsert_role(
            namespace, name, [r.model_dump() for r in payload.rules], payload.labels
        )
    except Exception as e:  # noqa: BLE001
        _raise(e)
    audit_logger.record(
        db,
        action="k8s_rbac.role.upsert",
        actor=actor,
        target_type="cluster",
        target_id=cluster.id,
        details={
            "namespace": namespace,
            "name": name,
            "rule_count": len(payload.rules),
            "cluster": cluster.name,
        },
        request=request,
    )
    return RoleResponse(message=f"Role {namespace}/{name} 을(를) 저장했습니다.", data=data)


@router.put("/cluster-roles/{name}", response_model=RoleResponse)
def upsert_cluster_role(
    cluster_id: UUID,
    name: str,
    payload: RoleUpsertRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cluster, svc = _service(cluster_id, db)
    try:
        data = svc.upsert_cluster_role(name, [r.model_dump() for r in payload.rules], payload.labels)
    except Exception as e:  # noqa: BLE001
        _raise(e)
    audit_logger.record(
        db,
        action="k8s_rbac.cluster_role.upsert",
        actor=actor,
        target_type="cluster",
        target_id=cluster.id,
        details={"name": name, "rule_count": len(payload.rules), "cluster": cluster.name},
        request=request,
    )
    return RoleResponse(message=f"ClusterRole {name} 을(를) 저장했습니다.", data=data)


@router.delete("/roles/{namespace}/{name}")
def delete_role(
    cluster_id: UUID,
    namespace: str,
    name: str,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cluster, svc = _service(cluster_id, db)
    try:
        svc.delete_role(namespace, name)
    except Exception as e:  # noqa: BLE001
        _raise(e)
    audit_logger.record(
        db,
        action="k8s_rbac.role.delete",
        actor=actor,
        target_type="cluster",
        target_id=cluster.id,
        details={"namespace": namespace, "name": name, "cluster": cluster.name},
        request=request,
    )
    return {"message": f"Role {namespace}/{name} 을(를) 삭제했습니다."}


@router.delete("/cluster-roles/{name}")
def delete_cluster_role(
    cluster_id: UUID,
    name: str,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cluster, svc = _service(cluster_id, db)
    try:
        svc.delete_cluster_role(name)
    except Exception as e:  # noqa: BLE001
        _raise(e)
    audit_logger.record(
        db,
        action="k8s_rbac.cluster_role.delete",
        actor=actor,
        target_type="cluster",
        target_id=cluster.id,
        details={"name": name, "cluster": cluster.name},
        request=request,
    )
    return {"message": f"ClusterRole {name} 을(를) 삭제했습니다."}


# ── Binding ───────────────────────────────────────────────────────────────
@router.get("/bindings", response_model=BindingListResponse)
def list_bindings(
    cluster_id: UUID,
    namespace: Optional[str] = Query(None),
    include_system: bool = Query(False),
    db: Session = Depends(get_db),
):
    _, svc = _service(cluster_id, db)
    try:
        return BindingListResponse(data=svc.list_bindings(namespace, include_system))
    except Exception as e:  # noqa: BLE001
        _raise(e)


@router.post("/bindings", response_model=BindingResponse)
def create_binding(
    cluster_id: UUID,
    payload: BindingCreateRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cluster, svc = _service(cluster_id, db)
    try:
        data = svc.create_binding(
            kind=payload.kind,
            name=payload.name,
            role_kind=payload.role_kind,
            role_name=payload.role_name,
            subjects=[s.model_dump() for s in payload.subjects],
            namespace=payload.namespace,
            labels=payload.labels,
        )
    except Exception as e:  # noqa: BLE001
        _raise(e)
    audit_logger.record(
        db,
        action="k8s_rbac.binding.upsert",
        actor=actor,
        target_type="cluster",
        target_id=cluster.id,
        details={
            "kind": payload.kind,
            "name": payload.name,
            "namespace": payload.namespace,
            "role": f"{payload.role_kind}/{payload.role_name}",
            "cluster": cluster.name,
        },
        request=request,
    )
    return BindingResponse(message=f"{payload.kind} {payload.name} 을(를) 저장했습니다.", data=data)


@router.delete("/bindings/{kind}/{name}")
def delete_binding(
    cluster_id: UUID,
    kind: str,
    name: str,
    request: Request,
    namespace: Optional[str] = Query(None, description="RoleBinding 일 때 필수"),
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    cluster, svc = _service(cluster_id, db)
    try:
        svc.delete_binding(kind, name, namespace)
    except Exception as e:  # noqa: BLE001
        _raise(e)
    audit_logger.record(
        db,
        action="k8s_rbac.binding.delete",
        actor=actor,
        target_type="cluster",
        target_id=cluster.id,
        details={"kind": kind, "name": name, "namespace": namespace, "cluster": cluster.name},
        request=request,
    )
    return {"message": f"{kind} {name} 을(를) 삭제했습니다."}


# ── 권한 점검 ──────────────────────────────────────────────────────────────
@router.post("/access-review", response_model=AccessReviewResponse)
def access_review(
    cluster_id: UUID,
    payload: AccessReviewRequest,
    db: Session = Depends(get_db),
):
    """"이 SA 로 정말 배포·로그 조회가 되나" 를 API server 의 SubjectAccessReview 로 확인."""
    _, svc = _service(cluster_id, db)
    namespaces = payload.namespaces or [payload.namespace]
    checks = (
        [c.model_dump() for c in payload.checks]
        if payload.checks
        else default_access_checks(namespaces)
    )
    try:
        data = svc.access_review(
            payload.namespace, payload.service_account, checks, sa_namespace=payload.namespace
        )
    except Exception as e:  # noqa: BLE001
        _raise(e)
    return AccessReviewResponse(data=data)


# ── kubeconfig 발급 ───────────────────────────────────────────────────────
@router.post("/kubeconfig", response_model=KubeconfigResponse)
def issue_kubeconfig(
    cluster_id: UUID,
    payload: KubeconfigRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """기존 SA 의 토큰을 발급해 개발자가 LOCAL 에 둘 kubeconfig 를 만든다."""
    cluster, svc = _service(cluster_id, db)
    try:
        if payload.long_lived_token:
            token_info = svc.issue_long_lived_token(payload.namespace, payload.service_account)
        else:
            token_info = svc.issue_token(
                payload.namespace, payload.service_account, payload.token_ttl_seconds
            )
        kubeconfig = svc.build_kubeconfig(
            payload.namespace, payload.service_account, token_info["token"], payload.context_name
        )
        server, _, _ = svc.cluster_endpoint()
    except Exception as e:  # noqa: BLE001
        _raise(e)
    audit_logger.record(
        db,
        action="k8s_rbac.kubeconfig.issue",
        actor=actor,
        target_type="cluster",
        target_id=cluster.id,
        details={
            "namespace": payload.namespace,
            "service_account": payload.service_account,
            "mode": token_info.get("mode"),
            "expires_at": token_info.get("expires_at"),
            "cluster": cluster.name,
        },
        request=request,
    )
    return KubeconfigResponse(
        kubeconfig=kubeconfig,
        expires_at=token_info.get("expires_at"),
        mode=token_info.get("mode", "ephemeral"),
        server=server,
        namespace=payload.namespace,
        service_account=payload.service_account,
    )


# ── 프로비저닝 (SA + 권한 + 바인딩 + kubeconfig) ─────────────────────────
def _provision_spec(payload: ProvisionRequest) -> dict:
    spec = payload.model_dump()
    spec["rules"] = [r.model_dump() for r in payload.rules]
    return spec


def _audit_provision(
    db: Session, cluster: Cluster, actor: User, payload: ProvisionRequest, request: Request, status: str
) -> None:
    audit_logger.record(
        db,
        action="k8s_rbac.provision",
        actor=actor,
        status=status,
        target_type="cluster",
        target_id=cluster.id,
        details={
            "namespace": payload.namespace,
            "service_account": payload.service_account,
            "extra_namespaces": payload.extra_namespaces,
            "binding_mode": payload.binding_mode,
            "preset": payload.preset_key,
            "dry_run": payload.dry_run,
            "cluster": cluster.name,
        },
        request=request,
    )


@router.post("/provision", response_model=ProvisionResult)
def provision(
    cluster_id: UUID,
    payload: ProvisionRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """일괄 생성 — 비스트리밍. 로그는 결과의 `logs` 에 전부 담겨 온다."""
    cluster, svc = _service(cluster_id, db)
    logs: list[dict] = []
    result: dict | None = None
    try:
        for event in svc.provision(_provision_spec(payload)):
            if event.get("type") == "log":
                logs.append(
                    {"level": event.get("level", "info"), "ts": event.get("ts"), "message": event["message"]}
                )
            elif event.get("type") == "result":
                result = event
    except Exception as e:  # noqa: BLE001
        _audit_provision(db, cluster, actor, payload, request, "failure")
        _raise(e)
    _audit_provision(db, cluster, actor, payload, request, "success")
    if result is None:
        raise HTTPException(status_code=500, detail="프로비저닝이 결과를 반환하지 않았습니다.")
    result.pop("type", None)
    return ProvisionResult(**result, logs=logs)


@router.post("/provision/stream")
def provision_stream(
    cluster_id: UUID,
    payload: ProvisionRequest,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """일괄 생성 — SSE 로 단계별 로그를 실시간 중계한다.

    화면의 "실행" 버튼은 이 엔드포인트를 쓴다. 본문은 fetch+reader 로 직접 소비되므로
    snake_case 원문 JSON 이다.
    """
    cluster, svc = _service(cluster_id, db)
    spec = _provision_spec(payload)

    def _gen():
        failed = False
        try:
            for event in svc.provision(spec):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except GeneratorExit:  # 클라이언트가 끊음
            return
        except Exception as e:  # noqa: BLE001 — SSE 로는 에러도 이벤트로 보낸다
            failed = True
            yield (
                "data: "
                + json.dumps(
                    {"type": "error", "message": str(e) or "프로비저닝에 실패했습니다."},
                    ensure_ascii=False,
                )
                + "\n\n"
            )
        finally:
            try:
                _audit_provision(
                    db, cluster, actor, payload, request, "failure" if failed else "success"
                )
            except Exception:  # noqa: BLE001 — 감사 로그 실패가 스트림을 깨지 않게
                pass
        yield f"data: {json.dumps({'type': 'done'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(_gen(), media_type="text/event-stream", headers=SSE_HEADERS)
