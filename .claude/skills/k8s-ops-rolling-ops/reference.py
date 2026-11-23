"""Rolling operations — KM(K8s Manager) 롤링 재시작 / 노드 빼기·넣기 / 유지보수 모드 패턴.

KM 롤링 재시작 옵션: worker_batch_size, worker_fail_count_threshold, sleep_seconds,
stale_configs_only, unupgraded_only, restart_role_types, restart_role_names.
노드 빼기(decommission)/넣기(recommission_with_start), enter/exit_maintenance_mode.

핵심: (1) 마스터는 하나씩 먼저, (2) 워커는 배치로, (3) 배치 실패 허용치,
(4) 배치 사이 sleep + 헬스 게이트, (5) stale/미업그레이드만 골라 재시작.
순수 계획/실행 로직 — 실제 K8s 호출은 콜백으로 주입한다.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Iterable


@dataclass(frozen=True)
class Target:
    """재시작/드레인 대상 1개 (K8s: 노드, 파드, 워크로드)."""
    name: str
    role_type: str  # 예: "control-plane", "etcd", "worker", "ingress"
    is_master: bool = False  # 마스터 역할. 하나씩, 먼저.
    config_stale: bool = False  # 원하는 설정 해시 != 적용 해시
    upgraded: bool = True  # 목표 버전/이미지로 이미 바뀌었는가
    maintenance: bool = False


@dataclass
class RollingOptions:
    batch_size: int = 1  # KM workerBatchSize (>0). 스토리지/쿼럼은 복제 수보다 작게
    fail_threshold: int = 0  # KM workerFailCountThreshold: 허용 가능한 실패 *배치* 수
    sleep_seconds: float = 0  # 배치 사이 대기
    stale_only: bool = False
    unupgraded_only: bool = False
    role_types: tuple[str, ...] = ()  # 비면 전부
    names: tuple[str, ...] = ()  # 비면 role_types 전부
    skip_maintenance: bool = True  # 유지보수 중 대상은 건드리지 않음

    def validate(self) -> list[str]:
        e = []
        if self.batch_size < 1:
            e.append("batch_size must be >= 1")
        if self.fail_threshold < 0:
            e.append("fail_threshold must be >= 0")
        if self.sleep_seconds < 0:
            e.append("sleep_seconds must be >= 0")
        return e


@dataclass
class Plan:
    masters: list[Target]
    batches: list[list[Target]]
    skipped: list[tuple[Target, str]] = field(default_factory=list)

    def describe(self) -> list[str]:
        out = [f"master {i + 1}/{len(self.masters)}: {t.name}" for i, t in enumerate(self.masters)]
        out += [f"batch {i + 1}/{len(self.batches)}: {', '.join(t.name for t in b)}" for i, b in enumerate(self.batches)]
        out += [f"skip {t.name}: {why}" for t, why in self.skipped]
        return out


def plan_rolling(targets: Iterable[Target], opt: RollingOptions) -> Plan:
    if errs := opt.validate():
        raise ValueError("; ".join(errs))
    masters, workers, skipped = [], [], []
    for t in targets:
        if opt.role_types and t.role_type not in opt.role_types:
            continue
        if opt.names and t.name not in opt.names:
            continue
        if opt.skip_maintenance and t.maintenance:
            skipped.append((t, "maintenance mode"))
            continue
        if opt.stale_only and not t.config_stale:
            skipped.append((t, "config fresh"))
            continue
        if opt.unupgraded_only and t.upgraded:
            skipped.append((t, "already upgraded"))
            continue
        (masters if t.is_master else workers).append(t)
    batches = [workers[i:i + opt.batch_size] for i in range(0, len(workers), opt.batch_size)]
    return Plan(masters, batches, skipped)


@dataclass
class RollingResult:
    success: bool
    failed_batches: int
    failed_targets: list[str]
    message: str


def execute_rolling(
    plan: Plan,
    opt: RollingOptions,
    restart: Callable[[Target], None],  # 예외 = 실패
    healthy: Callable[[Target], bool],  # 재시작 후 Ready/롤아웃 완료 확인 (내부에서 타임아웃 처리)
    log: Callable[[str], None] = print,
    checkpoint: Callable[[], None] = lambda: None,  # abort 지점 (command-tracking 의 ctx.checkpoint)
    sleep: Callable[[float], None] = time.sleep,
) -> RollingResult:
    failed: list[str] = []
    # 1) 마스터: 하나라도 실패하면 즉시 중단 (쿼럼/컨트롤 플레인 보호 — 허용치 적용 안 함)
    for t in plan.masters:
        checkpoint()
        log(f"[master] restart {t.name}")
        try:
            restart(t)
            if not healthy(t):
                raise RuntimeError("not healthy after restart")
        except Exception as e:
            log(f"[master] FAILED {t.name}: {e} — abort rolling")
            return RollingResult(False, 0, [t.name], f"master {t.name} failed: {e}")
    # 2) 워커 배치
    failed_batches = 0
    for i, batch in enumerate(plan.batches, 1):
        checkpoint()
        log(f"[batch {i}/{len(plan.batches)}] {', '.join(t.name for t in batch)}")
        batch_failed = False
        for t in batch:
            try:
                restart(t)
            except Exception as e:
                log(f"  restart failed {t.name}: {e}")
                failed.append(t.name)
                batch_failed = True
        for t in batch:
            if t.name not in failed and not healthy(t):
                log(f"  health gate failed {t.name}")
                failed.append(t.name)
                batch_failed = True
        if batch_failed:
            failed_batches += 1
            if failed_batches > opt.fail_threshold:
                msg = f"{failed_batches} batch(es) failed > threshold {opt.fail_threshold}"
                log(f"STOP: {msg}")
                return RollingResult(False, failed_batches, failed, msg)
        if opt.sleep_seconds and i < len(plan.batches):
            log(f"  sleep {opt.sleep_seconds}s")
            sleep(opt.sleep_seconds)
    ok = failed_batches == 0
    return RollingResult(ok, failed_batches, failed,
                         "completed" if ok else f"completed with {failed_batches} failed batch(es) (<= threshold)")


# ── Decommission / Recommission (KM 노드 빼기 / 넣기) ──
DECOMMISSION_STEPS = (
    ("maintenance_on", "유지보수 모드 ON — 알람 억제 (KM enter_maintenance_mode)"),
    ("cordon", "스케줄 차단 — kubectl cordon"),
    ("drain", "PDB 준수 eviction — kubectl drain --ignore-daemonsets --delete-emptydir-data"),
    ("verify_empty", "DaemonSet 외 파드 0 확인"),
)
RECOMMISSION_STEPS = (
    ("uncordon", "스케줄 재개 — kubectl uncordon"),
    ("verify_ready", "Node Ready + 필수 DaemonSet Ready"),
    ("maintenance_off", "유지보수 모드 OFF (KM exit_maintenance_mode)"),
)


def run_steps(steps, handlers: dict[str, Callable[[], None]], log: Callable[[str], None] = print) -> list[dict]:
    """단계별 실행 + 결과 기록. 실패 시 이후 단계 skipped."""
    out, failed = [], False
    for sid, label in steps:
        if failed:
            out.append({"id": sid, "label": label, "status": "skipped"})
            continue
        t0 = time.monotonic()
        try:
            handlers[sid]()
            st, detail = "ok", ""
        except Exception as e:
            st, detail, failed = "failed", str(e), True
        out.append({"id": sid, "label": label, "status": st, "detail": detail,
                    "duration_ms": int((time.monotonic() - t0) * 1000)})
        log(f"[{st}] {label} {detail}".rstrip())
    return out
