from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.app_setting import AppSetting
from app.services.assignee_accounts import sync_assignee_accounts
from app.schemas.ui_settings import (
    UiSettingsResponse,
    UiSettingsUpdate,
    ClusterLinksResponse,
    ClusterLinksUpdate,
    ClusterLinksPayload,
    OperationLevelsResponse,
    OperationLevelsUpdate,
    OperationLevelItem,
)

router = APIRouter(prefix="/ui-settings", tags=["ui-settings"])

UI_SETTINGS_KEY = "ui_settings"
CLUSTER_LINKS_KEY = "cluster_links"
ASSIGNEES_KEY = "assignees"
OPERATION_LEVELS_KEY = "operation_levels"
DEFAULT_ASSIGNEES = []
DEFAULT_OPERATION_LEVELS = {
    "levels": [
        {"value": "production", "label": "운영 (Production)", "color": "red",    "icon": "🚀"},
        {"value": "staging",    "label": "스테이징 (Staging)", "color": "amber",  "icon": "✨"},
        {"value": "dev",        "label": "개발 (Dev)",         "color": "blue",   "icon": "💻"},
        {"value": "test",       "label": "테스트 (Test)",      "color": "slate",  "icon": "🧪"},
        {"value": "dr",         "label": "DR",                 "color": "purple", "icon": "🛡️"},
    ]
}


DEFAULT_UI_SETTINGS = {
    "app_title": "DEVOPS MANAGEMENT",
    "nav_labels": {},
}

# Old default values that should auto-migrate to the current default. If a row's
# value matches one of these (i.e., user never customized the title), the GET
# endpoint substitutes the new default instead of returning the stale brand.
LEGACY_APP_TITLES = {"K8s Daily Monitor"}

DEFAULT_CLUSTER_LINKS = {
    "common_links": [],
    "cluster_groups": [],
}


def _get_or_create(db: Session, key: str, default_value: dict):
    setting = db.query(AppSetting).filter(AppSetting.key == key).first()
    if setting:
        return setting

    setting = AppSetting(key=key, value=default_value)
    db.add(setting)
    db.commit()
    db.refresh(setting)
    return setting


@router.get("", response_model=UiSettingsResponse)
def get_ui_settings(db: Session = Depends(get_db)):
    setting = _get_or_create(db, UI_SETTINGS_KEY, DEFAULT_UI_SETTINGS)
    value = setting.value or {}
    stored_title = value.get("app_title", DEFAULT_UI_SETTINGS["app_title"])
    # Auto-rebrand: if the row still holds a legacy default (user never set
    # a custom title), persist the new default so the UI reflects it
    # consistently across reloads.
    if stored_title in LEGACY_APP_TITLES:
        stored_title = DEFAULT_UI_SETTINGS["app_title"]
        setting.value = {**(setting.value or {}), "app_title": stored_title}
        db.commit()
    return UiSettingsResponse(
        app_title=stored_title,
        nav_labels=value.get("nav_labels", {}),
        service_catalog=value.get("service_catalog"),
    )


@router.put("", response_model=UiSettingsResponse)
def update_ui_settings(payload: UiSettingsUpdate, db: Session = Depends(get_db)):
    setting = _get_or_create(db, UI_SETTINGS_KEY, DEFAULT_UI_SETTINGS)
    current = setting.value or DEFAULT_UI_SETTINGS.copy()

    next_value: dict = {
        "app_title": payload.app_title if payload.app_title is not None else current.get("app_title", DEFAULT_UI_SETTINGS["app_title"]),
        "nav_labels": payload.nav_labels if payload.nav_labels is not None else current.get("nav_labels", {}),
    }
    if payload.service_catalog is not None:
        # 빈 슬러그 배제 + slug 기준 dedupe (먼저 들어온 항목 우선)
        seen: set[str] = set()
        cleaned: list[dict] = []
        for it in payload.service_catalog:
            slug = it.slug.strip()
            if not slug or slug in seen:
                continue
            seen.add(slug)
            cleaned.append(it.model_dump(exclude_none=False))
        next_value["service_catalog"] = cleaned
    elif "service_catalog" in current:
        next_value["service_catalog"] = current["service_catalog"]

    setting.value = next_value
    db.commit()
    db.refresh(setting)

    return UiSettingsResponse(
        app_title=next_value["app_title"],
        nav_labels=next_value["nav_labels"],
        service_catalog=next_value.get("service_catalog"),
    )


@router.get("/cluster-links", response_model=ClusterLinksResponse)
def get_cluster_links(db: Session = Depends(get_db)):
    setting = _get_or_create(db, CLUSTER_LINKS_KEY, DEFAULT_CLUSTER_LINKS)
    value = setting.value or DEFAULT_CLUSTER_LINKS
    payload = ClusterLinksPayload(
        common_links=value.get("common_links", []),
        cluster_groups=value.get("cluster_groups", []),
    )
    return ClusterLinksResponse(data=payload)


@router.put("/cluster-links", response_model=ClusterLinksResponse)
def update_cluster_links(payload: ClusterLinksUpdate, db: Session = Depends(get_db)):
    setting = _get_or_create(db, CLUSTER_LINKS_KEY, DEFAULT_CLUSTER_LINKS)
    next_value = {
        "common_links": [item.model_dump() for item in payload.common_links],
        "cluster_groups": [group.model_dump() for group in payload.cluster_groups],
    }
    setting.value = next_value
    db.commit()
    db.refresh(setting)

    return ClusterLinksResponse(data=ClusterLinksPayload(**next_value))


def _normalize_assignee(a) -> dict | None:
    """Normalize an assignee entry: accepts both plain string (legacy) and object."""
    if isinstance(a, str):
        name = a.strip()
        return {"name": name} if name else None
    if isinstance(a, dict):
        name = str(a.get("name", "")).strip()
        return {
            "name": name,
            "employeeId": a.get("employeeId") or a.get("employee_id"),
            "email": a.get("email"),
            "ip": a.get("ip"),
            "primaryRole": a.get("primaryRole") or a.get("primary_role"),
            "secondaryRole": a.get("secondaryRole") or a.get("secondary_role"),
        } if name else None
    return None


@router.get("/assignees")
def get_assignees(db: Session = Depends(get_db)):
    setting = _get_or_create(db, ASSIGNEES_KEY, DEFAULT_ASSIGNEES)
    value = setting.value
    if isinstance(value, list):
        # Normalize legacy plain strings to Assignee objects
        normalized = [n for a in value if (n := _normalize_assignee(a)) is not None]
        return {"data": normalized}
    return {"data": []}


@router.put("/assignees")
def update_assignees(payload: dict, db: Session = Depends(get_db)):
    assignees = payload.get("assignees", [])
    if not isinstance(assignees, list):
        assignees = []
    # Normalize and deduplicate by name
    seen: set[str] = set()
    cleaned = []
    for raw in assignees:
        entry = _normalize_assignee(raw)
        if entry and entry["name"] not in seen:
            seen.add(entry["name"])
            cleaned.append(entry)
    setting = _get_or_create(db, ASSIGNEES_KEY, DEFAULT_ASSIGNEES)
    setting.value = cleaned
    db.commit()
    db.refresh(setting)
    # 사번이 있는 담당자는 자동으로 operator 로그인 계정을 부여 (초기 비번 = 사번).
    # 계정 생성 실패가 담당자 저장 자체를 막지 않도록 방어적으로 감싼다.
    try:
        accounts = sync_assignee_accounts(db, cleaned)
    except Exception:  # noqa: BLE001
        accounts = {"created": [], "skipped_existing": [], "skipped_no_employee_id": [], "errors": []}
    return {"data": cleaned, "accounts": accounts}


# ── 운영레벨 (사용자 정의) ──────────────────────────────────────────────

@router.get("/operation-levels", response_model=OperationLevelsResponse)
def get_operation_levels(db: Session = Depends(get_db)):
    setting = _get_or_create(db, OPERATION_LEVELS_KEY, DEFAULT_OPERATION_LEVELS)
    raw_levels = (setting.value or {}).get("levels", [])
    items: list[OperationLevelItem] = []
    seen: set[str] = set()
    for it in raw_levels:
        if not isinstance(it, dict):
            continue
        v = str(it.get("value", "")).strip()
        if not v or v in seen:
            continue
        seen.add(v)
        icon_raw = it.get("icon")
        items.append(OperationLevelItem(
            value=v,
            label=str(it.get("label", v)),
            color=str(it.get("color", "slate")),
            icon=str(icon_raw) if isinstance(icon_raw, str) and icon_raw.strip() else None,
        ))
    if not items:
        items = [OperationLevelItem(**x) for x in DEFAULT_OPERATION_LEVELS["levels"]]
    return OperationLevelsResponse(levels=items)


@router.put("/operation-levels", response_model=OperationLevelsResponse)
def update_operation_levels(payload: OperationLevelsUpdate, db: Session = Depends(get_db)):
    setting = _get_or_create(db, OPERATION_LEVELS_KEY, DEFAULT_OPERATION_LEVELS)
    seen: set[str] = set()
    cleaned: list[dict] = []
    for it in payload.levels:
        v = it.value.strip()
        if not v or v in seen:
            continue
        seen.add(v)
        icon = (it.icon or "").strip() or None
        cleaned.append({"value": v, "label": it.label.strip() or v, "color": it.color or "slate", "icon": icon})
    setting.value = {"levels": cleaned}
    db.commit()
    db.refresh(setting)
    return OperationLevelsResponse(levels=[OperationLevelItem(**x) for x in cleaned])
