"""DB-free — 명령 비밀값 마스킹(`services/command_mask`)과 cilium-dbg 읽기 전용 allowlist 판정.

마스킹 규칙은 프론트 `lib/commandMask.ts` 와 같아야 한다(감사 로그·응답·화면이 같은 값을 가린다).
"""
import pytest

from app.services.cilium_trace_service import (
    cilium_readonly_command_labels,
    is_cilium_readonly_command,
)
from app.services.command_mask import (
    AUDIT_COMMAND_MAX,
    AUDIT_HOSTS_MAX,
    audit_command,
    audit_hosts,
    mask_command,
)


@pytest.mark.parametrize("raw, expected", [
    # --password / --pass / --secret[-key] / --token (= 또는 공백)
    ("etcdctl --password=abc get /", "etcdctl --password=**** get /"),
    ("etcdctl --password 'a b' get /", "etcdctl --password **** get /"),
    ("x --PASS P", "x --PASS ****"),
    ("x --secret-key=S --secret X", "x --secret-key=**** --secret ****"),
    ("x --token T1", "x --token ****"),
    # --user name:pass
    ("etcdctl --user root:pw123 get /", "etcdctl --user root:**** get /"),
    ("etcdctl --user=root:pw member list", "etcdctl --user=root:**** member list"),
    # ENV 대입
    ("export ETCDCTL_PASSWORD='x y' && etcdctl get /", "export ETCDCTL_PASSWORD=**** && etcdctl get /"),
    ("api_key=1 secret_key=2 aws_access_key_id=3 TOKEN=4 passwd=5",
     "api_key=**** secret_key=**** aws_access_key_id=**** TOKEN=**** passwd=****"),
    # mc alias set <name> <url> <access> <secret>
    ("mc alias set local http://h:9000 AKIA SECRETV && mc ls local",
     "mc alias set local http://h:9000 **** **** && mc ls local"),
    # Authorization: Bearer
    ('curl -H "Authorization: Bearer abc.def" http://x', 'curl -H "Authorization: Bearer ****" http://x'),
    # 서버 추가 규칙
    ("export MC_HOST_local='https://AK:SK@10.0.0.1:9000'", "export MC_HOST_local='https://****:****@10.0.0.1:9000'"),
    ("sshpass -p hunter2 ssh h", "sshpass -p **** ssh h"),
    ("git clone https://u:p@github.com/x", "git clone https://u:****@github.com/x"),
])
def test_mask_rules(raw, expected):
    assert mask_command(raw) == expected


@pytest.mark.parametrize("raw", [
    "endpoint health --write-out=table",
    "get /registry/secrets --prefix --keys-only",
    "--passphrase keep",
    "ls local/bucket",
])
def test_non_secret_text_unchanged(raw):
    assert mask_command(raw) == raw


def test_mask_is_idempotent_and_handles_empty():
    s = "etcdctl --user root:pw --password=x && mc alias set a http://h AK SK"
    assert mask_command(mask_command(s)) == mask_command(s)
    assert mask_command("") == ""
    assert mask_command(None) == ""  # type: ignore[arg-type]


def test_audit_command_masks_before_truncating():
    long = "etcdctl --password=supersecret " + "x" * 1000
    out = audit_command(long)
    assert len(out) == AUDIT_COMMAND_MAX
    assert "supersecret" not in out and "****" in out


def test_audit_hosts_keeps_first_twenty():
    hosts = [f"10.0.0.{i}" for i in range(30)] + [None, ""]
    out = audit_hosts(hosts)
    assert out == [f"10.0.0.{i}" for i in range(AUDIT_HOSTS_MAX)]


# ── cilium-dbg 읽기 전용 allowlist ──────────────────────────────────────────

@pytest.mark.parametrize("cmd", [
    "status", "status --verbose", "cilium-dbg status", "version",
    "endpoint list -o json", "bpf ct list global", "bpf lb list", "bpf policy get 123",
    "bpf fs show", "service list", "identity get 1234", "config", "config -o json",
    "fqdn cache list", "bpf ct flush global --help",
])
def test_cilium_readonly_allowed(cmd):
    assert is_cilium_readonly_command(cmd)


@pytest.mark.parametrize("cmd", [
    "", "   ", "bpf ct flush global", "endpoint delete 123", "config Debug=true",
    "service delete 1", "cleanup --all-state", "shell -- db/show", "kvstore set k v",
    "endpoint config 12 Debug=true", "policy delete --all", "'unterminated",
    "bpf lb delete",
])
def test_cilium_mutating_or_unknown_blocked(cmd):
    assert not is_cilium_readonly_command(cmd)


def test_cilium_allowlist_labels_are_human_readable():
    labels = cilium_readonly_command_labels()
    assert "status" in labels and "bpf <맵> list" in labels
