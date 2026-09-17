"""점검 매트릭스 — "정해진 카드" 제약 해소(커스텀 카드) 테스트.

커버하는 계약:
  CC-1  행 전용 정의(CheckMatrixItem.definition_id) — 같은 check_type 으로 설정이 다른
        카드를 여러 장 만들 수 있고, 서로의 임계값/파라미터를 건드리지 않는다.
  CC-2  공유 해석(check_type → 정의)이 남의 행 전용 정의를 집지 않는다.
  CC-3  셀의 클러스터별 오버라이드(copy-on-write)가 행 계보(parent_id) 안에 머문다.
  CC-4  기본 등록 카드도 설정을 조회·수정할 수 있고, 원할 때 전용 설정으로 분리된다.
  CC-5  마법사에서 작성한 Ansible 플레이북이 라이브러리 + 클러스터별 실행 단위로 등록되고,
        그 이름으로 만든 매트릭스 행이 실제로 실행 가능해진다.
"""
import uuid

import pytest

from app.models import (
    CheckMatrixItem,
    CheckMatrixSourceType,
    Cluster,
    DeepCheckDefinition,
    DeepCheckResult,
    Playbook,
)
from app.models.ansible_assets import AnsiblePlaybookFile
from app.services import check_matrix_service as svc
from app.services.check_matrix_runbook import build_runbook


@pytest.fixture
def db():
    from app.database import SessionLocal, engine, Base
    from app.main import _ensure_pgvector_extension

    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def cluster(db):
    c = Cluster(name=f"cc-{uuid.uuid4().hex[:8]}", api_endpoint="https://127.0.0.1:65535")
    db.add(c)
    db.commit()
    yield c
    db.query(Cluster).filter(Cluster.id == c.id).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def cleanup(db):
    """테스트가 만든 행/정의/플레이북을 역순으로 지운다(FK 순서 보존).

    명시적으로 등록한 객체 외에, 이 테스트가 **간접적으로** 만든 DeepCheckDefinition 도
    함께 쓸어담는다 — 글로벌 정의 한 건이 남으면 "정의가 없으면 skipped" 를 검증하는 다른
    테스트가 실제 실행으로 넘어가 버려(그리고 deep_check_results 가 쌓여) 무너진다.
    """
    before_defs = {d.id for d in db.query(DeepCheckDefinition.id).all()}
    created: list = []
    yield created
    for obj in reversed(created):
        try:
            row = db.query(type(obj)).filter(type(obj).id == obj.id).first()
            if row is not None:
                db.delete(row)
                db.commit()
        except Exception:  # noqa: BLE001 — 정리 실패가 테스트 결과를 가리지 않게
            db.rollback()
    try:
        leaked = [
            d for d in db.query(DeepCheckDefinition).all() if d.id not in before_defs
        ]
        for d in leaked:
            db.query(DeepCheckResult).filter(
                DeepCheckResult.definition_id == d.id,
            ).delete(synchronize_session=False)
        # 자식(클러스터 오버라이드)부터 지워야 FK 가 걸리지 않는다.
        for d in sorted(leaked, key=lambda x: x.parent_id is None):
            db.delete(d)
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()


def _custom_http_item(db, cleanup, name: str, endpoints: list[str]):
    """custom_http 로 "전용 설정" 카드 1장을 만든다 — 마법사 create_item 과 같은 순서."""
    definition = svc.create_dedicated_definition(
        db, "custom_http", name=name, params={"endpoints": endpoints},
    )
    item = CheckMatrixItem(
        name=name,
        source_type=CheckMatrixSourceType.deep_check,
        source_ref="custom_http",
        definition_id=definition.id,
    )
    db.add(item)
    db.commit()
    cleanup.append(item)
    cleanup.append(definition)
    return item, definition


# ── CC-1 / CC-2 행 전용 정의 ─────────────────────────────────────────────────
class TestDedicatedDefinition:
    def test_same_check_type_can_have_two_independent_cards(self, db, cluster, cleanup):
        item_a, def_a = _custom_http_item(db, cleanup, f"portal-{uuid.uuid4().hex[:6]}", ["http://a"])
        item_b, def_b = _custom_http_item(db, cleanup, f"object-{uuid.uuid4().hex[:6]}", ["http://b"])

        assert def_a.id != def_b.id
        assert svc.resolve_definition_for_item(db, item_a, cluster.id).id == def_a.id
        assert svc.resolve_definition_for_item(db, item_b, cluster.id).id == def_b.id
        assert svc.resolve_definition_for_item(db, item_a, cluster.id).params["endpoints"] == ["http://a"]
        assert svc.resolve_definition_for_item(db, item_b, cluster.id).params["endpoints"] == ["http://b"]

    def test_shared_resolution_ignores_other_rows_dedicated_definition(self, db, cluster, cleanup):
        """전용 정의는 check_type 공유 해석에서 제외된다 — 남의 설정이 새어 나오면 안 된다.

        공유 정의가 **함께 있을 때도** 공유 쪽이 잡혀야 한다(전용 정의가 먼저 만들어져도).
        """
        _item, dedicated = _custom_http_item(db, cleanup, f"probe-{uuid.uuid4().hex[:6]}", ["http://x"])
        shared_def, _created = svc.ensure_deep_check_definition(
            db, "custom_http", None, {"endpoints": ["http://shared"]},
        )
        db.commit()
        cleanup.append(shared_def)

        resolved = svc._resolve_deep_check_definition(db, "custom_http", cluster.id)
        assert resolved is not None
        assert resolved.id == shared_def.id
        assert resolved.id != dedicated.id

    def test_item_without_dedicated_definition_uses_shared(self, db, cluster, cleanup):
        """전용 정의를 안 쓰는 행은 예전과 똑같이 공유 정의로 해석된다(하위 호환)."""
        shared_def, _created = svc.ensure_deep_check_definition(
            db, "custom_http", None, {"endpoints": ["http://legacy"]},
        )
        db.commit()
        cleanup.append(shared_def)
        item = CheckMatrixItem(
            name=f"legacy-{uuid.uuid4().hex[:6]}",
            source_type=CheckMatrixSourceType.deep_check,
            source_ref="custom_http",
        )
        db.add(item)
        db.commit()
        cleanup.append(item)
        assert svc.resolve_definition_for_item(db, item, cluster.id).id == shared_def.id

    def test_runbook_uses_the_rows_own_definition(self, db, cluster, cleanup):
        item, definition = _custom_http_item(db, cleanup, f"rb-{uuid.uuid4().hex[:6]}", ["http://rb"])
        rb = build_runbook(db, item, cluster)
        assert rb["definition_id"] == str(definition.id)


# ── CC-3 클러스터별 오버라이드는 계보 안에서 ─────────────────────────────────
class TestClusterOverride:
    def test_cell_edit_creates_child_override_bound_to_the_row(self, db, cluster, cleanup):
        item, definition = _custom_http_item(db, cleanup, f"ov-{uuid.uuid4().hex[:6]}", ["http://ov"])
        out = svc.update_source_config(
            db, item, cluster,
            [{"group": "thresholds", "name": "warning_failure_pct", "value": "42"}],
        )
        assert out["scope"] == "cluster"
        assert out["copied_from_global"] is True

        child = (
            db.query(DeepCheckDefinition)
            .filter(DeepCheckDefinition.id == out["definition_id"])
            .first()
        )
        cleanup.append(child)
        assert child.parent_id == definition.id
        assert child.cluster_id == cluster.id
        assert child.thresholds["warning_failure_pct"] == 42
        # 같은 클러스터에서 이 행을 실행하면 이제 오버라이드가 잡힌다.
        assert svc.resolve_definition_for_item(db, item, cluster.id).id == child.id
        # 원본(행 기준 정의)은 그대로다.
        assert definition.thresholds.get("warning_failure_pct") != 42

    def test_other_rows_override_is_not_picked_up(self, db, cluster, cleanup):
        item_a, _def_a = _custom_http_item(db, cleanup, f"a-{uuid.uuid4().hex[:6]}", ["http://a"])
        item_b, def_b = _custom_http_item(db, cleanup, f"b-{uuid.uuid4().hex[:6]}", ["http://b"])
        out = svc.update_source_config(
            db, item_a, cluster,
            [{"group": "thresholds", "name": "critical_failure_pct", "value": "99"}],
        )
        child = (
            db.query(DeepCheckDefinition)
            .filter(DeepCheckDefinition.id == out["definition_id"])
            .first()
        )
        cleanup.append(child)
        assert svc.resolve_definition_for_item(db, item_b, cluster.id).id == def_b.id


# ── CC-4 기본 등록 카드의 설정 확인·수정 ─────────────────────────────────────
class TestItemSourceConfig:
    def test_seeded_card_exposes_current_values_and_shared_note(self, db, cleanup):
        # 부팅 시드와 같은 상태 — check_type 당 1개의 공유(글로벌) 정의가 있는 경우.
        shared, created = svc.ensure_deep_check_definition(db, "cert_expiry")
        db.commit()
        if created:
            cleanup.append(shared)
        item = CheckMatrixItem(
            name=f"cert-{uuid.uuid4().hex[:6]}",
            source_type=CheckMatrixSourceType.deep_check,
            source_ref="cert_expiry",
        )
        db.add(item)
        db.commit()
        cleanup.append(item)

        cfg = svc.item_source_config(db, item)
        assert cfg["editable"] is True
        assert cfg["dedicated"] is False
        assert any(f["name"] == "warning_days" for f in cfg["threshold_fields"])
        assert cfg["thresholds"]["warning_days"] is not None
        assert "공유" in (cfg["note"] or "")

    def test_saving_with_dedicated_detaches_without_touching_shared(self, db, cleanup):
        item = CheckMatrixItem(
            name=f"cert-split-{uuid.uuid4().hex[:6]}",
            source_type=CheckMatrixSourceType.deep_check,
            source_ref="cert_expiry",
        )
        db.add(item)
        db.commit()
        cleanup.append(item)

        shared_before = svc._resolve_deep_check_definition(db, "cert_expiry", None)
        shared_warning_before = (shared_before.thresholds or {}).get("warning_days") if shared_before else None

        out = svc.update_item_source_config(
            db, item, thresholds={"warning_days": 3}, params=None, dedicated=True,
        )
        assert out["created"] is True
        assert out["dedicated"] is True
        dedicated = (
            db.query(DeepCheckDefinition)
            .filter(DeepCheckDefinition.id == out["definition_id"])
            .first()
        )
        cleanup.append(dedicated)
        assert item.definition_id == dedicated.id
        assert dedicated.thresholds["warning_days"] == 3
        if shared_before is not None:
            db.refresh(shared_before)
            assert (shared_before.thresholds or {}).get("warning_days") == shared_warning_before

    def test_unknown_field_is_rejected(self, db, cleanup):
        item = CheckMatrixItem(
            name=f"cert-bad-{uuid.uuid4().hex[:6]}",
            source_type=CheckMatrixSourceType.deep_check,
            source_ref="cert_expiry",
        )
        db.add(item)
        db.commit()
        cleanup.append(item)
        with pytest.raises(ValueError):
            svc.update_item_source_config(db, item, thresholds={"nope": 1}, dedicated=True)

    def test_non_deep_check_item_is_not_editable(self, db, cleanup):
        item = CheckMatrixItem(
            name=f"manual-{uuid.uuid4().hex[:6]}", source_type=CheckMatrixSourceType.manual,
        )
        db.add(item)
        db.commit()
        cleanup.append(item)
        assert svc.item_source_config(db, item)["editable"] is False


# ── CC-5 내가 만든 Ansible 플레이북을 카드로 ────────────────────────────────
class TestPlaybookCard:
    def test_authoring_creates_library_file_and_per_cluster_playbook(self, db, cluster, cleanup):
        name = f"wizard-pb-{uuid.uuid4().hex[:6]}"
        out = svc.create_playbook_card_targets(
            db,
            name=name,
            content="- hosts: all\n  tasks: []\n",
            description="마법사에서 작성",
            cluster_ids=[cluster.id],
            extra_vars={"foo": "bar"},
        )
        db.commit()
        assert out["created_cluster_ids"] == [str(cluster.id)]

        pb_file = (
            db.query(AnsiblePlaybookFile).filter(AnsiblePlaybookFile.name == name).first()
        )
        playbook = (
            db.query(Playbook)
            .filter(Playbook.name == name, Playbook.cluster_id == cluster.id)
            .first()
        )
        cleanup.append(playbook)
        cleanup.append(pb_file)
        assert pb_file is not None
        assert playbook is not None
        assert playbook.playbook_file_id == pb_file.id
        assert playbook.extra_vars == {"foo": "bar"}

        # 이 이름으로 만든 행은 해당 클러스터에서 실행 가능해야 한다.
        item = CheckMatrixItem(
            name=name, source_type=CheckMatrixSourceType.playbook, source_ref=name,
        )
        db.add(item)
        db.commit()
        cleanup.append(item)
        rb = build_runbook(db, item, cluster)
        assert rb["runnable"] is True

    def test_same_name_updates_content_instead_of_duplicating(self, db, cluster, cleanup):
        name = f"wizard-pb2-{uuid.uuid4().hex[:6]}"
        svc.create_playbook_card_targets(
            db, name=name, content="- hosts: all\n  tasks: []\n", cluster_ids=[cluster.id],
        )
        db.commit()
        out = svc.create_playbook_card_targets(
            db, name=name, content="- hosts: all\n  tasks: [{name: x, ping: {}}]\n",
            cluster_ids=[cluster.id],
        )
        db.commit()
        assert out["updated_cluster_ids"] == [str(cluster.id)]
        files = db.query(AnsiblePlaybookFile).filter(AnsiblePlaybookFile.name == name).all()
        playbooks = db.query(Playbook).filter(Playbook.name == name).all()
        for p in playbooks:
            cleanup.append(p)
        for f in files:
            cleanup.append(f)
        assert len(files) == 1
        assert len(playbooks) == 1
        assert "ping" in files[0].content

    def test_requires_content_and_cluster(self, db, cluster):
        with pytest.raises(ValueError):
            svc.create_playbook_card_targets(db, name="x", content="", cluster_ids=[cluster.id])
        with pytest.raises(ValueError):
            svc.create_playbook_card_targets(db, name="x", content="- hosts: all", cluster_ids=[])


# ── 카탈로그 — "새로 만들기" 선택지가 노출된다 ───────────────────────────────
class TestCatalogCreatable:
    def test_catalog_offers_new_playbook_and_custom_check(self, db):
        catalog = svc.list_catalog(db)
        kinds = {c["kind"] for c in catalog["creatable"]}
        assert "new_playbook" in kinds
        assert "custom_check" in kinds
        assert "ansible" in catalog["exec_techs"]
        deep = [i for i in catalog["items"] if i["source_type"] == "deep_check"]
        assert deep and all(i["supports_dedicated"] for i in deep)


# ── 라우터 — 등록 마법사가 실제로 쓰는 경로 ──────────────────────────────────
@pytest.fixture
def admin_user(db):
    from app.models import User

    user = User(
        username=f"cc-admin-{uuid.uuid4().hex[:8]}", hashed_password="x",
        role="admin", display_name="Custom Card Admin",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    yield user
    db.query(User).filter(User.id == user.id).delete()
    db.commit()


@pytest.fixture
def client(admin_user):
    from fastapi.testclient import TestClient
    from app.auth.deps import get_current_user
    from app.main import app

    app.dependency_overrides[get_current_user] = lambda: admin_user
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_current_user, None)


class TestCreateItemRouter:
    def test_dedicated_flag_creates_row_scoped_definition(self, db, client, cleanup):
        name = f"api-http-{uuid.uuid4().hex[:6]}"
        res = client.post("/api/v1/check-matrix/items", json={
            "name": name,
            "source_type": "deep_check",
            "source_ref": "custom_http",
            "dedicated_definition": True,
            "params": {"endpoints": ["http://api-test"]},
        })
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["definition_id"]
        item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == body["id"]).first()
        definition = (
            db.query(DeepCheckDefinition)
            .filter(DeepCheckDefinition.id == body["definition_id"])
            .first()
        )
        cleanup.append(item)
        cleanup.append(definition)
        assert definition.params["endpoints"] == ["http://api-test"]

    def test_new_playbook_is_registered_and_linked(self, db, client, cluster, cleanup):
        pb_name = f"api-pb-{uuid.uuid4().hex[:6]}"
        res = client.post("/api/v1/check-matrix/items", json={
            "name": pb_name,
            "source_type": "playbook",
            "new_playbook": {
                "name": pb_name,
                "content": "- hosts: all\n  tasks: []\n",
                "cluster_ids": [str(cluster.id)],
                "extra_vars": [{"name": "myVar", "value": "1"}],
            },
        })
        assert res.status_code == 200, res.text
        item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == res.json()["id"]).first()
        playbook = (
            db.query(Playbook)
            .filter(Playbook.name == pb_name, Playbook.cluster_id == cluster.id)
            .first()
        )
        pb_file = db.query(AnsiblePlaybookFile).filter(AnsiblePlaybookFile.name == pb_name).first()
        cleanup.append(item)
        cleanup.append(playbook)
        cleanup.append(pb_file)
        assert item.source_ref == pb_name
        assert playbook is not None
        assert pb_file is not None
        # 사용자가 정한 변수명은 그대로 보존돼야 한다(키 변환에 망가지지 않는 경로).
        assert playbook.extra_vars == {"myVar": "1"}

    def test_new_playbook_without_cluster_is_rejected(self, client):
        pb_name = f"api-pb-bad-{uuid.uuid4().hex[:6]}"
        res = client.post("/api/v1/check-matrix/items", json={
            "name": pb_name,
            "source_type": "playbook",
            "new_playbook": {"name": pb_name, "content": "- hosts: all", "cluster_ids": []},
        })
        assert res.status_code == 400

    def test_item_source_config_roundtrip(self, db, client, cleanup):
        name = f"api-cfg-{uuid.uuid4().hex[:6]}"
        created = client.post("/api/v1/check-matrix/items", json={
            "name": name, "source_type": "deep_check", "source_ref": "cert_expiry",
        }).json()
        item = db.query(CheckMatrixItem).filter(CheckMatrixItem.id == created["id"]).first()
        cleanup.append(item)

        got = client.get(f"/api/v1/check-matrix/items/{item.id}/source-config").json()
        assert got["editable"] is True

        saved = client.put(f"/api/v1/check-matrix/items/{item.id}/source-config", json={
            "thresholds": {"warning_days": 11}, "dedicated": True,
        })
        assert saved.status_code == 200, saved.text
        definition = (
            db.query(DeepCheckDefinition)
            .filter(DeepCheckDefinition.id == saved.json()["definition_id"])
            .first()
        )
        cleanup.append(definition)
        assert definition.thresholds["warning_days"] == 11

        again = client.get(f"/api/v1/check-matrix/items/{item.id}/source-config").json()
        assert again["dedicated"] is True
        assert again["thresholds"]["warning_days"] == 11
