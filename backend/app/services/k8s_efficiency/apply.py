"""적용/롤백 실행 — K8sEfficiencyRun.targets 를 순서대로 패치하고 단계/로그를 남긴다.

target 종류:
  {"type":"workload","namespace","kind","name","container","requests":{"cpu":"250m","memory":"256Mi"},
   "limits":{...}?, "recommendation_id"?}
  {"type":"resourcequota","namespace","name","hard":{"requests.cpu":"..","requests.memory":".."}}
  {"type":"custom_resource","namespace","group","version","plural","name","jsonpath","value"}

- before(현재 값) 를 먼저 기록해 롤백 run 을 만들 수 있게 한다.
- dry_run 이면 apiserver 에 dry_run="All" 로 보내 검증만 한다(변경 없음).
- 한 대상이 실패해도 계속 진행하고 run_state=partial.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

from kubernetes import client as k8s_client
from kubernetes.client.rest import ApiException
from sqlalchemy.orm import Session

from app.models.k8s_efficiency import K8sEfficiencyRun, K8sRightsizeRecommendation

from .quota import fmt_cpu_q, fmt_mem_q
from .runs import RunLogger

logger = logging.getLogger(__name__)

_READ = {
    "Deployment": lambda a, ns, n: a.read_namespaced_deployment(n, ns),
    "StatefulSet": lambda a, ns, n: a.read_namespaced_stateful_set(n, ns),
    "DaemonSet": lambda a, ns, n: a.read_namespaced_daemon_set(n, ns),
}
_PATCH = {
    "Deployment": lambda a, ns, n, body, **kw: a.patch_namespaced_deployment(n, ns, body, **kw),
    "StatefulSet": lambda a, ns, n, body, **kw: a.patch_namespaced_stateful_set(n, ns, body, **kw),
    "DaemonSet": lambda a, ns, n, body, **kw: a.patch_namespaced_daemon_set(n, ns, body, **kw),
}


def _api_error(e: Exception) -> str:
    if isinstance(e, ApiException):
        try:
            import json
            body = json.loads(e.body) if e.body else {}
            msg = body.get("message") or e.reason or ""
        except Exception:  # noqa: BLE001
            msg = e.reason or ""
        if e.status == 403:
            return f"kubeconfig 권한 부족(RBAC) — {msg[:160]}"
        return f"HTTP {e.status} — {msg[:200]}"
    return str(e)[:200]


def workload_patch_body(container: str, requests: dict[str, str], limits: Optional[dict[str, str]]) -> dict:
    res: dict[str, Any] = {"requests": requests}
    if limits:
        res["limits"] = limits
    return {"spec": {"template": {"spec": {"containers": [{"name": container, "resources": res}]}}}}


def jsonpath_body(path: str, value: Any) -> dict:
    """'spec.starRocksCnSpec.replicas' → {"spec":{"starRocksCnSpec":{"replicas": value}}} (merge-patch)."""
    parts = [p for p in path.replace("/", ".").strip(".").split(".") if p]
    body: Any = value
    for p in reversed(parts):
        body = {p: body}
    return body


def jsonpath_get(obj: Any, path: str) -> Any:
    cur = obj
    for p in [p for p in path.replace("/", ".").strip(".").split(".") if p]:
        if isinstance(cur, dict):
            cur = cur.get(p)
        elif isinstance(cur, list) and p.isdigit():
            cur = cur[int(p)] if int(p) < len(cur) else None
        else:
            return None
    return cur


def _container_resources(obj, container: str) -> Optional[dict]:
    for c in (obj.spec.template.spec.containers or []):
        if c.name == container:
            r = c.resources
            return {"requests": dict((r.requests or {}) if r else {}), "limits": dict((r.limits or {}) if r else {})}
    return None


def targets_from_recommendations(recs: list[K8sRightsizeRecommendation]) -> list[dict]:
    """같은 컨테이너의 cpu/memory 추천을 target 1개로 묶는다."""
    grouped: dict[tuple[str, str, str, str], dict] = {}
    for r in recs:
        t = grouped.setdefault((r.namespace, r.kind, r.name, r.container), {
            "type": "workload", "namespace": r.namespace, "kind": r.kind, "name": r.name,
            "container": r.container, "requests": {}, "limits": {}, "recommendation_ids": [],
        })
        if r.resource == "cpu":
            t["requests"]["cpu"] = fmt_cpu_q(r.target_req)
            if r.target_lim:
                t["limits"]["cpu"] = fmt_cpu_q(r.target_lim)
        else:
            t["requests"]["memory"] = fmt_mem_q(r.target_req)
            if r.target_lim:
                t["limits"]["memory"] = fmt_mem_q(r.target_lim)
        t["recommendation_ids"].append(str(r.id))
    out = []
    for t in grouped.values():
        if not t["limits"]:
            t.pop("limits")
        out.append(t)
    return out


def rollback_targets(run: K8sEfficiencyRun) -> list[dict]:
    """before 스냅샷 → 원복 target 목록."""
    out: list[dict] = []
    for i, t in enumerate(run.targets or []):
        b = (run.before or {}).get(str(i)) if isinstance(run.before, dict) else None
        if not b:
            continue
        if t.get("type") == "workload" and isinstance(b, dict):
            req = {k: v for k, v in (b.get("requests") or {}).items() if k in ("cpu", "memory")}
            lim = {k: v for k, v in (b.get("limits") or {}).items() if k in ("cpu", "memory")}
            if not req and not lim:
                continue
            nt = {"type": "workload", "namespace": t["namespace"], "kind": t["kind"], "name": t["name"],
                  "container": t["container"], "requests": req or {}}
            if lim:
                nt["limits"] = lim
            out.append(nt)
        elif t.get("type") == "resourcequota" and isinstance(b, dict):
            out.append({"type": "resourcequota", "namespace": t["namespace"], "name": t["name"], "hard": b})
        elif t.get("type") == "custom_resource":
            out.append({**t, "value": b})
    return out


def execute_run(db: Session, run: K8sEfficiencyRun, cluster) -> K8sEfficiencyRun:
    from app.routers.k8s_resources import _api_client

    rl = RunLogger(db, run)
    rl.start()
    rl.log(f"실행 시작 — type={run.run_type} trigger={run.trigger} dry_run={run.dry_run} targets={len(run.targets or [])}")
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    ok = fail = 0
    dry = {"dry_run": "All"} if run.dry_run else {}
    client = None
    try:
        client = _api_client(cluster)
        apps = k8s_client.AppsV1Api(client)
        core = k8s_client.CoreV1Api(client)
        co = k8s_client.CustomObjectsApi(client)
        for i, t in enumerate(run.targets or []):
            sid = f"t{i}"
            ttype = t.get("type")
            label = (f"{t.get('kind')}/{t.get('namespace')}/{t.get('name')}:{t.get('container')}" if ttype == "workload"
                     else f"{ttype}/{t.get('namespace')}/{t.get('name')}")
            rl.step(sid, "running", None, label=label)
            try:
                if ttype == "workload":
                    kind = t["kind"]
                    if kind not in _READ:
                        raise ValueError(f"지원하지 않는 kind: {kind}")
                    obj = _READ[kind](apps, t["namespace"], t["name"])
                    cur = _container_resources(obj, t["container"])
                    if cur is None:
                        raise ValueError(f"컨테이너 {t['container']} 없음")
                    before[str(i)] = cur
                    body = workload_patch_body(t["container"], t.get("requests") or {}, t.get("limits"))
                    rl.log(f"[{label}] before requests={cur['requests']} limits={cur['limits']} → "
                           f"patch requests={t.get('requests')} limits={t.get('limits') or '-'}{' (dry-run)' if run.dry_run else ''}")
                    _PATCH[kind](apps, t["namespace"], t["name"], body, **dry)
                    after[str(i)] = {"requests": t.get("requests") or {}, "limits": t.get("limits") or cur["limits"]}
                elif ttype == "resourcequota":
                    q = core.read_namespaced_resource_quota(t["name"], t["namespace"])
                    hard_cur = dict((q.spec.hard or {}) if q.spec else {})
                    before[str(i)] = {k: hard_cur.get(k) for k in (t.get("hard") or {})}
                    rl.log(f"[{label}] hard {before[str(i)]} → {t.get('hard')}{' (dry-run)' if run.dry_run else ''}")
                    core.patch_namespaced_resource_quota(t["name"], t["namespace"], {"spec": {"hard": t.get("hard") or {}}}, **dry)
                    after[str(i)] = t.get("hard") or {}
                elif ttype == "custom_resource":
                    cur_obj = co.get_namespaced_custom_object(t["group"], t["version"], t["namespace"], t["plural"], t["name"])
                    cur_val = jsonpath_get(cur_obj, t["jsonpath"])
                    before[str(i)] = cur_val
                    rl.log(f"[{label}] {t['jsonpath']}: {cur_val} → {t.get('value')}{' (dry-run)' if run.dry_run else ''}")
                    co.patch_namespaced_custom_object(t["group"], t["version"], t["namespace"], t["plural"], t["name"],
                                                      jsonpath_body(t["jsonpath"], t.get("value")), **dry)
                    after[str(i)] = t.get("value")
                else:
                    raise ValueError(f"알 수 없는 target type: {ttype}")
                ok += 1
                rl.step(sid, "success", "적용 검증만(dry-run)" if run.dry_run else "적용 완료")
            except Exception as e:  # noqa: BLE001
                fail += 1
                msg = _api_error(e)
                rl.log(f"[{label}] 실패: {msg}")
                rl.step(sid, "failed", msg)
    except Exception as e:  # noqa: BLE001
        rl.log(f"클라이언트 초기화 실패: {_api_error(e)}")
        rl.finish("failed", error=_api_error(e), before=before, after=after,
                  summary={"ok": ok, "failed": fail})
        return run
    finally:
        try:
            if client is not None:
                client.close()
        except Exception:  # noqa: BLE001
            pass

    state = "succeeded" if fail == 0 else ("partial" if ok > 0 else "failed")
    # 실제 적용(비 dry-run)이면 추천 상태를 applied 로.
    if not run.dry_run and ok > 0:
        rec_ids: list[str] = []
        for i, t in enumerate(run.targets or []):
            if str(i) in after:
                rec_ids.extend(t.get("recommendation_ids") or [])
        if rec_ids:
            (db.query(K8sRightsizeRecommendation)
             .filter(K8sRightsizeRecommendation.id.in_(rec_ids))
             .update({"status": "applied", "applied_run_id": run.id, "updated_at": datetime.utcnow()},
                     synchronize_session=False))
            db.commit()
    rl.log(f"실행 종료 — {state} (성공 {ok} / 실패 {fail})")
    rl.finish(state, before=before, after=after, summary={"ok": ok, "failed": fail, "dry_run": run.dry_run})
    return run
