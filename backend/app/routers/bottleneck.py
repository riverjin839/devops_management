"""Pod-to-pod bottleneck analyzer router."""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from typing import AsyncIterator, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db
from app.models import Cluster, BottleneckRun, User
from app.auth.deps import require_operator, get_current_user
from app.services import audit_logger
from app.services.cluster_access import require_cluster_access
from app.services.bottleneck_probes import (
    BOTTLENECK_PROBE_REGISTRY, PROBE_CATALOG, make_context, worst_status,
)
from app.schemas.bottleneck import (
    BottleneckRunCreate,
    BottleneckRunResponse,
    BottleneckRunListResponse,
    ProbeCatalogEntry,
)


router = APIRouter(prefix="/pod-bottleneck", tags=["pod-bottleneck"])


def _not_found(run_id: UUID) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "BOTTLENECK_RUN_NOT_FOUND",
                "message": "Bottleneck run not found", "id": str(run_id)},
    )


def _cluster_not_found(cluster_id: UUID) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"error": "CLUSTER_NOT_FOUND",
                "message": "Cluster not found", "id": str(cluster_id)},
    )


# ─── catalog ──────────────────────────────────────────────────────────────

@router.get("/probes", response_model=list[ProbeCatalogEntry])
def list_probes(_: User = Depends(get_current_user)):
    """등록된 4 probe 메타 — frontend UI 안내용."""
    return [ProbeCatalogEntry(probe_key=k, **v) for k, v in PROBE_CATALOG.items()]


# ─── run history ──────────────────────────────────────────────────────────

@router.get("/runs", response_model=BottleneckRunListResponse)
def list_runs(
    cluster_id: UUID | None = Query(default=None),
    namespace: str | None = Query(default=None, max_length=100),
    source_pod: str | None = Query(default=None, max_length=253),
    dest_pod: str | None = Query(default=None, max_length=253),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    q = db.query(BottleneckRun)
    if cluster_id is not None:
        q = q.filter(BottleneckRun.cluster_id == cluster_id)
    if namespace:
        q = q.filter(BottleneckRun.namespace == namespace)
    if source_pod:
        q = q.filter(BottleneckRun.source_pod == source_pod)
    if dest_pod:
        q = q.filter(BottleneckRun.dest_pod == dest_pod)

    total = q.count()
    items = (
        q.order_by(BottleneckRun.created_at.desc())
        .offset(offset).limit(limit).all()
    )
    return BottleneckRunListResponse(
        data=items, total=total, offset=offset, limit=limit,
        has_more=(offset + len(items)) < total,
    )


@router.get("/runs/{run_id}", response_model=BottleneckRunResponse)
def get_run(
    run_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    row = db.query(BottleneckRun).filter(BottleneckRun.id == run_id).first()
    if not row:
        raise _not_found(run_id)
    return row


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_run(
    run_id: UUID,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    row = db.query(BottleneckRun).filter(BottleneckRun.id == run_id).first()
    if not row:
        raise _not_found(run_id)
    snap = {
        "cluster_id": str(row.cluster_id), "namespace": row.namespace,
        "source_pod": row.source_pod, "dest_pod": row.dest_pod,
    }
    target_id = row.id
    db.delete(row); db.commit()
    audit_logger.record(
        db, action="bottleneck.delete", actor=actor,
        target_type="bottleneck_run", target_id=target_id,
        details=snap, request=request,
    )
    return None


# ─── run (the core action) ───────────────────────────────────────────────

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}


def _prepare_run(payload: BottleneckRunCreate, db: Session, actor: User):
    """공통 사전 검증 — 클러스터 존재·테넌트 접근·probe 키. (cluster, selected_keys) 반환."""
    cluster = db.query(Cluster).filter(Cluster.id == payload.cluster_id).first()
    if not cluster:
        raise _cluster_not_found(payload.cluster_id)
    # 본문 cluster_id 는 경로 의존성(enforce_cluster_access)이 못 보므로 여기서 테넌트 바인딩을 판정.
    require_cluster_access(db, actor, cluster.id, "operate")

    # 어떤 probe 들을 돌릴지 결정 (payload.probes 미지정 시 전체)
    selected_keys = payload.probes or list(BOTTLENECK_PROBE_REGISTRY.keys())
    invalid = [k for k in selected_keys if k not in BOTTLENECK_PROBE_REGISTRY]
    if invalid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "UNKNOWN_PROBE_KEY",
                    "message": f"미지원 probe: {invalid}",
                    "supported": sorted(BOTTLENECK_PROBE_REGISTRY.keys())},
        )
    return cluster, selected_keys


def _save_run(db: Session, cluster: Cluster, payload: BottleneckRunCreate, actor: User,
              probes_dict: dict, overall: str, duration_ms: int, selected_keys: list[str],
              request: Optional[Request]) -> BottleneckRun:
    row = BottleneckRun(
        cluster_id=cluster.id,
        namespace=payload.namespace,
        source_pod=payload.source_pod,
        dest_pod=payload.dest_pod,
        dest_service=payload.dest_service,
        overall_status=overall,
        probes=probes_dict,
        triggered_by_user=actor.username,
        duration_ms=duration_ms,
    )
    db.add(row); db.commit(); db.refresh(row)

    audit_logger.record(
        db, action="bottleneck.run", actor=actor,
        target_type="bottleneck_run", target_id=row.id,
        details={
            "namespace": payload.namespace,
            "source_pod": payload.source_pod,
            "dest_pod": payload.dest_pod,
            "dest_service": payload.dest_service,
            "overall_status": overall,
            "duration_ms": duration_ms,
            "probes_run": selected_keys,
        },
        request=request,
    )
    return row


@router.post("/run", response_model=BottleneckRunResponse, status_code=status.HTTP_201_CREATED)
async def run_bottleneck_analysis(
    payload: BottleneckRunCreate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
    request: Request = None,  # noqa: B008
):
    """두 pod 사이 병목 진단 — 4 probe 병렬 실행 + BottleneckRun 저장."""
    cluster, selected_keys = _prepare_run(payload, db, actor)

    ctx = make_context(
        cluster=cluster,
        namespace=payload.namespace,
        source_pod=payload.source_pod,
        dest_pod=payload.dest_pod,
        dest_service=payload.dest_service,
    )

    start = time.time()
    probes = [BOTTLENECK_PROBE_REGISTRY[k]() for k in selected_keys]
    results = await asyncio.gather(*[p.safe_run(ctx) for p in probes])
    duration_ms = int((time.time() - start) * 1000)

    probes_dict = {p.PROBE_KEY: r.to_dict() for p, r in zip(probes, results)}
    overall = worst_status([r.status for r in results])
    return _save_run(db, cluster, payload, actor, probes_dict, overall, duration_ms, selected_keys, request)


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _status_str(st) -> str:
    return st.value if hasattr(st, "value") else str(st)


@router.post("/run/stream")
async def run_bottleneck_analysis_stream(
    payload: BottleneckRunCreate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """병목 진단 — probe 가 끝나는 순서대로 SSE 로 단계·로그를 중계하고 마지막에 run id 를 보낸다.

    화면의 "지금 진단" 버튼은 이 엔드포인트를 쓴다(D-089 — 실행 버튼은 실시간 로그 필수).
    본문은 fetch+reader 로 직접 소비되므로 axios 인터셉터를 타지 않는다 → **snake_case 원문 JSON**.
    이벤트: ``log``{level,ts,message} · ``step``{name,status} · ``result``{run_id,overall_status,duration_ms} · ``error``{message}.
    검증 실패(404/403/400)는 스트림을 시작하기 전에 일반 HTTP 오류로 응답한다.
    """
    cluster, selected_keys = _prepare_run(payload, db, actor)
    cluster_id = cluster.id
    cluster_name = cluster.name
    actor_id = actor.id

    async def gen() -> AsyncIterator[str]:
        # FastAPI 0.106+ 는 yield 의존성(get_db) 을 스트리밍 전에 정리하므로 스트림 전용 세션을 쓴다.
        sdb = SessionLocal()
        try:
            yield _sse({"type": "log", "level": "info", "ts": _now(),
                        "message": f"진단 시작 — {cluster_name} · {payload.namespace}/{payload.source_pod} → "
                                   f"{payload.dest_pod}" + (f" (svc {payload.dest_service})" if payload.dest_service else "")})
            s_cluster = sdb.query(Cluster).filter(Cluster.id == cluster_id).first()
            s_actor = sdb.query(User).filter(User.id == actor_id).first()
            if s_cluster is None or s_actor is None:
                yield _sse({"type": "error", "message": "클러스터 또는 사용자 정보를 다시 읽지 못했습니다."})
                return
            try:
                ctx = make_context(
                    cluster=s_cluster, namespace=payload.namespace, source_pod=payload.source_pod,
                    dest_pod=payload.dest_pod, dest_service=payload.dest_service,
                )
            except Exception as e:  # noqa: BLE001 — kubeconfig 해석 실패를 스트림 오류로
                yield _sse({"type": "error", "message": f"kubeconfig 준비 실패: {str(e)[:300]}"})
                return
            yield _sse({"type": "log", "level": "info", "ts": _now(), "message": "kubeconfig 준비 완료"})

            probes = [BOTTLENECK_PROBE_REGISTRY[k]() for k in selected_keys]
            for p in probes:
                yield _sse({"type": "step", "name": p.PROBE_KEY, "label": p.PROBE_LABEL, "status": "running"})
                yield _sse({"type": "log", "level": "info", "ts": _now(),
                            "message": f"[{p.PROBE_LABEL}] 시작 (timeout {p.TIMEOUT_SEC}s)"})

            start = time.time()

            async def _run(p):
                t0 = time.time()
                r = await p.safe_run(ctx)
                return p, r, int((time.time() - t0) * 1000)

            results: dict[str, object] = {}
            for fut in asyncio.as_completed([_run(p) for p in probes]):
                p, r, ms = await fut
                results[p.PROBE_KEY] = r
                st = _status_str(r.status)
                level = {"critical": "error", "warning": "warn", "pending": "warn"}.get(st, "info")
                yield _sse({"type": "step", "name": p.PROBE_KEY, "label": p.PROBE_LABEL,
                            "status": "failed" if st == "critical" else "done"})
                yield _sse({"type": "log", "level": level, "ts": _now(),
                            "message": f"[{p.PROBE_LABEL}] {st} · {ms}ms — {r.message}"})
                if r.recommendation:
                    yield _sse({"type": "log", "level": "info", "ts": _now(),
                                "message": f"[{p.PROBE_LABEL}] 권고: {r.recommendation}"})

            duration_ms = int((time.time() - start) * 1000)
            ordered = [results[p.PROBE_KEY] for p in probes]
            probes_dict = {p.PROBE_KEY: r.to_dict() for p, r in zip(probes, ordered)}
            overall = worst_status([r.status for r in ordered])
            row = _save_run(sdb, s_cluster, payload, s_actor, probes_dict, overall, duration_ms,
                            selected_keys, request)
            yield _sse({"type": "log", "level": "error" if overall == "critical" else "info", "ts": _now(),
                        "message": f"진단 완료 — 종합 {overall} · {duration_ms}ms · 결과 저장({str(row.id)[:8]})"})
            yield _sse({"type": "result", "run_id": str(row.id), "overall_status": overall,
                        "duration_ms": duration_ms})
        except Exception as e:  # noqa: BLE001 — 스트림 도중 예외는 error 이벤트로(빈 500 금지)
            sdb.rollback()
            yield _sse({"type": "error", "message": f"진단 중 오류: {str(e)[:300]}"})
        finally:
            sdb.close()

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
