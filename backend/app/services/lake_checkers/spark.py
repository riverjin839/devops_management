"""SparkChecker — shallow stub. Spark master `/api/v1/applications` 가
200 + JSON array 면 healthy. 깊은 정보(worker count, executor 메모리 등) 는
carry-over (`lake-spark-deep-check` PDCA)."""
from app.services.lake_checkers.base import LakeBaseChecker


class SparkChecker(LakeBaseChecker):
    def healthz_path(self) -> str:
        return "/api/v1/applications"
