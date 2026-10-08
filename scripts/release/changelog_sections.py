#!/usr/bin/env python3
"""CHANGELOG.md 의 '이미 릴리스된 섹션' 보호 — CI 가드와 auto-release 구제(rescue)의 공용 로직.

문제: PR 이 `## [Unreleased]` 끝에 항목을 추가한 뒤, 그 PR 이 머지되기 전에 auto-release 가
`[Unreleased]` 를 `## [X.Y.Z]` 로 확정하면, git 3-way 머지가 PR 의 추가 줄을 **충돌 없이**
새로 생긴 `[X.Y.Z]` 섹션 안에 넣는다. 그 결과 `[Unreleased]` 는 비고(auto-release 가 "릴리스할
내용 없음"으로 스킵), 변경은 이미 나간 버전에 거짓으로 기록된다 (1.38.0 · 1.41.1 · 1.41.2 사례).

두 겹으로 막는다.
  1. `check_changelog_sections.py` (PR CI): base 대비 이미 존재하는 버전 섹션 본문이 바뀌면 실패.
  2. `bump_version.py --rescue-from <ref>` (auto-release): CI 이후에 릴리스가 끼어들어 가드를
     통과해 버린 경우, 직전 main 대비 릴리스 섹션에 **새로 끼어든 줄**을 `[Unreleased]` 의 같은
     `### 소제목` 아래로 옮긴 뒤 bump 한다.

의도적으로 릴리스 섹션을 고치는 PR(위치 정리 등)은 제목에 `[changelog-fix]` 를 붙여 둘 다 우회한다.
"""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

UNRELEASED_KEY = "Unreleased"
EXEMPT_MARKER = "[changelog-fix]"

_SECTION_RE = re.compile(r"^## \[(?P<key>[^\]]+)\]", re.MULTILINE)
_SUBHEAD_RE = re.compile(r"^### (?P<name>.+?)\s*$")
_RELEASE_TITLE_RE = re.compile(r"^chore\(release\)(!)?:")


@dataclass
class Section:
    key: str            # "Unreleased" 또는 "1.42.0"
    start: int          # 헤더 줄 시작 오프셋
    end: int            # 다음 섹션 헤더 시작(또는 링크 정의/파일 끝) 오프셋
    header: str         # "## [1.42.0] - 2026-10-08" 줄 (개행 제외)
    body: str           # 헤더 다음 줄부터 end 까지


@dataclass
class Intrusion:
    """릴리스 섹션에 새로 끼어든 줄 묶음."""
    version: str
    subsection: str | None           # 끼어든 위치의 `### 소제목` (없으면 None)
    lines: list[str] = field(default_factory=list)


def is_exempt_title(title: str | None) -> bool:
    t = (title or "").strip()
    return EXEMPT_MARKER in t or bool(_RELEASE_TITLE_RE.match(t))


def parse_sections(text: str) -> list[Section]:
    matches = list(_SECTION_RE.finditer(text))
    sections: list[Section] = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        line_end = text.find("\n", start)
        line_end = len(text) if line_end == -1 else line_end
        sections.append(Section(
            key=m.group("key"),
            start=start,
            end=end,
            header=text[start:line_end],
            body=text[line_end + 1:end] if line_end < end else "",
        ))
    return sections


def released_sections(text: str) -> dict[str, Section]:
    return {s.key: s for s in parse_sections(text) if s.key != UNRELEASED_KEY}


def _subsection_at(lines: list[str], idx: int) -> str | None:
    for j in range(idx - 1, -1, -1):
        m = _SUBHEAD_RE.match(lines[j])
        if m:
            return m.group("name")
    return None


def section_changes(base_text: str, head_text: str) -> list[str]:
    """base 에 이미 있던 릴리스 섹션이 head 에서 바뀐 내역(사람이 읽는 문장 목록). 비면 통과."""
    problems: list[str] = []
    base = released_sections(base_text)
    head = released_sections(head_text)
    for key, b in base.items():
        h = head.get(key)
        if h is None:
            problems.append(f"[{key}] 섹션이 사라졌다")
            continue
        if b.body.strip() == h.body.strip() and b.header == h.header:
            continue
        if b.header != h.header:
            problems.append(f"[{key}] 헤더가 바뀌었다: {b.header!r} → {h.header!r}")
        diff = [
            ln for ln in difflib.unified_diff(
                b.body.strip("\n").splitlines(), h.body.strip("\n").splitlines(),
                lineterm="", n=0,
            )
            if ln[:1] in "+-" and not ln.startswith(("+++", "---"))
        ]
        if diff:
            shown = "\n    ".join(diff[:12]) + ("\n    …" if len(diff) > 12 else "")
            problems.append(f"[{key}] 본문이 바뀌었다:\n    {shown}")
    return problems


def find_intrusions(base_text: str, head_text: str) -> list[Intrusion]:
    """base 에 있던 릴리스 섹션에 head 에서 **순수 추가**된 줄 묶음. 기존 줄 수정·삭제는 대상 아님."""
    out: list[Intrusion] = []
    base = released_sections(base_text)
    for h in parse_sections(head_text):
        b = base.get(h.key)
        if b is None or h.key == UNRELEASED_KEY:
            continue
        b_lines = b.body.splitlines()
        h_lines = h.body.splitlines()
        sm = difflib.SequenceMatcher(a=b_lines, b=h_lines, autojunk=False)
        for tag, _i1, _i2, j1, j2 in sm.get_opcodes():
            if tag != "insert":
                continue
            block = h_lines[j1:j2]
            if not any(ln.strip() for ln in block):
                continue
            # 블록이 자체 소제목을 들고 들어왔으면 그 이름, 아니면 끼어든 위치의 소제목.
            sub = None
            for ln in block:
                m = _SUBHEAD_RE.match(ln)
                if m:
                    sub = m.group("name")
                    break
            if sub is None:
                sub = _subsection_at(h_lines, j1)
            payload = [ln for ln in block if ln.strip() and not _SUBHEAD_RE.match(ln)]
            if payload:
                out.append(Intrusion(version=h.key, subsection=sub, lines=payload))
    return out


def _remove_lines(body: str, to_remove: list[str]) -> str:
    """body 에서 to_remove 줄들(각 1회)을 지우고, 비어 버린 `### 소제목` 과 연속 빈 줄을 정리."""
    lines = body.splitlines()
    for target in to_remove:
        for i, ln in enumerate(lines):
            if ln == target:
                del lines[i]
                break
    cleaned: list[str] = []
    for i, ln in enumerate(lines):
        if _SUBHEAD_RE.match(ln):
            rest = lines[i + 1:]
            nxt = next((x for x in rest if x.strip()), None)
            if nxt is None or _SUBHEAD_RE.match(nxt):
                continue  # 내용 없는 소제목
        cleaned.append(ln)
    out: list[str] = []
    for ln in cleaned:
        if not ln.strip() and out and not out[-1].strip():
            continue
        out.append(ln)
    while out and not out[0].strip():
        out.pop(0)
    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out) + "\n\n"


def _append_to_unreleased(body: str, grouped: dict[str | None, list[str]]) -> str:
    lines = body.rstrip("\n").splitlines()
    for sub, payload in grouped.items():
        if sub is None:
            insert_at = len(lines)
            for i, ln in enumerate(lines):
                if _SUBHEAD_RE.match(ln):
                    insert_at = i
                    break
            lines[insert_at:insert_at] = payload + ([""] if insert_at < len(lines) else [])
            continue
        head_idx = next((i for i, ln in enumerate(lines)
                         if (m := _SUBHEAD_RE.match(ln)) and m.group("name") == sub), None)
        if head_idx is None:
            if lines and lines[-1].strip():
                lines.append("")
            lines.append(f"### {sub}")
            lines.extend(payload)
            continue
        end = len(lines)
        for i in range(head_idx + 1, len(lines)):
            if _SUBHEAD_RE.match(lines[i]):
                end = i
                break
        while end > head_idx + 1 and not lines[end - 1].strip():
            end -= 1
        lines[end:end] = payload
    return "\n".join(lines) + "\n\n"


def rescue(base_text: str, head_text: str) -> tuple[str, list[Intrusion]]:
    """릴리스 섹션에 끼어든 줄을 [Unreleased] 로 옮긴 텍스트와 옮긴 묶음 목록을 돌려준다."""
    intrusions = find_intrusions(base_text, head_text)
    if not intrusions:
        return head_text, []

    by_version: dict[str, list[str]] = {}
    grouped: dict[str | None, list[str]] = {}
    for it in intrusions:
        by_version.setdefault(it.version, []).extend(it.lines)
        grouped.setdefault(it.subsection, []).extend(it.lines)

    # 뒤쪽 섹션부터 고쳐야 앞쪽 오프셋이 안 밀린다.
    text = head_text
    for sec in sorted(parse_sections(text), key=lambda s: s.start, reverse=True):
        if sec.key in by_version:
            new_body = _remove_lines(sec.body, by_version[sec.key])
            text = text[:sec.start] + sec.header + "\n\n" + new_body + text[sec.end:]

    unreleased = next((s for s in parse_sections(text) if s.key == UNRELEASED_KEY), None)
    if unreleased is None:
        raise SystemExit("CHANGELOG.md 에 [Unreleased] 섹션이 없어 구제할 수 없다")
    new_body = _append_to_unreleased(unreleased.body, grouped)
    text = text[:unreleased.start] + unreleased.header + "\n" + new_body + text[unreleased.end:]
    return text, intrusions
