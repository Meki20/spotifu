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
engine = create_engine(DATABASE_URL, echo=False, pool_pre_ping=True)


def create_db():
    SQLModel.metadata.create_all(engine)
    _migrate()


def _migrate():
    migrations = [
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS artist_credit VARCHAR",
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS mb_artist_id VARCHAR",
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS mb_release_id VARCHAR",
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS mb_release_group_id VARCHAR",
        "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS artist_credit VARCHAR",
        "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_artist_id VARCHAR",
        "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_release_id VARCHAR",
        "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS mb_release_group_id VARCHAR",
        "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS preview_url VARCHAR",
        "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS release_date VARCHAR",
        "ALTER TABLE tracks ADD COLUMN IF NOT EXISTS genre VARCHAR",
        "ALTER TABLE playlists ADD COLUMN IF NOT EXISTS description VARCHAR",
        "ALTER TABLE playlists ADD COLUMN IF NOT EXISTS cover_image_url VARCHAR",
        "DROP TABLE IF EXISTS playlist_tracks CASCADE",
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMP",
        "UPDATE mb_lookup_cache SET fetched_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE fetched_at IS NULL",
        "CREATE INDEX IF NOT EXISTS ix_tracks_status_added_at ON tracks (status, added_at)",
        "CREATE INDEX IF NOT EXISTS ix_mb_lookup_fetched_at ON mb_lookup_cache (fetched_at)",
        """
        CREATE TABLE IF NOT EXISTS playlist_import_jobs (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
            base_position INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
            status VARCHAR NOT NULL DEFAULT 'running',
            total INTEGER NOT NULL DEFAULT 0,
            matched INTEGER NOT NULL DEFAULT 0,
            unmatched INTEGER NOT NULL DEFAULT 0,
            errored INTEGER NOT NULL DEFAULT 0,
            error_summary VARCHAR
        )
        """,
        "ALTER TABLE playlist_import_jobs ADD COLUMN IF NOT EXISTS base_position INTEGER NOT NULL DEFAULT 0",
        "CREATE INDEX IF NOT EXISTS ix_playlist_import_jobs_user_id ON playlist_import_jobs (user_id)",
        "CREATE INDEX IF NOT EXISTS ix_playlist_import_jobs_playlist_id ON playlist_import_jobs (playlist_id)",
        "CREATE INDEX IF NOT EXISTS ix_playlist_import_jobs_created_at ON playlist_import_jobs (created_at)",
        "CREATE INDEX IF NOT EXISTS ix_playlist_import_jobs_status ON playlist_import_jobs (status)",
        """
        CREATE TABLE IF NOT EXISTS playlist_import_rows (
            id SERIAL PRIMARY KEY,
            job_id INTEGER NOT NULL REFERENCES playlist_import_jobs(id) ON DELETE CASCADE,
            row_index INTEGER NOT NULL,
            desired_position INTEGER NOT NULL DEFAULT 0,
            title VARCHAR NOT NULL DEFAULT '',
            artist VARCHAR NOT NULL DEFAULT '',
            album VARCHAR NOT NULL DEFAULT '',
            query_normalized VARCHAR NOT NULL DEFAULT '',
            state VARCHAR NOT NULL DEFAULT 'unmatched',
            mb_recording_id VARCHAR,
            confidence DOUBLE PRECISION,
            phase VARCHAR,
            details_json VARCHAR,
            error VARCHAR
        )
        """,
        "ALTER TABLE playlist_import_rows ADD COLUMN IF NOT EXISTS desired_position INTEGER NOT NULL DEFAULT 0",
        "CREATE INDEX IF NOT EXISTS ix_playlist_import_rows_job_id ON playlist_import_rows (job_id)",
        "CREATE INDEX IF NOT EXISTS ix_playlist_import_rows_row_index ON playlist_import_rows (row_index)",
        "CREATE INDEX IF NOT EXISTS ix_playlist_import_rows_desired_position ON playlist_import_rows (desired_position)",
        "CREATE INDEX IF NOT EXISTS ix_playlist_import_rows_query_normalized ON playlist_import_rows (query_normalized)",
        "CREATE INDEX IF NOT EXISTS ix_playlist_import_rows_state ON playlist_import_rows (state)",
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences_json VARCHAR(32768)",
    ]
    with engine.connect() as conn:
        for sql in migrations:
            conn.execute(text(sql))
        conn.commit()


def get_session():
    with Session(engine) as session:
        yield session