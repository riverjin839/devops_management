"""LLM 응답 정보요청(need_more_info) 파서 단위 테스트."""
from app.services.llm.response_parser import extract_info_requests


def test_extracts_fenced_json_block():
    text = (
        "OOM 으로 보입니다. 메모리 limit 을 확인하세요.\n\n"
        "```json\n"
        '{"need_more_info": [{"kind": "logs", "detail": "직전 1시간 로그가 필요합니다"}]}\n'
        "```"
    )
    clean, requests = extract_info_requests(text)
    assert "OOM 으로 보입니다" in clean
    assert "need_more_info" not in clean
    assert requests == [{"kind": "logs", "detail": "직전 1시간 로그가 필요합니다"}]


def test_extracts_bare_trailing_json():
    text = (
        "정확한 진단에는 서비스 코드가 필요합니다.\n"
        '{"need_more_info": [{"kind": "github_code", "detail": "핸들러 소스"}]}'
    )
    clean, requests = extract_info_requests(text)
    assert clean == "정확한 진단에는 서비스 코드가 필요합니다."
    assert requests[0]["kind"] == "github_code"


def test_filters_invalid_kinds_and_caps_detail():
    text = (
        "답변.\n"
        "```json\n"
        '{"need_more_info": ['
        '{"kind": "execute_command", "detail": "이건 무시"},'
        '{"kind": "troubleshooting_history", "detail": "' + ("x" * 600) + '"}'
        "]}\n```"
    )
    clean, requests = extract_info_requests(text)
    assert clean == "답변."
    assert len(requests) == 1
    assert requests[0]["kind"] == "troubleshooting_history"
    assert len(requests[0]["detail"]) == 500


def test_no_block_returns_text_unchanged():
    clean, requests = extract_info_requests("그냥 일반 답변입니다.")
    assert clean == "그냥 일반 답변입니다."
    assert requests == []


def test_malformed_json_is_ignored():
    text = "답변.\n```json\n{broken json...\n```"
    clean, requests = extract_info_requests(text)
    assert requests == []
    assert "답변." in clean


def test_json_without_need_more_info_key_is_kept():
    text = '분석 결과입니다.\n```json\n{"severity": "critical"}\n```'
    clean, requests = extract_info_requests(text)
    assert requests == []
    # need_more_info 블록이 아니면 본문을 훼손하지 않는다
    assert '{"severity": "critical"}' in clean


def test_empty_input():
    assert extract_info_requests("") == ("", [])
