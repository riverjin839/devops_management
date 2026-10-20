#!/usr/bin/env python3
"""모달은 공용 어댑터로만 만든다 — R-2(shadcn/ui 확산) 종료 기준의 회귀 방지 검사.

`aria-modal` 이 붙은 요소(=모달)를 그리는 .tsx 파일은 아래 중 하나를 써야 한다:
  - shadcn `components/ui/dialog`(Base UI 래퍼 — 포커스 트랩·Escape·뒤로가기 닫기 내장)
  - 자체 마크업이면 `useModalA11y`(Escape·포커스 트랩·겹친 모달 순서·뒤로가기, DESIGN_SYSTEM §12.13)
  - 포커스 트랩을 이미 가진 UI 면 `useModalHistory`

팝오버·드롭다운(`role="dialog"` 이지만 `aria-modal` 없음)은 대상이 아니다. 예외가 필요하면 아래
ALLOWED 에 사유와 함께 등록한다.

사용: python3 scripts/ui/check_dialogs.py  (CI frontend job 에서 실행)
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "frontend" / "src"

ADAPTERS = re.compile(r"useModalA11y|useModalHistory|@/components/ui/dialog|from '\./dialog'|@base-ui")
MODAL = re.compile(r"aria-modal(=\"true\"|=\{true\}|\s|>|=\{)")

# 경로(SRC 기준) → 사유. 어댑터 자체 구현 파일만 둔다.
ALLOWED: dict[str, str] = {
    "components/ui/dialog.tsx": "shadcn Dialog 래퍼 자체",
    "components/common/useModalA11y.ts": "어댑터 훅 자체",
}


def main() -> int:
    bad: list[str] = []
    for p in sorted(SRC.rglob("*.tsx")):
        rel = p.relative_to(SRC).as_posix()
        if rel in ALLOWED:
            continue
        text = p.read_text(encoding="utf-8")
        if MODAL.search(text) and not ADAPTERS.search(text):
            line = next(i for i, l in enumerate(text.splitlines(), 1) if MODAL.search(l))
            bad.append(f"frontend/src/{rel}:{line}")
    if bad:
        print("[check-dialogs] 실패 — 공용 어댑터 없이 그린 모달(aria-modal):")
        for b in bad:
            print(f"  - {b}")
        print("해결: `components/ui/dialog` 를 쓰거나, 자체 마크업이면 `useModalA11y(open, onClose)` 의 ref 를 "
              "모달 컨테이너에 연결한다(DESIGN_SYSTEM §12.13·R-2).")
        return 1
    print("[check-dialogs] OK — 모든 모달이 공용 어댑터를 쓴다")
    return 0


if __name__ == "__main__":
    sys.exit(main())
