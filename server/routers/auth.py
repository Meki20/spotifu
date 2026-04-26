from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
import logging

logger = logging.getLogger(__name__)
from sqlmodel import Session
from database import get_session
from limiter import limiter
from models import User
from auth import hash_password, verify_password, create_access_token, ACCESS_TOKEN_EXPIRE_MINUTES

REMEMBER_ME_MINUTES = 30 * 24 * 60

router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    username: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str
    remember: bool = False


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


@router.post("/register", response_model=TokenResponse)
@limiter.limit("10/minute")
def register(
    request: Request,
    body: RegisterRequest,
    session: Session = Depends(get_session),
):
    existing = session.query(User).filter(User.username == body.username).first()
    if existing:
        raise HTTPException(status_code=400, detail="Username already taken")

    user = User(username=body.username, hashed_password=hash_password(body.password))
    session.add(user)
    session.commit()
    session.refresh(user)

    token = create_access_token({"sub": str(user.id), "username": user.username})
    return TokenResponse(access_token=token)


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
def login(
    request: Request,
    body: LoginRequest,
    session: Session = Depends(get_session),
):
    logger.debug("login body: %s", body)
    user = session.query(User).filter(User.username == body.username).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    expires_minutes = REMEMBER_ME_MINUTES if body.remember else ACCESS_TOKEN_EXPIRE_MINUTES
    token = create_access_token({"sub": str(user.id), "username": user.username}, expires_in=expires_minutes)
    return TokenResponse(access_token=token)