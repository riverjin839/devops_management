import re
from collections import Counter

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.user import User
from app.auth.deps import get_current_user, require_admin
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
FEATURE_ACCESS_KEY = "feature_access"
DEFAULT_FEATURE_ACCESS: dict = {}
OPERATION_LEVELS_KEY = "operation_levels"
WORK_ITEM_BOARD_SETTINGS_KEY = "work_item_board_settings"
BOARD_VIEW_KEYS = ("epic", "table", "calendar", "kanban")
BOARD_BADGE_KEYS = ("total", "wip", "done", "overdue")
# 업무 관리 게시판 공통(전 사용자 공유) 설정 — admin 전용 편집. 기본값은 에픽뷰·목록만
# 노출하고 달력·칸반은 숨김, 헤더 배지(전체/WIP/Done/지연) 4개는 전부 숨김으로 시작한다.
DEFAULT_WORK_ITEM_BOARD_SETTINGS = {
    "view_visibility": {"epic": True, "table": True, "calendar": False, "kanban": False},
    "default_view": "epic",
    "badge_visibility": {"total": False, "wip": False, "done": False, "overdue": False},
}
DEFAULT_ASSIGNEES = []
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")
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
        home_icons=value.get("home_icons"),
        page_styles=value.get("page_styles"),
    )


@router.put("", response_model=UiSettingsResponse)
def update_ui_settings(
    payload: UiSettingsUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    setting = _get_or_create(db, UI_SETTINGS_KEY, DEFAULT_UI_SETTINGS)
    current = setting.value or DEFAULT_UI_SETTINGS.copy()

    next_value: dict = {
        "app_title": payload.app_title if payload.app_title is not None else current.get("app_title", DEFAULT_UI_SETTINGS["app_title"]),
        "nav_labels": payload.nav_labels if payload.nav_labels is not None else current.get("nav_labels", {}),
    }
    # 홈 버튼 아이콘 — 프론트가 항상 work/platform 전체를 보내므로 통째로 저장.
    if payload.home_icons is not None:
        next_value["home_icons"] = payload.home_icons.model_dump(exclude_none=False)
    elif "home_icons" in current:
        next_value["home_icons"] = current["home_icons"]

    # 페이지별 화면 스타일 — 프론트가 전체 map 을 통째로 보낸다. 빈 오버라이드는
    # 제거해서 깔끔하게 유지(미지정 필드는 exclude_none).
    if payload.page_styles is not None:
        cleaned_styles: dict[str, dict] = {}
        for key, ps in payload.page_styles.items():
            dumped = ps.model_dump(exclude_none=True)
            if dumped:  # 아무 필드도 없으면 저장하지 않음
                cleaned_styles[key] = dumped
        next_value["page_styles"] = cleaned_styles
    elif "page_styles" in current:
        next_value["page_styles"] = current["page_styles"]

    setting.value = next_value
    db.commit()
    db.refresh(setting)

    return UiSettingsResponse(
        app_title=next_value["app_title"],
        nav_labels=next_value["nav_labels"],
        home_icons=next_value.get("home_icons"),
        page_styles=next_value.get("page_styles"),
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
def update_cluster_links(
    payload: ClusterLinksUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
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
            "seatLocation": a.get("seatLocation") or a.get("seat_location"),
            "primaryRole": a.get("primaryRole") or a.get("primary_role"),
            "secondaryRole": a.get("secondaryRole") or a.get("secondary_role"),
        } if name else None
    return None


# 본인이 직접 고칠 수 있는 담당자 필드 → 허용되는 payload 키(별칭 포함).
# 이름/사번은 제외한다 — 이름은 work item 의 담당자 식별 키, 사번은 로그인 username 이라
# 본인이 바꾸면 업무 ownership 과 계정이 끊긴다. 둘의 변경은 admin 전용 엔드포인트에서만.
SELF_EDITABLE_ASSIGNEE_FIELDS: dict[str, tuple[str, ...]] = {
    "email": ("email",),
    "ip": ("ip",),
    "seatLocation": ("seatLocation", "seat_location"),
    "primaryRole": ("primaryRole", "primary_role"),
    "secondaryRole": ("secondaryRole", "secondary_role"),
}


def _apply_self_assignee_patch(cleaned: list[dict], username: str, payload: dict) -> int:
    """정규화된 담당자 목록에서 본인 행을 찾아 self-editable 필드만 제자리 갱신.

    본인 판정은 employeeId == username (담당자 계정은 username = employeeId 로 provisioning).
    갱신한 인덱스를 반환하고, 본인 행이 없으면 -1 을 반환한다.
    """
    username = (username or "").strip()
    if not username:
        return -1
    idx = next(
        (i for i, a in enumerate(cleaned) if str(a.get("employeeId") or "").strip() == username),
        -1,
    )
    if idx < 0:
        return -1

    merged = dict(cleaned[idx])
    for field, aliases in SELF_EDITABLE_ASSIGNEE_FIELDS.items():
        for alias in aliases:
            if alias in payload:
                raw = payload.get(alias)
                merged[field] = raw.strip() if isinstance(raw, str) else raw
                break

    # 이름/사번은 payload 에 뭐가 오든 기존 값을 유지한다 (self 편집 대상 아님).
    merged["name"] = cleaned[idx]["name"]
    merged["employeeId"] = cleaned[idx].get("employeeId")

    # cleaned 항목은 이미 _normalize_assignee 를 통과해 name 이 비어 있지 않으므로 None 이 아니다.
    cleaned[idx] = _normalize_assignee(merged) or cleaned[idx]
    return idx


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
def update_assignees(
    payload: dict,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    raw_list = payload.get("assignees", [])
    if not isinstance(raw_list, list):
        raw_list = []

    cleaned = [e for raw in raw_list if (e := _normalize_assignee(raw)) is not None]

    # 안전 정규화: 담당자 이름과 사번(employeeId)은 고유해야 한다.
    #   - 이름은 work item 의 담당자 식별 키(primary/secondary_assignee)로 그대로 저장되므로
    #     동명이인이 있으면 ownership(본인 업무 수정/삭제) 판정이 모호해진다.
    #   - 사번은 로그인 username 으로 provisioning 되므로 중복되면 계정이 충돌한다.
    # 중복이 있으면 저장을 막고(400) 어떤 값이 충돌하는지 알려준다.
    name_counts = Counter(a["name"].strip().lower() for a in cleaned if a["name"].strip())
    dup_names = sorted({
        a["name"] for a in cleaned
        if a["name"].strip() and name_counts[a["name"].strip().lower()] > 1
    })
    emp_values = [str(a.get("employeeId") or "").strip() for a in cleaned]
    emp_counts = Counter(e for e in emp_values if e)
    dup_emps = sorted({e for e in emp_values if e and emp_counts[e] > 1})
    if dup_names or dup_emps:
        parts = []
        if dup_names:
            parts.append(f"중복된 담당자 이름: {', '.join(dup_names)}")
        if dup_emps:
            parts.append(f"중복된 사번: {', '.join(dup_emps)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "ASSIGNEE_DUPLICATE",
                "message": "담당자 이름과 사번은 고유해야 합니다. " + " / ".join(parts),
                "duplicate_names": dup_names,
                "duplicate_employee_ids": dup_emps,
            },
        )

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


@router.put("/assignees/me")
def update_my_assignee(
    payload: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본인 담당자 정보(이메일/IP/좌석/역할)만 수정 — 로그인한 사용자 누구나 가능.

    사용자 메뉴의 "내 담당자 정보" 패널이 쓰는 엔드포인트다. 예전에는 이 패널도 전체 목록을
    덮어쓰는 admin 전용 `PUT /assignees` 를 호출해서 operator 가 본인 IP 를 바꾸면 403 이
    났다. 여기서는 본인 행만 부분 갱신하므로 다른 담당자 데이터를 건드리지 않는다.

    담당자 계정은 username = employeeId 로 provisioning 되므로 그 매칭으로 본인 행을 찾는다.
    """
    setting = _get_or_create(db, ASSIGNEES_KEY, DEFAULT_ASSIGNEES)
    raw_value = setting.value if isinstance(setting.value, list) else []
    cleaned = [e for raw in raw_value if (e := _normalize_assignee(raw)) is not None]

    idx = _apply_self_assignee_patch(cleaned, user.username or "", payload)
    if idx < 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="등록된 담당자 정보가 없습니다. 관리자에게 사번 등록을 요청하세요.",
        )

    setting.value = cleaned
    db.commit()
    db.refresh(setting)
    return {"data": cleaned, "me": cleaned[idx]}


# ── 기능별 접근 제어 (feature access) ────────────────────────────────────
# 형태: { "<feature>": { "roles": [..], "users": [.. (username 또는 display_name)],
#                         "enabled": false (선택) } }
# feature 키는 라우트 경로를 그대로 쓴다(예: "/wbs") — Sidebar 의 NAV_MAP 키와 동일.
# 규칙(프론트/백엔드 공통):
#   - admin 은 항상 허용.
#   - enabled 가 명시적으로 false 면 admin 외 전체 차단(roles/users 무관, 최우선).
#   - 그 외 해당 feature 설정이 없거나 roles/users 가 모두 비면 전체 허용(기본 open).
#   - 설정이 있으면 role ∈ roles 또는 본인 ∈ users 일 때만 허용(세부 제한, WBS 등 고급 용도).

def _normalize_feature_access(raw) -> dict:
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for feature, rule in raw.items():
        if not isinstance(rule, dict):
            continue
        roles = rule.get("roles")
        users = rule.get("users")
        entry = {
            "roles": [str(r) for r in roles] if isinstance(roles, list) else [],
            "users": [str(u) for u in users] if isinstance(users, list) else [],
        }
        # enabled 는 명시적으로 false 일 때만 저장 — 기본값(true/미설정)은 저장하지 않아
        # payload 를 최소화하고, "미설정 = 열림" 의미를 필드 부재로 표현한다.
        if rule.get("enabled") is False:
            entry["enabled"] = False
        out[str(feature)] = entry
    # 레거시 마이그레이션: Your Island 이전엔 WBS 만 지원했고 키가 'wbs' 였다.
    # 화면별 접근 제어가 라우트 경로를 키로 쓰는 규칙으로 통일되면서 '/wbs' 로 승격한다.
    # '/wbs' 가 이미 있으면(신규 설정 우선) 구 키는 버리고, 없으면 그 값을 승격한다 —
    # 어느 쪽이든 'wbs' 라는 레거시 키 자체는 결과에 남기지 않는다.
    if "wbs" in out:
        legacy = out.pop("wbs")
        out.setdefault("/wbs", legacy)
    return out


@router.get("/feature-access")
def get_feature_access(db: Session = Depends(get_db)):
    setting = _get_or_create(db, FEATURE_ACCESS_KEY, DEFAULT_FEATURE_ACCESS)
    return {"data": _normalize_feature_access(setting.value)}


@router.put("/feature-access")
def update_feature_access(payload: dict, db: Session = Depends(get_db),
                          _: User = Depends(require_admin)):
    """기능별 접근 제어 저장 — admin 전용."""
    access = _normalize_feature_access(payload.get("access", payload))
    setting = _get_or_create(db, FEATURE_ACCESS_KEY, DEFAULT_FEATURE_ACCESS)
    setting.value = access
    db.commit()
    db.refresh(setting)
    return {"data": access}


# ── 업무 관리 게시판 공통 설정 (Settings) ─────────────────────────────────────────
# 뷰(목록/달력/칸반/에픽뷰) 노출 여부 + 기본 뷰, 헤더 배지(전체/WIP/Done/지연) 노출 여부 —
# 전 사용자 공통 적용(개인화 아님). admin 만 PUT 가능, 조회는 게시판을 보는 모든
# 사용자가 필요해 인증만 요구한다.
def _normalize_board_settings(raw) -> dict:
    if not isinstance(raw, dict):
        raw = {}

    raw_vis = raw.get("view_visibility")
    raw_vis = raw_vis if isinstance(raw_vis, dict) else {}
    view_visibility = {
        k: bool(raw_vis[k]) if k in raw_vis else DEFAULT_WORK_ITEM_BOARD_SETTINGS["view_visibility"][k]
        for k in BOARD_VIEW_KEYS
    }
    # 전부 꺼지면 게시판이 아예 안 보이게 되므로 기본값으로 되돌린다.
    if not any(view_visibility.values()):
        view_visibility = dict(DEFAULT_WORK_ITEM_BOARD_SETTINGS["view_visibility"])

    default_view = raw.get("default_view")
    if default_view not in BOARD_VIEW_KEYS or not view_visibility.get(default_view):
        # 보이는 뷰 중 우선순위(에픽뷰 → 목록 → 칸반 → 달력)로 폴백.
        default_view = next(
            (k for k in ("epic", "table", "kanban", "calendar") if view_visibility.get(k)),
            "table",
        )

    raw_badges = raw.get("badge_visibility")
    raw_badges = raw_badges if isinstance(raw_badges, dict) else {}
    badge_visibility = {
        k: bool(raw_badges[k]) if k in raw_badges else DEFAULT_WORK_ITEM_BOARD_SETTINGS["badge_visibility"][k]
        for k in BOARD_BADGE_KEYS
    }

    return {
        "view_visibility": view_visibility,
        "default_view": default_view,
        "badge_visibility": badge_visibility,
    }


@router.get("/work-item-board")
def get_work_item_board_settings(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    setting = _get_or_create(db, WORK_ITEM_BOARD_SETTINGS_KEY, DEFAULT_WORK_ITEM_BOARD_SETTINGS)
    return {"data": _normalize_board_settings(setting.value)}


@router.put("/work-item-board")
def update_work_item_board_settings(
    payload: dict,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    """업무 관리 게시판 공통 설정 저장 — admin 전용."""
    settings = _normalize_board_settings(payload.get("data", payload))
    setting = _get_or_create(db, WORK_ITEM_BOARD_SETTINGS_KEY, DEFAULT_WORK_ITEM_BOARD_SETTINGS)
    setting.value = settings
    db.commit()
    db.refresh(setting)
    return {"data": settings}


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
        hex_raw = it.get("custom_hex")
        items.append(OperationLevelItem(
            value=v,
            label=str(it.get("label", v)),
            color=str(it.get("color", "slate")),
            icon=str(icon_raw) if isinstance(icon_raw, str) and icon_raw.strip() else None,
            custom_hex=str(hex_raw) if isinstance(hex_raw, str) and _HEX_RE.match(hex_raw) else None,
        ))
    if not items:
        items = [OperationLevelItem(**x) for x in DEFAULT_OPERATION_LEVELS["levels"]]
    return OperationLevelsResponse(levels=items)


@router.put("/operation-levels", response_model=OperationLevelsResponse)
def update_operation_levels(
    payload: OperationLevelsUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    setting = _get_or_create(db, OPERATION_LEVELS_KEY, DEFAULT_OPERATION_LEVELS)
    seen: set[str] = set()
    cleaned: list[dict] = []
    for it in payload.levels:
        v = it.value.strip()
        if not v or v in seen:
            continue
        seen.add(v)
        icon = (it.icon or "").strip() or None
        custom_hex = (it.custom_hex or "").strip() or None
        if custom_hex and not _HEX_RE.match(custom_hex):
            custom_hex = None
        cleaned.append({
            "value": v, "label": it.label.strip() or v, "color": it.color or "slate",
            "icon": icon, "custom_hex": custom_hex,
        })
    setting.value = {"levels": cleaned}
    db.commit()
    db.refresh(setting)
    return OperationLevelsResponse(levels=[OperationLevelItem(**x) for x in cleaned])
