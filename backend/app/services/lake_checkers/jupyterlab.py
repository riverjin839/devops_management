"""JupyterHubChecker — shallow stub. JupyterHub `/hub/health` probe.
User pod 카운트 + 리소스 사용량은 carry-over."""
from app.services.lake_checkers.base import LakeBaseChecker


class JupyterHubChecker(LakeBaseChecker):
    def healthz_path(self) -> str:
        return "/hub/health"
