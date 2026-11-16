"""DC 인벤토리 도메인 예외 — 라우터가 HTTP 상태로 옮긴다(빈 500 금지)."""
from __future__ import annotations

from typing import Any


class DcError(Exception):
    status_code = 400

    def __init__(self, detail: str, *, code: str = "invalid", conflict: dict[str, Any] | None = None,
                 column: str | None = None):
        super().__init__(detail)
        self.detail = detail
        self.code = code
        self.conflict = conflict
        self.column = column  # 일괄 등록에서 오류 열을 가리킬 때

    def payload(self) -> dict[str, Any]:
        out: dict[str, Any] = {"message": self.detail, "code": self.code}
        if self.conflict:
            out["conflict"] = self.conflict
        return out


class DcInvalid(DcError):
    """값이 규칙에 맞지 않는다 (422)."""

    status_code = 422


class DcConflict(DcError):
    """다른 행과 충돌한다 (409)."""

    status_code = 409


class DcNotFound(DcError):
    status_code = 404

    def __init__(self, detail: str):
        super().__init__(detail, code="not_found")
