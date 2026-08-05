"""시크릿 마스킹 단위 테스트 — 자격증명 패턴별 + 과잉 마스킹 회귀."""
from app.services.llm.masking import MASK, mask_secrets


def test_bearer_token_masked():
    out = mask_secrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789")
    assert MASK in out
    assert "abcdefghijklmnopqrstuvwxyz" not in out


def test_password_kv_masked():
    out = mask_secrets("DB 연결 실패: password=SuperSecret123! host=db")
    assert "SuperSecret123!" not in out
    assert "host=db" in out


def test_api_key_masked():
    out = mask_secrets("api_key=sk-proj-abcdefghijklmnop1234 요청 실패")
    assert "sk-proj-abcdefghijklmnop1234" not in out


def test_aws_keys_masked():
    out = mask_secrets("key: AKIAIOSFODNN7EXAMPLE / aws_secret_access_key=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY0")
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    assert "wJalrXUtnFEMIK7MDENG" not in out


def test_pem_block_masked():
    pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
    out = mask_secrets(f"before\n{pem}\nafter")
    assert "MIIEpAIBAAKCAQEA" not in out
    assert "before" in out and "after" in out


def test_url_userinfo_masked():
    out = mask_secrets("접속 http://admin:hunter22@nexus.corp:8081/repo 실패")
    assert "hunter22" not in out
    assert "nexus.corp:8081/repo" in out


def test_jwt_masked():
    jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"
    out = mask_secrets(f"token in log: {jwt}")
    assert jwt not in out


# ── 과잉 마스킹 회귀 — 일반 로그는 훼손하지 않는다 ─────────────────────

def test_normal_logs_untouched():
    log = (
        "2026-07-29T10:00:00Z ERROR pod api-5c9d crashed: OOMKilled\n"
        "restartCount=12 node=worker-3 image=registry/app:v1.2.3\n"
        "sha256: 3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a\n"
        "uuid=550e8400-e29b-41d4-a716-446655440000 latency_ms=120"
    )
    assert mask_secrets(log) == log


def test_short_flag_values_untouched():
    text = "token=abc pwd 필드 없음, secret_key 미설정"
    # 16자 미만 token 값·값 없는 언급은 마스킹하지 않는다
    assert mask_secrets(text) == text


def test_empty_and_none_safe():
    assert mask_secrets("") == ""
