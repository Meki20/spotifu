"""Reusable test helpers (imported by conftest and test modules)."""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlmodel import Session

from auth import hash_password
from models import Track, User


def make_user(
    session: Session,
    *,
    username: str = "u1",
    password: str = "secret1",
) -> User:
    u = User(username=username, hashed_password=hash_password(password))
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def make_track(
    session: Session,
    *,
    title: str = "T1",
    artist: str = "A1",
    status=None,
    local_path: str | None = None,
) -> Track:
    from models import TrackStatus

    t = Track(
        title=title,
        artist=artist,
        album="Al1",
        status=status or TrackStatus.READY,
        local_file_path=local_path,
    )
    session.add(t)
    session.commit()
    session.refresh(t)
    return t


def auth_header(client: TestClient, username: str, password: str) -> dict[str, str]:
    r = client.post(
        "/auth/login",
        json={"username": username, "password": password, "remember": False},
    )
    r.raise_for_status()
    return {"Authorization": f"Bearer {r.json()['access_token']}"}
