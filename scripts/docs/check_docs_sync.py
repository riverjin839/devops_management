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
  6. celery_app.py 의 beat_schedule 엔트리가 CLAUDE.md 표에 전수 기재됐는가
  7. config.py 의 Settings 필드가 docs/ENVIRONMENT.md 에 전수 기재됐는가
  8. CLAUDE.md 에 썩기 쉬운 개수 표현("라우터 65개" 등)이 되살아나지 않았는가

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
    "/settings/users",  # 구 독립 페이지 → Settings "시스템 담당자" ▸ 로그인 계정 서브탭으로 통합, /settings?tab=assignee 로 redirect
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


def check_celery_beat(errors: list[str]) -> None:
    """beat_schedule 엔트리가 CLAUDE.md 의 Celery Tasks 표에 전수 기재됐는지.

    과거 CLAUDE.md 가 "Beat 스케줄 6개"/"7개" 라고 서로 다르게 적어둔 채 실제 9개로
    늘어난 적이 있다 — 개수 대신 엔트리 이름 자체를 대조해 드리프트를 막는다.
    """
    celery = (ROOT / "backend/app/celery_app.py").read_text(encoding="utf-8")
    claude = (ROOT / "CLAUDE.md").read_text(encoding="utf-8")
    start = celery.find("beat_schedule")
    if start == -1:
        return
    entries = re.findall(r'^\s{4}["\']([\w-]+)["\']:\s*\{', celery[start:], re.M)
    for e in entries:
        if f"`{e}`" not in claude:
            errors.append(
                f"CLAUDE.md: Celery Beat 엔트리 `{e}` 미기재 (celery_app.py 에 존재). "
                "§Celery Tasks 표에 주기·역할과 함께 추가할 것."
            )


def check_env_vars(errors: list[str]) -> None:
    """config.py 의 Settings 필드가 docs/ENVIRONMENT.md 에 전수 기재됐는지."""
    config = (ROOT / "backend/app/config.py").read_text(encoding="utf-8")
    env_doc = (ROOT / "docs/ENVIRONMENT.md").read_text(encoding="utf-8")
    m = re.search(r"class Settings\(BaseSettings\):(.*?)(?:\nclass |\Z)", config, re.S)
    if not m:
        return
    fields = re.findall(r"^\s{4}([a-z][a-z0-9_]*)\s*:", m.group(1), re.M)
    for f in fields:
        if f.upper() not in env_doc:
            errors.append(
                f"docs/ENVIRONMENT.md: 환경변수 `{f.upper()}` 미기재 (config.py Settings 에 존재). "
                "표에 기본값·설명과 함께 추가하고 .env.example 도 함께 확인할 것."
            )


# 커밋마다 썩는 개수 표현 — 문서에 두지 않는다(직접 세면 되는 정보).
# 과거 라우터 64/65, 태스크 13/16, 체커 16, 테스트 13 처럼 파일 안에서 서로 모순된 채
# 방치돼 에이전트가 어느 쪽도 신뢰하지 못하는 상태가 됐다.
STALE_COUNT_PATTERNS = [
    r"라우터\s*~?\d+\s*개",
    r"모델\s*~?\d+\s*개",
    r"페이지\s*~?\d+\s*개",
    r"라우트\s*~?\d+\s*개",
    r"훅\s*~?\d+\s*개",
    r"테스트\s*모듈\s*~?\d+\s*개",
    r"태스크는?\s*~?\d+\s*개",
    r"스케줄\s*~?\d+\s*개",
    r"체커\s*~?\d+\s*[개종]",
    r"점검\s*~?\d+\s*종",
    r"APIRouter\s*~?\d+\s*개",
]


def check_stale_counts(errors: list[str]) -> None:
    claude = (ROOT / "CLAUDE.md").read_text(encoding="utf-8").split("\n")
    for lineno, line in enumerate(claude, 1):
        if line.lstrip().startswith(">"):
            continue  # 규칙을 설명하는 인용 블록 자체는 예외
        for pat in STALE_COUNT_PATTERNS:
            hit = re.search(pat, line)
            if hit:
                errors.append(
                    f"CLAUDE.md:{lineno}: 개수 표현 \"{hit.group(0)}\" — 커밋마다 썩는다. "
                    "개수 대신 항목 이름을 나열하거나 문장을 개수 없이 다시 쓸 것."
                )


def main() -> int:
    errors: list[str] = []
    check_screens(errors)
    check_code_map(errors)
    check_docs_index(errors)
    check_versions(errors)
    check_celery_beat(errors)
    check_env_vars(errors)
    check_stale_counts(errors)
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
