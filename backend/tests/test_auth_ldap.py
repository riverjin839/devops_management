"""R-7 사내 디렉터리(LDAP/AD) 로그인 — 가짜 ldap3(메모리 디렉터리)로 ``POST /auth/login`` 전체 흐름을 태운다.

가짜 디렉터리는 실제 서버처럼 "DN + 빈 비밀번호" 바인드를 **성공**으로 응답한다(unauthenticated bind) —
서비스가 그런 바인드를 서버에 보내지 않는지 확인하기 위해서다. 필터는 escape 되지 않은 ``*`` 를
와일드카드로 해석해 인젝션이 실제로 위험한 조건을 흉내 낸다. 로그인 레이트리밋은 기록만 하는 가짜로 바꾼다.
"""
import os
import re
import socket
import uuid
from types import SimpleNamespace

import pytest

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/k8s_monitor_test",
)

from fastapi.testclient import TestClient  # noqa: E402

from app.auth.security import create_access_token, hash_password  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import _ensure_pgvector_extension, _run_migrations, app  # noqa: E402
from app.models.app_setting import AppSetting  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.user_setting import UserSetting  # noqa: E402
from app.services import backup_service, login_rate_limiter  # noqa: E402
from app.services import ldap_service as ldap  # noqa: E402

BASE_DN = "ou=people,dc=corp,dc=test"
SVC_DN = "cn=svc-pep,ou=service,dc=corp,dc=test"
SVC_PW = "svc-Secret-never-leak"
USER_PW = "Dir3ctory-pw!"
GROUP_OK = "CN=PEP-Users,OU=Groups,DC=corp,DC=test"


# ── 가짜 ldap3 ───────────────────────────────────────────────────────────


class FakeLDAPException(Exception):
    pass


class FakeSocketOpenError(FakeLDAPException):
    pass


def _unescape(v: str) -> str:
    return re.sub(r"\\([0-9a-fA-F]{2})", lambda m: chr(int(m.group(1), 16)), v)


class FakeDirectory:
    def __init__(self) -> None:
        self.entries: dict[str, dict] = {}
        self.unreachable: set[str] = set()
        self.binds: list[str | None] = []  # 바인드 이름만(비밀번호는 기록하지 않는다)
        self.searches: list[tuple[str, str]] = []
        self.servers: list[dict] = []
        self.add(SVC_DN, SVC_PW, {"cn": ["svc-pep"]})

    def add(self, dn: str, password: str, attrs: dict) -> None:
        self.entries[dn] = {"password": password, "attributes": attrs}

    def add_user(self, uid: str, *, password: str = USER_PW, groups: list[str] | None = None,
                 mail: str | None = None) -> str:
        dn = f"uid={uid},{BASE_DN}"
        self.add(dn, password, {
            "uid": [uid], "displayName": [f"디렉터리 {uid}"], "mail": [mail or f"{uid}@corp.test"],
            "memberOf": groups if groups is not None else [GROUP_OK],
            "userPrincipalName": [f"{uid}@corp.test"],
        })
        return dn

    def _resolve(self, name: str) -> str | None:
        # 실서버처럼 DN·UPN 은 대소문자를 가리지 않는다.
        for dn, e in self.entries.items():
            if dn.lower() == name.lower():
                return dn
            if name.lower() in [v.lower() for v in e["attributes"].get("userPrincipalName") or []]:
                return dn
        return None

    def match(self, flt: str) -> list[str]:
        m = re.fullmatch(r"\((\w+)=(.*)\)", flt)
        if not m:
            return []
        attr, raw = m.group(1), m.group(2)
        if attr == "objectClass" and raw == "*":
            return list(self.entries)
        # escape 되지 않은 '*' 는 와일드카드(실서버와 같다) — 인젝션이 되면 전부 걸린다.
        pattern = "^" + ".*".join(re.escape(_unescape(p)) for p in raw.split("*")) + "$"
        out = []
        for dn, e in self.entries.items():
            if any(re.match(pattern, str(v), re.IGNORECASE) for v in e["attributes"].get(attr, [])):
                out.append(dn)
        return out

    def lib(self) -> SimpleNamespace:
        from ldap3.utils.conv import escape_filter_chars
        from ldap3.utils.dn import escape_rdn

        directory = self

        class Server:
            def __init__(self, host, port=None, use_ssl=False, tls=None, get_info=None, connect_timeout=None):
                self.host, self.port, self.use_ssl, self.tls = host, port, use_ssl, tls
                directory.servers.append({"host": host, "port": port, "use_ssl": use_ssl,
                                          "tls": tls, "timeout": connect_timeout})

        class Connection:
            def __init__(self, server, user=None, password=None, authentication=None, **kw):
                self.server, self.user, self.password = server, user, password
                self.kw = kw
                self.response: list = []
                self.result: dict = {}

            def open(self):
                if self.server.host in directory.unreachable:
                    raise FakeSocketOpenError("socket connection error while opening: [Errno 111] refused")

            def start_tls(self):
                return True

            def bind(self):
                directory.binds.append(self.user)
                if self.user is None:
                    return True  # 익명
                dn = directory._resolve(self.user)
                if self.password == "" and dn:
                    return True  # unauthenticated bind — 실서버처럼 "성공"
                if dn and directory.entries[dn]["password"] == self.password:
                    return True
                self.result = {"result": 49, "description": "invalidCredentials",
                               "message": "80090308: LdapErr: DSID-0C09044E, data 52e, v4563"}
                return False

            def search(self, search_base, search_filter, search_scope=None, attributes=None, size_limit=0):
                directory.searches.append((search_base, search_filter))
                if search_scope == "BASE":
                    dns = [search_base] if search_base in directory.entries else []
                else:
                    dns = [d for d in directory.match(search_filter) if d.endswith(search_base)]
                self.response = [{"type": "searchResEntry", "dn": d,
                                  "attributes": directory.entries[d]["attributes"]} for d in dns]
                self.result = {"result": 0}
                return bool(dns)

            def unbind(self):
                return True

        return SimpleNamespace(
            Server=Server, Connection=Connection, Tls=lambda **kw: SimpleNamespace(**kw),
            SIMPLE="SIMPLE", ANONYMOUS="ANONYMOUS", SUBTREE="SUBTREE", BASE="BASE", NO_INFO="NO_INFO",
            LDAPException=FakeLDAPException, escape_filter_chars=escape_filter_chars, escape_rdn=escape_rdn,
        )


# ── fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture(scope="module", autouse=True)
def _ensure_schema():
    _ensure_pgvector_extension()
    Base.metadata.create_all(bind=engine)
    _run_migrations()
    yield


@pytest.fixture
def db():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def directory(monkeypatch):
    d = FakeDirectory()
    monkeypatch.setattr(ldap, "_ldap3", d.lib)
    return d


@pytest.fixture
def rate(monkeypatch):
    calls: dict[str, list] = {"failure": [], "success": [], "ip_failure": [], "checked": []}
    monkeypatch.setattr(login_rate_limiter, "check_login_allowed",
                        lambda ip, u: (calls["checked"].append(u), (True, None))[1])
    monkeypatch.setattr(login_rate_limiter, "record_failure", lambda ip, u: calls["failure"].append(u))
    monkeypatch.setattr(login_rate_limiter, "record_ip_failure", lambda ip: calls["ip_failure"].append(ip))
    monkeypatch.setattr(login_rate_limiter, "record_success", lambda ip, u: calls["success"].append(u))
    return calls


def _write_cfg(db, **over):
    cfg = dict(ldap.DEFAULTS)
    cfg.update({
        "enabled": True,
        "server_urls": ["ldap://ldap.corp.test"],
        "start_tls": True,
        "bind_mode": "direct",
        "bind_dn_template": f"uid={{username}},{BASE_DN}",
        "user_search_base": BASE_DN,
        "user_search_filter": "(uid={username})",
        "service_bind_dn": SVC_DN,
        "bind_password_encrypted": ldap.secret_box.encrypt(SVC_PW),
    })
    cfg.update(over)
    row = db.query(AppSetting).filter(AppSetting.key == ldap.SETTING_KEY).first()
    if row is None:
        db.add(AppSetting(key=ldap.SETTING_KEY, value=cfg))
    else:
        row.value = cfg
    db.commit()
    return cfg


@pytest.fixture
def ldap_cfg(db):
    """auth.ldap 설정을 테스트 값으로 바꾸고 끝나면 원래대로 되돌린다."""
    row = db.query(AppSetting).filter(AppSetting.key == ldap.SETTING_KEY).first()
    original = dict(row.value) if row is not None else None
    _write_cfg(db)
    yield lambda **over: _write_cfg(db, **over)
    db.rollback()
    row = db.query(AppSetting).filter(AppSetting.key == ldap.SETTING_KEY).first()
    if original is None:
        if row is not None:
            db.delete(row)
    else:
        row.value = original
    db.commit()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def users(db):
    names: list[str] = []
    yield names
    db.rollback()
    ids = [u.id for u in db.query(User).filter(User.username.in_(names)).all()]
    if ids:
        db.query(UserSetting).filter(UserSetting.user_id.in_(ids)).delete(synchronize_session=False)
    db.query(User).filter(User.username.in_(names)).delete(synchronize_session=False)
    db.commit()


def _name(prefix: str = "ld") -> str:
    return f"{prefix}{uuid.uuid4().hex[:8]}"


def _make_user(db, users, username: str, *, role: str = "operator", active: bool = True,
               password: str | None = None) -> User:
    u = User(username=username, hashed_password=hash_password(password) if password else None,
             role=role, display_name=None, is_active=active)
    db.add(u)
    db.commit()
    db.refresh(u)
    users.append(username)
    return u


def _login(client, username: str, password: str):
    return client.post("/api/v1/auth/login", json={"username": username, "password": password})


def _audits(db, username: str) -> list[AuditLog]:
    db.expire_all()
    return (db.query(AuditLog).filter(AuditLog.actor_username == username)
            .order_by(AuditLog.created_at).all())


def _last_login_audit(db, username: str) -> AuditLog:
    rows = [r for r in _audits(db, username) if r.action.startswith("login.")]
    assert rows, "login audit 없음"
    return rows[-1]


def _user_binds(directory: FakeDirectory) -> list[str]:
    return [b for b in directory.binds if b and b != SVC_DN]


# ── 직접 바인드 / 검색 후 재바인드 ──────────────────────────────────────────


def test_direct_bind_auto_provision(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    users.append(name)
    directory.add_user(name)
    ldap_cfg(auto_provision=True, default_role="operator")
    r = _login(client, name, USER_PW)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["auth_source"] == "ldap"
    assert body["user"]["must_change_password"] is False
    assert body["user"]["role"] == "operator"
    assert _user_binds(directory) == [f"uid={name},{BASE_DN}"]
    assert directory.servers[0]["tls"].validate is not None  # StartTLS — 인증서 검증 객체가 붙는다
    u = db.query(User).filter(User.username == name).first()
    assert u.hashed_password is None and u.display_name == f"디렉터리 {name}" and u.email == f"{name}@corp.test"
    audit = _last_login_audit(db, name)
    assert audit.action == "login.success" and audit.details == {"method": "ldap", "provisioned": True}

    h = {"Authorization": f"Bearer {body['access_token']}"}
    me = client.get("/api/v1/auth/me", headers=h).json()
    assert me["auth_source"] == "ldap"
    assert rate["success"] == [name]


def test_search_then_rebind(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name, role="viewer")
    ldap_cfg(bind_mode="search", bind_dn_template="")
    r = _login(client, name, USER_PW)
    assert r.status_code == 200, r.text
    assert directory.binds[0] == SVC_DN  # 서비스 계정 먼저
    assert _user_binds(directory) == [f"uid={name},{BASE_DN}"]  # 찾은 DN 으로 재바인드
    assert directory.searches == [(BASE_DN, f"(uid={name})")]
    u = db.query(User).filter(User.username == name).first()
    db.refresh(u)
    # 비어 있던 프로필은 디렉터리 값으로 채운다.
    assert u.display_name == f"디렉터리 {name}" and u.email == f"{name}@corp.test"


def test_upn_template(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name)
    ldap_cfg(bind_dn_template="{username}@corp.test")
    assert _login(client, name, USER_PW).status_code == 200
    assert _user_binds(directory) == [f"{name}@corp.test"]
    # UPN 형식에 도메인을 바꾸는 문자는 바인드 전에 거절.
    r = _login(client, f"{name}@evil.test", USER_PW)
    assert r.status_code == 401
    assert _user_binds(directory) == [f"{name}@corp.test"]
    assert _last_login_audit(db, f"{name}@evil.test").details["reason"] == "invalid_username"


def test_failover_to_second_server(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name)
    directory.unreachable.add("ldap1.corp.test")
    ldap_cfg(server_urls=["ldap://ldap1.corp.test", "ldaps://ldap2.corp.test:636"], start_tls=False)
    assert _login(client, name, USER_PW).status_code == 200
    assert [s["host"] for s in directory.servers] == ["ldap1.corp.test", "ldap2.corp.test"]
    assert directory.servers[1]["use_ssl"] is True and directory.servers[1]["port"] == 636


# ── 실패 ─────────────────────────────────────────────────────────────────


def test_wrong_password(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name)
    r = _login(client, name, "wrong-pw-123")
    assert r.status_code == 401
    assert r.json()["detail"] == "잘못된 사용자명 또는 비밀번호입니다."
    audit = _last_login_audit(db, name)
    assert audit.details["method"] == "ldap" and audit.details["reason"] == "invalid_credentials"
    assert "AD: 비밀번호 불일치" in audit.details["detail"]  # AD 하위 코드(52e)는 운영자용 상세로만
    assert "wrong-pw-123" not in str(audit.details)
    assert rate["failure"] == [name]


@pytest.mark.parametrize("password", [" ", "   ", "\x00" + USER_PW])
def test_blank_password_never_sent(client, directory, ldap_cfg, rate, db, users, password):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name)
    r = _login(client, name, password)
    assert r.status_code == 401
    assert _user_binds(directory) == []  # 서버에 바인드 자체를 보내지 않는다
    assert _last_login_audit(db, name).details["reason"] == "empty_password"


def test_empty_password_unit(directory):
    cfg = dict(ldap.DEFAULTS, enabled=True, server_urls=["ldap://ldap.corp.test"],
               bind_dn_template=f"uid={{username}},{BASE_DN}")
    directory.add_user("alice")
    with pytest.raises(ldap.LdapError) as ei:
        ldap.authenticate(cfg, "alice", "")
    assert ei.value.code == "empty_password"
    assert directory.binds == []
    # 같은 조건에서 가짜 서버는 빈 비밀번호를 "성공"으로 답한다 — 가드가 없으면 로그인됐을 것.
    conn = directory.lib().Connection(directory.lib().Server("ldap.corp.test"), user=f"uid=alice,{BASE_DN}",
                                      password="")
    assert conn.bind() is True


def test_filter_injection_escaped(client, directory, ldap_cfg, rate, db, users):
    victim = _name()
    directory.add_user(victim)
    _make_user(db, users, victim)
    ldap_cfg(bind_mode="search", auto_provision=True)
    evil = "*)(uid=*"
    users.append(evil)
    r = _login(client, evil, USER_PW)
    assert r.status_code == 401
    assert directory.searches[-1][1] == r"(uid=\2a\29\28uid=\2a)"
    assert _user_binds(directory) == []
    assert _last_login_audit(db, evil).details["reason"] == "user_not_found"
    # escape 없이 넣었다면 와일드카드로 전부 걸렸을 것 — 가짜 디렉터리가 실제로 위험한 조건인지 확인.
    assert f"uid={victim},{BASE_DN}" in directory.match("(uid=*)")
    assert db.query(User).filter(User.username == evil).first() is None


def test_dn_escape_unit(directory):
    lib = directory.lib()
    cfg = dict(ldap.DEFAULTS, bind_dn_template=f"uid={{username}},{BASE_DN}", user_search_filter="(uid={username})")
    assert ldap.bind_name(lib, cfg, "bob,ou=admins") == rf"uid=bob\,ou\=admins,{BASE_DN}"
    assert ldap.search_filter(lib, cfg, "a*b(c)\\") == r"(uid=a\2ab\28c\29\5c)"
    with pytest.raises(ldap.LdapError):
        ldap.bind_name(lib, cfg, "bad\nname")
    cfg["bind_dn_template"] = "CORP\\{username}"
    with pytest.raises(ldap.LdapError):
        ldap.bind_name(lib, cfg, "x\\administrator")


def test_group_filter(client, directory, ldap_cfg, rate, db, users):
    ok_user, other = _name(), _name()
    directory.add_user(ok_user, groups=["cn=pep-users, ou=groups, dc=corp, dc=test"])  # 대소문자·공백 차이 무시
    directory.add_user(other, groups=["CN=Other,OU=Groups,DC=corp,DC=test"])
    _make_user(db, users, ok_user)
    _make_user(db, users, other)
    ldap_cfg(bind_mode="search", allowed_groups=[GROUP_OK])
    assert _login(client, ok_user, USER_PW).status_code == 200
    r = _login(client, other, USER_PW)
    assert r.status_code == 401
    assert _last_login_audit(db, other).details["reason"] == "group_denied"
    assert rate["failure"] == [other]


def test_group_filter_direct_mode_reads_self(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name, groups=[])
    _make_user(db, users, name)
    ldap_cfg(allowed_groups=[GROUP_OK])
    assert _login(client, name, USER_PW).status_code == 401
    assert directory.searches[-1] == (f"uid={name},{BASE_DN}", "(objectClass=*)")


# ── 계정 매핑 ────────────────────────────────────────────────────────────


def test_auto_provision_off(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    users.append(name)
    directory.add_user(name)
    ldap_cfg(auto_provision=False)
    r = _login(client, name, USER_PW)
    assert r.status_code == 401
    assert _last_login_audit(db, name).details["reason"] == "user_not_provisioned"
    assert db.query(User).filter(User.username == name).first() is None


def test_provision_role_limited(db):
    with pytest.raises(ValueError):
        ldap.merge_config(dict(ldap.DEFAULTS), {"default_role": "admin"})


def test_inactive_user(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name, active=False)
    r = _login(client, name, USER_PW)
    assert r.status_code == 401
    assert _user_binds(directory) == []
    assert _last_login_audit(db, name).details["reason"] == "user_inactive"


def test_case_insensitive_mapping(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name.upper())
    _make_user(db, users, name)
    ldap_cfg(auto_provision=True)
    r = _login(client, name.upper(), USER_PW)
    assert r.status_code == 200, r.text
    assert r.json()["user"]["username"] == name  # 대문자로 새 계정을 만들지 않고 기존 계정에 매핑
    assert db.query(User).filter(User.username == name.upper()).first() is None


def test_local_admin_protected(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name, role="admin", password="local-admin-pw")
    ldap_cfg(priority="ldap_first")
    assert _login(client, name, USER_PW).status_code == 401
    assert _user_binds(directory) == []  # 보호 대상 admin 은 LDAP 를 시도하지 않는다
    # 대소문자만 바꿔 우회하지 못한다.
    assert _login(client, name.upper(), USER_PW).status_code == 401
    # 대소문자 무시로 찾은 계정이 감사 행위자가 된다.
    assert _last_login_audit(db, name).details["reason"] == "local_admin_protected"
    assert _login(client, name, "local-admin-pw").status_code == 200
    ldap_cfg(priority="ldap_first", protect_local_admins=False)
    assert _login(client, name, USER_PW).status_code == 200


# ── 우선순위 ─────────────────────────────────────────────────────────────


def test_local_first_order(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name, password="local-pw-1")
    ldap_cfg(priority="local_first")
    r = _login(client, name, "local-pw-1")
    assert r.status_code == 200
    assert r.json()["user"]["auth_source"] == "local"
    assert _user_binds(directory) == []  # 로컬이 맞으면 LDAP 는 시도하지 않는다
    assert _last_login_audit(db, name).details == {"method": "local"}
    r = _login(client, name, USER_PW)  # 로컬 실패 → LDAP 성공
    # 로컬 비밀번호가 살아 있는 계정은 LDAP 로 들어와도 auth_source 가 local(본인이 비밀번호를 바꿀 수 있게).
    assert r.status_code == 200 and r.json()["user"]["auth_source"] == "local"
    audit = _last_login_audit(db, name)
    assert audit.details["method"] == "ldap"


def test_ldap_first_order(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name, password="local-pw-2")
    ldap_cfg(priority="ldap_first")
    r = _login(client, name, "local-pw-2")  # LDAP 먼저(실패) → 로컬 성공
    assert r.status_code == 200 and r.json()["user"]["auth_source"] == "local"
    assert _user_binds(directory) == [f"uid={name},{BASE_DN}"]
    r = _login(client, name, USER_PW)
    assert r.status_code == 200 and _last_login_audit(db, name).details["method"] == "ldap"
    r = _login(client, name, "nope-nope")
    assert r.status_code == 401
    attempts = _last_login_audit(db, name).details["attempts"]
    assert [a["method"] for a in attempts] == ["ldap", "local"]


def test_passwordless_account_ldap_only(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name, password=None)  # OIDC·LDAP 생성 계정
    ldap_cfg(priority="local_first")
    r = _login(client, name, "local-guess")
    assert r.status_code == 401
    attempts = _last_login_audit(db, name).details["attempts"]
    assert [a["method"] for a in attempts] == ["ldap"]  # 로컬 비밀번호가 없으니 로컬은 시도하지 않는다
    r = _login(client, name, USER_PW)
    assert r.status_code == 200
    assert _last_login_audit(db, name).details["method"] == "ldap"


# ── Fail-safe ────────────────────────────────────────────────────────────


def test_ldap3_missing_local_login_works(client, ldap_cfg, rate, db, users, monkeypatch):
    monkeypatch.setattr(ldap, "_ldap3", lambda: None)
    name, ext = _name(), _name()
    _make_user(db, users, name, password="local-pw-3")
    _make_user(db, users, ext, password=None)
    for prio in ("local_first", "ldap_first"):
        ldap_cfg(priority=prio)
        r = _login(client, name, "local-pw-3")
        assert r.status_code == 200, (prio, r.text)
    r = _login(client, ext, "whatever-pw")
    assert r.status_code == 503
    assert _last_login_audit(db, ext).details["reason"] == "module_missing"
    assert ext not in rate["failure"]  # 인프라 실패는 레이트리밋 실패로 세지 않는다
    assert ldap.module_available() is False


def test_server_unreachable_structured(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    _make_user(db, users, name)
    directory.unreachable.add("ldap.corp.test")
    r = _login(client, name, USER_PW)
    assert r.status_code == 503
    assert "LDAP" in r.json()["detail"]
    assert _last_login_audit(db, name).details["reason"] == "server_unreachable"


def _closed_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def test_real_ldap3_unreachable(client, ldap_cfg, rate, db, users):
    pytest.importorskip("ldap3")
    name = _name()
    _make_user(db, users, name)
    ldap_cfg(server_urls=[f"ldap://127.0.0.1:{_closed_port()}"], timeout_seconds=1, start_tls=False)
    r = _login(client, name, USER_PW)
    assert r.status_code == 503, r.text
    assert _last_login_audit(db, name).details["reason"] == "server_unreachable"
    # 로컬 비밀번호 계정은 디렉터리가 죽어도 로그인된다.
    local = _name()
    _make_user(db, users, local, password="local-pw-4")
    ldap_cfg(server_urls=[f"ldap://127.0.0.1:{_closed_port()}"], timeout_seconds=1, priority="ldap_first")
    assert _login(client, local, "local-pw-4").status_code == 200


def test_disabled_keeps_legacy_login(client, ldap_cfg, rate, db, users):
    ldap_cfg(enabled=False)
    name = _name()
    _make_user(db, users, name, password="local-pw-5")
    assert _login(client, name, "local-pw-5").status_code == 200
    assert _login(client, name, "bad").status_code == 401
    assert _last_login_audit(db, name).details == {"reason": "invalid_credentials"}


def test_audit_never_contains_password(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name, password="local-pw-6")
    ldap_cfg(bind_mode="search")
    for pw in (USER_PW, "local-pw-6", "Wr0ng-Secret-Value"):
        _login(client, name, pw)
    rows = _audits(db, name)
    assert len(rows) >= 3
    text = " ".join(str(r.details) for r in rows)
    for secret in (USER_PW, "local-pw-6", "Wr0ng-Secret-Value", SVC_PW):
        assert secret not in text


# ── 비밀번호 변경 차단 ──────────────────────────────────────────────────────


def test_password_change_blocked_for_ldap(client, directory, ldap_cfg, rate, db, users):
    """로컬 비밀번호가 없는 LDAP 계정 — 비밀번호 변경은 디렉터리에서."""
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name, password=None)
    token = _login(client, name, USER_PW).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/v1/auth/me", headers=h).json()["auth_source"] == "ldap"
    r = client.post("/api/v1/auth/me/password", headers=h,
                    json={"current_password": "x", "new_password": "new-pw-1234"})
    assert r.status_code == 400
    assert "사내 디렉터리" in r.json()["detail"]
    u = db.query(User).filter(User.username == name).first()
    log = (db.query(AuditLog).filter(AuditLog.action == "user.password.change", AuditLog.target_id == u.id)
           .order_by(AuditLog.created_at.desc()).first())
    assert log.details == {"reason": "directory_account"}


def test_local_password_stays_rotatable_after_ldap_login(client, directory, ldap_cfg, rate, db, users):
    """담당자 명부가 발급한 약한 로컬 비밀번호(사번)가 있는 계정 — LDAP 로 로그인한 뒤에도 본인이 바꿀 수 있다."""
    name = _name()
    directory.add_user(name)
    _make_user(db, users, name, password="local-pw-7")
    token = _login(client, name, USER_PW).json()["access_token"]
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/v1/auth/me", headers=h).json()["auth_source"] == "local"
    r = client.post("/api/v1/auth/me/password", headers=h,
                    json={"current_password": "local-pw-7", "new_password": "new-pw-1234"})
    assert r.status_code == 200, r.text


def test_username_whitespace_normalized(client, directory, ldap_cfg, rate, db, users):
    """앞뒤 공백 변형이 계정별 레이트리밋 키·조회를 우회하거나 중복 계정을 만들지 못한다."""
    name = _name()
    users.append(name)
    directory.add_user(name)
    ldap_cfg(auto_provision=True)
    assert _login(client, f"  {name} ", "wrong-pw").status_code == 401
    assert rate["checked"][-1] == name and rate["failure"][-1] == name
    assert _login(client, f"{name}  ", USER_PW).status_code == 200
    assert db.query(User).filter(User.username.like(f"%{name}%")).count() == 1


def test_infra_failure_counts_ip_only(client, directory, ldap_cfg, rate, db, users):
    name = _name()
    _make_user(db, users, name)
    directory.unreachable.add("ldap.corp.test")
    assert _login(client, name, USER_PW).status_code == 503
    assert rate["ip_failure"] and not rate["failure"]


def test_upn_direct_mode_reads_bound_identity(client, directory, ldap_cfg, rate, db, users):
    """UPN 으로 바인드하면 속성·그룹은 그 UPN 의 항목에서 읽는다(검색 필터의 다른 사용자 X)."""
    name = _name()
    directory.add_user(name, groups=[GROUP_OK])
    _make_user(db, users, name)
    ldap_cfg(bind_dn_template="{username}@corp.test", allowed_groups=[GROUP_OK])
    assert _login(client, name, USER_PW).status_code == 200
    assert directory.searches[-1] == (BASE_DN, f"(userPrincipalName={name}@corp.test)")


def test_password_change_blocked_without_local_password(client, db, users):
    name = _name()
    _make_user(db, users, name, password=None)
    h = {"Authorization": f"Bearer {create_access_token(subject=name, role='operator')}"}
    assert client.get("/api/v1/auth/me", headers=h).json()["auth_source"] == "external"
    r = client.post("/api/v1/auth/me/password", headers=h,
                    json={"current_password": "x", "new_password": "new-pw-1234"})
    assert r.status_code == 400


# ── 관리자 설정 ───────────────────────────────────────────────────────────


def _admin_headers(db, users):
    admin = _make_user(db, users, _name("ldadm"), role="admin")
    return {"Authorization": f"Bearer {create_access_token(subject=admin.username, role='admin')}"}


def test_admin_settings_roundtrip(client, directory, ldap_cfg, db, users):
    h = _admin_headers(db, users)
    r = client.get("/api/v1/auth/ldap/settings", headers=h)
    assert r.status_code == 200
    body = r.json()
    assert body["has_bind_password"] is True
    assert "bind_password_encrypted" not in body and "bind_password" not in body
    assert SVC_PW not in r.text and "v1:" not in r.text

    r = client.put("/api/v1/auth/ldap/settings", headers=h, json={
        "bind_password": "new-Svc-pw", "bind_mode": "search",
        "server_urls": ["ldaps://dc1.corp.test:636/", "ldaps://dc1.corp.test:636"],
        "start_tls": False, "allowed_groups": [GROUP_OK, " ", GROUP_OK], "priority": "ldap_first",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["server_urls"] == ["ldaps://dc1.corp.test:636"]
    assert body["allowed_groups"] == [GROUP_OK]
    assert "new-Svc-pw" not in r.text
    assert ldap.bind_password(ldap.load_config(db)) == "new-Svc-pw"
    log = (db.query(AuditLog).filter(AuditLog.action == "settings.ldap.update")
           .order_by(AuditLog.created_at.desc()).first())
    assert log is not None and "new-Svc-pw" not in str(log.details) and "bind_password" in log.details["changed"]

    for bad in ({"default_role": "admin"}, {"server_urls": ["http://x"]}, {"priority": "random"},
                {"start_tls": True}, {"user_search_filter": "uid={username}"},
                {"bind_dn_template": "uid=fixed,dc=x"}, {"timeout_seconds": 0}):
        assert client.put("/api/v1/auth/ldap/settings", headers=h, json=bad).status_code == 400, bad

    r = client.put("/api/v1/auth/ldap/settings", headers=h, json={"clear_bind_password": True, "enabled": False})
    assert r.status_code == 200 and r.json()["has_bind_password"] is False


def test_settings_require_admin(client, ldap_cfg, db, users):
    viewer = _make_user(db, users, _name("ldv"), role="viewer")
    h = {"Authorization": f"Bearer {create_access_token(subject=viewer.username, role='viewer')}"}
    assert client.get("/api/v1/auth/ldap/settings", headers=h).status_code == 403
    assert client.get("/api/v1/auth/ldap/settings").status_code == 401
    assert client.put("/api/v1/auth/ldap/settings", headers=h, json={"enabled": False}).status_code == 403
    assert client.post("/api/v1/auth/ldap/settings/test", headers=h, json={}).status_code == 403


def test_connection_check(client, directory, ldap_cfg, db, users):
    h = _admin_headers(db, users)
    uid = _name()
    directory.add_user(uid)
    ldap_cfg(bind_mode="search")
    r = client.post("/api/v1/auth/ldap/settings/test", headers=h, json={"test_username": uid})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True, body
    assert [s["name"] for s in body["steps"]] == ["connect", "service_bind", "user_search"]
    assert body["user"]["dn"] == f"uid={uid},{BASE_DN}"
    assert _user_binds(directory) == []  # 테스트 사용자는 검색만, 바인드하지 않는다
    assert SVC_PW not in r.text

    # 저장 전 입력값으로 확인 — 저장은 하지 않는다.
    directory.unreachable.add("down.corp.test")
    r = client.post("/api/v1/auth/ldap/settings/test", headers=h,
                    json={"server_urls": ["ldap://down.corp.test"], "start_tls": False})
    body = r.json()
    assert r.status_code == 200 and body["ok"] is False
    assert body["steps"][0]["name"] == "connect" and body["steps"][0]["ok"] is False
    assert any("평문" in w for w in body["warnings"])
    assert ldap.load_config(db)["server_urls"] == ["ldap://ldap.corp.test"]

    r = client.post("/api/v1/auth/ldap/settings/test", headers=h, json={"server_urls": ["ftp://x"]})
    assert r.status_code == 200 and r.json()["steps"][0]["name"] == "config"


def test_connection_check_retarget_needs_password(client, directory, ldap_cfg, db, users):
    """접속 대상을 바꾼 연결 확인에는 저장된 서비스 계정 비밀번호를 싣지 않는다(평문 유출 방지) + 감사."""
    h = _admin_headers(db, users)
    ldap_cfg(bind_mode="search")
    directory.add(f"cn=other,{BASE_DN}", SVC_PW, {"cn": ["other"]})
    r = client.post("/api/v1/auth/ldap/settings/test", headers=h,
                    json={"server_urls": ["ldap://evil.corp.test"], "start_tls": False})
    body = r.json()
    assert r.status_code == 200
    assert SVC_DN not in [b for b in directory.binds if b]  # 저장된 비밀번호로 바인드하지 않았다
    assert any("다시 입력" in w for w in body.get("warnings", []))
    log = (db.query(AuditLog).filter(AuditLog.action == "settings.ldap.test")
           .order_by(AuditLog.created_at.desc()).first())
    assert log is not None and log.details["retargeted"] and SVC_PW not in str(log.details)


def test_backup_masks_bind_password():
    keys = backup_service.SENSITIVE_JSON_KEYS["app_settings"]["value"]
    assert "bind_password_encrypted" in keys and "client_secret_encrypted" in keys
    row = {"key": "auth.ldap", "value": {"bind_password_encrypted": "v1:abc", "server_urls": ["ldap://x"]}}
    masked = backup_service._mask_sensitive("app_settings", row, include_sensitive=False)
    assert masked["value"]["bind_password_encrypted"] != "v1:abc"
    assert masked["value"]["server_urls"] == ["ldap://x"]


def test_real_ldap3_mock_strategy(monkeypatch):
    """실제 ldap3 코드 경로(MOCK_SYNC 메모리 서버) — 응답 객체 형식(CaseInsensitiveDict 등)까지 확인."""
    ldap3 = pytest.importorskip("ldap3")
    real = ldap._ldap3()
    shared = ldap3.Server("mock.corp.test", get_info=ldap3.NONE)
    boot = ldap3.Connection(shared, client_strategy=ldap3.MOCK_SYNC)
    boot.strategy.add_entry(SVC_DN, {"userPassword": SVC_PW, "cn": "svc-pep"})
    boot.strategy.add_entry(f"uid=alice,{BASE_DN}", {
        "userPassword": USER_PW, "objectClass": "person", "uid": "alice", "displayName": "Alice K",
        "mail": "alice@corp.test",
        "memberOf": [GROUP_OK],
    })

    class MockConnection(ldap3.Connection):
        def __init__(self, server, **kw):
            super().__init__(shared, client_strategy=ldap3.MOCK_SYNC, **kw)

    monkeypatch.setattr(ldap, "_ldap3", lambda: SimpleNamespace(**{**vars(real), "Connection": MockConnection}))
    cfg = dict(ldap.DEFAULTS, enabled=True, server_urls=["ldap://mock.corp.test"], bind_mode="search",
               service_bind_dn=SVC_DN, bind_password_encrypted=ldap.secret_box.encrypt(SVC_PW),
               user_search_base=BASE_DN, user_search_filter="(uid={username})",
               allowed_groups=["cn=pep-users, ou=groups, dc=corp, dc=test"])
    ident = ldap.authenticate(cfg, "alice", USER_PW)
    assert ident.dn == f"uid=alice,{BASE_DN}"
    assert ident.display_name == "Alice K" and ident.email == "alice@corp.test" and ident.groups == [GROUP_OK]
    with pytest.raises(ldap.LdapError) as ei:
        ldap.authenticate(cfg, "alice", "wrong")
    assert ei.value.code == "invalid_credentials"
    with pytest.raises(ldap.LdapError) as ei:
        ldap.authenticate(cfg, "*", USER_PW)
    assert ei.value.code == "user_not_found"
    direct = dict(cfg, bind_mode="direct", bind_dn_template=f"uid={{username}},{BASE_DN}")
    assert ldap.authenticate(direct, "alice", USER_PW).groups == [GROUP_OK]
    check = ldap.check_connection(cfg, "alice")
    assert check["ok"] is True and check["user"]["group_allowed"] is True
