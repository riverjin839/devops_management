"""공통 서비스 — 인스턴스 CRUD·수집 실행(단계·실행 로그)·스냅샷/변경 저장·알람·감시 설정·K8S 후보 찾기.

수집 1회(``run_collect``)
  1) 배포 수준(K8S 워크로드 + 마운트 ConfigMap / Podman inspect) → 2) 앱 설정(서비스별 API·파일)
  → 3) 컴포넌트마다 직전 스냅샷과 해시 비교, 바뀌면 새 스냅샷 + 바뀐 키를 ``CommonServiceChange`` 로, 변경 알람 1건.
  단계 실패는 기록하고 다음 단계로(partial). 실행 로그는 ``CommonServiceRun.log_lines`` 에 단계마다 커밋하고, ``emit`` 이 있으면
  SSE(``services/sse.py`` 규약 log/step)로도 흘린다. kind="test" 는 같은 단계를 돌리되 아무것도 저장하지 않는다.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.common_service import (
    CommonServiceChange,
    CommonServiceCredential,
    CommonServiceInstance,
    CommonServiceLink,
    CommonServiceRun,
    CommonServiceSnapshot,
)
from app.services.common_services import catalog as K
from app.services.common_services import collectors as CO
from app.services.common_services import flatten as F

logger = logging.getLogger(__name__)

Emit = Callable[[dict], None]

SETTINGS_KEY = "common_services.watch"
SETTINGS_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "interval_min": 30,
    "change_alert": True,
    "change_severity": "warning",
    "unreachable_alert": True,
    "unreachable_after": 3,
    "unreachable_severity": "warning",
}
_SEVERITIES = ("info", "warning", "critical")
ALERT_SOURCE = "common-service"
ALERT_CHANGED = "CommonServiceConfigChanged"
ALERT_UNREACHABLE = "CommonServiceUnreachable"
RUN_STALE_MIN = 15
MAX_LOG_LINES = 3000


class CommonServiceError(Exception):
    def __init__(self, status: int, detail: Any):
        super().__init__(str(detail))
        self.status, self.detail = status, detail


# ── 설정 ─────────────────────────────────────────────────────────────────────

def normalize_settings(stored: Any) -> dict[str, Any]:
    out = {**SETTINGS_DEFAULTS, **(stored if isinstance(stored, dict) else {})}
    for k in ("enabled", "change_alert", "unreachable_alert"):
        out[k] = bool(out[k])
    for k, lo, hi in (("interval_min", 5, 1440), ("unreachable_after", 1, 100)):
        try:
            out[k] = max(lo, min(int(out[k]), hi))
        except (TypeError, ValueError):
            out[k] = SETTINGS_DEFAULTS[k]
    for k in ("change_severity", "unreachable_severity"):
        if out[k] not in _SEVERITIES:
            out[k] = SETTINGS_DEFAULTS[k]
    return {k: out[k] for k in SETTINGS_DEFAULTS}


def get_settings(db: Session) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    try:
        row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    except Exception:  # noqa: BLE001
        db.rollback()
        return normalize_settings(None)
    return normalize_settings(row.value if row else None)


def set_settings(db: Session, patch: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    prev = row.value if row and isinstance(row.value, dict) else {}
    merged = normalize_settings({**prev, **{k: v for k, v in patch.items() if v is not None}})
    if row:
        row.value = merged
    else:
        db.add(AppSetting(key=SETTINGS_KEY, value=merged))
    db.commit()
    return merged


# ── 직렬화 ───────────────────────────────────────────────────────────────────

def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.replace(tzinfo=timezone.utc).isoformat() if dt else None


def serialize(db: Session, inst: CommonServiceInstance, cluster_names: Optional[dict[UUID, str]] = None) -> dict[str, Any]:
    names = cluster_names or {c.id: c.name for c in db.query(Cluster.id, Cluster.name).all()}
    creds = db.query(CommonServiceCredential).filter(CommonServiceCredential.instance_id == inst.id).all()
    links = db.query(CommonServiceLink).filter(CommonServiceLink.instance_id == inst.id).all()
    return {
        "id": str(inst.id), "service_type": inst.service_type, "name": inst.name, "description": inst.description,
        "endpoint_url": inst.endpoint_url, "tls_verify": inst.tls_verify, "host_kind": inst.host_kind,
        "cluster_id": str(inst.cluster_id) if inst.cluster_id else None,
        "cluster_name": names.get(inst.cluster_id) if inst.cluster_id else None,
        "namespace": inst.namespace, "workload_kind": inst.workload_kind, "workload_name": inst.workload_name,
        "ssh_host": inst.ssh_host, "ssh_port": inst.ssh_port, "container_name": inst.container_name,
        # 키/값 목록 — 응답 camelCase 변환이 ``auth_realm`` 같은 params 키를 바꾸지 않게(요청도 같은 형식).
        "params": [{"key": k, "value": v} for k, v in K.normalize_params(inst.service_type, inst.params).items()],
        "watch_enabled": inst.watch_enabled, "status": inst.status, "last_collected_at": _iso(inst.last_collected_at),
        "last_error": inst.last_error, "fail_count": inst.fail_count,
        "credentials": [{"purpose": c.purpose, "auth_type": c.auth_type, "username": c.username, "has_secret": bool(c.secret)}
                        for c in creds],
        "links": [{"cluster_id": str(lk.cluster_id), "cluster_name": names.get(lk.cluster_id), "relation": lk.relation}
                  for lk in links],
        "created_by": inst.created_by, "created_at": _iso(inst.created_at), "updated_at": _iso(inst.updated_at),
    }


def list_instances(db: Session, hidden: frozenset[UUID] = frozenset(), service_type: Optional[str] = None) -> list[dict[str, Any]]:
    q = db.query(CommonServiceInstance)
    if service_type:
        q = q.filter(CommonServiceInstance.service_type == service_type)
    names = {c.id: c.name for c in db.query(Cluster.id, Cluster.name).all()}
    return [serialize(db, i, names) for i in q.order_by(CommonServiceInstance.service_type, CommonServiceInstance.name).all()
            if not (i.cluster_id and i.cluster_id in hidden)]


def get_instance(db: Session, instance_id: UUID) -> CommonServiceInstance:
    inst = db.query(CommonServiceInstance).filter(CommonServiceInstance.id == instance_id).first()
    if inst is None:
        raise CommonServiceError(404, "공통 서비스를 찾을 수 없습니다.")
    return inst


# ── 쓰기 ─────────────────────────────────────────────────────────────────────

_FIELDS = ("name", "description", "endpoint_url", "tls_verify", "host_kind", "cluster_id", "namespace", "workload_kind",
           "workload_name", "ssh_host", "ssh_port", "container_name", "watch_enabled")


def _validate(db: Session, data: dict[str, Any]) -> None:
    st = data.get("service_type")
    if st not in K.SERVICE_KEYS:
        raise CommonServiceError(422, f"알 수 없는 서비스 종류: {st}")
    hk = data.get("host_kind")
    if hk not in K.meta(st)["host_kinds"]:
        raise CommonServiceError(422, f"{K.meta(st)['label']} 는 호스팅 방식 '{hk}' 를 지원하지 않습니다.")
    if hk == "k8s":
        if not data.get("cluster_id") or not data.get("namespace") or not data.get("workload_name"):
            raise CommonServiceError(422, "K8S 호스팅은 클러스터·네임스페이스·워크로드 이름이 필요합니다.")
        if not db.query(Cluster.id).filter(Cluster.id == data["cluster_id"]).first():
            raise CommonServiceError(422, "호스팅 클러스터를 찾을 수 없습니다.")
    if hk == "podman" and (not data.get("ssh_host") or not data.get("container_name")):
        raise CommonServiceError(422, "Podman 호스팅은 SSH 호스트와 컨테이너 이름이 필요합니다.")
    if st != "argocd" and hk != "k8s" and not (data.get("endpoint_url") or "").strip() and hk != "podman":
        raise CommonServiceError(422, "엔드포인트 주소가 필요합니다.")


def save_instance(db: Session, data: dict[str, Any], actor: str, instance_id: Optional[UUID] = None) -> CommonServiceInstance:
    if instance_id:
        inst = get_instance(db, instance_id)
        data = {**data, "service_type": inst.service_type}
    else:
        inst = CommonServiceInstance(service_type=data.get("service_type"), created_by=actor)
    _validate(db, data)
    dup = (db.query(CommonServiceInstance.id)
           .filter(CommonServiceInstance.service_type == data["service_type"], CommonServiceInstance.name == data["name"],
                   CommonServiceInstance.id != (inst.id or instance_id)).first()) if data.get("name") else None
    if dup:
        raise CommonServiceError(409, "같은 서비스에 같은 이름의 인스턴스가 있습니다.")
    for f in _FIELDS:
        if f in data:
            setattr(inst, f, data[f])
    if inst.host_kind != "k8s":
        inst.cluster_id = inst.namespace = inst.workload_kind = inst.workload_name = None
    if inst.host_kind != "podman":
        inst.ssh_host = inst.container_name = None
    raw = data.get("params", inst.params)
    if isinstance(raw, list):  # [{key, value}] — 화면 형식
        raw = {str(p.get("key")): p.get("value") for p in raw if isinstance(p, dict) and p.get("key")}
    inst.params = K.normalize_params(inst.service_type, raw)
    if instance_id is None:
        db.add(inst)
    db.flush()
    for c in data.get("credentials") or []:
        _save_cred(db, inst.id, c)
    if "links" in data:
        db.query(CommonServiceLink).filter(CommonServiceLink.instance_id == inst.id).delete()
        seen: set[str] = set()
        for lk in data["links"] or []:
            cid = str(lk.get("cluster_id") or "")
            if cid and cid not in seen and db.query(Cluster.id).filter(Cluster.id == cid).first():
                seen.add(cid)
                db.add(CommonServiceLink(instance_id=inst.id, cluster_id=cid, relation=(lk.get("relation") or "")[:200] or None))
    db.commit()
    db.refresh(inst)
    return inst


def _save_cred(db: Session, instance_id: UUID, c: dict[str, Any]) -> None:
    purpose = c.get("purpose")
    if purpose not in K.CRED_PURPOSES:
        return
    row = (db.query(CommonServiceCredential)
           .filter(CommonServiceCredential.instance_id == instance_id, CommonServiceCredential.purpose == purpose).first())
    if c.get("clear"):
        if row:
            db.delete(row)
        return
    if row is None:
        row = CommonServiceCredential(instance_id=instance_id, purpose=purpose)
        db.add(row)
    row.auth_type = c.get("auth_type") if c.get("auth_type") in ("password", "token", "private_key") else "password"
    row.username = (c.get("username") or "").strip()[:255] or None
    if c.get("secret"):  # 비우면 기존 값 유지(쓰기 전용)
        row.secret = c["secret"]


def delete_instance(db: Session, instance_id: UUID) -> None:
    inst = get_instance(db, instance_id)
    db.delete(inst)
    db.commit()


# ── 실행 로그 ────────────────────────────────────────────────────────────────

class RunLog:
    """실행 로그·단계 — DB(``log_lines``/``steps``) + SSE emit. 단계가 끝날 때마다 커밋한다."""

    def __init__(self, db: Session, run: CommonServiceRun, emit: Optional[Emit]):
        self.db, self.run, self.emit = db, run, emit
        self.lines: list[list[str]] = list(run.log_lines or [])
        self.steps: list[dict[str, Any]] = list(run.steps or [])

    def log(self, level: str, message: str) -> None:
        ts = datetime.now(timezone.utc).isoformat()
        if len(self.lines) < MAX_LOG_LINES:
            self.lines.append([ts, level, message])
        if self.emit:
            self.emit({"type": "log", "level": level, "ts": ts, "message": message})

    def step(self, name: str, label: str, status: str, message: str = "") -> None:
        found = next((s for s in self.steps if s["name"] == name), None)
        if found is None:
            self.steps.append({"name": name, "label": label, "status": status, "message": message})
        else:
            found.update(status=status, message=message)
        if self.emit:
            self.emit({"type": "step", "name": name, "label": label, "status": status})

    def flush(self) -> None:
        self.run.log_lines = list(self.lines)
        self.run.steps = [dict(s) for s in self.steps]
        try:
            self.db.commit()
        except Exception:  # noqa: BLE001
            self.db.rollback()


def running_run(db: Session, instance_id: UUID) -> Optional[CommonServiceRun]:
    since = datetime.utcnow() - timedelta(minutes=RUN_STALE_MIN)
    return (db.query(CommonServiceRun)
            .filter(CommonServiceRun.instance_id == instance_id, CommonServiceRun.status == "running",
                    CommonServiceRun.started_at >= since).first())


def start_run(db: Session, inst: CommonServiceInstance, kind: str, trigger: str, actor: Optional[str]) -> CommonServiceRun:
    if running_run(db, inst.id):
        raise CommonServiceError(409, "이 인스턴스는 이미 수집 중입니다. 끝난 뒤 다시 시도하세요.")
    run = CommonServiceRun(instance_id=inst.id, kind=kind, trigger=trigger, status="running", started_by=actor,
                           steps=[], log_lines=[])
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def _creds(db: Session, inst: CommonServiceInstance) -> dict[str, Any]:
    rows = db.query(CommonServiceCredential).filter(CommonServiceCredential.instance_id == inst.id).all()
    return {r.purpose: {"username": r.username, "secret": r.secret, "auth_type": r.auth_type} for r in rows}


def _plan_steps(inst: CommonServiceInstance) -> list[tuple[str, str, Callable[..., Any]]]:
    steps: list[tuple[str, str, Callable[..., Any]]] = []
    if inst.host_kind == "k8s":
        steps.append(("deploy", "K8S 워크로드 설정", CO.collect_k8s_deploy))
    elif inst.host_kind == "podman":
        steps.append(("deploy", "Podman 컨테이너 설정", CO.collect_podman))
    app = CO.APP_COLLECTORS.get(inst.service_type)
    if app is not None:
        steps.append(("app", CO.APP_LABELS.get(inst.service_type, "앱 설정"), app))
    return steps


def run_collect(db: Session, inst: CommonServiceInstance, run: CommonServiceRun, emit: Optional[Emit] = None) -> dict[str, Any]:
    """동기 실행(Celery 워커·SSE 의 executor 스레드). 반환 = 요약(화면 result 이벤트)."""
    log = RunLog(db, run, emit)
    store = run.kind == "collect"
    meta = K.meta(inst.service_type)
    cluster = db.query(Cluster).filter(Cluster.id == inst.cluster_id).first() if inst.cluster_id else None
    ctx = CO.Ctx(inst=inst, params=K.normalize_params(inst.service_type, inst.params), creds=_creds(db, inst),
                 cluster=cluster, log=log.log)
    where = {"k8s": f"K8S {cluster.name if cluster else '?'} · {inst.namespace}/{inst.workload_name}",
             "podman": f"Podman {inst.ssh_host} · {inst.container_name}", "external": f"외부 {inst.endpoint_url or ''}"}
    log.log("info", f"{meta['label']} '{inst.name}' {'수집' if store else '접속 테스트'} 시작 — {where.get(inst.host_kind, '')}")
    ok = failed = 0
    errors: list[str] = []
    for name, label, fn in _plan_steps(inst):
        log.step(name, label, "running")
        try:
            fn(ctx)
            ok += 1
            log.step(name, label, "done")
        except CO.CollectError as exc:
            failed += 1
            errors.append(f"{label}: {exc}")
            log.log("error", f"{label} 실패: {exc}")
            log.step(name, label, "failed", str(exc)[:300])
        except Exception as exc:  # noqa: BLE001 — 외부 서비스 오류는 단계 실패로
            failed += 1
            errors.append(f"{label}: {str(exc)[:300]}")
            log.log("error", f"{label} 실패: {type(exc).__name__}: {str(exc)[:300]}")
            log.step(name, label, "failed", str(exc)[:300])
        log.flush()

    changes: list[dict[str, Any]] = []
    now = datetime.utcnow()
    if store and ctx.components:
        log.step("store", "변경 비교·저장", "running")
        for comp, payload in ctx.components.items():
            chs = store_snapshot(db, inst, comp, payload["flat"], payload["meta"], now, run.trigger)
            if chs:
                log.log("warn", f"{comp}: {len(chs)}개 변경 — " + ", ".join(
                    f"{c['key']} {c['old'] or '없음'} → {c['new'] or '없음'}" for c in chs[:5]) + (" …" if len(chs) > 5 else ""))
            changes.extend({**c, "component": comp} for c in chs)
        db.commit()  # 스냅샷·변경 이력은 알람 처리와 무관하게 먼저 확정한다
        log.step("store", "변경 비교·저장", "done")
        log.log("info", f"변경 {len(changes)}건" if changes else "직전 수집과 같습니다(변경 없음).")

    status = "succeeded" if failed == 0 and ok > 0 else ("partial" if ok > 0 else "failed")
    total_keys = sum(len(p["flat"]) for p in ctx.components.values())
    summary = {"components": len(ctx.components), "keys": total_keys, "changed": len(changes),
               "changes": [{k: c[k] for k in ("component", "key", "old", "new")} for c in changes[:50]], "errors": errors}
    run.status, run.summary, run.finished_at = status, summary, datetime.utcnow()
    if store:
        _after_collect(db, inst, status, errors, changes, run)
    log.log("info" if status == "succeeded" else ("warn" if status == "partial" else "error"),
            f"끝 — {({'succeeded': '성공', 'partial': '일부 실패', 'failed': '실패'})[status]} · 컴포넌트 {len(ctx.components)} · 설정 {total_keys}개")
    log.flush()
    return {"run_id": str(run.id), "status": status, **summary}


# ── 스냅샷·변경 ──────────────────────────────────────────────────────────────

def store_snapshot(db: Session, inst: CommonServiceInstance, component: str, flat: dict[str, Any], meta: dict[str, Any],
                   now: datetime, source: str) -> list[dict[str, Any]]:
    """해시가 바뀐 때만 새 스냅샷. 직전 스냅샷이 있으면 바뀐 키를 변경 이력으로. 첫 수집은 변경이 아니다."""
    h = F.content_hash(flat)
    prev = (db.query(CommonServiceSnapshot)
            .filter(CommonServiceSnapshot.instance_id == inst.id, CommonServiceSnapshot.component == component)
            .order_by(CommonServiceSnapshot.collected_at.desc()).first())
    if prev is not None and prev.content_hash == h:
        return []
    snap = CommonServiceSnapshot(instance_id=inst.id, component=component, data={"flat": flat, "meta": meta},
                                 content_hash=h, collected_at=now)
    db.add(snap)
    db.flush()
    if prev is None:
        return []
    changes = F.diff_flat((prev.data or {}).get("flat") or {}, flat)
    for c in changes:
        db.add(CommonServiceChange(instance_id=inst.id, component=component, key=c["key"][:500],
                                   old_value=c["old"], new_value=c["new"], source=source,
                                   to_snapshot_id=snap.id, detected_at=now))
    return changes


def latest_config(db: Session, inst: CommonServiceInstance) -> dict[str, Any]:
    """컴포넌트별 최신 스냅샷의 평탄 값 + 24시간 안 키별 마지막 변경."""
    rows = (db.query(CommonServiceSnapshot)
            .filter(CommonServiceSnapshot.instance_id == inst.id)
            .order_by(CommonServiceSnapshot.component, CommonServiceSnapshot.collected_at.desc())
            .distinct(CommonServiceSnapshot.component).all())
    since = datetime.utcnow() - timedelta(hours=24)
    recent: dict[tuple[str, str], CommonServiceChange] = {}
    for ch in (db.query(CommonServiceChange)
               .filter(CommonServiceChange.instance_id == inst.id, CommonServiceChange.detected_at >= since)
               .order_by(CommonServiceChange.detected_at.asc()).all()):
        recent[(ch.component, ch.key)] = ch
    comps = []
    for s in sorted(rows, key=lambda r: (not r.component.startswith(("deploy", "podman")), r.component)):
        flat = (s.data or {}).get("flat") or {}
        comps.append({
            "component": s.component, "collected_at": _iso(s.collected_at), "meta": (s.data or {}).get("meta") or {},
            "items": [{"key": k, "value": v, **({"changed": {"old": recent[(s.component, k)].old_value,
                                                             "new": recent[(s.component, k)].new_value,
                                                             "at": _iso(recent[(s.component, k)].detected_at)}}
                                                if (s.component, k) in recent else {})} for k, v in flat.items()],
        })
    return {"components": comps}


def list_changes(db: Session, inst: CommonServiceInstance, limit: int = 300) -> list[dict[str, Any]]:
    rows = (db.query(CommonServiceChange).filter(CommonServiceChange.instance_id == inst.id)
            .order_by(CommonServiceChange.detected_at.desc()).limit(limit).all())
    return [{"id": str(r.id), "component": r.component, "key": r.key, "old_value": r.old_value, "new_value": r.new_value,
             "source": r.source, "detected_at": _iso(r.detected_at)} for r in rows]


def run_row(r: CommonServiceRun, full: bool = False) -> dict[str, Any]:
    out = {"id": str(r.id), "kind": r.kind, "trigger": r.trigger, "status": r.status, "started_by": r.started_by,
           "started_at": _iso(r.started_at), "finished_at": _iso(r.finished_at), "summary": r.summary or {},
           "steps": r.steps or []}
    if full:
        out["log_lines"] = r.log_lines or []
    return out


def list_runs(db: Session, inst: CommonServiceInstance, limit: int = 50) -> list[dict[str, Any]]:
    rows = (db.query(CommonServiceRun).filter(CommonServiceRun.instance_id == inst.id)
            .order_by(CommonServiceRun.started_at.desc()).limit(limit).all())
    return [run_row(r) for r in rows]


# ── 상태·알람 ────────────────────────────────────────────────────────────────

def _after_collect(db: Session, inst: CommonServiceInstance, status: str, errors: list[str],
                   changes: list[dict[str, Any]], run: CommonServiceRun) -> None:
    cfg = get_settings(db)
    prev_fail = inst.fail_count or 0
    inst.last_collected_at = datetime.utcnow()
    inst.status = {"succeeded": "ok", "partial": "partial", "failed": "error"}[status]
    inst.last_error = "; ".join(errors)[:2000] or None
    inst.fail_count = prev_fail + 1 if status == "failed" else 0
    db.commit()
    try:
        with db.begin_nested():  # 알람 실패가 수집 결과를 되돌리지 않게 세이브포인트로 격리
            _alerts(db, inst, cfg, status, prev_fail, changes, run)
        db.commit()
    except Exception as exc:  # noqa: BLE001 — 알람 실패가 수집 결과를 막지 않는다
        db.rollback()
        logger.warning("common-service alert failed %s: %s", inst.id, exc)


def _alerts(db: Session, inst: CommonServiceInstance, cfg: dict[str, Any], status: str, prev_fail: int,
            changes: list[dict[str, Any]], run: CommonServiceRun) -> None:
    if changes and cfg["change_alert"]:
        _alert(db, inst, ALERT_CHANGED, cfg["change_severity"], "firing", str(run.id),
               f"{K.meta(inst.service_type)['label']} {inst.name}: 설정 {len(changes)}개 변경 — "
               + ", ".join(f"{c['key']} {c['old'] or '없음'}→{c['new'] or '없음'}" for c in changes[:3])
               + (" …" if len(changes) > 3 else ""),
               "\n".join(f"- [{c['component']}] {c['key']}: {c['old'] or '없음'} → {c['new'] or '없음'}" for c in changes[:30]))
    if cfg["unreachable_alert"]:
        if inst.fail_count == cfg["unreachable_after"]:
            _alert(db, inst, ALERT_UNREACHABLE, cfg["unreachable_severity"], "firing", "",
                   f"{K.meta(inst.service_type)['label']} {inst.name}: {inst.fail_count}회 연속 수집 실패",
                   inst.last_error or "")
        elif status != "failed" and prev_fail >= cfg["unreachable_after"]:
            _alert(db, inst, ALERT_UNREACHABLE, cfg["unreachable_severity"], "resolved", "",
                   f"{K.meta(inst.service_type)['label']} {inst.name}: 수집 복구", "")


def _alert(db: Session, inst: CommonServiceInstance, alertname: str, severity: str, status: str, salt: str,
           summary: str, description: str) -> None:
    from app.services.observability.alert_ingest import ParsedAlert, compute_fingerprint
    from app.services.observability.alert_router import route_and_notify

    labels = {"source": ALERT_SOURCE, "service": inst.service_type, "instance": inst.name}
    fp = compute_fingerprint(alertname, {"instance": str(inst.id), **({"run": salt} if salt else {})})
    cluster_name = None
    if inst.cluster_id:
        c = db.query(Cluster.name).filter(Cluster.id == inst.cluster_id).first()
        cluster_name = c[0] if c else None
    route_and_notify(db, ParsedAlert(
        alertname=alertname, fingerprint=fp, status=status, severity=severity, summary=summary[:500],
        description=description, resource=inst.name, cluster_hint=cluster_name,
        starts_at=None, labels={**labels, **({"cluster": cluster_name} if cluster_name else {})},
        annotations={}, raw={}, source=ALERT_SOURCE,
    ), inst.cluster_id)


def service_status(db: Session, hidden: frozenset[UUID] = frozenset()) -> dict[str, Any]:
    """서비스 레일 상태 점 — 서비스별 인스턴스 수·가장 나쁜 상태."""
    rank = {"error": 3, "partial": 2, "unknown": 1, "ok": 0}
    out: dict[str, Any] = {k: {"count": 0, "level": "ok", "reasons": []} for k in K.SERVICE_KEYS}
    for i in db.query(CommonServiceInstance).all():
        if i.cluster_id and i.cluster_id in hidden:
            continue
        s = out.setdefault(i.service_type, {"count": 0, "level": "ok", "reasons": []})
        s["count"] += 1
        if i.status in ("error", "partial"):
            s["reasons"].append(f"{i.name}: {'수집 실패' if i.status == 'error' else '일부 실패'}")
            if rank[i.status] > rank.get(s["level"], 0):
                s["level"] = i.status
    for s in out.values():
        s["level"] = {"error": "critical", "partial": "warning"}.get(s["level"], "ok")
    return out


# ── 주기 수집 ────────────────────────────────────────────────────────────────

def due_instances(db: Session, now: datetime) -> list[CommonServiceInstance]:
    cfg = get_settings(db)
    if not cfg["enabled"]:
        return []
    limit = now - timedelta(minutes=cfg["interval_min"]) + timedelta(seconds=5)
    return [i for i in db.query(CommonServiceInstance).filter(CommonServiceInstance.watch_enabled.is_(True)).all()
            if i.last_collected_at is None or i.last_collected_at <= limit]


def collect_scheduled(db: Session, instance_id: str) -> dict[str, Any]:
    inst = db.query(CommonServiceInstance).filter(CommonServiceInstance.id == instance_id).first()
    if inst is None:
        return {"error": "instance not found"}
    try:
        run = start_run(db, inst, "collect", "schedule", None)
    except CommonServiceError as exc:
        return {"skipped": str(exc.detail)}
    return run_collect(db, inst, run)


# ── K8S 후보 찾기 ────────────────────────────────────────────────────────────

def discover(db: Session, cluster: Cluster, namespace: Optional[str], service_type: Optional[str]) -> list[dict[str, Any]]:
    """클러스터(·NS)의 Deployment/StatefulSet 중 카탈로그 이미지·이름 패턴에 맞는 워크로드 + 같은 셀렉터 Service 주소."""
    from app.services.service_config.apply import k8s_apis

    try:
        core, apps = k8s_apis(cluster)
    except Exception as exc:  # noqa: BLE001
        raise CommonServiceError(422, f"클러스터에 연결할 수 없습니다: {str(exc)[:200]}") from exc
    types = [s for s in K.SERVICES if s["discover"] and (not service_type or s["key"] == service_type)]
    out: list[dict[str, Any]] = []
    try:
        if namespace:
            lists = [("Deployment", apps.list_namespaced_deployment(namespace, _request_timeout=20)),
                     ("StatefulSet", apps.list_namespaced_stateful_set(namespace, _request_timeout=20))]
            svcs = core.list_namespaced_service(namespace, _request_timeout=20).items
        else:
            lists = [("Deployment", apps.list_deployment_for_all_namespaces(_request_timeout=20)),
                     ("StatefulSet", apps.list_stateful_set_for_all_namespaces(_request_timeout=20))]
            svcs = core.list_service_for_all_namespaces(_request_timeout=20).items
    except Exception as exc:  # noqa: BLE001
        raise CommonServiceError(422, f"워크로드 조회 실패: {str(exc)[:200]}") from exc
    for kind, lst in lists:
        for wl in lst.items or []:
            images = [c.image or "" for c in (wl.spec.template.spec.containers or [])]
            hay = " ".join(images + [wl.metadata.name or ""]).lower()
            st = next((t for t in types if any(p in hay for p in t["discover"])), None)
            if st is None:
                continue
            ns = wl.metadata.namespace
            labels = (wl.spec.template.metadata.labels or {}) if wl.spec.template.metadata else {}
            endpoint = None
            for s in svcs:
                sel = s.spec.selector or {}
                if s.metadata.namespace == ns and sel and all(labels.get(k) == v for k, v in sel.items()) and s.spec.ports:
                    port = s.spec.ports[0].port
                    scheme = "https" if port in (443, 8443) else "http"
                    endpoint = f"{scheme}://{s.metadata.name}.{ns}.svc:{port}"
                    break
            out.append({"service_type": st["key"], "namespace": ns, "workload_kind": kind, "workload_name": wl.metadata.name,
                        "images": images, "replicas": getattr(wl.spec, "replicas", None), "endpoint_url": endpoint})
    return out
