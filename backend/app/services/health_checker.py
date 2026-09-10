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

        먼저 API server reachability 를 체크하고 안 되면 애드온 체크는 건너뛴다 — 어차피
        전부 연결 실패로 끝날 호출이기 때문이다. "연결 실패"와 "연결은 되는데 addon 문제"
        를 구분하기 위한 최적화일 뿐, cluster.status 자체는 이 확인과 무관하게 아래
        `cluster_status_service.recompute()` 가 최신 DailyCheckLog 기준으로 판정한다.

        ── cluster.status 갱신 정책 (G-1, 개정) ────────────────────────
        Cluster.status 는 recompute() 하나만 쓴다. 여기서는 자기 도메인 결과(애드온
        status/CheckLog)만 flush 하고 recompute() 를 호출한다 — 직접 대입하지 않는다.
        """
        cluster = self.db.query(Cluster).filter(Cluster.id == cluster_id).first()
        if not cluster:
            return

        from app.services.cluster_status_service import recompute

        # ── Reachability 선제 체크(애드온 호출 절약용 — 아래 설명 참고) ──────────
        if not _is_api_server_reachable(cluster):
            self.db.add(CheckLog(
                cluster_id=cluster_id,
                status=StatusEnum.pending,
                message="Cluster unreachable — API server probe failed (미연결), 애드온 점검 건너뜀",
            ))
            self.db.flush()
            recompute(self.db, cluster_id)
            return

        addons = self.db.query(Addon).filter(Addon.cluster_id == cluster_id).all()

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

        self.db.flush()
        breakdown = recompute(self.db, cluster_id)

        self.db.add(CheckLog(
            cluster_id=cluster_id,
            status=StatusEnum(breakdown["status"]),
            message=f"Cluster check completed - Status: {breakdown['status']}",
        ))
        self.db.commit()


    def run_single_addon_check(self, cluster_id: UUID, addon_id: UUID) -> CheckResult | None:
        """특정 addon 하나만 헬스 체크 실행.

        클러스터 전체 상태는 이 애드온 하나만 보고 재계산하지 않는다 — 예전엔 여기서
        "이 클러스터의 애드온 전체"만 다시 훑어 cluster.status 를 덮어썼는데, 핵심 점검
        번들의 reachability 판정을 무시하는 비대칭이 있었다(연결 자체가 끊긴 클러스터에서
        애드온 하나만 실행해도 상태가 healthy 로 보일 수 있었음). `cluster_status_service
        .recompute()` 가 핵심 번들·전체 애드온·opt-in 심층 점검을 모두 같은 규칙으로
        다시 집계한다.
        """
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
        self.db.flush()

        from app.services.cluster_status_service import recompute
        recompute(self.db, cluster_id)
        return result

    def preview_addon_check(
        self, cluster: Cluster, addon_type: str, config: dict | None = None,
    ) -> CheckResult:
        """저장하지 않은 애드온 설정으로 ad-hoc 1회 실행 — 등록 마법사의 "테스트" 단계.

        실제 Addon 로우를 만들지 않는다 — 세션에 추가(add)하지도, 커밋하지도 않는 transient
        인스턴스를 체커에 넘긴다. 체커는 addon.type/addon.config/addon.name 만 읽으므로 안전하다.
        """
        transient = Addon(cluster_id=cluster.id, type=addon_type, name=addon_type, config=config or {})
        return self._dispatch(cluster, transient)

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
