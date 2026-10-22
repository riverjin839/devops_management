"""NS 마이그레이션 실행 엔진 — 소스 수집 → 변환 → 타깃 비교(+서버 dry-run) → server-side apply.

- 클라이언트: `k8s_client_pool.get_api_client(cluster)` 를 `kubernetes.dynamic.DynamicClient` 로 감싼다.
- 적용: server-side apply(fieldManager=pep-ns-migration). 타깃에만 있는 리소스는 지우지 않는다(prune 없음).
- 리소스 단위로 예외를 격리 — 하나가 실패해도 다음을 진행하고 run 은 partial 로 끝난다.
- 로그·items 에 Secret 값은 남기지 않는다(mask_secret).
"""
from __future__ import annotations

from typing import Any, Callable, Optional

from app.services.ns_migration import transform as tf

FIELD_MANAGER = "pep-ns-migration"
Log = Callable[[str], None]


def dynamic_client(cluster: Any):
    from kubernetes.dynamic import DynamicClient

    from app.services.k8s_client_pool import get_api_client

    return DynamicClient(get_api_client(cluster))


def _err(e: Exception) -> str:
    body = getattr(e, "body", None) or getattr(e, "summary", None)
    if body:
        try:
            import json
            msg = json.loads(body).get("message") if isinstance(body, (str, bytes)) else None
            if msg:
                return str(msg)[:400]
        except Exception:  # noqa: BLE001
            pass
    status = getattr(e, "status", None)
    return (f"[{status}] " if status else "") + str(e)[:400]


def _resource(dyn, kind: str):
    spec = tf.KIND_BY_NAME[kind]
    return dyn.resources.get(api_version=spec["api_version"], kind=kind)


def _get(dyn, kind: str, name: str, namespace: Optional[str]) -> Optional[dict]:
    try:
        res = dyn.resources.get(api_version="v1", kind="Namespace") if kind == "Namespace" else _resource(dyn, kind)
        obj = res.get(name=name, namespace=namespace) if res.namespaced else res.get(name=name)
        return obj.to_dict()
    except Exception as e:  # noqa: BLE001
        if getattr(e, "status", None) == 404:
            return None
        raise


def collect(dyn, source_ns: str, kinds: list[str], *, keep_node_ports: bool, log: Log) -> tuple[list[dict], list[dict]]:
    """소스 NS 의 선택 종류를 수집·정리. (옮길 객체, 건너뛴 항목)."""
    objs: list[dict] = []
    skipped: list[dict] = []
    ns_obj = _get(dyn, "Namespace", source_ns, None)
    if ns_obj is None:
        raise RuntimeError(f"소스 클러스터에 네임스페이스 '{source_ns}' 가 없습니다.")
    objs.append(tf.sanitize(ns_obj, "Namespace"))
    log(f"[수집] Namespace/{source_ns}")
    for kind in kinds:
        try:
            res = _resource(dyn, kind)
            items = res.get(namespace=source_ns).to_dict().get("items") or []
        except Exception as e:  # noqa: BLE001
            log(f"[수집] {kind}: 조회 실패 — {_err(e)} (건너뜀)")
            skipped.append({"kind": kind, "name": "*", "reason": f"조회 실패: {_err(e)}"})
            continue
        n_ok = 0
        for item in items:
            name = (item.get("metadata") or {}).get("name")
            item.setdefault("kind", kind)
            reason = tf.skip_reason(item, kind)
            if reason:
                skipped.append({"kind": kind, "name": name, "reason": reason})
                log(f"[수집] {kind}/{name} 제외 — {reason}")
                continue
            objs.append(tf.sanitize(item, kind, keep_node_ports=keep_node_ports))
            n_ok += 1
        log(f"[수집] {kind}: {n_ok}개 (전체 {len(items)})")
    return objs, skipped


def transform_all(objs: list[dict], rules: list[dict], source_ns: str, target_ns: str, log: Log) -> list[tuple[dict, list[str]]]:
    out = []
    for o in objs:
        new, notes = tf.apply_rules(o, rules, source_ns, target_ns)
        if notes:
            log(f"[변환] {new['kind']}/{new['metadata'].get('name')}: " + ", ".join(notes))
        out.append((new, notes))
    return out


def _apply_one(dyn, obj: dict, *, dry_run: bool, force_conflicts: bool) -> None:
    kind = obj["kind"]
    res = dyn.resources.get(api_version="v1", kind="Namespace") if kind == "Namespace" else _resource(dyn, kind)
    kwargs: dict[str, Any] = {"field_manager": FIELD_MANAGER, "force_conflicts": force_conflicts}
    if dry_run:
        kwargs["dry_run"] = "All"
    dyn.server_side_apply(res, body=obj, namespace=obj["metadata"].get("namespace"), **kwargs)


def plan_and_apply(dyn, desired: list[tuple[dict, list[str]]], *, target_ns: str, apply: bool,
                   force_conflicts: bool, log: Log) -> list[dict]:
    """타깃과 비교해 create/update/unchanged 분류 → (plan) 서버 dry-run / (apply) 실제 적용.

    반환 item: {kind, name, action, notes, diff, status, message}. status = ok|failed|skipped.
    """
    items: list[dict] = []
    ns_exists = True
    for obj, notes in desired:
        kind, name = obj["kind"], obj["metadata"].get("name")
        ns = None if kind == "Namespace" else target_ns
        item: dict[str, Any] = {"kind": kind, "name": name, "notes": notes, "diff": "", "status": "ok", "message": ""}
        try:
            current = _get(dyn, kind, name, ns)
        except Exception as e:  # noqa: BLE001
            item.update(action="error", status="failed", message=f"타깃 조회 실패: {_err(e)}")
            log(f"[{kind}/{name}] 타깃 조회 실패 — {item['message']}")
            items.append(item)
            continue
        if kind == "Namespace":
            ns_exists = current is not None
        action, text = tf.diff(current, obj)
        item.update(action=action, diff=text)
        if action == "unchanged":
            log(f"[{kind}/{name}] 변경 없음")
            items.append(item)
            continue
        verb = "생성" if action == "create" else "갱신"
        if not apply and kind != "Namespace" and not ns_exists:
            # 타깃 NS 가 아직 없으면 namespaced 서버 dry-run 은 NotFound — 적용 시 NS 가 먼저 생성된다.
            log(f"[{kind}/{name}] {verb} 예정 (타깃 NS 미존재 — 서버 dry-run 생략)")
            item["message"] = "타깃 NS 생성 후 적용"
            items.append(item)
            continue
        try:
            _apply_one(dyn, obj, dry_run=not apply, force_conflicts=force_conflicts)
            log(f"[{kind}/{name}] {verb} {'완료' if apply else '예정 — 서버 dry-run 통과'}")
        except Exception as e:  # noqa: BLE001
            item.update(status="failed", message=_err(e))
            log(f"[{kind}/{name}] {verb} {'실패' if apply else 'dry-run 실패'} — {item['message']}")
        items.append(item)
    return items


def summarize(items: list[dict], skipped: list[dict]) -> dict[str, int]:
    s = {"create": 0, "update": 0, "unchanged": 0, "failed": 0, "skipped": len(skipped)}
    for it in items:
        if it["status"] == "failed":
            s["failed"] += 1
        elif it.get("action") in s:
            s[it["action"]] += 1
    return s


def build_desired(source_cluster: Any, spec: dict, source_ns: str, target_ns: str, log: Log) -> tuple[list[tuple[dict, list[str]]], list[dict]]:
    """소스 수집 + 변환 — 실행(run)과 번들 다운로드가 공유."""
    kinds = tf.normalize_kinds(spec.get("kinds"), bool(spec.get("include_secrets")))
    opts = spec.get("options") or {}
    dyn = dynamic_client(source_cluster)
    objs, skipped = collect(dyn, source_ns, kinds, keep_node_ports=bool(opts.get("keep_node_ports")), log=log)
    objs.sort(key=lambda o: -1 if o["kind"] == "Namespace" else tf.KIND_ORDER.get(o["kind"], 99))
    return transform_all(objs, spec.get("rules") or [], source_ns, target_ns, log), skipped


def execute_run(db, run, source_cluster: Any, target_cluster: Any) -> None:
    """NsMigrationRun 1회 실행 — 단계/로그를 RunLogger 로 커밋(프론트 폴링 실시간 표시)."""
    from app.services.k8s_efficiency.runs import RunLogger

    rl = RunLogger(db, run)
    rl.start()
    spec = run.spec or {}
    apply = run.mode == "apply"
    rl.log(f"{'적용' if apply else '계획(dry-run)'} 시작 — {source_cluster.name}/{run.source_namespace} → "
           f"{target_cluster.name}/{run.target_namespace}")
    try:
        rl.step("collect", "running")
        desired, skipped = build_desired(source_cluster, spec, run.source_namespace, run.target_namespace, rl.log)
        rl.step("collect", "success", detail=f"{len(desired)}개 수집 · {len(skipped)}개 제외")
    except Exception as e:  # noqa: BLE001
        rl.step("collect", "failed", detail=_err(e))
        rl.log(f"[수집] 실패 — {_err(e)}")
        rl.finish("failed", error=f"소스 수집 실패: {_err(e)}")
        return
    try:
        rl.step("compare", "running")
        tdyn = dynamic_client(target_cluster)
        rl.step("compare", "success")
    except Exception as e:  # noqa: BLE001
        rl.step("compare", "failed", detail=_err(e))
        rl.finish("failed", error=f"타깃 클러스터 연결 실패: {_err(e)}")
        return
    rl.step("apply", "running", label="적용" if apply else "서버 dry-run")
    items = plan_and_apply(tdyn, desired, target_ns=run.target_namespace, apply=apply,
                           force_conflicts=bool((spec.get("options") or {}).get("force_conflicts")), log=rl.log)
    summary = summarize(items, skipped)
    run.items = {"resources": items, "skipped": skipped}
    state = "succeeded" if summary["failed"] == 0 else ("failed" if summary["failed"] == len(items) else "partial")
    rl.step("apply", "success" if state == "succeeded" else "failed",
            detail=f"생성 {summary['create']} · 갱신 {summary['update']} · 동일 {summary['unchanged']} · 실패 {summary['failed']}")
    rl.log(f"완료 — 생성 {summary['create']} · 갱신 {summary['update']} · 동일 {summary['unchanged']} · "
           f"실패 {summary['failed']} · 제외 {summary['skipped']}")
    rl.finish(state, summary=summary, error=None if state == "succeeded" else f"{summary['failed']}개 리소스 실패")
