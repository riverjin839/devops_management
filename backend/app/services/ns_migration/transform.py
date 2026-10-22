"""NS 마이그레이션 순수 변환 — 지원 종류 카탈로그, 정리(sanitize), 제외 판정, 치환 규칙, 마스킹, diff.

클러스터 호출이 없어 단위 테스트로 전부 검증한다(tests/test_ns_migration_transform.py).
"""
from __future__ import annotations

import copy
import difflib
from typing import Any, Optional

import yaml

# 적용 순서 = 카탈로그 순서. 참조 대상(NS·SA·RBAC·설정)이 먼저, 워크로드·노출이 나중.
KIND_CATALOG: list[dict[str, Any]] = [
    {"kind": "ResourceQuota", "api_version": "v1", "group": "base", "label": "ResourceQuota"},
    {"kind": "LimitRange", "api_version": "v1", "group": "base", "label": "LimitRange"},
    {"kind": "ServiceAccount", "api_version": "v1", "group": "base", "label": "ServiceAccount"},
    {"kind": "Role", "api_version": "rbac.authorization.k8s.io/v1", "group": "base", "label": "Role"},
    {"kind": "RoleBinding", "api_version": "rbac.authorization.k8s.io/v1", "group": "base", "label": "RoleBinding"},
    {"kind": "ConfigMap", "api_version": "v1", "group": "base", "label": "ConfigMap"},
    {"kind": "Secret", "api_version": "v1", "group": "secret", "label": "Secret"},
    {"kind": "PersistentVolumeClaim", "api_version": "v1", "group": "workload", "label": "PVC (정의만)"},
    {"kind": "Service", "api_version": "v1", "group": "workload", "label": "Service"},
    {"kind": "Deployment", "api_version": "apps/v1", "group": "workload", "label": "Deployment"},
    {"kind": "StatefulSet", "api_version": "apps/v1", "group": "workload", "label": "StatefulSet"},
    {"kind": "DaemonSet", "api_version": "apps/v1", "group": "workload", "label": "DaemonSet"},
    {"kind": "CronJob", "api_version": "batch/v1", "group": "workload", "label": "CronJob"},
    {"kind": "Ingress", "api_version": "networking.k8s.io/v1", "group": "workload", "label": "Ingress"},
    {"kind": "HorizontalPodAutoscaler", "api_version": "autoscaling/v2", "group": "workload", "label": "HPA"},
    {"kind": "PodDisruptionBudget", "api_version": "policy/v1", "group": "workload", "label": "PDB"},
    {"kind": "NetworkPolicy", "api_version": "networking.k8s.io/v1", "group": "workload", "label": "NetworkPolicy"},
]
KIND_ORDER = {k["kind"]: i for i, k in enumerate(KIND_CATALOG)}
KIND_BY_NAME = {k["kind"]: k for k in KIND_CATALOG}
DEFAULT_KINDS = [k["kind"] for k in KIND_CATALOG if k["group"] == "base"]
RULE_TYPES = ("image_registry", "string", "replicas", "label")

_ALWAYS_SKIP_SECRET_TYPES = {"kubernetes.io/service-account-token", "helm.sh/release.v1"}
_META_DROP = ("uid", "resourceVersion", "creationTimestamp", "generation", "managedFields", "selfLink",
              "ownerReferences", "deletionTimestamp", "deletionGracePeriodSeconds", "finalizers")
_ANNOTATION_DROP_PREFIXES = (
    "kubectl.kubernetes.io/last-applied-configuration", "deployment.kubernetes.io/",
    "pv.kubernetes.io/", "volume.beta.kubernetes.io/", "volume.kubernetes.io/",
    "control-plane.alpha.kubernetes.io/", "meta.helm.sh/",
)
_LABEL_DROP = ("pod-template-hash", "controller-uid", "batch.kubernetes.io/controller-uid",
               "controller-revision-hash", "statefulset.kubernetes.io/pod-name")
MASK = "********"


def normalize_kinds(kinds: Optional[list[str]], include_secrets: bool) -> list[str]:
    """선택 종류를 카탈로그 순서로 정렬. Secret 은 include_secrets 일 때만 남긴다."""
    picked = set(kinds or DEFAULT_KINDS)
    if include_secrets:
        picked.add("Secret")
    else:
        picked.discard("Secret")
    return [k["kind"] for k in KIND_CATALOG if k["kind"] in picked]


def skip_reason(obj: dict, kind: str) -> Optional[str]:
    """옮기지 않을 객체면 사유, 옮길 객체면 None."""
    meta = obj.get("metadata") or {}
    name = meta.get("name") or ""
    if meta.get("ownerReferences"):
        owner = meta["ownerReferences"][0]
        return f"{owner.get('kind')}/{owner.get('name')} 가 관리하는 객체(컨트롤러만 옮김)"
    if kind == "ServiceAccount" and name == "default":
        return "기본 ServiceAccount(타깃 NS 생성 시 자동 생성)"
    if kind == "ConfigMap" and name == "kube-root-ca.crt":
        return "클러스터 CA ConfigMap(자동 생성)"
    if kind == "Secret" and obj.get("type") in _ALWAYS_SKIP_SECRET_TYPES:
        return f"자동 관리 Secret({obj.get('type')})"
    return None


def _clean_map(m: Optional[dict], drop_prefixes: tuple[str, ...]) -> Optional[dict]:
    if not m:
        return None
    out = {k: v for k, v in m.items() if not any(k == p or k.startswith(p) for p in drop_prefixes)}
    return out or None


def _clean_meta(meta: dict) -> dict:
    out = {k: v for k, v in meta.items() if k not in _META_DROP}
    for key, drops in (("annotations", _ANNOTATION_DROP_PREFIXES), ("labels", _LABEL_DROP)):
        cleaned = _clean_map(out.get(key), drops)
        if cleaned is None:
            out.pop(key, None)
        else:
            out[key] = cleaned
    return out


def sanitize(obj: dict, kind: str, *, keep_node_ports: bool = False) -> dict:
    """소스 클러스터 고유값(uid·status·할당 IP·바인딩된 PV 등)을 제거해 다른 클러스터에 적용 가능한 형태로."""
    spec = KIND_BY_NAME.get(kind) or {}
    out = copy.deepcopy(obj)
    out["apiVersion"] = out.get("apiVersion") or spec.get("api_version")
    out["kind"] = kind
    out.pop("status", None)
    out["metadata"] = _clean_meta(out.get("metadata") or {})
    s = out.get("spec")
    if kind == "Service" and isinstance(s, dict):
        if s.get("clusterIP") not in ("None",):
            s.pop("clusterIP", None)
            s.pop("clusterIPs", None)
        s.pop("healthCheckNodePort", None)
        if not keep_node_ports:
            for p in s.get("ports") or []:
                p.pop("nodePort", None)
    elif kind == "PersistentVolumeClaim" and isinstance(s, dict):
        s.pop("volumeName", None)
    elif kind == "Namespace":
        out.pop("spec", None)
    for tmpl in _pod_templates(out):
        tmeta = tmpl.get("metadata")
        if isinstance(tmeta, dict):
            tmpl["metadata"] = _clean_meta(tmeta)
            tmpl["metadata"].pop("creationTimestamp", None)
    return out


def _pod_templates(obj: dict) -> list[dict]:
    spec = obj.get("spec") or {}
    out = []
    if isinstance(spec.get("template"), dict):
        out.append(spec["template"])
    job_tmpl = ((spec.get("jobTemplate") or {}).get("spec") or {}).get("template")
    if isinstance(job_tmpl, dict):
        out.append(job_tmpl)
    return out


def _pod_specs(obj: dict) -> list[dict]:
    return [t["spec"] for t in _pod_templates(obj) if isinstance(t.get("spec"), dict)]


def _replace_strings(node: Any, old: str, new: str) -> Any:
    if isinstance(node, str):
        return node.replace(old, new)
    if isinstance(node, list):
        return [_replace_strings(v, old, new) for v in node]
    if isinstance(node, dict):
        return {k: _replace_strings(v, old, new) for k, v in node.items()}
    return node


def _rule_matches(rule: dict, obj: dict) -> bool:
    if rule.get("kind") and rule["kind"] != obj.get("kind"):
        return False
    if rule.get("name") and rule["name"] != (obj.get("metadata") or {}).get("name"):
        return False
    return True


def apply_rules(obj: dict, rules: list[dict], source_ns: str, target_ns: str) -> tuple[dict, list[str]]:
    """NS 이름 변경 + 사용자 치환 규칙 적용. (변환 결과, 적용된 규칙 설명 목록)."""
    out = copy.deepcopy(obj)
    notes: list[str] = []
    kind = out.get("kind")
    meta = out.setdefault("metadata", {})
    if kind == "Namespace":
        meta["name"] = target_ns
        if (meta.get("labels") or {}).get("kubernetes.io/metadata.name"):
            meta["labels"]["kubernetes.io/metadata.name"] = target_ns
    else:
        meta["namespace"] = target_ns
    if source_ns != target_ns:
        if kind == "RoleBinding":
            for subj in out.get("subjects") or []:
                if subj.get("namespace") == source_ns:
                    subj["namespace"] = target_ns
        # 클러스터 내부 DNS 참조(svc.<ns>.svc…) 를 새 NS 로.
        if kind != "Secret":
            before = out
            out = _replace_strings(out, f".{source_ns}.svc", f".{target_ns}.svc")
            if out != before:
                notes.append(f"내부 DNS .{source_ns}.svc → .{target_ns}.svc")
    for rule in rules or []:
        rtype, frm, to = rule.get("type"), str(rule.get("from") or ""), str(rule.get("to") or "")
        if not _rule_matches(rule, out):
            continue
        if rtype == "image_registry" and frm:
            hit = 0
            for ps in _pod_specs(out):
                for c in (ps.get("containers") or []) + (ps.get("initContainers") or []):
                    img = c.get("image") or ""
                    if img.startswith(frm):
                        c["image"] = to + img[len(frm):]
                        hit += 1
            if hit:
                notes.append(f"이미지 레지스트리 {frm} → {to} ({hit}개)")
        elif rtype == "string" and frm:
            # Secret 의 data 는 base64 라 문자열 치환 대상에서 제외(stringData 없음).
            target = {k: v for k, v in out.items() if not (kind == "Secret" and k == "data")}
            replaced = _replace_strings(target, frm, to)
            if replaced != target:
                out.update(replaced)
                notes.append(f"문자열 '{frm}' → '{to}'")
        elif rtype == "replicas" and kind in ("Deployment", "StatefulSet") and to.strip():
            try:
                n = int(to)
            except ValueError:
                continue
            spec = out.setdefault("spec", {})
            if spec.get("replicas") != n:
                spec["replicas"] = n
                notes.append(f"replicas → {n}")
        elif rtype == "label" and frm:
            meta = out.setdefault("metadata", {})
            meta.setdefault("labels", {})[frm] = to
            notes.append(f"라벨 {frm}={to}")
    return out, notes


def mask_secret(obj: dict) -> dict:
    """미리보기·로그·실행 기록용 — Secret 값을 가린다(키 이름은 남김)."""
    if obj.get("kind") != "Secret":
        return obj
    out = copy.deepcopy(obj)
    for field in ("data", "stringData"):
        if isinstance(out.get(field), dict):
            out[field] = {k: MASK for k in out[field]}
    return out


def project(actual: Any, desired: Any) -> Any:
    """actual 을 desired 의 키 구조로 투영 — 서버 기본값 필드가 diff 잡음이 되지 않게."""
    if isinstance(desired, dict) and isinstance(actual, dict):
        return {k: project(actual[k], v) for k, v in desired.items() if k in actual}
    if isinstance(desired, list) and isinstance(actual, list):
        return [project(a, d) for a, d in zip(actual, desired)] + actual[len(desired):]
    return actual


def to_yaml(obj: dict) -> str:
    return yaml.safe_dump(obj, sort_keys=False, allow_unicode=True, default_flow_style=False)


def diff(current: Optional[dict], desired: dict, *, limit: int = 20000) -> tuple[str, str]:
    """(action, unified diff). action = create | update | unchanged. Secret 은 마스킹 후 비교 표시."""
    if current is None:
        return "create", ""
    cur = project(sanitize(current, desired.get("kind") or "", keep_node_ports=True), desired)
    if cur == desired:
        return "unchanged", ""
    if desired.get("kind") == "Secret":
        # 값이 바뀌었는지만 알리고 내용은 키 단위로만 노출.
        cur, desired = _secret_diff_view(cur, desired, mark=False), _secret_diff_view(desired, cur, mark=True)
    text = "".join(difflib.unified_diff(
        to_yaml(cur).splitlines(keepends=True), to_yaml(desired).splitlines(keepends=True),
        fromfile="target(현재)", tofile="source(적용 예정)"))
    return "update", text[:limit]


def _secret_diff_view(obj: dict, other: dict, *, mark: bool) -> dict:
    """값은 가리고, 적용 예정 쪽(mark)에만 바뀐 키를 '(변경)' 으로 표시해 diff 에 드러나게 한다."""
    out = copy.deepcopy(obj)
    for field in ("data", "stringData"):
        mine, theirs = out.get(field), other.get(field) or {}
        if isinstance(mine, dict):
            out[field] = {k: (f"{MASK} (변경)" if mark and k in theirs and theirs[k] != v else MASK)
                          for k, v in mine.items()}
    return out


def bundle_yaml(objs: list[dict], header: str = "") -> str:
    """다중 문서 YAML — 적용 순서대로."""
    docs = [to_yaml(o).rstrip() for o in objs]
    return (header + "\n" if header else "") + "\n---\n".join(docs) + "\n"
