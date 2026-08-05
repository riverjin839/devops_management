"""저장 스크립트(bash/python)를 bulk-exec 의 단일 SSH 명령 문자열로 변환.

`BulkExecRequest.command` 는 파라미코 `exec_command()` 에 그대로 넘어가는 단일
문자열이라 언어 개념이 없다 — bash 는 원래 셸이 그대로 해석하니 손댈 게 없고,
python 스크립트만 원격 `python3` 인터프리터에 heredoc 으로 넘기도록 감싼다.
순수 함수라 원격 접속 없이 단위 테스트 가능하다.
"""
import uuid

from app.schemas.saved_script import ScriptLanguage


def wrap_script_for_language(content: str, language: ScriptLanguage) -> str:
    """`content` 를 원격 셸에서 그대로 실행 가능한 명령 문자열로 변환.

    bash 는 원본 그대로 반환(기존 동작과 100% 호환). python 은 유일한
    heredoc 구분자(스크립트 본문과 우연히 겹치지 않도록 매 호출 랜덤 생성)로
    감싸 `python3 - <<'DELIM' ... DELIM` 형태로 만든다 — 따옴표 처리한
    구분자라 셸 변수 확장이 스크립트 본문에 적용되지 않는다.
    """
    if language == "python":
        delimiter = f"PYEOF_{uuid.uuid4().hex[:12]}"
        return f"python3 - <<'{delimiter}'\n{content}\n{delimiter}"
    return content
