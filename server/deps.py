from fastapi import Depends, Header, HTTPException
from jose import JWTError
from sqlmodel import Session

from auth import decode_access_token
from database import get_session
from models import User


def get_current_user(
    authorization: str | None = Header(None),
    session: Session = Depends(get_session),
) -> User:
    if authorization is None:
        raise HTTPException(status_code=401, detail="Authorization header required")
    token = authorization.removeprefix("Bearer ")
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
