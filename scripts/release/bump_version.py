#!/usr/bin/env python3
"""SemVer 버전을 올리고 CHANGELOG.md 의 [Unreleased] 섹션을 새 버전 섹션으로 확정한다.

.github/workflows/auto-release.yml 에서 호출된다 (PR 머지 시 자동 실행).
docs/branch-tag-strategy.md / .claude/skills/release/SKILL.md 의 수동 절차와 동일한 결과를
만들어낸다 — "버전 3곳"(frontend/package.json, backend/app/main.py 2곳) + CHANGELOG.md 섹션 확정.

사용법:
    python3 scripts/release/bump_version.py <minor|patch> [--dry-run]

동작:
    - Unreleased 섹션에 실제 변경 항목("- " 로 시작하는 불릿)이 하나도 없으면 아무것도 바꾸지
      않고 종료 코드 3 으로 끝난다 (호출자가 "릴리즈할 내용 없음"으로 판단해 스킵하도록).
    - 버전 문자열을 못 찾거나 예상 개수(1/2)와 다르게 매칭되면 예외로 즉시 실패한다
      (조용히 일부만 바뀌는 상황을 막기 위해).
    - 표준출력에 `new_version=X.Y.Z` 한 줄을 출력해 호출자가 파싱할 수 있게 한다.
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_JSON = REPO_ROOT / "frontend" / "package.json"
MAIN_PY = REPO_ROOT / "backend" / "app" / "main.py"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"

UNRELEASED_HEADER = "## [Unreleased]"
# 태그라인은 직전 릴리스 버전을 가리켜야 하므로 매 bump 마다 새로 만든다 — 하드코딩하면
# 첫 자동 릴리스 이후 "1.0.0 이후" 로 계속 고정돼 실제 최신 버전과 어긋난다.
UNRELEASED_TAGLINE_RE = re.compile(
    r"^\S+ 이후 main 에 병합된 변경 \((?:다음 마이너 릴리스 후보|다음 릴리스 후보)\)\.\s*$",
    re.MULTILINE,
)


def unreleased_tagline(version: str) -> str:
    return f"{version} 이후 main 에 병합된 변경 (다음 릴리스 후보)."


NEXT_HEADER_RE = re.compile(r"^## \[", re.MULTILINE)
BULLET_RE = re.compile(r"^- ", re.MULTILINE)


def read_current_version() -> str:
    data = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    version = data.get("version")
    if not version:
        raise SystemExit("frontend/package.json 에 version 필드가 없습니다.")
    return version


def bump(version: str, kind: str) -> str:
    parts = version.split(".")
    if len(parts) != 3:
        raise SystemExit(f"버전 형식이 X.Y.Z 가 아닙니다: {version!r}")
    major, minor, patch = (int(p) for p in parts)
    if kind == "minor":
        minor += 1
        patch = 0
    elif kind == "patch":
        patch += 1
    else:
        raise SystemExit(f"알 수 없는 bump kind: {kind!r} (minor|patch 만 허용)")
    return f"{major}.{minor}.{patch}"


def update_package_json(old: str, new: str, dry_run: bool) -> None:
    text = PACKAGE_JSON.read_text(encoding="utf-8")
    pattern = re.compile(r'("version":\s*")' + re.escape(old) + r'(")')
    new_text, n = pattern.subn(r"\g<1>" + new + r"\g<2>", text)
    if n != 1:
        raise SystemExit(f"frontend/package.json 에서 version 필드를 정확히 1개 찾지 못함 (매칭 {n}개)")
    if not dry_run:
        PACKAGE_JSON.write_text(new_text, encoding="utf-8")


def update_main_py(old: str, new: str, dry_run: bool) -> None:
    text = MAIN_PY.read_text(encoding="utf-8")
    app_pattern = re.compile(r'version="' + re.escape(old) + r'"')
    text, n1 = app_pattern.subn(f'version="{new}"', text)
    root_pattern = re.compile(r'("version":\s*")' + re.escape(old) + r'(")')
    text, n2 = root_pattern.subn(r"\g<1>" + new + r"\g<2>", text)
    if n1 != 1 or n2 != 1:
        raise SystemExit(
            f"backend/app/main.py 버전 문자열 매칭 개수가 예상과 다름 "
            f"(FastAPI version= : {n1}개, root() 응답 : {n2}개, 각각 1개여야 함)"
        )
    if not dry_run:
        MAIN_PY.write_text(text, encoding="utf-8")


def update_changelog(new_version: str, dry_run: bool) -> bool:
    """CHANGELOG.md 를 갱신한다. Unreleased 섹션에 실제 항목이 없으면 False 를 반환하고 아무것도 바꾸지 않는다."""
    text = CHANGELOG.read_text(encoding="utf-8")

    header_idx = text.find(UNRELEASED_HEADER)
    if header_idx == -1:
        raise SystemExit(f"CHANGELOG.md 에서 '{UNRELEASED_HEADER}' 섹션을 찾지 못함")
    content_start = header_idx + len(UNRELEASED_HEADER)

    next_match = NEXT_HEADER_RE.search(text, content_start)
    if not next_match:
        raise SystemExit("CHANGELOG.md 에서 Unreleased 다음 '## [' 섹션을 찾지 못함")
    next_header_start = next_match.start()

    block = text[content_start:next_header_start]

    if not BULLET_RE.search(block):
        return False

    # 태그라인 문장(버전 참조가 있어 릴리즈 섹션엔 남기지 않음)을 제외한 나머지가 실제 릴리즈 내용.
    body = UNRELEASED_TAGLINE_RE.sub("", block, count=1).strip("\n")
    body = body.strip()

    date_str = datetime.date.today().isoformat()
    new_section = f"## [{new_version}] - {date_str}\n\n{body}\n\n"
    new_unreleased = f"{UNRELEASED_HEADER}\n\n{unreleased_tagline(new_version)}\n\n"

    new_text = text[:header_idx] + new_unreleased + new_section + text[next_header_start:]
    if not dry_run:
        CHANGELOG.write_text(new_text, encoding="utf-8")
    else:
        print("---- CHANGELOG.md dry-run 미리보기 (Unreleased 리셋 + 새 섹션) ----")
        print(new_unreleased + new_section[: len(new_section)])
        print("---- (이하 기존 내용 이어짐) ----")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("bump_kind", choices=["minor", "patch"])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    old_version = read_current_version()
    new_version = bump(old_version, args.bump_kind)

    has_content = update_changelog(new_version, args.dry_run)
    if not has_content:
        print("skip=true", file=sys.stderr)
        print("Unreleased 섹션에 실제 변경 항목이 없어 릴리즈를 스킵합니다.", file=sys.stderr)
        return 3

    update_package_json(old_version, new_version, args.dry_run)
    update_main_py(old_version, new_version, args.dry_run)

    print(f"old_version={old_version}")
    print(f"new_version={new_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
