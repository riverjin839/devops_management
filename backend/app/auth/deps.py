"""FastAPI dependencies for protected endpoints."""
from typing import Callable

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.auth.security import decode_access_token


# tokenUrl is the relative path of the login endpoint — used by Swagger UI
# to populate the Authorize dialog.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the current user from the bearer token. 401 on failure."""
    cred_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    payload = decode_access_token(token)
    if not payload:
        raise cred_exc
    username = payload.get("sub")
    if not username:
        raise cred_exc
    user = db.query(User).filter(User.username == username).first()
    if not user or not user.is_active:
        raise cred_exc
    return user


def require_role(*allowed: str) -> Callable[[User], User]:
    """허용 role 화이트리스트를 가진 의존성 팩토리.

    레거시 role 'user' 는 'viewer' 와 동의어로 취급.
    """
    allowed_set = set(allowed)

    def _checker(user: User = Depends(get_current_user)) -> User:
        effective_role = "viewer" if user.role == "user" else user.role
        if effective_role not in allowed_set:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"권한이 부족합니다. 필요한 role: {', '.join(sorted(allowed_set))}",
            )
        return user

    return _checker


require_admin = require_role("admin")
require_operator = require_role("admin", "operator")
