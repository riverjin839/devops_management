#!/usr/bin/env python3
"""PR CI 가드 — 이미 릴리스된 CHANGELOG 섹션이 바뀌면 실패한다.

사용법:
    python3 scripts/release/check_changelog_sections.py <base-ref> [--title "<PR 제목>"]

<base-ref> 의 CHANGELOG.md(PR 의 base) 와 작업 트리의 CHANGELOG.md(PR 을 base 에 머지한 결과)를
비교해, base 에 이미 있던 `## [X.Y.Z]` 섹션의 헤더나 본문이 달라졌으면 종료 코드 1.

- 새 항목은 항상 `## [Unreleased]` 에 추가한다. 머지 결과에서 그 항목이 릴리스 섹션 안에 들어가
  있다면, 브랜치를 만든 뒤 릴리스가 끼어든 것이다 → main 을 머지하고 항목을 [Unreleased] 로 옮긴다.
- 의도적인 위치 정리 PR 은 제목에 `[changelog-fix]` 를 붙인다. `chore(release): …` 도 예외.
로직은 changelog_sections.py, 단위 테스트는 test_changelog_sections.py.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from changelog_sections import EXEMPT_MARKER, is_exempt_title, section_changes  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
CHANGELOG = REPO_ROOT / "CHANGELOG.md"


def read_at(ref: str) -> str | None:
    r = subprocess.run(
        ["git", "show", f"{ref}:CHANGELOG.md"],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )
    return r.stdout if r.returncode == 0 else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base_ref")
    ap.add_argument("--title", default="")
    args = ap.parse_args(argv)

    if is_exempt_title(args.title):
        print(f"예외 PR ({args.title!r}) — 릴리스 섹션 보호 검사 생략")
        return 0

    base_text = read_at(args.base_ref)
    if base_text is None:
        print(f"{args.base_ref} 에 CHANGELOG.md 가 없음 — 검사 생략")
        return 0

    problems = section_changes(base_text, CHANGELOG.read_text(encoding="utf-8"))
    if not problems:
        print("[changelog-sections] OK — 이미 릴리스된 섹션은 그대로다")
        return 0

    print("::error::이미 릴리스된 CHANGELOG 섹션이 바뀌었다.")
    for p in problems:
        print(f"  - {p}")
    print(
        "\n대개 이 브랜치를 만든 뒤 auto-release 가 [Unreleased] 를 새 버전으로 확정했고, 이 PR 의 "
        "항목이 git 머지로 그 섹션 안에 들어간 경우다.\n"
        "  → main 을 머지한 뒤 추가한 항목을 `## [Unreleased]` 아래로 옮긴다.\n"
        f"의도적으로 릴리스 섹션을 고치는 PR 이면 제목에 `{EXEMPT_MARKER}` 를 붙인다."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
