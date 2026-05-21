"""TrinoChecker — shallow stub. `/v1/info` 가 200 + uptime/version JSON 반환.
Coordinator/worker 카운트 + catalog 등록 상태는 carry-over."""
from app.services.lake_checkers.base import LakeBaseChecker


class TrinoChecker(LakeBaseChecker):
    def healthz_path(self) -> str:
        return "/v1/info"
