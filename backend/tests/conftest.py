"""
Shared pytest configuration and fixtures.

When the test environment is missing optional third-party modules that pytest
collection touches via app imports, register minimal stubs so pure-unit tests
(e.g. test_csv_glob.py) can still be collected and run. If the real module is
already importable (CI, full dev env) we leave it alone — the stub MUST NOT
shadow the real package.
"""
import importlib.util
import os
import sys
import types


def _stub_if_missing(name: str) -> types.ModuleType | None:
    """Register a stub module under `name` only if the real one isn't importable."""
    if name in sys.modules:
        return sys.modules[name]
    if importlib.util.find_spec(name) is not None:
        return None
    mod = types.ModuleType(name)
    sys.modules[name] = mod
    return mod


# ── Optional deps that only some tests need ─────────────────────────────
# `feedparser` is used by trends/rss_collector. Real package exists in
# CI/full-dev requirements.txt and will be left alone.
# (app.auth.security 는 PyJWT/bcrypt 를 쓴다 — 둘 다 필수 의존이라 스텁이 필요 없다.)

_stub_if_missing("feedparser")


# ── Standard env-vars required by app.config / SQLAlchemy engine init ──────

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")
os.environ.setdefault("CELERY_BROKER_URL", "redis://localhost:6379/0")
os.environ.setdefault("CELERY_RESULT_BACKEND", "redis://localhost:6379/0")
os.environ.setdefault("SECRET_KEY", "test-secret-key")


# ── 운영 DB 보호 가드 ─────────────────────────────────────────────────────
# 위 setdefault 는 DATABASE_URL 이 이미 있으면 그대로 쓴다 — backend 파드 안(`kubectl exec`)이나
# 운영 DB 접속 정보가 env 로 박힌 Jenkins 에이전트에서 pytest 를 돌리면 테스트가 운영 DB 에
# 계정을 만들고 지우며 app_settings 키를 삭제한다(사이드바 설치 목록이 배포 후 통째로 다시
# 채워지던 버그의 원인 경로). DB 이름에 "test" 가 없으면 수집 전에 중단한다. 일부러 다른 DB 를
# 써야 하면 PEP_TESTS_ALLOW_NON_TEST_DB=1 로 명시적으로 우회한다.
def _database_name(url: str) -> str:
    from urllib.parse import urlparse

    return urlparse(url).path.lstrip("/").split("?")[0]


def pytest_configure(config):  # noqa: ARG001 — pytest hook signature
    import pytest

    db_name = _database_name(os.environ.get("DATABASE_URL", ""))
    if "test" not in db_name.lower() and os.environ.get("PEP_TESTS_ALLOW_NON_TEST_DB") != "1":
        raise pytest.UsageError(
            f"DATABASE_URL 의 DB 이름 '{db_name}' 에 'test' 가 없다 — 운영/개발 DB 로 보여 테스트를 "
            "중단한다(테스트는 행을 만들고 지운다). 테스트 전용 DB(예: k8s_monitor_test)를 쓰거나, "
            "의도한 것이면 PEP_TESTS_ALLOW_NON_TEST_DB=1 로 우회한다."
        )
