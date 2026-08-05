"""홈/네비게이션 개인화 설정 — 기본 홈 탭, 즐겨찾기 경로.

`user_settings` 의 ``home_prefs`` 키에 저장되는 사용자별 JSON 설정이다. 기기·브라우저를
넘어 따라오는 서버 저장 선호이고(로컬 전용 최근 방문과 다름), 새 컬럼/테이블이 아니라
기존 `UserSetting` 을 재사용하므로 마이그레이션이 필요 없다.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.auth.deps import get_current_user
from app.schemas.home_prefs import HomePrefs, HomePrefsUpdate
from app.services.user_settings import get_user_setting, set_user_setting

router = APIRouter(prefix="/me", tags=["home-prefs"])

PREFS_KEY = "home_prefs"


@router.get("/home-prefs", response_model=HomePrefs)
def get_home_prefs(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    raw = get_user_setting(db, user.id, PREFS_KEY, None)
    return HomePrefs.model_validate(raw) if isinstance(raw, dict) else HomePrefs()


@router.put("/home-prefs", response_model=HomePrefs)
def update_home_prefs(
    payload: HomePrefsUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    raw = get_user_setting(db, user.id, PREFS_KEY, None)
    current = HomePrefs.model_validate(raw) if isinstance(raw, dict) else HomePrefs()
    updated = current.model_copy(update=payload.model_dump(exclude_unset=True))
    set_user_setting(db, user.id, PREFS_KEY, updated.model_dump())
    return updated
