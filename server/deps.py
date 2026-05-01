from fastapi import Depends, Header, HTTPException, Query
from jose import JWTError
from sqlmodel import Session, select

from auth import decode_access_token
from database import get_session
from models import User, UserPermission


def get_current_user(
    authorization: str | None = Header(None),
    token: str | None = Query(None),
    session: Session = Depends(get_session),
) -> User:
    if authorization is not None:
        token = authorization.removeprefix("Bearer ")
    if token is None:
        raise HTTPException(status_code=401, detail="Authorization header or token query param required")
    try:
        payload = decode_access_token(token)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    sub = payload.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="Malformed token")
    try:
        user_id = int(sub)
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Malformed token")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def get_user_permissions(session: Session, user_id: int) -> UserPermission | None:
    return session.get(UserPermission, user_id)


class CurrentUser:
    def __init__(self, user: User, permissions: UserPermission | None):
        self.user = user
        self.permissions = permissions

    @property
    def is_admin(self) -> bool:
        return self.user.is_admin

    def has_permission(self, permission: str) -> bool:
        if self.is_admin:
            return True
        if self.permissions is None:
            return False
        return getattr(self.permissions, permission, False)


def get_current_user_with_permissions(
    authorization: str | None = Header(None),
    token: str | None = Query(None),
    session: Session = Depends(get_session),
) -> CurrentUser:
    user = get_current_user(authorization, token, session)
    permissions = get_user_permissions(session, user.id)
    return CurrentUser(user, permissions)


def require_admin(user: CurrentUser = Depends(get_current_user_with_permissions)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def require_permission(permission: str):
    def _require_permission(user: CurrentUser = Depends(get_current_user_with_permissions)) -> CurrentUser:
        if not user.has_permission(permission):
            raise HTTPException(status_code=403, detail=f"Permission required: {permission}")
        return user
    return _require_permission
