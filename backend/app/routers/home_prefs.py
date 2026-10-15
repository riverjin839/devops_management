"""홈/네비게이션 개인화 설정 — 기본 홈 탭, 즐겨찾기 경로, 사이드바/상단바 설치 앱.

`user_settings` 의 ``home_prefs`` 키에 저장되는 사용자별 JSON 설정이다. 기기·브라우저를
넘어 따라오는 서버 저장 선호이고(로컬 전용 최근 방문과 다름), 새 컬럼/테이블이 아니라
기존 `UserSetting` 을 재사용하므로 마이그레이션이 필요 없다.

쓰기는 행 잠금(``SELECT … FOR UPDATE``) 아래에서 읽기-수정-쓰기를 한 트랜잭션으로 처리한다 —
두 기기·탭이 동시에 앱을 추가/제거해도 서로의 변경을 덮지 않는다(델타 연산과 함께).
"""
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.user_setting import UserSetting
from app.auth.deps import get_current_user
from app.schemas.home_prefs import HomePrefsOut, HomePrefsUpdate
from app.services.home_prefs import apply_update, get_default_installed_apps, load_prefs, to_out
from app.services import audit_logger, local_prefs, personal_settings
from app.services.user_settings import get_user_setting

router = APIRouter(prefix="/me", tags=["home-prefs"])

PREFS_KEY = "home_prefs"


@router.get("/home-prefs", response_model=HomePrefsOut)
def get_home_prefs(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    prefs = load_prefs(get_user_setting(db, user.id, PREFS_KEY, None))
    return to_out(prefs, get_default_installed_apps(db))


def _locked_row(db: Session, user_id: str) -> UserSetting | None:
    return (
        db.query(UserSetting)
        .filter(UserSetting.user_id == user_id, UserSetting.key == PREFS_KEY)
        .with_for_update()
        .first()
    )


@router.put("/home-prefs", response_model=HomePrefsOut)
def update_home_prefs(
    payload: HomePrefsUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    defaults = get_default_installed_apps(db)
    # 행이 아직 없을 때 두 요청이 동시에 INSERT 하면 한쪽이 유니크 위반 — 그때는 생긴 행을
    # 잠그고 한 번 더 적용한다.
    for attempt in range(2):
        row = _locked_row(db, user.id)
        current = load_prefs(row.value if row is not None else None)
        updated = apply_update(current, payload, defaults)
        value = updated.model_dump()
        try:
            if row is None:
                db.add(UserSetting(user_id=user.id, key=PREFS_KEY, value=value))
            else:
                row.value = value
            db.commit()
            break
        except IntegrityError:
            db.rollback()
            if attempt == 1:
                raise
    return to_out(updated, defaults)


# ── 개인 설정 내보내기 / 가져오기 ─────────────────────────────────────────────
# 본인 설정 중 이식 가능한 키만(services/personal_settings.py 허용 목록). 브라우저 로컬 설정은
# 화면이 같은 파일의 "local" 에 직접 담고 복원한다.

@router.get("/settings-export")
def export_personal_settings(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    # 문서는 JSON **문자열** 로 감싼다 — axios 인터셉터의 키 camelCase/snake_case 자동 변환이
    # 설정 값 안의 키(프로필 이름 등)까지 바꾸지 못하게.
    return {"document": json.dumps(personal_settings.export_settings(db, user), ensure_ascii=False)}


class SettingsImportRequest(BaseModel):
    document: str = Field(..., max_length=2_000_000)


@router.post("/settings-import")
def import_personal_settings(
    payload: SettingsImportRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        doc = json.loads(payload.document)
        result = personal_settings.import_settings(db, user, doc)
    except (ValueError, TypeError) as e:  # json.JSONDecodeError 는 ValueError
        raise HTTPException(status_code=400, detail=f"가져오기 실패: {e}") from e
    audit_logger.record(
        db,
        action="user.settings_import",
        actor=user,
        target_type="user",
        target_id=user.id,
        details=result,
        request=request,
    )
    return result


# ── 브라우저 로컬 개인 설정 동기화 ───────────────────────────────────────────────
# 그룹 접힘·보기 모드처럼 localStorage 에 있던 개인 설정을 다른 PC 로 따라오게 한다(services/local_prefs.py).
# 화면은 axios 가 아니라 fetch 로 부른다 — 응답 값의 키("pep:homeTab" 등)가 camelCase 변환에 바뀌지 않게.

@router.get("/local-prefs")
def get_local_prefs(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return local_prefs.get_local_prefs(db, user.id)


class LocalPrefsDelta(BaseModel):
    set: dict[str, str] = Field(default_factory=dict)
    remove: list[str] = Field(default_factory=list, max_length=local_prefs.MAX_KEYS)


@router.patch("/local-prefs")
def patch_local_prefs(
    payload: LocalPrefsDelta,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if len(payload.set) > local_prefs.MAX_KEYS:
        raise HTTPException(status_code=413, detail=f"한 번에 {local_prefs.MAX_KEYS}개까지 저장할 수 있다")
    try:
        return local_prefs.apply_delta(db, user.id, payload.set, payload.remove)
    except local_prefs.LocalPrefsTooLarge as e:
        raise HTTPException(status_code=413, detail=str(e)) from e
