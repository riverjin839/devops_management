#!/usr/bin/env python3
"""머지된 PR 제목(Conventional Commits) → SemVer bump 종류(minor | patch | none) 판정.

.github/workflows/auto-release.yml 의 determine-bump 스텝에서 호출된다.

예전에는 워크플로 안의 bash 패턴이 `feat:*` / `fix:*` 를 **문자 그대로** 비교해서,
scope 가 붙은 `feat(ui): …` · `fix(k8s-allocation): …` 제목은 "인식할 수 없는 prefix"로
릴리스가 조용히 스킵됐다. 그 PR 의 CHANGELOG [Unreleased] 항목은 다음에 우연히 머지된
unscoped PR 의 릴리스에 섞여 나가거나(엉뚱한 버전에 기록), 한동안 미릴리스로 남았다.

규칙 (`type(scope)!: 설명` — scope 와 `!` 는 선택):
  - chore(release)        → none  (release 자동 PR 자신의 머지 — 무한루프 방지)
  - feat                  → minor
  - fix / docs / chore / refactor → patch
  - 그 외(perf, test, ci, 형식 불일치, 대문자 type 등) → none
  - `!`(breaking) 는 인식만 하고 type 기준으로 판정한다 — major 는 bump_version.py 가
    지원하지 않으며 수동 릴리스(.claude/skills/release) 대상이다.

사용법:
    python3 scripts/release/decide_bump.py "<PR title>"
표준출력에 `bump=<minor|patch|none>` 한 줄(GITHUB_OUTPUT 에 그대로 append), 판정 사유는
표준에러. 판정 결과와 무관하게 종료 코드는 0 — 스킵도 정상 결과다.
"""
from __future__ import annotations

import re
import sys

# type 은 소문자만, scope 는 괄호 안 아무 문자(괄호 제외), 이어서 선택적 `!` 와 콜론.
_TITLE_RE = re.compile(r"^(?P<type>[a-z]+)(?:\((?P<scope>[^()]*)\))?(?P<bang>!)?:")

_MINOR_TYPES = {"feat"}
_PATCH_TYPES = {"fix", "docs", "chore", "refactor"}


def decide_bump(title: str) -> tuple[str, str]:
    """PR 제목 → (bump, 사유). bump 는 'minor' | 'patch' | 'none'."""
    t = (title or "").strip()
    if not t:
        return "none", "PR 제목이 비어 있음 — 스킵"
    m = _TITLE_RE.match(t)
    if not m:
        return "none", f"conventional commit 형식이 아님 — 스킵 ({t})"
    ctype, scope = m.group("type"), m.group("scope")
    if ctype == "chore" and scope == "release":
        return "none", "release 자동 PR 자신의 머지 — 무한루프 방지, 스킵"
    label = f"{ctype}({scope})" if scope is not None else ctype
    if ctype in _MINOR_TYPES:
        return "minor", f"{label} → minor"
    if ctype in _PATCH_TYPES:
        return "patch", f"{label} → patch"
    return "none", f"릴리스 대상이 아닌 type '{ctype}' — 스킵 ({t})"


def main(argv: list[str]) -> int:
    title = argv[1] if len(argv) > 1 else ""
    bump, reason = decide_bump(title)
    print(reason, file=sys.stderr)
    print(f"bump={bump}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
