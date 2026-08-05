"""Isilon(OneFS) NFS 수집 공유 서비스.

deep checker(``isilon_nfs``) 와 전용 모니터링 페이지(``/isilon-nfs/overview``) 가 **동일한**
명령 정의·파서·캐시를 쓰도록 수집 로직을 이 한 곳에 모은다.

## 부하 보호 (NAS 무부하 — 최우선)
1. **읽기 전용만**: ``validate_isi_command`` 가 저장/실행 전 allowlist 검증. ``isi`` 로 시작하는
   조회성 명령만 허용하고, 변경 동사(create/delete/modify/...)·셸 메타문자(``;`` ``|`` `` ` `` 등)·
   지속 세션 플래그(``--repeat``/``--interval``/``--continuously``) 는 거부한다.
2. **단발성·직렬 실행**: 한 번의 수집은 SSH 세션 **1개**만 열어 명령을 순차 실행한다
   (병렬/bulk 없음 → 커넥션 스파이크 없음). 명령별 짧은 exec timeout.
3. **TTL 캐시**: 서버별 스냅샷을 메모리에 캐시(기본 60s). 페이지 새로고침·다중 뷰어·cron 이
   겹쳐도 간격 내에는 캐시를 돌려주고 실제 SSH 는 하지 않는다. 강제 재수집은 ``force=True`` 만.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime
from typing import Any, Optional

import paramiko

from app.models.isilon_server import IsilonCommand, IsilonServer
from app.services import ssh_runner
from app.services.secret_box import decrypt as decrypt_secret

logger = logging.getLogger(__name__)

# 캐시 기본 TTL(초). 이 간격 안에는 SSH 를 다시 열지 않는다.
DEFAULT_CACHE_TTL_SECONDS = 60
# 명령 1건의 기본/최대 exec timeout(초) — NAS 에 오래 매달리지 않도록 상한.
DEFAULT_COMMAND_TIMEOUT = 15
MAX_COMMAND_TIMEOUT = 60
# JSON 출력이 클 수 있으므로 넉넉히(예: exports/quotas 목록).
MAX_STDOUT_CHARS = 300_000
CONNECT_TIMEOUT = 8

# ── 부하 보호: 명령 검증 ──────────────────────────────────────────────────────
# 셸 메타문자(체이닝/리다이렉트/서브셸/파이프) — 단일 isi 호출만 허용.
_SHELL_METACHARS = (";", "|", "&", "`", "$(", "${", ">", "<", "\n", "\r", "\\")
# 변경/파괴/무거운 동사 — 어느 토큰에라도 등장하면 거부(읽기 전용 보장).
_BLOCKED_TOKENS = frozenset({
    "create", "delete", "remove", "rm", "modify", "set", "unset",
    "enable", "disable", "reboot", "restart", "shutdown", "halt", "poweroff",
    "kill", "mv", "cp", "rename", "revert", "edit", "write", "format",
    "mkdir", "touch", "chmod", "chown", "reset", "flush", "purge", "drain",
})
# 지속 세션/폴링 플래그 — statistics 를 계속 돌려 부하 유발. 거부.
_BLOCKED_FLAGS = ("--repeat", "--interval", "--continuously", "--force", "--top")


class IsiCommandRejected(ValueError):
    """읽기 전용/무부하 정책을 위반한 명령."""


def validate_isi_command(command: Optional[str]) -> str:
    """읽기 전용·무부하 정책 검증. 통과하면 정규화된 command 문자열을 반환,
    위반하면 ``IsiCommandRejected`` 를 던진다.
    """
    if not command or not command.strip():
        raise IsiCommandRejected("명령이 비어 있습니다.")
    cmd = command.strip()

    for meta in _SHELL_METACHARS:
        if meta in cmd:
            raise IsiCommandRejected(
                f"셸 메타문자('{meta}')는 허용되지 않습니다 — 단일 isi 조회 명령만 등록하세요."
            )

    tokens = cmd.split()
    if tokens[0] != "isi":
        raise IsiCommandRejected("명령은 반드시 'isi' 로 시작해야 합니다.")

    lowered = [t.lower() for t in tokens]
    for t in lowered:
        # 플래그가 아닌 순수 토큰만 동사 블록리스트와 비교.
        if not t.startswith("-") and t in _BLOCKED_TOKENS:
            raise IsiCommandRejected(
                f"변경/위험 동사('{t}')가 포함되어 거부되었습니다 — 조회(list/view/status/statistics) "
                "명령만 허용됩니다."
            )
    for flag in _BLOCKED_FLAGS:
        if flag in lowered:
            raise IsiCommandRejected(
                f"부하 유발 플래그('{flag}')는 허용되지 않습니다 — 단발 스냅샷 명령만 등록하세요."
            )
    return cmd


# ── 기본(builtin) 명령 정의 — 시드가 사용 ────────────────────────────────────
# 운영자가 편집/비활성/추가할 수 있도록 전부 IsilonCommand 로 시드한다.
# 무거운 statistics 는 enabled=False 로 등록만 해둔다(부하 보호 §4).
BUILTIN_COMMANDS: list[dict[str, Any]] = [
    {
        "key": "exports",
        "label": "NFS Exports",
        "section": "exports",
        "command": "isi nfs exports list --format json",
        "parse_mode": "json",
        "enabled": True,
        "sort_order": 10,
    },
    {
        "key": "nfs_settings",
        "label": "NFS 글로벌 설정",
        "section": "nfs_settings",
        "command": "isi nfs settings global view",
        "parse_mode": "text",
        "enabled": True,
        "sort_order": 20,
    },
    {
        "key": "quotas",
        "label": "쿼터 / 용량",
        "section": "quotas",
        "command": "isi quota quotas list --format json",
        "parse_mode": "json",
        "enabled": True,
        "sort_order": 30,
    },
    {
        "key": "node_health",
        "label": "클러스터 / 노드 상태",
        "section": "node_health",
        "command": "isi status -q",
        "parse_mode": "text",
        "enabled": True,
        "sort_order": 40,
    },
    {
        "key": "clients",
        "label": "NFS 클라이언트 통계",
        "section": "clients",
        "command": "isi statistics client --format json",
        "parse_mode": "json",
        "enabled": False,  # 무거움 — 필요 시 운영자가 활성화
        "sort_order": 50,
    },
    {
        "key": "protocol_stats",
        "label": "NFS 프로토콜 통계",
        "section": "clients",
        "command": "isi statistics protocol --protocols nfs3 nfs4 --format json",
        "parse_mode": "json",
        "enabled": False,  # 무거움 — opt-in
        "sort_order": 60,
    },
]


# ── 서버/자격증명/명령 조회 ───────────────────────────────────────────────────
def get_server(db, server_id: Optional[str] = None) -> Optional[IsilonServer]:
    """server_id 로 조회. 없으면 is_default, 그것도 없으면 유일 서버."""
    q = db.query(IsilonServer)
    if server_id:
        return q.filter(IsilonServer.id == server_id).first()
    default = q.filter(IsilonServer.is_default == True).first()  # noqa: E712
    if default:
        return default
    servers = q.limit(2).all()
    return servers[0] if len(servers) == 1 else None


def resolve_target(server: IsilonServer) -> ssh_runner.SSHTarget:
    """IsilonServer 의 암호화 자격증명을 복호해 SSHTarget 구성."""
    password = None
    private_key = None
    try:
        password = decrypt_secret(server.encrypted_password)
    except ValueError:
        password = None
    try:
        private_key = decrypt_secret(server.encrypted_private_key)
    except ValueError:
        private_key = None
    return ssh_runner.SSHTarget(
        host=server.host,
        port=server.port or 22,
        username=server.username or "root",
        password=password,
        private_key=private_key,
        name=server.name,
    )


def effective_commands(db, server: IsilonServer) -> list[IsilonCommand]:
    """글로벌 기본 + 해당 서버 오버라이드를 병합. 같은 key 는 서버 전용이 우선.
    enabled=True 만 반환. sort_order 오름차순.
    """
    rows = (
        db.query(IsilonCommand)
        .filter(
            (IsilonCommand.server_id == None)  # noqa: E711
            | (IsilonCommand.server_id == server.id)
        )
        .all()
    )
    by_key: dict[str, IsilonCommand] = {}
    for r in rows:
        # 서버 전용(server_id 존재)이 글로벌을 덮어쓴다.
        existing = by_key.get(r.key)
        if existing is None or (existing.server_id is None and r.server_id is not None):
            by_key[r.key] = r
    enabled = [c for c in by_key.values() if c.enabled]
    enabled.sort(key=lambda c: (c.sort_order or 100, c.key))
    return enabled


# ── TTL 캐시 ──────────────────────────────────────────────────────────────────
_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_CACHE_LOCK = threading.Lock()


def _cache_get(server_id: str, ttl: float) -> Optional[dict[str, Any]]:
    with _CACHE_LOCK:
        entry = _CACHE.get(server_id)
        if not entry:
            return None
        ts, snap = entry
        if (time.monotonic() - ts) <= ttl:
            cached = dict(snap)
            cached["from_cache"] = True
            return cached
        return None


def _cache_put(server_id: str, snap: dict[str, Any]) -> None:
    with _CACHE_LOCK:
        _CACHE[server_id] = (time.monotonic(), snap)


def clear_cache(server_id: Optional[str] = None) -> None:
    with _CACHE_LOCK:
        if server_id:
            _CACHE.pop(server_id, None)
        else:
            _CACHE.clear()


# ── 수집 ──────────────────────────────────────────────────────────────────────
def _run_one(client: "paramiko.SSHClient", cmd: IsilonCommand) -> dict[str, Any]:
    """열려 있는 SSH 세션에서 명령 1건 실행 + 파싱. 예외는 삼켜 결과 dict 로 반환."""
    timeout = min(int(cmd.timeout_seconds or DEFAULT_COMMAND_TIMEOUT), MAX_COMMAND_TIMEOUT)
    result: dict[str, Any] = {
        "key": cmd.key,
        "label": cmd.label,
        "section": cmd.section,
        "command": cmd.command,
        "parse_mode": cmd.parse_mode,
        "show_on_overview": bool(cmd.show_on_overview),
        "ok": False,
        "exit_code": None,
        "parsed": None,
        "raw": "",
        "error": None,
        "duration_ms": 0,
    }
    start = time.monotonic()
    try:
        # 안전장치: 저장 이후 손상/우회된 명령도 실행 직전 재검증.
        validate_isi_command(cmd.command)
        _stdin, stdout, stderr = client.exec_command(cmd.command, timeout=timeout, get_pty=False)
        out = stdout.read().decode("utf-8", errors="replace")[:MAX_STDOUT_CHARS]
        err = stderr.read().decode("utf-8", errors="replace")[:4000]
        rc = stdout.channel.recv_exit_status()
        result["exit_code"] = rc
        result["raw"] = out
        result["ok"] = rc == 0
        if rc != 0 and err:
            result["error"] = err.strip()[:1000]
        if cmd.parse_mode == "json" and out.strip():
            try:
                result["parsed"] = json.loads(out)
                result["raw"] = ""  # 파싱 성공 시 원문 중복 저장 안 함
            except (json.JSONDecodeError, ValueError) as e:
                result["error"] = f"JSON 파싱 실패: {str(e)[:150]}"
    except IsiCommandRejected as e:
        result["error"] = f"거부된 명령: {e}"
    except Exception as e:  # noqa: BLE001 — 한 명령 실패가 전체를 죽이지 않게.
        result["error"] = str(e)[:500]
    finally:
        result["duration_ms"] = int((time.monotonic() - start) * 1000)
    return result


def collect_nfs_snapshot(db, server: IsilonServer, *, force: bool = False) -> dict[str, Any]:
    """Isilon 에서 NFS 스냅샷을 수집. 부하 보호: TTL 캐시 + SSH 세션 1개 + 직렬 실행.

    반환:
    ``{server, collected_at, from_cache, connection_ok, connection_error,
       results:[...], errors:[...]}``
    """
    sid = str(server.id)
    ttl = DEFAULT_CACHE_TTL_SECONDS
    if not force:
        cached = _cache_get(sid, ttl)
        if cached is not None:
            return cached

    commands = effective_commands(db, server)
    snapshot: dict[str, Any] = {
        "server": {"id": sid, "name": server.name, "host": server.host},
        "collected_at": datetime.utcnow().isoformat() + "Z",
        "from_cache": False,
        "connection_ok": False,
        "connection_error": None,
        "results": [],
        "errors": [],
    }

    target = resolve_target(server)
    if not target.password and not target.private_key:
        snapshot["connection_error"] = "저장된 자격증명이 없습니다. 서버 설정에서 비밀번호 또는 키를 등록하세요."
        _cache_put(sid, snapshot)
        return snapshot

    client: Optional[paramiko.SSHClient] = None
    try:
        # 부하 보호: 세션 1개만 열어 모든 명령을 순차 실행.
        client = ssh_runner._build_client(target, CONNECT_TIMEOUT)
        snapshot["connection_ok"] = True
        for cmd in commands:
            res = _run_one(client, cmd)
            snapshot["results"].append(res)
            if res.get("error"):
                snapshot["errors"].append(f"{cmd.label}: {res['error']}")
    except paramiko.AuthenticationException as e:
        snapshot["connection_error"] = f"인증 실패: {str(e)[:150]}"
    except Exception as e:  # noqa: BLE001
        snapshot["connection_error"] = f"연결 실패: {str(e)[:200]}"
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    _cache_put(sid, snapshot)
    return snapshot


def run_selected_commands(db, server: IsilonServer, keys: list[str]) -> dict[str, Any]:
    """등록된 명령 중 선택한 키만 온디맨드 실행(캐시 미사용) — mc 클라이언트처럼 사용자가
    고른 것만 실행한다. 임의 문자열은 받지 않고 ``effective_commands`` 에 있는(=등록·활성화된)
    키만 허용해 UI-First 등록 정책을 그대로 지킨다. 부하 보호는 ``collect_nfs_snapshot`` 과
    동일: SSH 세션 1개, 직렬 실행.
    """
    sid = str(server.id)
    requested = set(keys)
    # effective_commands() 순서(sort_order)를 그대로 따른다 — 화면에 보이는 순서와 결과 순서가
    # 요청 배열 순서에 좌우되지 않고 항상 일치하게.
    ordered = effective_commands(db, server)
    selected = [c for c in ordered if c.key in requested]
    skipped = requested - {c.key for c in ordered}

    result: dict[str, Any] = {
        "server": {"id": sid, "name": server.name, "host": server.host},
        "executed_at": datetime.utcnow().isoformat() + "Z",
        "connection_ok": False,
        "connection_error": None,
        "results": [],
        "skipped_keys": [k for k in keys if k in skipped],
    }
    if not selected:
        result["connection_error"] = "실행할 명령이 없습니다 (등록/활성화 여부를 확인하세요)."
        return result

    target = resolve_target(server)
    if not target.password and not target.private_key:
        result["connection_error"] = "저장된 자격증명이 없습니다. 서버 설정에서 비밀번호 또는 키를 등록하세요."
        return result

    client: Optional[paramiko.SSHClient] = None
    try:
        client = ssh_runner._build_client(target, CONNECT_TIMEOUT)
        result["connection_ok"] = True
        for cmd in selected:
            result["results"].append(_run_one(client, cmd))
    except paramiko.AuthenticationException as e:
        result["connection_error"] = f"인증 실패: {str(e)[:150]}"
    except Exception as e:  # noqa: BLE001
        result["connection_error"] = f"연결 실패: {str(e)[:200]}"
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass

    return result
