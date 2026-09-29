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
