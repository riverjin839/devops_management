"""EtcdChecker — etcd 헬스 체크.

두 가지 환경을 지원한다:
 1) **Pod 배포** (kubeadm 등) → kube-system 의 etcd pod 안에서 `etcdctl endpoint status` exec.
 2) **systemd 배포** (StaticPod 아님) → 최근 수집된 스냅샷을 조회해 판단:
    - `etcd_systemd` (systemctl show + etcd --version)
    - `etcdctl_config:{host}` (endpoint_status_json 포함)

Pod 가 없고 스냅샷도 없으면 warning 으로 안내 — "SSH 기반 etcd 수집" 유도.
"""
import json
from datetime import datetime
from typing import Optional

from kubernetes.stream import stream as k8s_stream

from app.models import StatusEnum, ClusterConfigSnapshot
from app.services import command_trace
from app.services.checkers.base import BaseChecker, CheckResult


class EtcdChecker(BaseChecker):
    """etcd leader election & health status.

    우선 Pod exec, 실패하면 etcdctl_config 스냅샷으로 fallback, 없으면 systemd 상태만.
    """

    def check(self) -> CheckResult:
        start = datetime.utcnow()

        try:
            v1 = self._get_k8s_client()
            pods = v1.list_namespaced_pod(
                namespace="kube-system",
                label_selector="component=etcd",
            )
        except Exception as e:
            # k8s API 자체 실패 — 스냅샷 fallback 시도
            fallback = self._check_via_snapshots(start, reason=f"k8s API 조회 실패: {str(e)[:120]}")
            if fallback is not None:
                return fallback
            raise

        if not pods.items:
            # Pod 없음 (etcd 가 systemd 로 동작) → 스냅샷 fallback
            fallback = self._check_via_snapshots(start, reason="etcd pod 없음 (systemd 배포로 추정)")
            if fallback is not None:
                return fallback
            return CheckResult(
                status=StatusEnum.warning,
                message="etcd pod 없음 · 스냅샷 없음 — '버전/설정' 페이지에서 etcdctl 수집 먼저 실행하세요",
                details={
                    "source": "none",
                    "hint": "etcd 가 systemd 로 동작 중이면 Versions 페이지의 'etcd (systemd)' 또는 etcdctl config 수집을 사용하세요.",
                },
            )

        pods_info = [
            {
                "name": p.metadata.name,
                "phase": p.status.phase,
                "ready": all(cs.ready for cs in (p.status.container_statuses or [])),
            }
            for p in pods.items
        ]
        target = next((p for p in pods.items if p.status.phase == "Running"), None)
        if not target:
            return CheckResult(
                status=StatusEnum.critical,
                message="No running etcd pods found",
                details={"source": "pod", "pods": pods_info},
            )

        pod_name = target.metadata.name

        etcd_cmd = [
            "etcdctl", "endpoint", "status",
            "--cacert=/etc/kubernetes/pki/etcd/ca.crt",
            "--cert=/etc/kubernetes/pki/etcd/server.crt",
            "--key=/etc/kubernetes/pki/etcd/server.key",
            "--write-out=json",
        ]
        command_trace.record("pod-exec", f"kube-system/{pod_name} -c etcd", etcd_cmd)
        try:
            resp = k8s_stream(
                v1.connect_get_namespaced_pod_exec,
                pod_name,
                "kube-system",
                command=etcd_cmd,
                container="etcd",
                stderr=True, stdout=True, stdin=False, tty=False,
                _preload_content=True,
            )
            elapsed = self._elapsed_ms(start)
            return self._parse_etcdctl_json(resp, pod_name, pods_info, elapsed, source="pod")

        except json.JSONDecodeError:
            elapsed = self._elapsed_ms(start)
            all_ready = all(p["ready"] for p in pods_info)
            return CheckResult(
                status=StatusEnum.healthy if all_ready else StatusEnum.warning,
                message=f"etcd pod {pod_name} {'ready' if all_ready else 'partially ready'} ({len(pods_info)} members)",
                response_time=elapsed,
                details={"source": "pod", "pod_name": pod_name, "member_count": len(pods_info), "pods": pods_info},
            )

        except Exception as exec_err:
            # exec 실패 — 스냅샷 fallback 시도 (systemd 이면 건질 수 있음)
            fallback = self._check_via_snapshots(start, reason=f"pod exec 실패: {str(exec_err)[:120]}")
            if fallback is not None:
                return fallback
            elapsed = self._elapsed_ms(start)
            all_running = all(p["phase"] == "Running" for p in pods_info)
            return CheckResult(
                status=StatusEnum.healthy if all_running else StatusEnum.warning,
                message=f"etcd pods {'running' if all_running else 'mixed'} ({len(pods_info)} members) - exec unavailable",
                response_time=elapsed,
                details={"source": "pod", "pod_name": pod_name, "member_count": len(pods_info), "exec_error": str(exec_err)[:200]},
            )

    # ── JSON 파서 (pod exec / snapshot 공통) ─────────────────────────────────

    def _parse_etcdctl_json(
        self,
        resp: str,
        pod_name: Optional[str],
        pods_info: list,
        elapsed: int,
        *,
        source: str,
        extra_details: Optional[dict] = None,
    ) -> CheckResult:
        data = json.loads(resp)
        entry = data[0] if isinstance(data, list) and data else data

        status_data = entry.get("Status", entry)
        header = status_data.get("header", {})

        member_id = header.get("member_id", 0)
        leader_id = status_data.get("leader", 0)
        # 64-bit ID 는 etcd 버전에 따라 int/string 둘다 가능 → str 정규화 후 비교
        is_leader = (
            bool(member_id) and bool(leader_id)
            and str(member_id) == str(leader_id)
        )
        db_size = status_data.get("dbSize", 0)
        version = status_data.get("version", "unknown")
        raft_term = status_data.get("raftTerm", 0)

        details: dict = {
            "source": source,
            "pod_name": pod_name,
            "is_leader": is_leader,
            "leader_id": str(leader_id),
            "member_id": str(member_id),
            "version": version,
            "db_size_mb": round(db_size / (1024 * 1024), 2) if db_size else 0,
            "db_size_in_use_mb": round(status_data.get("dbSizeInUse", 0) / (1024 * 1024), 2),
            "raft_term": raft_term,
            "raft_index": status_data.get("raftIndex", 0),
            "member_count": len(pods_info),
            "pods": pods_info,
        }
        if extra_details:
            details.update(extra_details)

        if db_size and db_size > 100 * 1024 * 1024:
            return CheckResult(StatusEnum.warning, f"etcd DB large ({details['db_size_mb']}MB)", elapsed, details)

        label = "Leader" if is_leader else "Follower"
        src_tag = f" · {source}" if source != "pod" else ""
        return CheckResult(
            StatusEnum.healthy,
            f"etcd {label} healthy - v{version}, DB: {details['db_size_mb']}MB, Term: {raft_term}{src_tag}",
            elapsed,
            details,
        )

    # ── 스냅샷 fallback ────────────────────────────────────────────────────

    def _check_via_snapshots(self, start: datetime, *, reason: str) -> Optional[CheckResult]:
        """etcdctl_config:{host} / etcd_systemd 스냅샷을 이용한 fallback.

        반환:
          - CheckResult: fallback 성공
          - None: db 세션 없음 또는 스냅샷 없음 → caller 가 원래 흐름 유지
        """
        if self.db is None:
            return None

        # 1) 호스트별 etcdctl_config:{host} 중 최신 1건을 모은다.
        etcdctl_snaps = (
            self.db.query(ClusterConfigSnapshot)
            .filter(
                ClusterConfigSnapshot.cluster_id == self.cluster.id,
                ClusterConfigSnapshot.component.like("etcdctl_config:%"),
            )
            .order_by(
                ClusterConfigSnapshot.component,
                ClusterConfigSnapshot.collected_at.desc(),
            )
            .all()
        )
        latest_per_host: dict[str, ClusterConfigSnapshot] = {}
        for snap in etcdctl_snaps:
            if snap.component not in latest_per_host:
                latest_per_host[snap.component] = snap

        # 2) etcd_systemd 는 `etcd_systemd:{host}` 호스트별로 저장됨 — 모두 모아 호스트별 최신 1건씩
        sysd_snaps = (
            self.db.query(ClusterConfigSnapshot)
            .filter(
                ClusterConfigSnapshot.cluster_id == self.cluster.id,
                ClusterConfigSnapshot.component.like("etcd_systemd:%"),
            )
            .order_by(
                ClusterConfigSnapshot.component,
                ClusterConfigSnapshot.collected_at.desc(),
            )
            .all()
        )
        sysd_latest_per_host: dict[str, ClusterConfigSnapshot] = {}
        for snap in sysd_snaps:
            if snap.component not in sysd_latest_per_host:
                sysd_latest_per_host[snap.component] = snap
        # 가장 최근 systemd 스냅샷 시각 (대표값으로 details 에 노출)
        sysd_latest_at = max(
            (s.collected_at for s in sysd_latest_per_host.values() if s.collected_at),
            default=None,
        )

        if not latest_per_host and not sysd_latest_per_host:
            return None

        hosts_info: list[dict] = []
        leader_found = False
        versions: set[str] = set()
        max_db_mb = 0.0
        newest_json: Optional[str] = None
        newest_host: Optional[str] = None

        # etcdctl_config 스냅샷 파싱
        for comp_key, snap in latest_per_host.items():
            host = comp_key.split(":", 1)[1] if ":" in comp_key else comp_key
            data = snap.data or {}
            endpoint_json = data.get("endpoint_status_json")
            entry: dict = {"host": host, "collected_at": snap.collected_at.isoformat()}
            if endpoint_json:
                try:
                    parsed = json.loads(endpoint_json)
                    st = parsed[0] if isinstance(parsed, list) and parsed else parsed
                    st = st.get("Status", st)
                    hdr = st.get("header", {})
                    member_id = hdr.get("member_id", 0)
                    leader_id = st.get("leader", 0)
                    is_leader = (
                        bool(member_id) and bool(leader_id)
                        and str(member_id) == str(leader_id)
                    )
                    if is_leader:
                        leader_found = True
                    ver = st.get("version")
                    if ver:
                        versions.add(ver)
                    db_size = st.get("dbSize", 0) or 0
                    db_mb = round(db_size / (1024 * 1024), 2) if db_size else 0
                    if db_mb >= max_db_mb:
                        max_db_mb = db_mb
                        newest_json = endpoint_json
                        newest_host = host
                    entry.update({
                        "is_leader": is_leader,
                        "version": ver,
                        "db_size_mb": db_mb,
                        "raft_term": st.get("raftTerm"),
                    })
                except json.JSONDecodeError:
                    entry["parse_error"] = "endpoint_status_json JSON 파싱 실패"
            else:
                entry["has_endpoint_status"] = False
            hosts_info.append(entry)

        # systemd 상태 병합 — `etcd_systemd:{host}` 스냅샷 (호스트당 1건) 을 평면으로 읽음
        active_states: list[str] = []
        for comp_key, snap in sysd_latest_per_host.items():
            data = snap.data or {}
            host = data.get("host") or comp_key.split(":", 1)[1]
            active_state = data.get("active_state")
            ver = data.get("version")
            sub_state = data.get("sub_state")
            if active_state:
                active_states.append(active_state)
            if ver:
                versions.add(ver)
            existing = next((x for x in hosts_info if x.get("host") == host), None)
            if existing is None:
                hosts_info.append({
                    "host": host,
                    "collected_at": (snap.collected_at.isoformat() if snap.collected_at else None),
                    "active_state": active_state,
                    "sub_state": sub_state,
                    "version": ver,
                })
            else:
                existing["active_state"] = active_state
                if sub_state:
                    existing["sub_state"] = sub_state
                if not existing.get("version") and ver:
                    existing["version"] = ver

        elapsed = self._elapsed_ms(start)

        if newest_json:
            return self._parse_etcdctl_json(
                newest_json,
                pod_name=None,
                pods_info=hosts_info,
                elapsed=elapsed,
                source="etcdctl_snapshot",
                extra_details={
                    "fallback_reason": reason,
                    "host_count": len(hosts_info),
                    "representative_host": newest_host,
                    "active_states": active_states,
                    "systemd_snapshot_at": sysd_latest_at.isoformat() if sysd_latest_at else None,
                },
            )

        if sysd_latest_per_host:
            all_active = len(active_states) > 0 and all(s == "active" for s in active_states)
            any_active = any(s == "active" for s in active_states)
            if all_active:
                status = StatusEnum.healthy
                msg = f"etcd (systemd) active — {len(active_states)}개 호스트 모두 active"
            elif any_active:
                status = StatusEnum.warning
                msg = f"etcd (systemd) 일부 inactive — {active_states}"
            else:
                status = StatusEnum.critical
                msg = f"etcd (systemd) 전부 inactive — {active_states}"
            return CheckResult(
                status=status,
                message=msg,
                response_time=elapsed,
                details={
                    "source": "systemd_snapshot",
                    "fallback_reason": reason,
                    "hosts": hosts_info,
                    "active_states": active_states,
                    "versions": sorted(versions),
                    "snapshot_at": sysd_latest_at.isoformat() if sysd_latest_at else None,
                },
            )

        return CheckResult(
            status=StatusEnum.warning,
            message=f"etcdctl_config 스냅샷 {len(hosts_info)}건 있으나 endpoint_status 없음",
            response_time=elapsed,
            details={
                "source": "etcdctl_snapshot_partial",
                "fallback_reason": reason,
                "hosts": hosts_info,
                "leader_found": leader_found,
            },
        )
