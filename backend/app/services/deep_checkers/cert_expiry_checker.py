"""K8s 컨트롤 플레인 인증서 만료 점검.

실행 경로 2가지 (params.source 로 선택 — UI 설정 편집에서 변경, etcd_defrag 와 동일 관례):
- **pod**      : kube-system 의 kube-apiserver 파드에서 ``kubectl exec`` 로
  ``kubeadm certs check-expiration`` 실행을 시도한다. **대부분의 최신 클러스터에서
  실패한다** — kube-apiserver 공식 이미지는 distroless(쉘/kubeadm 바이너리 없음)라
  exec 자체가 안 되는 경우가 많다. 파드가 없거나 실행이 실패하면 그 이유를
  단계(steps)에 남긴다.
- **snapshot** : "버전 / 설정 관리(/versions)" 화면(kubeadm 인증서 만료 수집)에서
  SSH 로 호스트에서 직접 실행해 수집해 둔 ``kubeadm_certs:{host}`` 스냅샷을 읽는다
  — 체커가 직접 SSH 하지 않으므로 자격증명을 params 에 저장할 필요가 없다
  (etcd_defrag 의 ``etcdctl_config:{host}`` 스냅샷 폴백과 동일 패턴).
- **auto**(기본): pod 를 먼저 시도하고, 파드가 없거나 exec 이 실패하면 snapshot 으로
  폴백한다(etcd_defrag 은 "파드 없음"에서만 폴백하지만, cert_expiry 는 파드가 있어도
  exec 자체가 구조적으로 실패하는 경우가 흔해 "exec 실패"에서도 폴백한다).
"""
from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any, Optional

from app.models import StatusEnum
from app.services.deep_checkers.base import (
    DeepCheckContext,
    DeepCheckOutcome,
    DeepCheckerBase,
)

logger = logging.getLogger(__name__)


# kubeadm 의 RESIDUAL TIME 은 HumanDuration 포맷(예: "362d", "9y", "1y64d", "23h").
# 'd' 만 잡던 기존 정규식은 연/주 단위(CA 인증서 등)를 통째로 놓쳐 rows 에서 누락됐다.
_DURATION_RE = re.compile(r"(\d+)\s*(y|w|d|h)")


def _residual_days(line: str) -> int | None:
    """한 라인에서 잔여기간 토큰(y/w/d/h)을 모아 일수로 환산. 없으면 None."""
    total = 0.0
    found = False
    for num, unit in _DURATION_RE.findall(line):
        found = True
        n = int(num)
        if unit == "y":
            total += n * 365
        elif unit == "w":
            total += n * 7
        elif unit == "d":
            total += n
        elif unit == "h":
            total += n / 24
    return int(total) if found else None


def _parse_kubeadm_output(stdout: str) -> list[dict[str, Any]]:
    """``kubeadm certs check-expiration`` 출력의 핵심 라인 파싱.

    예시:
    ``apiserver         Aug 12, 2026 10:11 UTC   362d   ca   no``
    """
    rows: list[dict[str, Any]] = []
    for raw in (stdout or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("CERTIFICATE"):
            continue
        days = _residual_days(line)
        if days is None:
            continue
        # 첫 토큰 = 인증서 이름
        name = line.split()[0]
        rows.append({
            "name": name,
            "residual_days": days,
            "raw": line[:200],
        })
    return rows


def _verdict(rows: list[dict[str, Any]], warning_days: int, critical_days: int) -> tuple[StatusEnum, int]:
    min_days = min(r["residual_days"] for r in rows)
    status = StatusEnum.healthy
    if min_days <= critical_days:
        status = StatusEnum.critical
    elif min_days <= warning_days:
        status = StatusEnum.warning
    return status, min_days


class CertExpiryChecker(DeepCheckerBase):
    check_type = "cert_expiry"
    display_name = "인증서 만료"

    def run(self, ctx: DeepCheckContext) -> DeepCheckOutcome:
        warning_days = int(ctx.thresholds.get("warning_days", 30))
        critical_days = int(ctx.thresholds.get("critical_days", 7))
        source = str(ctx.params.get("source", "auto")).lower()
        snapshot_max_age_hours = int(ctx.params.get("snapshot_max_age_hours", 24))

        if source == "snapshot":
            return self._check_via_snapshot(ctx, warning_days, critical_days, snapshot_max_age_hours)

        return self._check_via_kubeadm_pod(ctx, warning_days, critical_days, fallback_ok=(source == "auto"))

    def _check_via_kubeadm_pod(
        self,
        ctx: DeepCheckContext,
        warning_days: int,
        critical_days: int,
        *,
        fallback_ok: bool,
    ) -> DeepCheckOutcome:
        snapshot_max_age_hours = int(ctx.params.get("snapshot_max_age_hours", 24))

        with self._step("locate_pod", "컨트롤플레인 파드 탐색") as st:
            v1 = self._v1(ctx)
            pods = v1.list_namespaced_pod(
                namespace="kube-system",
                label_selector="component=kube-apiserver",
                timeout_seconds=10,
            )
            target = None
            for p in pods.items:
                if p.status and p.status.phase == "Running":
                    target = p
                    break
            if target is None:
                if fallback_ok:
                    st.status = "skipped"
                    st.detail = "Running kube-apiserver 파드 없음 → 수집 스냅샷 폴백"
                    return self._check_via_snapshot(ctx, warning_days, critical_days, snapshot_max_age_hours)
                st.status = "failed"
                st.detail = "Running kube-apiserver 파드 없음"
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message="kubeadm 컨트롤 플레인 파드를 찾지 못해 인증서 만료를 직접 확인할 수 없습니다.",
                    details={"reason": "kubeadm_not_found"},
                )
            st.detail = f"kube-system/{target.metadata.name}"

        with self._step("exec_kubeadm", "kubeadm certs check-expiration 실행") as st:
            proc = self._kubectl(
                ctx, "-n", "kube-system", "exec", target.metadata.name, "--",
                "kubeadm", "certs", "check-expiration", timeout=20,
            )
            st.metrics = {"rc": proc.returncode}
            if proc.returncode != 0:
                # kube-apiserver 공식 이미지는 distroless(쉘/kubeadm 바이너리 없음)인 경우가
                # 많고, 그 외에도 "Internal error occurred" 처럼 클러스터마다 다른 이유로
                # exec 자체가 거부되기도 한다 — pending 으로 뭉개지 말고 "왜"(exit code +
                # stderr)를 그대로 남기고, auto 모드면 스냅샷으로 폴백한다. UI(steps/DB)만
                # 보지 않는 운영자도 서버 로그로 추적할 수 있도록 warning 도 함께 남긴다.
                st.status = "failed"
                stderr_excerpt = (proc.stderr or "")[:300]
                st.detail = f"rc={proc.returncode} · {stderr_excerpt}"
                cluster_label = getattr(ctx.cluster, "name", None) or "(no cluster)"
                logger.warning(
                    "cert_expiry: kubectl exec kubeadm certs check-expiration 실패 "
                    "(cluster=%s, pod=%s, rc=%s): %s",
                    cluster_label, target.metadata.name, proc.returncode, stderr_excerpt,
                )
                if fallback_ok:
                    logger.info(
                        "cert_expiry: pod exec 실패 → snapshot 폴백 (cluster=%s)", cluster_label,
                    )
                    return self._check_via_snapshot(ctx, warning_days, critical_days, snapshot_max_age_hours)
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message="kubeadm certs check-expiration 실행 불가 (권한 부족 또는 파드 이미지에 "
                            "kubeadm 바이너리 없음 — 'K8s 인증서(kubeadm)' 화면에서 SSH 수집 후 "
                            "source=snapshot 을 쓰세요).",
                    details={"returncode": proc.returncode, "stderr": (proc.stderr or "")[:1000]},
                )
            st.detail = f"exit 0 · {len(proc.stdout or '')} bytes 출력"

        with self._step("parse", "인증서 잔여일 파싱") as st:
            rows = _parse_kubeadm_output(proc.stdout)
            if not rows:
                st.status = "failed"
                st.detail = "출력에서 유효한 행을 찾지 못함"
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message="kubeadm 출력 파싱 실패",
                    details={"raw": (proc.stdout or "")[:2000]},
                )
            st.detail = f"{len(rows)}개 인증서 파싱됨"

        with self._step("verdict", "최소 잔여일 임계 비교") as st:
            status_enum, min_days = _verdict(rows, warning_days, critical_days)
            st.detail = f"최소 잔여일 {min_days} (warning={warning_days}, critical={critical_days}) → {status_enum.value}"
            st.metrics = {"min_residual_days": min_days, "status": status_enum.value}

        return DeepCheckOutcome(
            status=status_enum,
            message=f"가장 짧은 인증서: {min_days}일 남음 ({len(rows)}개 점검, pod exec)",
            details={
                "source": "pod",
                "min_residual_days": min_days,
                "warning_days": warning_days,
                "critical_days": critical_days,
                "rows": rows,
            },
        )

    # ── SSH 로 수집한 kubeadm_certs 스냅샷 기반 점검 (etcd_defrag 의 snapshot 경로와 동일) ──
    def _check_via_snapshot(
        self,
        ctx: DeepCheckContext,
        warning_days: int,
        critical_days: int,
        max_age_hours: int,
    ) -> DeepCheckOutcome:
        """"버전 / 설정 관리(/versions)" 화면의 "K8s 인증서(kubeadm)" 수집 버튼이 SSH 로
        호스트에서 직접 실행해 저장해 둔 ``kubeadm_certs:{host}`` 스냅샷을 읽는다.

        체커가 직접 SSH 하지 않는 이유: 자격증명을 정의 params(JSONB, 런북/로그에
        노출)에 저장하지 않기 위해서다 — 수집은 별도 UI 흐름(요청 시에만 자격증명 사용,
        미저장)을 그대로 쓴다.
        """
        collect_hint = (
            "'버전 / 설정 관리(/versions)' 화면의 'K8s 인증서(kubeadm)' 버튼으로 컨트롤 "
            "플레인 노드에서 SSH 로 kubeadm certs check-expiration 을 먼저 수집하세요."
        )
        with self._step("snapshot", "수집된 kubeadm_certs 스냅샷 조회") as st:
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
                        ClusterConfigSnapshot.component.like("kubeadm_certs:%"),
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
                st.detail = "kubeadm_certs 스냅샷 없음"
                logger.warning(
                    "cert_expiry: kubeadm_certs 스냅샷 없음 (cluster=%s) — %s",
                    getattr(ctx.cluster, "name", None) or "(no cluster)", collect_hint,
                )
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message=f"수집된 kubeadm 인증서 스냅샷이 없습니다. {collect_hint}",
                    details={"reason": "no_snapshot"},
                )
            st.detail = f"호스트 {len(latest_per_host)}개"

        with self._step("parse", "인증서 잔여일 파싱") as st:
            all_rows: list[dict[str, Any]] = []
            newest_at: Optional[datetime] = None
            per_host_errors: list[dict[str, Any]] = []
            for comp_key, snap in latest_per_host.items():
                host = comp_key.split(":", 1)[1] if ":" in comp_key else comp_key
                if snap.collected_at and (newest_at is None or snap.collected_at > newest_at):
                    newest_at = snap.collected_at
                raw = (snap.data or {}).get("check_expiration_output")
                if not raw:
                    per_host_errors.append({"host": host, "error": "check_expiration_output 없음"})
                    continue
                rows = _parse_kubeadm_output(raw)
                if not rows:
                    per_host_errors.append({"host": host, "error": "파싱 가능한 행 없음"})
                    continue
                for r in rows:
                    r["host"] = host
                all_rows.extend(rows)
            if not all_rows:
                st.status = "failed"
                st.detail = "파싱 가능한 호스트 없음"
                return DeepCheckOutcome(
                    status=StatusEnum.pending,
                    message=f"스냅샷에서 인증서 정보를 파싱하지 못했습니다. {collect_hint}",
                    details={"source": "snapshot", "errors": per_host_errors},
                )
            st.detail = f"{len(all_rows)}개 인증서 파싱됨 ({len(latest_per_host)}개 호스트)"

        with self._step("verdict", "최소 잔여일 임계 비교") as st:
            age_hours: Optional[float] = None
            if newest_at is not None:
                age_hours = round((datetime.utcnow() - newest_at).total_seconds() / 3600, 1)
            stale = age_hours is not None and age_hours > max_age_hours
            status_enum, min_days = _verdict(all_rows, warning_days, critical_days)
            if stale:
                status_enum = StatusEnum.pending
                message = (
                    f"스냅샷이 {age_hours}시간 전 것이라 판정하지 않습니다"
                    f"(허용 {max_age_hours}h). {collect_hint}"
                )
            else:
                message = f"가장 짧은 인증서: {min_days}일 남음 ({len(all_rows)}개 점검, snapshot)"
            st.detail = f"{message} → {status_enum.value}"
            st.metrics = {"min_residual_days": min_days, "status": status_enum.value}

        return DeepCheckOutcome(
            status=status_enum,
            message=message,
            details={
                "source": "snapshot",
                "min_residual_days": min_days,
                "warning_days": warning_days,
                "critical_days": critical_days,
                "rows": all_rows,
                "snapshot_age_hours": age_hours,
                "snapshot_max_age_hours": max_age_hours,
                "host_errors": per_host_errors,
            },
        )
