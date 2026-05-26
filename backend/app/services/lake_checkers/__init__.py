"""LAKE 서비스 헬스체커 registry.

신규 LAKE 서비스 추가 절차:
 1. 신규 모듈 (예: kafka.py) 에서 LakeBaseChecker 상속 + healthz_path() 구현
 2. 본 __init__.py 의 LAKE_CHECKER_REGISTRY 에 등록
 3. schemas/lake_service.py 의 ServiceType Literal 에 추가
 4. SERVICE_TYPE_CATALOG (이 파일 하단) 에 메타 추가
"""
from app.services.lake_checkers.base import LakeBaseChecker, LakeCheckResult
from app.services.lake_checkers.airflow import AirflowChecker
from app.services.lake_checkers.spark import SparkChecker
from app.services.lake_checkers.iceberg import IcebergChecker
from app.services.lake_checkers.trino import TrinoChecker
from app.services.lake_checkers.starrocks import StarRocksChecker
from app.services.lake_checkers.jupyterlab import JupyterHubChecker
from app.services.lake_checkers.superset import SupersetChecker
from app.services.lake_checkers.polaris import PolarisChecker
from app.services.lake_checkers.generic import GenericHealthzChecker


LAKE_CHECKER_REGISTRY: dict[str, type[LakeBaseChecker]] = {
    "airflow":    AirflowChecker,
    "spark":      SparkChecker,
    "iceberg":    IcebergChecker,
    "trino":      TrinoChecker,
    "starrocks":  StarRocksChecker,
    "jupyterlab": JupyterHubChecker,
    "superset":   SupersetChecker,
    "polaris":    PolarisChecker,
}


# 8 service_type 메타 — /lake-services/types 응답에 사용.
# 신규 서비스 추가 시 이 dict + Checker 클래스 + REGISTRY 1줄로 끝.
SERVICE_TYPE_CATALOG: dict[str, dict] = {
    "airflow": {
        "label": "Apache Airflow",
        "category": "runtime",
        "default_path": "/health",
        "description": "워크플로우 오케스트레이션 (DAG scheduler/worker/triggerer)",
    },
    "spark": {
        "label": "Apache Spark",
        "category": "runtime",
        "default_path": "/api/v1/applications",
        "description": "분산 컴퓨팅 (master/worker/history server)",
    },
    "iceberg": {
        "label": "Apache Iceberg",
        "category": "catalog",
        "default_path": "/v1/config",
        "description": "테이블 포맷 REST catalog",
    },
    "trino": {
        "label": "Trino",
        "category": "analytics",
        "default_path": "/v1/info",
        "description": "분산 SQL 쿼리 엔진 (coordinator/worker)",
    },
    "starrocks": {
        "label": "StarRocks",
        "category": "analytics",
        "default_path": "/api/health",
        "description": "OLAP MPP 분석 DB (FE/BE)",
    },
    "jupyterlab": {
        "label": "JupyterHub",
        "category": "analytics",
        "default_path": "/hub/health",
        "description": "Jupyter notebook hub + user pods",
    },
    "superset": {
        "label": "Apache Superset",
        "category": "analytics",
        "default_path": "/health",
        "description": "BI 대시보드 (web/worker/beat)",
    },
    "polaris": {
        "label": "Apache Polaris",
        "category": "catalog",
        "default_path": "/api/management/v1/health",
        "description": "Apache Polaris catalog (management REST)",
    },
}


def get_checker_class(service_type: str) -> type[LakeBaseChecker] | None:
    """service_type → builtin LakeChecker 클래스. 없으면 None.

    Custom type (DB-driven, REGISTRY 미등록) 는 router 가 GenericHealthzChecker
    를 직접 instantiate 해야 함 — `build_checker(svc_type, default_path, service)`
    를 사용.
    """
    return LAKE_CHECKER_REGISTRY.get(service_type)


def build_checker(service, type_default_path: str | None = None):
    """service.service_type 에 맞는 checker 인스턴스 생성.

    1. builtin (REGISTRY hit) → 기존 클래스(service) 인스턴스
    2. custom (REGISTRY miss) → GenericHealthzChecker(service, healthz_path)
       — healthz_path 는 type_default_path 우선, 없으면 '/health'

    router 가 LakeServiceType DB row 의 default_path 를 type_default_path 로 전달.
    """
    cls = LAKE_CHECKER_REGISTRY.get(service.service_type)
    if cls is not None:
        return cls(service)
    # Custom type — GenericHealthzChecker fallback
    return GenericHealthzChecker(service, type_default_path or "/health")


def get_category_for(service_type: str) -> str:
    """service_type → category 자동 결정. 미지정 시 'runtime'."""
    return SERVICE_TYPE_CATALOG.get(service_type, {}).get("category", "runtime")


__all__ = [
    "LakeBaseChecker",
    "LakeCheckResult",
    "GenericHealthzChecker",
    "LAKE_CHECKER_REGISTRY",
    "SERVICE_TYPE_CATALOG",
    "get_checker_class",
    "get_category_for",
    "build_checker",
]
