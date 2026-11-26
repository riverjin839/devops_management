"""알람 등록 요청 → PrometheusRule 자동 적용.

승인된 요청의 임계치(수정 값, 비면 기본 값)를 적용 클러스터마다 ``monitoring.coreos.com/v1 PrometheusRule``
하나로 만든다(알람 항목당 1개, 심각도별 rule). 같은 이름이 있으면 PEP 가 만든 것(``app.kubernetes.io/managed-by=pep``)
만 덮어쓰고, 다른 도구가 만든 것은 건드리지 않고 실패로 남긴다.

어디에·어떤 라벨로 쓸지는 설치마다 다르다(kube-prometheus-stack 의 ruleSelector 라벨, 네임스페이스 …) —
코드 상수가 아니라 AppSetting ``alarm_requests.apply`` 로 화면에서 고친다(UI-First). 클러스터별 재정의 가능.

실제로 나간 K8S API 호출은 ``command_trace.record("k8s-api", …)`` 로 실행 로그 맨 앞에 남는다(관리자에게만).
실행 결과(클러스터별 상태 + 로그 줄)는 요청 행의 ``apply_runs`` 에 최근 N건 보관한다.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any, Callable

import yaml
from sqlalchemy.orm import Session

from app.models.alarm_request import AlarmRequest
from app.models.cluster import Cluster
from app.models.user import User
from app.services import command_trace

_log = logging.getLogger(__name__)

SETTINGS_KEY = "alarm_requests.apply"
GROUP, VERSION, PLURAL, KIND = "monitoring.coreos.com", "v1", "prometheusrules", "PrometheusRule"
MANAGED_BY_LABEL = "app.kubernetes.io/managed-by"
MANAGED_BY_VALUE = "pep"
REQUEST_TIMEOUT = 15
KEEP_RUNS = 10
MAX_LOG_LINES = 500

DEFAULT_SETTINGS: dict[str, Any] = {
    # PrometheusRule 을 만들 네임스페이스
    "namespace": "monitoring",
    # PrometheusRule metadata.labels — Prometheus ruleSelector 가 고르는 라벨(kube-prometheus-stack 기본 release 라벨)
    "rule_labels": {"release": "kube-prometheus-stack"},
    # 리소스 이름 접두사 — <prefix>-<service>-<metric>
    "name_prefix": "pep-alarm",
    # 모든 alert rule 에 붙일 추가 라벨(알림 라우팅용 team 등)
    "alert_labels": {},
    # 모든 클러스터에 성공하면 「진행」 요청을 「완료」로 바꾼다
    "mark_applied_on_success": True,
    # 클러스터별 재정의 [{cluster_id, namespace?, rule_labels?}]
    "cluster_overrides": [],
}

_LABEL_KEY = re.compile(r"^([a-z0-9]([-a-z0-9.]*[a-z0-9])?/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$")
_NS = re.compile(r"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$")


class ApplySettingsError(ValueError):
    pass


def _labels(v: Any, what: str) -> dict[str, str]:
    if v is None:
        return {}
    if not isinstance(v, dict):
        raise ApplySettingsError(f"{what} 형식이 잘못됐습니다.")
    out: dict[str, str] = {}
    for k, val in v.items():
        k = str(k).strip()
        if not k:
            continue
        if not _LABEL_KEY.match(k):
            raise ApplySettingsError(f"{what} 키 '{k}' 가 K8S 라벨 키 형식이 아닙니다.")
        out[k] = "" if val is None else str(val).strip()[:63]
    return out


def _namespace(v: Any, what: str = "네임스페이스") -> str:
    ns = str(v or "").strip()
    if not _NS.match(ns):
        raise ApplySettingsError(f"{what} '{ns}' 가 K8S 네임스페이스 이름 형식이 아닙니다.")
    return ns


def normalize_settings(raw: Any, *, strict: bool = False) -> dict[str, Any]:
    """저장값 정규화. strict=False 면 잘못된 값을 기본값으로 되돌리고(조회 fail-safe), True 면 오류를 낸다(저장)."""
    src = raw if isinstance(raw, dict) else {}
    out = dict(DEFAULT_SETTINGS)

    def take(key: str, fn: Callable[[Any], Any]) -> None:
        if key not in src:
            return
        try:
            out[key] = fn(src[key])
        except ApplySettingsError:
            if strict:
                raise

    take("namespace", _namespace)
    take("rule_labels", lambda v: _labels(v, "PrometheusRule 라벨"))
    take("alert_labels", lambda v: _labels(v, "알람 라벨"))
    take("name_prefix", lambda v: _prefix(v))
    take("mark_applied_on_success", bool)

    def overrides(v: Any) -> list[dict[str, Any]]:
        if not isinstance(v, list):
            raise ApplySettingsError("클러스터별 재정의 형식이 잘못됐습니다.")
        res = []
        seen = set()
        for o in v:
            if not isinstance(o, dict) or not o.get("cluster_id"):
                continue
            cid = str(o["cluster_id"])
            if cid in seen:
                raise ApplySettingsError("같은 클러스터의 재정의가 두 번 있습니다.")
            seen.add(cid)
            item: dict[str, Any] = {"cluster_id": cid}
            if str(o.get("namespace") or "").strip():
                item["namespace"] = _namespace(o["namespace"], "재정의 네임스페이스")
            if o.get("rule_labels"):
                item["rule_labels"] = _labels(o["rule_labels"], "재정의 PrometheusRule 라벨")
            res.append(item)
        return res

    take("cluster_overrides", overrides)
    return out


def _prefix(v: Any) -> str:
    p = slug(str(v or ""))
    if not p or len(p) > 40:
        raise ApplySettingsError("이름 접두사는 영문 소문자·숫자·하이픈 1~40자여야 합니다.")
    return p


def get_settings(db: Session) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    try:
        row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    except Exception:  # noqa: BLE001 — 조회 화면이 죽지 않게
        db.rollback()
        return normalize_settings(None)
    return normalize_settings(row.value if row else None)


def save_settings(db: Session, value: dict[str, Any]) -> dict[str, Any]:
    from app.models.app_setting import AppSetting

    merged = normalize_settings({**get_settings(db), **value}, strict=True)
    row = db.query(AppSetting).filter(AppSetting.key == SETTINGS_KEY).first()
    if row:
        row.value = merged
    else:
        db.add(AppSetting(key=SETTINGS_KEY, value=merged))
    db.commit()
    return merged


def target_for(settings: dict[str, Any], cluster_id: str) -> tuple[str, dict[str, str]]:
    """클러스터의 (네임스페이스, PrometheusRule 라벨) — 재정의가 있으면 그 값."""
    ns, labels = settings["namespace"], dict(settings["rule_labels"])
    for o in settings.get("cluster_overrides") or []:
        if o.get("cluster_id") == cluster_id:
            ns = o.get("namespace") or ns
            if o.get("rule_labels"):
                labels = dict(o["rule_labels"])
    return ns, labels


def _pairs(d: dict[str, str]) -> list[dict[str, str]]:
    return [{"key": k, "value": v} for k, v in (d or {}).items()]


def _dict(pairs: Any) -> dict[str, str]:
    if isinstance(pairs, dict):
        return pairs
    return {str(p.get("key", "")): str(p.get("value", "")) for p in pairs or [] if isinstance(p, dict)}


def to_api(settings: dict[str, Any]) -> dict[str, Any]:
    """저장 형식(dict 라벨) → API 형식(라벨 쌍 목록)."""
    return {
        **settings,
        "rule_labels": _pairs(settings["rule_labels"]),
        "alert_labels": _pairs(settings["alert_labels"]),
        "cluster_overrides": [{**o, "rule_labels": _pairs(o.get("rule_labels") or {})}
                              for o in settings.get("cluster_overrides") or []],
    }


def from_api(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        **payload,
        "rule_labels": _dict(payload.get("rule_labels")),
        "alert_labels": _dict(payload.get("alert_labels")),
        "cluster_overrides": [{**o, "rule_labels": _dict(o.get("rule_labels"))}
                              for o in payload.get("cluster_overrides") or []],
    }


# ── 매니페스트 ────────────────────────────────────────────────────────────────
def slug(s: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9-]", "-", s.lower())).strip("-")


def rule_name(settings: dict[str, Any], req: AlarmRequest) -> str:
    return f"{settings['name_prefix']}-{slug(req.service)}-{slug(req.metric_name)}"[:253].rstrip("-")


def effective_rules(req: AlarmRequest) -> list[dict[str, str]]:
    """심각도별 실제 적용 값 — 수정 값이 비면 기본 값. expr 이 없는 행은 뺀다."""
    out = []
    for t in req.thresholds or []:
        expr = (t.get("new_expr") or t.get("base_expr") or "").strip()
        if not expr:
            continue
        out.append({"severity": t.get("severity") or "warning", "expr": expr,
                    "for": (t.get("new_for") or t.get("base_for") or "").strip()})
    return out


def build_manifest(settings: dict[str, Any], req: AlarmRequest, cluster_id: str, *,
                   applied_by: str | None = None, applied_at: str | None = None) -> dict[str, Any]:
    from app.services.alarm_requests import code_of

    ns, labels = target_for(settings, cluster_id)
    rules = []
    for r in effective_rules(req):
        rule: dict[str, Any] = {
            "alert": req.metric_name,
            "expr": r["expr"],
            "labels": {**settings.get("alert_labels", {}), "severity": r["severity"], "service": req.service},
            "annotations": {"summary": (req.meaning or req.metric_name).strip()[:500],
                            "pep_request": code_of(req.id)},
        }
        if r["for"]:
            rule["for"] = r["for"]
        rules.append(rule)
    annotations = {"pep.io/alarm-request": code_of(req.id)}
    if applied_by:
        annotations["pep.io/applied-by"] = applied_by
    if applied_at:
        annotations["pep.io/applied-at"] = applied_at
    return {
        "apiVersion": f"{GROUP}/{VERSION}",
        "kind": KIND,
        "metadata": {
            "name": rule_name(settings, req),
            "namespace": ns,
            "labels": {**labels, MANAGED_BY_LABEL: MANAGED_BY_VALUE, "pep.io/alarm-service": slug(req.service)[:63]},
            "annotations": annotations,
        },
        "spec": {"groups": [{"name": f"pep.{slug(req.service)}.{slug(req.metric_name)}", "rules": rules}]},
    }


def to_yaml(manifest: dict[str, Any]) -> str:
    return yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False)


def preview(db: Session, req: AlarmRequest) -> list[dict[str, Any]]:
    settings = get_settings(db)
    out = []
    for c in req.clusters or []:
        m = build_manifest(settings, req, str(c.get("id")))
        out.append({"cluster_id": c.get("id"), "cluster_name": c.get("name"),
                    "namespace": m["metadata"]["namespace"], "name": m["metadata"]["name"], "yaml": to_yaml(m)})
    return out


# ── 적용 ─────────────────────────────────────────────────────────────────────
def _api_path(ns: str, name: str | None = None) -> str:
    base = f"/apis/{GROUP}/{VERSION}/namespaces/{ns}/{PLURAL}"
    return f"{base}/{name}" if name else base


def _custom_api(cluster: Cluster):
    from kubernetes import client as k8s_client

    from app.services.k8s_client_pool import get_api_client

    return k8s_client.CustomObjectsApi(get_api_client(cluster))


def _status_of(exc: Exception) -> int | None:
    return getattr(exc, "status", None)


def _reason(exc: Exception) -> str:
    body = getattr(exc, "body", None)
    if body:
        try:
            import json

            msg = json.loads(body).get("message")
            if msg:
                return str(msg)[:300]
        except Exception:  # noqa: BLE001
            pass
    return (str(exc) or exc.__class__.__name__)[:300]


def apply_to_cluster(cluster: Cluster, manifest: dict[str, Any], log: Callable[[str, str], None],
                     custom_api_factory: Callable[[Cluster], Any] | None = None) -> dict[str, Any]:
    """클러스터 1개에 upsert. 예외를 올리지 않고 결과 dict 를 돌려준다."""
    ns = manifest["metadata"]["namespace"]
    name = manifest["metadata"]["name"]
    target = f"cluster {cluster.name}"
    res = {"cluster_id": str(cluster.id), "cluster_name": cluster.name, "namespace": ns, "name": name}
    try:
        api = (custom_api_factory or _custom_api)(cluster)
    except Exception as e:  # noqa: BLE001 — kubeconfig 해석 실패 등
        log("error", f"[{cluster.name}] K8S 접속 준비 실패 — {_reason(e)}")
        return {**res, "status": "failed", "message": f"K8S 접속 준비 실패: {_reason(e)}"}

    command_trace.record("k8s-api", target, f"GET {_api_path(ns, name)}")
    existing = None
    try:
        existing = api.get_namespaced_custom_object(GROUP, VERSION, ns, PLURAL, name, _request_timeout=REQUEST_TIMEOUT)
    except Exception as e:  # noqa: BLE001
        if _status_of(e) != 404:
            log("error", f"[{cluster.name}] 기존 PrometheusRule 조회 실패 — {_reason(e)}")
            return {**res, "status": "failed", "message": f"조회 실패: {_reason(e)}"}

    try:
        if existing is None:
            log("info", f"[{cluster.name}] {ns}/{name} 없음 — 새로 만듭니다")
            command_trace.record("k8s-api", target, f"POST {_api_path(ns)} (kind={KIND}, name={name})")
            api.create_namespaced_custom_object(GROUP, VERSION, ns, PLURAL, manifest, _request_timeout=REQUEST_TIMEOUT)
            log("info", f"[{cluster.name}] {ns}/{name} 생성 완료")
            return {**res, "status": "created", "message": "생성"}
        owner = ((existing.get("metadata") or {}).get("labels") or {}).get(MANAGED_BY_LABEL)
        if owner != MANAGED_BY_VALUE:
            msg = (f"같은 이름의 PrometheusRule 이 이미 있고 PEP 가 만든 것이 아닙니다"
                   f"({MANAGED_BY_LABEL}={owner or '없음'}) — 덮어쓰지 않았습니다")
            log("error", f"[{cluster.name}] {msg}")
            return {**res, "status": "failed", "message": msg}
        body = {**manifest, "metadata": {**manifest["metadata"],
                                         "resourceVersion": (existing.get("metadata") or {}).get("resourceVersion")}}
        log("info", f"[{cluster.name}] {ns}/{name} 있음(PEP 관리) — 새 임계치로 교체합니다")
        command_trace.record("k8s-api", target, f"PUT {_api_path(ns, name)}")
        api.replace_namespaced_custom_object(GROUP, VERSION, ns, PLURAL, name, body, _request_timeout=REQUEST_TIMEOUT)
        log("info", f"[{cluster.name}] {ns}/{name} 갱신 완료")
        return {**res, "status": "updated", "message": "갱신"}
    except Exception as e:  # noqa: BLE001
        reason = _reason(e)
        if _status_of(e) == 404:
            reason = f"{reason} — 네임스페이스 '{ns}' 또는 PrometheusRule CRD({GROUP}) 가 없는지 확인하세요"
        log("error", f"[{cluster.name}] 적용 실패 — {reason}")
        return {**res, "status": "failed", "message": reason}


def run_apply(db: Session, req: AlarmRequest, actor: User, emit: Callable[[dict], None],
              custom_api_factory: Callable[[Cluster], Any] | None = None) -> dict[str, Any]:
    """모든 적용 클러스터에 순서대로 적용하고 실행 기록을 요청 행에 남긴다(커밋 포함)."""
    from app.services import alarm_requests as svc
    from app.services.sse import log_evt, now_iso, step_evt

    started = datetime.now(timezone.utc)
    lines: list[list[str]] = []

    def log(level: str, message: str) -> None:
        if len(lines) < MAX_LOG_LINES:
            lines.append([now_iso(), level, message])
        log_evt(emit, level, message)

    def cmd_sink(message: str) -> None:
        if len(lines) < MAX_LOG_LINES:
            lines.append([now_iso(), command_trace.CMD_LEVEL, message])
        # 비관리자에게는 stream_async_job 의 emit 이 cmd 이벤트를 걸러낸다.
        emit({"type": "log", "level": command_trace.CMD_LEVEL, "ts": now_iso(), "message": message})

    settings = get_settings(db)
    applied_at = started.isoformat(timespec="seconds")
    rules = effective_rules(req)
    log("info", f"{svc.code_of(req.id)} {req.metric_name} — 심각도 {len(rules)}개를 클러스터 {len(req.clusters or [])}개에 적용합니다")
    results: list[dict[str, Any]] = []
    with command_trace.bind(cmd_sink):
        for c in req.clusters or []:
            cid = str(c.get("id"))
            step = f"cluster-{cid}"
            label = c.get("name") or cid
            step_evt(emit, step, label, "running")
            cluster = None
            try:
                cluster = db.query(Cluster).filter(Cluster.id == cid).first()
            except Exception:  # noqa: BLE001
                db.rollback()
            if cluster is None:
                log("error", f"[{label}] 등록된 클러스터가 아닙니다(삭제됨?) — 건너뜁니다")
                results.append({"cluster_id": cid, "cluster_name": label, "status": "failed", "message": "클러스터 없음"})
                step_evt(emit, step, label, "failed")
                continue
            manifest = build_manifest(settings, req, cid, applied_by=svc.display_name(actor), applied_at=applied_at)
            r = apply_to_cluster(cluster, manifest, log, custom_api_factory)
            results.append(r)
            step_evt(emit, step, label, "failed" if r["status"] == "failed" else "done")

    ok = bool(results) and all(r["status"] != "failed" for r in results)
    failed = [r for r in results if r["status"] == "failed"]
    summary = (f"{len(results)}개 클러스터 적용 성공" if ok
               else f"{len(results) - len(failed)}/{len(results)}개 성공, 실패: {', '.join(r['cluster_name'] for r in failed)}")
    log("info" if ok else "warn", summary)

    run = {"at": applied_at, "by": svc.display_name(actor), "ok": ok, "results": results, "log": lines}
    req.apply_runs = [run, *(req.apply_runs or [])][:KEEP_RUNS]
    svc.add_history(req, actor, "rule_applied" if ok else "rule_apply_failed", summary)
    if ok and req.status == "done":
        # 완료 뒤 다시 적용(임계치 재반영) — 상태는 그대로, 카탈로그 기본값만 지금 값으로 맞춘다.
        svc.promote_to_catalog(db, req, actor)
    elif ok and settings.get("mark_applied_on_success") and req.status == "in_progress":
        svc.set_status(db, req, actor, "done", "PrometheusRule 자동 적용")
        log("info", "요청을 「완료」로 바꾸고 수정 임계치를 알람 카탈로그 기본값으로 저장했습니다")
    db.commit()
    return {"ok": ok, "summary": summary, "results": results, "status": req.status}
