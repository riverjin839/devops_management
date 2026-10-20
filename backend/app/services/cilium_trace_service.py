"""Cilium BPF / Monitor / Hubble trace service.

세 가지 진입점을 제공:

1. **BPF map 스냅샷** — `cilium-dbg bpf <kind> list -o json` 결과를 파싱.
2. **`cilium-dbg monitor` 스트리밍** — 특정 cilium agent pod 에 `kubectl exec`
   해서 실시간 trace 이벤트를 줄 단위로 yield. SSE 핸들러가 이를
   `text/event-stream` 으로 흘려보낸다.
3. **`hubble observe --follow` 스트리밍** — kubectl port-forward 로 hubble
   relay 에 붙어 flow 를 줄 단위로 yield.

모든 스트림은 generator. 클라이언트 disconnect 시 caller 에서 GeneratorExit
를 받아 자식 process group 을 SIGTERM 으로 정리.
"""
from __future__ import annotations

import json
import os
import shlex
import signal
import socket
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Iterator, Optional


# ── 공통 ──────────────────────────────────────────────────────────────────────

def _kubectl_base(kubeconfig_path: str) -> list[str]:
    return ["kubectl", "--kubeconfig", kubeconfig_path]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_port_ready(host: str, port: int, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def _kill_process_group(proc: Optional[subprocess.Popen]) -> None:
    if not proc or proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=2)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


# ── Status & agent discovery ─────────────────────────────────────────────────

@dataclass
class _AgentInfo:
    pod_name: str
    namespace: str
    node_name: Optional[str] = None
    node_ip: Optional[str] = None
    ready: bool = False


def list_agents(kubeconfig_path: str, namespace: str = "kube-system") -> tuple[list[_AgentInfo], Optional[str]]:
    """k8s -l k8s-app=cilium pods 조회."""
    cmd = _kubectl_base(kubeconfig_path) + [
        "-n", namespace, "get", "pods",
        "-l", "k8s-app=cilium",
        "-o", "json",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except FileNotFoundError as e:
        return [], f"kubectl 바이너리가 없습니다: {e}"
    except subprocess.TimeoutExpired:
        return [], "kubectl 호출 타임아웃"

    if proc.returncode != 0:
        return [], (proc.stderr or "kubectl 실패").strip()[:400]

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return [], "kubectl 응답 JSON 파싱 실패"

    agents: list[_AgentInfo] = []
    for item in data.get("items", []):
        meta = item.get("metadata", {})
        spec = item.get("spec", {})
        status = item.get("status", {})
        ready = False
        for c in status.get("conditions", []):
            if c.get("type") == "Ready" and c.get("status") == "True":
                ready = True
                break
        agents.append(_AgentInfo(
            pod_name=meta.get("name", ""),
            namespace=meta.get("namespace", namespace),
            node_name=spec.get("nodeName"),
            node_ip=status.get("hostIP"),
            ready=ready,
        ))
    agents.sort(key=lambda a: (a.node_name or "", a.pod_name))
    return agents, None


def detect_status(kubeconfig_path: str, namespace: str = "kube-system") -> dict:
    """cilium / hubble-relay 설치 여부와 버전 정보."""
    agents, err = list_agents(kubeconfig_path, namespace=namespace)
    if err and not agents:
        return {
            "cilium_installed": False,
            "hubble_relay_installed": False,
            "agent_count": 0,
            "cilium_version": None,
            "namespace": namespace,
            "error": err,
        }

    cilium_installed = len(agents) > 0
    cilium_version: Optional[str] = None
    if cilium_installed:
        try:
            ready_agent = next((a for a in agents if a.ready), agents[0])
            ver_cmd = _kubectl_base(kubeconfig_path) + [
                "-n", namespace, "exec", ready_agent.pod_name, "--",
                "cilium-dbg", "version",
            ]
            ver_proc = subprocess.run(ver_cmd, capture_output=True, text=True, timeout=15)
            if ver_proc.returncode == 0 and ver_proc.stdout:
                # "Client: 1.14.5\nDaemon: 1.14.5\n" → 첫 번째 버전
                for line in ver_proc.stdout.splitlines():
                    if "Daemon:" in line or "Client:" in line:
                        cilium_version = line.split(":", 1)[1].strip().split()[0]
                        break
        except Exception:
            pass

    hubble_installed = False
    # 확인 자체가 실패하면(RBAC 거부·타임아웃 등) "미설치"가 아니라 사유를 돌려준다 — 화면이 설치 안내와 구분한다.
    hubble_error: Optional[str] = None
    try:
        relay_cmd = _kubectl_base(kubeconfig_path) + [
            "-n", namespace, "get", "svc", "hubble-relay",
            "-o", "name",
        ]
        relay_proc = subprocess.run(relay_cmd, capture_output=True, text=True, timeout=10)
        hubble_installed = relay_proc.returncode == 0 and bool((relay_proc.stdout or "").strip())
        if relay_proc.returncode != 0:
            stderr = (relay_proc.stderr or "").strip()
            if "NotFound" not in stderr and "not found" not in stderr.lower():
                hubble_error = stderr[:300] or f"kubectl 종료 코드 {relay_proc.returncode}"
    except Exception as exc:  # noqa: BLE001 — fail-safe
        hubble_error = f"hubble-relay 확인 실패: {type(exc).__name__}"

    return {
        "cilium_installed": cilium_installed,
        "hubble_relay_installed": hubble_installed,
        "hubble_relay_error": hubble_error,
        "agent_count": len(agents),
        "cilium_version": cilium_version,
        "namespace": namespace,
        "error": None,
    }


# ── BPF map inspector ───────────────────────────────────────────────────────

# kind → cilium-dbg bpf 서브커맨드 매핑.
_BPF_COMMANDS: dict[str, list[str]] = {
    "endpoint": ["bpf", "endpoint", "list"],
    "lb":       ["bpf", "lb", "list"],
    "nat":      ["bpf", "nat", "list"],
    "ct":       ["bpf", "ct", "list", "global"],
    "tunnel":   ["bpf", "tunnel", "list"],
    "fs":       ["bpf", "fs", "show"],
    "metrics":  ["bpf", "metrics", "list"],
    "ipcache":  ["bpf", "ipcache", "list"],
    "node":     ["bpf", "node", "list"],
}


def _bpf_target(
    kubeconfig_path: str,
    kind: str,
    *,
    pod_name: Optional[str],
    namespace: str,
    endpoint_id: Optional[str],
) -> tuple[str, list[str], Optional[str]]:
    """BPF 조회 대상 pod 과 cilium-dbg 서브커맨드. 반환: (pod, sub, 오류). 오류가 있으면 앞 둘은 비어 있다."""
    target_pod = pod_name
    if not target_pod:
        agents, err = list_agents(kubeconfig_path, namespace=namespace)
        if err:
            return "", [], err
        ready = next((a for a in agents if a.ready), None)
        if not ready:
            return "", [], "Ready 상태인 cilium agent pod 가 없습니다."
        target_pod = ready.pod_name
    if kind == "policy":
        if not endpoint_id:
            return target_pod, [], "policy 조회는 endpoint_id 가 필수입니다."
        return target_pod, ["bpf", "policy", "get", str(endpoint_id)], None
    sub = _BPF_COMMANDS.get(kind)
    if not sub:
        return target_pod, [], f"지원하지 않는 BPF kind: {kind}"
    return target_pod, sub, None


def bpf_inspect(
    kubeconfig_path: str,
    kind: str,
    *,
    pod_name: Optional[str] = None,
    namespace: str = "kube-system",
    endpoint_id: Optional[str] = None,
) -> dict:
    """단발성 BPF map 조회. JSON 출력 시도 후 실패하면 raw 그대로 반환.

    JSON 으로 파싱되면 원본(raw)은 응답에 싣지 않는다(`raw_omitted`) — conntrack·NAT 처럼 수십만 항목인 맵은
    원본 문자열과 파싱본을 함께 응답하면 워커 메모리·응답 크기가 두 배가 된다. 원본이 필요하면
    `bpf_raw_stream` 다운로드로 받는다(메모리에 올리지 않고 흘려보냄).
    """
    target_pod, sub, terr = _bpf_target(kubeconfig_path, kind, pod_name=pod_name,
                                        namespace=namespace, endpoint_id=endpoint_id)
    if terr:
        return {"raw": "", "parsed": None, "is_json": False, "error": terr,
                "pod_name": target_pod, "executed": None}

    # JSON 출력 시도
    cmd_json = _kubectl_base(kubeconfig_path) + [
        "-n", namespace, "exec", target_pod, "--",
        "cilium-dbg", *sub, "-o", "json",
    ]
    proc = _run(cmd_json, timeout=20)
    if proc and proc.returncode == 0 and proc.stdout.strip().startswith(("[", "{")):
        try:
            parsed = json.loads(proc.stdout)
            return {
                "raw": "",
                "raw_omitted": True,
                "raw_size": len(proc.stdout),
                "parsed": parsed,
                "is_json": True,
                "error": None,
                "pod_name": target_pod,
                "executed": " ".join(shlex.quote(a) for a in cmd_json),
            }
        except json.JSONDecodeError:
            pass

    # JSON 실패 시 plain text 모드 (-o 미지정)
    cmd_text = _kubectl_base(kubeconfig_path) + [
        "-n", namespace, "exec", target_pod, "--",
        "cilium-dbg", *sub,
    ]
    proc_text = _run(cmd_text, timeout=20)
    if not proc_text:
        return {"raw": "", "parsed": None, "is_json": False,
                "error": "kubectl exec 실행 실패", "pod_name": target_pod, "executed": None}
    if proc_text.returncode != 0:
        err = (proc_text.stderr or "cilium-dbg 실패").strip()[:400]
        return {"raw": proc_text.stdout or "", "parsed": None, "is_json": False,
                "error": err, "pod_name": target_pod,
                "executed": " ".join(shlex.quote(a) for a in cmd_text)}
    return {
        "raw": proc_text.stdout or "",
        "parsed": None,
        "is_json": False,
        "error": None,
        "pod_name": target_pod,
        "executed": " ".join(shlex.quote(a) for a in cmd_text),
    }


def bpf_raw_stream(
    kubeconfig_path: str,
    kind: str,
    *,
    as_json: bool,
    pod_name: Optional[str] = None,
    namespace: str = "kube-system",
    endpoint_id: Optional[str] = None,
    timeout: int = 120,
) -> tuple[str, Optional[str], Optional[Iterator[bytes]], Optional[str]]:
    """BPF 맵 원본을 **흘려보내는** 다운로드용 스트림. 반환: (pod, 실행 명령, 바이트 생성기, 오류).

    출력을 메모리에 모으지 않고 64KB 씩 그대로 내보낸다 — 수십만 항목 conntrack 도 워커 메모리는 고정.
    시간 초과(timeout 초)면 프로세스를 죽여 스트림을 끝낸다. 명령이 실패해 출력이 없으면 stderr 를 내보낸다.
    """
    target_pod, sub, terr = _bpf_target(kubeconfig_path, kind, pod_name=pod_name,
                                        namespace=namespace, endpoint_id=endpoint_id)
    if terr:
        return target_pod, None, None, terr
    cmd = _kubectl_base(kubeconfig_path) + [
        "-n", namespace, "exec", target_pod, "--", "cilium-dbg", *sub,
    ] + (["-o", "json"] if as_json else [])
    executed = " ".join(shlex.quote(a) for a in cmd)

    def _gen() -> Iterator[bytes]:
        err_file = tempfile.TemporaryFile()
        proc: Optional[subprocess.Popen] = None
        timer: Optional[threading.Timer] = None
        sent = 0
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err_file, preexec_fn=os.setsid)
            timer = threading.Timer(timeout, _kill_process_group, [proc])
            timer.daemon = True
            timer.start()
            assert proc.stdout is not None
            while True:
                chunk = proc.stdout.read(64 * 1024)
                if not chunk:
                    break
                sent += len(chunk)
                yield chunk
            proc.wait(timeout=5)
            if sent == 0 and proc.returncode:
                err_file.seek(0)
                yield (b"[cilium-dbg failed] " + err_file.read(4000))
        except FileNotFoundError as e:
            yield f"[kubectl 바이너리가 없습니다] {e}".encode()
        finally:
            if timer is not None:
                timer.cancel()
            _kill_process_group(proc)
            err_file.close()

    return target_pod, executed, _gen(), None


def bpf_ct_head(
    kubeconfig_path: str,
    max_lines: int,
    *,
    pod_name: Optional[str] = None,
    namespace: str = "kube-system",
    timeout: int = 20,
) -> tuple[list[str], Optional[str]]:
    """`cilium-dbg bpf ct list global` 텍스트 출력의 **앞 max_lines 줄만** 읽고 프로세스를 끊는다.

    서비스 토폴로지의 conntrack 폴백은 앞쪽 수천 항목만 쓰는데, 예전엔 테이블 전체를 JSON 으로 받아
    파싱했다(수십만 항목이면 수백 MB). 반환: (줄 목록, 오류)."""
    target_pod, sub, terr = _bpf_target(kubeconfig_path, "ct", pod_name=pod_name,
                                        namespace=namespace, endpoint_id=None)
    if terr:
        return [], terr
    cmd = _kubectl_base(kubeconfig_path) + ["-n", namespace, "exec", target_pod, "--", "cilium-dbg", *sub]
    lines: list[str] = []
    proc: Optional[subprocess.Popen] = None
    timer: Optional[threading.Timer] = None
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True, errors="replace", preexec_fn=os.setsid)
        timer = threading.Timer(timeout, _kill_process_group, [proc])
        timer.daemon = True
        timer.start()
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if line:
                lines.append(line)
                if len(lines) >= max_lines:
                    break
    except FileNotFoundError as e:
        return [], f"kubectl 바이너리가 없습니다: {e}"
    except Exception as e:  # noqa: BLE001
        return lines, f"conntrack 조회 실패: {str(e)[:200]}"
    finally:
        if timer is not None:
            timer.cancel()
        _kill_process_group(proc)
    if not lines and proc is not None and proc.returncode not in (0, None, -15):
        return [], f"cilium-dbg bpf ct list 실패 (exit {proc.returncode})"
    return lines, None


# ── cilium-dbg 읽기 전용 allowlist (정책 2) ─────────────────────────────────
# 직접 명령(ad-hoc)은 이 목록에 맞는 **조회** 하위 명령만 operator 에게 허용하고, 목록 밖(변경·삭제·
# flush·config 쓰기·shell 등)은 admin 만 실행한다. ``*`` 는 아무 토큰 하나(예: ``bpf <map> list``).
#
# 판정 규칙(프론트 ``frontend/src/lib/ciliumCommand.ts`` 와 동일 — 한쪽만 고치지 않는다):
#  1. 앞의 ``cilium-dbg``/``cilium`` 접두는 뗀다. 파싱 불가·빈 명령은 목록 밖.
#  2. 다른 agent 로 붙거나 설정 파일을 바꾸는 ``--config``·``-H``·``--host``(``=값``·붙여 쓴 꼴 포함)는
#     어디에 있든 목록 밖.
#  3. 명령은 하위 명령 단어로 **시작**해야 한다 — 인자 앞부분 ``parts[:len(rule)]`` 가 규칙과 정확히
#     같아야 하고(앞쪽 플래그 불가: cobra 는 플래그를 건너뛰고 하위 명령을 찾으므로 ``--x status
#     endpoint delete`` 꼴 우회를 막는다), ``*`` 자리도 ``-`` 로 시작하면 안 된다.
#  4. 규칙 뒤에는 위치 인자(``-`` 로 시작하지 않는 토큰)와 아래 읽기 전용 플래그만 허용한다.
#     ``-h``/``--help`` 는 이미 허용된 명령 뒤에서만 허용(목록 밖 명령 + ``-h`` 는 목록 밖).
#  5. ``config`` 는 위치 인자 없이 조회만 — ``config Key=Value`` 는 설정 변경.
#  6. ``debuginfo`` 의 ``-f``/``--file``/``--file-per-command`` 는 agent 에 파일을 쓰므로 목록 밖.
CILIUM_READONLY_COMMANDS: tuple[tuple[str, ...], ...] = (
    ("status",),
    ("version",),
    ("debuginfo",),
    ("config",),  # 인자 없이 조회만 — ``config Key=Value`` 쓰기는 아래에서 따로 막는다
    ("endpoint", "list"), ("endpoint", "get"), ("endpoint", "log"), ("endpoint", "health"),
    ("identity", "list"), ("identity", "get"),
    ("service", "list"), ("service", "get"),
    ("policy", "get"), ("policy", "selectors"),
    ("ip", "list"), ("ip", "get"),
    ("node", "list"), ("nodeid", "list"),
    ("map", "list"), ("map", "get"),
    ("metrics", "list"),
    ("fqdn", "cache", "list"),
    ("lrp", "list"),
    ("encrypt", "status"),
    ("kvstore", "get"),
    ("bgp", "peers"), ("bgp", "routes"), ("bgp", "route-policies"),
    ("prefilter", "list"),
    ("recorder", "list"),
    ("cgroups", "list"),
    ("bpf", "*", "list"), ("bpf", "*", "get"), ("bpf", "fs", "show"),
    ("help",),
)

# 규칙 뒤에 올 수 있는 값 받는 플래그 — 다음 토큰을 값으로 소비한다(``--output=json`` 꼴도 허용).
_CILIUM_VALUE_FLAGS = frozenset({"-o", "--output", "-n"})
# 규칙 뒤에 올 수 있는 값 없는 읽기 전용 플래그(``status`` 의 ``--all-*`` 조회 플래그 포함).
_CILIUM_BOOL_FLAGS = frozenset({
    "-v", "--verbose", "-h", "--help",
    "--all-addresses", "--all-clusters", "--all-controllers", "--all-health",
    "--all-nodes", "--all-redirects",
})
# 어디에 있든 목록 밖 — agent 접속 대상(-H/--host)·설정 파일(--config) 전환.
_CILIUM_DENY_LONG = ("--config", "--host")
# debuginfo 의 파일 쓰기 플래그.
_CILIUM_DEBUGINFO_FILE_LONG = ("--file", "--file-per-command")


def cilium_readonly_command_labels() -> list[str]:
    """화면 안내용 — ``bpf <맵> list`` 같은 사람이 읽는 형태."""
    return [" ".join("<맵>" if t == "*" else t for t in rule) for rule in CILIUM_READONLY_COMMANDS]


def _long_flag_is(tok: str, names: tuple[str, ...]) -> bool:
    return any(tok == n or tok.startswith(n + "=") for n in names)


def _cilium_denied_token(tok: str) -> bool:
    """``--config``·``--host``(=값)·``-H``(붙여 쓴 값 포함)."""
    return _long_flag_is(tok, _CILIUM_DENY_LONG) or (tok.startswith("-H") and not tok.startswith("--"))


def _cilium_debuginfo_writes_file(tok: str) -> bool:
    return _long_flag_is(tok, _CILIUM_DEBUGINFO_FILE_LONG) or (tok.startswith("-f") and not tok.startswith("--"))


def _cilium_rule_matches(rule: tuple[str, ...], parts: list[str]) -> bool:
    if len(parts) < len(rule):
        return False
    for r, p in zip(rule, parts):
        if p.startswith("-"):
            return False
        if r != "*" and r != p:
            return False
    return True


def _cilium_tail_is_readonly(rule: tuple[str, ...], tail: list[str]) -> bool:
    """규칙 뒤 토큰: 위치 인자 + 읽기 전용 플래그만."""
    i = 0
    while i < len(tail):
        tok = tail[i]
        if not tok.startswith("-"):
            if rule == ("config",):
                return False  # ``config Key=Value`` = 설정 변경
            i += 1
            continue
        if rule == ("debuginfo",) and _cilium_debuginfo_writes_file(tok):
            return False
        if tok in _CILIUM_BOOL_FLAGS:
            i += 1
            continue
        if tok in _CILIUM_VALUE_FLAGS:
            if i + 1 >= len(tail) or tail[i + 1].startswith("-"):
                return False  # 값 누락 — 다음 플래그를 값으로 삼켜 판정을 흐리지 않는다
            i += 2
            continue
        if tok.startswith("--output="):
            i += 1
            continue
        return False
    return True


def _split_cilium_args(command_args: str) -> list[str]:
    parts = shlex.split((command_args or "").strip())
    if parts and parts[0] in ("cilium-dbg", "cilium"):
        parts = parts[1:]
    return parts


def is_cilium_readonly_command(command_args: str) -> bool:
    """``cilium-dbg`` 뒤 인자가 읽기 전용 allowlist 에 드는지. 파싱 불가·빈 명령은 False."""
    try:
        parts = _split_cilium_args(command_args)
    except ValueError:
        return False
    if not parts:
        return False
    if any(_cilium_denied_token(t) for t in parts):
        return False
    for rule in CILIUM_READONLY_COMMANDS:
        if _cilium_rule_matches(rule, parts):
            return _cilium_tail_is_readonly(rule, parts[len(rule):])
    return False


def exec_cilium_command(
    kubeconfig_path: str,
    *,
    pod_name: Optional[str] = None,
    namespace: str = "kube-system",
    command_args: str = "",
    timeout: int = 30,
    allow_any: bool = False,
) -> dict:
    """선택 pod 에서 ``cilium-dbg <args>`` 실행(ad-hoc).

    shell=False + ``cilium-dbg`` 고정 prefix → 임의 바이너리 실행 불가(주입 방지). JSON 파싱 없이 raw 반환.
    ``allow_any=False``(기본)면 읽기 전용 allowlist 밖 명령을 실행하지 않는다 — 라우터가 admin 일 때만 True.
    """
    raw_args = (command_args or "").strip()
    if not raw_args:
        return {"raw": "", "error": "명령이 비어 있습니다.", "exit_code": None,
                "executed": None, "pod_name": pod_name or "", "duration_ms": 0}
    try:
        parts = shlex.split(raw_args)
    except ValueError as e:
        return {"raw": "", "error": f"명령 파싱 오류: {e}", "exit_code": None,
                "executed": None, "pod_name": pod_name or "", "duration_ms": 0}
    if parts and parts[0] in ("cilium-dbg", "cilium"):
        parts = parts[1:]  # 사용자가 prefix 를 붙였으면 제거(우리가 고정 추가)
    if not parts:
        return {"raw": "", "error": "cilium-dbg 뒤에 실행할 하위 명령이 필요합니다 (예: status).",
                "exit_code": None, "executed": None, "pod_name": pod_name or "", "duration_ms": 0}
    if not allow_any and not is_cilium_readonly_command(raw_args):
        return {"raw": "", "error": "읽기 전용 허용 목록 밖의 cilium-dbg 명령입니다 (admin 만 실행 가능).",
                "exit_code": None, "executed": None, "pod_name": pod_name or "", "duration_ms": 0,
                "forbidden": True}

    target_pod = pod_name
    if not target_pod:
        agents, err = list_agents(kubeconfig_path, namespace=namespace)
        if err:
            return {"raw": "", "error": err, "exit_code": None, "executed": None, "pod_name": "", "duration_ms": 0}
        ready = next((a for a in agents if a.ready), None)
        if not ready:
            return {"raw": "", "error": "Ready 상태인 cilium agent pod 가 없습니다.",
                    "exit_code": None, "executed": None, "pod_name": "", "duration_ms": 0}
        target_pod = ready.pod_name

    cmd = _kubectl_base(kubeconfig_path) + [
        "-n", namespace, "exec", target_pod, "--", "cilium-dbg", *parts,
    ]
    t0 = time.time()
    proc = _run(cmd, timeout=timeout)
    dur = int((time.time() - t0) * 1000)
    executed = " ".join(shlex.quote(a) for a in cmd)
    if not proc:
        return {"raw": "", "error": "kubectl exec 실행 실패", "exit_code": None,
                "executed": executed, "pod_name": target_pod, "duration_ms": dur}
    out = proc.stdout or ""
    if proc.returncode != 0 and proc.stderr:
        out = (out + ("\n" if out else "") + "[stderr] " + proc.stderr).strip()
    return {
        "raw": out,
        "exit_code": proc.returncode,
        "error": (proc.stderr or "").strip()[:400] if proc.returncode != 0 else None,
        "executed": executed,
        "pod_name": target_pod,
        "duration_ms": dur,
    }


def _run(cmd: list[str], timeout: int) -> Optional[subprocess.CompletedProcess]:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None


# ── cilium monitor stream ───────────────────────────────────────────────────

@dataclass
class MonitorOptions:
    pod_name: str
    namespace: str = "kube-system"
    types: list[str] = field(default_factory=list)   # drop, trace, ...
    related_to: Optional[str] = None
    hex: bool = False


def monitor_stream(kubeconfig_path: str, opts: MonitorOptions) -> Iterator[str]:
    """`kubectl exec ... -- cilium-dbg monitor --json` 결과를 한 줄씩 yield.

    호출자가 disconnect 시 generator close 가 호출되며 자식 process 가 정리됨.
    """
    extra: list[str] = []
    for t in opts.types:
        t = t.strip()
        if t:
            extra += ["--type", t]
    if opts.related_to:
        extra += ["--related-to", str(opts.related_to)]
    if opts.hex:
        extra.append("--hex")

    cmd = _kubectl_base(kubeconfig_path) + [
        "-n", opts.namespace, "exec", opts.pod_name, "--",
        "cilium-dbg", "monitor", "--json", *extra,
    ]

    proc: Optional[subprocess.Popen] = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            preexec_fn=os.setsid,
        )
        yield json.dumps({
            "kind": "meta",
            "executed": " ".join(shlex.quote(a) for a in cmd),
        })
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.rstrip("\n")
            if not line:
                continue
            yield line
        # 정상 종료 시 stderr 도 흘려준다
        if proc.stderr is not None:
            err = proc.stderr.read()
            if err:
                yield json.dumps({"kind": "stderr", "data": err[:400]})
    except FileNotFoundError as e:
        yield json.dumps({"kind": "error", "data": f"kubectl 바이너리가 없습니다: {e}"})
    except Exception as e:
        yield json.dumps({"kind": "error", "data": f"monitor 실패: {str(e)[:200]}"})
    finally:
        _kill_process_group(proc)


# ── hubble flow stream ──────────────────────────────────────────────────────

@dataclass
class HubbleStreamOptions:
    namespace: str = "kube-system"
    relay_service: str = "hubble-relay"
    relay_port: int = 80
    from_pod: Optional[str] = None
    to_pod: Optional[str] = None
    from_namespace: Optional[str] = None
    to_namespace: Optional[str] = None
    protocol: Optional[str] = None
    verdict: Optional[str] = None


def hubble_stream(kubeconfig_path: str, opts: HubbleStreamOptions) -> Iterator[str]:
    """port-forward 후 `hubble observe --follow` 한 줄씩 yield."""
    if not kubeconfig_path or not os.path.exists(kubeconfig_path):
        yield json.dumps({"kind": "error", "data": "kubeconfig 파일이 없습니다."})
        return

    local_port = _free_port()
    pf_cmd = _kubectl_base(kubeconfig_path) + [
        "port-forward", "-n", opts.namespace,
        f"svc/{opts.relay_service}", f"{local_port}:{opts.relay_port}",
    ]

    pf: Optional[subprocess.Popen] = None
    obs: Optional[subprocess.Popen] = None
    try:
        pf = subprocess.Popen(
            pf_cmd,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            preexec_fn=os.setsid,
        )
        if not _wait_port_ready("127.0.0.1", local_port, timeout=6.0):
            stderr_b = pf.stderr.read() if pf.stderr else b""
            stderr = stderr_b.decode("utf-8", "replace")[:400] if stderr_b else "port-forward timeout"
            yield json.dumps({"kind": "error", "data": f"Hubble Relay 접속 실패: {stderr}"})
            return

        obs_cmd = [
            "hubble", "observe",
            "--server", f"127.0.0.1:{local_port}",
            "--follow", "--output", "json",
        ]
        if opts.from_pod:        obs_cmd += ["--from-pod", opts.from_pod]
        if opts.to_pod:          obs_cmd += ["--to-pod", opts.to_pod]
        if opts.from_namespace:  obs_cmd += ["--from-namespace", opts.from_namespace]
        if opts.to_namespace:    obs_cmd += ["--to-namespace", opts.to_namespace]
        if opts.protocol:        obs_cmd += ["--protocol", opts.protocol.lower()]
        if opts.verdict:         obs_cmd += ["--verdict", opts.verdict.upper()]

        obs = subprocess.Popen(
            obs_cmd,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
            preexec_fn=os.setsid,
        )
        yield json.dumps({
            "kind": "meta",
            "executed": " ".join(shlex.quote(a) for a in obs_cmd),
        })
        assert obs.stdout is not None
        for line in obs.stdout:
            line = line.rstrip("\n")
            if line:
                yield line

    except FileNotFoundError as e:
        yield json.dumps({"kind": "error", "data": f"바이너리 없음: {e}"})
    except Exception as e:
        yield json.dumps({"kind": "error", "data": f"hubble stream 실패: {str(e)[:200]}"})
    finally:
        _kill_process_group(obs)
        _kill_process_group(pf)
