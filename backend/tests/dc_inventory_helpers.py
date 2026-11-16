"""DC 인벤토리 테스트 공용 헬퍼 — 테스트 DB 의 dc_* 테이블을 비우고 기본 위치 계층을 만든다."""
import importlib.util
import os
import pathlib
import uuid

from sqlalchemy import text

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

API = "/api/v1/dc"
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

_DC_TABLES = (
    "dc_ip_addresses", "dc_asns", "dc_prefixes", "dc_vrfs", "dc_cables", "dc_interfaces", "dc_devices",
    "dc_device_types", "dc_racks", "dc_rack_rows", "dc_halls", "dc_sites", "dc_change_logs",
)


def wipe(db) -> None:
    """dc_* 전부 삭제(테스트 DB 전용 — conftest 가 DB 이름에 test 가 없으면 수집 전에 막는다)."""
    db.rollback()
    for table in ("node_server_specs", "infra_nodes"):
        db.execute(text(f"UPDATE {table} SET device_id = NULL WHERE device_id IS NOT NULL"))
    for table in _DC_TABLES:
        db.execute(text(f"DELETE FROM {table}"))
    db.commit()


def make_user(db, role: str):
    from app.models.user import User

    user = User(username=f"dc-{role}-{uuid.uuid4().hex[:8]}", hashed_password="x", role=role,
                display_name=f"DC {role}")
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def client_as(user):
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def post(client, path: str, body: dict, expect: int = 201) -> dict:
    r = client.post(f"{API}/{path}", json=body)
    assert r.status_code == expect, f"{path} → {r.status_code} {r.text}"
    return r.json()


def make_rack(client, name: str = "R01", *, rack_no: int | None = 1, u_height: int = 42, row: str = "A") -> dict:
    """사이트 → 홀 → 열 → 랙. 이미 있는 상위는 재사용한다."""
    def get_or_create(path: str, body: dict, match: dict) -> dict:
        items = client.get(f"{API}/{path}", params={"limit": 1000}).json()["items"]
        for item in items:
            if all(item.get(k) == v for k, v in match.items()):
                return item
        return post(client, path, body)

    site = get_or_create("sites", {"name": "DC-T"}, {"name": "DC-T"})
    hall = get_or_create("halls", {"site_id": site["id"], "name": "Hall-1"}, {"site_id": site["id"], "name": "Hall-1"})
    rack_row = get_or_create("rack-rows", {"hall_id": hall["id"], "name": row}, {"hall_id": hall["id"], "name": row})
    return post(client, "racks", {"row_id": rack_row["id"], "name": name, "rack_no": rack_no, "u_height": u_height})


def make_type(client, model: str = "Server-2U", *, u_height: int = 2, full: bool = True, templates=None) -> dict:
    return post(client, "device-types", {
        "model": model, "u_height": u_height, "is_full_depth": full, "interface_templates": templates,
    })


def load_seed_module():
    """scripts/lab/seed_dc_inventory.py 를 모듈로 읽는다(패키지가 아니라 경로로)."""
    path = REPO_ROOT / "scripts" / "lab" / "seed_dc_inventory.py"
    spec = importlib.util.spec_from_file_location("seed_dc_inventory", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_verify_module():
    path = REPO_ROOT / "scripts" / "dc_inventory" / "verify_import.py"
    spec = importlib.util.spec_from_file_location("verify_dc_import", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
