"""Isilon NFS (NAS) 점검 — ``isilon_nfs``.

Isilon(OneFS) NAS 에 SSH 접속해 ``isi`` 명령으로 수집한 스냅샷을 K8s 관점에서 판정한다.

- **Export/마운트 가용성**: K8s PV(``spec.nfs``) 가 마운트하는 export path 가 Isilon 에 실제로
  존재하는지 매칭. K8s 가 쓰는 export 가 없으면 critical.
- **용량/쿼터**: 쿼터 사용률(%) 이 임계 초과면 warning/critical.
- **노드/서비스 health**: Isilon 노드 degraded 또는 NFS 서비스 disabled 이면 critical.

실제 SSH 수집·파싱·**캐시(무부하)** 는 ``app.services.isilon_service`` 가 담당한다. 이 체커는
서버가 미설정이면 **pending**(운영 무해) 을 돌려준다.
"""
from __future__ import annotations

import re
from typing import Any, Optional

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)


class IsilonNfsChecker(DeepCheckerBase):
    check_type = "isilon_nfs"
    display_name = "Isilon NFS (NAS)"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        from app.database import SessionLocal
        from app.services import isilon_service

        warning_pct = float(ctx.thresholds.get("warning_quota_pct", 80))
        critical_pct = float(ctx.thresholds.get("critical_quota_pct", 95))
        server_name = str(ctx.params.get("isilon_server_name") or "").strip()
        nfs_pv_only = bool(ctx.params.get("nfs_pv_only", True))

        db = SessionLocal()
        try:
            with self._step("ssh_connect", "Isilon 서버 조회 · SSH 수집") as st:
                server = self._resolve_server(db, isilon_service, server_name)
                if server is None:
                    return DeepCheckOutcome(
                        status=StatusEnum.pending,
                        message=(
                            "설정된 Isilon 서버가 없습니다. NFS 모니터링 페이지에서 서버를 "
                            "등록하거나 params.isilon_server_name 을 지정하세요."
                        ),
                        details={"configured": False},
                    )
                # 부하 보호: 캐시 존중(force=False).
                snap = isilon_service.collect_nfs_snapshot(db, server, force=False)
                st.detail = (
                    f"{server.name} · {'cache' if snap.get('from_cache') else 'live'} · "
                    f"명령 {len(snap.get('results', []))}건"
                )
                st.metrics = {"from_cache": bool(snap.get("from_cache"))}

            if not snap.get("connection_ok"):
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message=f"Isilon 접속 불가: {snap.get('connection_error') or '알 수 없음'}",
                    details=self._base_details(server, snap),
                )

            results = snap.get("results", [])
            exports = _parse_exports(_section_parsed(results, "exports"))
            quota_max, quota_items = _parse_quota_usage(_section_parsed(results, "quotas"))
            node_bad, node_hint = _scan_node_health(_section_raw(results, "node_health"))
            nfs_disabled = _nfs_service_disabled(_section_raw(results, "nfs_settings"))

            with self._step("match_k8s_pv", "K8s NFS PV ↔ export 매칭") as st:
                k8s_nfs, missing = self._match_k8s(ctx, exports)
                st.detail = f"K8s NFS PV {len(k8s_nfs)}건 · export 누락 {len(missing)}건"
                st.metrics = {"k8s_nfs_pvs": len(k8s_nfs), "missing_exports": len(missing)}

            with self._step("verdict", "가용성 · 쿼터 · health 판정") as st:
                status = StatusEnum.healthy
                reasons: list[str] = []
                if nfs_pv_only and missing:
                    status = StatusEnum.critical
                    reasons.append(f"K8s 가 쓰는 export 누락 {len(missing)}건")
                if nfs_disabled:
                    status = StatusEnum.critical
                    reasons.append("NFS 서비스 비활성")
                if node_bad:
                    status = StatusEnum.critical
                    reasons.append(f"노드 상태 이상({node_hint})")
                if quota_max is not None:
                    if quota_max >= critical_pct:
                        status = StatusEnum.critical
                        reasons.append(f"쿼터 사용률 {quota_max:.0f}%")
                    elif quota_max >= warning_pct and status != StatusEnum.critical:
                        status = StatusEnum.warning
                        reasons.append(f"쿼터 사용률 {quota_max:.0f}%")
                st.detail = status.value

            msg = "정상" if not reasons else " · ".join(reasons)
            details = self._base_details(server, snap)
            details.update({
                "exports_total": len(exports),
                "k8s_nfs_pvs": k8s_nfs[:100],
                "missing_exports": missing[:100],
                "quota_max_pct": quota_max,
                "quota_items": quota_items[:100],
                "nfs_service_disabled": nfs_disabled,
                "node_health_issue": node_hint if node_bad else None,
            })
            return DeepCheckOutcome(status=status, message=f"Isilon NFS: {msg}", details=details)
        finally:
            db.close()

    # ── helpers ────────────────────────────────────────────────────────────
    def _resolve_server(self, db, isilon_service, server_name: str):
        if server_name:
            from app.models.isilon_server import IsilonServer
            srv = db.query(IsilonServer).filter(IsilonServer.name == server_name).first()
            if srv:
                return srv
        return isilon_service.get_server(db, None)

    def _match_k8s(self, ctx: DeepCheckContext, exports: list[dict[str, Any]]):
        """K8s PV 중 NFS 백엔드(spec.nfs)를 뽑아 Isilon export path 와 매칭.

        export 목록을 못 얻은 경우(명령 비활성/실패) 는 매칭 불가로 보고 **missing 을 비운다**
        — export 데이터가 없다는 이유로 K8s PV 를 전부 누락(critical)으로 오판하지 않기 위함.
        """
        export_paths = [e["path"] for e in exports if e.get("path")]
        have_exports = len(export_paths) > 0
        k8s_nfs: list[dict[str, Any]] = []
        missing: list[dict[str, Any]] = []
        try:
            v1 = self._v1(ctx)
            pvs = v1.list_persistent_volume(timeout_seconds=15)
            for pv in pvs.items:
                nfs = getattr(pv.spec, "nfs", None) if pv.spec else None
                if not nfs or not getattr(nfs, "path", None):
                    continue
                path = nfs.path
                claim = pv.spec.claim_ref if pv.spec else None
                entry = {
                    "pv": pv.metadata.name,
                    "server": getattr(nfs, "server", None),
                    "path": path,
                    "pvc": f"{claim.namespace}/{claim.name}" if claim else None,
                }
                k8s_nfs.append(entry)
                if have_exports and not _path_served(path, export_paths):
                    missing.append(entry)
        except Exception as e:  # noqa: BLE001 — K8s 미도달 시 매칭 생략(무해).
            k8s_nfs.append({"error": f"K8s PV 조회 실패: {str(e)[:150]}"})
        return k8s_nfs, missing

    def _base_details(self, server, snap: dict[str, Any]) -> dict[str, Any]:
        return {
            "configured": True,
            "server": {"name": server.name, "host": server.host},
            "collected_at": snap.get("collected_at"),
            "from_cache": snap.get("from_cache"),
            "collect_errors": snap.get("errors", [])[:50],
        }


# ── 파싱 유틸 (OneFS 버전차에 관대하게, 절대 throw 안 함) ─────────────────────
def _section_parsed(results: list[dict[str, Any]], section: str) -> Any:
    for r in results:
        if r.get("section") == section and r.get("parsed") is not None:
            return r["parsed"]
    return None


def _section_raw(results: list[dict[str, Any]], section: str) -> str:
    for r in results:
        if r.get("section") == section:
            return r.get("raw") or ""
    return ""


def _parse_exports(parsed: Any) -> list[dict[str, Any]]:
    """isi nfs exports list --format json → [{id, path, enabled}]. shape 에 관대."""
    out: list[dict[str, Any]] = []
    items = None
    if isinstance(parsed, dict):
        items = parsed.get("exports") or parsed.get("items") or parsed.get("data")
    elif isinstance(parsed, list):
        items = parsed
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        paths = it.get("paths") or ([it["path"]] if it.get("path") else [])
        if isinstance(paths, str):
            paths = [paths]
        for p in paths or []:
            out.append({
                "id": it.get("id"),
                "path": p,
                "description": it.get("description"),
            })
    return out


def _parse_quota_usage(parsed: Any):
    """isi quota quotas list --format json → (최대 사용률%, [{path, pct}]). 계산 불가면 (None, [])."""
    items = None
    if isinstance(parsed, dict):
        items = parsed.get("quotas") or parsed.get("items") or parsed.get("data")
    elif isinstance(parsed, list):
        items = parsed
    if not isinstance(items, list):
        return None, []
    rows: list[dict[str, Any]] = []
    max_pct: Optional[float] = None
    for it in items:
        if not isinstance(it, dict):
            continue
        used = _dig(it, ["usage", "logical"]) or _dig(it, ["usage", "fslogical"]) \
            or _dig(it, ["usage", "physical"])
        hard = _dig(it, ["thresholds", "hard"])
        pct = None
        if isinstance(used, (int, float)) and isinstance(hard, (int, float)) and hard > 0:
            pct = round(used / hard * 100, 1)
            max_pct = pct if max_pct is None else max(max_pct, pct)
        rows.append({"path": it.get("path"), "pct": pct})
    return max_pct, rows


def _dig(d: Any, keys: list[str]) -> Any:
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _scan_node_health(raw: str):
    """isi status 텍스트에서 이상 신호 스캔 → (bad, hint)."""
    if not raw:
        return False, ""
    low = raw.lower()
    for bad in ("smartfail", "down", "critical", "unhealthy", "degraded", "offline"):
        if re.search(rf"\b{bad}\b", low):
            return True, bad
    return False, ""


def _nfs_service_disabled(raw: str) -> bool:
    """isi nfs settings global view 텍스트에서 서비스 비활성 감지."""
    if not raw:
        return False
    for line in raw.splitlines():
        low = line.lower()
        if "service" in low and ("nfs" in low or "enabled" in low):
            if re.search(r"\b(no|false|disabled|off)\b", low):
                return True
    return False


def _path_served(pv_path: str, export_paths: list[str]) -> bool:
    """PV 의 NFS path 가 어떤 export path 아래(또는 동일)에 있으면 served."""
    if not pv_path:
        return False
    pvp = pv_path.rstrip("/")
    for ep in export_paths:
        e = (ep or "").rstrip("/")
        if not e:
            continue
        if pvp == e or pvp.startswith(e + "/") or e.startswith(pvp + "/") or e == pvp:
            return True
    return False
