"""서비스 구성 — NIC 적용(2-b). 설계: ``docs/02-design/nic-apply.md`` §5.

노드마다 SSH 로(자격증명은 요청에만 쓰고 저장하지 않는다):
0. 현재 값 읽기 — 2-a SSH 수집 스크립트(``nic_watch/ssh_collect``)를 그대로 돌려 인터페이스 상태를 얻는다.
1. 계획 — 대상(본딩과 그 하위 / glob) 인터페이스마다 ``max`` 를 최대값으로 풀고, 최대값 초과는 실패,
   ``[fixed]``·드라이버 미지원·값 같음은 건너뜀. **이중화가 확인되지 않은 인터페이스**(본딩 하위가 2개 미만이거나
   하위가 MII up·활성 Aggregator 에 속하지 않음)는 큐를 다시 만드는 키(ring·채널·offload)를 건너뛴다.
2. 원복 준비 — 지금 값으로 되돌리는 스크립트를 ``/run/pep/nic-rollback.sh`` 에 쓰고
   ``systemd-run --on-active`` 타이머를 건다(데드맨 스위치). PEP 가 다시 접속해 확인해야 타이머를 끈다.
3. 끊김 없는 키 — 본딩 sysfs(xmit_hash_policy·miimon·lacp_rate). lacp_rate 는 커널이 본딩 up 중 변경을 거부할 수 있어
   그 경우 영구 기록만 하고 '본딩 재기동 후 반영' 으로 남긴다.
4. 끊김 있는 키 — **하위 인터페이스 하나씩** ``ethtool -G/-L/-K`` → 링크 up + 본딩 MII up + (802.3ad) 활성 Aggregator
   재합류를 제한 시간까지 기다린 뒤 다음 하위로. 실패하면 그 노드를 즉시 원복한다.
5. 확인 — 새 SSH 세션으로 다시 읽어 목표 값과 비교 → 타이머 해제.
6. 영구 기록 — NetworkManager 가 관리하는 인터페이스만 ``nmcli connection modify``(속성이 있는지 먼저 확인).
   ``connection up``·``device reapply`` 는 하지 않는다(재활성화로 링크가 내려갈 수 있다). NM 이 아니면 런타임만 + 경고.

순수 함수(계획·명령·원복 스크립트·본딩 옵션 병합·재합류 판정)는 단위 테스트 대상이고, 실행은 ``RunLog`` 로 실시간 로그를 흘린다.
"""
from __future__ import annotations

import asyncio
import re
import shlex
import time
from typing import Any, Callable, Optional

from sqlalchemy.orm import Session

from app.models.cluster import Cluster
from app.models.service_config import ServiceConfigApplyRun
from app.node_param_agent.nic import parse_proc_bonding
from app.services import ssh_runner
from app.services.ssh_runner import SSHTarget

# 버전 키 → ethtool -K 기능 이름(짧은 이름이 있으면 그것 — 오래된 ethtool 도 받는다) / NM ethtool.feature-* 이름
FEATURE_K = {"rx-lro": "lro", "rx-gro": "gro", "tx-tcp-segmentation": "tso", "rx-checksum": "rx",
             "tx-checksum-ip-generic": "tx-checksum-ip-generic", "tx-udp_tnl-segmentation": "tx-udp_tnl-segmentation"}
FEATURE_NM = {"rx-lro": "lro", "rx-gro": "gro", "tx-tcp-segmentation": "tso", "rx-checksum": "rx",
              "tx-checksum-ip-generic": "tx-checksum-ip-generic", "tx-udp_tnl-segmentation": "tx-udp_tnl-segmentation"}
BOND_SYSFS = {"bond.xmit_hash_policy": "xmit_hash_policy", "bond.lacp_rate": "lacp_rate", "bond.miimon": "miimon"}
ROLLBACK_SCRIPT = "/run/pep/nic-rollback.sh"
ROLLBACK_UNIT = "pep-nic-rollback"
_NAME_RE = re.compile(r"^[A-Za-z0-9_.:@-]{1,32}$")
_VAL_RE = re.compile(r"^[A-Za-z0-9+._-]{1,32}$")


# ── 계획(순수) ───────────────────────────────────────────────────────────────

def _want_num(spec: Any, cur: Optional[int], mx: Optional[int]) -> tuple[Optional[int], Optional[str]]:
    """(목표 숫자, 오류). ``max`` → 최대값. 최대값 초과는 오류."""
    s = str(spec).strip().lower()
    if s == "max":
        return (mx, None) if mx else (None, "최대값을 읽지 못함")
    try:
        n = int(s)
    except ValueError:
        return None, f"숫자 또는 max 가 아님: {spec}"
    if n <= 0:
        return None, f"0 이하: {n}"
    if mx and n > mx:
        return None, f"{n} > 최대 {mx}"
    return n, None


def bond_redundant(bond: dict[str, Any]) -> tuple[bool, str]:
    """하위 2개 이상이 MII up 이고 (802.3ad 면) 모두 활성 Aggregator 에 속하는가."""
    slaves = list(bond.get("slaves") or [])
    if len(slaves) < 2:
        return False, f"하위 인터페이스 {len(slaves)}개"
    st = bond.get("slave_state") or {}
    down = [s for s in slaves if (st.get(s) or {}).get("mii_status") not in (None, "up")]
    if down:
        return False, f"하위 다운: {', '.join(down)}"
    if bond.get("mode") == "802.3ad":
        agg = (bond.get("active") or {}).get("aggregator_id")
        out = [s for s in slaves if agg is not None and (st.get(s) or {}).get("aggregator_id") not in (None, agg)]
        if out:
            return False, f"활성 Aggregator 밖: {', '.join(out)}"
    return True, ""


def plan_node(ifaces: list[dict[str, Any]], values: dict[str, Any], targets: tuple[list[dict], list[dict]]) -> dict[str, Any]:
    """노드 하나의 적용 계획. ``targets`` = ``snapshot.select_targets`` 결과(본딩들, 물리 대상들).

    반환: {bonds: [{name, changes: [{key, attr, cur, want}], notes}], members: [{name, bond, ring, channels,
    features: {feat: (cur, want)}, skipped: [...]}], errors: [...], redundant: {bond: (ok, why)}}"""
    bonds, phys = targets
    out: dict[str, Any] = {"bonds": [], "members": [], "errors": [], "redundant": {}}
    member_of: dict[str, str] = {}
    for b in bonds:
        bd = b.get("bond") or {}
        ok, why = bond_redundant(bd)
        out["redundant"][b["name"]] = (ok, why)
        for s in bd.get("slaves") or []:
            member_of[s] = b["name"]
        changes = []
        for key, attr in BOND_SYSFS.items():
            if key not in values:
                continue
            if key == "bond.lacp_rate" and bd.get("mode") != "802.3ad":
                continue
            cur = bd.get(attr)
            want = str(values[key]).strip()
            if cur is None or str(cur) != want:
                changes.append({"key": key, "attr": attr, "cur": None if cur is None else str(cur), "want": want})
        out["bonds"].append({"name": b["name"], "changes": changes})
    for it in phys:
        name = it["name"]
        bond = member_of.get(name)
        m: dict[str, Any] = {"name": name, "bond": bond, "ring": {}, "channels": None, "features": {}, "skipped": []}
        ring = it.get("ring") or {}
        for side in ("rx", "tx"):
            key = f"ring.{side}"
            if key not in values:
                continue
            if not ring:
                m["skipped"].append(f"{key}: 드라이버가 ring 조회를 지원하지 않음")
                continue
            want, err = _want_num(values[key], ring.get(side), ring.get(f"{side}_max"))
            if err:
                out["errors"].append(f"{name} {key}: {err}")
            elif want != ring.get(side):
                m["ring"][side] = (ring.get(side), want)
        if "channels.combined" in values:
            ch = it.get("channels") or {}
            if not ch.get("combined_max"):
                m["skipped"].append("channels.combined: 결합 채널을 지원하지 않음")
            else:
                want, err = _want_num(values["channels.combined"], ch.get("combined"), ch.get("combined_max"))
                if err:
                    out["errors"].append(f"{name} channels.combined: {err}")
                elif want != ch.get("combined"):
                    m["channels"] = (ch.get("combined"), want)
        feats = it.get("features") or {}
        for key, val in values.items():
            if not key.startswith("offload."):
                continue
            feat = key[len("offload."):]
            if feat not in FEATURE_K:
                continue
            st = feats.get(feat)
            want_on = str(val).strip() == "on"
            if not isinstance(st, dict):
                m["skipped"].append(f"{key}: 드라이버에 없음")
                continue
            if bool(st.get("on")) == want_on:
                continue
            if st.get("fixed"):
                m["skipped"].append(f"{key}: [fixed] — 드라이버가 고정")
                continue
            m["features"][feat] = (bool(st.get("on")), want_on)
        disruptive = bool(m["ring"] or m["channels"] or m["features"])
        if disruptive:
            ok, why = out["redundant"].get(bond or "", (False, "본딩 하위가 아님"))
            if not ok:
                m["skipped"].append(f"이중화 없음({why}) — 큐를 다시 만드는 변경(ring·채널·offload)을 건너뜀")
                m["ring"], m["channels"], m["features"] = {}, None, {}
        out["members"].append(m)
    return out


def has_runtime_changes(plan: dict[str, Any]) -> bool:
    return any(b["changes"] for b in plan["bonds"]) or any(
        m["ring"] or m["channels"] or m["features"] for m in plan["members"])


# ── 명령(순수) ───────────────────────────────────────────────────────────────

def _q(name: str) -> str:
    if not _NAME_RE.match(name):
        raise ValueError(f"쓸 수 없는 인터페이스 이름: {name!r}")
    return name


def member_commands(eth: str, m: dict[str, Any], *, rollback: bool = False) -> list[str]:
    """하위 인터페이스 하나의 ethtool 명령. ``rollback`` 이면 지금(cur) 값으로 되돌리는 명령."""
    i = 0 if rollback else 1
    n = _q(m["name"])
    cmds: list[str] = []
    if m["ring"]:
        parts = " ".join(f"{side} {pair[i]}" for side, pair in sorted(m["ring"].items()) if pair[i])
        if parts:
            cmds.append(f"{eth} -G {n} {parts}")
    if m["channels"] and m["channels"][i]:
        cmds.append(f"{eth} -L {n} combined {m['channels'][i]}")
    if m["features"]:
        parts = " ".join(f"{FEATURE_K[f]} {'on' if pair[i] else 'off'}" for f, pair in sorted(m["features"].items()))
        cmds.append(f"{eth} -K {n} {parts}")
    return cmds


def bond_command(bond: str, attr: str, value: str) -> str:
    if not _VAL_RE.match(value):
        raise ValueError(f"쓸 수 없는 값: {value!r}")
    return f"echo {value} > /sys/class/net/{_q(bond)}/bonding/{attr}"


def rollback_script(eth: str, plan: dict[str, Any]) -> str:
    """지금 값으로 되돌리는 셸 스크립트 — 하위 인터페이스 → 본딩 순. 각 줄 실패는 무시하고 계속한다."""
    lines = ["#!/bin/sh", "# PEP NIC 적용 원복(데드맨) — 적용이 확인되면 PEP 가 타이머를 끈다"]
    for m in plan["members"]:
        lines += [f"{c} || true" for c in member_commands(eth, m, rollback=True)]
    for b in plan["bonds"]:
        for ch in b["changes"]:
            if ch["cur"] is not None:
                lines.append(f"{bond_command(b['name'], ch['attr'], ch['cur'])} || true")
    return "\n".join(lines) + "\n"


def merge_bond_options(current: str, updates: dict[str, str]) -> str:
    """NM ``bond.options``(``a=1,b=2``)에서 해당 키만 바꾸고 나머지는 보존한다."""
    pairs: list[list[str]] = []
    for tok in (current or "").split(","):
        tok = tok.strip()
        if "=" in tok:
            k, v = tok.split("=", 1)
            pairs.append([k.strip(), v.strip()])
    keys = [p[0] for p in pairs]
    for k, v in updates.items():
        if k in keys:
            pairs[keys.index(k)][1] = v
        else:
            pairs.append([k, v])
    return ",".join(f"{k}={v}" for k, v in pairs)


def member_rejoined(proc_text: str, member: str, mode: Optional[str]) -> tuple[bool, str]:
    """``/proc/net/bonding/<bond>`` 로 하위가 다시 들어왔는지 — MII up + (802.3ad) 활성 Aggregator."""
    p = parse_proc_bonding(proc_text or "")
    st = (p.get("slave_state") or {}).get(member) or {}
    if st.get("mii_status") != "up":
        return False, f"MII {st.get('mii_status') or '없음'}"
    if mode == "802.3ad":
        agg = (p.get("active") or {}).get("aggregator_id")
        if agg is not None and st.get("aggregator_id") != agg:
            return False, f"Aggregator {st.get('aggregator_id')} ≠ 활성 {agg}"
    return True, "MII up" + (" · 활성 Aggregator" if mode == "802.3ad" else "")


def planned_commands(cfg: dict[str, Any], values: dict[str, Any]) -> list[str]:
    """적용 대화상자 '실행될 명령' — 노드 하나 기준 예시(인터페이스 자리는 <하위>·<본딩>)."""
    eth = cfg.get("nic_ethtool") or "ethtool"
    t = int(cfg.get("nic_rollback_timer_sec") or 120)
    cmds = ["sh -c '<NIC 수집 스크립트>'  # 현재 값·최대값·[fixed]·본딩 상태(조회만)",
            f"install -D -m 700 /dev/stdin {ROLLBACK_SCRIPT}  # 지금 값으로 되돌리는 스크립트",
            f"systemd-run --unit={ROLLBACK_UNIT} --on-active={t}s /bin/sh {ROLLBACK_SCRIPT}  # 데드맨 원복 타이머"]
    for key, attr in BOND_SYSFS.items():
        if key in values:
            cmds.append(f"echo {values[key]} > /sys/class/net/<본딩>/bonding/{attr}")
    ring = " ".join(f"{s} {values[f'ring.{s}']}" for s in ("rx", "tx") if f"ring.{s}" in values)
    if ring:
        cmds.append(f"{eth} -G <하위> {ring}  # max = 인터페이스 최대값, 하위 하나씩")
    if "channels.combined" in values:
        cmds.append(f"{eth} -L <하위> combined {values['channels.combined']}")
    feats = " ".join(f"{FEATURE_K[k[8:]]} {values[k]}" for k in sorted(values) if k.startswith("offload.") and k[8:] in FEATURE_K)
    if feats:
        cmds.append(f"{eth} -K <하위> {feats}")
    cmds += ["cat /proc/net/bonding/<본딩>  # MII up·활성 Aggregator 재합류 대기 → 다음 하위",
             "sh -c '<NIC 수집 스크립트>'  # 새 SSH 세션으로 다시 읽어 확인",
             f"systemctl stop {ROLLBACK_UNIT}.timer  # 데드맨 해제",
             "nmcli connection modify <연결> ethtool.ring-rx … ethtool.feature-… / bond.options …  # 영구 기록(NM 관리 인터페이스만, 재활성화 안 함)"]
    return cmds


# ── 실행 ─────────────────────────────────────────────────────────────────────

class _Ssh:
    def __init__(self, host: str, creds: dict[str, Any]):
        self.target = SSHTarget(host=host, port=int(creds.get("port") or 22), username=creds.get("username") or "root",
                                password=creds.get("password"), private_key=creds.get("private_key"))
        self.timeout = int(creds.get("connect_timeout") or 8)
        self.sudo = "sudo -n " if creds.get("use_sudo") else ""

    def run(self, cmd: str, label: str, exec_timeout: int = 30, check: bool = True, big: bool = False):
        full = f"{self.sudo}sh -c {shlex.quote(cmd)}"
        r = ssh_runner._exec_ssh(self.target, full, connect_timeout=self.timeout, exec_timeout=exec_timeout,  # noqa: SLF001
                                 max_stdout_chars=1_000_000 if big else 20000)
        if check and r.status != "ok":
            detail = (r.error or r.stderr or r.stdout or "").strip()[:300]
            raise RuntimeError(f"{label} 실패({r.status}{'' if r.exit_code is None else f', exit {r.exit_code}'}): {detail}")
        return r


def _collect(ssh: _Ssh, cfg: dict[str, Any], nic_cfg: dict[str, Any], label: str) -> list[dict[str, Any]]:
    from app.services.nic_watch import ssh_collect as NS

    out = ssh.run(NS.build_script(nic_cfg["exclude_names"], cfg.get("nic_ethtool") or "ethtool"), label,
                  exec_timeout=60, big=True)
    parsed = NS.parse_output(out.stdout or "", nic_cfg)
    for w in parsed["errors"]:
        if "ethtool" in w:
            raise RuntimeError(f"{label}: 노드에 ethtool 이 없습니다 — 적용 설정의 ethtool 경로를 확인하세요")
    return parsed["interfaces"]


def _nm(ssh: _Ssh, plan: dict[str, Any], values: dict[str, Any], log: Callable[[str, str], None]) -> list[str]:
    """NetworkManager 영구 기록. 반환 = 결과 메모 목록."""
    notes: list[str] = []
    if (ssh.run("command -v nmcli >/dev/null 2>&1 && echo yes || echo no", "nmcli 확인").stdout or "").strip() != "yes":
        return ["NetworkManager 없음 — 런타임만 적용(재부팅하면 원래 값)"]

    def conn_of(dev: str) -> Optional[str]:
        r = ssh.run(f"nmcli -t -g GENERAL.STATE,GENERAL.CONNECTION device show {_q(dev)}", f"{dev} NM 상태", check=False)
        lines = [ln.strip() for ln in (r.stdout or "").splitlines() if ln.strip()]
        if r.status != "ok" or len(lines) < 2 or "unmanaged" in lines[0] or not lines[1] or lines[1] == "--":
            return None
        return lines[1]

    def modify(conn: str, props: dict[str, str], what: str) -> None:
        ok_props: dict[str, str] = {}
        for prop, val in props.items():
            r = ssh.run(f"nmcli -g {prop} connection show {shlex.quote(conn)}", f"{what} {prop} 확인", check=False)
            if r.status != "ok":
                notes.append(f"{what}: NM 이 {prop} 를 지원하지 않음 — 런타임만")
                continue
            if (r.stdout or "").strip() != val:
                ok_props[prop] = val
        if ok_props:
            args = " ".join(f"{p} {shlex.quote(v)}" for p, v in ok_props.items())
            ssh.run(f"nmcli connection modify {shlex.quote(conn)} {args}", f"{what} NM 기록")
            log("info", f"NM {conn}: {', '.join(f'{p}={v}' for p, v in ok_props.items())}")

    for m in plan["members"]:
        props: dict[str, str] = {}
        if m.get("want_ring"):
            for side, v in m["want_ring"].items():
                props[f"ethtool.ring-{side}"] = str(v)
        if m.get("want_channels"):
            props["ethtool.channels-combined"] = str(m["want_channels"])
        for feat, on in (m.get("want_features") or {}).items():
            props[f"ethtool.feature-{FEATURE_NM[feat]}"] = "on" if on else "off"
        if not props:
            continue
        conn = conn_of(m["name"])
        if conn is None:
            notes.append(f"{m['name']}: NM 이 관리하지 않음 — 런타임만(재부팅하면 원래 값)")
            continue
        modify(conn, props, m["name"])
    for b in plan["bonds"]:
        upd = {BOND_SYSFS[k]: str(values[k]) for k in BOND_SYSFS if k in values
               and not (k == "bond.lacp_rate" and not b.get("lacp_applies", True))}
        if not upd:
            continue
        conn = conn_of(b["name"])
        if conn is None:
            notes.append(f"{b['name']}: NM 이 관리하지 않음 — 본딩 옵션 런타임만")
            continue
        r = ssh.run(f"nmcli -g bond.options connection show {shlex.quote(conn)}", f"{b['name']} bond.options 읽기")
        cur = (r.stdout or "").strip().replace("\\,", ",")
        merged = merge_bond_options(cur, upd)
        if merged != cur:
            ssh.run(f"nmcli connection modify {shlex.quote(conn)} bond.options {shlex.quote(merged)}", f"{b['name']} NM 기록")
            log("info", f"NM {conn}: bond.options={merged}")
    return notes


def nic_node(node: str, host: str, values: dict[str, Any], cfg: dict[str, Any], nic_cfg: dict[str, Any],
             opts: dict[str, Any], creds: dict[str, Any], log: Any) -> dict[str, Any]:
    """노드 하나 적용 — 작업 스레드에서 돈다. 반환은 ``node_results`` 한 행."""
    from app.services.nic_watch import snapshot as SN

    t0 = time.monotonic()
    eth = cfg.get("nic_ethtool") or "ethtool"
    timer = int(opts.get("rollback_timer_sec") or cfg.get("nic_rollback_timer_sec") or 120)
    rejoin = int(opts.get("rejoin_timeout_sec") or cfg.get("nic_rejoin_timeout_sec") or 60)
    member_wait = int(opts.get("member_wait_sec") if opts.get("member_wait_sec") is not None else cfg.get("nic_member_wait_sec", 10))
    res: dict[str, Any] = {"node": node, "host": host, "status": "failed", "before": {}, "after": {}, "error": None,
                           "interfaces": [], "notes": []}
    ssh = _Ssh(host, creds)
    armed = False
    applied_any = False
    plan: dict[str, Any] = {}

    def L(level: str, msg: str) -> None:
        log.log(level, f"[{node}] {msg}")

    def rollback(reason: str) -> None:
        if not applied_any:
            return
        L("warn", f"원복 — {reason}")
        r = ssh.run(f"sh {ROLLBACK_SCRIPT}; systemctl stop {ROLLBACK_UNIT}.timer 2>/dev/null; true", "원복", check=False, exec_timeout=120)
        if r.status == "ok":
            L("warn", "원복 스크립트 실행 완료(이전 값)")
        else:
            L("error", f"원복 접속 실패 — 노드 타이머가 {timer}초 안에 원복한다({r.error or r.status})")

    try:
        log.step(node, node, "running")
        L("info", f"SSH {ssh.target.username}@{host}:{ssh.target.port} — 현재 값 읽기")
        ifaces = _collect(ssh, cfg, nic_cfg, "현재 값 읽기")
        targets = SN.select_targets(ifaces, nic_cfg.get("target_mode") or "bond_members", nic_cfg.get("target_glob") or [])
        plan = plan_node(ifaces, values, targets)
        for b, (ok, why) in plan["redundant"].items():
            L("info" if ok else "warn", f"본딩 {b}: {'이중화 확인' if ok else '이중화 없음 — ' + why}")
        if plan["errors"]:
            raise RuntimeError("계획 실패: " + "; ".join(plan["errors"][:6]))
        for m in plan["members"]:
            for s in m["skipped"]:
                L("warn", f"{m['name']} 건너뜀 — {s}")
        # 실행 화면 표와 같은 모양(키 → 값, 스냅샷과 같은 '현재/최대' 표기)
        res["before"] = SN.flatten(ifaces, nic_cfg.get("target_mode") or "bond_members", nic_cfg.get("target_glob") or [])["flat"]
        # 영구 기록용 목표 값(런타임 변경이 없어도 NM 은 맞춘다)
        by = {i["name"]: i for i in ifaces}
        for m in plan["members"]:
            it = by.get(m["name"]) or {}
            ring = it.get("ring") or {}
            m["want_ring"] = {s: n for s in ("rx", "tx") if f"ring.{s}" in values and ring
                              for n in [_want_num(values[f"ring.{s}"], ring.get(s), ring.get(f"{s}_max"))[0]] if n}
            ch = it.get("channels") or {}
            n = _want_num(values["channels.combined"], ch.get("combined"), ch.get("combined_max"))[0] if (
                "channels.combined" in values and ch.get("combined_max")) else None
            m["want_channels"] = n
            m["want_features"] = {k[8:]: str(v) == "on" for k, v in values.items()
                                  if k.startswith("offload.") and k[8:] in FEATURE_K
                                  and isinstance((it.get("features") or {}).get(k[8:]), dict)
                                  and not (it.get("features") or {})[k[8:]].get("fixed")}
        for b in plan["bonds"]:
            b["lacp_applies"] = ((by.get(b["name"]) or {}).get("bond") or {}).get("mode") == "802.3ad"
        if has_runtime_changes(plan):
            ssh.run(f"mkdir -p /run/pep && cat > {ROLLBACK_SCRIPT} <<'PEP_NIC_EOF'\n{rollback_script(eth, plan)}PEP_NIC_EOF\nchmod 700 {ROLLBACK_SCRIPT}",
                    "원복 스크립트 기록")
            ssh.run(f"systemctl stop {ROLLBACK_UNIT}.timer 2>/dev/null; systemctl reset-failed {ROLLBACK_UNIT}.timer {ROLLBACK_UNIT}.service 2>/dev/null; "
                    f"systemd-run --unit={ROLLBACK_UNIT} --on-active={timer}s /bin/sh {ROLLBACK_SCRIPT}", "원복 타이머")
            armed = True
            L("info", f"데드맨 원복 타이머 {timer}초 — 확인 전 연결이 끊기면 노드가 스스로 이전 값으로 돌아간다")
        else:
            L("info", "런타임 변경 없음")
        # 끊김 없는 키 — 본딩 sysfs
        for b in plan["bonds"]:
            for ch in b["changes"]:
                r = ssh.run(bond_command(b["name"], ch["attr"], ch["want"]), f"{b['name']} {ch['attr']}", check=False)
                if r.status == "ok":
                    applied_any = True
                    L("info", f"{b['name']} {ch['attr']} {ch['cur']} → {ch['want']}")
                elif ch["attr"] == "lacp_rate":
                    res["notes"].append(f"{b['name']} lacp_rate: 본딩이 올라와 있어 커널이 거부 — 영구 기록만, 본딩 재기동(재부팅) 후 반영")
                    L("warn", res["notes"][-1])
                    ch["deferred"] = True
                else:
                    raise RuntimeError(f"{b['name']} {ch['attr']} 변경 실패: {(r.stderr or r.error or '').strip()[:200]}")
        # 끊김 있는 키 — 하위 하나씩
        modes = {b["name"]: ((by.get(b["name"]) or {}).get("bond") or {}).get("mode") for b in plan["bonds"]}
        todo = [m for m in plan["members"] if m["ring"] or m["channels"] or m["features"]]
        for idx, m in enumerate(todo):
            for cmd in member_commands(eth, m):
                ssh.run(cmd, f"{m['name']} 변경", exec_timeout=60)
                applied_any = True
                L("info", f"실행 {cmd}")
            if m["bond"]:
                deadline = time.monotonic() + rejoin
                ok, why = False, ""
                while time.monotonic() < deadline:
                    r = ssh.run(f"cat /proc/net/bonding/{_q(m['bond'])}", "본딩 상태", check=False)
                    ok, why = member_rejoined(r.stdout or "", m["name"], modes.get(m["bond"]))
                    if ok:
                        break
                    time.sleep(2)
                if not ok:
                    raise RuntimeError(f"{m['name']} 가 {rejoin}초 안에 본딩 {m['bond']} 에 다시 들어오지 않음({why})")
                L("info", f"{m['name']} 재합류 — {why}")
            if idx + 1 < len(todo) and member_wait:
                L("info", f"다음 하위 전 대기 {member_wait}초")
                time.sleep(member_wait)
        # 확인 — 새 SSH 세션으로 다시 읽기
        after_ifaces = _collect(ssh, cfg, nic_cfg, "적용 후 다시 읽기") if applied_any else ifaces
        after = {i["name"]: i for i in after_ifaces}
        bad: list[str] = []
        for m in plan["members"]:
            it = after.get(m["name"]) or {}
            for side, (_c, want) in m["ring"].items():
                if (it.get("ring") or {}).get(side) != want:
                    bad.append(f"{m['name']} ring.{side}={(it.get('ring') or {}).get(side)}(기대 {want})")
            if m["channels"] and (it.get("channels") or {}).get("combined") != m["channels"][1]:
                bad.append(f"{m['name']} channels={(it.get('channels') or {}).get('combined')}(기대 {m['channels'][1]})")
            for feat, (_c, want) in m["features"].items():
                if bool(((it.get("features") or {}).get(feat) or {}).get("on")) != want:
                    bad.append(f"{m['name']} {feat}(기대 {'on' if want else 'off'})")
        for b in plan["bonds"]:
            bd = (after.get(b["name"]) or {}).get("bond") or {}
            for ch in b["changes"]:
                if not ch.get("deferred") and str(bd.get(ch["attr"])) != ch["want"]:
                    bad.append(f"{b['name']} {ch['attr']}={bd.get(ch['attr'])}(기대 {ch['want']})")
        if bad:
            raise RuntimeError("다시 읽은 값이 다름: " + ", ".join(bad[:8]))
        if armed:
            ssh.run(f"systemctl stop {ROLLBACK_UNIT}.timer; systemctl reset-failed {ROLLBACK_UNIT}.timer {ROLLBACK_UNIT}.service 2>/dev/null; true",
                    "데드맨 해제")
            armed = False
            L("info", "새 세션으로 확인 — 데드맨 타이머 해제")
        res["after_interfaces"] = after_ifaces
        res["after"] = SN.flatten(after_ifaces, nic_cfg.get("target_mode") or "bond_members", nic_cfg.get("target_glob") or [])["flat"]
        if opts.get("persist", True):
            res["notes"] += _nm(ssh, plan, values, L)
            for n in res["notes"]:
                if "런타임만" in n:
                    L("warn", n)
        else:
            res["notes"].append("영구 기록 끔 — 재부팅하면 원래 값")
        res["interfaces"] = [{"name": m["name"], "changed": member_commands(eth, m), "skipped": m["skipped"]} for m in plan["members"]]
        res["status"] = "ok"
        L("info", "완료")
        log.step(node, node, "done")
    except Exception as exc:  # noqa: BLE001 — 노드 하나의 실패가 실행 전체를 죽이지 않는다
        res["error"] = str(exc)[:500]
        L("error", res["error"])
        try:
            rollback(res["error"][:120])
        except Exception as rexc:  # noqa: BLE001
            L("error", f"원복 중 오류 — 노드 타이머에 맡긴다: {rexc}")
        log.step(node, node, "failed")
    res["duration_ms"] = int((time.monotonic() - t0) * 1000)
    return res


async def run_nic(db: Session, cluster: Cluster, run: ServiceConfigApplyRun, plan: dict[str, Any],
                  opts: dict[str, Any], creds: dict[str, Any], log: Any) -> dict[str, Any]:
    from app.services.nic_watch import service as nic_svc
    from app.services.nic_watch.settings import get_effective
    from app.services.service_config.apply import _finish, _flush, _stop_requested, get_settings

    cfg = get_settings(db)
    nic_cfg = get_effective(db, cluster.id)
    values = dict(plan["values"])
    targets = plan["targets"]
    batch = max(1, min(int(opts.get("batch_size") or 1), 20))
    pause = max(0, min(int(opts.get("pause_sec") or 0), 600))
    log.log("info", f"시작 — NIC {plan['group']['name']} V{plan['version_no']} · 노드 {len(targets)}개 · {batch}대씩"
                    f" · 대기 {pause}초 · 실패 시 {'중단' if opts.get('stop_on_failure', True) else '계속'}"
                    f" · 원복 타이머 {opts.get('rollback_timer_sec') or cfg['nic_rollback_timer_sec']}초"
                    f" · {'NM 영구 기록' if opts.get('persist', True) else '런타임만'}")
    results: list[dict[str, Any]] = []
    loop = asyncio.get_running_loop()
    stopped = False
    for i in range(0, len(targets), batch):
        if _stop_requested(db, run):
            stopped = True
            log.log("warn", "중지 요청 — 남은 노드를 건너뜁니다.")
        failed_before = any(r["status"] == "failed" for r in results)
        if stopped or (failed_before and opts.get("stop_on_failure", True)):
            for t in targets[i:]:
                results.append({"node": t["node"], "host": t["host"], "status": "skipped", "before": {}, "after": {},
                                "error": "중지" if stopped else "앞 노드 실패로 중단", "duration_ms": 0})
            if not stopped:
                log.log("warn", f"앞 배치에서 실패 — 남은 {len(targets) - i}개 노드는 건너뜁니다.")
            break
        chunk = targets[i:i + batch]
        done = await asyncio.gather(*[
            loop.run_in_executor(None, nic_node, t["node"], t["host"], values, cfg, nic_cfg, opts, creds, log)
            for t in chunk
        ])
        for r in done:
            after = r.pop("after_interfaces", None)
            if r["status"] == "ok" and after is not None:  # 화면 현재 값·스냅샷을 바로 갱신(PEP 적용 — 변경 알람 없음)
                try:
                    nic_svc.ingest(db, cluster, r["node"], r["host"], None, None, {"interfaces": after},
                                   source="ssh", snapshot_source="apply")
                except Exception as exc:  # noqa: BLE001
                    db.rollback()
                    log.log("warn", f"[{r['node']}] 현재 값 갱신 실패 — 적용은 유지({exc})")
        results.extend(done)
        _flush(db, run, log, results)
        will_stop = opts.get("stop_on_failure", True) and any(r["status"] == "failed" for r in results)
        if i + batch < len(targets) and pause and not will_stop:
            log.log("info", f"대기 {pause}초 (배치 사이)")
            await asyncio.sleep(pause)
    nic_svc.invalidate(cluster.id)
    return _finish(db, cluster, run, log, results, stopped)
