#!/usr/bin/env python3
"""문서-코드 동기화 검사기 (docs guard).

코드 구조와 저장소 문서(README/CLAUDE.md/CODE_MAP.md/docs/*)가 어긋나면
CI 를 실패시켜 "기능은 추가됐는데 문서는 안 고친" 드리프트를 조기에 잡는다.

검사 항목:
  1. frontend/src/App.tsx 의 모든 라우트가 docs/SCREENS.md 에 섹션으로 존재하는가
  2. backend/app/routers/*.py 가 CODE_MAP.md 에 언급되는가
  3. frontend/src/pages/*.tsx 가 CODE_MAP.md 에 언급되는가
  4. docs/ 최상위 *.md 가 docs/README.md 인덱스에 링크되어 있는가
  5. frontend/package.json 과 backend/app/main.py 의 버전이 일치하는가

새 라우트/라우터/페이지를 추가하면 해당 문서도 같이 갱신해야 이 검사가 통과한다.
의도적으로 문서화를 미루는 항목은 아래 EXEMPT_* 목록에 사유와 함께 추가한다.

사용법: python3 scripts/docs/check_docs_sync.py   (레포 루트 기준 상대경로 자동 탐지)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# 문서화 대상에서 제외할 항목 — 반드시 사유를 주석으로 남길 것
EXEMPT_ROUTES = {
    "*",        # NotFound catch-all
    "/tasks",   # /tasks-mgmt 로 리다이렉트되는 레거시 alias
    "/issues",  # /tasks-mgmt 로 리다이렉트되는 레거시 alias
    "/work-items", "/work-items/:id", "/work-items/:id/edit", "/work-items/new",  # 레거시 alias → /tasks-mgmt
    "/k8s-resources", "/k8s-resources/:clusterId",  # 구 리소스 탐색기 → /k8s-manage 로 통합·redirect
    "/tasks-mgmt/:id/edit",  # 상세 페이지 ?edit=1 로 redirect (독립 화면 아님)
}
EXEMPT_ROUTERS = {"__init__.py"}
EXEMPT_PAGES: set[str] = set()
EXEMPT_DOCS = {"README.md"}  # 인덱스 자기 자신


def fail(msgs: list[str]) -> None:
    for m in msgs:
        print(f"  - {m}")


def check_screens(errors: list[str]) -> None:
    app_tsx = (ROOT / "frontend/src/App.tsx").read_text(encoding="utf-8")
    screens = (ROOT / "docs/SCREENS.md").read_text(encoding="utf-8")
    routes = sorted(set(re.findall(r'path="([^"]+)"', app_tsx)) - EXEMPT_ROUTES)
    missing = [r for r in routes if f"`{r}`" not in screens]
    for r in missing:
        errors.append(
            f"docs/SCREENS.md: 라우트 `{r}` 섹션 없음 (App.tsx 에 존재). "
            "화면 명세 섹션을 추가하거나 EXEMPT_ROUTES 에 사유와 함께 등록."
        )


def check_code_map(errors: list[str]) -> None:
    code_map = (ROOT / "CODE_MAP.md").read_text(encoding="utf-8")
    routers = sorted(
        p.name for p in (ROOT / "backend/app/routers").glob("*.py") if p.name not in EXEMPT_ROUTERS
    )
    for r in routers:
        if r not in code_map:
            errors.append(f"CODE_MAP.md: backend/app/routers/{r} 미기재")
    pages = sorted(
        p.name for p in (ROOT / "frontend/src/pages").glob("*.tsx") if p.name not in EXEMPT_PAGES
    )
    for p in pages:
        if p not in code_map:
            errors.append(f"CODE_MAP.md: frontend/src/pages/{p} 미기재")


def check_docs_index(errors: list[str]) -> None:
    index = (ROOT / "docs/README.md").read_text(encoding="utf-8")
    for doc in sorted((ROOT / "docs").glob("*.md")):
        if doc.name in EXEMPT_DOCS:
            continue
        if doc.name not in index:
            errors.append(f"docs/README.md: {doc.name} 인덱스 누락")


def check_versions(errors: list[str]) -> None:
    pkg = json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))
    fe_ver = pkg.get("version", "")
    main_py = (ROOT / "backend/app/main.py").read_text(encoding="utf-8")
    m = re.search(r'version="([^"]+)"', main_py)
    be_ver = m.group(1) if m else "(못 찾음)"
    if fe_ver != be_ver:
        errors.append(
            f"버전 불일치: frontend/package.json={fe_ver} vs backend/app/main.py={be_ver} "
            "(scripts/release/bump_version.py 로 함께 올릴 것)"
        )


def main() -> int:
    errors: list[str] = []
    check_screens(errors)
    check_code_map(errors)
    check_docs_index(errors)
    check_versions(errors)
    if errors:
        print(f"[docs-sync] 실패 — {len(errors)}건의 문서-코드 드리프트:")
        fail(errors)
        print(
            "\n해결: 해당 문서를 갱신하거나(권장), 의도된 예외면 "
            "scripts/docs/check_docs_sync.py 의 EXEMPT_* 에 사유와 함께 추가."
        )
        return 1
    print("[docs-sync] OK — 문서와 코드 구조가 동기화되어 있음")
    return 0


if __name__ == "__main__":
    sys.exit(main())
