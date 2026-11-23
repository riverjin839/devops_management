"""Templates — cm_api HostTemplate(apply_host_template) + ClusterTemplate(export / import_cluster_template).

원본: host_templates.py `ApiHostTemplate{name, roleConfigGroupRefs}`, `apply_host_template(host_ids, start_roles)`,
clusters.py `export(export_auto_config)`, cms.py `import_cluster_template(template, add_repositories)`,
types.py `ApiClusterTemplate*`(services/hostTemplates(cardinality)/instantiator{clusterName, hosts(hostNameRange), variables}),
`ApiClusterTemplateConfig{name, value, ref, variable, autoConfig}`.

K8s 매핑
- HostTemplate → NodeProfile: 노드에 입힐 라벨·테인트·역할(DaemonSet 참여 라벨)·OS 파라미터 그룹 묶음.
- ClusterTemplate → 클러스터 청사진: 애드온/네임스페이스/정책/노드 프로파일을 변수화해 내보내고 다른 클러스터에 재현.
"""
from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from typing import Any

VAR_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


@dataclass
class NodeProfile:
    name: str
    labels: dict[str, str] = field(default_factory=dict)
    taints: list[dict] = field(default_factory=list)  # {"key","value","effect"}
    config_groups: list[str] = field(default_factory=list)  # config-model 의 그룹 이름 참조
    owned_label_prefix: str = "profile.pep.io/"  # 이 접두 라벨은 프로파일이 소유 → 제거도 함


@dataclass
class NodeState:
    name: str
    labels: dict[str, str]
    taints: list[dict]


def plan_apply_profile(p: NodeProfile, nodes: list[NodeState]) -> list[dict]:
    """노드별 diff 계획(dry-run). 실제 적용은 command-tracking 의 명령으로 실행한다."""
    plans = []
    tkey = lambda t: (t["key"], t.get("value", ""), t["effect"])  # noqa: E731
    want_taints = {tkey(t) for t in p.taints}
    for n in nodes:
        add = {k: v for k, v in p.labels.items() if n.labels.get(k) != v}
        remove = [k for k in n.labels if k.startswith(p.owned_label_prefix) and k not in p.labels]
        have = {tkey(t) for t in n.taints}
        plans.append({
            "node": n.name,
            "labels_set": add,
            "labels_remove": remove,
            "taints_add": [dict(zip(("key", "value", "effect"), t)) for t in sorted(want_taints - have)],
            "noop": not add and not remove and want_taints <= have,
        })
    return plans


def expand_host_range(pattern: str) -> list[str]:
    """CM hostNameRange 'node[01-03].dc' → node01.dc, node02.dc, node03.dc (0 패딩 유지)."""
    m = re.search(r"\[(\d+)-(\d+)\]", pattern)
    if not m:
        return [pattern]
    a, b = m.group(1), m.group(2)
    width = len(a)
    return [pattern[:m.start()] + str(i).zfill(width) + pattern[m.end():] for i in range(int(a), int(b) + 1)]


@dataclass
class ClusterTemplate:
    """내보낸 청사진. 인스턴스 고유 값은 {{var}} 로 치환돼 있어야 한다."""
    version: str
    resources: list[dict]  # 매니페스트/설정 항목 (임의 구조, 문자열 값에 {{var}} 허용)
    node_profiles: list[dict] = field(default_factory=list)  # {"profile": name, "cardinality": n}
    variables: dict[str, Any] = field(default_factory=dict)  # 기본값(없으면 필수)


def export_template(resources: list[dict], instance_values: dict[str, str], version: str) -> ClusterTemplate:
    """export(): 클러스터 고유 값(이름·도메인·레지스트리 주소 등)을 변수로 역치환."""
    def sub(x):
        if isinstance(x, str):
            for var, val in sorted(instance_values.items(), key=lambda kv: -len(kv[1])):
                if val:
                    x = x.replace(val, "{{%s}}" % var)
            return x
        if isinstance(x, dict):
            return {k: sub(v) for k, v in x.items()}
        if isinstance(x, list):
            return [sub(v) for v in x]
        return x
    return ClusterTemplate(version, sub(resources), variables={k: None for k in instance_values})


def required_variables(t: ClusterTemplate) -> set[str]:
    found: set[str] = set()

    def walk(x):
        if isinstance(x, str):
            found.update(VAR_RE.findall(x))
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(t.resources)
    return found


def instantiate(t: ClusterTemplate, variables: dict[str, Any], hosts: dict[str, list[str]] | None = None):
    """import_cluster_template(): 변수 검증 → 치환 → 프로파일 cardinality 검사. 오류는 모아서 한 번에."""
    vals = {**{k: v for k, v in t.variables.items() if v is not None}, **variables}
    errors = [f"missing variable: {v}" for v in sorted(required_variables(t) - vals.keys())]
    for np in t.node_profiles:
        got = len((hosts or {}).get(np["profile"], []))
        if np.get("cardinality") and got != np["cardinality"]:
            errors.append(f"profile {np['profile']}: cardinality {np['cardinality']} != hosts {got}")
    if errors:
        return None, errors

    def sub(x):
        if isinstance(x, str):
            return VAR_RE.sub(lambda m: str(vals[m.group(1)]), x)
        if isinstance(x, dict):
            return {k: sub(v) for k, v in x.items()}
        if isinstance(x, list):
            return [sub(v) for v in x]
        return x
    return sub(t.resources), []


def match_nodes(patterns: list[str], names: list[str]) -> list[str]:
    return [n for n in names if any(fnmatch.fnmatch(n, p) for p in patterns)]
