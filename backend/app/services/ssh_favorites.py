"""SSH 터미널 즐겨찾기 명령 — 기본 명령(프리셋)과 사용자별 시드·복원.

기본 명령은 삭제된 커널 파라미터 콘솔(``KernelParamsPage``)의 조회 프리셋을 그대로 옮긴 것이다(전부 조회 전용이라
누르면 바로 실행). 사용자가 처음 목록을 열면 그 사용자 몫으로 복사되고, 그 뒤로는 사용자의 행이 원본이다.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.ssh_favorite import SshFavoriteCommand


@dataclass(frozen=True)
class SshFavoritePreset:
    key: str
    name: str
    description: str
    command: str
    run_mode: str = "run"


PRESETS: tuple[SshFavoritePreset, ...] = (
    SshFavoritePreset(
        key='os-info',
        name='OS·커널 정보',
        description='OS 이름/버전, 커널, 호스트명, 가동시간, CPU',
        command="echo '### os-release ###' && cat /etc/os-release 2>/dev/null | head -15 && echo && echo '### uname ###' && uname -a && echo && echo '### uptime ###' && uptime && echo && echo '### cpu ###' && lscpu 2>/dev/null | head -20 || cat /proc/cpuinfo | head -20",
    ),
    SshFavoritePreset(
        key='sysctl-net',
        name='sysctl — 네트워크 (k8s/cilium 관련)',
        description='net.ipv4.ip_forward, bridge-nf, conntrack, somaxconn 등',
        command="sysctl -a 2>/dev/null | grep -E '^(net\\.ipv4\\.ip_forward|net\\.ipv4\\.conf\\.all\\.|net\\.bridge\\.|net\\.core\\.|net\\.netfilter\\.|net\\.ipv6\\.conf\\.default\\.disable_ipv6)' | sort",
    ),
    SshFavoritePreset(
        key='conntrack',
        name='conntrack 현재치 vs 최대치',
        description='nf_conntrack_count / max 비율. k8s 네트워크 이슈 진단',
        command='sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max 2>/dev/null; echo; cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null; cat /proc/sys/net/netfilter/nf_conntrack_max 2>/dev/null',
    ),
    SshFavoritePreset(
        key='sysctl-mem',
        name='sysctl — 메모리 / VM',
        description='vm.max_map_count, swappiness, overcommit 등',
        command="sysctl -a 2>/dev/null | grep -E '^(vm\\.|kernel\\.shm|kernel\\.msgmax|kernel\\.sem)' | sort",
    ),
    SshFavoritePreset(
        key='sysctl-fs',
        name='sysctl — 파일시스템 / inotify',
        description='fs.file-max, fs.inotify.*',
        command="sysctl -a 2>/dev/null | grep -E '^(fs\\.|kernel\\.pid_max)' | sort",
    ),
    SshFavoritePreset(
        key='sysctl-conf-files',
        name='/etc/sysctl.d/ 파일 목록 + 내용',
        description='부팅 시 적용되는 sysctl 파일들',
        command='ls -la /etc/sysctl.d/ 2>/dev/null && echo && for f in /etc/sysctl.d/*.conf /etc/sysctl.conf; do [ -f "$f" ] && echo && echo "### $f ###" && cat "$f"; done',
    ),
    SshFavoritePreset(
        key='limits',
        name='ulimit / limits.conf',
        description='사용자별 파일 핸들/프로세스 제한',
        command='echo \'### ulimit -a (현재 쉘) ###\' && ulimit -a && echo && echo \'### /etc/security/limits.conf ###\' && grep -vE \'^\\s*(#|$)\' /etc/security/limits.conf 2>/dev/null && echo && echo \'### /etc/security/limits.d/ ###\' && for f in /etc/security/limits.d/*.conf; do [ -f "$f" ] && echo "=== $f ===" && grep -vE \'^\\s*(#|$)\' "$f"; done',
    ),
    SshFavoritePreset(
        key='memory',
        name='메모리 / swap 상태',
        description='free, swap, cgroup memory',
        command="free -h && echo && swapon --show 2>/dev/null && echo && echo '### /proc/meminfo head ###' && head -25 /proc/meminfo",
    ),
    SshFavoritePreset(
        key='disk-io',
        name='디스크 I/O / 마운트',
        description='df, lsblk, mount, IO scheduler',
        command='df -hT 2>/dev/null | head -25 && echo && lsblk 2>/dev/null && echo && mount | grep -v -E \'^(proc|sysfs|tmpfs|devpts|cgroup|overlay|fuse)\' | head -20 && echo && echo \'### IO scheduler ###\' && for d in /sys/block/*/queue/scheduler; do echo "$d → $(cat $d 2>/dev/null)"; done',
    ),
    SshFavoritePreset(
        key='kernel-modules',
        name='로드된 커널 모듈',
        description='lsmod — k8s/cilium 관련 (ip_tables, br_netfilter 등)',
        command="lsmod | head -1 && lsmod | grep -E '^(br_netfilter|nf_conntrack|iptable|ip_tables|ip_set|xt_|nfnetlink|bpf|cls_bpf|overlay)'",
    ),
    SshFavoritePreset(
        key='time-sync',
        name='시간 동기화 상태 (chronyd / NTP)',
        description='etcd 가 가장 민감 — time sync 필수',
        command="timedatectl 2>/dev/null && echo && chronyc tracking 2>/dev/null || ntpstat 2>/dev/null || echo '(chronyc/ntpstat 없음)'",
    ),
)
PRESET_BY_KEY = {p.key: p for p in PRESETS}


def _preset_row(username: str, p: SshFavoritePreset, order: int) -> SshFavoriteCommand:
    return SshFavoriteCommand(
        username=username, name=p.name, description=p.description, command=p.command,
        run_mode=p.run_mode, sort_order=order, preset_key=p.key, hidden=False,
    )


def ensure_seeded(db: Session, username: str) -> None:
    """행이 하나도 없는(숨긴 행 포함) 사용자에게만 기본 명령을 복사한다 — 지운 기본 명령은 되살아나지 않는다."""
    exists = db.query(SshFavoriteCommand.id).filter(SshFavoriteCommand.username == username).first()
    if exists:
        return
    for i, p in enumerate(PRESETS):
        db.add(_preset_row(username, p, i))
    db.commit()


def reset_presets(db: Session, username: str) -> None:
    """기본값 복원 — 기본 명령 행을 지우고 원래대로 앞에 다시 만든다. 사용자가 만든 명령은 그대로 뒤에 둔다."""
    db.query(SshFavoriteCommand).filter(
        SshFavoriteCommand.username == username, SshFavoriteCommand.preset_key.isnot(None),
    ).delete(synchronize_session=False)
    custom = (
        db.query(SshFavoriteCommand)
        .filter(SshFavoriteCommand.username == username)
        .order_by(SshFavoriteCommand.sort_order, SshFavoriteCommand.created_at)
        .all()
    )
    for i, p in enumerate(PRESETS):
        db.add(_preset_row(username, p, i))
    for j, row in enumerate(custom):
        row.sort_order = len(PRESETS) + j
    db.commit()


def is_modified(row: SshFavoriteCommand) -> bool:
    p = PRESET_BY_KEY.get(row.preset_key or "")
    if p is None:
        return False
    return (row.name, row.description or "", row.command, row.run_mode) != (p.name, p.description, p.command, p.run_mode)


def to_response(row: SshFavoriteCommand) -> dict:
    return {
        "id": row.id, "name": row.name, "description": row.description, "command": row.command,
        "run_mode": row.run_mode, "sort_order": row.sort_order, "preset_key": row.preset_key,
        "modified": is_modified(row), "created_at": row.created_at, "updated_at": row.updated_at,
    }
