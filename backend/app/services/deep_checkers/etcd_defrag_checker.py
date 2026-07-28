"""etcd defrag/alarm 점검.

전략:
1) ``etcdctl endpoint status -w json`` 결과를 읽어 dbSize / dbSizeInUse 비율로
   단편화 비율을 계산. fragmentation > warning threshold → warning, > critical → critical.
2) ``etcdctl alarm list`` 가 비어있지 않으면 critical.

실행 경로 2가지 (params.source 로 선택 — UI 설정 편집에서 변경):
- **pod**      : kube-system 내 etcd pod 에서 exec (kubeadm 등 파드형 etcd).
- **snapshot** : etcd 가 master 노드의 systemd 데몬으로 떠 있는 환경(파드 없음,
  env 는 /etc/etcd.env). "버전 / 설정 관리(/versions)" 화면에서 SSH 로 수집해 둔
  ``etcdctl_config:{host}`` 스냅샷(endpoint_status_json)을 읽어 단편화율을 계산한다 —
  체커가 직접 SSH 하지 않으므로 자격증명을 params 에 저장할 필요가 없다.
- **auto**(기본): pod 를 먼저 찾고, 없으면 snapshot 으로 폴백.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any, Optional

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)


_ETCDCTL_ENV = [
    "ETCDCTL_API=3",
    "ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt",
    "ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt",
    "ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key",
]


class EtcdDefragChecker(DeepCheckerBase):
    check_type = "etcd_defrag"
    display_name = "etcd 단편화 / 알람"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_frag = float(ctx.thresholds.get("warning_fragmentation_pct", 30))
        critical_frag = float(ctx.thresholds.get("critical_fragmentation_pct", 50))
        source = str(ctx.params.get("source", "auto")).lower()
        snapshot_max_age_hours = int(ctx.params.get("snapshot_max_age_hours", 24))

        if source == "snapshot":
            return self._check_via_snapshots(ctx, warning_frag, critical_frag, snapshot_max_age_hours)

        with self._step("locate_pod", "etcd 파드 탐색") as st:
            v1 = self._v1(ctx)
            pods = v1.list_namespaced_pod(
                namespace="kube-system",
                label_selector="component=etcd",
                timeout_seconds=10,
            )
            target = None
            for p in pods.items:
                if p.status and p.status.phase == "Running":
                    target = p
                    break
            if target is None:
                if source == "auto":
                    st.status = "skipped"
                    st.detail = "Running etcd pod 없음 → 수집 스냅샷 폴백 (데몬 etcd)"
                    return self._check_via_snapshots(
                        ctx, warning_frag, critical_frag, snapshot_max_age_hours,
                    )
                st.status = "failed"
                st.detail = "Running etcd pod 없음 (managed/external etcd 가능성)"
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message="etcd pod 를 찾지 못했습니다 (managed/external etcd 가능성). "
                            "데몬(systemd) etcd 환경이면 설정 편집에서 source 를 auto/snapshot 으로 두세요.",
                    details={"reason": "no_etcd_pod"},
                )
            st.detail = f"kube-system/{target.metadata.name}"

        with self._step("exec_status", "etcdctl endpoint status 실행") as st:
            endpoint_proc = self._kubectl(
                ctx,
                "-n", "kube-system", "exec", target.metadata.name, "--",
                "sh", "-c",
                f"{' '.join(_ETCDCTL_ENV)} etcdctl endpoint status -w json",
                timeout=20,
            )
            st.metrics = {"rc": endpoint_proc.returncode}
            if endpoint_proc.returncode != 0:
                st.status = "failed"
                st.detail = f"rc={endpoint_proc.returncode} · {(endpoint_proc.stderr or '')[:80]}"
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message="etcdctl endpoint status 실행 실패 (권한 또는 etcd 부재)",
                    details={"stderr": (endpoint_proc.stderr or "")[:1000]},
                )

        with self._step("exec_alarm", "etcdctl alarm list 실행") as st:
            alarm_proc = self._kubectl(
                ctx,
                "-n", "kube-system", "exec", target.metadata.name, "--",
                "sh", "-c",
                f"{' '.join(_ETCDCTL_ENV)} etcdctl alarm list",
                timeout=15,
            )
            st.metrics = {"rc": alarm_proc.returncode}

        with self._step("parse", "db size 파싱 · 단편화율 계산") as st:
            try:
                data = json.loads(endpoint_proc.stdout)
                row = data[0] if isinstance(data, list) and data else {}
                status = row.get("Status", {})
                db_size = int(status.get("dbSize", 0))
                db_size_in_use = int(status.get("dbSizeInUse", 0))
            except Exception as e:
                st.status = "failed"
                st.detail = str(e)[:120]
                # 파싱 실패는 '점검 불가' 이지 이상 상태가 아니므로 pending (fail-safe 관례).
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message=f"etcd status 파싱 실패: {e}",
                    details={"raw": (endpoint_proc.stdout or "")[:1000]},
                )
            frag_pct = 0.0
            if db_size > 0:
                frag_pct = round((1 - (db_size_in_use / db_size)) * 100, 2)
            alarms = (alarm_proc.stdout or "").strip().splitlines()
            alarms = [a for a in alarms if a.strip()]
            st.detail = f"단편화 {frag_pct}% · 알람 {len(alarms)}건"
            st.metrics = {"fragmentation_pct": frag_pct, "alarms": len(alarms)}

        status_enum = StatusEnum.healthy
        msg_parts: list[str] = []
        with self._step("verdict", "단편화/알람 임계 비교") as st:
            if alarms:
                status_enum = StatusEnum.critical
                msg_parts.append(f"알람 {len(alarms)}건")
            if frag_pct >= critical_frag:
                status_enum = StatusEnum.critical
                msg_parts.append(f"단편화 {frag_pct}%")
            elif frag_pct >= warning_frag and status_enum != StatusEnum.critical:
                status_enum = StatusEnum.warning
                msg_parts.append(f"단편화 {frag_pct}%")
            else:
                msg_parts.append(f"단편화 {frag_pct}%")
            st.detail = ", ".join(msg_parts)
            st.metrics = {"status": status_enum.value}

        return DeepCheckOutcome(
            status=status_enum,
            message=", ".join(msg_parts),
            details={
                "source": "pod",
                "fragmentation_pct": frag_pct,
                "warning_pct": warning_frag,
                "critical_pct": critical_frag,
                "db_size_bytes": db_size,
                "db_size_in_use_bytes": db_size_in_use,
                "alarms": alarms,
            },
        )

    # ── 데몬(systemd) etcd — 수집 스냅샷 기반 점검 ──────────────────────────────
    def _check_via_snapshots(
        self,
        ctx: DeepCheckContext,
        warning_frag: float,
        critical_frag: float,
        max_age_hours: int,
    ) -> DeepCheckOutcome:
        """`버전 / 설정 관리` 화면이 SSH 로 수집해 둔 ``etcdctl_config:{host}`` 스냅샷의
        endpoint_status_json 으로 단편화율을 계산한다.

        체커가 직접 SSH 하지 않는 이유: 자격증명을 정의 params(JSONB, 런북/로그에
        노출)에 저장하지 않기 위해서다 — 수집은 기존 UI 흐름(요청 시에만 자격증명 사용,
        미저장)을 그대로 쓴다. addon EtcdChecker 의 스냅샷 폴백과 같은 데이터 소스.
        """
        collect_hint = (
            "'버전 / 설정 관리(/versions)' 화면에서 etcd 설정 수집(etcdctl_config)을 "
            "먼저 실행하세요 — master 노드 SSH 로 /etc/etcd.env 를 source 해 "
            "endpoint status 를 수집합니다."
        )
        with self._step("snapshot", "수집된 etcdctl 스냅샷 조회 (데몬 etcd)") as st:
            if ctx.cluster is None:
                st.status = "failed"
                st.detail = "cluster 컨텍스트 없음"
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message="스냅샷 폴백은 클러스터 컨텍스트가 필요합니다 (in-cluster 단독 모드 미지원).",
                    details={"reason": "no_cluster_context"},
                )
            try:
                from app.database import SessionLocal
                from app.models.config_snapshot import ClusterConfigSnapshot

                db = SessionLocal()
            except Exception as e:  # noqa: BLE001 — Super Pod 등 DB 없는 런타임
                st.status = "failed"
                st.detail = str(e)[:120]
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message="스냅샷 조회용 DB 에 연결할 수 없습니다.",
                    details={"error": str(e)[:300]},
                )
            try:
                snaps = (
                    db.query(ClusterConfigSnapshot)
                    .filter(
                        ClusterConfigSnapshot.cluster_id == ctx.cluster.id,
                        ClusterConfigSnapshot.component.like("etcdctl_config:%"),
                    )
                    .order_by(
                        ClusterConfigSnapshot.component,
                        ClusterConfigSnapshot.collected_at.desc(),
                    )
                    .all()
                )
                latest_per_host: dict[str, Any] = {}
                for s in snaps:
                    if s.component not in latest_per_host:
                        latest_per_host[s.component] = s
            finally:
                db.close()
            if not latest_per_host:
                st.status = "failed"
                st.detail = "etcdctl_config 스냅샷 없음"
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message=f"수집된 etcd 스냅샷이 없습니다. {collect_hint}",
                    details={"reason": "no_snapshot"},
                )
            st.detail = f"호스트 {len(latest_per_host)}개"

        with self._step("parse", "db size 파싱 · 단편화율 계산") as st:
            hosts: list[dict[str, Any]] = []
            worst_frag: Optional[float] = None
            newest_at: Optional[datetime] = None
            for comp_key, snap in latest_per_host.items():
                host = comp_key.split(":", 1)[1] if ":" in comp_key else comp_key
                entry: dict[str, Any] = {
                    "host": host,
                    "collected_at": snap.collected_at.isoformat() if snap.collected_at else None,
                }
                if snap.collected_at and (newest_at is None or snap.collected_at > newest_at):
                    newest_at = snap.collected_at
                raw = (snap.data or {}).get("endpoint_status_json")
                if not raw:
                    entry["error"] = "endpoint_status_json 없음"
                    hosts.append(entry)
                    continue
                try:
                    parsed = json.loads(raw)
                    row = parsed[0] if isinstance(parsed, list) and parsed else parsed
                    status = row.get("Status", row)
                    db_size = int(status.get("dbSize", 0) or 0)
                    db_in_use = int(status.get("dbSizeInUse", 0) or 0)
                except Exception as e:  # noqa: BLE001
                    entry["error"] = f"파싱 실패: {str(e)[:80]}"
                    hosts.append(entry)
                    continue
                frag = round((1 - (db_in_use / db_size)) * 100, 2) if db_size > 0 else 0.0
                entry.update({
                    "fragmentation_pct": frag,
                    "db_size_bytes": db_size,
                    "db_size_in_use_bytes": db_in_use,
                })
                hosts.append(entry)
                if worst_frag is None or frag > worst_frag:
                    worst_frag = frag
            if worst_frag is None:
                st.status = "failed"
                st.detail = "endpoint status 파싱 가능한 호스트 없음"
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message=f"스냅샷에 endpoint status 가 없습니다. {collect_hint}",
                    details={"source": "snapshot", "hosts": hosts},
                )
            st.detail = f"최대 단편화 {worst_frag}% ({len(hosts)}개 호스트)"
            st.metrics = {"fragmentation_pct": worst_frag}

        with self._step("verdict", "단편화/알람 임계 비교") as st:
            age_hours: Optional[float] = None
            if newest_at is not None:
                age_hours = round((datetime.utcnow() - newest_at).total_seconds() / 3600, 1)
            stale = age_hours is not None and age_hours > max_age_hours
            if stale:
                status_enum = StatusEnum.pending
                message = (
                    f"스냅샷이 {age_hours}시간 전 것이라 판정하지 않습니다"
                    f"(허용 {max_age_hours}h). {collect_hint}"
                )
            elif worst_frag >= critical_frag:
                status_enum = StatusEnum.critical
                message = f"단편화 {worst_frag}% (데몬 etcd · 스냅샷 기준)"
            elif worst_frag >= warning_frag:
                status_enum = StatusEnum.warning
                message = f"단편화 {worst_frag}% (데몬 etcd · 스냅샷 기준)"
            else:
                status_enum = StatusEnum.healthy
                message = f"단편화 {worst_frag}% (데몬 etcd · 스냅샷 기준)"
            st.detail = message
            st.metrics = {"status": status_enum.value}

        return DeepCheckOutcome(
            status=status_enum,
            message=message,
            details={
                "source": "snapshot",
                "fragmentation_pct": worst_frag,
                "warning_pct": warning_frag,
                "critical_pct": critical_frag,
                "snapshot_age_hours": age_hours,
                "snapshot_max_age_hours": max_age_hours,
                "hosts": hosts,
                # 스냅샷에는 alarm list 가 없다 — alarm 은 pod 경로 또는 etcdctl 콘솔에서 확인.
                "alarms_unavailable": True,
            },
        )
