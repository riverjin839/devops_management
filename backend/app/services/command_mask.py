"""명령 문자열의 비밀값 마스킹 — 감사 로그·응답(`executed_command`)·실행 로그 공용.

프론트 ``frontend/src/lib/commandMask.ts`` 와 **같은 규칙**을 쓴다(대소문자 무시, 값만 ``****``).

공통 규칙(프론트와 1:1):
- ``--password[= ]X`` · ``--pass[= ]X`` · ``--secret[-key][= ]X`` · ``--token[= ]X``
- ``--user[= ]name:X`` — etcdctl ``--user u:p`` 의 ``p``
- ``(PASSWORD|PASSWD|SECRET|TOKEN|ACCESS_KEY|SECRET_KEY|API_KEY)[A-Z_]*=X`` — ``ETCDCTL_PASSWORD=…`` 등 env 대입
- ``mc alias set <name> <url> <access> <secret>`` 의 access·secret 두 인자
- ``Authorization: Bearer X``

서버 추가 규칙(D-170 — 감사 로그 쪽 방어를 한 겹 더):
- ``MC_HOST_<alias>=https://ACCESS:SECRET@host`` 의 ACCESS·SECRET
- ``sshpass -p X``
- URL userinfo 비밀번호(``scheme://user:X@host``)

값(X)은 따옴표로 감싼 문자열(``'…'``/``"…"``) 또는 공백 전까지다. 마스킹은 멱등이다.
"""
from __future__ import annotations

import re
from typing import Iterable

MASK = "****"

# 값 토큰 — 따옴표 문자열 또는 공백·따옴표 아닌 연속 문자.
_VAL = r"""(?:'[^']*'|"[^"]*"|[^\s'"]+)"""

_FLAGS = re.IGNORECASE

# (패턴, 치환) — 순서대로 적용한다.
_RULES: list[tuple[re.Pattern[str], str]] = [
    # --password / --pass / --secret / --secret-key / --token  (= 또는 공백 구분)
    (re.compile(r"(--(?:password|pass|secret(?:-key)?|token)(?:=|\s+))" + _VAL, _FLAGS), r"\1" + MASK),
    # --user name:pass → --user name:****
    (re.compile(r"""(--user(?:=|\s+)['"]?[^\s:'"]*:)[^\s'"]+""", _FLAGS), r"\1" + MASK),
    # ENV 대입 — PASSWORD=… / ETCDCTL_PASSWORD=… / AWS_SECRET_ACCESS_KEY=… / API_KEY=…
    (re.compile(r"((?:PASSWORD|PASSWD|SECRET|TOKEN|ACCESS_KEY|SECRET_KEY|API_KEY)[A-Z_]*=)" + _VAL, _FLAGS),
     r"\1" + MASK),
    # mc alias set <name> <url> <access> <secret>
    (re.compile(r"(\balias\s+set\s+" + _VAL + r"\s+" + _VAL + r"\s+)" + _VAL + r"(\s+)" + _VAL, _FLAGS),
     r"\1" + MASK + r"\2" + MASK),
    # Authorization: Bearer X
    (re.compile(r"(Authorization:\s*Bearer\s+)[^\s'\"]+", _FLAGS), r"\1" + MASK),
    # ── 서버 추가 규칙 ──
    # MC_HOST_<alias>=https://ACCESS:SECRET@host
    (re.compile(r"""(MC_HOST_\w*=['"]?[a-z][a-z0-9+.-]*://)[^:@\s'"/]+:[^@\s'"/]+@""", _FLAGS),
     r"\1" + MASK + ":" + MASK + "@"),
    # sshpass -p X
    (re.compile(r"(\bsshpass\s+-p\s*)" + _VAL, _FLAGS), r"\1" + MASK),
    # scheme://user:password@host  (위 규칙이 이미 가린 **** 는 그대로 둔다)
    (re.compile(r"([a-z][a-z0-9+.-]*://[^:@\s'\"/]+:)(?!\*\*\*\*@)[^@\s'\"/]+@", _FLAGS), r"\1" + MASK + "@"),
]

AUDIT_COMMAND_MAX = 500
AUDIT_HOSTS_MAX = 20


def mask_command(text: str) -> str:
    """명령 문자열에서 비밀값을 ``****`` 로 가린다. None/빈 값은 빈 문자열."""
    if not text:
        return ""
    out = str(text)
    for pattern, repl in _RULES:
        out = pattern.sub(repl, out)
    return out


def audit_command(text: str | None, limit: int = AUDIT_COMMAND_MAX) -> str:
    """감사 로그 ``details.command`` 용 — 마스킹 후 ``limit`` 자까지(정책 7)."""
    return mask_command(text or "")[:limit]


def audit_hosts(hosts: Iterable[str | None], limit: int = AUDIT_HOSTS_MAX) -> list[str]:
    """감사 로그 대상 호스트 목록 — 앞 ``limit`` 개까지(정책 7)."""
    out: list[str] = []
    for h in hosts:
        if h:
            out.append(str(h)[:255])
        if len(out) >= limit:
            break
    return out
