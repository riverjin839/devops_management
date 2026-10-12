"""홈/네비게이션 개인화 설정 — 기본 홈 탭, 즐겨찾기 경로, 사이드바/상단바 설치 앱.

`user_settings` 의 ``home_prefs`` 키에 저장되는 사용자별 JSON 설정이다. 기기·브라우저를
넘어 따라오는 서버 저장 선호이고(로컬 전용 최근 방문과 다름), 새 컬럼/테이블이 아니라
기존 `UserSetting` 을 재사용하므로 마이그레이션이 필요 없다.

쓰기는 행 잠금(``SELECT … FOR UPDATE``) 아래에서 읽기-수정-쓰기를 한 트랜잭션으로 처리한다 —
두 기기·탭이 동시에 앱을 추가/제거해도 서로의 변경을 덮지 않는다(델타 연산과 함께).
"""
from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.user_setting import UserSetting
from app.auth.deps import get_current_user
from app.schemas.home_prefs import HomePrefsOut, HomePrefsUpdate
from app.services.home_prefs import apply_update, get_default_installed_apps, load_prefs, to_out
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
