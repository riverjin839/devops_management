"""클러스터 종합 상태(Cluster.status) 단일 롤업.

과거엔 `DailyChecker`(core_bundle)와 `HealthChecker`(addon)가 각자 `Cluster.status` 를 직접
덮어썼다 — 실행 순서에 따라 서로의 판정을 지우고(마지막에 실행된 쪽이 이김), `HealthChecker`
의 애드온 단일 실행(`run_single_addon_check`)은 핵심 번들의 reachability 판정 없이 애드온
결과만으로 클러스터 전체 상태를 다시 계산해 비대칭이 있었다. `DeepCheckService`(심층 점검)는
`Cluster.status` 를 전혀 반영하지 않아 클러스터가 warning/critical 인 이유에 심층 점검 결과가
전혀 나타나지 않는 문제도 있었다.

`recompute()` 하나가 이 세 도메인의 최신 신호를 모아 우선순위(critical > warning > healthy)로
집계하고 `Cluster.status` 를 1회만 기록한다. `DailyChecker`/`HealthChecker`/`DeepCheckService`
세 곳 모두 자기 도메인 결과를 커밋(또는 flush)한 뒤 이 함수만 호출한다 — 직접 `cluster.status`
를 대입하지 않는다.

opt-in 정책: 심층 점검은 `DeepCheckDefinition.affects_cluster_status=True` 인 정의만 집계
대상이다(기본 False — 운영자가 명시적으로 "클러스터 상태에 반영"을 켠 점검만). 점검 매트릭스의
배치잡·플레이북·수동 입력 행은 `CheckMatrixItem.affects_cluster_status=True` 인 행만 반영한다.
애드온은 기존과 동일하게 항상 반영된다(클러스터별 인스턴스라 opt-in 개념이 없음).
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import Addon, Cluster, DailyCheckLog, DeepCheckDefinition, DeepCheckResult, StatusEnum


def _core_bundle_message(log: DailyCheckLog) -> str:
    if log.overall_status == StatusEnum.critical:
        msgs = log.error_messages or []
        return msgs[0] if msgs else "핵심 점검 번들에서 심각 상태가 감지됐습니다."
    if log.overall_status == StatusEnum.warning:
        msgs = log.warning_messages or []
        return msgs[0] if msgs else "핵심 점검 번들에서 경고가 감지됐습니다."
    return "정상입니다."


def _status_definition_groups(db: Session, cluster_id) -> list[dict[str, Any]]:
    """`affects_cluster_status=True` 인 정의를 "계보" 단위로 묶는다 — 클러스터 전용이 글로벌보다 우선.

    예전엔 check_type 하나당 정의 하나로 접어, 같은 종류의 커스텀 카드 둘(A·B)이 있으면 하나만 남았고
    결과도 check_type 의 최신 1건을 읽었다 — 10:00 A 위험, 10:01 B 정상이면 클러스터가 정상으로 보였다.

    - 매트릭스 행이 전용으로 문 정의(``CheckMatrixItem.definition_id``)와 그 오버라이드(parent_id)는
      그 정의의 계보 하나로 묶는다.
    - 그 밖의 공유 정의는 예전처럼 check_type 단위(클러스터 전용 사본 우선) — 셀 편집이 만드는 공유
      정의의 클러스터 사본은 parent_id 가 없으므로 check_type 으로 묶어야 같은 계보가 된다.
    """
    from app.models import CheckMatrixItem

    defs = (
        db.query(DeepCheckDefinition)
        .filter(
            DeepCheckDefinition.affects_cluster_status.is_(True),
            or_(
                DeepCheckDefinition.cluster_id == cluster_id,
                DeepCheckDefinition.cluster_id.is_(None),
            ),
        )
        .order_by(DeepCheckDefinition.created_at.asc())
        .all()
    )
    dedicated_roots = {
        r[0] for r in db.query(CheckMatrixItem.definition_id).filter(CheckMatrixItem.definition_id.isnot(None))
    }
    groups: dict[Any, dict[str, Any]] = {}
    for d in defs:
        root = d.parent_id or d.id
        key = ("lineage", root) if root in dedicated_roots else ("type", d.check_type)
        g = groups.setdefault(key, {"key": key, "check_type": d.check_type, "ids": set(), "primary": None})
        g["ids"].add(d.id)
        # 클러스터 전용 정의가 있으면 그것을 대표로(이름·편집 대상).
        if g["primary"] is None or (d.cluster_id is not None and g["primary"].cluster_id is None):
            g["primary"] = d
    return list(groups.values())


def _latest_group_result(db: Session, cluster_id, group: dict[str, Any]) -> Optional[DeepCheckResult]:
    q = db.query(DeepCheckResult).filter(DeepCheckResult.cluster_id == cluster_id)
    if group["key"][0] == "lineage":
        q = q.filter(DeepCheckResult.definition_id.in_(list(group["ids"])))
    else:
        # 공유 계보: 이 정의들의 결과 + 정의 참조가 끊긴(삭제·레거시) 같은 종류 결과.
        q = q.filter(
            DeepCheckResult.check_type == group["check_type"],
            or_(
                DeepCheckResult.definition_id.in_(list(group["ids"])),
                DeepCheckResult.definition_id.is_(None),
            ),
        )
    return q.order_by(DeepCheckResult.checked_at.desc()).first()


def recompute(db: Session, cluster_id) -> dict[str, Any]:
    """이 클러스터의 최신 신호를 모아 `Cluster.status` 를 1회 기록하고 원인 목록을 반환한다.

    반환값(StatusBreakdown): ``{"cluster_id", "status", "contributors": [...]}``.
    contributor 1건: ``{source_type, source_ref, name, status, message, checked_at, edit_id}``.

    호출 전 이 함수가 읽어야 할 변경 사항(방금 커밋한 DailyCheckLog, 방금 갱신한 Addon.status
    등)은 호출자가 먼저 ``db.flush()`` 해둬야 한다 — 이 세션은 ``autoflush=False`` 다.
    """
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if cluster is None:
        return {"cluster_id": str(cluster_id), "status": None, "contributors": []}

    latest_log = (
        db.query(DailyCheckLog)
        .filter(DailyCheckLog.cluster_id == cluster_id)
        .order_by(DailyCheckLog.checked_at.desc())
        .first()
    )

    contributors: list[dict[str, Any]] = []

    # ① 핵심 점검 번들(core_bundle) — pending(미연결)이면 다른 신호는 의미가 없으므로
    # 선제 종료한다. DailyChecker._determine_overall_status() 가 이미 "API 서버 자체가
    # 응답하지 않음"만 pending 으로 판정하므로, 여기선 그 판정을 그대로 신뢰한다.
    if latest_log is not None and latest_log.overall_status == StatusEnum.pending:
        final_status = StatusEnum.pending
        contributors.append({
            "source_type": "core_bundle", "source_ref": None,
            "name": "핵심 점검 번들", "status": StatusEnum.pending.value,
            "message": "API 서버에 연결할 수 없습니다 (미연결).",
            "checked_at": latest_log.checked_at.isoformat() if latest_log.checked_at else None,
            "edit_id": None,
        })
    else:
        final_status = StatusEnum.healthy

        if latest_log is not None:
            contributors.append({
                "source_type": "core_bundle", "source_ref": None,
                "name": "핵심 점검 번들", "status": latest_log.overall_status.value,
                "message": _core_bundle_message(latest_log),
                "checked_at": latest_log.checked_at.isoformat() if latest_log.checked_at else None,
                "edit_id": None,
            })
            if latest_log.overall_status == StatusEnum.critical:
                final_status = StatusEnum.critical
            elif latest_log.overall_status == StatusEnum.warning:
                final_status = StatusEnum.warning

        # ② 애드온 — 항상 반영(opt-in 아님). 개별 pending(연결 실패)은 클러스터 전체를
        # critical 로 만들지 않고 warning 으로 승격한다(예전 HealthChecker.run_check() 의
        # 규칙을 여기로 이관).
        addons = db.query(Addon).filter(Addon.cluster_id == cluster_id).all()
        for a in addons:
            status = a.status or StatusEnum.healthy
            contributors.append({
                "source_type": "addon", "source_ref": a.type,
                "name": a.name, "status": status.value,
                "message": (a.details or {}).get("last_message"),
                "checked_at": a.last_check.isoformat() if a.last_check else None,
                "edit_id": str(a.id),
            })
            if status == StatusEnum.critical:
                final_status = StatusEnum.critical
            elif status == StatusEnum.warning and final_status != StatusEnum.critical:
                final_status = StatusEnum.warning
            elif status == StatusEnum.pending and final_status == StatusEnum.healthy:
                final_status = StatusEnum.warning

        # ③ 심층 점검(opt-in) — pending(미판정)은 "아직 판정 없음"이라 집계에서 제외한다
        # (애드온과 달리 warning 으로 승격하지 않음 — opt-in 이라 안 켠 점검이 대다수라
        # 노이즈가 커지는 걸 막는다).
        for group in _status_definition_groups(db, cluster_id):
            d = group["primary"]
            latest_result = _latest_group_result(db, cluster_id, group)
            if latest_result is None or latest_result.status == StatusEnum.pending:
                continue
            contributors.append({
                "source_type": "deep_check", "source_ref": group["check_type"],
                "name": d.name, "status": latest_result.status.value,
                "message": latest_result.message,
                "checked_at": latest_result.checked_at.isoformat() if latest_result.checked_at else None,
                "edit_id": str(d.id),
            })
            if latest_result.status == StatusEnum.critical:
                final_status = StatusEnum.critical
            elif latest_result.status == StatusEnum.warning and final_status != StatusEnum.critical:
                final_status = StatusEnum.warning

        # ④ 점검 매트릭스 행(opt-in) — 배치잡·플레이북·수동 입력 결과. 이 소스들은 점검 정의가 없어
        # 위 ③으로 잡히지 않는다. 운영자가 항목에서 "클러스터 상태에 반영" 을 켠 활성 행만 본다.
        # pending(판정 보류)은 ③과 같이 제외한다.
        from app.models import CheckMatrixItem, CheckMatrixResult, CheckMatrixSourceType

        rows = (
            db.query(CheckMatrixItem, CheckMatrixResult)
            .join(CheckMatrixResult, CheckMatrixResult.item_id == CheckMatrixItem.id)
            .filter(
                CheckMatrixResult.cluster_id == cluster_id,
                CheckMatrixItem.affects_cluster_status.is_(True),
                CheckMatrixItem.enabled.is_(True),
                CheckMatrixItem.source_type.in_([
                    CheckMatrixSourceType.batch_job, CheckMatrixSourceType.playbook,
                    CheckMatrixSourceType.manual,
                ]),
            )
            .all()
        )
        for item, res in rows:
            if res.status is None or res.status == StatusEnum.pending:
                continue
            contributors.append({
                "source_type": "check_matrix", "source_ref": item.source_type.value,
                "name": item.name, "status": res.status.value,
                "message": res.message,
                "checked_at": res.checked_at.isoformat() if res.checked_at else None,
                "edit_id": str(item.id),
            })
            if res.status == StatusEnum.critical:
                final_status = StatusEnum.critical
            elif res.status == StatusEnum.warning and final_status != StatusEnum.critical:
                final_status = StatusEnum.warning

    # row-level lock 으로 동시 갱신(Beat cron + 사용자 수동 트리거 등) race 차단 — 예전
    # DailyChecker/HealthChecker 각자 걸던 SELECT FOR UPDATE 를 여기 한 곳으로 모았다.
    locked = db.query(Cluster).filter(Cluster.id == cluster_id).with_for_update().first()
    if locked is not None:
        locked.status = final_status
    db.commit()

    _SEVERITY = {"critical": 0, "warning": 1, "pending": 2, "healthy": 3}
    contributors.sort(key=lambda c: _SEVERITY.get(c["status"], 9))

    return {
        "cluster_id": str(cluster_id),
        "status": final_status.value,
        "contributors": contributors,
    }
