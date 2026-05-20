"""Super Pod 엔트리포인트 — ``python -m app.superpod.runner``.

SUPERPOD_MODE 환경변수에 따라 두 가지 모드로 동작:

* ``in_cluster``  — 대상 클러스터 내부에서 실행. load_incluster_config() 로 K8s 접근,
                    결과를 SUPERPOD_INGEST_URL 로 POST.
* ``centralized`` — 관리 클러스터에서 실행. DB 에서 모든 Cluster 행을 읽어 kubeconfig 로
                    각 클러스터를 점검하고 결과를 직접 DB 에 저장.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from datetime import datetime
from typing import Any

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("superpod")


def main() -> int:
    mode = os.environ.get("SUPERPOD_MODE", "centralized").strip().lower()
    logger.info("Super Pod starting (mode=%s)", mode)

    if mode == "in_cluster":
        return _run_in_cluster()
    elif mode == "centralized":
        return _run_centralized()
    else:
        logger.error("Unknown SUPERPOD_MODE=%r — expected in_cluster|centralized", mode)
        return 2


# ───────────────────────────────────────────────────────────────
# in_cluster 모드
# ───────────────────────────────────────────────────────────────

def _run_in_cluster() -> int:
    """대상 클러스터 내부에서 모든 enabled check 를 실행하고 관리 backend 로 push."""
    from app.services.deep_checkers import REGISTRY, DeepCheckContext

    ingest_url = os.environ.get("SUPERPOD_INGEST_URL", "").strip()
    ingest_token = os.environ.get("SUPERPOD_INGEST_TOKEN", "").strip()
    cluster_id = os.environ.get("SUPERPOD_CLUSTER_ID", "").strip()

    if not ingest_url or not cluster_id:
        logger.error("SUPERPOD_INGEST_URL and SUPERPOD_CLUSTER_ID required for in_cluster mode")
        return 2

    # in-cluster 모드는 DB 가 없으므로 정의 셋을 환경에서 받지 못한다.
    # 기본 정의 = registry 의 모든 check_type 을 기본 임계/파라미터로 1회씩 수행.
    results: list[dict[str, Any]] = []
    for check_type, (cls, spec) in REGISTRY.items():
        ctx = DeepCheckContext(
            cluster=None,
            thresholds=dict(spec.default_thresholds),
            params=dict(spec.default_params),
            in_cluster=True,
        )
        outcome = cls().safe_run(ctx)
        results.append({
            "check_type": check_type,
            "status": outcome.status.value,
            "message": outcome.message,
            "details": outcome.details,
            "duration_ms": outcome.duration_ms,
        })
        logger.info("%s → %s (%dms)", check_type, outcome.status.value, outcome.duration_ms)

    payload = {
        "cluster_id": cluster_id,
        "executed_at": datetime.utcnow().isoformat(),
        "results": results,
    }

    from app.superpod.ingest_client import post_ingest
    ack = post_ingest(ingest_url, ingest_token, payload)
    logger.info("Ingest ack: %s", json.dumps(ack)[:1000])
    return 0 if ack.get("status") == "ok" else 1


# ───────────────────────────────────────────────────────────────
# centralized 모드
# ───────────────────────────────────────────────────────────────

def _run_centralized() -> int:
    """관리 클러스터에서 등록된 모든 Cluster 행에 대해 deep check 실행."""
    from app.database import SessionLocal
    from app.models import Cluster
    from app.services.deep_check_service import DeepCheckService

    db = SessionLocal()
    rc = 0
    try:
        svc = DeepCheckService(db)
        for cluster in db.query(Cluster).all():
            try:
                n, _log_id = asyncio.run(svc.run_for_cluster(str(cluster.id), in_cluster=False))
                logger.info("Cluster %s: %d checks executed (log=%s)", cluster.name, n, _log_id)
            except Exception as e:
                logger.exception("Cluster %s failed: %s", cluster.name, e)
                rc = 1
    finally:
        db.close()
    return rc


if __name__ == "__main__":
    sys.exit(main())
