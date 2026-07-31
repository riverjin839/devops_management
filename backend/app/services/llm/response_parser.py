"""LLM 응답 후처리 — 정보요청(need_more_info) 블록 추출.

프롬프트 규약: 컨텍스트가 부족하면 모델이 응답 말미에 fenced JSON 을 붙인다.

    ```json
    {"need_more_info": [{"kind": "github_code", "detail": "..."}]}
    ```

이 모듈은 그 블록을 응답 본문에서 떼어내 구조화한다. **자율 tool-calling 이
아니다** — 요청은 UI 에서 운영자에게 액션 칩으로 표시되고, 정보 제공 여부는
항상 사람이 결정한다 (무실행 보증 유지). 파싱 실패는 조용히 무시(fail-safe).
"""
from __future__ import annotations

import json
import re
from typing import Any

VALID_KINDS = {"github_code", "troubleshooting_history", "logs", "config"}

_FENCE_RE = re.compile(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```")
_BARE_RE = re.compile(r"(\{[^{}]*\"need_more_info\"[\s\S]*\})\s*$")


def extract_info_requests(text: str) -> tuple[str, list[dict[str, Any]]]:
    """(정리된 본문, 정보요청 목록) 반환. 절대 raise 하지 않는다."""
    if not text:
        return "", []
    try:
        for pattern in (_FENCE_RE, _BARE_RE):
            for match in reversed(list(pattern.finditer(text))):
                block = match.group(1)
                try:
                    parsed = json.loads(block)
                except (ValueError, TypeError):
                    continue
                if not isinstance(parsed, dict) or "need_more_info" not in parsed:
                    continue
                requests = _normalize(parsed.get("need_more_info"))
                clean = (text[:match.start()] + text[match.end():]).strip()
                return clean, requests
    except Exception:  # noqa: BLE001
        pass
    return text.strip(), []


def _normalize(raw: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind", "")).strip()
        if kind not in VALID_KINDS:
            continue
        detail = str(item.get("detail", "")).strip()[:500]
        out.append({"kind": kind, "detail": detail})
    return out[:5]
