#!/usr/bin/env python3
"""버전 3곳 + CHANGELOG 최신 섹션이 한 버전으로 맞는지 검사한다 (CI docs-sync job).

    python3 scripts/release/check_versions.py

검사:
    - frontend/package.json 최상위 "version" 키가 정확히 1개
    - backend/app/main.py 의 FastAPI(version="…") 와 root() 응답 "version" 이 각각 정확히 1개
    - 세 값과 CHANGELOG.md 의 [Unreleased] 다음 첫 `## [X.Y.Z]` 가 모두 같다

왜: 동시에 돈 auto-release 두 실행이 같은 버전 파일을 고쳐 릴리스 PR 하나가 충돌로 남았고,
그 PR 을 GitHub UI 에서 "양쪽 다 남기기"로 풀어 머지하자 `version=` 인자가 두 번 들어가
backend/app/main.py 가 SyntaxError 가 됐다(1.64.2/1.66.0 사례). JSON 중복 키는 파서가 조용히
뒤 값을 쓰므로 빌드로는 잡히지 않는다. `chore(release):` PR 도 예외 없이 검사한다.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_JSON = REPO_ROOT / "frontend" / "package.json"
MAIN_PY = REPO_ROOT / "backend" / "app" / "main.py"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"

# 최상위 키만 — package.json 은 2칸 들여쓰기 포맷이다(npm 이 그렇게 쓴다).
PKG_VERSION_RE = re.compile(r'^  "version":\s*"([^"]+)"', re.MULTILINE)
APP_VERSION_RE = re.compile(r'^\s+version="([^"]+)"', re.MULTILINE)
ROOT_VERSION_RE = re.compile(r'^\s+"version":\s*"([^"]+)"', re.MULTILINE)
RELEASED_RE = re.compile(r"^## \[(\d+\.\d+\.\d+)\]", re.MULTILINE)


def check(package_json: str, main_py: str, changelog: str) -> list[str]:
    """어긋난 점을 사람이 읽을 문장 목록으로 돌려준다(비면 정상)."""
    errors: list[str] = []
    found: dict[str, str] = {}

    for label, regex, text in (
        ("frontend/package.json \"version\"", PKG_VERSION_RE, package_json),
        ("backend/app/main.py FastAPI(version=…)", APP_VERSION_RE, main_py),
        ("backend/app/main.py root() \"version\"", ROOT_VERSION_RE, main_py),
    ):
        values = regex.findall(text)
        if len(values) != 1:
            errors.append(f"{label}: 정확히 1개여야 하는데 {len(values)}개 ({', '.join(values) or '없음'})")
        if values:
            found[label] = values[-1]

    released = RELEASED_RE.search(changelog)
    if released:
        found["CHANGELOG.md 최신 릴리스 섹션"] = released.group(1)
    else:
        errors.append("CHANGELOG.md: `## [X.Y.Z]` 릴리스 섹션을 찾지 못함")

    if len(set(found.values())) > 1:
        errors.append("버전이 서로 다름 — " + ", ".join(f"{k}={v}" for k, v in found.items()))
    return errors


def main() -> int:
    errors = check(
        PACKAGE_JSON.read_text(encoding="utf-8"),
        MAIN_PY.read_text(encoding="utf-8"),
        CHANGELOG.read_text(encoding="utf-8"),
    )
    for e in errors:
        print(f"::error::{e}")
    if errors:
        print("버전 3곳(frontend/package.json, backend/app/main.py ×2)과 CHANGELOG.md 최신 섹션을 한 버전으로 맞추세요.")
        return 1
    print("versions OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
