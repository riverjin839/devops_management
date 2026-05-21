"""SupersetChecker — shallow stub. Superset `/health` probe.
Web/worker/beat 컴포넌트별 상태는 carry-over."""
from app.services.lake_checkers.base import LakeBaseChecker


class SupersetChecker(LakeBaseChecker):
    def healthz_path(self) -> str:
        return "/health"
