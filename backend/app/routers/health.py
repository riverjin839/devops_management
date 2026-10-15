from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session
from uuid import UUID

from app.database import get_db
from app.models import Cluster, Addon, CheckLog, StatusEnum, Playbook
from app.schemas import (
    AddonCreate,
    AddonUpdate,
    AddonResponse,
    AddonListResponse,
    ClusterResponse,
    SummaryStatsResponse,
)
from app.services.health_checker import HealthChecker

router = APIRouter(prefix="/health", tags=["health"])

_STATUS_KR = {"healthy": "정상", "warning": "주의", "critical": "이상", "unknown": "미확인", "running": "실행중"}


@router.post("/check/{cluster_id}")
def run_health_check(
    cluster_id: UUID,
    db: Session = Depends(get_db)
):
    """클러스터 헬스 체크 실행 (동기 – threadpool에서 실행)"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cluster not found"
        )

    checker = HealthChecker(db)
    checker.run_check(cluster_id)

    # 점검 완료된 addon 데이터를 응답에 포함 (프론트엔드 즉시 반영 + 실행 로그 애드온별 줄, D-128)
    addons = db.query(Addon).filter(Addon.cluster_id == cluster_id).all()
    addon_list = addon_check_summaries(addons)

    return {
        "message": "Health check completed",
        "cluster_id": str(cluster_id),
        "addons_updated": len(addon_list),
        "addons": addon_list,
    }


def addon_check_summaries(addons) -> list[dict]:
    """점검 직후 애드온별 요약 — 실행 로그가 한 줄씩 그린다. details 의 message/error 가 있으면 같이 싣는다."""
    out: list[dict] = []
    for a in addons:
        details = a.details if isinstance(a.details, dict) else {}
        msg = details.get("message") or details.get("error") or None
        out.append({
            "id": str(a.id),
            "name": a.name,
            "type": a.type,
            "status": a.status.value if hasattr(a.status, "value") else a.status,
            "response_time": a.response_time,
            "message": str(msg) if msg is not None else None,
            "last_check": a.last_check.isoformat() if a.last_check else None,
        })
    return out


@router.post("/check/{cluster_id}/addons/{addon_id}")
def run_single_addon_check(
    cluster_id: UUID,
    addon_id: UUID,
    db: Session = Depends(get_db),
):
    """특정 addon 헬스 체크 실행"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cluster not found"
        )

    addon = db.query(Addon).filter(Addon.id == addon_id, Addon.cluster_id == cluster_id).first()
    if not addon:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Addon not found"
        )

    checker = HealthChecker(db)
    result = checker.run_single_addon_check(cluster_id, addon_id)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Addon not found"
        )

    db.refresh(addon)

    return {
        "message": "Addon check completed",
        "cluster_id": str(cluster_id),
        "addon_id": str(addon_id),
        "status": result.status.value if hasattr(result.status, "value") else str(result.status),
        "response_time": result.response_time,
        "log": result.message,
        "details": addon.details or {},
    }

@router.get("/status/{cluster_id}", response_model=ClusterResponse)
def get_cluster_status(cluster_id: UUID, db: Session = Depends(get_db)):
    """클러스터 현재 상태 조회"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cluster not found"
        )
    return cluster


@router.get("/addons/{cluster_id}", response_model=AddonListResponse)
def get_cluster_addons(cluster_id: UUID, db: Session = Depends(get_db)):
    """클러스터의 애드온 상태 조회"""
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cluster not found"
        )
    
    addons = db.query(Addon).filter(Addon.cluster_id == cluster_id).all()
    return AddonListResponse(data=addons)


@router.post("/addons", response_model=AddonResponse, status_code=status.HTTP_201_CREATED)
def create_addon(addon_data: AddonCreate, db: Session = Depends(get_db)):
    """애드온 생성"""
    cluster = db.query(Cluster).filter(Cluster.id == addon_data.cluster_id).first()
    if not cluster:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cluster not found"
        )

    # 중복 체크
    existing = db.query(Addon).filter(
        Addon.cluster_id == addon_data.cluster_id,
        Addon.name == addon_data.name
    ).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Addon '{addon_data.name}' already exists for this cluster"
        )

    addon = Addon(**addon_data.model_dump())
    db.add(addon)
    db.commit()
    db.refresh(addon)
    return addon


@router.delete("/addons/{addon_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_addon(addon_id: UUID, db: Session = Depends(get_db)):
    """애드온 삭제"""
    addon = db.query(Addon).filter(Addon.id == addon_id).first()
    if not addon:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Addon not found"
        )
    db.delete(addon)
    db.commit()
    return None


@router.put("/addons/{addon_id}", response_model=AddonResponse)
def update_addon(addon_id: UUID, addon_data: AddonUpdate, db: Session = Depends(get_db)):
    """애드온 수정"""
    addon = db.query(Addon).filter(Addon.id == addon_id).first()
    if not addon:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Addon not found"
        )

    update_data = addon_data.model_dump(exclude_unset=True)

    new_name = update_data.get("name")
    if new_name and new_name != addon.name:
        existing = db.query(Addon).filter(
            Addon.cluster_id == addon.cluster_id,
            Addon.name == new_name,
            Addon.id != addon.id,
        ).first()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Addon '{new_name}' already exists for this cluster"
            )

    for key, value in update_data.items():
        setattr(addon, key, value)

    db.commit()
    db.refresh(addon)
    return addon


@router.get("/summary", response_model=SummaryStatsResponse)
def get_summary_stats(db: Session = Depends(get_db)):
    """전체 클러스터 요약 통계"""
    clusters = db.query(Cluster).all()
    
    total = len(clusters)
    healthy = sum(1 for c in clusters if c.status == StatusEnum.healthy)
    warning = sum(1 for c in clusters if c.status == StatusEnum.warning)
    critical = sum(1 for c in clusters if c.status == StatusEnum.critical)
    
    return SummaryStatsResponse(
        total_clusters=total,
        healthy=healthy,
        warning=warning,
        critical=critical
    )


@router.get("/report")
def export_daily_report(
    cluster_id: UUID | None = Query(default=None),
    fmt: str = Query(default="md", regex="^(md|csv)$"),
    db: Session = Depends(get_db),
):
    """Daily Report 내보내기 (addon + playbook 결과)"""
    query = db.query(Cluster)
    if cluster_id:
        query = query.filter(Cluster.id == cluster_id)
    clusters = query.order_by(Cluster.name).all()

    now = datetime.utcnow()
    today = now.strftime("%Y.%m.%d")
    now_str = now.strftime("%Y.%m.%d %H:%M UTC")

    if fmt == "csv":
        return _build_csv(clusters, db, today, now_str)
    return _build_md(clusters, db, today, now_str)


def _addon_row(addon: Addon, today: str) -> dict:
    """addon에서 리포트 행 데이터 추출"""
    check_date = addon.last_check.strftime("%Y.%m.%d %H:%M") if addon.last_check else today
    status_kr = _STATUS_KR.get(addon.status.value if hasattr(addon.status, "value") else addon.status, "미확인")
    value = _extract_addon_value(addon)
    note = _extract_addon_note(addon)
    return {"name": addon.name, "date": check_date, "status": status_kr, "value": value, "note": note}


def _playbook_row(pb: Playbook) -> dict:
    """playbook에서 리포트 행 데이터 추출"""
    run_date = pb.last_run_at.strftime("%Y.%m.%d %H:%M") if pb.last_run_at else "-"
    status_kr = _STATUS_KR.get(pb.status, "미확인")
    value = "-"
    note = "없음"

    if pb.last_result:
        stats = pb.last_result.get("stats", {})
        totals = stats.get("totals")
        if totals:
            value = f"ok={totals.get('ok', 0)}, fail={totals.get('failures', 0)}"
            if totals.get("failures", 0) > 0:
                note = f"failures: {totals['failures']}"
            elif totals.get("changed", 0) > 0:
                note = f"changed: {totals['changed']}"
            else:
                note = "없음"
        else:
            msg = pb.last_result.get("message", "")
            if msg:
                note = msg[:50]

    return {"name": f"[PB] {pb.name}", "date": run_date, "status": status_kr, "value": value, "note": note}


def _extract_addon_value(addon: Addon) -> str:
    """addon 타입별 수치 추출"""
    d = addon.details or {}
    addon_type = addon.type

    if addon_type == "etcd-leader":
        db_mb = d.get("db_size_mb", "")
        members = d.get("member_count", "")
        src = d.get("source")
        if db_mb:
            suffix = {
                "etcdctl_snapshot": " · snapshot",
                "systemd_snapshot": " · systemd",
            }.get(src, "")
            return f"DB:{db_mb}MB, Members:{members}{suffix}"
        if src == "systemd_snapshot":
            active = d.get("active_states", [])
            return f"systemd · {sum(1 for s in active if s == 'active')}/{len(active)} active" if active else "systemd"
        return "-"

    if addon_type == "node-check":
        ready = d.get("ready", 0)
        total = d.get("total", 0)
        return f"{ready}/{total}" if total else "-"

    if addon_type == "control-plane":
        latency = d.get("api_latency_ms")
        components = d.get("components", [])
        healthy_c = sum(1 for c in components if c.get("status") == "healthy")
        return f"{healthy_c}/{len(components)} healthy, {latency}ms" if latency else "-"

    if addon_type == "system-pod":
        ready = d.get("ready_pods", 0)
        total = d.get("total_pods", 0)
        pct = d.get("ratio_pct")
        return f"{ready}/{total} ({pct}%)" if pct is not None else f"{ready}/{total}"

    if addon_type == "nexus":
        writable = d.get("writable", False)
        return "Writable" if writable else "Read-Only"

    if addon_type == "jenkins":
        mode = d.get("mode", "?")
        executors = d.get("num_executors", 0)
        queue = d.get("queue_items", 0)
        return f"Mode:{mode}, Exec:{executors}, Q:{queue}"

    if addon_type == "argocd":
        total = d.get("total_apps", 0)
        synced = d.get("synced", 0)
        degraded = d.get("degraded", 0)
        return f"{synced}/{total} synced, {degraded} degraded"

    if addon_type == "keycloak":
        ready = d.get("ready", False)
        db = d.get("db_status", "?")
        return f"Ready, DB:{db}" if ready else f"NotReady, DB:{db}"

    return f"{addon.response_time}ms" if addon.response_time else "-"


def _extract_addon_note(addon: Addon) -> str:
    """addon 타입별 특이사항 추출"""
    d = addon.details or {}
    status_val = addon.status.value if hasattr(addon.status, "value") else addon.status

    if status_val == "healthy":
        return "없음"

    addon_type = addon.type

    if addon_type == "node-check":
        issues = d.get("issues", [])
        not_ready = d.get("not_ready", [])
        parts = []
        if not_ready:
            parts.append(f"NotReady: {', '.join(str(n) for n in not_ready[:3])}")
        if issues:
            parts.append(", ".join(f"{i.get('node', '?')}:{i.get('reason', '?')}" for i in issues[:3]))
        return "; ".join(parts) if parts else "없음"

    if addon_type == "control-plane":
        components = d.get("components", [])
        unhealthy = [c["name"] for c in components if c.get("status") != "healthy"]
        return f"unhealthy: {', '.join(unhealthy)}" if unhealthy else "없음"

    if addon_type == "nexus":
        sys_status = d.get("system_status", "")
        return f"Read-Only (system: {sys_status})" if not d.get("writable") else "없음"

    if addon_type == "jenkins":
        if d.get("quieting_down"):
            return "Quieting down (preparing shutdown)"
        queue = d.get("queue_items", 0)
        return f"Queue backed up ({queue} items)" if queue > 20 else "없음"

    if addon_type == "argocd":
        problems = d.get("problem_apps", [])
        if problems:
            return ", ".join(f"{p.get('name','?')}({p.get('health','?')})" for p in problems[:3])
        return "없음"

    if addon_type == "keycloak":
        checks = d.get("checks", [])
        down = [c["name"] for c in checks if c.get("status") != "UP"]
        return f"DOWN: {', '.join(down)}" if down else "없음"

    err = d.get("error", "")
    if err:
        return str(err)[:60]

    return "없음"


def _build_md(clusters: list, db: Session, today: str, now_str: str) -> PlainTextResponse:
    lines = [
        f"# K8s Daily Check Report",
        f"",
        f"> Generated: {now_str}",
        f"",
    ]

    for cluster in clusters:
        lines.append(f"## Cluster: {cluster.name}")
        lines.append("")
        lines.append("| 검사 항목 | 날짜 | 상태 | 수치 | 특이사항 |")
        lines.append("|-----------|------|------|------|----------|")

        addons = db.query(Addon).filter(Addon.cluster_id == cluster.id).order_by(Addon.name).all()
        for addon in addons:
            r = _addon_row(addon, today)
            lines.append(f"| {r['name']} | {r['date']} | {r['status']} | {r['value']} | {r['note']} |")

        playbooks = (
            db.query(Playbook)
            .filter(Playbook.cluster_id == cluster.id, Playbook.last_run_at.isnot(None))
            .order_by(Playbook.name).all()
        )
        for pb in playbooks:
            r = _playbook_row(pb)
            lines.append(f"| {r['name']} | {r['date']} | {r['status']} | {r['value']} | {r['note']} |")

        lines.append("")

    md = "\n".join(lines)
    filename = f"k8s-daily-report-{today.replace('.', '-')}.md"
    return PlainTextResponse(
        content=md,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _build_csv(clusters: list, db: Session, today: str, now_str: str) -> PlainTextResponse:
    lines = ["검사 항목,클러스터,날짜,상태,수치,특이사항"]

    for cluster in clusters:
        addons = db.query(Addon).filter(Addon.cluster_id == cluster.id).order_by(Addon.name).all()
        for addon in addons:
            r = _addon_row(addon, today)
            lines.append(_csv_row(r["name"], cluster.name, r))

        playbooks = (
            db.query(Playbook)
            .filter(Playbook.cluster_id == cluster.id, Playbook.last_run_at.isnot(None))
            .order_by(Playbook.name).all()
        )
        for pb in playbooks:
            r = _playbook_row(pb)
            lines.append(_csv_row(r["name"], cluster.name, r))

    csv = "\n".join(lines)
    filename = f"k8s-daily-report-{today.replace('.', '-')}.csv"
    return PlainTextResponse(
        content=csv,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _csv_row(name: str, cluster_name: str, r: dict) -> str:
    def esc(s: str) -> str:
        s = s.replace('"', '""')
        return f'"{s}"' if "," in s or '"' in s else s
    return f'{esc(name)},{esc(cluster_name)},{esc(r["date"])},{esc(r["status"])},{esc(r["value"])},{esc(r["note"])}'
