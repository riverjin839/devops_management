"""viewer 대상 클러스터 네트워크 정보 숨김 정책.

`/clusters` 목록·상세 응답에는 내부 IP·CIDR·MAC·호스트명·API 엔드포인트 같은 망 구성 정보가
그대로 실린다. 클러스터 단위 격리(테넌트 바인딩, ``services/cluster_access.py``)는 "어느
클러스터를 볼 수 있나"만 정하므로, 볼 수 있는 클러스터의 **필드 단위** 노출은 이 정책이 맡는다.

- 설정: ``AppSetting`` key ``cluster_viewer_network_mask`` = ``{"enabled": bool}``.
  기본값 off — 기존 설치의 viewer 화면이 바뀌지 않는다(UI-First: Settings → 접근 제어에서 켠다).
- 대상: admin·operator 를 제외한 역할(viewer 및 알 수 없는 역할). 실행·변경 권한이 있는
  역할은 원래 이 정보를 써서 작업하므로 가리지 않는다.
- 범위: ``/clusters`` 라우터 응답(목록·상세·Cilium 설정). 인프라 노드·토폴로지 등 다른 화면의
  IP 는 각 화면의 접근 제어(Settings → 접근 제어 → 화면별 노출)로 막는다.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models.app_setting import AppSetting
from app.models.user import User

CLUSTER_VIEWER_MASK_KEY = "cluster_viewer_network_mask"
DEFAULT_CLUSTER_VIEWER_MASK: dict[str, Any] = {"enabled": False}

# 이 역할은 가리지 않는다 — 나머지(viewer, 알 수 없는 역할)는 정책이 켜지면 가린다(fail-closed).
_UNMASKED_ROLES = frozenset({"admin", "operator"})

# 응답에서 비우는 망 구성 필드. api_endpoint 는 필수 문자열이라 "" 로, 나머지는 None 으로 비운다.
NETWORK_FIELDS: tuple[str, ...] = (
    "kubeconfig_path",
    "cilium_config",
    "cidr",
    "internal_ips",
    "first_host",
    "last_host",
    "pod_cidr",
    "pod_first_host",
    "pod_last_host",
    "svc_cidr",
    "svc_first_host",
    "svc_last_host",
    "bond0_ip",
    "bond0_mac",
    "bond1_ip",
    "bond1_mac",
    "hostname",
    "as_number",
    "node_ips",
    "prometheus_url",
    "alertmanager_url",
)


def normalize_mask_setting(raw: Any) -> dict[str, Any]:
    enabled = raw.get("enabled") if isinstance(raw, dict) else None
    return {"enabled": enabled if isinstance(enabled, bool) else DEFAULT_CLUSTER_VIEWER_MASK["enabled"]}


def get_mask_setting(db: Session) -> dict[str, Any]:
    """조회 실패(테이블 드리프트 등)는 기본값(off)으로 — 목록 조회 자체를 막지 않는다."""
    try:
        row = db.query(AppSetting).filter(AppSetting.key == CLUSTER_VIEWER_MASK_KEY).first()
    except Exception:  # noqa: BLE001 — fail-safe
        db.rollback()
        return dict(DEFAULT_CLUSTER_VIEWER_MASK)
    return normalize_mask_setting(row.value if row else None)


def should_mask(db: Session, user: User | None) -> bool:
    if user is None or user.role in _UNMASKED_ROLES:
        return False
    return bool(get_mask_setting(db)["enabled"])


def mask_cluster(cluster) -> dict[str, Any]:
    """ORM ``Cluster`` 또는 ``ClusterResponse`` → 망 구성 필드를 비운 응답 dict.

    ``network_masked=True`` 를 붙여 화면이 빈 값 대신 "숨김" 을 표시하게 한다.
    """
    from app.schemas.cluster import ClusterResponse

    data = ClusterResponse.model_validate(cluster).model_dump()
    for f in NETWORK_FIELDS:
        if f in data:
            data[f] = None
    data["api_endpoint"] = ""
    data["network_masked"] = True
    return data
