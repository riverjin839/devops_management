import re
from collections import Counter
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.app_setting import AppSetting
from app.models.cluster import Cluster
from app.models.user import User
from app.auth.deps import get_cluster_scope, get_current_user, require_admin
from app.auth.feature_access import FEATURE_ACCESS_KEY, normalize_feature_access
from app.auth.security import hash_password
from app.services import audit_logger
from app.services.cluster_access import ClusterScope
from app.services.assignee_accounts import ASSIGNEE_ACCOUNT_ROLE
from app.services.cluster_endpoint_policy import (
    CLUSTER_ENDPOINT_ALLOWLIST_KEY,
    DEFAULT_CLUSTER_ENDPOINT_ALLOWLIST,
    InvalidAllowlistEntry,
    normalize_allowlist,
)
from app.services.cluster_network_mask import (
    CLUSTER_VIEWER_MASK_KEY,
    DEFAULT_CLUSTER_VIEWER_MASK,
    normalize_mask_setting,
)
from app.services.operation_levels import DEFAULT_OPERATION_LEVELS, OPERATION_LEVELS_KEY
from app.schemas.home_prefs import HomePrefsDefaults
from app.services.home_prefs import (
    DEFAULTS_KEY as HOME_PREFS_DEFAULTS_KEY,
    get_default_installed_apps,
    set_default_installed_apps,
)
from app.schemas.ui_settings import (
    UiSettingsResponse,
    UiSettingsUpdate,
    ClusterLinksResponse,
    ClusterLinksUpdate,
    ClusterLinksPayload,
    OperationLevelsResponse,
    OperationLevelsUpdate,
    OperationLevelItem,
    default_guarded,
    is_http_url,
)

router = APIRouter(prefix="/ui-settings", tags=["ui-settings"])

UI_SETTINGS_KEY = "ui_settings"
CLUSTER_LINKS_KEY = "cluster_links"
DEFAULT_FEATURE_ACCESS: dict = {}
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
_HEX_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")


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


CLUSTER_LINKS_CONFLICT_DETAIL = "다른 곳에서 링크가 바뀌었습니다. 새로고침 후 다시 저장하세요."


def _cluster_links_version(setting: AppSetting | None) -> str:
    """링크 문서 버전 — 마지막 저장 시각(updated_at ISO). 행이 없거나 시각이 없으면 "0"."""
    if setting is None or setting.updated_at is None:
        return "0"
    return setting.updated_at.isoformat()


def _as_uuid(value) -> UUID | None:
    try:
        return value if isinstance(value, UUID) else UUID(str(value))
    except (TypeError, ValueError):
        return None


def _existing_cluster_ids(db: Session, groups: list) -> set[UUID]:
    ids = {
        cid for cid in (_as_uuid(g.get("cluster_id")) for g in groups if isinstance(g, dict)) if cid
    }
    if not ids:
        return set()
    return {cid for (cid,) in db.query(Cluster.id).filter(Cluster.id.in_(ids)).all()}


def _group_visible(cluster_id, scope: ClusterScope, existing: set[UUID], is_admin: bool) -> bool:
    """이 사용자에게 링크 그룹이 보이는가 — 클러스터 가시 범위(테넌트 바인딩)를 따른다.

    클러스터가 없어진(또는 id 가 깨진) 고아 그룹은 admin 에게만 보인다 — 정리는 admin 몫이고,
    다른 사용자에게 "삭제된 클러스터" 로 남의 링크를 보여주지 않는다(A-18).
    """
    cid = _as_uuid(cluster_id)
    if cid is None or cid not in existing:
        return is_admin
    return scope.visible(cid)


def _safe_links(links) -> list[dict]:
    """저장된 링크 중 http(s) URL 만 응답한다(검증 도입 전 저장된 javascript: 등은 노출하지 않음)."""
    out: list[dict] = []
    for link in links or []:
        if isinstance(link, dict) and is_http_url(link.get("url")):
            out.append(link)
    return out


def _cluster_links_view(db: Session, value: dict, scope: ClusterScope, is_admin: bool) -> ClusterLinksPayload:
    groups = [g for g in (value.get("cluster_groups") or []) if isinstance(g, dict)]
    existing = _existing_cluster_ids(db, groups)
    visible_groups = [
        {**g, "links": _safe_links(g.get("links"))}
        for g in groups
        if _group_visible(g.get("cluster_id"), scope, existing, is_admin)
    ]
    return ClusterLinksPayload(
        common_links=_safe_links(value.get("common_links")),
        cluster_groups=visible_groups,
    )


@router.get("/cluster-links", response_model=ClusterLinksResponse)
def get_cluster_links(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """공용 링크 + 클러스터별 링크 그룹. 그룹은 호출자에게 보이는 클러스터만(고아 그룹은 admin 만),
    배열 순서 = 저장된 순서. ``version`` 은 PUT 의 충돌 검사용."""
    setting = _get_or_create(db, CLUSTER_LINKS_KEY, DEFAULT_CLUSTER_LINKS)
    value = setting.value or DEFAULT_CLUSTER_LINKS
    version = _cluster_links_version(setting)
    payload = _cluster_links_view(db, value, scope, user.role == "admin")
    payload.version = version
    return ClusterLinksResponse(data=payload, version=version)


@router.put("/cluster-links", response_model=ClusterLinksResponse)
def update_cluster_links(
    payload: ClusterLinksUpdate,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
    scope: ClusterScope = Depends(get_cluster_scope),
):
    """링크 문서 저장(admin). ``version`` 을 주면 저장된 버전과 다를 때 409.

    ``cluster_groups`` 배열 순서를 그대로 저장한다. 호출자에게 안 보이는 그룹(다른 테넌트 클러스터,
    admin 이 아니면 고아 그룹)은 요청에 없어도 지우지 않고 저장된 문서에서 다시 합친다(뒤에 붙임).
    """
    # 버전 검사와 저장 사이에 다른 저장이 끼지 않게 행을 잠근다.
    setting = (
        db.query(AppSetting).filter(AppSetting.key == CLUSTER_LINKS_KEY).with_for_update().first()
    )
    current_version = _cluster_links_version(setting)
    if payload.version is not None and payload.version != current_version:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=CLUSTER_LINKS_CONFLICT_DETAIL)

    is_admin = actor.role == "admin"
    stored = (setting.value or {}) if setting is not None else {}
    stored_groups = [g for g in (stored.get("cluster_groups") or []) if isinstance(g, dict)]
    incoming = [group.model_dump() for group in payload.cluster_groups]
    existing = _existing_cluster_ids(db, stored_groups + incoming)

    # 보이는 그룹만 요청대로(순서 포함) 반영 — 안 보이는 클러스터의 그룹을 요청으로 덮어쓰지 못한다.
    groups = [g for g in incoming if _group_visible(g["cluster_id"], scope, existing, is_admin)]
    hidden = [g for g in stored_groups if not _group_visible(g.get("cluster_id"), scope, existing, is_admin)]
    next_value = {
        "common_links": [item.model_dump() for item in payload.common_links],
        "cluster_groups": groups + hidden,
    }
    if setting is None:
        setting = AppSetting(key=CLUSTER_LINKS_KEY, value=next_value)
        db.add(setting)
    else:
        setting.value = next_value
    # 내용이 같아도 버전은 올린다(동일 JSON 대입은 UPDATE 가 생략돼 onupdate 가 안 돈다).
    setting.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(setting)

    version = _cluster_links_version(setting)
    view = _cluster_links_view(db, next_value, scope, is_admin)
    view.version = version
    return ClusterLinksResponse(data=view, version=version)


# 담당자 명부는 users 테이블 자체다(모델 docstring 참고) — app_settings JSON 이 아니다.
# 응답 dict 의 키는 프론트엔드 Assignee 타입(camelCase)과 그대로 맞춘다.

def _assignee_out(u: User, *, include_account: bool) -> dict:
    out = {
        "name": u.display_name or u.username or "",
        "employeeId": u.employee_id,
        "email": u.email,
        "ip": u.ip,
        "seatLocation": u.seat_location,
        "primaryRole": u.primary_role,
        "secondaryRole": u.secondary_role,
    }
    if include_account:
        out.update({
            "id": u.id,
            "username": u.username,
            "accountRole": u.role,
            "isActive": u.is_active,
            "hasLogin": bool(u.username),
            "createdAt": u.created_at.isoformat() if u.created_at else None,
        })
    return out


# 본인이 직접 고칠 수 있는 담당자 필드 → 허용되는 payload 키(별칭 포함) → User 모델 속성명.
# 이름/사번은 제외한다 — 이름은 work item 의 담당자 식별 키, 사번은 로그인 username 이라
# 본인이 바꾸면 업무 ownership 과 계정이 끊긴다. 둘의 변경은 admin 전용 엔드포인트에서만.
SELF_EDITABLE_ASSIGNEE_FIELDS: dict[str, tuple[str, ...]] = {
    "email": ("email",),
    "ip": ("ip",),
    "seat_location": ("seatLocation", "seat_location"),
    "primary_role": ("primaryRole", "primary_role"),
    "secondary_role": ("secondaryRole", "secondary_role"),
}


def _apply_self_editable_fields(user: User, payload: dict) -> None:
    """payload 에 들어온 self-editable 필드만 user 행에 제자리 반영(커밋은 호출측)."""
    for attr, aliases in SELF_EDITABLE_ASSIGNEE_FIELDS.items():
        for alias in aliases:
            if alias in payload:
                raw = payload.get(alias)
                setattr(user, attr, raw.strip() if isinstance(raw, str) else raw)
                break


@router.get("/assignees")
def get_assignees(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(User).order_by(User.display_name).all()
    include_account = user.role == "admin"
    return {"data": [_assignee_out(u, include_account=include_account) for u in rows]}


@router.put("/assignees")
def update_assignees(
    payload: dict,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    """담당자 명부를 upsert 한다 — 삭제는 하지 않는다(생성/수정 전용).

    행 삭제는 로그인 계정 삭제와 동일한 작업이므로(users 테이블이 명부 자체라서)
    감사 로그가 남고 본인 삭제를 막는 기존 `DELETE /auth/users/{id}` 로만 한다.
    각 항목은 `id`(기존 행 갱신) 가 있으면 update, 없으면 새 행을 만든다. 사번
    (employeeId) 이 채워지면 로그인 계정을 자동 발급(초기 비번=사번, role=operator)한다.

    계정 해제 가드(D-156) — 화면은 한 행만 고쳐도 전체 목록을 보내므로, "사번 비움 = 해제" 는
    **기존에 사번이 있던 행에서 이번 요청이 employeeId 키를 명시적으로 비웠을 때만** 적용한다.
      - 원래 사번이 없던 계정(부트스트랩 admin·"관리자 계정 추가"·LDAP/SSO 계정)은 employeeId 가
        null 로 되돌아와도 로그인 필드를 건드리지 않는다.
      - employeeId 키가 아예 없는 항목은 사번·계정을 바꾸지 않는다.
      - 요청자 본인 계정 해제, 활성 admin 로그인을 하나도 남기지 않는 해제는 400.
      - 해제·발급은 감사 로그(`user.login.revoke` / `user.create`)에 남긴다.
    응답 `accounts` 에 발급(created)·해제(revoked) 사번 목록을 담는다.
    """
    raw_list = payload.get("assignees", [])
    if not isinstance(raw_list, list):
        raw_list = []

    cleaned = []
    for raw in raw_list:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name", "")).strip()
        if not name:
            continue

        def _s(*keys) -> str | None:
            for k in keys:
                v = raw.get(k)
                if v is not None and str(v).strip():
                    return str(v).strip()
            return None

        cleaned.append({
            "id": raw.get("id"),
            "name": name,
            "employeeId": _s("employeeId", "employee_id"),
            # 키 자체가 왔는지 — 없으면 사번을 "모름"으로 보고 기존 값을 유지한다.
            "employeeIdGiven": "employeeId" in raw or "employee_id" in raw,
            "email": _s("email"),
            "ip": _s("ip"),
            "seatLocation": _s("seatLocation", "seat_location"),
            "primaryRole": _s("primaryRole", "primary_role"),
            "secondaryRole": _s("secondaryRole", "secondary_role"),
        })

    # 안전 정규화: 담당자 이름과 사번(employeeId)은 고유해야 한다.
    #   - 이름은 work item 의 담당자 식별 키(primary/secondary_assignee)로 그대로 저장되므로
    #     동명이인이 있으면 ownership(본인 업무 수정/삭제) 판정이 모호해진다.
    #   - 사번은 로그인 username 으로 provisioning 되므로 중복되면 계정이 충돌한다.
    name_counts = Counter(a["name"].lower() for a in cleaned)
    dup_names = sorted({a["name"] for a in cleaned if name_counts[a["name"].lower()] > 1})
    emp_counts = Counter(a["employeeId"] for a in cleaned if a["employeeId"])
    dup_emps = sorted({a["employeeId"] for a in cleaned if a["employeeId"] and emp_counts[a["employeeId"]] > 1})
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

    accounts_created: list[str] = []
    created_users: list[User] = []
    # (user, 해제 전 username, 해제 전 사번) — 커밋 후 감사 로그용.
    revoked: list[tuple[User, str | None, str]] = []
    revoked_admin = False
    for a in cleaned:
        existing = db.query(User).filter(User.id == a["id"]).first() if a["id"] else None
        if existing is None and a["employeeId"]:
            existing = db.query(User).filter(User.employee_id == a["employeeId"]).first()

        if existing is not None:
            if a["employeeId"]:
                conflict = db.query(User).filter(
                    User.employee_id == a["employeeId"], User.id != existing.id,
                ).first()
                if conflict:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"사번 {a['employeeId']} 은(는) 이미 다른 담당자가 사용 중입니다.",
                    )
            existing.display_name = a["name"]
            existing.email = a["email"]
            existing.ip = a["ip"]
            existing.seat_location = a["seatLocation"]
            existing.primary_role = a["primaryRole"]
            existing.secondary_role = a["secondaryRole"]
            if not a["employeeIdGiven"]:
                # 사번 키가 없는 항목 — 사번·로그인 계정은 그대로 둔다.
                continue
            if a["employeeId"] and not existing.username:
                # 로그인 없던 담당자에게 사번이 새로 붙음 → 계정 자동 발급.
                _ensure_username_free(db, a["employeeId"], existing.id)
                existing.employee_id = a["employeeId"]
                existing.username = a["employeeId"]
                existing.hashed_password = hash_password(a["employeeId"])
                existing.role = existing.role or ASSIGNEE_ACCOUNT_ROLE
                accounts_created.append(a["employeeId"])
                created_users.append(existing)
            elif a["employeeId"]:
                # 사번 기반으로 발급된 username(=기존 사번)만 새 사번으로 옮긴다. 사번과 무관한
                # username(부트스트랩 admin 의 "admin" 등)은 사번을 붙여도 로그인 아이디를 유지한다.
                if existing.username == existing.employee_id and existing.username != a["employeeId"]:
                    _ensure_username_free(db, a["employeeId"], existing.id)
                    existing.username = a["employeeId"]  # 사번 변경 → username 도 함께 이동
                existing.employee_id = a["employeeId"]
            elif existing.employee_id:
                # 사번이 있던 행에서 이번 요청이 명시적으로 비움 → 로그인 계정 해제.
                if existing.id == actor.id:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"본인 계정({existing.display_name or existing.username})의 사번은 비울 수 없습니다 "
                               "— 로그인이 해제됩니다. 다른 관리자에게 요청하세요.",
                    )
                if existing.username != existing.employee_id:
                    # 사번에서 파생되지 않은 로그인(부트스트랩 "admin"·LDAP·SSO 계정 등) — 사번만 떼고
                    # 로그인은 그대로 둔다. 해제 대상은 사번으로 자동 발급된 계정뿐이다.
                    existing.employee_id = None
                    continue
                revoked.append((existing, existing.username, existing.employee_id))
                if existing.role == "admin":
                    revoked_admin = True
                existing.employee_id = None
                existing.username = None
                existing.hashed_password = None
                # 역할을 남겨 두면 나중에 사번을 다시 붙일 때 예전 역할(admin 등)·초기 비밀번호(=사번)로
                # 되살아난다 — 해제 시 기본 역할로 되돌린다.
                existing.role = ASSIGNEE_ACCOUNT_ROLE
            # else: 원래 사번이 없던 계정 — 로그인 필드는 건드리지 않는다.
        else:
            new_user = User(
                display_name=a["name"], email=a["email"], ip=a["ip"],
                seat_location=a["seatLocation"], primary_role=a["primaryRole"],
                secondary_role=a["secondaryRole"], employee_id=a["employeeId"],
            )
            if a["employeeId"]:
                _ensure_username_free(db, a["employeeId"], None)
                new_user.username = a["employeeId"]
                new_user.hashed_password = hash_password(a["employeeId"])
                new_user.role = ASSIGNEE_ACCOUNT_ROLE
                accounts_created.append(a["employeeId"])
                created_users.append(new_user)
            db.add(new_user)

    if revoked_admin:
        db.flush()
        remaining_admins = db.query(User).filter(
            User.role == "admin", User.is_active.is_(True), User.username.isnot(None),
        ).count()
        if remaining_admins == 0:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="로그인 가능한 관리자가 남지 않습니다 — 마지막 관리자 계정의 사번은 비울 수 없습니다.",
            )

    db.commit()
    for u in created_users:
        audit_logger.record(
            db, action="user.create", actor=actor, status="success",
            target_type="user", target_id=u.id,
            details={"username": u.username, "role": u.role, "source": "assignees"},
            request=request,
        )
    for u, old_username, old_emp in revoked:
        audit_logger.record(
            db, action="user.login.revoke", actor=actor, status="success",
            target_type="user", target_id=u.id,
            details={"username": old_username, "employee_id": old_emp, "display_name": u.display_name,
                     "role": u.role, "reason": "employee_id_cleared"},
            request=request,
        )
    rows = db.query(User).order_by(User.display_name).all()
    return {
        "data": [_assignee_out(u, include_account=True) for u in rows],
        "accounts": {"created": accounts_created, "revoked": [emp for _, _, emp in revoked]},
    }


def _ensure_username_free(db: Session, username: str, self_id: str | None) -> None:
    """사번을 로그인 username 으로 쓰기 전에 다른 계정이 같은 username 을 쓰는지 확인(400)."""
    q = db.query(User).filter(User.username == username)
    if self_id is not None:
        q = q.filter(User.id != self_id)
    if q.first() is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"사번 {username} 은(는) 이미 다른 계정의 로그인 아이디로 사용 중입니다.",
        )


@router.put("/assignees/me")
def update_my_assignee(
    payload: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """본인 담당자 정보(이메일/IP/좌석/역할)만 수정 — 로그인한 사용자 누구나 가능.

    사용자 메뉴의 "내 담당자 정보" 패널이 쓰는 엔드포인트다. 예전에는 이 패널도 전체 목록을
    덮어쓰는 admin 전용 `PUT /assignees` 를 호출해서 operator 가 본인 IP 를 바꾸면 403 이
    났다. `get_current_user` 로 이미 본인 행이 확정되므로 다른 담당자 데이터는 건드리지 않는다.
    """
    _apply_self_editable_fields(user, payload)
    db.commit()
    db.refresh(user)
    rows = db.query(User).order_by(User.display_name).all()
    include_account = user.role == "admin"
    return {
        "data": [_assignee_out(u, include_account=include_account) for u in rows],
        "me": _assignee_out(user, include_account=True),
    }


# ── 기능별 접근 제어 (feature access) ────────────────────────────────────
# 형태: { "<feature>": { "roles": [..], "users": [.. (username 또는 display_name)],
#                         "enabled": false (선택) } }
# feature 키는 라우트 경로를 그대로 쓴다(예: "/wbs") — Sidebar 의 NAV_MAP 키와 동일.
# 규칙(프론트/백엔드 공통):
#   - admin 은 항상 허용.
#   - enabled 가 명시적으로 false 면 admin 외 전체 차단(roles/users 무관, 최우선).
#   - 그 외 해당 feature 설정이 없거나 roles/users 가 모두 비면 전체 허용(기본 open).
#   - 설정이 있으면 role ∈ roles 또는 본인 ∈ users 일 때만 허용(세부 제한, WBS 등 고급 용도).

# 정규화·판정 로직은 서버 측 강제(`app.auth.feature_access`)와 공유한다 — 저장과 강제가
# 같은 규칙을 쓰도록 한 곳에 둔다.
_normalize_feature_access = normalize_feature_access


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


# ── viewer 클러스터 네트워크 정보 숨김 (Settings → 접근 제어) ─────────────────────
# 켜면 viewer 의 /clusters 응답에서 내부 IP·CIDR·MAC·호스트명·API 엔드포인트를 비운다.
# 조회는 화면이 "숨김" 안내를 그리도록 인증만, 변경은 admin + 감사 로그.
@router.get("/cluster-viewer-mask")
def get_cluster_viewer_mask(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    setting = _get_or_create(db, CLUSTER_VIEWER_MASK_KEY, DEFAULT_CLUSTER_VIEWER_MASK)
    return {"data": normalize_mask_setting(setting.value)}


@router.put("/cluster-viewer-mask")
def update_cluster_viewer_mask(
    payload: dict,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    """viewer 네트워크 정보 숨김 정책 저장 — admin 전용, 변경 시 감사 기록."""
    value = normalize_mask_setting(payload.get("data", payload))
    setting = _get_or_create(db, CLUSTER_VIEWER_MASK_KEY, DEFAULT_CLUSTER_VIEWER_MASK)
    before = normalize_mask_setting(setting.value)
    setting.value = value
    db.commit()
    db.refresh(setting)
    if before != value:
        audit_logger.record(
            db,
            action="settings.cluster_viewer_mask.update",
            actor=actor,
            target_type="app_setting",
            target_id=CLUSTER_VIEWER_MASK_KEY,
            details={"enabled_from": before["enabled"], "enabled_to": value["enabled"]},
            request=request,
        )
    return {"data": value}


# ── 사이드바/상단바 조직 기본 설치 목록 (Settings "화면 UI 설정") ─────────────────────
# 개인화하지 않은(installed_apps_customized=False) 모든 계정의 실효 목록이다. 조회는 인증만,
# 변경은 admin 전용 + 감사 기록. 이미 직접 고른 계정은 영향을 받지 않는다.

@router.get("/home-prefs-defaults", response_model=HomePrefsDefaults)
def get_home_prefs_defaults(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    return HomePrefsDefaults(installed_apps=get_default_installed_apps(db))


@router.put("/home-prefs-defaults", response_model=HomePrefsDefaults)
def update_home_prefs_defaults(
    payload: HomePrefsDefaults,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    before = get_default_installed_apps(db)
    after = set_default_installed_apps(db, payload.installed_apps)
    if before != after:
        audit_logger.record(
            db,
            action="settings.home_prefs_defaults.update",
            actor=actor,
            target_type="app_setting",
            target_id=HOME_PREFS_DEFAULTS_KEY,
            details={
                "added": [a for a in after if a not in before],
                "removed": [a for a in before if a not in after],
            },
            request=request,
        )
    return HomePrefsDefaults(installed_apps=after)


# ── 클러스터 API 엔드포인트 허용 대역 (Settings → 접근 제어) ───────────────────
# 비어 있으면 제한 없음. 채우면 클러스터 생성·api_endpoint 변경·연결 검증이 이 대역(CIDR/호스트명)
# 밖의 주소로 요청을 보내지 않는다 — services/cluster_endpoint_policy.py.
@router.get("/cluster-endpoint-allowlist")
def get_cluster_endpoint_allowlist(
    db: Session = Depends(get_db),
    _: User = Depends(get_current_user),
):
    setting = _get_or_create(db, CLUSTER_ENDPOINT_ALLOWLIST_KEY, DEFAULT_CLUSTER_ENDPOINT_ALLOWLIST)
    return {"data": normalize_allowlist(setting.value)}


@router.put("/cluster-endpoint-allowlist")
def update_cluster_endpoint_allowlist(
    payload: dict,
    request: Request,
    db: Session = Depends(get_db),
    actor: User = Depends(require_admin),
):
    """허용 대역 저장 — admin 전용. 잘못된 항목은 422 로 항목명을 알려준다. 변경 시 감사 기록."""
    try:
        value = normalize_allowlist(payload.get("data", payload), strict=True)
    except InvalidAllowlistEntry as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    setting = _get_or_create(db, CLUSTER_ENDPOINT_ALLOWLIST_KEY, DEFAULT_CLUSTER_ENDPOINT_ALLOWLIST)
    before = normalize_allowlist(setting.value)
    setting.value = value
    db.commit()
    db.refresh(setting)
    if before != value:
        audit_logger.record(
            db,
            action="settings.cluster_endpoint_allowlist.update",
            actor=actor,
            target_type="app_setting",
            target_id=CLUSTER_ENDPOINT_ALLOWLIST_KEY,
            details={"entries_from": before["entries"], "entries_to": value["entries"]},
            request=request,
        )
    return {"data": value}


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
        guarded_raw = it.get("guarded")
        items.append(OperationLevelItem(
            value=v,
            label=str(it.get("label", v)),
            color=str(it.get("color", "slate")),
            icon=str(icon_raw) if isinstance(icon_raw, str) and icon_raw.strip() else None,
            custom_hex=str(hex_raw) if isinstance(hex_raw, str) and _HEX_RE.match(hex_raw) else None,
            # 구버전 데이터(guarded 없음)는 value 로 판정 — production·dr 만 보호.
            guarded=guarded_raw if isinstance(guarded_raw, bool) else default_guarded(v),
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
            "guarded": it.guarded if it.guarded is not None else default_guarded(v),
        })
    setting.value = {"levels": cleaned}
    db.commit()
    db.refresh(setting)
    return OperationLevelsResponse(levels=[OperationLevelItem(**x) for x in cleaned])
