import logging
import os

from sqlalchemy import text
from sqlmodel import SQLModel, create_engine, Session
from contextlib import contextmanager

logger = logging.getLogger(__name__)

_DEFAULT_DATABASE_URL = "postgresql://spotifu:spotifu@localhost:5432/spotifu"
DATABASE_URL = os.environ.get("DATABASE_URL") or _DEFAULT_DATABASE_URL
if DATABASE_URL == _DEFAULT_DATABASE_URL:
    logger.warning(
        "DATABASE_URL not set, using built-in dev default. Set DATABASE_URL "
        "explicitly for anything beyond local development."
    )
engine = create_engine(
    DATABASE_URL,
    echo=False,
    pool_pre_ping=True,
    pool_size=20,
    max_overflow=40,
    pool_timeout=30,
)


def create_db():
    SQLModel.metadata.create_all(engine)
    _migrate()


def _migrate():
    migrations = [
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='tracks' AND column_name='genre') THEN
                ALTER TABLE tracks RENAME COLUMN genre TO tags;
            END IF;
        END $$;
        """,
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS artist_credit VARCHAR",
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS mb_artist_id VARCHAR",
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS mb_release_id VARCHAR",
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS mb_release_group_id VARCHAR",
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ix_mb_lookup_cache_mb_id
        ON mb_lookup_cache (mb_id) WHERE mb_id IS NOT NULL
        """,
        """
        DELETE FROM search_history WHERE id NOT IN (
            SELECT MAX(id) FROM search_history
            GROUP BY user_id, query
        )
        """,
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ix_search_history_user_query_unique
        ON search_history (user_id, query)
        """,
    ]
    with engine.connect() as conn:
        for sql in migrations:
            conn.execute(text(sql))
        conn.commit()


def get_session():
    with Session(engine) as session:
        yield session