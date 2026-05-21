import subprocess
from datetime import datetime
from uuid import UUID

import httpx
from sqlalchemy.orm import Session

from app.models import Cluster, Addon, CheckLog, StatusEnum
from app.config import settings
from app.services.checkers import CHECKER_REGISTRY, CheckResult


_REACHABILITY_TIMEOUT = 5  # seconds


def _is_api_server_reachable(cluster: Cluster) -> bool:
    """API server /healthz 로 빠른 reachability 체크."""
    endpoint = (cluster.api_endpoint or "").strip()
    if not endpoint:
        return False
    # cluster.tls_verify 옵트인 — 기본 False (자체 서명 인증서 환경 호환)
    verify_tls = bool(getattr(cluster, "tls_verify", False))
    try:
        url = endpoint.rstrip("/") + "/healthz"
        with httpx.Client(verify=verify_tls, timeout=_REACHABILITY_TIMEOUT) as client:
            resp = client.get(url)
        return resp.status_code < 500
    except Exception:
        return False


class HealthChecker:
    def __init__(self, db: Session):
        self.db = db

    def run_check(self, cluster_id: UUID) -> None:
        """클러스터 전체 헬스 체크 실행.

        먼저 API server reachability 를 체크하고 안 되면 addon 체크는
        skip 하고 cluster.status = pending(미연결) 로 마킹한다.
        이렇게 해야 "연결 실패"와 "연결은 되는데 addon 문제" 가 구분됨.

        ── cluster.status 갱신 정책 (G-1) ────────────────────────
        DailyChecker 가 primary authoritative source. HealthChecker 는
        사용자의 ad-hoc 트리거이므로 cluster.status 갱신 시 row-level lock
        (SELECT FOR UPDATE) 으로 동시 갱신 race 차단. 같은 정책을
        DailyChecker.run_daily_check 도 따른다.
        """
        cluster = self.db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if not cluster:
            return

        # ── Reachability 선제 체크 ────────────────────────────
        if not _is_api_server_reachable(cluster):
            locked = (
                self.db.query(Cluster)
                .filter(Cluster.id == cluster_id)
                .with_for_update()
                .first()
            )
            if locked is not None:
                locked.status = StatusEnum.pending
                locked.updated_at = datetime.utcnow()
            self.db.add(CheckLog(
                cluster_id=cluster_id,
                status=StatusEnum.pending,
                message="Cluster unreachable — API server probe failed (미연결)",
            ))
            self.db.commit()
            return

        addons = self.db.query(Addon).filter(Addon.cluster_id == cluster_id).all()
        overall_status = StatusEnum.healthy

        for addon in addons:
            result = self._dispatch(cluster, addon)

            # 애드온 상태 업데이트
            addon.status = result.status
            addon.response_time = result.response_time
            addon.last_check = datetime.utcnow()
            addon.details = {**(result.details or {}), "last_message": result.message}

            # 로그 기록
            log = CheckLog(
                cluster_id=cluster_id,
                addon_id=addon.id,
                status=result.status,
                message=result.message,
                raw_output={"response_time": result.response_time, **(result.details or {})},
            )
            self.db.add(log)

            # 전체 상태 계산 — pending(개별 addon 연결 실패) 은 warning 수준.
            # cluster 전체 pending 은 위에서 reachability 실패 시만 설정.
            if result.status == StatusEnum.critical:
                overall_status = StatusEnum.critical
            elif result.status == StatusEnum.warning and overall_status != StatusEnum.critical:
                overall_status = StatusEnum.warning
            elif result.status == StatusEnum.pending and overall_status == StatusEnum.healthy:
                overall_status = StatusEnum.warning

        # G-1: row-level lock 으로 동시 갱신 race 차단
        locked = (
            self.db.query(Cluster)
            .filter(Cluster.id == cluster_id)
            .with_for_update()
            .first()
        )
        if locked is not None:
            locked.status = overall_status
            locked.updated_at = datetime.utcnow()

        cluster_log = CheckLog(
            cluster_id=cluster_id,
            status=overall_status,
            message=f"Cluster check completed - Status: {overall_status.value}",
        )
        self.db.add(cluster_log)
        self.db.commit()


    def run_single_addon_check(self, cluster_id: UUID, addon_id: UUID) -> CheckResult | None:
        """특정 addon 하나만 헬스 체크 실행"""
        cluster = self.db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if not cluster:
            return None

        addon = self.db.query(Addon).filter(Addon.id == addon_id, Addon.cluster_id == cluster_id).first()
        if not addon:
            return None

        result = self._dispatch(cluster, addon)
        addon.status = result.status
        addon.response_time = result.response_time
        addon.last_check = datetime.utcnow()
        addon.details = {**(result.details or {}), "last_message": result.message}

        log = CheckLog(
            cluster_id=cluster_id,
            addon_id=addon.id,
            status=result.status,
            message=result.message,
            raw_output={"response_time": result.response_time, **(result.details or {})},
        )
        self.db.add(log)

        # 클러스터 전체 상태 재계산 + row-level lock (G-1 정책)
        addons = self.db.query(Addon).filter(Addon.cluster_id == cluster_id).all()
        overall_status = StatusEnum.healthy
        for a in addons:
            if a.status == StatusEnum.critical:
                overall_status = StatusEnum.critical
                break
            if a.status == StatusEnum.warning:
                overall_status = StatusEnum.warning

        locked = (
            self.db.query(Cluster)
            .filter(Cluster.id == cluster_id)
            .with_for_update()
            .first()
        )
        if locked is not None:
            locked.status = overall_status
            locked.updated_at = datetime.utcnow()
        self.db.commit()
        return result

    def _dispatch(self, cluster: Cluster, addon: Addon) -> CheckResult:
        """addon.type에 맞는 Checker를 찾아 실행 (Strategy Pattern)."""
        checker_cls = CHECKER_REGISTRY.get(addon.type)
        if checker_cls:
            return checker_cls(cluster, addon, db=self.db).safe_check()

        # fallback: ansible playbook 또는 HTTP 체크
        try:
            if addon.check_playbook:
                s, m, t, d = self._run_ansible_check(cluster, addon)
            else:
                s, m, t, d = self._run_http_check(cluster, addon)
            return CheckResult(status=s, message=m, response_time=t, details=d)
        except Exception as e:
            return CheckResult(
                status=StatusEnum.critical,
                message=f"Check failed: {str(e)[:200]}",
            )

    # ── Legacy fallback methods ────────────────────────────

    def _run_ansible_check(
        self, cluster: Cluster, addon: Addon
    ) -> tuple[StatusEnum, str, int, dict | None]:
        playbook_path = f"{settings.ansible_playbook_dir}/{addon.check_playbook}"
        try:
            start = datetime.utcnow()
            result = subprocess.run(
                [
                    "ansible-playbook", playbook_path,
                    "-i", f"{settings.ansible_inventory_dir}/clusters.yml",
                    "-e", f"target_cluster={cluster.name}",
                    "-e", f"api_endpoint={cluster.api_endpoint}",
                ],
                capture_output=True, text=True,
                timeout=settings.check_timeout_seconds,
            )
            elapsed = int((datetime.utcnow() - start).total_seconds() * 1000)

            # stdout에서 핵심 메시지 추출
            output = result.stdout.strip().split("\n")[-1] if result.stdout else ""
            if "PLAY RECAP" in output:
                output = "Check completed"
            details = {"result": output, "command": " ".join(["ansible-playbook", playbook_path, "-i", f"{settings.ansible_inventory_dir}/clusters.yml", "-e", f"target_cluster={cluster.name}", "-e", f"api_endpoint={cluster.api_endpoint}"])} if output else {"command": " ".join(["ansible-playbook", playbook_path, "-i", f"{settings.ansible_inventory_dir}/clusters.yml", "-e", f"target_cluster={cluster.name}", "-e", f"api_endpoint={cluster.api_endpoint}"])}

            if result.returncode == 0:
                msg = output or f"{addon.name} check passed"
                return StatusEnum.healthy, msg, elapsed, details
            return StatusEnum.warning, f"{addon.name} failed: {result.stderr[:200]}", elapsed, details
        except subprocess.TimeoutExpired:
            return StatusEnum.critical, f"{addon.name} timed out", settings.check_timeout_seconds * 1000, None
        except Exception as e:
            return StatusEnum.critical, f"{addon.name} error: {str(e)}", 0, None

    def _run_http_check(
        self, cluster: Cluster, addon: Addon
    ) -> tuple[StatusEnum, str, int, dict | None]:
        import httpx

        endpoint_map = {"API Server": "/healthz", "etcd": "/health", "Metrics Server": "/metrics"}
        endpoint = endpoint_map.get(addon.name, "/healthz")
        url = f"{cluster.api_endpoint}{endpoint}"
        verify_tls = bool(getattr(cluster, "tls_verify", False))

        try:
            start = datetime.utcnow()
            with httpx.Client(verify=verify_tls, timeout=10.0) as client:
                response = client.get(url)
            elapsed = int((datetime.utcnow() - start).total_seconds() * 1000)

            details = {"endpoint": endpoint, "url": url, "status_code": response.status_code}

            if response.status_code == 200:
                if elapsed > 3000:
                    return StatusEnum.warning, f"{addon.name} slow ({elapsed}ms)", elapsed, details
                return StatusEnum.healthy, f"{addon.name} healthy ({elapsed}ms)", elapsed, details
            return StatusEnum.warning, f"{addon.name} returned {response.status_code}", elapsed, details
        except httpx.TimeoutException:
            return StatusEnum.critical, f"{addon.name} timeout", 10000, {"endpoint": endpoint}
        except Exception as e:
            return StatusEnum.critical, f"{addon.name} failed: {str(e)}", 0, None
