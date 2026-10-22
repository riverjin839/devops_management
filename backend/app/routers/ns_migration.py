"""NS 마이그레이션 API — 개발 클러스터의 네임스페이스 리소스를 운영 클러스터로 옮긴다.

- 조회(종류 카탈로그·NS 목록·실행 이력·프로필): 인증된 사용자(클러스터 read 권한 범위).
- 계획/적용 실행·YAML 번들·프로필 저장: require_operator + 소스 read · 타깃 operate 권한(+감사).
  body 에 클러스터 id 가 있어 경로 기반 자동 검사(enforce_cluster_access)가 닿지 않으므로 직접 검사한다.
실행은 Celery 로 큐잉하고 run_id 를 돌려준다 — 프론트가 `GET /runs/{id}` 를 폴링해 단계/로그를
실시간 표시한다(CLAUDE.md "실행 버튼 = 실시간 로그" 규칙).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user, require_operator
from app.database import get_db
from app.models import Cluster
from app.models.ns_migration import NsMigrationProfile, NsMigrationRun
from app.models.user import User
from app.schemas.ns_migration import MigrationSpec, ProfileBody, RunCreate
from app.services import audit_logger
from app.services.cluster_access import has_cluster_access, require_cluster_access
from app.services.ns_migration import engine
from app.services.ns_migration import transform as tf

router = APIRouter(prefix="/ns-migration", tags=["ns-migration"])

STEP_PLAN = [
    {"id": "collect", "label": "소스 수집·변환"},
    {"id": "compare", "label": "타깃 연결"},
    {"id": "apply", "label": "비교·적용"},
]


def _cluster(db: Session, cid: UUID) -> Cluster:
    c = db.query(Cluster).filter(Cluster.id == cid).first()
    if c is None:
        raise HTTPException(status_code=404, detail="Cluster not found")
    return c


def _check_pair(db: Session, user: User, spec: MigrationSpec) -> tuple[Cluster, Cluster]:
    if spec.source_cluster_id == spec.target_cluster_id:
        raise HTTPException(status_code=422, detail="소스와 타깃 클러스터가 같습니다.")
    src, dst = _cluster(db, spec.source_cluster_id), _cluster(db, spec.target_cluster_id)
    require_cluster_access(db, user, src.id, "read")
    require_cluster_access(db, user, dst.id, "operate")
    return src, dst


def _visible(db: Session, user: User, *cluster_ids: UUID) -> bool:
    return all(has_cluster_access(db, user, cid, "read") for cid in cluster_ids)


def _run_dict(r: NsMigrationRun, *, full: bool = True) -> dict[str, Any]:
    d = {
        "id": str(r.id), "source_cluster_id": str(r.source_cluster_id), "target_cluster_id": str(r.target_cluster_id),
        "source_namespace": r.source_namespace, "target_namespace": r.target_namespace, "mode": r.mode,
        "dry_run": r.dry_run, "triggered_by": r.triggered_by, "run_state": r.run_state, "summary": r.summary,
        "error": r.error, "steps": r.steps or [],
        "queued_at": r.queued_at.isoformat() if r.queued_at else None,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "duration_ms": r.duration_ms or 0,
    }
    if full:
        d.update(spec=r.spec or {}, log_lines=r.log_lines or "", items=r.items or {"resources": [], "skipped": []})
    return d


def _profile_dict(p: NsMigrationProfile) -> dict[str, Any]:
    return {
        "id": str(p.id), "name": p.name, "source_cluster_id": str(p.source_cluster_id),
        "target_cluster_id": str(p.target_cluster_id), "source_namespace": p.source_namespace,
        "target_namespace": p.target_namespace, "kinds": p.kinds or [], "include_secrets": p.include_secrets,
        "rules": p.rules or [], "options": p.options or {}, "created_by": p.created_by,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


@router.get("/kinds")
def list_kinds(_: User = Depends(get_current_user)):
    return {"data": tf.KIND_CATALOG, "default_kinds": tf.DEFAULT_KINDS, "rule_types": list(tf.RULE_TYPES)}


@router.get("/clusters/{cluster_id}/namespaces")
def list_namespaces(cluster_id: UUID, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    """클러스터의 NS 이름 목록 — 미도달이어도 500 대신 error 필드(fail-safe)."""
    cluster = _cluster(db, cluster_id)
    try:
        dyn = engine.dynamic_client(cluster)
        res = dyn.resources.get(api_version="v1", kind="Namespace")
        items = res.get().to_dict().get("items") or []
        return {"data": sorted(i["metadata"]["name"] for i in items), "error": None}
    except Exception as e:  # noqa: BLE001
        return {"data": [], "error": engine._err(e)}


@router.post("/export")
def export_bundle(payload: MigrationSpec, request: Request, db: Session = Depends(get_db),
                  actor: User = Depends(require_operator)):
    """변환된 다중 문서 YAML 다운로드(GitOps 커밋·수동 적용용). 타깃에는 아무것도 쓰지 않는다."""
    src, dst = _check_pair(db, actor, payload)
    lines: list[str] = []
    try:
        desired, skipped = engine.build_desired(src, payload.spec_dict(), payload.source_namespace,
                                                payload.target_namespace, lines.append)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"소스 수집 실패: {engine._err(e)}")
    header = (f"# PEP NS 마이그레이션 번들 — {src.name}/{payload.source_namespace} → "
              f"{dst.name}/{payload.target_namespace}\n# 생성: {datetime.utcnow().isoformat()}Z · "
              f"리소스 {len(desired)}개 · 제외 {len(skipped)}개\n# 적용: kubectl apply --server-side "
              f"--field-manager={engine.FIELD_MANAGER} -f <file>")
    if payload.include_secrets:
        header += "\n# 주의: Secret 원문이 포함돼 있다 — 저장소에 그대로 커밋하지 말 것."
    body = tf.bundle_yaml([o for o, _ in desired], header)
    audit_logger.record(db, action="k8s.ns_migration.export", actor=actor, request=request,
                        target_type="cluster", target_id=str(src.id),
                        details={"source": src.name, "target": dst.name, "source_ns": payload.source_namespace,
                                 "target_ns": payload.target_namespace, "count": len(desired),
                                 "include_secrets": payload.include_secrets})
    fname = f"ns-migration-{payload.source_namespace}-to-{payload.target_namespace}.yaml"
    return Response(content=body, media_type="application/x-yaml",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@router.post("/runs")
def create_run(payload: RunCreate, request: Request, db: Session = Depends(get_db),
               actor: User = Depends(require_operator)):
    src, dst = _check_pair(db, actor, payload)
    run = NsMigrationRun(
        source_cluster_id=src.id, target_cluster_id=dst.id, source_namespace=payload.source_namespace,
        target_namespace=payload.target_namespace, mode=payload.mode, dry_run=payload.mode != "apply",
        spec=payload.spec_dict(), triggered_by=actor.username, run_state="queued",
        steps=[{"id": s["id"], "label": s["label"], "status": "pending"} for s in STEP_PLAN], log_lines="",
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    try:
        from app import celery_app as ca
        task = ca.run_ns_migration.delay(str(run.id))
        run.celery_task_id = getattr(task, "id", None)
        db.commit()
    except Exception as e:  # noqa: BLE001
        run.run_state = "failed"
        run.error = f"작업 큐잉 실패(Celery/Redis 확인): {str(e)[:200]}"
        db.commit()
        raise HTTPException(status_code=503, detail=run.error)
    if payload.mode == "apply":
        audit_logger.record(db, action="k8s.ns_migration.apply.request", actor=actor, request=request,
                            target_type="cluster", target_id=str(dst.id),
                            details={"run_id": str(run.id), "source": src.name, "target": dst.name,
                                     "source_ns": payload.source_namespace, "target_ns": payload.target_namespace,
                                     "kinds": payload.kinds, "include_secrets": payload.include_secrets})
    return _run_dict(run)


@router.get("/runs")
def list_runs(limit: int = 30, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(NsMigrationRun).order_by(NsMigrationRun.queued_at.desc()).limit(max(1, min(limit, 200))).all()
    return {"data": [_run_dict(r, full=False) for r in rows
                     if _visible(db, user, r.source_cluster_id, r.target_cluster_id)]}


@router.get("/runs/{run_id}")
def get_run(run_id: UUID, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    r = db.query(NsMigrationRun).filter(NsMigrationRun.id == run_id).first()
    if r is None or not _visible(db, user, r.source_cluster_id, r.target_cluster_id):
        raise HTTPException(status_code=404, detail="실행 기록이 없습니다.")
    return _run_dict(r)


@router.get("/profiles")
def list_profiles(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(NsMigrationProfile).order_by(NsMigrationProfile.name).all()
    return {"data": [_profile_dict(p) for p in rows if _visible(db, user, p.source_cluster_id, p.target_cluster_id)]}


def _fill_profile(p: NsMigrationProfile, body: ProfileBody) -> None:
    spec = body.spec_dict()
    p.name = body.name.strip()
    p.source_cluster_id, p.target_cluster_id = body.source_cluster_id, body.target_cluster_id
    p.source_namespace, p.target_namespace = body.source_namespace, body.target_namespace
    p.kinds, p.include_secrets, p.rules, p.options = spec["kinds"], spec["include_secrets"], spec["rules"], spec["options"]


@router.post("/profiles")
def create_profile(body: ProfileBody, db: Session = Depends(get_db), actor: User = Depends(require_operator)):
    _check_pair(db, actor, body)
    p = NsMigrationProfile(created_by=actor.username)
    _fill_profile(p, body)
    db.add(p)
    db.commit()
    db.refresh(p)
    return _profile_dict(p)


@router.put("/profiles/{profile_id}")
def update_profile(profile_id: UUID, body: ProfileBody, db: Session = Depends(get_db),
                   actor: User = Depends(require_operator)):
    p = db.query(NsMigrationProfile).filter(NsMigrationProfile.id == profile_id).first()
    if p is None or not _visible(db, actor, p.source_cluster_id, p.target_cluster_id):
        raise HTTPException(status_code=404, detail="프로필이 없습니다.")
    _check_pair(db, actor, body)
    _fill_profile(p, body)
    db.commit()
    db.refresh(p)
    return _profile_dict(p)


@router.delete("/profiles/{profile_id}")
def delete_profile(profile_id: UUID, db: Session = Depends(get_db), actor: User = Depends(require_operator)):
    p = db.query(NsMigrationProfile).filter(NsMigrationProfile.id == profile_id).first()
    if p is None or not _visible(db, actor, p.source_cluster_id, p.target_cluster_id):
        raise HTTPException(status_code=404, detail="프로필이 없습니다.")
    db.delete(p)
    db.commit()
    return {"ok": True}
