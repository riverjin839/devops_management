"""IcebergChecker — shallow stub. REST catalog `/v1/config` probe.
Catalog 카탈로그 namespace/permission 검증은 carry-over."""
from app.services.lake_checkers.base import LakeBaseChecker


class IcebergChecker(LakeBaseChecker):
    def healthz_path(self) -> str:
        return "/v1/config"
