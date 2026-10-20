"""명령 문자열의 비밀값 마스킹 — 감사 로그·응답(`executed_command`)·실행 로그 공용.

프론트 ``frontend/src/lib/commandMask.ts`` 와 **같은 규칙·같은 순서**를 쓴다(대소문자 무시, 값만 ``****``).
규칙을 바꾸면 양쪽을 같은 커밋에서 바꾸고 ``tests/test_command_mask.py`` 에 사례를 추가한다.

값(X) = 셸 단어 하나 — 따옴표 안 공백은 포함하고 **따옴표 밖 공백·``;&|<>`` 전까지**
(``'pa'"'"'ss'`` 처럼 이어 붙인 따옴표도 한 단어). 닫히지 않은 따옴표는 끝까지 값으로 본다.

규칙(순서대로 적용):
1. ``mc alias set [flags] <name> <url> <access> <secret>`` · ``mc config host add …``(구버전) —
   ``--api S3v4`` 같은 플래그·값 쌍은 건너뛰고 URL 다음 두 위치 인자를 가린다.
2. 비밀 플래그 ``--X[= ]값`` — ``--password``·``--passwd``·``--pass``·``--secret``·``--token``·
   ``--access-token``·``--api-key``·``--secret-key``·``--<무엇>-key``·``--<무엇>password|token|secret``.
   ``--key``(TLS 키 파일 경로)·``--keys-only``·``--passphrase X``·``--no-password`` 는 비밀이 아니라 그대로.
3. ``--user[= ]name:X`` · ``curl -u name:X``(``-U`` 프록시 포함) · ``<무엇>USER=name:X``(``ETCDCTL_USER``)
   — 이름은 남기고 ``:`` 뒤만.
4. env 대입 ``…(PASSWORD|PASSWD|SECRET|TOKEN|ACCESS_KEY|SECRET_KEY|API_KEY)…=X`` ·
   ``PASS…=X``/``_PASS…=X``(``DB_PASS``) · ``_PWD=X``(``MYSQL_PWD``; 셸 ``PWD=`` 는 제외).
5. ``mysql|mysqldump|mysqladmin|mariadb … -pX``(붙여 쓴 값만 — ``-p db`` 는 프롬프트+DB 이름, ``-P`` 는 포트).
6. ``Authorization: Bearer|Basic|Token X``.
7. (D-170 서버 방어 규칙 — 프론트도 동일) ``MC_HOST_<alias>=scheme://ACCESS:SECRET@host`` · ``sshpass -p X`` ·
   URL userinfo ``scheme://user:X@host``(빈 user 허용, X 안의 ``@``·``/`` 는 마지막 ``@`` 까지).

마스킹은 멱등이다(``mask(mask(s)) == mask(s)``).
"""
from __future__ import annotations

import re
from typing import Callable, Iterable

MASK = "****"

# 셸 단어 — 작은따옴표 문자열 | 큰따옴표 문자열(\" 이스케이프) | \x | 따옴표·공백·메타문자 아닌 문자 — 의 연속.
# 각 대안의 첫 글자가 서로 달라 역추적이 선형이다. 닫는 따옴표가 없으면 끝까지 먹는다(과잉 마스킹 쪽으로).
_WORD = r"""(?:'[^']*'?|"(?:[^"\\]|\\.)*"?|\\.|[^\s'"\\;&|<>])+"""

_I = re.IGNORECASE | re.ASCII  # JS 정규식과 같은 ASCII \w·\b

_VALUE_FLAGS = frozenset({"--api", "--path", "--config-dir", "-c"})
_WS_WORD = re.compile(r"(\s+)(" + _WORD + ")", re.ASCII)


def _mask_after_colon(word: str) -> str:
    """``name:secret`` → ``name:****``. 콜론이 없으면(비밀번호 프롬프트) 그대로. 여는 따옴표는 닫아 준다."""
    idx = word.find(":")
    if idx < 0:
        return word
    head = word[: idx + 1]
    q = head[0] if head[0] in "'\"" and head.count(head[0]) % 2 == 1 else ""
    return head + MASK + q


def _mask_mc_alias_tail(tail: str) -> str:
    """``alias set`` 뒤 인자들 — 플래그(와 값)를 건너뛴 위치 인자 중 URL 다음 두 개(없으면 3·4번째)를 가린다."""
    toks = [[m.group(1), m.group(2)] for m in _WS_WORD.finditer(tail)]
    positional: list[int] = []
    skip_next = False
    for i, (_, w) in enumerate(toks):
        if skip_next:
            skip_next = False
            continue
        if w.startswith("-") and len(w) > 1:
            skip_next = "=" not in w and w.lower() in _VALUE_FLAGS
            continue
        positional.append(i)
    url_pos = next((k for k, i in enumerate(positional) if "://" in toks[i][1]), None)
    secret = positional[url_pos + 1: url_pos + 3] if url_pos is not None else positional[2:4]
    for i in secret:
        toks[i][1] = MASK
    return "".join(ws + w for ws, w in toks)


_Repl = Callable[[re.Match[str]], str]


def _keep_head(m: re.Match[str]) -> str:
    return m.group(1) + MASK


def _head_after_colon(m: re.Match[str]) -> str:
    return m.group(1) + _mask_after_colon(m.group(2))


# (패턴, 치환 함수) — 순서대로 적용한다. 프론트 RULES 와 1:1.
_RULES: list[tuple[re.Pattern[str], _Repl]] = [
    # 1. mc alias set / config host add
    (re.compile(r"(\b(?:alias\s+set|config\s+host\s+add))((?:\s+" + _WORD + r")+)", _I),
     lambda m: m.group(1) + _mask_mc_alias_tail(m.group(2))),
    # 2. 비밀 플래그 --X[= ]값
    (re.compile(r"(--(?!no-)(?:[\w-]*(?:password|passwd|token|secret)|pass|apikey|[\w-]+-key)(?:=|\s+))"
                + _WORD, _I), _keep_head),
    # 3. --user name:X · curl -u name:X · …USER=name:X
    (re.compile(r"(--user(?:=|\s+))(" + _WORD + ")", _I), _head_after_colon),
    (re.compile(r"(\bcurl\b[^;&|\n]*?\s-[a-z]*u\s*)(" + _WORD + ")", _I), _head_after_colon),
    (re.compile(r"(\w*USER=)(" + _WORD + ")", _I), _head_after_colon),
    # 4. env 대입
    (re.compile(r"((?:PASSWORD|PASSWD|SECRET|TOKEN|ACCESS_KEY|SECRET_KEY|API_KEY|(?:\b|_)PASS|_PWD)[A-Z_]*=)"
                + _WORD, _I), _keep_head),
    # 5. mysql -pX (대소문자 구분 — -P 는 포트)
    (re.compile(r"(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;&|\n]*?\s-p)" + _WORD, re.ASCII), _keep_head),
    # 6. Authorization 헤더
    (re.compile(r"(Authorization:\s*(?:Bearer|Basic|Token)\s+)[^\s'\"]+", _I), _keep_head),
    # 7. MC_HOST_<alias>=scheme://ACCESS:SECRET@host
    (re.compile(r"""(MC_HOST_\w*=['"]?[a-z][a-z0-9+.-]*://)[^:@\s'"/]*:[^\s'"]*@""", _I),
     lambda m: m.group(1) + MASK + ":" + MASK + "@"),
    # sshpass -p X
    (re.compile(r"(\bsshpass\s+-p\s*)" + _WORD, _I), _keep_head),
    # scheme://user:X@host — 빈 user 허용, X 는 마지막 @ 까지(@·/ 포함 비밀번호)
    (re.compile(r"""([a-z][a-z0-9+.-]*://[^:@\s'"/]*:)[^\s'"]*@""", _I), lambda m: m.group(1) + MASK + "@"),
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


def audit_error(exc: BaseException | None, limit: int = 200) -> str | None:
    """실행 도중 예외의 감사용 요약 — ``Type: 메시지`` 를 마스킹 후 ``limit`` 자까지. 예외가 없으면 None."""
    if exc is None:
        return None
    msg = str(exc).strip()
    return audit_command(f"{type(exc).__name__}: {msg}" if msg else type(exc).__name__, limit)


def audit_hosts(hosts: Iterable[str | None], limit: int = AUDIT_HOSTS_MAX) -> list[str]:
    """감사 로그 대상 호스트 목록 — 앞 ``limit`` 개까지(정책 7)."""
    out: list[str] = []
    for h in hosts:
        if h:
            out.append(str(h)[:255])
        if len(out) >= limit:
            break
    return out
