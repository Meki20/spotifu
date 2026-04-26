"""Test fixtures: SQLite in-memory DB, no PostgreSQL migrate, no startup reconcile I/O."""
from __future__ import annotations

import os
import tempfile
from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine

# Must be set before any import of services.reconcile or auth
os.environ.setdefault("JWT_SECRET", "test_jwt_secret_value_minimum_32_chars_xxx")
if len(os.environ["JWT_SECRET"]) < 32:
    raise RuntimeError("JWT_SECRET for tests must be at least 32 characters")

_secrets: str
with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
    _secrets = f.name
with open(_secrets, "w", encoding="utf-8") as f:
    f.write("{}")

_fdb, _dbpath = tempfile.mkstemp(suffix=".db")
os.close(_fdb)
os.environ["DATABASE_URL"] = f"sqlite:///{_dbpath.replace(os.sep, '/')}"
os.environ["SECRETS_FILE"] = _secrets

import database  # noqa: E402
from sqlalchemy import event

_test_engine = create_engine(
    os.environ["DATABASE_URL"],
    connect_args={"check_same_thread": False},
    echo=False,
)

@event.listens_for(_test_engine, "connect", propagate=True)
def _set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
    try:
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
    except (AttributeError, OSError, RuntimeError, TypeError):
        return
    else:
        cur.close()


def _test_create_db() -> None:
    import models  # noqa: F401 — register all model tables
    SQLModel.metadata.create_all(_test_engine)


database.engine = _test_engine
database.create_db = _test_create_db

# Skip heavy / network startup reconciliation
import services.reconcile as _reconcile  # noqa: E402


def _noop_stuck() -> None:
    return


async def _noop_provider() -> None:
    return


_reconcile.reconcile_stuck_tracks = _noop_stuck
_reconcile.reconcile_provider_ids = _noop_provider

import main  # noqa: E402
import limiter as _limiter_mod  # noqa: E402
from database import get_session  # noqa: E402

app = main.app

# Full suite would exceed 10/min on /auth; disable while testing
_limiter_mod.limiter.enabled = False


@pytest.fixture
def session() -> Generator[Session, None, None]:
    _test_create_db()
    with Session(_test_engine) as s:
        yield s
    # Fresh schema next time
    SQLModel.metadata.drop_all(_test_engine)


@pytest.fixture
def client(session: Session) -> Generator[TestClient, None, None]:
    def _override_get_session() -> Generator[Session, None, None]:
        yield session

    app.dependency_overrides[get_session] = _override_get_session
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
