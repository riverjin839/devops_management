"""서비스 구성 — 수집 스냅샷에서 노드별 '현재 값'을 뽑는 순수 함수들(DB 없음, 단위 테스트 대상).

입력은 서비스와 관련된 ``cluster_config_snapshots`` 의 컴포넌트별 **최신** 스냅샷(``SnapLike``)과 설정 항목 목록이다.
출력은 ``{"values": {key: {node: value}}, "sources": [...]}`` — 같은 키라도 노드마다 값이 다를 수 있어 노드별로 둔다.

출처(서비스별):
- etcd       : ``etcd``(K8S API 정적 파드 플래그 ``data.flags``) · ``etcd_systemd:{host}``(env 파일 ``env_content`` + ExecStart 플래그)
- containerd : ``containerd_config:{host}`` (``data.flat`` — 수집 때 TOML 을 평탄화해 둔 값)
- cilium     : ``cilium_config`` (``data.data`` — ConfigMap, 클러스터 하나의 값)
- linux      : ``node_params:{node}``(노드 에이전트 ``data.runtime``) 우선, 없으면 ``kernel_params:{host}``(SSH ``data.params``)
"""
from __future__ import annotations

import json
import re
import shlex
from datetime import datetime
from typing import Any, Iterable, Optional, Protocol


class SnapLike(Protocol):
    component: str
    data: Any
    collected_at: Optional[datetime]


class ItemLike(Protocol):
    key: str
    source_keys: Any


# 서비스별로 읽어야 할 스냅샷 컴포넌트 — 정확히 같은 이름(exact) 또는 접두어(prefix).
SERVICE_COMPONENTS: dict[str, dict[str, tuple[str, ...]]] = {
    "etcd": {"exact": ("etcd",), "prefix": ("etcd_systemd:",)},
    "containerd": {"exact": (), "prefix": ("containerd_config:",)},
    "cilium": {"exact": ("cilium_config",), "prefix": ()},
    "linux": {"exact": (), "prefix": ("node_params:", "kernel_params:")},
}

CLUSTER_NODE = "(클러스터)"  # 노드 구분 없이 클러스터에 하나뿐인 값(cilium-config)


def wants_component(service: str, component: str) -> bool:
    spec = SERVICE_COMPONENTS.get(service) or {}
    return component in spec.get("exact", ()) or any(component.startswith(p) for p in spec.get("prefix", ()))


def norm(value: Any) -> Optional[str]:
    """비교·표시용 문자열 — 공백 정규화, bool 은 소문자, 목록·표는 JSON."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return " ".join(str(value).split())


# ── 파서 ─────────────────────────────────────────────────────────────────────

def parse_env_text(text: Optional[str]) -> dict[str, str]:
    """``KEY=value`` env 파일 → dict. ``export`` 접두어·따옴표·주석을 처리한다."""
    out: dict[str, str] = {}
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def parse_cli_flags(cmdline: Optional[str]) -> dict[str, str]:
    """``--flag=value`` / ``--flag value`` / ``--flag``(=true) → dict."""
    try:
        tokens = shlex.split(cmdline or "")
    except ValueError:
        tokens = (cmdline or "").split()
    out: dict[str, str] = {}
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok.startswith("--") and len(tok) > 2:
            if "=" in tok:
                k, v = tok[2:].split("=", 1)
                out[k] = v
            elif i + 1 < len(tokens) and not tokens[i + 1].startswith("-"):
                out[tok[2:]] = tokens[i + 1]
                i += 1
            else:
                out[tok[2:]] = "true"
        i += 1
    return out


_BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")


def _seg(key: str) -> str:
    return key if _BARE_KEY.match(key) else json.dumps(key)


def flatten_toml(obj: Any, prefix: str = "") -> dict[str, str]:
    """TOML(dict) → ``a.b."c.d".e`` 형식의 평탄화 키 → 문자열 값. 점이 든 키는 TOML 처럼 따옴표로 감싼다."""
    out: dict[str, str] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            path = f"{prefix}.{_seg(str(k))}" if prefix else _seg(str(k))
            if isinstance(v, dict):
                out.update(flatten_toml(v, path))
            else:
                out[path] = norm(v) or ""
    return out


def parse_containerd_toml(text: str) -> dict[str, str]:
    import tomllib

    return flatten_toml(tomllib.loads(text))


# ── 서비스별 현재 값 ─────────────────────────────────────────────────────────

def _src(component: str, node: str, source: str, snap: SnapLike) -> dict[str, Any]:
    return {
        "component": component, "node": node, "source": source,
        "collected_at": snap.collected_at.isoformat() if snap.collected_at else None,
    }


def current_values(service: str, snaps: Iterable[SnapLike], items: Iterable[ItemLike]) -> dict[str, Any]:
    items = list(items)
    snaps = [s for s in snaps if wants_component(service, s.component)]
    values: dict[str, dict[str, str]] = {it.key: {} for it in items}
    sources: list[dict[str, Any]] = []

    def put(key: str, node: str, raw: Any) -> None:
        v = norm(raw)
        if v is not None:
            values.setdefault(key, {})[node] = v

    if service == "etcd":
        for s in snaps:
            data = s.data or {}
            if s.component == "etcd":
                node = str(data.get("podName") or "etcd")
                node = node[5:] if node.startswith("etcd-") else node
                flags = data.get("flags") or {}
                env: dict[str, str] = {}
                sources.append(_src(s.component, node, "K8S API · 정적 파드 플래그", s))
            else:
                node = s.component.split(":", 1)[1]
                flags = parse_cli_flags(data.get("exec_start") or data.get("ps_cmdline"))
                env = parse_env_text(data.get("env_content"))
                sources.append(_src(s.component, node, f"SSH · systemd env {data.get('env_file') or ''}".strip(), s))
            for it in items:
                sk = it.source_keys or {}
                if sk.get("flag") in flags:
                    put(it.key, node, flags[sk["flag"]])
                elif sk.get("env") in env:
                    put(it.key, node, env[sk["env"]])

    elif service == "containerd":
        for s in snaps:
            node = s.component.split(":", 1)[1]
            flat = (s.data or {}).get("flat") or {}
            sources.append(_src(s.component, node, f"SSH · {(s.data or {}).get('source_label') or 'containerd config'}", s))
            for it in items:
                for path in (it.source_keys or {}).get("paths") or []:
                    if path in flat:
                        put(it.key, node, flat[path])
                        break

    elif service == "cilium":
        for s in snaps:
            cm = (s.data or {}).get("data") or {}
            sources.append(_src(s.component, CLUSTER_NODE, "K8S API · kube-system/cilium-config", s))
            for it in items:
                k = (it.source_keys or {}).get("key") or it.key
                if k in cm:
                    put(it.key, CLUSTER_NODE, cm[k])

    elif service == "linux":
        agent = [s for s in snaps if s.component.startswith("node_params:")]
        chosen = agent or [s for s in snaps if s.component.startswith("kernel_params:")]
        for s in chosen:
            node = s.component.split(":", 1)[1]
            is_agent = s.component.startswith("node_params:")
            params = ((s.data or {}).get("runtime") if is_agent else (s.data or {}).get("params")) or {}
            sources.append(_src(s.component, node, "노드 에이전트" if is_agent else "SSH 수집(sysctl)", s))
            for it in items:
                k = (it.source_keys or {}).get("key") or it.key
                if k in params:
                    put(it.key, node, params[k])

    return {"values": values, "sources": sources}


def summarize(node_values: dict[str, str]) -> dict[str, Any]:
    """노드별 값 → 화면 요약. ``groups`` 는 값별 노드 목록(많은 값 먼저)."""
    groups: dict[str, list[str]] = {}
    for node, v in sorted(node_values.items()):
        groups.setdefault(v, []).append(node)
    ordered = sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    return {
        "uniform": len(ordered) <= 1,
        "value": ordered[0][0] if ordered else None,
        "groups": [{"value": v, "nodes": nodes} for v, nodes in ordered],
        "node_count": len(node_values),
    }


def item_status(version_value: Optional[str], summary: dict[str, Any]) -> str:
    """unknown(값 없음) · mixed(노드마다 다름) · differs(버전 값과 다름) · same."""
    if not summary["groups"]:
        return "unknown"
    if not summary["uniform"]:
        return "mixed"
    if version_value is not None and norm(version_value) != summary["value"]:
        return "differs"
    return "same"
