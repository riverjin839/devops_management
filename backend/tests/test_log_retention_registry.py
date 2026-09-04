"""로그성 테이블 등록 정합성 — 효율화 샘플/실행 로그가 purge · backup 양쪽에 빠짐없이 등록됐는지."""
from app.services import backup_service, log_retention_service as lrs

NEW_LOG_TABLES = ("k8s_ns_samples", "k8s_workload_samples", "k8s_efficiency_runs")


def test_new_tables_registered_for_retention_and_backup():
    for t in NEW_LOG_TABLES:
        assert t in lrs.RETENTION_DAYS, f"{t} 보존기간 미등록"
        assert t in backup_service.LOG_TABLES, f"{t} backup LOG_TABLES 미등록"
    # 워크로드 샘플(대용량 JSONB)은 추천 윈도(7일) 이상, NS 샘플은 추이 분석용으로 길게
    assert lrs.RETENTION_DAYS["k8s_workload_samples"] >= 7
    assert lrs.RETENTION_DAYS["k8s_ns_samples"] > lrs.RETENTION_DAYS["k8s_workload_samples"]


def test_purge_targets_include_new_tables():
    import inspect
    src = inspect.getsource(lrs.purge_all)
    for t in NEW_LOG_TABLES:
        assert f'"{t}"' in src, f"purge_all simple_targets 에 {t} 없음"
