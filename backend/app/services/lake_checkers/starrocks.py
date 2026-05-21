"""StarRocksChecker — shallow stub. FE `/api/health` probe.
FE/BE 노드 수 + compaction/replication 상태는 carry-over."""
from app.services.lake_checkers.base import LakeBaseChecker


class StarRocksChecker(LakeBaseChecker):
    def healthz_path(self) -> str:
        return "/api/health"
