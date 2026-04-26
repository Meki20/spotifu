"""Auth router: register, login, token expiry, ACCESS_TOKEN_EXIRE_MINUTES wiring."""
from __future__ import annotations

import time

import pytest
from jose import JWTError

import auth
from tests.factories import auth_header, make_user
from models import User
from sqlmodel import select


def test_register_login_success(client, session):
    r = client.post("/auth/register", json={"username": "alice", "password": "x" * 12})
    assert r.status_code == 200
    token = r.json()["access_token"]
    user = session.exec(select(User).where(User.username == "alice")).first()
    assert user is not None
    p = auth.decode_access_token(token)
    assert p["sub"] == str(user.id)
    h = auth_header(client, "alice", "x" * 12)
    assert client.get("/settings", headers=h).status_code == 200


def test_register_duplicate_400(client):
    client.post("/auth/register", json={"username": "dup", "password": "pw" * 8})
    r = client.post("/auth/register", json={"username": "dup", "password": "other" * 4})
    assert r.status_code == 400


def test_login_wrong_password_401(client, session):
    make_user(session, username="bob", password="rightpw" * 2)
    r = client.post("/auth/login", json={"username": "bob", "password": "wrong", "remember": False})
    assert r.status_code == 401


def test_login_remember_30d_exp(client, session):
    make_user(session, username="dave", password="dwpw" * 2)
    r_short = client.post(
        "/auth/login",
        json={"username": "dave", "password": "dwpw" * 2, "remember": False},
    )
    r_long = client.post(
        "/auth/login",
        json={"username": "dave", "password": "dwpw" * 2, "remember": True},
    )
    assert r_short.status_code == 200 and r_long.status_code == 200
    exp_short = auth.decode_access_token(r_short.json()["access_token"]).get("exp", 0)
    exp_long = auth.decode_access_token(r_long.json()["access_token"]).get("exp", 0)
    # remember-me token should expire at least a day after the non-remember token
    assert (exp_long - exp_short) > 3600 * 20


def test_no_remember_uses_configured_expiry_not_unbounded(client, session):
    """Regression: create_access_token must get expires_in=ACCESS_TOKEN_EXPIRE_MINUTES when not remember."""
    from auth import ACCESS_TOKEN_EXPIRE_MINUTES

    make_user(session, username="eve", password="evpw" * 2)
    r = client.post(
        "/auth/login",
        json={"username": "eve", "password": "evpw" * 2, "remember": False},
    )
    t = r.json()["access_token"]
    p = auth.decode_access_token(t)
    now = time.time()
    ttl_sec = p["exp"] - now
    # ~30 min session, allow clock/test skew
    assert 5 * 60 < ttl_sec < (ACCESS_TOKEN_EXPIRE_MINUTES + 5) * 60


def test_access_token_expire_minutes_wired_in_router():
    from routers.auth import ACCESS_TOKEN_EXPIRE_MINUTES

    assert ACCESS_TOKEN_EXPIRE_MINUTES is auth.ACCESS_TOKEN_EXPIRE_MINUTES


def test_rejects_tampered_token():
    t = "a.b.c"
    with pytest.raises(JWTError):
        auth.decode_access_token(t)
