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
    try:
        relay_cmd = _kubectl_base(kubeconfig_path) + [
            "-n", namespace, "get", "svc", "hubble-relay",
            "-o", "name",
        ]
        relay_proc = subprocess.run(relay_cmd, capture_output=True, text=True, timeout=10)
        hubble_installed = relay_proc.returncode == 0 and bool((relay_proc.stdout or "").strip())
    except Exception:
        pass

    return {
        "cilium_installed": cilium_installed,
        "hubble_relay_installed": hubble_installed,
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


def bpf_inspect(
    kubeconfig_path: str,
    kind: str,
    *,
    pod_name: Optional[str] = None,
    namespace: str = "kube-system",
    endpoint_id: Optional[str] = None,
) -> dict:
    """단발성 BPF map 조회. JSON 출력 시도 후 실패하면 raw 그대로 반환."""
    # pod 자동 선택
    target_pod = pod_name
    if not target_pod:
        agents, err = list_agents(kubeconfig_path, namespace=namespace)
        if err:
            return {"raw": "", "parsed": None, "is_json": False, "error": err, "pod_name": "", "executed": None}
        ready = next((a for a in agents if a.ready), None)
        if not ready:
            return {"raw": "", "parsed": None, "is_json": False,
                    "error": "Ready 상태인 cilium agent pod 가 없습니다.",
                    "pod_name": "", "executed": None}
        target_pod = ready.pod_name

    if kind == "policy":
        if not endpoint_id:
            return {"raw": "", "parsed": None, "is_json": False,
                    "error": "policy 조회는 endpoint_id 가 필수입니다.",
                    "pod_name": target_pod, "executed": None}
        sub = ["bpf", "policy", "get", str(endpoint_id)]
    else:
        sub = _BPF_COMMANDS.get(kind)
        if not sub:
            return {"raw": "", "parsed": None, "is_json": False,
                    "error": f"지원하지 않는 BPF kind: {kind}",
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
                "raw": proc.stdout,
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


def exec_cilium_command(
    kubeconfig_path: str,
    *,
    pod_name: Optional[str] = None,
    namespace: str = "kube-system",
    command_args: str = "",
    timeout: int = 30,
) -> dict:
    """선택 pod 에서 임의 ``cilium-dbg <args>`` 실행(ad-hoc).

    shell=False + ``cilium-dbg`` 고정 prefix → 임의 바이너리 실행 불가(주입 방지). JSON 파싱 없이 raw 반환.
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
        return {"raw": "", "error": "cilium-dbg 뒤에 실행할 하위 명령이 필요합니다 (예: ipam status).",
                "exit_code": None, "executed": None, "pod_name": pod_name or "", "duration_ms": 0}

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
