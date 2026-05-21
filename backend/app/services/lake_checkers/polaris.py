"""PolarisChecker — shallow stub. Apache Polaris management `/api/management/v1/health`.
Namespace/permission/catalog REST 검증은 carry-over."""
from app.services.lake_checkers.base import LakeBaseChecker


class PolarisChecker(LakeBaseChecker):
    def healthz_path(self) -> str:
        return "/api/management/v1/health"
