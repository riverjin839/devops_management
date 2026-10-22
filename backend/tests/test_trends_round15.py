"""15차 감사 A-7·A-8·A-9·A-10·A-19 — 기술 동향(/trends) 서버.

- 수집 SSE(`POST /trends/collect/stream`): 소스별 한 줄 · 요약 진행 n/N · 합계 줄 · result=동기 응답 본문
- 다이제스트 락(409 "이미 수집 중입니다") · 30분 넘게 멈춘 collecting/summarizing → failed
- 요약 실패 = summary_ko None + summary_status failed + summary_error, 다음 수집 때 재시도(최대 3회)
- 다이제스트 partial · 수집기 실패는 error+사유(empty 아님)
- URL 전역 중복 제거 · 증분 since(마지막 성공 수집) · 수동 기간 = 백필
- 권한(require_operator·admin 하드 삭제)·감사 · DELETE = 비활성화
- SSRF 가드(스킴·사설 대역·redirect 재검사·허용 호스트) · GitHub slug 422
- 설정 API(토큰 write-only)

네트워크·LLM 은 가짜로 대체한다(실제 DB·Redis 사용).
"""
import asyncio
import json
import os
import uuid
from datetime import date, datetime, timedelta

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test")
os.environ.setdefault("REDIS_URL", "redis://localhost:6379/0")

import httpx  # noqa: E402

from app.database import Base, SessionLocal, engine  # noqa: E402
from app.models.app_setting import AppSetting  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.trend import TrendDigest, TrendItem, TrendSource  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.trends import summarizer, trend_settings, url_guard  # noqa: E402
from app.services.trends.base import CollectedItem, TrendCollectError  # noqa: E402
from app.services.trends.collect_lock import collect_lock  # noqa: E402
from app.services.trends.github_collector import GitHubReleaseCollector  # noqa: E402
from app.services.trends.rss_collector import RSSCollector  # noqa: E402
from app.services.trends.summarizer import SummaryResult  # noqa: E402
from app.services.trends.trend_service import TrendService  # noqa: E402

D1 = date(2031, 3, 1)
D2 = date(2031, 3, 2)


# ── fixtures ───────────────────────────────────────────────────────────────

def _wipe(db):
    db.query(TrendItem).delete(synchronize_session=False)
    db.query(TrendDigest).delete(synchronize_session=False)
    db.query(TrendSource).delete(synchronize_session=False)
    db.query(AppSetting).filter(AppSetting.key == trend_settings.SETTINGS_KEY).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def db():
    from app.main import _ensure_pgvector_extension
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    s = SessionLocal()
    _wipe(s)
    for d in (D1, D2, date.today()):
        collect_lock.release(d, "x")  # 토큰 불일치면 no-op
        r = collect_lock._r()
        if r is not None:
            r.delete(collect_lock.key(d))
    yield s
    s.rollback()
    _wipe(s)
    s.close()


@pytest.fixture
def users(db):
    tag = uuid.uuid4().hex[:8]
    out = {
        "admin": User(username=f"tr-admin-{tag}", hashed_password="x", role="admin"),
        "op": User(username=f"tr-op-{tag}", hashed_password="x", role="operator"),
        "viewer": User(username=f"tr-viewer-{tag}", hashed_password="x", role="viewer"),
    }
    db.add_all(out.values())
    db.commit()
    yield out
    ids = [str(u.id) for u in out.values()]
    db.query(AuditLog).filter(AuditLog.actor_user_id.in_(ids)).delete(synchronize_session=False)
    db.query(User).filter(User.id.in_([u.id for u in out.values()])).delete(synchronize_session=False)
    db.commit()


@pytest.fixture
def client_as():
    from fastapi.testclient import TestClient

    from app.auth.deps import get_current_user
    from app.main import app

    def _as(user):
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app)

    try:
        yield _as
    finally:
        app.dependency_overrides.pop(get_current_user, None)


class FakeFeeds:
    """URL → 항목 목록 또는 예외. collect 호출 기록(since 포함)."""

    def __init__(self):
        self.data: dict[str, object] = {}
        self.calls: list[tuple[str, datetime]] = []

    def install(self, monkeypatch):
        feeds = self

        async def gh(self_, url, since):
            feeds.calls.append((url, since))
            v = feeds.data.get(url, [])
            if isinstance(v, Exception):
                raise v
            return list(v)

        async def rss(self_, url, since, item_type=None):
            feeds.calls.append((url, since))
            v = feeds.data.get(url, [])
            if isinstance(v, Exception):
                raise v
            return [CollectedItem(**{**c.__dict__, "item_type": item_type or c.item_type}) for c in v]

        monkeypatch.setattr(GitHubReleaseCollector, "collect", gh)
        monkeypatch.setattr(RSSCollector, "collect", rss)
        return self


def _ci(url, title="t", item_type="blog", days_ago=1):
    return CollectedItem(source_name="x", source_type="rss", category="k8s", item_type=item_type,
                         title=title, url=url, published_at=datetime.utcnow() - timedelta(days=days_ago),
                         raw_content="body", version=None)


def _summ(monkeypatch, *, fail_titles=(), fail_all=False, digest_ok=True):
    calls = []

    async def item(title, content):
        calls.append(title)
        if fail_all or title in fail_titles:
            return SummaryResult(None, "LLM 요약 실패 — offline")
        return SummaryResult(f"요약:{title}")

    async def dig(d, items):
        return SummaryResult("종합") if digest_ok else SummaryResult(None, "LLM 요약 실패 — offline")

    monkeypatch.setattr(summarizer, "summarize_item", item)
    monkeypatch.setattr(summarizer, "summarize_digest", dig)
    return calls


def _src(db, name, url, *, source_type="rss", category="k8s", item_type=None, **kw):
    s = TrendSource(name=name, source_type=source_type, url=url, category=category, item_type=item_type, **kw)
    db.add(s)
    db.commit()
    return s


def _events(text):
    out = []
    for block in text.split("\n\n"):
        for ln in block.splitlines():
            if ln.startswith("data:"):
                out.append(json.loads(ln[5:].strip()))
    return out


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ── SSE 수집 ───────────────────────────────────────────────────────────────

def test_collect_stream_emits_source_lines_progress_total_and_result(db, users, client_as, monkeypatch):
    feeds = FakeFeeds().install(monkeypatch)
    _src(db, "Alpha", "https://a.example/feed")
    _src(db, "Beta", "https://b.example/feed")
    feeds.data["https://a.example/feed"] = [_ci("https://a.example/1", "A1"), _ci("https://a.example/2", "A2")]
    feeds.data["https://b.example/feed"] = TrendCollectError("HTTP 503 Service Unavailable — https://b.example/feed")
    _summ(monkeypatch, fail_titles=("A2",))

    res = client_as(users["op"]).post("/api/v1/trends/collect/stream",
                                      json={"target_date": D1.isoformat(), "lookback_days": 30})
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/event-stream")
    evts = _events(res.text)
    assert "error" not in [e["type"] for e in evts], evts
    logs = [e["message"] for e in evts if e["type"] == "log"]
    assert "Alpha · 신규 2" in logs
    assert any(m.startswith("Beta · 신규 0 · HTTP 503") for m in logs)
    assert any(m.startswith("요약 1/2 · ") for m in logs) and any(m.startswith("요약 2/2 · ") for m in logs)
    assert any(m.startswith("요약 ") and " · A2 · 실패: LLM 요약 실패" in m for m in logs)
    assert logs[-1].startswith("합계 · 소스 성공 1/2 · 신규 2건 · 요약 성공 1 · 요약 실패 1 · 상태 partial")
    steps = {(e["name"], e["status"]) for e in evts if e["type"] == "step"}
    assert {("collect", "running"), ("collect", "failed"), ("summarize", "failed"), ("digest", "done")} <= steps

    result = evts[-1]
    assert result["type"] == "result"
    body = result["result"]
    assert body["status"] == "partial"
    assert body["item_count"] == 2
    assert body["summary_ok"] == 1 and body["summary_failed"] == 1
    assert "소스 실패 1/2" in body["error_message"]
    run = body["run"]
    assert run["mode"] == "backfill" and run["source_failed"] == 1 and run["new_items"] == 2
    assert {s["name"]: s["status"] for s in run["sources"]} == {"Alpha": "ok", "Beta": "error"}
    # 락은 끝나면 풀린다
    assert not collect_lock.is_held(D1)
    # 감사
    db.expire_all()
    assert db.query(AuditLog).filter(AuditLog.action == "trends.collect",
                                     AuditLog.actor_user_id == str(users["op"].id)).count() == 1


def test_collect_returns_409_while_locked_and_viewer_403(db, users, client_as, monkeypatch):
    FakeFeeds().install(monkeypatch)
    _summ(monkeypatch)
    token = collect_lock.acquire(D1)
    try:
        c = client_as(users["op"])
        r1 = c.post("/api/v1/trends/collect/stream", json={"target_date": D1.isoformat()})
        assert r1.status_code == 409 and r1.json()["detail"] == "이미 수집 중입니다"
        r2 = c.post("/api/v1/trends/collect", params={"target_date": D1.isoformat()})
        assert r2.status_code == 409
    finally:
        collect_lock.release(D1, token)
    assert client_as(users["viewer"]).post("/api/v1/trends/collect/stream", json={}).status_code == 403
    assert client_as(users["viewer"]).post("/api/v1/trends/collect").status_code == 403


def test_sync_collect_still_works(db, users, client_as, monkeypatch):
    feeds = FakeFeeds().install(monkeypatch)
    _src(db, "Alpha", "https://a.example/feed")
    feeds.data["https://a.example/feed"] = [_ci("https://a.example/1", "A1")]
    _summ(monkeypatch)
    r = client_as(users["op"]).post("/api/v1/trends/collect", params={"target_date": D1.isoformat()})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "done" and body["item_count"] == 1 and body["run"]["mode"] == "incremental"
    items = client_as(users["viewer"]).get(f"/api/v1/trends/items/{D1.isoformat()}").json()
    assert items[0]["summary_status"] == "ok" and items[0]["summary_ko"] == "요약:A1"
    assert items[0]["summary_error"] is None


def test_stale_running_digest_marked_failed_on_read(db, users, client_as):
    old = datetime.utcnow() - timedelta(minutes=45)
    db.add(TrendDigest(digest_date=D1, status="collecting", created_at=old, updated_at=old))
    db.add(TrendDigest(digest_date=D2, status="summarizing", created_at=datetime.utcnow(),
                       updated_at=datetime.utcnow()))
    db.commit()
    # updated_at onupdate 우회 — 직접 과거로
    db.query(TrendDigest).filter(TrendDigest.digest_date == D1).update({"updated_at": old})
    db.commit()
    rows = {d["digest_date"]: d for d in client_as(users["viewer"]).get("/api/v1/trends/digests").json()}
    assert rows[D1.isoformat()]["status"] == "failed"
    assert "30분" in rows[D1.isoformat()]["error_message"]
    assert rows[D2.isoformat()]["status"] == "summarizing"  # 최근 진행 — 그대로


def test_stale_digest_with_live_lock_is_not_failed(db):
    old = datetime.utcnow() - timedelta(minutes=45)
    db.add(TrendDigest(digest_date=D1, status="collecting"))
    db.commit()
    db.query(TrendDigest).filter(TrendDigest.digest_date == D1).update({"updated_at": old})
    db.commit()
    token = collect_lock.acquire(D1)
    try:
        assert TrendService(db).recover_stale() == 0
    finally:
        collect_lock.release(D1, token)
    assert TrendService(db).recover_stale() == 1


# ── 요약 실패·재시도 ────────────────────────────────────────────────────────

def test_summary_failure_stored_as_none_and_retried_up_to_three(db, monkeypatch):
    feeds = FakeFeeds().install(monkeypatch)
    _src(db, "Alpha", "https://a.example/feed")
    feeds.data["https://a.example/feed"] = [_ci("https://a.example/1", "A1")]
    calls = _summ(monkeypatch, fail_all=True, digest_ok=False)

    d = _run(TrendService(db).run_daily_collect(D1))
    assert d.status == "partial"
    assert d.overall_summary_ko is None and "종합 요약 실패" in d.error_message
    item = db.query(TrendItem).one()
    assert item.summary_ko is None and item.summary_status == "failed"
    assert "offline" in item.summary_error and item.summary_attempts == 1

    # 다음 수집(다른 날짜)에도 재시도 — 3회에서 멈춘다
    _run(TrendService(db).run_daily_collect(D2))
    _run(TrendService(db).run_daily_collect(D2))
    _run(TrendService(db).run_daily_collect(D2))
    db.expire_all()
    item = db.query(TrendItem).one()
    assert item.summary_attempts == 3
    assert calls.count("A1") == 3

    # LLM 복구 뒤에는 한도 안의 항목만 재요약 — 여기선 한도 도달이라 그대로
    _summ(monkeypatch)
    _run(TrendService(db).run_daily_collect(D2))
    db.expire_all()
    assert db.query(TrendItem).one().summary_status == "failed"


def test_summary_recovers_on_retry(db, monkeypatch):
    feeds = FakeFeeds().install(monkeypatch)
    _src(db, "Alpha", "https://a.example/feed")
    feeds.data["https://a.example/feed"] = [_ci("https://a.example/1", "A1")]
    _summ(monkeypatch, fail_all=True)
    _run(TrendService(db).run_daily_collect(D1))
    _summ(monkeypatch)
    d2 = _run(TrendService(db).run_daily_collect(D2))
    db.expire_all()
    item = db.query(TrendItem).one()
    assert item.summary_status == "ok" and item.summary_ko == "요약:A1" and item.summary_error is None
    assert item.summary_attempts == 2
    assert d2.status == "done"


def test_all_sources_failed_marks_digest_failed_and_source_error(db, monkeypatch):
    feeds = FakeFeeds().install(monkeypatch)
    s = _src(db, "Alpha", "https://a.example/feed")
    feeds.data["https://a.example/feed"] = TrendCollectError("DNS 조회 실패(a.example) — nodename")
    _summ(monkeypatch)
    d = _run(TrendService(db).run_daily_collect(D1))
    assert d.status == "failed"
    db.refresh(s)
    assert s.last_status == "error" and s.last_message.startswith("DNS 조회 실패")
    assert s.last_success_at is None


# ── 중복 제거·증분 ─────────────────────────────────────────────────────────

def test_global_url_dedup_and_incremental_since(db, monkeypatch):
    feeds = FakeFeeds().install(monkeypatch)
    s = _src(db, "Alpha", "https://a.example/feed")
    feeds.data["https://a.example/feed"] = [_ci("https://a.example/1", "A1"), _ci("https://a.example/1", "dup")]
    _summ(monkeypatch)
    d1 = _run(TrendService(db).run_daily_collect(D1))
    assert d1.item_count == 1
    # 첫 수집은 90일 되돌아본다
    assert feeds.calls[-1][1] == datetime.combine(D1 - timedelta(days=90), datetime.min.time())

    feeds.data["https://a.example/feed"] = [_ci("https://a.example/1", "A1"), _ci("https://a.example/2", "A2")]
    d2 = _run(TrendService(db).run_daily_collect(D2))
    db.refresh(s)
    assert d2.item_count == 1  # 새로 발견된 A2 만
    assert {i.url for i in db.query(TrendItem).filter(TrendItem.digest_date == D2)} == {"https://a.example/2"}
    assert db.query(TrendItem).filter(TrendItem.url == "https://a.example/1").count() == 1
    # 증분: 마지막 성공 수집 시각 - 1일
    since2 = feeds.calls[-1][1]
    assert since2 > datetime.utcnow() - timedelta(days=2)

    # 수동 기간 = 백필
    _run(TrendService(db).run_daily_collect(D2, lookback_days=7))
    assert feeds.calls[-1][1] == datetime.combine(D2 - timedelta(days=7), datetime.min.time())


def test_unique_url_index_exists(db):
    from sqlalchemy import text
    with engine.connect() as c:
        assert c.execute(text("SELECT to_regclass('uq_trend_items_url') IS NOT NULL")).scalar() is True


# ── 소스 CRUD·권한·감사 ───────────────────────────────────────────────────

def test_source_crud_requires_operator_and_audits(db, users, client_as):
    body = {"name": "Istio 블로그", "source_type": "rss", "url": "https://istio.io/latest/blog/feed.xml",
            "category": "istio"}
    assert client_as(users["viewer"]).post("/api/v1/trends/sources", json=body).status_code == 403
    op = client_as(users["op"])
    r = op.post("/api/v1/trends/sources", json=body)
    assert r.status_code == 201, r.text
    src = r.json()
    assert src["item_type"] == "blog" and src["enabled"] is True
    sid = src["id"]

    r = op.put(f"/api/v1/trends/sources/{sid}", json={"item_type": "news"})
    assert r.status_code == 200 and r.json()["item_type"] == "news"
    assert client_as(users["viewer"]).patch(f"/api/v1/trends/sources/{sid}", json={"enabled": False}).status_code == 403
    op = client_as(users["op"])  # dependency override 는 전역 — 다시 operator 로
    rp = op.patch(f"/api/v1/trends/sources/{sid}", json={"enabled": False})
    assert rp.status_code == 200, rp.text
    assert rp.json()["enabled"] is False

    actions = {a.action for a in db.query(AuditLog).filter(AuditLog.actor_user_id == str(users["op"].id))}
    assert {"trends.source.create", "trends.source.update"} <= actions


def test_delete_deactivates_and_hard_delete_is_admin_only(db, users, client_as):
    s = _src(db, "Alpha", "https://a.example/feed")
    sid = s.id
    db.add(TrendItem(source_id=sid, title="t", url="https://a.example/1", published_at=datetime.utcnow(),
                     item_type="blog", digest_date=D1))
    db.commit()
    op = client_as(users["op"])
    assert op.delete(f"/api/v1/trends/sources/{s.id}").status_code == 204
    db.expire_all()
    assert db.query(TrendSource).filter(TrendSource.id == s.id).one().enabled is False
    assert db.query(TrendItem).count() == 1  # 과거 항목 보존

    r = op.delete(f"/api/v1/trends/sources/{s.id}", params={"hard": "true"})
    assert r.status_code == 403
    assert client_as(users["admin"]).delete(f"/api/v1/trends/sources/{s.id}",
                                            params={"hard": "true"}).status_code == 204
    db.expire_all()
    assert db.query(TrendSource).filter(TrendSource.id == sid).count() == 0
    assert db.query(TrendItem).count() == 0
    modes = [a.details.get("mode") for a in db.query(AuditLog).filter(AuditLog.action == "trends.source.delete",
                                                                      AuditLog.actor_user_id.in_(
                                                                          [str(users["op"].id),
                                                                           str(users["admin"].id)]))]
    assert sorted(modes) == ["deactivate", "hard"]


@pytest.mark.parametrize("slug", ["kubernetes", "a/b/c", "../..", "a/..", "owner/re po", "https://x/y"])
def test_github_slug_validation_422(db, users, client_as, slug):
    r = client_as(users["op"]).post("/api/v1/trends/sources", json={
        "name": "x", "source_type": "github_release", "url": slug, "category": "k8s"})
    assert r.status_code == 422, (slug, r.text)


@pytest.mark.parametrize("url", [
    "file:///etc/passwd", "gopher://a.example/", "http://127.0.0.1/feed", "http://169.254.169.254/latest/",
    "http://10.0.0.5/rss", "http://localhost:8000/x", "http://[::1]/x", "http://192.168.1.10/rss",
])
def test_internal_feed_urls_rejected_422(db, users, client_as, url):
    r = client_as(users["op"]).post("/api/v1/trends/sources", json={
        "name": "x", "source_type": "rss", "url": url, "category": "k8s"})
    assert r.status_code == 422, (url, r.text)


def test_allowed_hosts_exempt_internal_feed(db, users, client_as):
    trend_settings.update(db, allowed_hosts=["10.0.0.0/8", "mirror.internal"])
    op = client_as(users["op"])
    assert op.post("/api/v1/trends/sources", json={
        "name": "m", "source_type": "rss", "url": "http://10.0.0.5/rss", "category": "k8s"}).status_code == 201


# ── SSRF 가드(수집 시점) ───────────────────────────────────────────────────

def _transport(handler, monkeypatch):
    monkeypatch.setattr(url_guard, "_TRANSPORT", httpx.MockTransport(handler))


def test_dns_resolving_to_private_is_blocked(monkeypatch):
    async def fake_resolve(host, port):
        return ["10.1.2.3"]
    monkeypatch.setattr(url_guard, "_resolve", fake_resolve)
    with pytest.raises(url_guard.UrlBlocked):
        _run(url_guard.check_url("https://evil.example/feed"))
    # 허용 호스트면 통과
    _run(url_guard.check_url("https://evil.example/feed", ["*.example"]))
    _run(url_guard.check_url("https://evil.example/feed", ["10.0.0.0/8"]))


def test_redirect_to_metadata_is_rechecked_and_blocked(monkeypatch):
    async def fake_resolve(host, port):
        return ["93.184.216.34"]
    monkeypatch.setattr(url_guard, "_resolve", fake_resolve)

    def handler(req):
        # 연결은 검사한 IP 로 고정되므로 원래 호스트는 Host 헤더로 본다.
        if req.headers.get("host") == "pub.example":
            return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data/"})
        return httpx.Response(200, text="secret")
    _transport(handler, monkeypatch)
    with pytest.raises(url_guard.UrlBlocked):
        _run(url_guard.guarded_get("https://pub.example/feed"))


def test_rss_fetch_error_raises_with_reason(monkeypatch):
    async def fake_resolve(host, port):
        return ["93.184.216.34"]
    monkeypatch.setattr(url_guard, "_resolve", fake_resolve)
    _transport(lambda req: httpx.Response(403), monkeypatch)
    with pytest.raises(TrendCollectError, match="HTTP 403"):
        _run(RSSCollector().collect("https://pub.example/feed", datetime(2020, 1, 1)))


def test_rss_collect_uses_source_item_type(monkeypatch):
    async def fake_resolve(host, port):
        return ["93.184.216.34"]
    monkeypatch.setattr(url_guard, "_resolve", fake_resolve)
    feedparser = pytest.importorskip("feedparser")
    if not hasattr(feedparser, "parse"):
        pytest.skip("feedparser stub")
    xml = ("<?xml version='1.0'?><rss version='2.0'><channel><title>t</title>"
           "<item><title>Hello</title><link>https://pub.example/p/1</link>"
           "<pubDate>Mon, 01 Jan 2029 00:00:00 GMT</pubDate><description>x</description></item>"
           "</channel></rss>")
    _transport(lambda req: httpx.Response(200, text=xml), monkeypatch)
    items = _run(RSSCollector().collect("https://pub.example/feed", datetime(2020, 1, 1), item_type="news"))
    assert len(items) == 1 and items[0].item_type == "news" and items[0].url == "https://pub.example/p/1"


def _public(monkeypatch, addr="93.184.216.34"):
    calls = []

    async def fake_resolve(host, port):
        calls.append(host)
        return [addr]
    monkeypatch.setattr(url_guard, "_resolve", fake_resolve)
    return calls


def test_guarded_get_pins_checked_ip_with_host_header_and_sni(monkeypatch):
    _public(monkeypatch)
    seen = []

    def handler(req):
        seen.append((req.url.scheme, req.url.host, req.url.port, req.headers.get("host"),
                     req.extensions.get("sni_hostname")))
        if len(seen) == 1:
            return httpx.Response(301, headers={"location": "http://pub.example:8080/feed2"})
        return httpx.Response(200, text="ok")
    _transport(handler, monkeypatch)
    r = _run(url_guard.guarded_get("https://pub.example/feed"))
    assert r.text == "ok"
    assert seen[0] == ("https", "93.184.216.34", None, "pub.example", "pub.example")
    # redirect hop 도 다시 해석·고정. http 는 SNI 확장 없음, Host 에 포트 유지
    assert seen[1] == ("http", "93.184.216.34", 8080, "pub.example:8080", None)


def test_guarded_get_resolves_once_per_hop_dns_rebinding(monkeypatch):
    """검사 때 공인 → 이후 사설로 바뀌는 rebinding 이어도, 연결은 검사한 공인 IP 로 간다."""
    answers = iter([["93.184.216.34"], ["127.0.0.1"], ["169.254.169.254"]])
    calls = []

    async def fake_resolve(host, port):
        calls.append(host)
        return next(answers)
    monkeypatch.setattr(url_guard, "_resolve", fake_resolve)
    seen = []
    _transport(lambda req: seen.append(req.url.host) or httpx.Response(200, text="ok"), monkeypatch)
    _run(url_guard.guarded_get("https://rebind.example/feed"))
    assert calls == ["rebind.example"] and seen == ["93.184.216.34"]


def test_guarded_get_pins_ipv6_with_brackets(monkeypatch):
    _public(monkeypatch, "2606:4700::6810:84e5")
    seen = {}

    def handler(req):
        seen["url"], seen["host"] = str(req.url), req.headers.get("host")
        return httpx.Response(200, text="ok")
    _transport(handler, monkeypatch)
    _run(url_guard.guarded_get("https://v6.example/feed"))
    assert seen["url"] == "https://[2606:4700::6810:84e5]/feed" and seen["host"] == "v6.example"


def test_guarded_get_allowed_host_is_exempt_but_still_pinned(monkeypatch):
    _public(monkeypatch, "10.0.0.5")
    seen = []
    _transport(lambda req: seen.append((req.url.host, req.headers.get("host"))) or httpx.Response(200), monkeypatch)
    with pytest.raises(url_guard.UrlBlocked):
        _run(url_guard.guarded_get("https://mirror.example/feed"))
    _run(url_guard.guarded_get("https://mirror.example/feed", allowed_hosts=["*.example"]))
    assert seen == [("10.0.0.5", "mirror.example")]


def test_guarded_get_via_proxy_keeps_unpinned_request(monkeypatch):
    calls = _public(monkeypatch)
    monkeypatch.setattr(url_guard, "_proxy_for", lambda url: True)
    seen = []
    _transport(lambda req: seen.append((req.url.host, req.extensions.get("sni_hostname"))) or httpx.Response(200),
               monkeypatch)
    _run(url_guard.guarded_get("https://pub.example/feed"))
    assert seen == [("pub.example", None)] and calls == ["pub.example"]  # 사전 검사는 그대로


class _ExplodingStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        raise AssertionError("Content-Length 초과면 본문을 읽지 않아야 한다")
        yield b""  # pragma: no cover


def test_guarded_get_rejects_large_content_length_before_reading(monkeypatch):
    _public(monkeypatch)
    _transport(lambda req: httpx.Response(200, headers={"content-length": str(url_guard.MAX_BODY_BYTES + 1)},
                                          stream=_ExplodingStream()), monkeypatch)
    with pytest.raises(TrendCollectError, match="응답이 너무 큽니다"):
        _run(url_guard.guarded_get("https://pub.example/feed"))


def test_guarded_get_aborts_stream_once_cap_exceeded(monkeypatch):
    _public(monkeypatch)
    monkeypatch.setattr(url_guard, "MAX_BODY_BYTES", 10 * 1024)
    produced = []

    async def endless():
        while True:
            produced.append(1)
            yield b"x" * 1024
    _transport(lambda req: httpx.Response(200, content=endless()), monkeypatch)
    with pytest.raises(TrendCollectError, match="응답이 너무 큽니다"):
        _run(url_guard.guarded_get("https://pub.example/feed"))
    assert len(produced) <= 12


def test_guarded_get_cap_counts_decompressed_bytes(monkeypatch):
    import gzip
    _public(monkeypatch)
    monkeypatch.setattr(url_guard, "MAX_BODY_BYTES", 10 * 1024)
    bomb = gzip.compress(b"\0" * (200 * 1024))
    assert len(bomb) < 10 * 1024
    _transport(lambda req: httpx.Response(200, headers={"content-encoding": "gzip"}, content=bomb), monkeypatch)
    with pytest.raises(TrendCollectError, match="응답이 너무 큽니다"):
        _run(url_guard.guarded_get("https://pub.example/feed"))
    # 상한 이내 gzip 본문은 해제된 텍스트로 돌려준다
    small = gzip.compress("안녕 feed".encode())
    _transport(lambda req: httpx.Response(200, headers={"content-encoding": "gzip",
                                                        "content-type": "text/xml; charset=utf-8"},
                                          content=small), monkeypatch)
    assert _run(url_guard.guarded_get("https://pub.example/feed")).text == "안녕 feed"


def test_rss_drops_items_with_non_http_links(monkeypatch):
    _public(monkeypatch)
    feedparser = pytest.importorskip("feedparser")
    if not hasattr(feedparser, "parse"):
        pytest.skip("feedparser stub")

    def item(link):
        return (f"<item><title>{link}</title><link>{link}</link>"
                "<pubDate>Mon, 01 Jan 2029 00:00:00 GMT</pubDate><description>x</description></item>")
    xml = ("<?xml version='1.0'?><rss version='2.0'><channel><title>t</title>"
           + item("javascript:alert(1)") + item("data:text/html,x") + item("/relative/path")
           + item("ftp://pub.example/f") + item("https://pub.example/ok") + item("http://pub.example/ok2")
           + "</channel></rss>")
    _transport(lambda req: httpx.Response(200, text=xml), monkeypatch)
    items = _run(RSSCollector().collect("https://pub.example/feed", datetime(2020, 1, 1)))
    assert [i.url for i in items] == ["https://pub.example/ok", "http://pub.example/ok2"]


def test_github_rate_limit_raises_reason(monkeypatch):
    _transport(lambda req: httpx.Response(403, headers={"x-ratelimit-remaining": "0"},
                                          json={"message": "API rate limit exceeded"}), monkeypatch)
    with pytest.raises(TrendCollectError, match="레이트 리밋"):
        _run(GitHubReleaseCollector(api_url="https://api.github.com", token=None).collect(
            "kubernetes/kubernetes", datetime(2020, 1, 1)))


def test_github_uses_settings_api_url_and_token(db, monkeypatch):
    seen = {}

    def handler(req):
        seen["url"] = str(req.url)
        seen["auth"] = req.headers.get("authorization")
        return httpx.Response(200, json=[{"tag_name": "v1.0.0", "html_url": "https://ghe.corp/o/r/releases/v1",
                                          "published_at": "2030-01-01T00:00:00Z", "body": "b"}])
    _transport(handler, monkeypatch)
    trend_settings.update(db, github_api_url="https://ghe.corp/api/v3/", github_token="s3cret")
    svc = TrendService(db)
    items = _run(svc._github.collect("o/r", datetime(2020, 1, 1)))
    assert seen["url"].startswith("https://ghe.corp/api/v3/repos/o/r/releases")
    assert seen["auth"] == "Bearer s3cret"
    assert items[0].version == "v1.0.0"


# ── 설정 API ───────────────────────────────────────────────────────────────

def test_settings_api_token_write_only(db, users, client_as):
    v = client_as(users["viewer"]).get("/api/v1/trends/settings").json()
    assert set(v) >= {"github_api_url", "allowed_hosts", "token_set"}
    assert v["allowed_hosts"] == []

    body = {"github_api_url": "https://ghe.corp/api/v3", "allowed_hosts": ["Mirror.Internal", "10.0.0.0/8"],
            "github_token": "tok-123"}
    assert client_as(users["op"]).put("/api/v1/trends/settings", json=body).status_code == 403
    r = client_as(users["admin"]).put("/api/v1/trends/settings", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["token_set"] is True and out["token_source"] == "app_setting"
    assert out["allowed_hosts"] == ["mirror.internal", "10.0.0.0/8"]
    assert "tok-123" not in r.text and "github_token" not in out

    row = db.query(AppSetting).filter(AppSetting.key == trend_settings.SETTINGS_KEY).one()
    assert "tok-123" not in json.dumps(row.value)
    assert trend_settings.effective(db)["github_token"] == "tok-123"
    got = client_as(users["viewer"]).get("/api/v1/trends/settings")
    assert "tok-123" not in got.text and got.json()["github_api_url"] == "https://ghe.corp/api/v3"

    # 토큰 삭제
    r = client_as(users["admin"]).put("/api/v1/trends/settings", json={"github_token": ""})
    assert r.json()["token_source"] in (None, "env")
    audit = db.query(AuditLog).filter(AuditLog.action == "trends.settings.update",
                                      AuditLog.actor_user_id == str(users["admin"].id)).all()
    assert audit and all("tok-123" not in json.dumps(a.details) for a in audit)


@pytest.mark.parametrize("body", [{"github_api_url": "ftp://x"}, {"allowed_hosts": ["bad host!"]}])
def test_settings_validation_422(db, users, client_as, body):
    assert client_as(users["admin"]).put("/api/v1/trends/settings", json=body).status_code == 422


# ── beat ───────────────────────────────────────────────────────────────────

def test_beat_task_skips_when_locked(db, monkeypatch):
    from app.celery_app import run_trend_collect
    token = collect_lock.acquire(date.today())
    try:
        out = run_trend_collect.run()
    finally:
        collect_lock.release(date.today(), token)
    assert out["status"] == "skipped"


def test_beat_task_runs_incremental(db, monkeypatch):
    from app.celery_app import run_trend_collect
    feeds = FakeFeeds().install(monkeypatch)
    _src(db, "Alpha", "https://a.example/feed")
    feeds.data["https://a.example/feed"] = [_ci("https://a.example/9", "A9")]
    _summ(monkeypatch)
    out = run_trend_collect.run()
    assert out["status"] == "done" and out["item_count"] == 1
    assert not collect_lock.is_held(date.today())
