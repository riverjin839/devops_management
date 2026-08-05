"""DB-free 순수 함수 테스트 — services/script_wrap.py.

bulk-exec 는 단일 명령 문자열만 받으므로, 저장 스크립트가 python 일 때 원격
python3 인터프리터로 감싸는 이 변환이 정확해야 실제 SSH 실행에서 문제가 없다.
"""
from app.services.script_wrap import wrap_script_for_language


def test_bash_passthrough_unchanged():
    content = "uname -a && free -m"
    assert wrap_script_for_language(content, "bash") == content


def test_python_wraps_in_heredoc_with_python3_interpreter():
    content = "import sys\nprint(sys.version)"
    wrapped = wrap_script_for_language(content, "python")
    assert wrapped.startswith("python3 - <<'PYEOF_")
    assert content in wrapped
    # 시작/종료 구분자가 동일해야 heredoc 이 올바르게 닫힌다.
    first_line = wrapped.splitlines()[0]
    delimiter = first_line.split("<<'")[1].rstrip("'")
    assert wrapped.splitlines()[-1] == delimiter


def test_python_delimiter_is_unique_per_call():
    """스크립트 본문에 우연히 'EOF' 가 있어도 heredoc 이 조기 종료되지 않도록,
    매 호출 랜덤 구분자를 쓴다 — 두 번 감싸면 구분자가 달라야 한다."""
    content = "print('EOF')"
    a = wrap_script_for_language(content, "python")
    b = wrap_script_for_language(content, "python")
    delim_a = a.splitlines()[0].split("<<'")[1].rstrip("'")
    delim_b = b.splitlines()[0].split("<<'")[1].rstrip("'")
    assert delim_a != delim_b
    # 본문에 등장하는 리터럴 "EOF" 문자열이 구분자와 겹치지 않는다.
    assert "EOF" != delim_a and "EOF" != delim_b


def test_python_wrap_preserves_multiline_script_verbatim():
    content = "def f():\n    return 1\n\nprint(f())"
    wrapped = wrap_script_for_language(content, "python")
    # 구분자 라인(첫줄)과 종료 구분자(마지막줄)를 제외하면 원본과 동일해야 한다.
    body = "\n".join(wrapped.splitlines()[1:-1])
    assert body == content
