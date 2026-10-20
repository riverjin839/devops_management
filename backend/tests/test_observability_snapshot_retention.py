"""push 모드 관측 스냅샷 수신 — 같은 (클러스터, 모듈, 종류)는 최근 5건만 남는다(오래된 것은 id 로 묶어 삭제)."""
import uuid

import pytest


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient
    from app.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "alert_ingest_token", "snap-test-token")
    return TestClient(app)


def test_keeps_latest_five_snapshots(client):
    from app.database import SessionLocal
    from app.models.observability import ObservabilitySnapshot

    module = f"retention-{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        for i in range(8):
            r = client.post(
                "/api/v1/observability/snapshot/ingest",
                headers={"Authorization": "Bearer snap-test-token"},
                json={"module": module, "kind": "metrics", "payload": {"i": i},
                      "collected_at": f"2026-01-01T00:00:0{i}"},
            )
            assert r.status_code == 201, r.text
        rows = (db.query(ObservabilitySnapshot)
                .filter(ObservabilitySnapshot.module_key == module)
                .order_by(ObservabilitySnapshot.collected_at).all())
        assert [r.payload["i"] for r in rows] == [3, 4, 5, 6, 7]
    finally:
        db.query(ObservabilitySnapshot).filter(ObservabilitySnapshot.module_key == module).delete()
        db.commit()
        db.close()
