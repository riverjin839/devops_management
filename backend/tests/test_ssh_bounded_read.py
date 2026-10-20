"""SSH 출력 읽기 상한 — 큰 출력을 전부 메모리에 올리지 않고 필요한 끝/앞부분만 남긴다."""
import io

from app.services.isilon_service import _read_head
from app.services.ssh_runner import _read_tail


class _Stream(io.BytesIO):
    """paramiko ChannelFile 처럼 read(n) 으로 조금씩 준다."""


def test_read_tail_keeps_last_chars_only():
    data = ("가" * 300_000 + "끝부분").encode()
    assert _read_tail(_Stream(data), 5) == "가가끝부분"
    assert _read_tail(_Stream(b"short"), 8000) == "short"
    assert _read_tail(_Stream(b""), 10) == ""


def test_read_tail_unbounded_returns_all_small_output():
    assert _read_tail(_Stream(b"x" * 1000), 0) == "x" * 1000


def test_read_head_keeps_first_chars_and_drains():
    s = _Stream(("앞" * 10 + "z" * 500_000).encode())
    assert _read_head(s, 12) == "앞" * 10 + "zz"
    assert s.read() == b""  # 끝까지 읽었다(원격이 쓰기에서 막히지 않게)
