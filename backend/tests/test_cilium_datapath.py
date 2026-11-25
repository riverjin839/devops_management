"""Cilium 데이터패스(Rust 에이전트 수신) — 판정·카탈로그·설정·매니페스트·보고/알람·수동 수집 실행(실제 DB) 테스트."""
import os
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test"
)
os.environ["REDIS_URL"] = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

from app.services.cilium_datapath import catalog  # noqa: E402
from app.services.cilium_datapath import settings as S  # noqa: E402
from app.services.cilium_datapath.manifest import TOKEN_PLACEHOLDER, render_manifest  # noqa: E402
from app.services.cilium_datapath.service import (  # noqa: E402
    clean_maps,
    enrich_map,
    map_level,
    program_diff,
)

CFG = S.normalize(None)


def amap(name, entries, mx, *, group=None, partial=False, members=1, map_type="LRU_HASH"):
    return {"name": name, "group": group or name, "map_type": map_type, "max_entries": mx, "entries": entries,
            "partial": partial, "members": members, "elapsed_ms": 3, "pinned": True}


# ── 판정·카탈로그·설정 ────────────────────────────────────────────────────────

@pytest.mark.parametrize("entries,mx,pct,level", [
    (10, 100, 10.0, "ok"),
    (70, 100, 70.0, "warning"),
    (89, 100, 89.0, "warning"),
    (90, 100, 90.0, "critical"),
    (None, 100, None, "unknown"),
    (5, 0, None, "unknown"),
])
def test_map_level(entries, mx, pct, level):
    assert map_level(amap("cilium_ct4_global", entries, mx), CFG) == (pct, level)


def test_enrich_adds_label_and_recommendation_only_over_threshold():
    hot = enrich_map(amap("cilium_ct4_global", 487_588, 524_288), CFG)
    assert hot["label"] == "CT TCP4" and hot["level"] == "critical" and hot["config_key"] == "bpf-ct-global-tcp-max"
    assert "524,288 → 1,048,576" in hot["recommendation"] and "dynamic-size-ratio" in hot["recommendation"]
    cool = enrich_map(amap("cilium_snat_v4_external", 10, 524_288), CFG)
    assert cool["level"] == "ok" and cool["recommendation"] is None
    ip = enrich_map(amap("cilium_ipcache_v2", 500_000, 512_000, map_type="LPM_TRIE"), CFG)
    assert ip["level"] == "critical" and ip["recommendation"] is None and "고정" in ip["note"]
    unknown = enrich_map(amap("cilium_something_new", 1, 10), CFG)
    assert unknown["label"] == "something_new" and unknown["order"] == 1000


def test_catalog_versions_share_label():
    assert catalog.describe("cilium_lb4_backends_v3")["label"] == catalog.describe("cilium_lb4_backends_v2")["label"]
    assert catalog.describe("cilium_policy_v2")["config_key"] == "bpf-policy-map-max"


def test_settings_normalize_is_fail_safe():
    bad = S.normalize({"interval_sec": "x", "warn_pct": 95, "crit_pct": 90, "pin_dirs": ["relative", "/a/../b", "/sys/fs/bpf/x"],
                       "map_budget_ms": 9000, "total_budget_ms": 1000, "sys_admin": 1})
    assert bad["interval_sec"] == 300
    assert (bad["warn_pct"], bad["crit_pct"]) == (70, 90)  # 주의 ≥ 위험이면 기본값
    assert bad["pin_dirs"] == ["/sys/fs/bpf/x"]  # 상대 경로·.. 제거
    assert bad["map_budget_ms"] == 1000  # 맵당 예산은 전체 예산을 넘지 않는다
    assert bad["sys_admin"] is True
    cfg = S.agent_config(bad)
    assert cfg["scan_all_ids"] is True and cfg["program_inventory"] is True
    assert set(cfg) == {"interval_sec", "map_budget_ms", "total_budget_ms", "pin_dirs", "map_prefixes",
                        "scan_all_ids", "program_inventory", "program_prefixes"}


def test_agent_config_keys_match_rust_collect_cfg():
    """보고 응답 config 키 = Rust 에이전트 CollectCfg 필드(어긋나면 에이전트가 조용히 기본값을 쓴다)."""
    src = Path(__file__).resolve().parents[2] / "agents/pep-bpf-agent/src/collect.rs"
    if not src.exists():
        pytest.skip("agents 디렉터리가 없는 실행 환경")
    text = src.read_text()
    body = text.split("pub struct CollectCfg {", 1)[1].split("}", 1)[0]
    fields = {ln.strip().split(":")[0].replace("pub ", "") for ln in body.splitlines() if ln.strip().startswith("pub ")}
    assert fields == set(S.agent_config(CFG))


def test_clean_maps_truncates_untrusted_input():
    raw = [{"name": "x" * 500, "max_entries": "12", "entries": -5}, {"nope": 1}, "str",
           *[{"name": f"cilium_m{i}", "max_entries": 1, "entries": 1} for i in range(600)]]
    out = clean_maps(raw)
    assert len(out) == 400
    assert len(out[0]["name"]) == 128 and out[0]["max_entries"] == 12 and out[0]["entries"] is None


def test_program_diff():
    base = [{"name": "cil_from_netdev", "tags": ["aa"]}, {"name": "cil_to_host", "tags": ["bb"]},
            {"name": "cil_gone", "tags": ["cc"]}]
    cur = [{"name": "cil_from_netdev", "tags": ["aa"]}, {"name": "cil_to_host", "tags": ["bx"]},
           {"name": "cil_from_container", "tags": ["dd"]}]
    d = {p["name"]: p["diff"] for p in program_diff(cur, base)}
    assert d == {"cil_from_netdev": "same", "cil_to_host": "changed", "cil_from_container": "new", "cil_gone": "removed"}
    assert all(p["diff"] == "same" for p in program_diff(cur, None))


def test_manifest_is_least_privilege():
    import yaml

    docs = [d for d in yaml.safe_load_all(render_manifest(
        cluster_id="c1", cluster_name="prod", api_base_url="https://pep/api/v1", image="img:1",
        namespace="k8s-monitor-agent", tls_verify=True)) if d]
    assert [d["kind"] for d in docs] == ["Namespace", "Secret", "DaemonSet"]
    assert docs[1]["stringData"]["CILIUM_BPF_AGENT_TOKEN"] == TOKEN_PLACEHOLDER
    spec = docs[2]["spec"]["template"]["spec"]
    assert spec["automountServiceAccountToken"] is False
    assert "hostNetwork" not in spec and "hostPID" not in spec
    c = spec["containers"][0]
    sc = c["securityContext"]
    assert sc["capabilities"] == {"drop": ["ALL"], "add": ["BPF"]}
    assert sc["readOnlyRootFilesystem"] is True and sc["allowPrivilegeEscalation"] is False
    assert "privileged" not in sc
    assert c["volumeMounts"] == [{"name": "bpffs", "mountPath": "/sys/fs/bpf", "mountPropagation": "HostToContainer",
                                  "readOnly": True}]
    with_admin = [d for d in yaml.safe_load_all(render_manifest(
        cluster_id="c1", cluster_name="prod", api_base_url="https://pep/api/v1", image="img:1",
        namespace="ns", tls_verify=False, sys_admin=True)) if d]
    assert with_admin[2]["spec"]["template"]["spec"]["containers"][0]["securityContext"]["capabilities"]["add"] == ["BPF", "SYS_ADMIN"]
    assert with_admin[1]["stringData"]["PEP_TLS_VERIFY"] == "false"


def test_repo_deploy_bundle_matches_renderer():
    """deploy/k8s/cilium-bpf-agent/daemonset.yaml 은 화면 매니페스트 렌더러와 같은 DaemonSet 이어야 한다."""
    import yaml

    repo = Path(__file__).resolve().parents[2] / "deploy/k8s/cilium-bpf-agent/daemonset.yaml"
    if not repo.exists():
        pytest.skip("deploy 디렉터리가 없는 실행 환경")
    on_disk = yaml.safe_load(repo.read_text())
    rendered = [d for d in yaml.safe_load_all(render_manifest(
        cluster_id="x", cluster_name="x", api_base_url="https://x/api/v1",
        image=on_disk["spec"]["template"]["spec"]["containers"][0]["image"],
        namespace=on_disk["metadata"]["namespace"], tls_verify=True)) if d][2]
    assert on_disk == rendered


# ── 보고·알람·실행(실제 DB) ───────────────────────────────────────────────────

@pytest.fixture
def db():
    from app.database import Base, SessionLocal, engine
    from app.main import _ensure_pgvector_extension

    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def world(db):
    from app.models.alert_event import AlertEvent
    from app.models.app_setting import AppSetting
    from app.models.cilium_datapath import CiliumBpfAgent, CiliumDatapathRun
    from app.models.cluster import Cluster
    from app.models.user_notification import UserNotification

    prev = db.query(AppSetting).filter(AppSetting.key == S.SETTINGS_KEY).first()
    prev_value = dict(prev.value) if prev and isinstance(prev.value, dict) else None
    if prev:
        db.delete(prev)
        db.commit()
    tag = uuid.uuid4().hex[:8]
    cluster = Cluster(name=f"cdp-{tag}", api_endpoint="https://cdp:6443")
    db.add(cluster)
    db.commit()
    yield SimpleNamespace(cluster=cluster, tag=tag)
    db.rollback()
    event_ids = [e.id for e in db.query(AlertEvent.id).filter(AlertEvent.cluster_id == cluster.id).all()]
    if event_ids:
        db.query(UserNotification).filter(
            UserNotification.link.in_([f"/alerts?id={i}" for i in event_ids])).delete(synchronize_session=False)
    db.query(AlertEvent).filter(AlertEvent.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(CiliumDatapathRun).filter(CiliumDatapathRun.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(CiliumBpfAgent).filter(CiliumBpfAgent.cluster_id == cluster.id).delete(synchronize_session=False)
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)
    db.query(AppSetting).filter(AppSetting.key == S.SETTINGS_KEY).delete(synchronize_session=False)
    if prev_value is not None:
        db.add(AppSetting(key=S.SETTINGS_KEY, value=prev_value))
    db.commit()


def _firing(db, cluster_id):
    from app.models.alert_event import AlertEvent

    return db.query(AlertEvent).filter(AlertEvent.cluster_id == cluster_id, AlertEvent.alertname == "CiliumBpfMapPressure",
                                       AlertEvent.status == "firing").all()


def _report(node, ct_entries, *, run_id=None, programs=None):
    return {
        "node": node, "host_ip": "10.0.0.5", "agent_version": "0.1.0", "collected_at": "2026-11-24T00:00:00Z",
        "run_id": run_id, "features": {"kernel": "6.1.0", "cap_bpf": True, "kernel_drop_reason": True},
        "maps": [amap("cilium_ct4_global", ct_entries, 1000),
                 amap("cilium_policy_v2_02001", 300, 16384, group="cilium_policy_v2", members=3, map_type="HASH")],
        "maps_skipped": 4, "programs": programs or [], "errors": [], "collect_ms": 12,
    }


def test_report_alerts_open_escalate_and_resolve(db, world):
    from app.services.cilium_datapath import service as svc

    c = world.cluster
    out = svc.handle_report(db, c, _report("w1", 500))
    assert out["alerts_opened"] == 0 and out["config"]["interval_sec"] == 300

    out = svc.handle_report(db, c, _report("w1", 750))  # 75% → 주의
    assert out["alerts_opened"] == 1
    ev = _firing(db, c.id)
    assert len(ev) == 1 and ev[0].severity == "warning" and ev[0].resource == "w1" and "CT TCP4" in ev[0].summary

    out = svc.handle_report(db, c, _report("w1", 760))  # 같은 등급 — 다시 열지 않는다
    assert out["alerts_opened"] == 0 and len(_firing(db, c.id)) == 1

    svc.handle_report(db, c, _report("w1", 950))  # 위험으로 승격 — 같은 알람의 등급이 바뀐다
    ev = _firing(db, c.id)
    assert len(ev) == 1 and ev[0].severity == "critical"

    out = svc.handle_report(db, c, _report("w1", 100))  # 내려가면 닫힌다
    assert out["alerts_resolved"] == 1 and _firing(db, c.id) == []

    view = svc.cluster_view(db, c)
    assert [col["group"] for col in view["columns"]] == ["cilium_ct4_global", "cilium_policy_v2"]
    a = view["agents"][0]
    assert a["node"] == "w1" and a["state"] == "reporting" and a["maps_skipped"] == 4
    pol = next(m for m in a["maps"] if m["group"] == "cilium_policy_v2")
    assert pol["members"] == 3 and pol["label"] == "정책(최대)"


def test_periodic_report_alerts_are_committed(db, world):
    """주기 보고(run_id 없음)의 알람도 커밋돼 다른 세션에서 보인다(route_and_notify 는 커밋하지 않는다)."""
    from app.database import SessionLocal
    from app.services.cilium_datapath import service as svc

    svc.handle_report(db, world.cluster, _report("w1", 950))
    other = SessionLocal()
    try:
        assert len(_firing(other, world.cluster.id)) == 1
    finally:
        other.close()


def test_alert_kept_when_map_not_observed(db, world):
    """맵을 못 읽거나 끝까지 세지 못한 보고는 회복이 아니다 — 열린 알람을 닫지 않는다."""
    from app.services.cilium_datapath import service as svc

    c = world.cluster
    svc.handle_report(db, c, _report("w1", 950))
    assert len(_firing(db, c.id)) == 1
    # 1) 고정 경로를 못 읽어 맵이 하나도 없는 보고
    empty = {**_report("w1", 1), "maps": [], "errors": ["고정 경로를 읽지 못함"]}
    assert svc.handle_report(db, c, empty)["alerts_resolved"] == 0
    # 2) 세지 못한 맵(entries 없음)
    unknown = _report("w1", 1)
    unknown["maps"][0]["entries"] = None
    assert svc.handle_report(db, c, unknown)["alerts_resolved"] == 0
    # 3) 시간 예산 초과로 일부만 센 값(하한)은 임계치 아래여도 회복으로 보지 않는다
    partial = _report("w1", 100)
    partial["maps"][0]["partial"] = True
    assert svc.handle_report(db, c, partial)["alerts_resolved"] == 0
    assert len(_firing(db, c.id)) == 1
    # 4) 끝까지 세어 임계치 아래 → 닫힌다
    assert svc.handle_report(db, c, _report("w1", 100))["alerts_resolved"] == 1
    assert _firing(db, c.id) == []


def test_alerts_can_be_disabled(db, world):
    from app.services.cilium_datapath import service as svc

    S.set_settings(db, {"alerts_enabled": False})
    svc.handle_report(db, world.cluster, _report("w1", 990))
    assert _firing(db, world.cluster.id) == []


def test_program_baseline_set_once_and_reset(db, world):
    from app.models.cilium_datapath import CiliumBpfAgent
    from app.services.cilium_datapath import service as svc

    c = world.cluster
    p1 = [{"name": "cil_from_netdev", "prog_type": "SCHED_CLS", "count": 1, "tags": ["aa"]}]
    p2 = [{"name": "cil_from_netdev", "prog_type": "SCHED_CLS", "count": 1, "tags": ["bb"]}]
    svc.handle_report(db, c, _report("w1", 1, programs=p1))
    svc.handle_report(db, c, _report("w1", 1, programs=p2))
    view = svc.cluster_view(db, c)
    assert view["agents"][0]["programs"][0]["diff"] == "changed"
    agent = db.query(CiliumBpfAgent).filter(CiliumBpfAgent.cluster_id == c.id).one()
    svc.set_baseline(db, agent)
    assert svc.cluster_view(db, c)["agents"][0]["programs"][0]["diff"] == "same"


def test_run_lifecycle_claim_logs_done(db, world):
    from app.services.cilium_datapath import runs as R
    from app.services.cilium_datapath import service as svc

    c = world.cluster
    with pytest.raises(ValueError, match="보고 중인 에이전트가 없습니다"):
        R.create_run(db, c, "tester")
    svc.handle_report(db, c, _report("w1", 10))
    svc.handle_report(db, c, _report("w2", 10))
    run = R.create_run(db, c, "tester")
    assert run.target_nodes == ["w1", "w2"] and run.status == "running"

    task = R.claim_task(db, c.id, "w1")
    assert task == {"run_id": str(run.id), "kind": "collect"}
    assert R.claim_task(db, c.id, "w1") is None  # 같은 노드는 한 번만
    assert R.claim_task(db, c.id, "zz") is None  # 대상이 아닌 노드

    assert R.append_logs(db, str(run.id), c.id, "w1", [{"level": "info", "message": "맵 18개"}, {"level": "bogus", "message": "x"}])
    assert not R.append_logs(db, str(run.id), c.id, "zz", [{"message": "x"}])
    svc.handle_report(db, c, _report("w1", 950, run_id=str(run.id)))
    db.refresh(run)
    assert run.done_nodes == ["w1"] and run.status == "running"
    msgs = [(ln["node"], ln["level"], ln["message"]) for ln in run.log_lines]
    assert ("w1", "info", "맵 18개") in msgs and ("w1", "info", "x") in msgs
    assert any(n == "w1" and lv == "warn" and "위험 1" in m for n, lv, m in msgs)

    # w2 는 끝내 보고하지 않음 → 제한 시간 뒤 partial
    run = R.finalize(db, run.id)
    assert run.status == "partial" and run.summary["missing"] == ["w2"] and run.summary["critical"] == 1
    assert any("작업을 받아 가지 않은 노드: w2" in ln["message"] for ln in run.log_lines)

    run2 = R.create_run(db, c, "tester", ["w2"])
    R.claim_task(db, c.id, "w2")
    svc.handle_report(db, c, _report("w2", 10, run_id=str(run2.id)))
    db.refresh(run2)
    assert run2.status == "succeeded" and run2.finished_at is not None


def test_claim_records_agent_command_for_admins_only(db, world):
    """작업 전달 시 노드에서 하는 일을 cmd 줄로 남긴다 — 관리자만 보고, 에이전트는 cmd 줄을 흉내 낼 수 없다."""
    from app.services import command_trace
    from app.services.cilium_datapath import runs as R
    from app.services.cilium_datapath import service as svc

    c = world.cluster
    svc.handle_report(db, c, _report("w1", 10))
    run = R.create_run(db, c, "tester")
    R.claim_task(db, c.id, "w1")
    R.append_logs(db, str(run.id), c.id, "w1", [{"level": "cmd", "message": "$ [ssh root@x] rm -rf /"}])
    db.refresh(run)
    cmds = [ln for ln in run.log_lines if ln["level"] == "cmd"]
    assert len(cmds) == 1 and cmds[0]["node"] == "w1"
    assert cmds[0]["message"].startswith("$ [agent w1] pep-bpf-agent collect --pin-dirs /sys/fs/bpf/tc/globals")
    assert "BPF_F_RDONLY" in cmds[0]["message"] and "BPF_PROG_GET_NEXT_ID" not in cmds[0]["message"]
    forged = next(ln for ln in run.log_lines if "rm -rf" in ln["message"])
    assert forged["level"] == "info"  # 에이전트가 보낸 cmd 는 info 로 내린다
    assert command_trace.filter_log_lines(run.log_lines, False) == [ln for ln in run.log_lines if ln["level"] != "cmd"]
    # CAP_SYS_ADMIN 을 켜면 프로그램 목록·ID 조회도 적힌다
    S.set_settings(db, {"sys_admin": True})
    text = R.agent_command(S.get_settings(db))
    assert "BPF_PROG_GET_NEXT_ID" in text and "BPF_MAP_GET_NEXT_ID" in text


def test_offline_agents_are_not_targets(db, world):
    from app.models.cilium_datapath import CiliumBpfAgent
    from app.services.cilium_datapath import runs as R
    from app.services.cilium_datapath import service as svc

    c = world.cluster
    svc.handle_report(db, c, _report("old", 10))
    agent = db.query(CiliumBpfAgent).filter(CiliumBpfAgent.cluster_id == c.id).one()
    agent.last_seen_at = datetime.utcnow() - timedelta(hours=3)
    db.commit()
    assert svc.cluster_view(db, c)["agents"][0]["state"] == "offline"
    with pytest.raises(ValueError):
        R.create_run(db, c, "tester")


def test_ingest_endpoints_token_fail_closed_and_long_poll(db, world, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.main import app
    from app.routers import cilium_datapath as router_mod
    from app.services.cilium_datapath import runs as R

    client = TestClient(app)
    body = {**_report("w9", 10), "cluster": world.cluster.name}
    monkeypatch.setattr(settings, "cilium_bpf_agent_token", "")
    assert client.post("/api/v1/cilium-datapath/agent/report", json=body).status_code == 503
    monkeypatch.setattr(settings, "cilium_bpf_agent_token", "s3cret")
    hdr = {"Authorization": "Bearer s3cret"}
    assert client.post("/api/v1/cilium-datapath/agent/report", json=body,
                       headers={"Authorization": "Bearer nope"}).status_code == 401
    r = client.post("/api/v1/cilium-datapath/agent/report", json=body, headers=hdr)
    assert r.status_code == 200, r.text
    assert r.json()["config"]["pin_dirs"] == ["/sys/fs/bpf/tc/globals"]
    assert client.post("/api/v1/cilium-datapath/agent/report", json={**body, "cluster": "no-such"},
                       headers=hdr).status_code == 404

    # 작업이 없으면 wait 뒤 null, 있으면 바로 받는다
    monkeypatch.setattr(router_mod, "TASK_POLL_SEC", 0.05)
    q = {"cluster": str(world.cluster.id), "node": "w9", "wait": 0}
    assert client.get("/api/v1/cilium-datapath/agent/tasks", params=q, headers=hdr).json() == {"task": None}
    run = R.create_run(db, world.cluster, "tester")
    got = client.get("/api/v1/cilium-datapath/agent/tasks", params={**q, "wait": 1}, headers=hdr).json()
    assert got["task"]["run_id"] == str(run.id)
    r = client.post(f"/api/v1/cilium-datapath/agent/runs/{run.id}/log", headers=hdr,
                    json={"cluster": world.cluster.name, "node": "w9", "lines": [{"level": "info", "message": "hi"}]})
    assert r.status_code == 200
    r = client.post(f"/api/v1/cilium-datapath/agent/runs/{uuid.uuid4()}/log", headers=hdr,
                    json={"cluster": world.cluster.name, "node": "w9", "lines": []})
    assert r.status_code == 404
