"""네임스페이스 선택 기억 라우터 — 마지막 선택 NS 와 최근 선택 NS(기본 3개).

`user_settings` 의 ``ns_prefs`` 키(계정별)를 재사용하므로 마이그레이션이 필요 없다. 쓰기는
`home_prefs` 와 같이 행 잠금 아래 읽기-수정-쓰기로 처리해 두 탭이 동시에 바꿔도 서로를 덮지 않는다.
클러스터 접근 권한을 판정하지 않는다 — 이름 목록만 저장하는 개인 선호이고, NS 목록 조회 자체는
k8s_resources 라우터가 클러스터 접근 판정을 한다.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.database import get_db
from app.models.user import User
from app.models.user_setting import UserSetting
from app.schemas.ns_prefs import NsPrefsOut, NsPrefsUpdate
from app.services import ns_prefs as svc
from app.services.user_settings import get_user_setting

router = APIRouter(prefix="/me", tags=["ns-prefs"])

PREFS_KEY = "ns_prefs"


@router.get("/ns-prefs", response_model=NsPrefsOut)
def get_ns_prefs(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return svc.to_out(svc.load(get_user_setting(db, user.id, PREFS_KEY, None)))


@router.put("/ns-prefs", response_model=NsPrefsOut)
def update_ns_prefs(
    payload: NsPrefsUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # 행이 아직 없을 때 두 요청이 동시에 INSERT 하면 한쪽이 유니크 위반 — 생긴 행을 잠그고 한 번 더 적용.
    for attempt in range(2):
        row = (
            db.query(UserSetting)
            .filter(UserSetting.user_id == user.id, UserSetting.key == PREFS_KEY)
            .with_for_update()
            .first()
        )
        current = svc.load(row.value if row is not None else None)
        updated = svc.apply_update(current, payload.cluster_id, payload.selected, payload.recent_limit)
        try:
            if row is None:
                db.add(UserSetting(user_id=user.id, key=PREFS_KEY, value=updated))
            else:
                row.value = updated
            db.commit()
            break
        except IntegrityError:
            db.rollback()
            if attempt == 1:
                raise
    return svc.to_out(updated)
