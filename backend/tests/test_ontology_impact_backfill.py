"""A-17 후속 — 구버전 영향 분석 기록(config_change/warning)을 impact_simulation/info 로 재분류하는
1회성 백필(``main._backfill_impact_simulation_events``, ``_run_migrations`` 에서 호출) 회귀 테스트.

- 온톨로지 화면이 남긴 표지(분류·심각도·"<이름> 변경 영향 분석" 제목·requested_by 없음)가 모두 맞는
  행만 고친다. 하나라도 어긋나면 건드리지 않는다.
- 다시 돌려도 결과가 같다(멱등).
- 재분류된 행은 RAG 근거 인용에서 빠진다.
실제 Postgres(pgvector)로 검증한다.
"""
import os
import uuid

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from app.config import settings  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations  # noqa: E402
from app.models.cluster import Cluster  # noqa: E402
from app.models.ontology import OntologyEvent  # noqa: E402
from app.services import rag_service  # noqa: E402
from app.services.llm import service as llm_service_module  # noqa: E402

DIM = settings.embedding_dim


def _vec() -> list[float]:
    v = [0.0] * DIM
    v[3] = 1.0
    return v


@pytest.fixture(scope="module")
def _schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()


@pytest.fixture
def db(_schema):
    s = SessionLocal()
    yield s
    s.rollback()
    s.close()


@pytest.fixture
def seeded(db):
    tag = uuid.uuid4().hex[:8]
    cluster = Cluster(name=f"onto-bf-{tag}", api_endpoint="https://bf:6443")
    db.add(cluster)
    db.commit()

    def _ev(title, *, category="config_change", severity="warning", evidence=None):
        return OntologyEvent(cluster_id=cluster.id, category=category, severity=severity,
                             title=title, evidence=evidence or {}, embedding=_vec())

    rows = {
        # 구버전 온톨로지 화면이 남긴 영향 분석 그대로
        "old": _ev(f"cfg-{tag} 변경 영향 분석"),
        # 표지가 하나라도 어긋나면 건드리지 않는다
        "other_title": _ev(f"cfg-{tag} 실제 구성 변경"),
        "other_category": _ev(f"cfg-{tag} 변경 영향 분석", category="release"),
        "other_severity": _ev(f"cfg-{tag} 변경 영향 분석", severity="critical"),
        "new_style_evidence": _ev(f"cfg-{tag} 변경 영향 분석", evidence={"requested_by": "x"}),
    }
    db.add_all(rows.values())
    db.commit()
    ids = {k: r.id for k, r in rows.items()}
    yield ids

    db.rollback()
    db.query(Cluster).filter(Cluster.id == cluster.id).delete(synchronize_session=False)  # 이벤트는 CASCADE
    db.commit()


def _state(db, ids) -> dict:
    db.expire_all()
    return {
        k: tuple(db.query(OntologyEvent.category, OntologyEvent.severity).filter(OntologyEvent.id == v).one())
        for k, v in ids.items()
    }


def test_backfill_reclassifies_only_marked_rows_and_is_idempotent(db, seeded):
    _run_migrations()
    first = _state(db, seeded)
    assert first["old"] == ("impact_simulation", "info")
    assert first["other_title"] == ("config_change", "warning")
    assert first["other_category"] == ("release", "warning")
    assert first["other_severity"] == ("config_change", "critical")
    assert first["new_style_evidence"] == ("config_change", "warning")

    _run_migrations()
    assert _state(db, seeded) == first


async def test_backfilled_row_is_no_longer_cited(db, seeded, monkeypatch):
    async def _fake_embed(self, text, *, db=None):  # noqa: ARG001
        return _vec()
    monkeypatch.setattr(llm_service_module.LLMService, "embed", _fake_embed)

    async def _ids() -> set[str]:
        res = await rag_service.retrieve(db, "구성 변경", k=500, source_types=["ontology_event"])
        return {c["ref_id"] for c in res}

    assert str(seeded["old"]) in await _ids()  # 백필 전에는 근거로 인용된다
    _run_migrations()
    after = await _ids()
    assert str(seeded["old"]) not in after
    assert str(seeded["other_title"]) in after
