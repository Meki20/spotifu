import json
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

from jose import jwt, JWTError
from passlib.context import CryptContext

logger = logging.getLogger(__name__)

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30
_MIN_SECRET_LEN = 32

_SECRETS_FILE = Path(os.environ.get("SECRETS_FILE", "/home/lukaarch/Documents/src/SpotiFU/.secrets"))
_FORBIDDEN = {"", "change-me-in-production", "changeme", "secret"}


def _load_secrets_dict() -> dict:
    if not _SECRETS_FILE.exists():
        return {}
    try:
        with open(_SECRETS_FILE) as f:
            return json.load(f)
    except Exception as e:
        logger.warning("Failed to read .secrets for JWT key: %s", e)
        return {}


def _save_jwt_to_secrets(value: str) -> None:
    data = _load_secrets_dict()
    data["jwt_secret"] = value
    try:
        with open(_SECRETS_FILE, "w") as f:
            json.dump(data, f)
        os.chmod(_SECRETS_FILE, 0o600)
    except Exception as e:
        logger.error("Failed to persist generated JWT secret to .secrets: %s", e)
        raise


def _resolve_secret() -> str:
    env = os.environ.get("JWT_SECRET", "").strip()
    if env:
        if env in _FORBIDDEN or len(env) < _MIN_SECRET_LEN:
            raise RuntimeError(
                f"JWT_SECRET must be at least {_MIN_SECRET_LEN} chars and not a placeholder"
            )
        return env

    stored = _load_secrets_dict().get("jwt_secret", "").strip()
    if stored:
        if stored in _FORBIDDEN or len(stored) < _MIN_SECRET_LEN:
            raise RuntimeError(
                f"jwt_secret in .secrets is invalid (len<{_MIN_SECRET_LEN} or placeholder). "
                "Remove it to auto-regenerate."
            )
        return stored

    generated = secrets.token_urlsafe(48)
    _save_jwt_to_secrets(generated)
    logger.warning(
        "Generated new JWT secret and saved to %s. All existing sessions invalidated.",
        _SECRETS_FILE,
    )
    return generated


SECRET_KEY = _resolve_secret()

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    return pwd_ctx.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)


def create_access_token(data: dict, expires_in: int | None = ACCESS_TOKEN_EXPIRE_MINUTES) -> str:
    to_encode = data.copy()
    if expires_in is not None:
        expire = datetime.now(timezone.utc) + timedelta(minutes=expires_in)
        to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    if not token or len(token.split(".")) != 3:
        raise JWTError("Invalid token format")
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
