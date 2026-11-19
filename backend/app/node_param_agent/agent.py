"""노드 OS 파라미터 에이전트 — DaemonSet 으로 노드마다 떠서 sysctl 값을 PEP 로 보고한다.

**표준 라이브러리만 쓴다** — backend 이미지를 재사용하지만 ``app.config``·DB·SQLAlchemy 를 import 하지 않아
가볍고, 노드에서 DB 접속 정보가 필요 없다.

한 주기:
1. 감시 목록(지난 보고 응답으로 받은 파라미터)의 런타임 값을 ``/proc/sys`` 에서 읽는다.
2. 영구 설정 값을 sysctl 설정 파일에서 계산한다 — systemd-sysctl 과 같은 우선순위
   (``/etc`` > ``/run`` > ``/usr/local/lib`` > ``/usr/lib`` > ``/lib`` 의 ``sysctl.d/*.conf``, 파일 이름 순, 뒤에 적힌 값이 이김)
   + 마지막에 ``/etc/sysctl.conf``.
3. ``POST {PEP_API_URL}/node-params/agent/report`` — 응답의 ``params``·``interval_sec`` 로 다음 주기를 정한다.
   감시 대상은 PEP 화면에서 편집한다(첫 보고는 빈 목록 → 응답으로 목록을 받고 바로 다시 보고).

환경 변수: ``PEP_API_URL``(…/api/v1) · ``NODE_PARAM_INGEST_TOKEN`` · ``PEP_CLUSTER``(UUID 또는 이름) ·
``NODE_NAME`` · ``HOST_IP`` · ``HOST_ROOT``(호스트 설정 파일 마운트 위치, 기본 ``/host``) ·
``PEP_TLS_VERIFY``(기본 true) · ``PEP_CA_FILE``(사설 CA, 선택) · ``PROC_SYS``(기본 ``/proc/sys``).

점검용: ``python -m app.node_param_agent --dry-run --param net.core.somaxconn`` — 보내지 않고 읽은 값만 출력.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import random
import signal
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

AGENT_VERSION = "1.0.0"

# systemd-sysctl 우선순위 — 같은 파일 이름이면 앞 디렉터리가 이긴다.
SYSCTL_D_DIRS = ("etc/sysctl.d", "run/sysctl.d", "usr/local/lib/sysctl.d", "usr/lib/sysctl.d", "lib/sysctl.d")
SYSCTL_CONF = "etc/sysctl.conf"

_stop = False


def log(level: str, msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{ts} {level:<5} {msg}", flush=True)


def _norm(value: str) -> str:
    return " ".join(value.split())


def param_path(proc_sys: Path, param: str) -> Path:
    return proc_sys.joinpath(*param.split("."))


def read_runtime(params: list[str], proc_sys: Path) -> tuple[dict[str, Optional[str]], list[str]]:
    """감시 파라미터의 현재 값. 파라미터가 없으면 None(모듈 미적재 등), 읽기 권한이 없으면 보고에서 빼고 오류로 남긴다."""
    values: dict[str, Optional[str]] = {}
    errors: list[str] = []
    for p in params:
        try:
            values[p] = _norm(param_path(proc_sys, p).read_text(errors="replace"))
        except FileNotFoundError:
            values[p] = None
        except PermissionError:
            errors.append(f"{p}: 읽기 권한 없음")
        except OSError as exc:
            errors.append(f"{p}: {exc.strerror or exc}")
    return values, errors


def _parse_sysctl_file(path: Path) -> list[tuple[str, str, int]]:
    out: list[tuple[str, str, int]] = []
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return out
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("-"):
            line = line[1:].strip()  # '-key = v' : 적용 실패를 무시하라는 표시 — 값은 같다
        if "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip().replace("/", ".")
        if key:
            out.append((key, _norm(val), lineno))
    return out


def _host_path(f: Path, host_root: Path) -> Path:
    """호스트의 절대 경로 심볼릭 링크(예: 99-sysctl.conf → /etc/sysctl.conf)는 컨테이너 안에서 이미지의
    파일을 가리키므로, 호스트 마운트 위치 기준으로 다시 잇는다. 상대 링크는 마운트 안에서 그대로 풀린다."""
    try:
        if f.is_symlink():
            target = os.readlink(f)
            if target.startswith("/"):
                return host_root / target.lstrip("/")
    except OSError:
        pass
    return f


def sysctl_files(host_root: Path) -> list[Path]:
    """적용 순서대로 정렬된 설정 파일 목록(마지막이 가장 우선)."""
    by_name: dict[str, Path] = {}
    for d in SYSCTL_D_DIRS:
        base = host_root / d
        try:
            entries = sorted(base.glob("*.conf"))
        except OSError:
            continue
        for f in entries:
            by_name.setdefault(f.name, _host_path(f, host_root))
    files = [by_name[name] for name in sorted(by_name)]
    conf = host_root / SYSCTL_CONF
    if conf.is_file():
        files.append(conf)
    return files


def read_persistent(params: list[str], host_root: Path) -> dict[str, dict[str, str]]:
    """감시 파라미터의 영구 설정 값과 그 값을 정한 파일:줄. 어느 파일에도 없으면 결과에 없다."""
    wanted = set(params)
    result: dict[str, dict[str, str]] = {}
    for f in sysctl_files(host_root):
        shown = "/" + str(f.relative_to(host_root)) if f.is_relative_to(host_root) else str(f)
        for key, val, lineno in _parse_sysctl_file(f):
            if any(ch in key for ch in "*?["):
                targets = [p for p in wanted if fnmatch.fnmatchcase(p, key)]
            else:
                targets = [key] if key in wanted else []
            for t in targets:
                result[t] = {"value": val, "source": f"{shown}:{lineno}"}
    return result


def _ssl_context(verify: bool, ca_file: Optional[str]) -> ssl.SSLContext:
    if not verify:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return ssl.create_default_context(cafile=ca_file or None)


def post_report(url: str, token: str, payload: dict[str, Any], ctx: ssl.SSLContext, timeout: float = 15.0) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}",
                 "User-Agent": f"pep-node-param-agent/{AGENT_VERSION}"},
    )
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:  # noqa: S310 — 운영자가 지정한 PEP 주소
        return json.loads(resp.read().decode("utf-8") or "{}")


def _on_signal(signum, _frame) -> None:  # noqa: ANN001
    global _stop
    _stop = True
    log("INFO", f"신호 {signum} 수신 — 종료합니다")


def _sleep(seconds: float) -> None:
    end = time.monotonic() + seconds
    while not _stop and time.monotonic() < end:
        time.sleep(min(1.0, end - time.monotonic()))


def run(once: bool = False) -> int:
    api = os.environ.get("PEP_API_URL", "").rstrip("/")
    token = os.environ.get("NODE_PARAM_INGEST_TOKEN", "").strip()
    cluster = os.environ.get("PEP_CLUSTER", "").strip()
    node = os.environ.get("NODE_NAME", "").strip() or socket.gethostname()
    host_ip = os.environ.get("HOST_IP", "").strip()
    host_root = Path(os.environ.get("HOST_ROOT", "/host"))
    proc_sys = Path(os.environ.get("PROC_SYS", "/proc/sys"))
    verify = os.environ.get("PEP_TLS_VERIFY", "true").strip().lower() not in ("0", "false", "no", "off")
    ctx = _ssl_context(verify, os.environ.get("PEP_CA_FILE"))

    missing = [n for n, v in (("PEP_API_URL", api), ("NODE_PARAM_INGEST_TOKEN", token), ("PEP_CLUSTER", cluster)) if not v]
    if missing:
        log("ERROR", f"필수 환경 변수가 없습니다: {', '.join(missing)} — Secret 을 확인하세요")
        return 2

    url = f"{api}/node-params/agent/report"
    log("INFO", f"시작 v{AGENT_VERSION} node={node} host_ip={host_ip or '-'} cluster={cluster} → {url} (TLS 검증 {'켬' if verify else '끔'})")
    params: list[str] = []
    interval = 60
    failures = 0
    while not _stop:
        runtime, errors = read_runtime(params, proc_sys)
        persistent = read_persistent(params, host_root) if params else {}
        payload = {
            "cluster": cluster, "node": node, "host_ip": host_ip, "agent_version": AGENT_VERSION,
            "collected_at": datetime.now(timezone.utc).isoformat(),
            "runtime": runtime, "persistent": persistent, "errors": errors,
        }
        first_list = False
        try:
            resp = post_report(url, token, payload, ctx)
            failures = 0
            new_params = [str(p) for p in (resp.get("params") or [])]
            first_list = not params and bool(new_params)
            if set(new_params) != set(params):
                log("INFO", f"감시 목록 갱신 {len(params)} → {len(new_params)}개")
            params = new_params
            interval = int(resp.get("interval_sec") or interval)
            log("INFO", (
                f"보고 완료 파라미터 {len(runtime)}개 · 영구 설정 {len(persistent)}개 · 변경 {resp.get('changes', 0)}건 · "
                f"기준 위반 {resp.get('violations', 0)} · 영구 설정 불일치 {resp.get('mismatches', 0)} · "
                f"알람 열림 {resp.get('alerts_opened', 0)}/닫힘 {resp.get('alerts_resolved', 0)} · 다음 {interval}초 뒤"
            ))
            for e in errors:
                log("WARN", f"읽기 오류 {e}")
        except urllib.error.HTTPError as exc:
            failures += 1
            detail = ""
            try:
                detail = exc.read().decode("utf-8", errors="replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            hint = {401: "토큰 불일치", 503: "PEP 에 NODE_PARAM_INGEST_TOKEN 미설정", 404: "클러스터를 찾지 못함(PEP_CLUSTER 확인)"}.get(exc.code, "")
            log("ERROR", f"보고 실패 HTTP {exc.code} {hint} {detail}".strip())
        except Exception as exc:  # noqa: BLE001 — 네트워크·TLS 등 어떤 오류도 루프를 멈추지 않는다
            failures += 1
            log("ERROR", f"보고 실패 {type(exc).__name__}: {exc}")
        if first_list:
            continue  # 목록을 막 받았으면 바로 실제 값을 보고한다(--once 도 실제 값까지 보내고 끝낸다)
        if once:
            return 0 if failures == 0 else 1
        wait = interval if failures == 0 else min(interval, 10 * (2 ** min(failures - 1, 4)))
        _sleep(wait + random.uniform(0, min(10.0, interval * 0.1)))
    return 0


def dry_run(params: list[str]) -> int:
    host_root = Path(os.environ.get("HOST_ROOT", "/host"))
    proc_sys = Path(os.environ.get("PROC_SYS", "/proc/sys"))
    runtime, errors = read_runtime(params, proc_sys)
    persistent = read_persistent(params, host_root)
    print(json.dumps({"runtime": runtime, "persistent": persistent, "errors": errors,
                      "files": [str(f) for f in sysctl_files(host_root)]}, ensure_ascii=False, indent=2))
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.node_param_agent", description="PEP 노드 OS 파라미터 에이전트")
    ap.add_argument("--once", action="store_true", help="한 번만 보고하고 종료")
    ap.add_argument("--dry-run", action="store_true", help="보내지 않고 읽은 값만 출력")
    ap.add_argument("--param", action="append", default=[], help="--dry-run 에서 읽을 파라미터(여러 번)")
    args = ap.parse_args(argv)
    if args.dry_run:
        return dry_run(args.param)
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    return run(once=args.once)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
