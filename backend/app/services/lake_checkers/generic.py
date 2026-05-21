"""GenericHealthzChecker — custom LakeServiceType 의 fallback checker.

builtin REGISTRY 에 등록된 8개 외의 service_type 은 운영자가 Settings 에서 추가한
custom type. DB row 의 default_path 를 동적으로 사용해 HTTP GET probe 수행.

Deep check (airflow `/health` JSON components 같은) 는 dev 가 신규 LakeBaseChecker
subclass + LAKE_CHECKER_REGISTRY 등록으로 추가.
"""
from app.services.lake_checkers.base import LakeBaseChecker


class GenericHealthzChecker(LakeBaseChecker):
    """런타임에 healthz_path 가 주입되는 generic probe.

    DB 의 LakeServiceType.default_path 를 router 에서 받아 인스턴스화.
    Custom type 의 health endpoint 가 builtin 패턴과 다를 때 운영자가 Settings 에서
    default_path 를 적절히 설정 (예: /api/v1/status, /healthz, /readyz, /_status/healthz).
    """

    def __init__(self, service, healthz_path: str):
        super().__init__(service)
        # `__init__` 만 override 하고 healthz_path() 가 instance 변수 반환
        self._healthz_path = healthz_path or "/health"

    def healthz_path(self) -> str:
        return self._healthz_path
