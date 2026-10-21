"""Observability — 관측 스택 지표 대시보드 + 인시던트 알람 수신/인박스.

두 개의 라우터를 노출한다:

- `ingest_router` : **JWT 없음**. Bearer 토큰(`ALERT_INGEST_TOKEN`)만 자체 검증하는 수신 창구.
  Alertmanager webhook 과 사내 alert-forwarder, 그리고 push 모드 클러스터의 수집기가 호출한다.
  토큰 미설정 시 **503 으로 fail-closed** (kubewatch / superpod ingest 와 동일 정책).
- `router` : JWT 보호. 지표 카탈로그 CRUD, 지표 현재값, Prometheus 규칙/타겟/발화중 알람,
  알람 인박스 조회·ack, 알림 규칙/설정 CRUD.

수집 경로는 클러스터의 `observability_mode` 를 따른다:
- `pull`  : PEP 가 클러스터의 Prometheus/Alertmanager 에 직접 질의 (live)
- `push`  : in-cluster 수집기가 밀어넣은 `observability_snapshots` 최신 행을 읽음 (snapshot)

PrometheusService/AlertmanagerService 는 fail-safe 계약이라 미도달 시 예외가 아니라
`offline` 을 돌려준다 — 이 라우터도 500 대신 `source="offline"` + `detail` 로 응답한다.
"""
from __future__ import annotations

import json
import logging
import secrets
import time
from datetime import datetime, timedelta
from typing import Any, Optional
from uuid import UUID

import asyncio
from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from sqlalchemy import and_, case, desc, func, or_
from sqlalchemy.orm import Session

from app.auth.deps import get_cluster_scope, get_current_user, require_admin, require_operator
from app.services import audit_logger
from app.services.list_cursor import apply_cursor, page_with_cursor
from app.services.cluster_access import ClusterScope, require_cluster_access
from app.config import settings
from app.database import get_db
from app.models.alert_event import SEVERITY_ORDER, AlertEvent
from app.models.alert_notify_rule import AlertNotifyRule
from app.models.cluster import Cluster
from app.models.observability import (
    ObservabilityMetric,
    ObservabilityModule,
    ObservabilitySnapshot,
)
from app.models.user import User
from app.schemas.observability import (
    ActiveAlertOut,
    AlertAckInput,
    AlertEventListResponse,
    AlertEventOut,
    AlertNotifyRuleInput,
    AlertNotifyRuleOut,
    AlertSettingsOut,
    AlertSettingsUpdate,
    AlertStatsResponse,
    MetricPreviewInput,
    MetricPreviewOut,
    MetricPreviewSample,
    MetricValueOut,
    MetricValuesResponse,
    ObservabilityMetricInput,
    ObservabilityMetricOut,
    ObservabilityMetricUpdate,
    ObservabilityModuleInput,
    ObservabilityModuleOut,
    ObservabilityModuleUpdate,
    ObservabilitySettingsOut,
    ObservabilitySettingsUpdate,
    PromRuleOut,
    PromTargetOut,
    PromViewResponse,
    SnapshotIngestInput,
    SourceError,
    to_kv,
)
from app.services.observability.view_settings import (
    get_observability_settings,
    set_observability_settings,
    snapshot_freshness,
)
from app.services.alertmanager_service import AlertmanagerService, alertmanager_service
from app.services.observability.alert_ingest import parse_alert_payload
from app.services.observability.alert_router import (
    get_alert_settings,
    route_and_notify,
    set_alert_settings,
)
from app.services.prometheus_service import PrometheusService, aclose_if_private, prometheus_service

logger = logging.getLogger(__name__)

ingest_router = APIRouter(prefix="/observability", tags=["Observability Ingest"])
router = APIRouter(prefix="/observability", tags=["Observability"])

# 지표 현재값 fan-out 캐시 — /promql/query/all 과 같은 이유(여러 탭이 30초 폴링).
_VALUES_CACHE_TTL = 15.0
_values_cache: dict[str, tuple[float, MetricValuesResponse]] = {}


# ── 공통 헬퍼 ────────────────────────────────────────────────────────────────

def _invalidate_values_cache() -> None:
    _values_cache.clear()


def _get_cluster(db: Session, cluster_id: Optional[UUID]) -> Optional[Cluster]:
    if cluster_id is None:
        return None
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=404, detail="클러스터를 찾을 수 없습니다.")
    return cluster


_NO_CLUSTER_DETAIL = (
    "클러스터를 선택하세요. 클러스터를 지정하지 않은 전역 Prometheus·Alertmanager 조회는 "
    "관리자만 할 수 있습니다."
)


def _visible_cluster(db: Session, actor: User, cluster_id: Optional[UUID]) -> Optional[Cluster]:
    """관측 조회 공용 판정(D-181) — **캐시 조회보다 먼저** 부른다.

    - ``cluster_id`` 가 있으면 테넌트 read 권한(``require_cluster_access``) → 403, 이어서 존재 확인 → 404.
      판정을 존재 확인보다 앞에 둬서 바인딩된 클러스터의 존재 여부를 흘리지 않는다.
    - ``cluster_id`` 가 없으면 전역 ``PROMETHEUS_URL``·``ALERTMANAGER_URL`` 을 조회하게 되므로 admin 만 허용,
      그 외는 422(정책 결정 ① — 전역 Prometheus 가 특정 테넌트 클러스터의 것일 수 있다).
    """
    if cluster_id is None:
        if getattr(actor, "role", None) != "admin":
            raise HTTPException(status_code=422, detail=_NO_CLUSTER_DETAIL)
        return None
    require_cluster_access(db, actor, cluster_id, "read")
    return _get_cluster(db, cluster_id)


def _snapshot_meta(db: Session, collected_at: Optional[datetime]) -> dict[str, Any]:
    """push 스냅샷 신선도 필드(D-183) — 기준은 AppSetting ``observability.settings.stale_minutes``."""
    stale_minutes = get_observability_settings(db)["stale_minutes"]
    stale, age = snapshot_freshness(collected_at, stale_minutes)
    return {"stale": stale, "snapshot_age_sec": age}


def _missing_snapshot_error(what: str) -> list[SourceError]:
    return [SourceError(
        source="push",
        message=f"push 모드인데 {what} 스냅샷이 아직 수신되지 않았습니다. in-cluster 수집기 설정을 확인하세요.",
    )]


def _prom_error(result: dict) -> str:
    raw = result.get("error") or result.get("detail") or "알 수 없는 오류"
    return f"Prometheus 조회 실패: {raw}"


def _am_error(result: dict) -> str:
    raw = result.get("error") or result.get("detail") or "알 수 없는 오류"
    return f"Alertmanager 조회 실패: {raw}"


def _prom_for(cluster: Optional[Cluster]) -> Optional[PrometheusService]:
    """클러스터별 Prometheus 인스턴스. 비활성/미설정이면 None (= offline 응답).

    `cluster_trends._service_for` 와 같은 규칙이되, Observability 화면은 자체 토글
    (`observability_enabled`)을 우선 본다 — Trends 를 안 쓰면서 관측 대시보드만 켜는
    구성을 허용하기 위함.
    """
    if cluster is None:
        return prometheus_service
    if not bool(getattr(cluster, "observability_enabled", False)):
        return None
    override = (getattr(cluster, "prometheus_url", None) or "").strip()
    return PrometheusService(base_url=override) if override else prometheus_service


def _alertmanager_for(cluster: Optional[Cluster]) -> Optional[AlertmanagerService]:
    if cluster is None:
        return alertmanager_service
    if not bool(getattr(cluster, "observability_enabled", False)):
        return None
    override = (getattr(cluster, "alertmanager_url", None) or "").strip()
    return AlertmanagerService(base_url=override) if override else alertmanager_service


def _mode(cluster: Optional[Cluster]) -> str:
    return (getattr(cluster, "observability_mode", None) or "pull") if cluster else "pull"


def _offline_detail(cluster: Optional[Cluster]) -> str:
    if cluster is None:
        return "클러스터를 선택하세요."
    return (
        f"'{cluster.name}' 클러스터의 관측 연동이 꺼져 있습니다. "
        "클러스터 관리 → 정보 수정의 관측 연동 항목에서 사용을 켜고 Prometheus·Alertmanager "
        "주소와 수집 모드를 설정하세요."
    )


def _latest_snapshot(
    db: Session, cluster_id: Optional[UUID], module: str, kind: str
) -> Optional[ObservabilitySnapshot]:
    return (
        db.query(ObservabilitySnapshot)
        .filter(
            ObservabilitySnapshot.cluster_id == cluster_id,
            ObservabilitySnapshot.module_key == module,
            ObservabilitySnapshot.kind == kind,
        )
        .order_by(desc(ObservabilitySnapshot.collected_at))
        .first()
    )


def _parse_thresholds(spec: Optional[str]) -> dict[str, float]:
    """"warning:70,critical:90" → {"warning": 70.0, "critical": 90.0}."""
    out: dict[str, float] = {}
    for chunk in (spec or "").split(","):
        if ":" not in chunk:
            continue
        name, _, raw = chunk.partition(":")
        try:
            out[name.strip().lower()] = float(raw.strip())
        except ValueError:
            continue
    return out


def _evaluate_state(value: Optional[float], thresholds: Optional[str], invert: bool) -> str:
    """임계값 대비 상태 판정. 임계 미설정이면 'ok'(정보성 지표)."""
    if value is None:
        return "unknown"
    limits = _parse_thresholds(thresholds)
    if not limits:
        return "ok"
    crit = limits.get("critical")
    warn = limits.get("warning")
    if invert:
        # 값이 낮을수록 나쁨 (up==1 정상, 0 장애)
        if crit is not None and value < crit:
            return "critical"
        if warn is not None and value < warn:
            return "warning"
        return "ok"
    if crit is not None and value >= crit:
        return "critical"
    if warn is not None and value >= warn:
        return "warning"
    return "ok"


def _pick_representative(result: dict, invert: bool) -> tuple[Optional[float], dict, int]:
    """PrometheusService.query 결과에서 대표값 1개를 고른다.

    시리즈가 여러 개면 '가장 나쁜 쪽'(invert 면 최솟값, 아니면 최댓값)을 대표로 삼아
    dense 테이블 한 줄이 문제를 숨기지 않게 한다.
    """
    if result.get("value") is not None and not result.get("results"):
        return float(result["value"]), result.get("labels") or {}, 1

    rows = result.get("results") or []
    numeric = [(r.get("value"), r.get("labels") or {}) for r in rows if r.get("value") is not None]
    if not numeric:
        if result.get("value") is not None:
            return float(result["value"]), result.get("labels") or {}, 1
        return None, {}, 0
    chosen = min(numeric, key=lambda x: x[0]) if invert else max(numeric, key=lambda x: x[0])
    return float(chosen[0]), chosen[1], len(numeric)


# ── 모듈 / 지표 카탈로그 ─────────────────────────────────────────────────────

def _audit_catalog(
    db: Session, request: Request, actor: User, *, action: str, target_type: str,
    target_id: Any, name: str, key: str, extra: Optional[dict[str, Any]] = None,
) -> None:
    """카탈로그 변경 감사(D-186). details 는 이름·식별자(+변경 필드 **이름**)만 — 값·질의 결과는 남기지 않는다."""
    details: dict[str, Any] = {"id": str(target_id), "name": name, "key": key}
    if extra:
        details.update(extra)
    audit_logger.record(
        db, action=action, actor=actor, target_type=target_type, target_id=target_id,
        details=details, request=request,
    )


def _module_out(mod: ObservabilityModule, count: int) -> ObservabilityModuleOut:
    return ObservabilityModuleOut(
        id=mod.id, key=mod.key, label=mod.label, description=mod.description,
        icon=mod.icon,
        # 지표가 생기면 자동으로 활성 — 운영자가 지표만 추가하면 탭이 열린다.
        status="active" if count > 0 else (mod.status or "planned"),
        enabled=mod.enabled, sort_order=mod.sort_order, metric_count=count,
    )


def _enabled_metric_count(db: Session, module_key: str) -> int:
    return (
        db.query(func.count(ObservabilityMetric.id))
        .filter(ObservabilityMetric.module_key == module_key, ObservabilityMetric.enabled.is_(True))
        .scalar()
        or 0
    )


@router.get("/modules", response_model=list[ObservabilityModuleOut])
def list_modules(
    include_disabled: bool = Query(
        default=False, description="true 면 사용 안 함(enabled=false) 모듈도 포함 — 다시 켜기용"),
    db: Session = Depends(get_db),
) -> list[ObservabilityModuleOut]:
    """관측 모듈 목록. 지표가 1개 이상 등록된 모듈은 status 를 active 로 계산해 돌려준다."""
    q = db.query(ObservabilityModule)
    if not include_disabled:
        q = q.filter(ObservabilityModule.enabled.is_(True))
    modules = q.order_by(ObservabilityModule.sort_order, ObservabilityModule.key).all()
    counts: dict[str, int] = {}
    for metric in db.query(ObservabilityMetric.module_key).filter(
        ObservabilityMetric.enabled.is_(True)
    ):
        counts[metric.module_key] = counts.get(metric.module_key, 0) + 1
    return [_module_out(mod, counts.get(mod.key, 0)) for mod in modules]


@router.post("/modules", response_model=ObservabilityModuleOut, status_code=201)
def create_module(
    body: ObservabilityModuleInput,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
) -> ObservabilityModuleOut:
    """모듈 추가 — 전역 카탈로그 행이라 테넌트 판정 없이 operator 이상."""
    if db.query(ObservabilityModule.id).filter(ObservabilityModule.key == body.key).first():
        raise HTTPException(status_code=409, detail="이미 있는 모듈 키입니다.")
    mod = ObservabilityModule(**body.model_dump())
    db.add(mod)
    db.commit()
    db.refresh(mod)
    _audit_catalog(db, request, actor, action="observability.module.create",
                   target_type="observability_module", target_id=mod.id, name=mod.label, key=mod.key)
    return _module_out(mod, _enabled_metric_count(db, mod.key))


@router.put("/modules/{module_id}", response_model=ObservabilityModuleOut)
def update_module(
    module_id: UUID,
    body: ObservabilityModuleUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
) -> ObservabilityModuleOut:
    """모듈 수정 — ``enabled`` 를 다시 켜는 경로이기도 하다(D-186 ②). 키는 지표가 참조하므로 바꾸지 않는다."""
    mod = db.query(ObservabilityModule).filter(ObservabilityModule.id == module_id).first()
    if not mod:
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")
    changed: list[str] = []
    for field, value in body.model_dump(exclude_unset=True).items():
        if value is not None and getattr(mod, field) != value:
            setattr(mod, field, value)
            changed.append(field)
    db.commit()
    db.refresh(mod)
    _invalidate_values_cache()
    _audit_catalog(db, request, actor, action="observability.module.update",
                   target_type="observability_module", target_id=mod.id, name=mod.label, key=mod.key,
                   extra={"fields": changed})
    return _module_out(mod, _enabled_metric_count(db, mod.key))


@router.delete("/modules/{module_id}", status_code=204)
def delete_module(
    module_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    """모듈 삭제 — 지표가 남아 있으면 409(지표가 고아가 되지 않게). 숨기기만 하려면 사용 안 함으로 둔다."""
    mod = db.query(ObservabilityModule).filter(ObservabilityModule.id == module_id).first()
    if not mod:
        raise HTTPException(status_code=404, detail="모듈을 찾을 수 없습니다.")
    remaining = (
        db.query(func.count(ObservabilityMetric.id))
        .filter(ObservabilityMetric.module_key == mod.key)
        .scalar()
        or 0
    )
    if remaining:
        raise HTTPException(
            status_code=409,
            detail=f"지표 {remaining}개가 남아 있는 모듈은 삭제할 수 없습니다. 지표를 먼저 삭제하거나 모듈을 사용 안 함으로 두세요.",
        )
    mod_id, label, key = mod.id, mod.label, mod.key
    db.delete(mod)
    db.commit()
    _invalidate_values_cache()
    _audit_catalog(db, request, actor, action="observability.module.delete",
                   target_type="observability_module", target_id=mod_id, name=label, key=key)


@router.get("/metrics", response_model=list[ObservabilityMetricOut])
def list_metrics(
    module: Optional[str] = Query(default=None),
    include_disabled: bool = Query(default=True, description="false 면 사용 중인 지표만"),
    db: Session = Depends(get_db),
) -> list[ObservabilityMetric]:
    q = db.query(ObservabilityMetric)
    if module:
        q = q.filter(ObservabilityMetric.module_key == module)
    if not include_disabled:
        q = q.filter(ObservabilityMetric.enabled.is_(True))
    return q.order_by(ObservabilityMetric.module_key, ObservabilityMetric.sort_order).all()


@router.post("/metrics", response_model=ObservabilityMetricOut, status_code=201)
def create_metric(
    body: ObservabilityMetricInput,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
) -> ObservabilityMetric:
    exists = (
        db.query(ObservabilityMetric)
        .filter(
            ObservabilityMetric.module_key == body.module_key,
            ObservabilityMetric.key == body.key,
        )
        .first()
    )
    if exists:
        raise HTTPException(status_code=409, detail="같은 모듈에 이미 있는 지표 키입니다.")
    metric = ObservabilityMetric(**body.model_dump())
    db.add(metric)
    db.commit()
    db.refresh(metric)
    _invalidate_values_cache()
    _audit_catalog(db, request, actor, action="observability.metric.create",
                   target_type="observability_metric", target_id=metric.id, name=metric.label,
                   key=metric.key, extra={"module_key": metric.module_key})
    return metric


@router.put("/metrics/{metric_id}", response_model=ObservabilityMetricOut)
def update_metric(
    metric_id: UUID,
    body: ObservabilityMetricUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
) -> ObservabilityMetric:
    metric = db.query(ObservabilityMetric).filter(ObservabilityMetric.id == metric_id).first()
    if not metric:
        raise HTTPException(status_code=404, detail="지표를 찾을 수 없습니다.")
    changed: list[str] = []
    for field, value in body.model_dump(exclude_unset=True).items():
        if value is not None and getattr(metric, field) != value:
            setattr(metric, field, value)
            changed.append(field)
    db.commit()
    db.refresh(metric)
    _invalidate_values_cache()
    _audit_catalog(db, request, actor, action="observability.metric.update",
                   target_type="observability_metric", target_id=metric.id, name=metric.label,
                   key=metric.key, extra={"module_key": metric.module_key, "fields": changed})
    return metric


@router.delete("/metrics/{metric_id}", status_code=204)
def delete_metric(
    metric_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
):
    metric = db.query(ObservabilityMetric).filter(ObservabilityMetric.id == metric_id).first()
    if not metric:
        raise HTTPException(status_code=404, detail="지표를 찾을 수 없습니다.")
    mid, label, key, module_key = metric.id, metric.label, metric.key, metric.module_key
    db.delete(metric)
    db.commit()
    _invalidate_values_cache()
    _audit_catalog(db, request, actor, action="observability.metric.delete",
                   target_type="observability_metric", target_id=mid, name=label, key=key,
                   extra={"module_key": module_key})


# ── 화면 설정 (D-183) ────────────────────────────────────────────────────────

@router.get("/settings", response_model=ObservabilitySettingsOut)
def read_observability_settings(db: Session = Depends(get_db)) -> ObservabilitySettingsOut:
    """관측 화면 설정 — 로그인한 누구나 읽는다(스냅샷 "오래됨" 표시 기준)."""
    return ObservabilitySettingsOut(**get_observability_settings(db))


@router.put("/settings", response_model=ObservabilitySettingsOut)
def write_observability_settings(
    body: ObservabilitySettingsUpdate,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
) -> ObservabilitySettingsOut:
    """관측 화면 설정 저장 — 관리자 전용. ``stale_minutes`` 는 1~1440."""
    saved = set_observability_settings(db, body.model_dump())
    _invalidate_values_cache()
    audit_logger.record(
        db, action="observability.settings.update", actor=actor, target_type="app_setting",
        target_id="observability.settings", details={"stale_minutes": saved["stale_minutes"]},
        request=request,
    )
    return ObservabilitySettingsOut(**saved)


# ── 지표 미리 조회 (D-186) ───────────────────────────────────────────────────

_PREVIEW_TIMEOUT_SEC = 10.0
_PREVIEW_MAX_SAMPLES = 20


def _preview_samples(result_type: str, result: Any) -> tuple[list[MetricPreviewSample], int]:
    """Prometheus /api/v1/query ``data`` → (앞 20개 샘플, 전체 시리즈 수)."""

    def _num(raw: Any) -> Optional[float]:
        try:
            f = float(raw)
        except (TypeError, ValueError):
            return None
        return None if f != f or f in (float("inf"), float("-inf")) else round(f, 6)

    if result_type == "scalar" and isinstance(result, list) and len(result) == 2:
        return [MetricPreviewSample(labels=[], value=_num(result[1]))], 1
    if result_type == "string":
        return [MetricPreviewSample(labels=to_kv({"value": str(result[1]) if isinstance(result, list) and len(result) == 2 else ""}))], 1
    rows = result if isinstance(result, list) else []
    samples: list[MetricPreviewSample] = []
    for item in rows[:_PREVIEW_MAX_SAMPLES]:
        if not isinstance(item, dict):
            continue
        labels = {str(k): "" if v is None else str(v) for k, v in (item.get("metric") or {}).items()}
        if result_type == "matrix":
            values = item.get("values") or []
            pair = values[-1] if values else None
        else:
            pair = item.get("value")
        value = _num(pair[1]) if isinstance(pair, (list, tuple)) and len(pair) == 2 else None
        samples.append(MetricPreviewSample(labels=to_kv(labels), value=value))
    return samples, len(rows)


async def _run_preview(prom: PrometheusService, query: str) -> dict[str, Any]:
    """공유 httpx 클라이언트로 instant query 1회. 예외는 호출부가 잡는다."""
    client = prom._get_client()  # noqa: SLF001 — 같은 프로세스의 공유 커넥션 풀 재사용
    resp = await client.get(
        f"{prom.base_url}/api/v1/query",
        params={"query": query, "timeout": f"{int(_PREVIEW_TIMEOUT_SEC)}s"},
        timeout=_PREVIEW_TIMEOUT_SEC,
    )
    try:
        body = resp.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        return {"ok": False, "error": f"Prometheus 응답을 해석할 수 없습니다 (HTTP {resp.status_code})."}
    if body.get("status") != "success":
        # 400 bad_data(문법 오류) 도 여기로 온다 — Prometheus 의 오류 문구를 그대로 보여준다.
        err = body.get("error") or f"HTTP {resp.status_code}"
        return {"ok": False, "error": f"PromQL 오류: {err}"}
    data = body.get("data") or {}
    rtype = str(data.get("resultType") or "") or None
    samples, total = _preview_samples(rtype or "", data.get("result"))
    return {"ok": True, "result_type": rtype, "samples": samples, "series_count": total}


@router.post("/metrics/preview", response_model=MetricPreviewOut)
async def preview_metric(
    body: MetricPreviewInput,
    db: Session = Depends(get_db),
    actor: User = Depends(require_operator),
) -> MetricPreviewOut:
    """저장 전 PromQL 미리 조회 — operator 이상 + 클러스터 read 권한.

    Fail-safe: 클러스터 판정(403·404) 외에는 어떤 실패도 500 이 아니라 ``ok=false`` + ``error`` 로 응답한다.
    결과는 최대 20개 시리즈만 돌려주고 감사 기록에도 남기지 않는다.
    """
    cluster = _visible_cluster(db, actor, body.cluster_id)
    started = time.monotonic()

    def _elapsed() -> int:
        return int((time.monotonic() - started) * 1000)

    try:
        if _mode(cluster) == "push":
            return MetricPreviewOut(
                ok=False, duration_ms=_elapsed(),
                error="push 모드 클러스터는 PEP 가 Prometheus 에 직접 질의하지 않아 미리 조회할 수 없습니다. "
                      "저장 후 수집기가 보낸 스냅샷에서 값을 확인하세요.")
        prom = _prom_for(cluster)
        if prom is None:
            return MetricPreviewOut(ok=False, duration_ms=_elapsed(), error=_offline_detail(cluster))
        try:
            out = await asyncio.wait_for(_run_preview(prom, body.query), timeout=_PREVIEW_TIMEOUT_SEC)
        finally:
            # URL 오버라이드 클러스터는 요청마다 새 클라이언트를 만든다 — 소켓이 GC 까지 남지 않게 닫는다.
            await aclose_if_private(prom)
        return MetricPreviewOut(duration_ms=_elapsed(), **out)
    except asyncio.TimeoutError:
        return MetricPreviewOut(
            ok=False, duration_ms=_elapsed(),
            error=f"Prometheus 응답이 {int(_PREVIEW_TIMEOUT_SEC)}초 안에 오지 않았습니다.")
    except Exception as exc:  # noqa: BLE001 — fail-safe: 미리 조회는 절대 500 을 내지 않는다
        logger.warning("observability preview 실패 (cluster=%s): %s", body.cluster_id, exc)
        name = type(exc).__name__
        if "Connect" in name:
            msg = "Prometheus 에 연결할 수 없습니다."
        elif "Timeout" in name:
            msg = f"Prometheus 응답이 {int(_PREVIEW_TIMEOUT_SEC)}초 안에 오지 않았습니다."
        else:
            msg = f"미리 조회 실패: {exc}" if str(exc) else f"미리 조회 실패: {name}"
        return MetricPreviewOut(ok=False, duration_ms=_elapsed(), error=msg)


# ── 지표 현재값 ──────────────────────────────────────────────────────────────

def _metric_row(metric: ObservabilityMetric, **overrides: Any) -> MetricValueOut:
    base = dict(
        metric_id=metric.id, key=metric.key, label=metric.label, category=metric.category,
        unit=metric.unit, display_type=metric.display_type, thresholds=metric.thresholds,
        invert=metric.invert, help=metric.help, doc_url=metric.doc_url, promql=metric.promql,
    )
    base.update(overrides)
    return MetricValueOut(**base)


def _values_from_snapshot(
    metrics: list[ObservabilityMetric], payload: Any
) -> list[MetricValueOut]:
    """수집기가 보낸 `{key: {value, labels}}` 또는 `{key: value}` 를 지표 행에 매핑."""
    lookup: dict[str, Any] = payload if isinstance(payload, dict) else {}
    rows: list[MetricValueOut] = []
    for metric in metrics:
        entry = lookup.get(metric.key)
        value: Optional[float] = None
        labels: dict[str, Any] = {}
        if isinstance(entry, dict):
            try:
                value = float(entry.get("value")) if entry.get("value") is not None else None
            except (TypeError, ValueError):
                value = None
            labels = entry.get("labels") if isinstance(entry.get("labels"), dict) else {}
        elif isinstance(entry, (int, float)):
            value = float(entry)

        rows.append(_metric_row(
            metric,
            value=value,
            labels=to_kv(labels),
            state=_evaluate_state(value, metric.thresholds, metric.invert),
            status="ok" if entry is not None else "error",
            error=None if entry is not None else "스냅샷에 이 지표가 없습니다.",
            series_count=1 if value is not None else 0,
        ))
    return rows


@router.get("/metrics/values", response_model=MetricValuesResponse)
async def metric_values(
    module: str = Query(default="kube-prometheus-stack"),
    cluster_id: Optional[UUID] = Query(default=None),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> MetricValuesResponse:
    """모듈의 활성 지표를 한 번에 조회한다 (pull=live 병렬 질의 / push=최신 스냅샷)."""
    # D-181: 테넌트 판정은 캐시보다 먼저 — 캐시 히트가 판정을 우회하지 않게.
    cluster = _visible_cluster(db, actor, cluster_id)

    cache_key = f"{module}:{cluster_id}"
    now = time.monotonic()
    cached = _values_cache.get(cache_key)
    if cached and now - cached[0] < _VALUES_CACHE_TTL:
        response = cached[1]
        if response.source == "snapshot":
            # 캐시된 스냅샷도 나이는 지금 기준으로 다시 잰다.
            return response.model_copy(update=_snapshot_meta(db, response.collected_at))
        return response

    metrics = (
        db.query(ObservabilityMetric)
        .filter(
            ObservabilityMetric.module_key == module,
            ObservabilityMetric.enabled.is_(True),
        )
        .order_by(ObservabilityMetric.sort_order, ObservabilityMetric.key)
        .all()
    )

    if not metrics:
        return MetricValuesResponse(
            module=module, cluster_id=cluster_id, source="offline",
            detail="이 모듈에 등록된 지표가 없습니다. '지표 추가'로 지표를 등록하세요.",
        )

    if _mode(cluster) == "push":
        snap = _latest_snapshot(db, cluster_id, module, "metrics")
        if snap is None:
            return MetricValuesResponse(
                module=module, cluster_id=cluster_id, source="offline",
                detail="push 모드인데 아직 수신된 스냅샷이 없습니다. in-cluster 수집기 설정을 확인하세요.",
                data=[_metric_row(m, status="offline", error="스냅샷 없음") for m in metrics],
                errors=_missing_snapshot_error("지표"),
            )
        response = MetricValuesResponse(
            module=module, cluster_id=cluster_id, source="snapshot",
            collected_at=snap.collected_at,
            data=_values_from_snapshot(metrics, snap.payload),
            **_snapshot_meta(db, snap.collected_at),
        )
        _values_cache[cache_key] = (now, response)
        return response

    prom = _prom_for(cluster)
    if prom is None:
        return MetricValuesResponse(
            module=module, cluster_id=cluster_id, source="offline",
            detail=_offline_detail(cluster),
            data=[_metric_row(m, status="offline", error="관측 연동 꺼짐") for m in metrics],
        )

    raw_results = await asyncio.gather(*(prom.query(m.promql) for m in metrics))
    rows: list[MetricValueOut] = []
    for metric, result in zip(metrics, raw_results):
        status = result.get("status", "error")
        if status != "ok":
            rows.append(_metric_row(
                metric, status=status, error=result.get("error"), state="unknown"))
            continue
        value, labels, series = _pick_representative(result, metric.invert)
        rows.append(_metric_row(
            metric,
            value=value,
            labels=to_kv(labels),
            series_count=series,
            state=_evaluate_state(value, metric.thresholds, metric.invert),
            status="ok",
        ))

    errors: list[SourceError] = []
    failed = [r for r in raw_results if r.get("status") != "ok"]
    if failed and len(failed) == len(raw_results):
        # 전 지표가 실패 = Prometheus 자체 장애로 본다(행별 오류는 data[].error 에 그대로 있다).
        errors.append(SourceError(source="prometheus", message=_prom_error(failed[0])))
    response = MetricValuesResponse(
        module=module, cluster_id=cluster_id, source="live",
        collected_at=datetime.utcnow(), data=rows, errors=errors,
    )
    _values_cache[cache_key] = (now, response)
    return response


# 경로 파라미터 라우트는 `/metrics/values` 뒤에 둔다 — 앞에 두면 "values" 가 UUID 검증에 걸려 422 가 된다.
@router.get("/metrics/{metric_id}", response_model=ObservabilityMetricOut)
def get_metric(metric_id: UUID, db: Session = Depends(get_db)) -> ObservabilityMetric:
    """지표 1건 — 편집 모달이 목록 쿼리를 기다리지 않고 직접 불러오는 용도(D-186 ④)."""
    metric = db.query(ObservabilityMetric).filter(ObservabilityMetric.id == metric_id).first()
    if not metric:
        raise HTTPException(status_code=404, detail="지표를 찾을 수 없습니다.")
    return metric


# ── Prometheus 규칙 / 타겟 / 발화중 알람 ─────────────────────────────────────

def _rules_from_payload(payload: Any, state: Optional[str], q: Optional[str]) -> list[PromRuleOut]:
    groups = (payload or {}).get("groups") if isinstance(payload, dict) else None
    rows: list[PromRuleOut] = []
    for group in groups or []:
        gname = str(group.get("name") or "")
        gfile = group.get("file")
        for rule in group.get("rules") or []:
            labels = rule.get("labels") or {}
            rtype = str(rule.get("type") or "alerting")
            rstate = rule.get("state")
            if state and state != "all" and rstate != state:
                continue
            name = str(rule.get("name") or "")
            if q and q.lower() not in f"{name} {gname} {rule.get('query') or ''}".lower():
                continue
            rows.append(PromRuleOut(
                group=gname,
                file=gfile,
                name=name,
                type=rtype,
                state=rstate,
                severity=labels.get("severity"),
                duration=rule.get("duration"),
                query=str(rule.get("query") or ""),
                health=rule.get("health"),
                last_error=rule.get("lastError") or None,
                evaluation_time=rule.get("evaluationTime"),
                last_evaluation=rule.get("lastEvaluation"),
                active_alerts=len(rule.get("alerts") or []),
                labels=to_kv(labels),
                annotations=to_kv(rule.get("annotations")),
            ))
    return rows


def _targets_from_payload(payload: Any, health: Optional[str]) -> list[PromTargetOut]:
    active = (payload or {}).get("activeTargets") if isinstance(payload, dict) else None
    rows: list[PromTargetOut] = []
    for target in active or []:
        labels = target.get("labels") or {}
        thealth = str(target.get("health") or "unknown")
        if health and health != "all" and thealth != health:
            continue
        rows.append(PromTargetOut(
            job=str(labels.get("job") or target.get("scrapePool") or "-"),
            instance=str(labels.get("instance") or "-"),
            health=thealth,
            scrape_pool=target.get("scrapePool"),
            scrape_url=target.get("scrapeUrl"),
            last_scrape=target.get("lastScrape"),
            last_scrape_duration=target.get("lastScrapeDuration"),
            last_error=target.get("lastError") or None,
            labels=to_kv(labels),
        ))
    return rows


def _alerts_from_prometheus(payload: Any) -> list[ActiveAlertOut]:
    alerts = (payload or {}).get("alerts") if isinstance(payload, dict) else None
    rows: list[ActiveAlertOut] = []
    for alert in alerts or []:
        labels = alert.get("labels") or {}
        annotations = alert.get("annotations") or {}
        rows.append(ActiveAlertOut(
            alertname=str(labels.get("alertname") or "-"),
            state=str(alert.get("state") or "firing"),
            severity=labels.get("severity"),
            namespace=labels.get("namespace"),
            resource=labels.get("pod") or labels.get("instance") or labels.get("node"),
            summary=annotations.get("summary") or annotations.get("description"),
            active_at=alert.get("activeAt"),
            value=str(alert.get("value")) if alert.get("value") is not None else None,
            origin="prometheus",
            labels=to_kv(labels),
            annotations=to_kv(annotations),
        ))
    return rows


def _alerts_from_alertmanager(payload: Any) -> list[ActiveAlertOut]:
    rows: list[ActiveAlertOut] = []
    for alert in payload or []:
        if not isinstance(alert, dict):
            continue
        labels = alert.get("labels") or {}
        annotations = alert.get("annotations") or {}
        rows.append(ActiveAlertOut(
            alertname=str(labels.get("alertname") or "-"),
            state=str((alert.get("status") or {}).get("state") or "firing"),
            severity=labels.get("severity"),
            namespace=labels.get("namespace"),
            resource=labels.get("pod") or labels.get("instance") or labels.get("node"),
            summary=annotations.get("summary") or annotations.get("description"),
            active_at=alert.get("startsAt"),
            origin="alertmanager",
            labels=to_kv(labels),
            annotations=to_kv(annotations),
        ))
    return rows


@router.get("/prometheus/rules", response_model=PromViewResponse)
async def prometheus_rules(
    cluster_id: Optional[UUID] = Query(default=None),
    state: Optional[str] = Query(default=None, description="firing | pending | inactive | all"),
    q: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> PromViewResponse:
    cluster = _visible_cluster(db, actor, cluster_id)

    if _mode(cluster) == "push":
        snap = _latest_snapshot(db, cluster_id, "kube-prometheus-stack", "rules")
        if snap is None:
            return PromViewResponse(
                cluster_id=cluster_id, source="offline",
                detail="push 모드인데 규칙 스냅샷이 아직 없습니다.",
                errors=_missing_snapshot_error("규칙"))
        return PromViewResponse(
            cluster_id=cluster_id, source="snapshot", collected_at=snap.collected_at,
            rules=_rules_from_payload(snap.payload, state, q),
            **_snapshot_meta(db, snap.collected_at))

    prom = _prom_for(cluster)
    if prom is None:
        return PromViewResponse(cluster_id=cluster_id, source="offline", detail=_offline_detail(cluster))

    result = await prom.rules()
    if result.get("status") != "ok":
        message = _prom_error(result)
        return PromViewResponse(
            cluster_id=cluster_id, source="offline", detail=message,
            errors=[SourceError(source="prometheus", message=message)])
    return PromViewResponse(
        cluster_id=cluster_id, source="live", collected_at=datetime.utcnow(),
        rules=_rules_from_payload(result.get("data"), state, q))


@router.get("/prometheus/targets", response_model=PromViewResponse)
async def prometheus_targets(
    cluster_id: Optional[UUID] = Query(default=None),
    health: Optional[str] = Query(default=None, description="up | down | unknown | all"),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> PromViewResponse:
    cluster = _visible_cluster(db, actor, cluster_id)

    if _mode(cluster) == "push":
        snap = _latest_snapshot(db, cluster_id, "kube-prometheus-stack", "targets")
        if snap is None:
            return PromViewResponse(
                cluster_id=cluster_id, source="offline",
                detail="push 모드인데 스크레이프 대상 스냅샷이 아직 없습니다.",
                errors=_missing_snapshot_error("스크레이프 대상"))
        return PromViewResponse(
            cluster_id=cluster_id, source="snapshot", collected_at=snap.collected_at,
            targets=_targets_from_payload(snap.payload, health),
            **_snapshot_meta(db, snap.collected_at))

    prom = _prom_for(cluster)
    if prom is None:
        return PromViewResponse(cluster_id=cluster_id, source="offline", detail=_offline_detail(cluster))

    result = await prom.targets(state="active")
    if result.get("status") != "ok":
        message = _prom_error(result)
        return PromViewResponse(
            cluster_id=cluster_id, source="offline", detail=message,
            errors=[SourceError(source="prometheus", message=message)])
    return PromViewResponse(
        cluster_id=cluster_id, source="live", collected_at=datetime.utcnow(),
        targets=_targets_from_payload(result.get("data"), health))


@router.get("/prometheus/active-alerts", response_model=PromViewResponse)
async def prometheus_active_alerts(
    cluster_id: Optional[UUID] = Query(default=None),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
) -> PromViewResponse:
    """Prometheus 의 발화/대기 알람 + Alertmanager 보유 알람을 합쳐서 보여준다.

    한쪽 실패를 버리지 않는다(D-183) — 실패 출처는 ``errors`` 에 남고,
    Prometheus 실패 + Alertmanager 성공이면 ``source="partial"``, Alertmanager 만 실패하면
    ``source="live"`` + ``detail`` 안내. 둘 다 실패해야 ``offline``.
    """
    cluster = _visible_cluster(db, actor, cluster_id)

    if _mode(cluster) == "push":
        snap = _latest_snapshot(db, cluster_id, "kube-prometheus-stack", "alerts")
        if snap is None:
            return PromViewResponse(
                cluster_id=cluster_id, source="offline",
                detail="push 모드인데 알람 스냅샷이 아직 없습니다.",
                errors=_missing_snapshot_error("알람"))
        payload = snap.payload
        alerts = (
            _alerts_from_prometheus(payload) if isinstance(payload, dict)
            else _alerts_from_alertmanager(payload)
        )
        return PromViewResponse(
            cluster_id=cluster_id, source="snapshot", collected_at=snap.collected_at, alerts=alerts,
            **_snapshot_meta(db, snap.collected_at))

    prom = _prom_for(cluster)
    if prom is None:
        return PromViewResponse(cluster_id=cluster_id, source="offline", detail=_offline_detail(cluster))

    am = _alertmanager_for(cluster)
    prom_result, am_result = await asyncio.gather(
        _safe_call(prom.active_alerts()),
        _safe_call(am.alerts()) if am else _noop_result(),
    )
    prom_ok = prom_result.get("status") == "ok"
    am_ok = am_result.get("status") == "ok"

    alerts: list[ActiveAlertOut] = []
    errors: list[SourceError] = []
    if prom_ok:
        alerts.extend(_alerts_from_prometheus(prom_result.get("data")))
    else:
        errors.append(SourceError(source="prometheus", message=_prom_error(prom_result)))

    if am_ok:
        # Prometheus 에 이미 있는 알람은 (alertname, namespace, resource) 로 중복 제거.
        seen = {(a.alertname, a.namespace, a.resource) for a in alerts}
        for extra in _alerts_from_alertmanager(am_result.get("data")):
            if (extra.alertname, extra.namespace, extra.resource) not in seen:
                alerts.append(extra)
    else:
        errors.append(SourceError(source="alertmanager", message=_am_error(am_result)))

    if not prom_ok and not am_ok:
        return PromViewResponse(
            cluster_id=cluster_id, source="offline",
            detail=f"{errors[0].message} / {errors[1].message}", errors=errors)
    if not prom_ok:
        return PromViewResponse(
            cluster_id=cluster_id, source="partial", collected_at=datetime.utcnow(), alerts=alerts,
            detail="Prometheus 조회 실패 — Alertmanager 알람만 표시합니다.", errors=errors)
    detail = None if am_ok else "Alertmanager 조회 실패 — Prometheus 알람만 표시합니다."
    return PromViewResponse(
        cluster_id=cluster_id, source="live", collected_at=datetime.utcnow(),
        alerts=alerts, detail=detail, errors=errors)


async def _safe_call(coro) -> dict:
    """서비스가 fail-safe 계약을 어겨 예외를 내도 응답은 구조화된 offline 으로 만든다."""
    try:
        result = await coro
        return result if isinstance(result, dict) else {"status": "error", "error": "응답 형식 오류"}
    except Exception as exc:  # noqa: BLE001
        logger.warning("observability: 외부 조회 예외 — offline 처리 (%s)", exc)
        return {"status": "offline", "data": None, "error": str(exc) or type(exc).__name__}


async def _noop_result() -> dict:
    """Alertmanager 미설정 시 gather 자리를 채우는 no-op."""
    return {"status": "offline", "data": None, "error": "Alertmanager 가 설정되지 않았습니다."}


# ── 알람 인박스 ──────────────────────────────────────────────────────────────

def _alert_out(event: AlertEvent, cluster_names: dict[UUID, str]) -> AlertEventOut:
    raw_json: Optional[str] = None
    if event.raw is not None:
        try:
            raw_json = json.dumps(event.raw, ensure_ascii=False, indent=2, default=str)
        except (TypeError, ValueError):
            raw_json = str(event.raw)
    return AlertEventOut(
        id=event.id,
        cluster_id=event.cluster_id,
        cluster_name=cluster_names.get(event.cluster_id) if event.cluster_id else None,
        source=event.source,
        fingerprint=event.fingerprint,
        alertname=event.alertname,
        severity=event.severity,
        severity_source=event.severity_source,
        status=event.status,
        namespace=event.namespace,
        resource=event.resource,
        summary=event.summary,
        description=event.description,
        starts_at=event.starts_at,
        ends_at=event.ends_at,
        generator_url=event.generator_url,
        occurrences=event.occurrences or 1,
        notify_count=event.notify_count or 0,
        suppressed_count=event.suppressed_count or 0,
        last_notified_at=event.last_notified_at,
        acked=bool(event.acked),
        ack_by=event.ack_by,
        ack_at=event.ack_at,
        received_at=event.received_at,
        labels=to_kv(event.labels),
        annotations=to_kv(event.annotations),
        raw_json=raw_json,
        analysis_id=event.analysis_id,
        analysis_status=event.analysis_status,
    )


def _cluster_names(db: Session) -> dict[UUID, str]:
    return {c.id: c.name for c in db.query(Cluster.id, Cluster.name).all()}


def _filter_alerts(query, *, cluster_id=None, severity=None, status=None, q=None):
    """목록·일괄 확인이 **같은 조건**으로 알람을 고르게 하는 공용 필터(D-103)."""
    if cluster_id:
        query = query.filter(AlertEvent.cluster_id == cluster_id)
    if severity and severity != "all":
        query = query.filter(AlertEvent.severity == severity)
    if status and status != "all":
        query = query.filter(AlertEvent.status == status)
    if q:
        pattern = f"%{q}%"
        query = query.filter(or_(
            AlertEvent.alertname.ilike(pattern),
            AlertEvent.summary.ilike(pattern),
            AlertEvent.resource.ilike(pattern),
            AlertEvent.namespace.ilike(pattern),
        ))
    return query


def _load_visible_alert(db: Session, alert_id: UUID, scope: ClusterScope) -> AlertEvent:
    """보이지 않는(다른 테넌트 클러스터) 알람은 존재 자체를 숨긴다 — 404(D-103)."""
    event = db.query(AlertEvent).filter(AlertEvent.id == alert_id).first()
    if not event or not scope.visible(event.cluster_id):
        raise HTTPException(status_code=404, detail="알람을 찾을 수 없습니다.")
    return event


class AlertEventPageResponse(AlertEventListResponse):
    """알람 목록 한 페이지 — ``has_more`` 로 "더 보기" 여부를 알린다(D-111).

    공용 스키마(`schemas/observability.py`)는 건드리지 않고 이 라우터에서만 확장한다.
    """

    has_more: bool = False
    # 다음 페이지 키셋 커서 — "더 보기" 는 offset 대신 이 값을 ``cursor`` 로 넘긴다(행 누락 방지).
    next_cursor: Optional[str] = None


@router.get("/alerts", response_model=AlertEventPageResponse)
def list_alerts(
    cluster_id: Optional[UUID] = Query(default=None),
    severity: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None, description="firing | resolved"),
    alertname: Optional[str] = Query(default=None),
    q: Optional[str] = Query(default=None, description="alertname/summary/resource 부분 검색"),
    acked: Optional[bool] = Query(default=None),
    from_: Optional[datetime] = Query(default=None, alias="from"),
    to: Optional[datetime] = Query(default=None),
    limit: int = Query(default=100, le=500),
    offset: int = Query(default=0, ge=0),
    cursor: Optional[str] = Query(default=None, description="이전 페이지 next_cursor — 주면 offset 무시"),
    db: Session = Depends(get_db),
    scope: ClusterScope = Depends(get_cluster_scope),
) -> AlertEventPageResponse:
    query = _filter_alerts(
        scope.apply(db.query(AlertEvent), AlertEvent.cluster_id, nullable=True),
        cluster_id=cluster_id, severity=severity, status=status, q=q,
    )
    if alertname:
        query = query.filter(AlertEvent.alertname == alertname)
    if acked is not None:
        query = query.filter(AlertEvent.acked.is_(acked))
    if from_:
        query = query.filter(AlertEvent.received_at >= from_)
    if to:
        query = query.filter(AlertEvent.received_at <= to)

    total = query.count()
    # id 보조 정렬 — 같은 시각 행의 순서를 고정해 "더 보기" 경계가 흔들리지 않게(D-111).
    ordered = query.order_by(desc(AlertEvent.received_at), desc(AlertEvent.id))
    if cursor:
        rows, has_more, next_cursor = page_with_cursor(
            apply_cursor(ordered, AlertEvent.received_at, AlertEvent.id, cursor), limit)
    else:
        rows, has_more, next_cursor = page_with_cursor(ordered.offset(offset), limit)
    names = _cluster_names(db)
    data = [_alert_out(r, names) for r in rows]
    return AlertEventPageResponse(data=data, total=total, has_more=has_more, next_cursor=next_cursor)


@router.get("/alerts/stats", response_model=AlertStatsResponse)
def alert_stats(
    cluster_id: Optional[UUID] = Query(default=None),
    hours: int = Query(default=24, ge=1, le=720),
    db: Session = Depends(get_db),
    scope: ClusterScope = Depends(get_cluster_scope),
) -> AlertStatsResponse:
    since = datetime.utcnow() - timedelta(hours=hours)
    query = scope.apply(db.query(AlertEvent), AlertEvent.cluster_id, nullable=True).filter(
        AlertEvent.received_at >= since)
    if cluster_id:
        query = query.filter(AlertEvent.cluster_id == cluster_id)
    # 행을 올리지 않고 DB 에서 센다 — 예전엔 최대 30일치 AlertEvent 를 raw/labels JSONB 째 읽어 파이썬에서 셌다.
    def _n(cond):
        return func.count(case((cond, 1)))

    total, firing, resolved, critical, warning, info, unacked = query.with_entities(
        func.count(),
        _n(AlertEvent.status == "firing"),
        _n(AlertEvent.status == "resolved"),
        _n(AlertEvent.severity == "critical"),
        _n(AlertEvent.severity == "warning"),
        _n(AlertEvent.severity == "info"),
        _n(and_(AlertEvent.acked.is_(False), AlertEvent.status == "firing")),
    ).one()
    return AlertStatsResponse(
        firing=firing, resolved=resolved, critical=critical, warning=warning, info=info,
        unacked=unacked, total=total,
    )


@router.get("/alerts/{alert_id}", response_model=AlertEventOut)
def get_alert(alert_id: UUID, db: Session = Depends(get_db),
              scope: ClusterScope = Depends(get_cluster_scope)) -> AlertEventOut:
    return _alert_out(_load_visible_alert(db, alert_id, scope), _cluster_names(db))


@router.post("/alerts/{alert_id}/ack", response_model=AlertEventOut)
def ack_alert(
    alert_id: UUID,
    body: AlertAckInput = Body(default=AlertAckInput()),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
    scope: ClusterScope = Depends(get_cluster_scope),
) -> AlertEventOut:
    # 확인(ack)은 역할 제한 없이 알람을 볼 수 있는 사용자면 된다 — 다만 다른 테넌트 알람은 못 본다(D-103).
    event = _load_visible_alert(db, alert_id, scope)
    event.acked = bool(body.acked)
    event.ack_by = (actor.display_name or actor.username) if body.acked else None
    event.ack_at = datetime.utcnow() if body.acked else None
    db.commit()
    db.refresh(event)
    return _alert_out(event, _cluster_names(db))


@router.post("/alerts/ack-all")
def ack_all_alerts(
    cluster_id: Optional[UUID] = Query(default=None),
    severity: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None, description="firing | resolved — 목록 필터와 동일"),
    q: Optional[str] = Query(default=None, description="목록 검색어와 동일"),
    db: Session = Depends(get_db),
    actor: User = Depends(get_current_user),
    scope: ClusterScope = Depends(get_cluster_scope),
) -> dict[str, int]:
    """화면에 보이는 조건(클러스터·심각도·상태·검색어)과 **같은** 미확인 알람만 확인 처리한다.

    D-103: 예전엔 테넌트 범위 없이 전체를 훑고 상태·검색 필터를 무시해, "전체 클러스터"에서 누르면
    보이지 않는 다른 테넌트 알람까지 확인 처리됐다.
    """
    query = _filter_alerts(
        scope.apply(db.query(AlertEvent), AlertEvent.cluster_id, nullable=True),
        cluster_id=cluster_id, severity=severity, status=status, q=q,
    ).filter(AlertEvent.acked.is_(False))
    who = actor.display_name or actor.username
    now = datetime.utcnow()
    # 1000건씩 id 만 골라 묶음 UPDATE 를 반복한다 — 알람 폭주 때도 전체 행(raw JSONB 포함)이나 전체 id 목록을
    # 메모리에 올리지 않는다. 갱신된 행은 `acked = false` 조건에서 빠지므로 다음 묶음이 자연히 이어진다.
    count = 0
    while True:
        ids = [r[0] for r in query.with_entities(AlertEvent.id).limit(1000).all()]
        if not ids:
            break
        db.query(AlertEvent).filter(AlertEvent.id.in_(ids)).update(
            {AlertEvent.acked: True, AlertEvent.ack_by: who, AlertEvent.ack_at: now},
            synchronize_session=False,
        )
        count += len(ids)
    db.commit()
    return {"acked": count}


@router.get("/alerts/{alert_id}/analysis")
def get_alert_analysis(alert_id: UUID, db: Session = Depends(get_db),
                       scope: ClusterScope = Depends(get_cluster_scope)):
    """알람에 연결된 AI 분석 결과 조회 (최신 1건)."""
    from app.models.incident_analysis import IncidentAnalysis
    from app.schemas.observability import IncidentAnalysisOut

    _load_visible_alert(db, alert_id, scope)

    row = (
        db.query(IncidentAnalysis)
        .filter(IncidentAnalysis.alert_event_id == alert_id)
        .order_by(IncidentAnalysis.created_at.desc())
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="이 알람에 대한 AI 분석이 없습니다.")
    return {"data": IncidentAnalysisOut(
        id=row.id,
        alert_event_id=row.alert_event_id,
        cluster_id=row.cluster_id,
        namespace=row.namespace,
        resource=row.resource,
        trigger=row.trigger,
        status=row.status,
        severity=row.severity,
        root_cause=row.root_cause,
        suggested_actions=list(row.suggested_actions or []),
        related_runbooks=list(row.related_runbooks or []),
        confidence=row.confidence,
        degraded=row.degraded,
        citations=list(row.citations or []),
        analyzed_by=row.analyzed_by,
        matched_rule_id=row.matched_rule_id,
        duration_ms=row.duration_ms,
        error=row.error,
        created_at=row.created_at,
        finished_at=row.finished_at,
    )}


@router.post("/alerts/{alert_id}/analyze")
def trigger_alert_analysis(
    alert_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """수동 AI 분석 실행 — scope 규칙과 무관하게 즉시 llm 큐로 보낸다 (operator+, 클러스터 operate)."""
    event = _load_visible_alert(db, alert_id, scope)
    require_cluster_access(db, user, event.cluster_id, "operate")
    if event.analysis_status in ("queued", "running"):
        return {"ok": True, "status": event.analysis_status, "detail": "이미 분석이 진행 중입니다."}
    try:
        from app.celery_app import run_auto_incident_analysis
        run_auto_incident_analysis.apply_async(args=[str(event.id)], queue="llm")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"분석 큐잉 실패: {e}")
    event.analysis_status = "queued"
    db.commit()
    return {"ok": True, "status": "queued"}


@router.delete("/alerts/{alert_id}", status_code=204)
def delete_alert(
    alert_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(require_operator),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """알람 삭제 — operator 이상 + 알람 클러스터 operate 권한(D-103)."""
    event = _load_visible_alert(db, alert_id, scope)
    require_cluster_access(db, user, event.cluster_id, "operate")
    db.delete(event)
    db.commit()


# ── 알림 규칙 / 전역 설정 ────────────────────────────────────────────────────

def _rule_out(rule: AlertNotifyRule) -> AlertNotifyRuleOut:
    channel_ids: list[UUID] = []
    for raw in rule.channel_ids or []:
        try:
            channel_ids.append(UUID(str(raw)))
        except (ValueError, AttributeError, TypeError):
            continue  # 손상된 값이 있어도 규칙 목록 조회는 성공해야 한다
    return AlertNotifyRuleOut(
        id=rule.id, name=rule.name, enabled=rule.enabled, priority=rule.priority,
        cluster_id=rule.cluster_id, module_key=rule.module_key,
        alertname_pattern=rule.alertname_pattern, namespace_pattern=rule.namespace_pattern,
        label_matchers=to_kv(rule.label_matchers), severity_min=rule.severity_min,
        notify_mode=rule.notify_mode, recipients=list(rule.recipients or []),
        severity_override=rule.severity_override,
        channel_ids=channel_ids,
        dedup_window_sec=rule.dedup_window_sec, dedup_mode=rule.dedup_mode,
    )


def _rule_fields(body: AlertNotifyRuleInput) -> dict[str, Any]:
    if body.notify_mode not in ("all", "users", "none"):
        raise HTTPException(status_code=422, detail="notify_mode 는 all | users | none 이어야 합니다.")
    if body.dedup_mode not in ("first_only", "summarize"):
        raise HTTPException(status_code=422, detail="dedup_mode 는 first_only | summarize 이어야 합니다.")
    for name, value in (("severity_min", body.severity_min), ("severity_override", body.severity_override)):
        if value and value not in SEVERITY_ORDER:
            raise HTTPException(status_code=422, detail=f"{name} 은 info | warning | critical 이어야 합니다.")
    return {
        "name": body.name,
        "enabled": body.enabled,
        "priority": body.priority,
        "cluster_id": body.cluster_id,
        "module_key": body.module_key,
        "alertname_pattern": body.alertname_pattern,
        "namespace_pattern": body.namespace_pattern,
        "label_matchers": {pair.k: pair.v for pair in body.label_matchers},
        "severity_min": body.severity_min,
        "notify_mode": body.notify_mode,
        "recipients": [r for r in body.recipients if str(r).strip()],
        "severity_override": body.severity_override,
        "channel_ids": [str(c) for c in body.channel_ids],
        "dedup_window_sec": max(0, body.dedup_window_sec),
        "dedup_mode": body.dedup_mode,
    }


@router.get("/alert-rules", response_model=list[AlertNotifyRuleOut])
def list_alert_rules(db: Session = Depends(get_db)) -> list[AlertNotifyRuleOut]:
    rules = (
        db.query(AlertNotifyRule)
        .order_by(AlertNotifyRule.priority.asc(), AlertNotifyRule.created_at.asc())
        .all()
    )
    return [_rule_out(r) for r in rules]


@router.post("/alert-rules", response_model=AlertNotifyRuleOut, status_code=201)
def create_alert_rule(
    body: AlertNotifyRuleInput,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
) -> AlertNotifyRuleOut:
    rule = AlertNotifyRule(**_rule_fields(body))
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return _rule_out(rule)


@router.put("/alert-rules/{rule_id}", response_model=AlertNotifyRuleOut)
def update_alert_rule(
    rule_id: UUID,
    body: AlertNotifyRuleInput,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
) -> AlertNotifyRuleOut:
    rule = db.query(AlertNotifyRule).filter(AlertNotifyRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="알림 규칙을 찾을 수 없습니다.")
    for field, value in _rule_fields(body).items():
        setattr(rule, field, value)
    db.commit()
    db.refresh(rule)
    return _rule_out(rule)


@router.delete("/alert-rules/{rule_id}", status_code=204)
def delete_alert_rule(
    rule_id: UUID,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    rule = db.query(AlertNotifyRule).filter(AlertNotifyRule.id == rule_id).first()
    if not rule:
        raise HTTPException(status_code=404, detail="알림 규칙을 찾을 수 없습니다.")
    db.delete(rule)
    db.commit()


@router.get("/alert-settings", response_model=AlertSettingsOut)
def read_alert_settings(db: Session = Depends(get_db)) -> AlertSettingsOut:
    return AlertSettingsOut(**get_alert_settings(db))


@router.put("/alert-settings", response_model=AlertSettingsOut)
def write_alert_settings(
    body: AlertSettingsUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
) -> AlertSettingsOut:
    if body.default_notify_mode and body.default_notify_mode not in ("all", "users", "none"):
        raise HTTPException(status_code=422, detail="default_notify_mode 는 all | users | none 이어야 합니다.")
    if body.dedup_mode and body.dedup_mode not in ("first_only", "summarize"):
        raise HTTPException(status_code=422, detail="dedup_mode 는 first_only | summarize 이어야 합니다.")
    if body.default_severity_min and body.default_severity_min not in SEVERITY_ORDER:
        raise HTTPException(status_code=422, detail="default_severity_min 은 info | warning | critical 이어야 합니다.")
    return AlertSettingsOut(**set_alert_settings(db, body.model_dump(exclude_unset=True)))


# ── Ingest (JWT 없음 — Bearer 토큰 자체 검증) ────────────────────────────────

def _verify_alert_token(authorization: str = Header(default="")) -> None:
    """Bearer <ALERT_INGEST_TOKEN> 검증.

    Fail-closed: 토큰이 설정돼 있지 않으면 무인증 통과가 아니라 **수신 자체를 비활성화**한다
    (kubewatch / superpod ingest 와 동일 정책). 알람 수신구는 인터넷/사내망에 열리는
    엔드포인트라 "설정을 깜빡했다"가 곧 무인증 공개가 되면 안 된다.
    """
    expected = (settings.alert_ingest_token or "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail=(
                "알람 수신 비활성화: ALERT_INGEST_TOKEN 이 설정되지 않았습니다. "
                "백엔드 환경변수에 토큰을 설정한 뒤 Alertmanager receiver 를 등록하세요."
            ),
        )
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(None, 1)[1].strip()
    if not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="수신 토큰이 올바르지 않습니다.")


def _resolve_cluster_id(db: Session, hint: Optional[str]) -> Optional[UUID]:
    """클러스터 힌트(이름 또는 UUID 문자열)를 cluster_id 로 해석. 실패하면 None."""
    if not hint or not str(hint).strip():
        return None
    text = str(hint).strip()
    try:
        candidate = UUID(text)
        if db.query(Cluster.id).filter(Cluster.id == candidate).first():
            return candidate
    except (ValueError, AttributeError):
        pass
    row = db.query(Cluster.id).filter(Cluster.name == text).first()
    return row[0] if row else None


@ingest_router.post("/alerts/ingest", status_code=201)
def ingest_alerts(
    payload: Any = Body(...),
    cluster: Optional[str] = Query(default=None, description="클러스터 이름 또는 UUID (라벨보다 우선)"),
    db: Session = Depends(get_db),
    _: None = Depends(_verify_alert_token),
) -> dict[str, Any]:
    """Alertmanager webhook / 사내 alert-forwarder 알람 수신.

    두 포맷을 모두 받는다(파서가 자동 판별). 개별 알람 처리 실패가 배치 전체를 깨지 않도록
    건별로 try/except 하고, 결과 요약을 돌려준다.
    """
    alerts = parse_alert_payload(payload)
    if not alerts:
        raise HTTPException(status_code=422, detail="알람을 추출할 수 없는 페이로드입니다.")

    results: list[dict[str, Any]] = []
    errors: list[str] = []
    for alert in alerts:
        try:
            cluster_id = _resolve_cluster_id(db, cluster or alert.cluster_hint)
            results.append(route_and_notify(db, alert, cluster_id))
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            logger.warning("alert ingest: '%s' 처리 실패 — 건너뜀 (%s)", alert.alertname, exc)
            errors.append(f"{alert.alertname}: {exc}")

    try:
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("alert ingest: commit 실패 (%s)", exc)
        raise HTTPException(status_code=500, detail=f"알람 저장 실패: {exc}") from exc

    return {"received": len(alerts), "processed": len(results), "errors": errors, "results": results}


@ingest_router.post("/snapshot/ingest", status_code=201)
def ingest_snapshot(
    body: SnapshotIngestInput,
    db: Session = Depends(get_db),
    _: None = Depends(_verify_alert_token),
) -> dict[str, Any]:
    """push 모드 클러스터의 in-cluster 수집기가 보내는 관측 스냅샷 수신."""
    if body.kind not in ("metrics", "rules", "targets", "alerts", "status"):
        raise HTTPException(
            status_code=422, detail="kind 는 metrics | rules | targets | alerts | status 이어야 합니다.")

    cluster_id = _resolve_cluster_id(db, body.cluster)
    if body.cluster and cluster_id is None:
        raise HTTPException(status_code=404, detail=f"클러스터 '{body.cluster}' 를 찾을 수 없습니다.")

    snapshot = ObservabilitySnapshot(
        cluster_id=cluster_id,
        module_key=body.module or "kube-prometheus-stack",
        kind=body.kind,
        payload=body.payload,
        collected_at=body.collected_at or datetime.utcnow(),
    )
    db.add(snapshot)

    # 같은 (클러스터, 모듈, 종류) 의 오래된 스냅샷은 최근 5건만 남긴다 — 무한 증가 방지.
    try:
        db.flush()  # 방금 받은 스냅샷도 세도록(안 하면 6건이 남았다)
        # id 만 골라 지운다 — 스냅샷 payload(JSONB)를 지우려고 다시 읽지 않는다.
        stale_ids = (
            db.query(ObservabilitySnapshot.id)
            .filter(
                ObservabilitySnapshot.cluster_id == cluster_id,
                ObservabilitySnapshot.module_key == snapshot.module_key,
                ObservabilitySnapshot.kind == snapshot.kind,
            )
            .order_by(desc(ObservabilitySnapshot.collected_at))
            .offset(5)
            .all()
        )
        if stale_ids:
            db.query(ObservabilitySnapshot).filter(
                ObservabilitySnapshot.id.in_([r[0] for r in stale_ids])
            ).delete(synchronize_session=False)
    except Exception as exc:  # noqa: BLE001
        logger.warning("snapshot ingest: 오래된 스냅샷 정리 실패 — 무시 (%s)", exc)

    try:
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("snapshot ingest: commit 실패 (%s)", exc)
        raise HTTPException(status_code=500, detail=f"스냅샷 저장 실패: {exc}") from exc

    _invalidate_values_cache()
    return {"id": str(snapshot.id), "cluster_id": str(cluster_id) if cluster_id else None,
            "kind": snapshot.kind, "collected_at": snapshot.collected_at.isoformat()}
