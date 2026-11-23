"""Config model — cm_api 의 ApiConfig(view=summary|full), role config group, configStale 패턴.

원본: types.py `ApiConfig`(name/value/required/default/displayName/description/relatedName/
sensitive/validationState/validationMessage), `json_to_config`/`config_to_json`,
services.py `get_config(view)`/`update_config(svc_config, **rt_configs)`(서비스 + 역할 타입별 설정),
role_config_groups.py(그룹 단위 설정), roles.py/services.py `configStale`/`configStalenessStatus`,
examples/bulk_config_update.py.

K8s 매핑: 서비스 = 컴포넌트(kubelet/containerd/apiserver/앱), 역할 타입 = 노드 역할,
role config group = 노드 그룹(라벨/glob), role = 노드 1대(인스턴스 재정의).
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

MASK = "********"


class Validation(str, Enum):
    OK = "OK"
    WARNING = "WARNING"
    ERROR = "ERROR"


class Staleness(str, Enum):
    FRESH = "FRESH"
    STALE_REFRESHABLE = "STALE_REFRESHABLE"  # 재시작 없이 반영 가능(reload/SIGHUP/ConfigMap 재마운트)
    STALE = "STALE"  # 재시작 필요


@dataclass(frozen=True)
class ParamSpec:
    """설정 키 메타데이터 = UI 폼의 원천 (코드 하드코딩 금지 — DB 행으로 두는 것을 권장)."""
    name: str
    display_name: str
    description: str = ""
    default: Any = None
    required: bool = False
    sensitive: bool = False
    restart_required: bool = True  # False 면 STALE_REFRESHABLE
    related_name: str = ""  # 실제 파일/플래그 키 (예: kubelet --max-pods)
    validator: Callable[[Any], tuple[Validation, str]] | None = None


@dataclass
class ConfigValue:
    """full view 한 항목. summary view 는 {name: value} 뿐."""
    spec: ParamSpec
    value: Any
    source: str  # "default" | "service" | "group:<name>" | "instance"
    validation: Validation = Validation.OK
    message: str = ""

    def to_dict(self, reveal_sensitive: bool = False) -> dict:
        v = self.value
        if self.spec.sensitive and not reveal_sensitive and v not in (None, ""):
            v = MASK
        return {"name": self.spec.name, "value": v, "default": self.spec.default, "source": self.source,
                "required": self.spec.required, "sensitive": self.spec.sensitive,
                "displayName": self.spec.display_name, "description": self.spec.description,
                "relatedName": self.spec.related_name, "validationState": self.validation.value,
                "validationMessage": self.message}


@dataclass
class ConfigLayers:
    """기본값 ← 서비스 ← 그룹(처음 일치 하나) ← 인스턴스. None = 해당 층 재정의 없음."""
    service: dict[str, Any] = field(default_factory=dict)
    groups: list[tuple[str, Callable[[str], bool], dict[str, Any]]] = field(default_factory=list)
    instance: dict[str, dict[str, Any]] = field(default_factory=dict)  # instance name -> overrides


def effective(specs: list[ParamSpec], layers: ConfigLayers, instance: str) -> dict[str, ConfigValue]:
    group = next(((n, ov) for n, match, ov in layers.groups if match(instance)), None)
    out: dict[str, ConfigValue] = {}
    for s in specs:
        val, src = s.default, "default"
        if s.name in layers.service:
            val, src = layers.service[s.name], "service"
        if group and s.name in group[1]:
            val, src = group[1][s.name], f"group:{group[0]}"
        inst = layers.instance.get(instance, {})
        if s.name in inst:
            val, src = inst[s.name], "instance"
        cv = ConfigValue(s, val, src)
        if s.required and val in (None, ""):
            cv.validation, cv.message = Validation.ERROR, "required"
        elif s.validator:
            cv.validation, cv.message = s.validator(val)
        out[s.name] = cv
    return out


def view(values: dict[str, ConfigValue], mode: str = "summary", reveal_sensitive: bool = False):
    """summary = 기본값이 아닌(명시 설정된) 키만 {name: value}, full = 전체 메타데이터."""
    if mode == "full":
        return [v.to_dict(reveal_sensitive) for v in values.values()]
    return {k: (MASK if v.spec.sensitive and not reveal_sensitive else v.value)
            for k, v in values.items() if v.source != "default"}


def apply_update(layer: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
    """CM update_config 의미론: 값 None = 재정의 삭제(상위/기본값으로 복귀)."""
    new = dict(layer)
    for k, v in update.items():
        if v is None:
            new.pop(k, None)
        else:
            new[k] = v
    return new


def to_api_list(d: dict[str, Any]) -> dict:
    return {"items": [{"name": k, "value": v} for k, v in d.items()]}


def fingerprint(values: dict[str, ConfigValue]) -> str:
    payload = {k: v.value for k, v in sorted(values.items())}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:16]


def staleness(desired: dict[str, ConfigValue], applied: dict[str, Any]) -> tuple[Staleness, list[dict]]:
    """원하는 값(DB) vs 노드/파드에서 관측한 적용 값. 차이가 재시작 필요 키를 포함하면 STALE."""
    diffs = []
    for k, cv in desired.items():
        if k in applied and applied[k] != cv.value:
            diffs.append({"name": k, "desired": cv.value, "applied": applied[k],
                          "restart_required": cv.spec.restart_required})
    if not diffs:
        return Staleness.FRESH, []
    if any(d["restart_required"] for d in diffs):
        return Staleness.STALE, diffs
    return Staleness.STALE_REFRESHABLE, diffs
