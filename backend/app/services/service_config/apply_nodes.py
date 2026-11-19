"""서비스 구성 — ETCD·CONTAINERD 적용. 잘못 바꾸면 쿼럼 상실·노드 NotReady 로 번지므로
**사전 점검 · 한 대씩 · 상태 확인 · 실패 시 자동 복원**을 기본으로 둔다.

- ETCD      : 배치 1대 고정. 시작 전 대상 전 멤버 health 확인(하나라도 비정상이면 시작 안 함) → 노드마다
              방식 판별(정적 파드 매니페스트 / systemd env 파일) → 백업 → **줄 단위 편집**(서식 보존) →
              정적 파드는 kubelet 이 재시작, systemd 는 ``systemctl restart`` → health·실행 중 프로세스 값 확인.
              실패하면(옵션, 기본 켬) 백업 복원 후 나머지 노드는 건너뛴다.
- CONTAINERD: 노드마다 설정 파일 읽기 → **줄 단위 TOML 편집** + 재해석 검증 → (옵션) cordon·drain → 백업·기록 →
              재시작 명령 → 서비스 활성 확인 → ``containerd config dump`` 로 값 확인 → 노드 Ready 대기 → uncordon.
              실패하면(옵션) 복원·재시작. 성공 노드는 ``containerd_config:{host}`` 스냅샷을 갱신한다.

편집 로직(``edit_etcd_manifest`` · ``edit_env_file`` · ``edit_containerd_toml``)은 순수 함수 — 단위 테스트 대상.
SSH 자격증명은 요청 안에서만 쓰고 저장하지 않는다(``apply.py`` 와 같음).
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import time
from datetime import datetime
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.service_config import ServiceConfigApplyRun
from app.services import ssh_runner
from app.services.service_config import apply as A
from app.services.service_config import current as C
from app.services.service_config import view as V
from app.services.ssh_runner import SSHTarget

_PLAIN_ITEM = re.compile(r"^[A-Za-z0-9_.:/,+=\-]+$")
_FLAG_LINE = re.compile(r"""^(?P<indent>\s*)-\s+(?P<q>["']?)--(?P<flag>[A-Za-z0-9-]+)(?:=(?P<val>.*?))?(?P=q)\s*$""")
_ETCD_CMD_LINE = re.compile(r"""^(?P<indent>\s*)-\s+["']?(?:\S*/)?etcd["']?\s*$""")
_HEADER = re.compile(r"^\s*\[(?!\[)\s*(?P<path>[^\[\]]+?)\s*\]\s*(#.*)?$")
_ANY_HEADER = re.compile(r"^\s*\[")


class EditError(ValueError):
    """편집 결과가 기대와 다르면 — 노드에 쓰지 않는다."""


# ── ETCD 순수 편집 ───────────────────────────────────────────────────────────

def _render_flag(flag: str, value: str) -> str:
    item = f"--{flag}={value}"
    return item if _PLAIN_ITEM.match(item) else json.dumps(item)


def manifest_flags(text: str) -> dict[str, str]:
    """정적 파드 매니페스트(YAML)의 etcd 컨테이너 command 에서 ``--flag=value`` 를 뽑는다."""
    import yaml

    doc = yaml.safe_load(text) or {}
    containers = ((doc.get("spec") or {}).get("containers") or []) if isinstance(doc, dict) else []
    for c in containers:
        cmd = list(c.get("command") or []) + list(c.get("args") or [])
        if c.get("name") == "etcd" or (cmd and str(cmd[0]).rsplit("/", 1)[-1] == "etcd"):
            out: dict[str, str] = {}
            for tok in cmd:
                tok = str(tok)
                if tok.startswith("--"):
                    k, _, v = tok[2:].partition("=")
                    out[k] = v if "=" in tok else "true"
            return out
    raise EditError("매니페스트에서 etcd 컨테이너를 찾지 못했습니다.")


def edit_etcd_manifest(text: str, flags: dict[str, str]) -> str:
    """``- --flag=value`` 줄만 바꾸거나(같은 들여쓰기) 마지막 플래그 줄 뒤에 추가 — 나머지 서식은 그대로 둔다.
    바꾼 뒤 YAML 로 다시 읽어 플래그가 기대 값인지 확인하고, 다르면 ``EditError``."""
    lines = text.splitlines()
    last_flag = -1
    cmd_line = -1
    indent = None
    seen: set[str] = set()
    for i, line in enumerate(lines):
        m = _FLAG_LINE.match(line)
        if m:
            last_flag = i
            indent = m.group("indent")
            f = m.group("flag")
            if f in flags and f not in seen:
                lines[i] = f"{m.group('indent')}- {_render_flag(f, flags[f])}"
                seen.add(f)
            continue
        m2 = _ETCD_CMD_LINE.match(line)
        if m2 and cmd_line < 0:
            cmd_line = i
            indent = indent or m2.group("indent")
    missing = [f for f in flags if f not in seen]
    if missing:
        at = last_flag if last_flag >= 0 else cmd_line
        if at < 0 or indent is None:
            raise EditError("매니페스트에서 etcd command 목록을 찾지 못했습니다(- etcd / - --flag 줄).")
        lines[at + 1:at + 1] = [f"{indent}- {_render_flag(f, flags[f])}" for f in missing]
    out = "\n".join(lines) + ("\n" if text.endswith("\n") or not text else "")
    try:
        got = manifest_flags(out)
    except EditError:
        raise
    except Exception as exc:  # noqa: BLE001 — YAML 해석 실패
        raise EditError(f"편집한 매니페스트를 YAML 로 읽을 수 없습니다: {str(exc)[:160]}") from exc
    bad = [f for f, v in flags.items() if C.norm(got.get(f)) != C.norm(v)]
    if bad:
        raise EditError("편집 뒤 다시 읽은 플래그가 기대와 다릅니다: " + ", ".join(bad[:8]))
    return out


def _env_value(value: str) -> str:
    return value if re.match(r"^[A-Za-z0-9_.:/,+=\-]*$", value) else f'"{value}"'


def edit_env_file(text: str, env: dict[str, str]) -> str:
    """``KEY=value``(``export`` 허용) 줄을 바꾸거나 끝에 추가. 다시 읽어 확인."""
    lines = text.splitlines()
    seen: set[str] = set()
    for i, line in enumerate(lines):
        m = re.match(r"^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
        if m and m.group(3) in env and m.group(3) not in seen:
            k = m.group(3)
            lines[i] = f"{m.group(1)}{m.group(2) or ''}{k}={_env_value(env[k])}"
            seen.add(k)
    lines += [f"{k}={_env_value(v)}" for k, v in env.items() if k not in seen]
    out = "\n".join(lines) + "\n"
    got = C.parse_env_text(out)
    bad = [k for k, v in env.items() if C.norm(got.get(k)) != C.norm(v)]
    if bad:
        raise EditError("편집 뒤 다시 읽은 값이 기대와 다릅니다: " + ", ".join(bad[:8]))
    return out


# ── CONTAINERD 순수 편집 ─────────────────────────────────────────────────────

def split_toml_key(s: str) -> list[str]:
    """``a."b.c".d`` → ``["a", "b.c", "d"]`` (TOML 점 키, 큰·작은따옴표 지원)."""
    out: list[str] = []
    i, n = 0, len(s)
    while i < n:
        while i < n and s[i] in " \t":
            i += 1
        if i >= n:
            break
        if s[i] in "\"'":
            q = s[i]
            j = i + 1
            buf = []
            while j < n and s[j] != q:
                if q == '"' and s[j] == "\\" and j + 1 < n:
                    buf.append(s[j + 1])
                    j += 2
                    continue
                buf.append(s[j])
                j += 1
            if j >= n:
                raise EditError(f"닫히지 않은 따옴표: {s}")
            out.append("".join(buf))
            i = j + 1
        else:
            j = i
            while j < n and s[j] not in ". \t":
                j += 1
            out.append(s[i:j])
            i = j
        while i < n and s[i] in " \t":
            i += 1
        if i < n:
            if s[i] != ".":
                raise EditError(f"키를 해석할 수 없습니다: {s}")
            i += 1
    return out


def _join_toml_key(segs: list[str]) -> str:
    return ".".join(C._seg(x) for x in segs)  # noqa: SLF001


def render_toml_value(value: str, vtype: str) -> str:
    v = C.norm(value) or ""
    if vtype == "bool":
        if v.lower() not in ("true", "false"):
            raise EditError(f"참/거짓 값이어야 합니다: {v}")
        return v.lower()
    if vtype == "int":
        if not re.match(r"^-?\d+$", v):
            raise EditError(f"정수여야 합니다: {v}")
        return v
    return json.dumps(v, ensure_ascii=False)


def choose_containerd_path(paths: list[str], flat: dict[str, str]) -> str:
    """노드 설정에 이미 있는 후보 경로 → 없으면 파일 ``version``(2/3)에 맞는 후보."""
    for p in paths:
        if p in flat:
            return p
    ver = str(flat.get("version") or "")
    if ver not in ("2", "3"):
        raise EditError(f"containerd 설정 version {ver or '(없음)'} 은 지원하지 않습니다(2 또는 3).")
    want = '"io.containerd.cri.v1.' if ver == "3" else '"io.containerd.grpc.v1.cri"'
    for p in paths:
        if want in p:
            return p
    return paths[0]


def edit_containerd_toml(text: str, updates: dict[str, tuple[str, str]]) -> str:
    """``{평탄화 경로: (값, 형식)}`` 을 줄 단위로 반영 — 테이블 안 ``key =`` 줄 교체, 없으면 헤더 아래 추가,
    테이블이 없으면 끝에 새 테이블. tomllib 로 다시 읽어 값이 맞는지 확인하고 다르면 ``EditError``."""
    lines = text.splitlines()

    def regions() -> list[tuple[list[str], int, int]]:
        """(테이블 경로, 헤더 줄(-1=최상위), 끝 줄 exclusive)."""
        heads: list[tuple[list[str], int]] = [([], -1)]
        for i, line in enumerate(lines):
            m = _HEADER.match(line)
            if m:
                heads.append((split_toml_key(m.group("path")), i))
            elif _ANY_HEADER.match(line) and line.lstrip().startswith("[["):
                heads.append((["\0array"], i))  # 배열 테이블 — 대상 아님
        out = []
        for idx, (segs, at) in enumerate(heads):
            end = heads[idx + 1][1] if idx + 1 < len(heads) else len(lines)
            out.append((segs, at, end))
        return out

    for path, (value, vtype) in updates.items():
        segs = split_toml_key(path)
        table, key = segs[:-1], segs[-1]
        rendered = render_toml_value(value, vtype)
        done = False
        for tsegs, at, end in regions():
            for i in range(at + 1, end):
                line = lines[i]
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in stripped:
                    continue
                left = stripped.split("=", 1)[0]
                try:
                    full = tsegs + split_toml_key(left)
                except EditError:
                    continue
                if full == segs:
                    indent = line[: len(line) - len(line.lstrip())]
                    lines[i] = f"{indent}{_join_toml_key(split_toml_key(left))} = {rendered}"
                    done = True
                    break
            if done:
                break
        if done:
            continue
        target = next(((at, end) for tsegs, at, end in regions() if tsegs == table), None)
        if target is not None:
            at, end = target
            if at < 0:  # 최상위 키 — 첫 테이블 헤더 앞에 둔다
                lines.insert(end, f"{_join_toml_key([key])} = {rendered}")
            else:
                nxt = lines[at + 1] if at + 1 < len(lines) else ""
                indent = nxt[: len(nxt) - len(nxt.lstrip())] if nxt.strip() and not _ANY_HEADER.match(nxt) else ""
                lines.insert(at + 1, f"{indent}{_join_toml_key([key])} = {rendered}")
        else:
            if lines and lines[-1].strip():
                lines.append("")
            lines += [f"[{_join_toml_key(table)}]", f"  {_join_toml_key([key])} = {rendered}"]
    out = "\n".join(lines) + "\n"
    try:
        flat = C.parse_containerd_toml(out)
    except Exception as exc:  # noqa: BLE001
        raise EditError(f"편집한 설정을 TOML 로 읽을 수 없습니다: {str(exc)[:160]}") from exc
    bad = [p for p, (v, _t) in updates.items() if flat.get(p) != C.norm(v)]
    if bad:
        raise EditError("편집 뒤 다시 읽은 값이 기대와 다릅니다: " + ", ".join(bad[:5]))
    return out


# ── 실행될 명령(화면 표시) ────────────────────────────────────────────────────

def etcd_commands(cfg: dict[str, Any], base: int) -> list[str]:
    bd = cfg["etcd_backup_dir"]
    return [
        f"{cfg['etcd_health_cmd']}  # 사전 점검 — 대상 전 멤버, 하나라도 비정상이면 시작 안 함",
        f"test -f {cfg['etcd_manifest']}  # 방식 판별(설정: {cfg['etcd_mode']})",
        f"[정적 파드] cat {cfg['etcd_manifest']} → mkdir -p {bd} && cp -p {cfg['etcd_manifest']} {bd}/etcd.yaml.pep-bak-v{base}",
        f"[정적 파드] tee {cfg['etcd_manifest']}  # '- --flag=값' 줄만 교체·추가, kubelet 이 etcd 재시작",
        f"[systemd] cat {cfg['etcd_env_file']} → cp -p {cfg['etcd_env_file']} {bd}/{os.path.basename(cfg['etcd_env_file'])}.pep-bak-v{base}",
        f"[systemd] tee {cfg['etcd_env_file']}  # ETCD_* 줄만 교체·추가 → systemctl restart {cfg['etcd_service']}",
        f"{cfg['etcd_health_cmd']}  # 정상('{cfg['etcd_health_expect']}')이 될 때까지 대기(최대 {cfg['etcd_health_timeout_sec']}초)",
        "실행 중인 etcd 프로세스의 플래그·환경변수 다시 읽어 확인 · 실패 시 백업 복원",
    ]


def containerd_commands(cfg: dict[str, Any], base: int) -> list[str]:
    f = cfg["containerd_config"]
    return [
        f"cat {f}  # 줄 단위 TOML 편집 + 재해석 검증(노드에 쓰기 전)",
        "K8S API: cordon <노드> (옵션) · drain — DaemonSet·미러 파드 제외 eviction (옵션)",
        f"cp -p {f} {f}.pep-bak-v{base} → tee {f}",
        f"{cfg['containerd_restart_cmd']} → systemctl is-active {cfg['containerd_service']}",
        "containerd config dump  # 값 확인",
        f"K8S API: 노드 Ready 대기(최대 {cfg['node_ready_timeout_sec']}초) → uncordon · 실패 시 백업 복원",
    ]


# ── 실행 공용 ────────────────────────────────────────────────────────────────

class NodeShell:
    """노드 하나에 대한 SSH 명령 실행기(작업 스레드에서 쓴다)."""

    def __init__(self, host: str, creds: dict[str, Any]):
        self.sudo = "sudo -n " if creds.get("use_sudo") else ""
        self.target = SSHTarget(host=host, port=int(creds.get("port") or 22), username=creds.get("username") or "root",
                                password=creds.get("password"), private_key=creds.get("private_key"))
        self.timeout = int(creds.get("connect_timeout") or 8)

    def exec(self, cmd: str, exec_timeout: int = 30):
        return ssh_runner._exec_ssh(self.target, cmd, connect_timeout=self.timeout, exec_timeout=exec_timeout)  # noqa: SLF001

    def run(self, cmd: str, label: str, exec_timeout: int = 30):
        r = self.exec(cmd, exec_timeout)
        if r.status != "ok":
            detail = (r.error or r.stderr or r.stdout or "").strip()[:300]
            raise RuntimeError(f"{label} 실패({r.status}{'' if r.exit_code is None else f', exit {r.exit_code}'}): {detail}")
        return r

    def sh(self, script: str, label: str, exec_timeout: int = 30):
        return self.run(f"{self.sudo}sh -c {shlex.quote(script)}", label, exec_timeout)

    def write(self, path: str, content: str, label: str = "기록") -> None:
        eof = "PEP_CFG_EOF"
        if any(line.strip() == eof for line in content.splitlines()):
            raise RuntimeError("파일 내용에 구분 문자열이 들어 있어 기록할 수 없습니다.")
        self.run(f"{self.sudo}tee {path} >/dev/null <<'{eof}'\n{content}{eof}", label)


def _sleep(opts: dict[str, Any], key: str = "poll_sec", default: float = 5) -> None:
    s = float(opts.get(key, default) or 0)
    if s > 0:
        time.sleep(s)


def _health(sh: NodeShell, cfg: dict[str, Any]) -> tuple[bool, str]:
    r = sh.exec(f"{sh.sudo}sh -c {shlex.quote(cfg['etcd_health_cmd'])}", 15)
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    return (r.status == "ok" and cfg["etcd_health_expect"] in (r.stdout or "")), out[:200]


async def _run_batches(db: Session, run: ServiceConfigApplyRun, targets: list[dict[str, str]], batch: int, pause: int,
                       stop_on_failure: bool, worker: Callable[[dict[str, str]], dict[str, Any]], log: A.RunLog,
                       after_batch: Optional[Callable[[list[dict[str, Any]]], None]] = None) -> tuple[list[dict[str, Any]], bool]:
    """배치 실행 공용 — 중지 요청·실패 시 중단·배치 사이 대기. 노드 결과는 배치마다 커밋."""
    results: list[dict[str, Any]] = []
    loop = asyncio.get_running_loop()
    stopped = False
    for i in range(0, len(targets), batch):
        if A._stop_requested(db, run):  # noqa: SLF001
            stopped = True
            log.log("warn", "중지 요청 — 남은 노드를 건너뜁니다.")
        failed_before = any(r["status"] == "failed" for r in results)
        if stopped or (failed_before and stop_on_failure):
            for t in targets[i:]:
                results.append({"node": t["node"], "host": t["host"], "status": "skipped", "before": {}, "after": {},
                                "error": "중지" if stopped else "앞 노드 실패로 중단", "duration_ms": 0})
            if not stopped:
                log.log("warn", f"앞 노드에서 실패 — 남은 {len(targets) - i}개 노드는 건너뜁니다.")
            break
        chunk = targets[i:i + batch]
        done = list(await asyncio.gather(*[loop.run_in_executor(None, worker, t) for t in chunk]))
        if after_batch:
            after_batch(done)
        results.extend(done)
        A._flush(db, run, log, results)  # noqa: SLF001
        will_stop = stop_on_failure and any(r["status"] == "failed" for r in results)
        if i + batch < len(targets) and pause and not will_stop:
            log.log("info", f"대기 {pause}초 (다음 노드 전)")
            await asyncio.sleep(pause)
    return results, stopped


def _items(db: Session, service: str) -> dict[str, Any]:
    return {it.key: it for it in V.load_items(db, service)}


# ── ETCD ─────────────────────────────────────────────────────────────────────

def etcd_members(cluster: Cluster) -> list[dict[str, str]]:
    """정적 파드 etcd 멤버(``kube-system`` 의 ``component=etcd``) → [{node, host}]. 실패하면 [](fail-safe)."""
    try:
        core, _apps = A.k8s_apis(cluster)
        pods = core.list_namespaced_pod("kube-system", label_selector="component=etcd", _request_timeout=10)
    except Exception:  # noqa: BLE001
        return []
    out = []
    for p in getattr(pods, "items", None) or []:
        node = getattr(p.spec, "node_name", None)
        if node:
            out.append({"node": node, "host": getattr(p.status, "host_ip", None) or node})
    return out


_PROC_CMDLINE = 'for p in $(pgrep -x etcd); do tr "\\000" " " < /proc/$p/cmdline; echo; done'


def _running_flags(sh: NodeShell) -> list[dict[str, str]]:
    r = sh.exec(f"{sh.sudo}sh -c {shlex.quote(_PROC_CMDLINE)}", 15)
    return [C.parse_cli_flags(line) for line in (r.stdout or "").splitlines() if line.strip()]


def _running_env(sh: NodeShell, svc: str) -> dict[str, str]:
    script = f'tr "\\000" "\\n" < /proc/$(systemctl show -p MainPID --value {svc})/environ'
    r = sh.exec(f"{sh.sudo}sh -c {shlex.quote(script)}", 15)
    return C.parse_env_text(r.stdout or "") if r.status == "ok" else {}


def _etcd_node(t: dict[str, str], values: dict[str, str], items: dict[str, Any], cfg: dict[str, Any],
               opts: dict[str, Any], creds: dict[str, Any], base: int, log: A.RunLog) -> dict[str, Any]:
    node, host = t["node"], t["host"]
    t0 = time.monotonic()
    sh = NodeShell(host, creds)
    sudo = sh.sudo
    res: dict[str, Any] = {"node": node, "host": host, "status": "failed", "before": {}, "after": {}, "error": None}
    timeout = int(opts.get("health_timeout_sec") or cfg["etcd_health_timeout_sec"])
    bd = cfg["etcd_backup_dir"]
    restore: Optional[Callable[[], None]] = None
    try:
        log.step(node, node, "running")
        mode = cfg["etcd_mode"]
        if mode == "auto":
            r = sh.sh(f"test -f {cfg['etcd_manifest']} && echo static_pod || echo systemd", "방식 판별")
            mode = "static_pod" if "static_pod" in (r.stdout or "") else "systemd"
        log.log("info", f"[{node}] SSH {sh.target.username}@{host} — 방식 {'정적 파드' if mode == 'static_pod' else 'systemd'}")
        if mode == "static_pod":
            path = cfg["etcd_manifest"]
            want = {(items[k].source_keys or {}).get("flag") or k: v for k, v in values.items()}
            text = sh.run(f"{sudo}cat {path}", "매니페스트 읽기").stdout or ""
            cur = manifest_flags(text)
            res["before"] = {k: cur.get(f) for k, f in zip(values, want)}
            diff = [f for f, v in want.items() if C.norm(cur.get(f)) != C.norm(v)]
            if not diff:
                log.log("info", f"[{node}] 매니페스트가 이미 이 버전과 같습니다 — 건드리지 않습니다.")
                res["after"] = dict(res["before"])
            else:
                log.log("info", f"[{node}] 바뀔 플래그 {len(diff)}개: " + ", ".join(f"--{f} {cur.get(f, '없음')}→{want[f]}" for f in diff[:8]))
                new = edit_etcd_manifest(text, want)
                backup = f"{bd}/etcd.yaml.pep-bak-v{base}"
                sh.run(f"{sudo}mkdir -p {bd} && {sudo}cp -p {path} {backup}", "백업")
                log.log("info", f"[{node}] 백업 {path} → {backup}")

                def restore() -> None:  # noqa: F811 — 실패 시 복원
                    sh.run(f"{sudo}cp -p {backup} {path}", "복원")

                sh.write(path, new, "매니페스트 기록")
                log.log("info", f"[{node}] 기록 {path} — kubelet 이 etcd 를 다시 띄우기를 기다립니다(최대 {timeout}초)")
                _sleep(opts, "settle_sec", 10)
                deadline = time.monotonic() + timeout
                while True:
                    running = _running_flags(sh)
                    applied = any(all(C.norm(fl.get(f)) == C.norm(v) for f, v in want.items()) for fl in running)
                    ok, out = _health(sh, cfg) if applied else (False, "새 플래그로 아직 재시작되지 않음")
                    if applied and ok:
                        break
                    if time.monotonic() > deadline:
                        raise RuntimeError(f"{timeout}초 안에 새 설정으로 정상 기동하지 않았습니다 — {out}")
                    _sleep(opts)
                res["after"] = {k: want[f] for k, f in zip(values, want)}
        else:
            path, svc = cfg["etcd_env_file"], cfg["etcd_service"]
            want = {(items[k].source_keys or {}).get("env") or k: v for k, v in values.items()}
            flags = {(items[k].source_keys or {}).get("flag") or k for k in values}
            ex = sh.run(f"{sudo}systemctl show -p ExecStart {svc}", "ExecStart 읽기").stdout or ""
            ex_flags = C.parse_cli_flags(ex.split("argv[]=", 1)[-1].split(";", 1)[0])
            conflict = sorted(f for f in flags if f in ex_flags)
            if conflict:
                raise RuntimeError("ExecStart 에 플래그로 지정돼 env 파일로 바꿀 수 없습니다: " + ", ".join(f"--{f}" for f in conflict)
                                   + f" — 유닛 파일({svc})에서 플래그를 빼고 env 파일로 옮기세요.")
            r = sh.exec(f"{sudo}cat {path}", 15)
            existed = r.status == "ok"
            text = (r.stdout or "") if existed else ""
            cur = C.parse_env_text(text)
            res["before"] = {k: cur.get(e) for k, e in zip(values, want)}
            diff = [e for e, v in want.items() if C.norm(cur.get(e)) != C.norm(v)]
            if not diff:
                log.log("info", f"[{node}] env 파일이 이미 이 버전과 같습니다 — 재시작하지 않습니다.")
                res["after"] = dict(res["before"])
            else:
                log.log("info", f"[{node}] 바뀔 값 {len(diff)}개: " + ", ".join(f"{e} {cur.get(e, '없음')}→{want[e]}" for e in diff[:8]))
                new = edit_env_file(text, want)
                backup = f"{bd}/{os.path.basename(path)}.pep-bak-v{base}"
                if existed:
                    sh.run(f"{sudo}mkdir -p {bd} && {sudo}cp -p {path} {backup}", "백업")
                    log.log("info", f"[{node}] 백업 {path} → {backup}")

                def restore() -> None:  # noqa: F811
                    sh.run(f"{sudo}cp -p {backup} {path}" if existed else f"{sudo}rm -f {path}", "복원")
                    sh.run(f"{sudo}systemctl restart {svc}", "재시작", 120)

                sh.write(path, new, "env 파일 기록")
                sh.run(f"{sudo}systemctl restart {svc}", "재시작", 120)
                log.log("info", f"[{node}] 기록 {path} · systemctl restart {svc} — 정상이 될 때까지 대기(최대 {timeout}초)")
                deadline = time.monotonic() + timeout
                while True:
                    ok, out = _health(sh, cfg)
                    if ok:
                        break
                    if time.monotonic() > deadline:
                        raise RuntimeError(f"{timeout}초 안에 정상으로 돌아오지 않았습니다 — {out}")
                    _sleep(opts)
                env_now = _running_env(sh, svc)
                if env_now:
                    bad = [e for e, v in want.items() if C.norm(env_now.get(e)) != C.norm(v)]
                    if bad:
                        raise RuntimeError("실행 중인 etcd 환경변수가 기대와 다릅니다: " + ", ".join(bad[:8]))
                else:
                    log.log("warn", f"[{node}] 실행 중 프로세스 환경변수를 읽지 못해 health 로만 확인했습니다.")
                res["after"] = {k: want[e] for k, e in zip(values, want)}
        res["status"] = "ok"
        log.log("info", f"[{node}] 확인 — 정상 · 새 값 반영")
        log.step(node, node, "done")
    except Exception as exc:  # noqa: BLE001
        res["error"] = str(exc)[:500]
        log.log("error", f"[{node}] {res['error']}")
        if restore is not None and opts.get("auto_restore", True):
            try:
                log.log("warn", f"[{node}] 백업으로 복원합니다")
                restore()
                deadline = time.monotonic() + timeout
                while True:
                    ok, out = _health(sh, cfg)
                    if ok or time.monotonic() > deadline:
                        break
                    _sleep(opts)
                log.log("info" if ok else "error", f"[{node}] 복원 후 health {'정상' if ok else '비정상 — 직접 확인하세요: ' + out}")
                res["error"] += " · 백업으로 복원함" + ("" if ok else "(복원 후에도 비정상)")
            except Exception as rexc:  # noqa: BLE001
                log.log("error", f"[{node}] 복원 실패 — 직접 확인하세요: {str(rexc)[:200]}")
                res["error"] += " · 복원 실패"
        log.step(node, node, "failed")
    res["duration_ms"] = int((time.monotonic() - t0) * 1000)
    return res


async def run_etcd(db: Session, cluster: Cluster, run: ServiceConfigApplyRun, plan: dict[str, Any],
                   opts: dict[str, Any], creds: dict[str, Any], log: A.RunLog) -> dict[str, Any]:
    cfg = A.get_settings(db)
    values = A.validate_pairs(plan["values"])
    items = _items(db, "etcd")
    unknown = [k for k in values if k not in items]
    if unknown:
        raise A.ApplyError(422, f"알 수 없는 etcd 설정: {', '.join(unknown)}")
    targets = plan["targets"]
    base = plan["baseline_version_no"] or 0
    log.log("info", f"시작 — ETCD {plan['group']['name']} V{plan['version_no']} · 멤버 {len(targets)}개 · 한 대씩(고정)"
                    f" · 실패 시 중단(고정) · 자동 복원 {'켬' if opts.get('auto_restore', True) else '끔'}")
    loop = asyncio.get_running_loop()

    log.step("preflight", "사전 점검", "running")
    log.log("info", f"사전 점검 — 대상 멤버 health: {cfg['etcd_health_cmd']}")

    def check(t: dict[str, str]) -> tuple[str, bool, str]:
        try:
            ok, out = _health(NodeShell(t["host"], creds), cfg)
        except Exception as exc:  # noqa: BLE001
            ok, out = False, str(exc)[:200]
        return t["node"], ok, out

    checks = await asyncio.gather(*[loop.run_in_executor(None, check, t) for t in targets])
    bad = [(n, out) for n, ok, out in checks if not ok]
    for n, ok, out in checks:
        log.log("info" if ok else "error", f"[{n}] health {'정상' if ok else '비정상'} — {out}")
    if bad:
        log.step("preflight", "사전 점검", "failed")
        log.log("error", f"사전 점검 실패 — 비정상 멤버 {len(bad)}개. 쿼럼 보호를 위해 시작하지 않습니다.")
        results = [{"node": t["node"], "host": t["host"], "status": "skipped", "before": {}, "after": {},
                    "error": "사전 점검 실패로 시작 안 함", "duration_ms": 0} for t in targets]
        return A._finish(db, cluster, run, log, results, False)  # noqa: SLF001
    log.step("preflight", "사전 점검", "done")

    results, stopped = await _run_batches(
        db, run, targets, 1, max(0, min(int(opts.get("pause_sec") or 0), 600)), True,
        lambda t: _etcd_node(t, values, items, cfg, opts, creds, base, log), log)
    if any(r["status"] == "ok" for r in results):
        log.log("info", "화면의 현재 값은 ETCD 현재 값 수집(정적 파드는 버전 수집, systemd 는 SSH 수집) 뒤 갱신됩니다.")
    return A._finish(db, cluster, run, log, results, stopped)  # noqa: SLF001


# ── CONTAINERD ───────────────────────────────────────────────────────────────

def _node_name_map(core: Any) -> dict[str, str]:
    """SSH 주소·노드 이름 → K8S 노드 이름."""
    out: dict[str, str] = {}
    for n in getattr(core.list_node(_request_timeout=15), "items", None) or []:
        name = n.metadata.name
        out[name] = name
        for a in getattr(n.status, "addresses", None) or []:
            if getattr(a, "address", None):
                out.setdefault(a.address, name)
    return out


def _node_ready(core: Any, name: str) -> bool:
    n = core.read_node(name, _request_timeout=15)
    return any(c.type == "Ready" and c.status == "True" for c in (getattr(n.status, "conditions", None) or []))


def _drain(core: Any, name: str, timeout: int, opts: dict[str, Any], log: A.RunLog, node: str) -> None:
    def evictable() -> list[Any]:
        pods = core.list_pod_for_all_namespaces(field_selector=f"spec.nodeName={name}", _request_timeout=30)
        out = []
        for p in getattr(pods, "items", None) or []:
            ann = getattr(p.metadata, "annotations", None) or {}
            owners = getattr(p.metadata, "owner_references", None) or []
            if "kubernetes.io/config.mirror" in ann or any(o.kind == "DaemonSet" for o in owners):
                continue
            if getattr(p.status, "phase", None) in ("Succeeded", "Failed"):
                continue
            out.append(p)
        return out

    pods = evictable()
    log.log("info", f"[{node}] drain — 내보낼 파드 {len(pods)}개(DaemonSet·미러 파드 제외)")
    for p in pods:
        body = {"apiVersion": "policy/v1", "kind": "Eviction",
                "metadata": {"name": p.metadata.name, "namespace": p.metadata.namespace}}
        core.create_namespaced_pod_eviction(p.metadata.name, p.metadata.namespace, body, _request_timeout=15)
    deadline = time.monotonic() + timeout
    while pods:
        if time.monotonic() > deadline:
            raise RuntimeError(f"drain 이 {timeout}초 안에 끝나지 않았습니다(남은 파드 {len(pods)}개 — PDB 를 확인하세요)")
        _sleep(opts)
        pods = evictable()
    log.log("info", f"[{node}] drain 완료")


def _containerd_node(t: dict[str, str], values: dict[str, str], items: dict[str, Any], cfg: dict[str, Any],
                     opts: dict[str, Any], creds: dict[str, Any], base: int, core: Any, names: dict[str, str],
                     log: A.RunLog) -> dict[str, Any]:
    node, host = t["node"], t["host"]
    t0 = time.monotonic()
    sh = NodeShell(host, creds)
    sudo = sh.sudo
    path, svc = cfg["containerd_config"], cfg["containerd_service"]
    backup = f"{path}.pep-bak-v{base}"
    res: dict[str, Any] = {"node": node, "host": host, "status": "failed", "before": {}, "after": {}, "error": None}
    k8s_name = names.get(host) or names.get(node)
    cordoned = False
    written = False
    ready_timeout = int(opts.get("node_ready_timeout_sec") or cfg["node_ready_timeout_sec"])

    def restart() -> None:
        sh.sh(cfg["containerd_restart_cmd"], "재시작", 120)
        for _ in range(15):
            r = sh.exec(f"{sudo}systemctl is-active {svc}", 10)
            if (r.stdout or "").strip() == "active":
                return
            _sleep(opts, "poll_sec", 2)
        raise RuntimeError(f"재시작 뒤 {svc} 가 active 가 아닙니다")

    def uncordon() -> None:
        if cordoned and core is not None and k8s_name:
            core.patch_node(k8s_name, {"spec": {"unschedulable": False}}, _request_timeout=15)
            log.log("info", f"[{node}] uncordon {k8s_name}")

    try:
        log.step(node, node, "running")
        log.log("info", f"[{node}] SSH {sh.target.username}@{host} — {path} 읽기")
        text = sh.run(f"{sudo}cat {path}", "설정 파일 읽기").stdout or ""
        if not text.strip():
            raise RuntimeError(f"{path} 가 비어 있거나 없습니다 — containerd config default 로 먼저 파일을 만드세요.")
        flat = C.parse_containerd_toml(text)
        updates: dict[str, tuple[str, str]] = {}
        chosen: dict[str, str] = {}
        for k, v in values.items():
            p = choose_containerd_path(list((items[k].source_keys or {}).get("paths") or []), flat)
            chosen[k] = p
            updates[p] = (v, items[k].value_type or "string")
        res["before"] = {k: flat.get(p) for k, p in chosen.items()}
        diff = [k for k, p in chosen.items() if flat.get(p) != C.norm(values[k])]
        if not diff:
            log.log("info", f"[{node}] 설정 파일이 이미 이 버전과 같습니다 — 재시작하지 않습니다.")
            res["after"] = dict(res["before"])
            res["status"] = "ok"
            log.step(node, node, "done")
            res["duration_ms"] = int((time.monotonic() - t0) * 1000)
            return res
        log.log("info", f"[{node}] 바뀔 값 {len(diff)}개: " + ", ".join(f"{k} {flat.get(chosen[k], '없음')}→{values[k]}" for k in diff[:8]))
        new = edit_containerd_toml(text, updates)
        log.log("info", f"[{node}] 편집본 TOML 재해석 확인 완료(경로: {', '.join(chosen[k] for k in diff[:3])}{' …' if len(diff) > 3 else ''})")
        if core is not None and k8s_name and opts.get("cordon", True):
            was = bool(getattr(core.read_node(k8s_name, _request_timeout=15).spec, "unschedulable", False))
            if not was:
                core.patch_node(k8s_name, {"spec": {"unschedulable": True}}, _request_timeout=15)
                cordoned = True
                log.log("info", f"[{node}] cordon {k8s_name}")
            else:
                log.log("info", f"[{node}] 이미 cordon 상태 — 끝나도 uncordon 하지 않습니다.")
            if opts.get("drain", False):
                _drain(core, k8s_name, int(opts.get("drain_timeout_sec") or 300), opts, log, node)
        elif opts.get("cordon", True):
            log.log("warn", f"[{node}] K8S 노드를 찾지 못해 cordon·Ready 대기를 건너뜁니다.")
        sh.run(f"{sudo}cp -p {path} {backup}", "백업")
        log.log("info", f"[{node}] 백업 {path} → {backup}")
        sh.write(path, new, "설정 파일 기록")
        written = True
        log.log("info", f"[{node}] 기록 {path} · {cfg['containerd_restart_cmd']}")
        restart()
        log.log("info", f"[{node}] {svc} active")
        r = sh.exec(f"{sudo}containerd config dump", 30)
        after_flat: Optional[dict[str, str]] = None
        if r.status == "ok" and (r.stdout or "").strip():
            try:
                after_flat = C.parse_containerd_toml(r.stdout)
            except Exception:  # noqa: BLE001
                after_flat = None
        if after_flat is None:
            log.log("warn", f"[{node}] config dump 를 읽지 못해 파일로 확인합니다.")
            after_flat = C.parse_containerd_toml(sh.run(f"{sudo}cat {path}", "다시 읽기").stdout or "")
        res["after"] = {k: after_flat.get(p) for k, p in chosen.items()}
        bad = [k for k, p in chosen.items() if after_flat.get(p) != C.norm(values[k])]
        if bad:
            raise RuntimeError("재시작 뒤 실효 설정이 기대와 다릅니다: " + ", ".join(f"{k}={after_flat.get(chosen[k], '없음')}" for k in bad[:8]))
        if core is not None and k8s_name:
            deadline = time.monotonic() + ready_timeout
            while not _node_ready(core, k8s_name):
                if time.monotonic() > deadline:
                    raise RuntimeError(f"노드 {k8s_name} 가 {ready_timeout}초 안에 Ready 가 되지 않았습니다.")
                _sleep(opts)
            log.log("info", f"[{node}] 노드 Ready")
        uncordon()
        res["_flat"] = after_flat
        res["status"] = "ok"
        log.log("info", f"[{node}] 확인 {len(values)}/{len(values)} 일치 — 완료")
        log.step(node, node, "done")
    except Exception as exc:  # noqa: BLE001
        res["error"] = str(exc)[:500]
        log.log("error", f"[{node}] {res['error']}")
        healthy = not written
        if written and opts.get("auto_restore", True):
            try:
                log.log("warn", f"[{node}] 백업으로 복원 후 재시작합니다")
                sh.run(f"{sudo}cp -p {backup} {path}", "복원")
                restart()
                healthy = True
                res["error"] += " · 백업으로 복원함"
                log.log("info", f"[{node}] 복원 완료 · {svc} active")
            except Exception as rexc:  # noqa: BLE001
                res["error"] += " · 복원 실패"
                log.log("error", f"[{node}] 복원 실패 — 직접 확인하세요: {str(rexc)[:200]}")
        if healthy:
            try:
                uncordon()
            except Exception as uexc:  # noqa: BLE001
                log.log("error", f"[{node}] uncordon 실패: {str(uexc)[:200]}")
        elif cordoned:
            log.log("warn", f"[{node}] 런타임이 정상이 아니어서 cordon 상태로 둡니다.")
        log.step(node, node, "failed")
    res["duration_ms"] = int((time.monotonic() - t0) * 1000)
    return res


async def run_containerd(db: Session, cluster: Cluster, run: ServiceConfigApplyRun, plan: dict[str, Any],
                         opts: dict[str, Any], creds: dict[str, Any], log: A.RunLog) -> dict[str, Any]:
    from app.services.config_snapshot import store_if_changed

    cfg = A.get_settings(db)
    values = A.validate_pairs(plan["values"])
    items = _items(db, "containerd")
    for k, v in values.items():
        if k not in items:
            raise A.ApplyError(422, f"알 수 없는 containerd 설정: {k}")
        render_toml_value(v, items[k].value_type or "string")  # 형식 오류는 시작 전에
    targets = plan["targets"]
    base = plan["baseline_version_no"] or 0
    batch = max(1, min(int(opts.get("batch_size") or 1), 50))
    pause = max(0, min(int(opts.get("pause_sec") or 0), 600))
    stop_on_failure = opts.get("stop_on_failure", True)
    log.log("info", f"시작 — CONTAINERD {plan['group']['name']} V{plan['version_no']} · 노드 {len(targets)}개 · {batch}대씩"
                    f" · cordon {'켬' if opts.get('cordon', True) else '끔'} · drain {'켬' if opts.get('drain') else '끔'}"
                    f" · 자동 복원 {'켬' if opts.get('auto_restore', True) else '끔'}")
    loop = asyncio.get_running_loop()
    core = None
    names: dict[str, str] = {}
    try:
        core, _apps = await loop.run_in_executor(None, A.k8s_apis, cluster)
        names = await loop.run_in_executor(None, _node_name_map, core)
    except Exception as exc:  # noqa: BLE001 — K8S 를 못 쓰면 cordon·Ready 대기 없이 진행
        core = None
        log.log("warn", f"K8S API 를 쓸 수 없어 cordon·drain·Ready 대기를 건너뜁니다 ({str(exc)[:160]})")

    def after_batch(done: list[dict[str, Any]]) -> None:
        now = datetime.utcnow()
        changed = False
        for r in done:
            flat = r.pop("_flat", None)
            if flat:
                data = {"source": "ssh", "host": r["host"], "source_label": "containerd config dump (적용 후)", "flat": flat}
                changed |= store_if_changed(db, cluster.id, f"containerd_config:{r['host']}", "runtime",
                                            str(flat.get("version") or "") or None, data, now)
        if changed:
            db.commit()

    results, stopped = await _run_batches(
        db, run, targets, batch, pause, stop_on_failure,
        lambda t: _containerd_node(t, values, items, cfg, opts, creds, base, core, names, log), log, after_batch)
    return A._finish(db, cluster, run, log, results, stopped)  # noqa: SLF001
