"""Architecture Doc 서비스/라우터 테스트.

단위(그래프 shaping/reconcile/LLM 파싱)는 DB 없이, sync/API 는 테스트 DB 로 검증한다.
collect_topology 는 monkeypatch — 실제 클러스터 불필요.
"""
import uuid
from datetime import datetime

import pytest

from app.services import architecture_doc_service as ads
from app.models.service_arch_doc import (
    ServiceArchDoc,
    ServiceArchManualEdge,
    ServiceArchManualNode,
)


# ── fixtures: raw collect_topology output ────────────────────────────────────
def _raw_graph():
    return {
        "nodes": [
            {"id": "Deployment/ns1/web", "kind": "Deployment", "name": "web",
             "namespace": "ns1", "status": "healthy", "labels": {"app": "web"},
             "_refs": {"configmaps": ["cm1"]}, "metrics": {}},
            {"id": "Service/ns1/websvc", "kind": "Service", "name": "websvc",
             "namespace": "ns1", "status": "healthy"},
            {"id": "Ingress/ns1/ing", "kind": "Ingress", "name": "ing",
             "namespace": "ns1", "status": "healthy"},
            {"id": "ConfigMap/ns1/cm1", "kind": "ConfigMap", "name": "cm1",
             "namespace": "ns1", "status": "healthy"},
            {"id": "Pod/ns1/web-1", "kind": "Pod", "name": "web-1",
             "namespace": "ns1", "status": "healthy"},
        ],
        "edges": [
            {"id": "e1", "source": "Service/ns1/websvc", "target": "Deployment/ns1/web",
             "type": "routes", "label": ""},
            {"id": "e2", "source": "Ingress/ns1/ing", "target": "Service/ns1/websvc",
             "type": "exposes", "label": ""},
            {"id": "e3", "source": "Deployment/ns1/web", "target": "ConfigMap/ns1/cm1",
             "type": "uses_config", "label": ""},
        ],
        "warnings": [],
        "truncated": False,
        "pod_name_index": {},
        "pod_ip_index": {},
        "workload_pods": {},
    }


# ── simplify_graph ───────────────────────────────────────────────────────────
def test_simplify_drops_config_and_pods():
    g = ads.simplify_graph(_raw_graph())
    kinds = {n["kind"] for n in g["nodes"]}
    assert kinds == {"Deployment", "Service", "Ingress"}
    types = {e["type"] for e in g["edges"]}
    assert "uses_config" not in types
    assert {"routes", "exposes"} == types
    # 내부 필드 제거
    assert all("_refs" not in n and "labels" not in n for n in g["nodes"])


def test_simplify_drops_dangling_edges():
    raw = _raw_graph()
    raw["edges"].append({"id": "e4", "source": "Deployment/ns1/web",
                         "target": "Pod/ns1/web-1", "type": "owns", "label": ""})
    g = ads.simplify_graph(raw)
    assert all(e["target"] != "Pod/ns1/web-1" for e in g["edges"])


# ── compute_source_hash ──────────────────────────────────────────────────────
def test_source_hash_stable_under_reorder_and_status():
    g1 = ads.simplify_graph(_raw_graph())
    g2 = ads.simplify_graph(_raw_graph())
    g2["nodes"].reverse()
    g2["edges"].reverse()
    g2["nodes"][0]["status"] = "critical"  # status 플래핑은 해시 불변
    assert ads.compute_source_hash(g1) == ads.compute_source_hash(g2)


def test_source_hash_changes_on_structure():
    g1 = ads.simplify_graph(_raw_graph())
    g2 = ads.simplify_graph(_raw_graph())
    g2["nodes"].append({"id": "Deployment/ns1/api", "kind": "Deployment",
                        "name": "api", "namespace": "ns1", "status": "healthy"})
    assert ads.compute_source_hash(g1) != ads.compute_source_hash(g2)


# ── reconcile ────────────────────────────────────────────────────────────────
def _doc(auto_graph=None, layout=None, annotations=None):
    d = ServiceArchDoc(
        lake_service_id=uuid.uuid4(), cluster_id=uuid.uuid4(), namespace="ns1",
        auto_graph=auto_graph, layout=layout or {}, annotations=annotations or {},
    )
    # 비영속 인스턴스 — relationship 컬렉션 초기화
    d.manual_nodes = []
    d.manual_edges = []
    return d


def test_reconcile_added_and_changed():
    doc = _doc(auto_graph=ads.simplify_graph(_raw_graph()))
    new = ads.simplify_graph(_raw_graph())
    new["nodes"].append({"id": "Deployment/ns1/api", "kind": "Deployment",
                         "name": "api", "namespace": "ns1", "status": "healthy"})
    for n in new["nodes"]:
        if n["id"] == "Deployment/ns1/web":
            n["status"] = "critical"
    diff = ads.reconcile(doc, new)
    assert diff["added"] == ["Deployment/ns1/api"]
    assert diff["changed"] == ["Deployment/ns1/web"]
    assert "removed" not in diff


def test_reconcile_removed_marks_stale_not_delete():
    doc = _doc(auto_graph=ads.simplify_graph(_raw_graph()))
    new = ads.simplify_graph(_raw_graph())
    new["nodes"] = [n for n in new["nodes"] if n["id"] != "Ingress/ns1/ing"]
    new["edges"] = [e for e in new["edges"] if e["source"] != "Ingress/ns1/ing"]
    diff = ads.reconcile(doc, new)
    assert diff["removed"] == ["Ingress/ns1/ing"]
    stale = [n for n in doc.auto_graph["nodes"] if n.get("stale")]
    assert len(stale) == 1 and stale[0]["id"] == "Ingress/ns1/ing"
    assert stale[0].get("stale_since")
    # 두 번째 동일 sync — 이미 stale 이므로 diff 없음(현행화 완료 상태)
    diff2 = ads.reconcile(doc, new)
    assert diff2 == {}


def test_reconcile_prune_respects_references():
    doc = _doc(
        auto_graph=ads.simplify_graph(_raw_graph()),
        annotations={"Ingress/ns1/ing": "keep me"},
    )
    me = ServiceArchManualEdge(source_id="Service/ns1/websvc", target_id="ext:db",
                               edge_type="flow")
    doc.manual_edges = [me]
    new = ads.simplify_graph(_raw_graph())
    new["nodes"] = [n for n in new["nodes"]
                    if n["id"] not in ("Ingress/ns1/ing", "Service/ns1/websvc")]
    new["edges"] = []
    ads.reconcile(doc, new, prune=True)
    ids = {n["id"] for n in doc.auto_graph["nodes"]}
    # annotation/manual edge 가 참조 → prune 에도 stale 로 보존
    assert "Ingress/ns1/ing" in ids and "Service/ns1/websvc" in ids


def test_reconcile_prune_drops_unreferenced():
    doc = _doc(auto_graph=ads.simplify_graph(_raw_graph()))
    new = ads.simplify_graph(_raw_graph())
    new["nodes"] = [n for n in new["nodes"] if n["id"] != "Ingress/ns1/ing"]
    new["edges"] = [e for e in new["edges"] if e["source"] != "Ingress/ns1/ing"]
    ads.reconcile(doc, new, prune=True)
    ids = {n["id"] for n in doc.auto_graph["nodes"]}
    assert "Ingress/ns1/ing" not in ids


def test_reconcile_preserves_manual_layers():
    layout = {"architecture": {"Deployment/ns1/web": {"x": 1, "y": 2}}}
    annotations = {"Deployment/ns1/web": "메모"}
    doc = _doc(auto_graph=ads.simplify_graph(_raw_graph()),
               layout=layout, annotations=annotations)
    doc.summary_override = "사용자 요약"
    ads.reconcile(doc, ads.simplify_graph(_raw_graph()))
    assert doc.layout == layout
    assert doc.annotations == annotations
    assert doc.summary_override == "사용자 요약"


def test_reconcile_stale_clears_when_node_returns():
    doc = _doc(auto_graph=ads.simplify_graph(_raw_graph()))
    gone = ads.simplify_graph(_raw_graph())
    gone["nodes"] = [n for n in gone["nodes"] if n["id"] != "Ingress/ns1/ing"]
    gone["edges"] = [e for e in gone["edges"] if e["source"] != "Ingress/ns1/ing"]
    ads.reconcile(doc, gone)
    # 노드가 되돌아오면 stale 해제 + changed 로 보고
    diff = ads.reconcile(doc, ads.simplify_graph(_raw_graph()))
    node = next(n for n in doc.auto_graph["nodes"] if n["id"] == "Ingress/ns1/ing")
    assert not node.get("stale")
    assert "Ingress/ns1/ing" in diff.get("changed", [])


# ── parse_llm_response ───────────────────────────────────────────────────────
def test_parse_llm_valid_json():
    out = ads.parse_llm_response(
        '{"summary": "요약", "components": [{"node_id": "a", "role": "웹"}], '
        '"flow_steps": [{"order": 1, "source": "a", "target": "b", "description": "호출"}]}'
    )
    assert out["summary"] == "요약"
    assert out["components"] == [{"node_id": "a", "role": "웹"}]
    assert out["flow_steps"][0]["order"] == 1
    assert out["raw_fallback"] is False


def test_parse_llm_fenced_json():
    out = ads.parse_llm_response('```json\n{"summary": "s"}\n```')
    assert out["summary"] == "s" and out["raw_fallback"] is False


def test_parse_llm_json_with_chatter():
    out = ads.parse_llm_response('물론입니다! 다음과 같습니다:\n{"summary": "s"}\n감사합니다.')
    assert out["summary"] == "s" and out["raw_fallback"] is False


def test_parse_llm_garbage_falls_back():
    out = ads.parse_llm_response("그래프를 분석해 보니 웹 서비스가 있습니다.")
    assert out["raw_fallback"] is True
    assert "웹 서비스" in out["summary"]
    assert out["components"] == [] and out["flow_steps"] == []


def test_filter_unknown_node_ids():
    doc = _doc(auto_graph=ads.simplify_graph(_raw_graph()))
    mn = ServiceArchManualNode(node_id="manual:abc", label="ext DB", kind="database")
    doc.manual_nodes = [mn]
    content = {
        "summary": "s",
        "components": [
            {"node_id": "Deployment/ns1/web", "role": "웹"},
            {"node_id": "manual:abc", "role": "DB"},
            {"node_id": "Hallucinated/x/y", "role": "없음"},
        ],
        "flow_steps": [
            {"order": 1, "source": "Deployment/ns1/web", "target": "manual:abc", "description": "d"},
            {"order": 2, "source": "Fake/a/b", "target": "manual:abc", "description": "d"},
        ],
    }
    out = ads._filter_known_node_ids(content, doc)
    assert {c["node_id"] for c in out["components"]} == {"Deployment/ns1/web", "manual:abc"}
    assert len(out["flow_steps"]) == 1


# ── build_llm_prompt ─────────────────────────────────────────────────────────
def test_build_llm_prompt_contains_graph_and_schema():
    from types import SimpleNamespace as NS
    doc = _doc(auto_graph=ads.simplify_graph(_raw_graph()))
    service = NS(name="Prod Airflow", service_type="airflow",
                 namespace="ns1", endpoint_url="http://a")
    prompt = ads.build_llm_prompt(doc, service)
    assert "Deployment/ns1/web" in prompt
    assert "JSON" in prompt and "flow_steps" in prompt
    assert "Prod Airflow" in prompt


# ── DB-backed: sync_doc + API ────────────────────────────────────────────────
@pytest.fixture
def db():
    from app.database import SessionLocal, engine, Base
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def cluster(db):
    from app.models import Cluster
    c = Cluster(name=f"t-{uuid.uuid4().hex[:8]}", api_endpoint="https://127.0.0.1:6443")
    db.add(c)
    db.commit()
    db.refresh(c)
    yield c
    db.delete(c)
    db.commit()


@pytest.fixture
def lake_service(db, cluster):
    from app.models import LakeService
    s = LakeService(cluster_id=cluster.id, service_type="airflow",
                    name=f"af-{uuid.uuid4().hex[:6]}",
                    endpoint_url="http://airflow.ns1.svc:8080", namespace="ns1")
    db.add(s)
    db.commit()
    db.refresh(s)
    yield s
    db.query(LakeService).filter(LakeService.id == s.id).delete()
    db.commit()


def test_sync_doc_success_and_audit(db, lake_service, monkeypatch):
    from app.models import TopologyAuditLog
    monkeypatch.setattr(ads.topo_svc, "collect_topology",
                        lambda cluster, ns, **kw: _raw_graph())
    monkeypatch.setattr(ads, "ensure_kubeconfig_file", lambda c: None)  # 트래픽 skip
    doc = ads.sync_doc(db, lake_service, triggered_by="manual", username="tester")
    assert doc.last_sync_status == "ok"
    assert doc.source_hash
    assert doc.drift and set(doc.drift.get("added", [])) == {
        "Deployment/ns1/web", "Service/ns1/websvc", "Ingress/ns1/ing"}
    audit = (db.query(TopologyAuditLog)
             .filter(TopologyAuditLog.entity_type == "arch_doc",
                     TopologyAuditLog.entity_id == str(lake_service.id))
             .all())
    assert any(a.action == "sync" and a.after_data.get("hash") == doc.source_hash
               for a in audit)
    # 동일 그래프 재sync → drift 해제
    doc = ads.sync_doc(db, lake_service)
    assert doc.drift is None


def test_sync_doc_failure_is_soft(db, lake_service, monkeypatch):
    def _boom(cluster, ns, **kw):
        raise RuntimeError("connection refused")
    monkeypatch.setattr(ads.topo_svc, "collect_topology", _boom)
    doc = ads.sync_doc(db, lake_service)
    assert doc.last_sync_status == "failed"
    assert "connection refused" in (doc.sync_error or "")


def test_sync_doc_requires_namespace(db, cluster):
    from app.models import LakeService
    s = LakeService(cluster_id=cluster.id, service_type="trino",
                    name=f"tr-{uuid.uuid4().hex[:6]}",
                    endpoint_url="http://trino:8080", namespace=None)
    db.add(s); db.commit(); db.refresh(s)
    try:
        doc = ads.sync_doc(db, s)
        assert doc.last_sync_status == "failed"
        assert "namespace" in (doc.sync_error or "")
    finally:
        db.query(LakeService).filter(LakeService.id == s.id).delete()
        db.commit()


# ── API round-trip (auth + CRUD + layout) ────────────────────────────────────
@pytest.fixture
def client(db):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user
    from types import SimpleNamespace as NS

    app.dependency_overrides[get_current_user] = lambda: NS(
        id=uuid.uuid4(), username="tester", role="admin")
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_api_requires_auth(lake_service):
    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    assert c.get("/api/v1/architecture-docs").status_code == 401


def test_api_doc_roundtrip(client, db, lake_service):
    sid = str(lake_service.id)

    # 목록 — 문서 미생성 모듈 포함
    r = client.get("/api/v1/architecture-docs")
    assert r.status_code == 200
    row = next(x for x in r.json() if x["service_id"] == sid)
    assert row["has_doc"] is False and row["last_sync_status"] == "pending"

    # 문서 조회 — 빈 shell 자동 생성
    r = client.get(f"/api/v1/architecture-docs/{sid}")
    assert r.status_code == 200
    assert r.json()["last_sync_status"] == "pending"

    # 수동 노드/엣지 CRUD
    r = client.post(f"/api/v1/architecture-docs/{sid}/manual-nodes",
                    json={"label": "외부 DB", "kind": "database"})
    assert r.status_code == 201
    node = r.json()
    assert node["node_id"].startswith("manual:")

    r = client.post(f"/api/v1/architecture-docs/{sid}/manual-edges",
                    json={"source_id": node["node_id"], "target_id": "Deployment/ns1/web",
                          "edge_type": "flow", "view": "flow"})
    assert r.status_code == 201
    edge = r.json()

    # self-edge 거부
    r = client.post(f"/api/v1/architecture-docs/{sid}/manual-edges",
                    json={"source_id": "a", "target_id": "a"})
    assert r.status_code == 422

    # layout bulk 저장 + annotations merge
    r = client.patch(f"/api/v1/architecture-docs/{sid}/layout",
                     json={"view": "architecture",
                           "positions": [{"id": node["node_id"], "x": 10.5, "y": 20.25}]})
    assert r.status_code == 200
    assert r.json()["layout"]["architecture"][node["node_id"]] == {"x": 10.5, "y": 20.25}

    r = client.patch(f"/api/v1/architecture-docs/{sid}",
                     json={"annotations": [{"id": node["node_id"], "text": "중요 노드"}],
                           "summary_override": "수동 요약"})
    assert r.status_code == 200
    body = r.json()
    assert body["annotations"][node["node_id"]] == "중요 노드"
    assert body["summary_override"] == "수동 요약"

    # annotation 삭제 (text=null merge)
    r = client.patch(f"/api/v1/architecture-docs/{sid}",
                     json={"annotations": [{"id": node["node_id"], "text": None}]})
    assert node["node_id"] not in r.json()["annotations"]

    # 노드 삭제 → 걸린 수동 엣지도 정리
    r = client.delete(f"/api/v1/architecture-docs/{sid}/manual-nodes/{node['id']}")
    assert r.status_code == 204
    r = client.get(f"/api/v1/architecture-docs/{sid}")
    assert r.json()["manual_nodes"] == []
    assert all(e["id"] != edge["id"] for e in r.json()["manual_edges"])

    # 감사 이력 존재
    r = client.get(f"/api/v1/architecture-docs/{sid}/audit")
    assert r.status_code == 200
    assert any(a["action"] == "create" for a in r.json())


def test_api_schedule_roundtrip(client):
    r = client.get("/api/v1/architecture-docs/schedule")
    assert r.status_code == 200
    assert r.json()["cron"]

    r = client.put("/api/v1/architecture-docs/schedule",
                   json={"enabled": True, "cron": "30 5 * * *"})
    assert r.status_code == 200
    assert r.json()["cron"] == "30 5 * * *"

    r = client.put("/api/v1/architecture-docs/schedule",
                   json={"enabled": True, "cron": "not a cron"})
    assert r.status_code == 422
