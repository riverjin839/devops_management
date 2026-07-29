"""SSH 웹 터미널 공용 브리지(`services/ssh_pty`) 단위 테스트.

k9s 콘솔과 노드 SSH 터미널이 같은 init 프레임 파싱·플래그 처리를 공유하므로,
여기가 깨지면 두 콘솔이 동시에 깨진다.
"""
import json

import pytest

from app.routers.k9s_ssh import _build_k9s_command
from app.services.ssh_pty import (
    PtyInitError,
    env_flag_enabled,
    receive_init,
)


class FakeWebSocket:
    """receive_text 만 흉내내는 최소 스텁."""

    def __init__(self, frames: list[str]):
        self._frames = list(frames)
        self.sent: list[str] = []

    async def receive_text(self) -> str:
        if not self._frames:
            raise AssertionError("no more frames")
        return self._frames.pop(0)

    async def send_text(self, data: str) -> None:
        self.sent.append(data)


def _frame(**kwargs) -> str:
    return json.dumps({"type": "init", **kwargs})


# ── env_flag_enabled ────────────────────────────────────────────────────────

def test_env_flag_defaults_when_unset(monkeypatch):
    monkeypatch.delenv("PEP_TEST_FLAG", raising=False)
    assert env_flag_enabled("PEP_TEST_FLAG") is True
    assert env_flag_enabled("PEP_TEST_FLAG", default=False) is False


@pytest.mark.parametrize("value", ["false", "FALSE", "0", "no", " No "])
def test_env_flag_disabled_values(monkeypatch, value):
    monkeypatch.setenv("PEP_TEST_FLAG", value)
    assert env_flag_enabled("PEP_TEST_FLAG") is False


@pytest.mark.parametrize("value", ["true", "1", "yes", ""])
def test_env_flag_enabled_values(monkeypatch, value):
    monkeypatch.setenv("PEP_TEST_FLAG", value)
    assert env_flag_enabled("PEP_TEST_FLAG") is True


# ── receive_init ────────────────────────────────────────────────────────────

async def test_receive_init_parses_password_frame():
    ws = FakeWebSocket([_frame(host="10.0.0.11", port=2222, username="ops",
                               password="pw", cols=100, rows=30)])
    init = await receive_init(ws)
    assert (init.host, init.port, init.username) == ("10.0.0.11", 2222, "ops")
    assert init.password == "pw" and init.private_key is None
    assert (init.cols, init.rows) == (100, 30)
    assert init.label == "ops@10.0.0.11:2222"


async def test_receive_init_accepts_camel_and_snake_private_key():
    for key in ("privateKey", "private_key"):
        ws = FakeWebSocket([_frame(host="h", **{key: "-----BEGIN-----"})])
        init = await receive_init(ws)
        assert init.private_key == "-----BEGIN-----"


async def test_receive_init_defaults_port_user_and_size():
    ws = FakeWebSocket([_frame(host="h", password="pw")])
    init = await receive_init(ws)
    assert (init.port, init.username, init.cols, init.rows) == (22, "root", 120, 40)


async def test_receive_init_falls_back_on_unparsable_numbers():
    ws = FakeWebSocket([_frame(host="h", password="pw", port="not-a-port", cols="x", rows="y")])
    init = await receive_init(ws)
    assert (init.port, init.cols, init.rows) == (22, 120, 40)


async def test_receive_init_keeps_screen_specific_fields_in_raw():
    ws = FakeWebSocket([_frame(host="h", password="pw", namespace="kube-system",
                               initialCommand="sudo -i")])
    init = await receive_init(ws)
    assert init.raw["namespace"] == "kube-system"
    assert init.raw["initialCommand"] == "sudo -i"


@pytest.mark.parametrize("frame", [
    "not json at all",
    json.dumps({"type": "stdin", "data": "x"}),      # init 이 아님
    json.dumps(["init"]),                            # dict 가 아님
    _frame(password="pw"),                           # host 없음
    _frame(host="   ", password="pw"),               # host 공백
    _frame(host="h"),                                # 자격증명 없음
    _frame(host="h", password="", privateKey=""),    # 빈 자격증명
])
async def test_receive_init_rejects_bad_frames(frame):
    with pytest.raises(PtyInitError):
        await receive_init(FakeWebSocket([frame]))


async def test_pty_init_target_carries_metadata():
    ws = FakeWebSocket([_frame(host="h", password="pw")])
    init = await receive_init(ws)
    target = init.target(name="node-1", cluster_id="cid", cluster_name="prod")
    assert (target.host, target.username, target.password) == ("h", "root", "pw")
    assert (target.name, target.cluster_id, target.cluster_name) == ("node-1", "cid", "prod")


# ── k9s 명령 조립 (공용 브리지로 리팩터링된 뒤에도 동일해야 함) ───────────────

def test_build_k9s_command_plain():
    cmd = _build_k9s_command(None, False, None)
    assert cmd.endswith("exec k9s")
    assert "export TERM=xterm;" in cmd


def test_build_k9s_command_valid_namespace_and_readonly():
    cmd = _build_k9s_command("kube-system", True, None)
    assert cmd.endswith("exec k9s -n kube-system --readonly")


def test_build_k9s_command_drops_invalid_namespace():
    assert _build_k9s_command("Bad NS!", False, None).endswith("exec k9s")


def test_build_k9s_command_extra_flags_are_whitelisted():
    cmd = _build_k9s_command(None, False, "--headless --rm -rf /")
    assert cmd.endswith("exec k9s --headless")
