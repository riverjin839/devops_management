"""공통 서비스 — 수집 결과를 비교 가능한 평탄 키/값으로 만드는 순수 함수(DB 없음, 단위 테스트 대상).

- ``flatten``  : 중첩 dict/list → ``a.b.c`` 키. 이름 있는 객체 목록(name·alias·clientId·shortName …)은 그 이름을 경로로 쓴다
  — 순서가 바뀌어도 변경으로 잡히지 않게. 스칼라 목록은 정렬하지 않은 JSON 문자열(순서도 설정이다).
- ``mask``     : 비밀처럼 보이는 키의 값은 저장하지 않고 ``(숨김 · <해시 10자>)`` 로 바꾼다 — 값이 바뀌면 해시가 바뀌어 변경은 감지된다.
- ``content_hash`` · ``diff_flat`` : 스냅샷 중복 저장 방지와 바뀐 키 계산.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Optional

MAX_KEYS = 3000
MAX_VALUE = 4000
_NAME_KEYS = ("name", "alias", "clientId", "shortName", "key", "id")
_SECRET_RE = re.compile(r"(passw|secret|token|private[_-]?key|credential|api[_-]?key|bindpw|\.key$)", re.I)
_TOO_LONG = "…(잘림)"


def is_secret_key(key: str) -> bool:
    return bool(_SECRET_RE.search(key or ""))


def masked(value: Any) -> str:
    raw = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return f"(숨김 · {hashlib.sha256(raw.encode('utf-8')).hexdigest()[:10]})"


def scalar(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        s = value
    else:
        s = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return s if len(s) <= MAX_VALUE else s[:MAX_VALUE] + _TOO_LONG


def _item_name(obj: Any) -> Optional[str]:
    if isinstance(obj, dict):
        for k in _NAME_KEYS:
            v = obj.get(k)
            if isinstance(v, (str, int)) and str(v):
                return str(v)
    return None


def flatten(data: Any, prefix: str = "", out: Optional[dict[str, Optional[str]]] = None,
            mask_secrets: bool = True) -> dict[str, Optional[str]]:
    out = {} if out is None else out
    if len(out) >= MAX_KEYS:
        return out
    if isinstance(data, dict):
        if not data and prefix:
            out[prefix] = "{}"
        for k in sorted(data, key=str):
            key = f"{prefix}.{k}" if prefix else str(k)
            v = data[k]
            if mask_secrets and is_secret_key(str(k)) and v not in (None, "", [], {}):
                out[key] = masked(v)
            else:
                flatten(v, key, out, mask_secrets)
        return out
    if isinstance(data, list):
        if data and all(isinstance(x, dict) for x in data):
            names = [_item_name(x) for x in data]
            use_names = all(names) and len(set(names)) == len(names)
            for i, x in enumerate(data):
                flatten(x, f"{prefix}[{names[i] if use_names else i}]", out, mask_secrets)
            return out
        out[prefix] = scalar(data)
        return out
    out[prefix or "value"] = scalar(data)
    return out


def mask_env(env: dict[str, Any]) -> dict[str, Any]:
    """환경변수 이름이 비밀처럼 보이면 값을 해시로."""
    return {k: (masked(v) if is_secret_key(k) and v not in (None, "") else v) for k, v in env.items()}


def content_hash(flat: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(flat, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()


def diff_flat(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Optional[str]]]:
    out: list[dict[str, Optional[str]]] = []
    for k in sorted(set(before) | set(after)):
        b, a = before.get(k), after.get(k)
        if b != a:
            out.append({"key": k, "old": b, "new": a})
    return out


def parse_properties(text: str) -> dict[str, str]:
    """Java properties(nexus.properties) — 주석·빈 줄 무시, ``k=v`` / ``k: v``."""
    out: dict[str, str] = {}
    for line in (text or "").splitlines():
        s = line.strip()
        if not s or s[0] in "#!":
            continue
        m = re.match(r"([^=:\s]+)\s*[=:]\s*(.*)$", s)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out
