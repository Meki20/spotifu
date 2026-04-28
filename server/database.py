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
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS related_mb_ids VARCHAR",
        "ALTER TABLE mb_lookup_cache ADD COLUMN IF NOT EXISTS top_mb_ids VARCHAR",
        "DELETE FROM mb_entity_cache WHERE kind = 'similar_tracks'",
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
        # ------------------------------------------------------------------
        # Normalized cover cache (deduplicated URLs + entity links)
        # ------------------------------------------------------------------
        """
        CREATE TABLE IF NOT EXISTS cover_assets (
            id BIGSERIAL PRIMARY KEY,
            url VARCHAR(4096) NOT NULL UNIQUE,
            created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        )
        """,
        # Existing installs may have cover_assets created via SQLModel without a server default.
        "ALTER TABLE cover_assets ADD COLUMN IF NOT EXISTS created_at TIMESTAMP",
        "UPDATE cover_assets SET created_at = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') WHERE created_at IS NULL",
        "ALTER TABLE cover_assets ALTER COLUMN created_at SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')",
        "ALTER TABLE cover_assets ALTER COLUMN created_at SET NOT NULL",
        """
        CREATE TABLE IF NOT EXISTS cover_links (
            id BIGSERIAL PRIMARY KEY,
            entity_kind VARCHAR(64) NOT NULL,
            entity_id VARCHAR(128) NOT NULL,
            asset_id BIGINT REFERENCES cover_assets(id),
            found BOOLEAN NOT NULL DEFAULT FALSE,
            fetched_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
            CONSTRAINT ux_cover_links_entity UNIQUE (entity_kind, entity_id)
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_cover_links_asset_id ON cover_links (asset_id)",
        "CREATE INDEX IF NOT EXISTS ix_cover_links_kind_fetched_at ON cover_links (entity_kind, fetched_at)",
        # Backfill from MBEntityCache cover kinds (no network calls).
        # Note: payload is JSON string; use jsonb ops to extract url/found.
        """
        WITH src AS (
            SELECT
                kind,
                split_part(key, ':', 2) AS entity_id,
                (payload::jsonb ->> 'url') AS url,
                (payload::jsonb ->> 'found') AS found_str,
                fetched_at
            FROM mb_entity_cache
            WHERE kind IN ('cover_recording', 'cover_release', 'cover_rg')
        ),
        mapped AS (
            SELECT
                CASE
                    WHEN kind = 'cover_recording' THEN 'recording'
                    WHEN kind = 'cover_release' THEN 'release'
                    WHEN kind = 'cover_rg' THEN 'release_group'
                    ELSE kind
                END AS entity_kind,
                entity_id,
                url,
                (found_str = 'true') AS found,
                fetched_at
            FROM src
            WHERE entity_id IS NOT NULL AND entity_id <> ''
        ),
        ins_assets AS (
            INSERT INTO cover_assets (url, created_at)
            SELECT DISTINCT url
                 , (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
            FROM mapped
            WHERE found = TRUE AND url IS NOT NULL AND url <> ''
            ON CONFLICT (url) DO NOTHING
            RETURNING id, url
        ),
        all_assets AS (
            SELECT id, url FROM ins_assets
            UNION ALL
            SELECT id, url FROM cover_assets WHERE url IN (SELECT DISTINCT url FROM mapped WHERE found = TRUE AND url IS NOT NULL AND url <> '')
        )
        INSERT INTO cover_links (entity_kind, entity_id, asset_id, found, fetched_at)
        SELECT
            m.entity_kind,
            m.entity_id,
            a.id,
            m.found,
            COALESCE(m.fetched_at, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))
        FROM mapped m
        LEFT JOIN all_assets a ON a.url = m.url
        ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
            asset_id = EXCLUDED.asset_id,
            found = EXCLUDED.found,
            fetched_at = EXCLUDED.fetched_at
        """,
        # ------------------------------------------------------------------
        # MusicBrainz artist alias cache (mbid anchor + alias rows)
        # ------------------------------------------------------------------
        """
        CREATE TABLE IF NOT EXISTS mb_artists (
            artist_mbid VARCHAR(64) PRIMARY KEY,
            canonical_name VARCHAR(512) NOT NULL,
            sort_name VARCHAR(512),
            source VARCHAR(64) NOT NULL DEFAULT 'musicbrainz',
            is_manual BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
            updated_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
            last_fetched_at TIMESTAMP
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_mb_artists_canonical_name ON mb_artists (canonical_name)",
        "CREATE INDEX IF NOT EXISTS ix_mb_artists_is_manual ON mb_artists (is_manual)",
        "CREATE INDEX IF NOT EXISTS ix_mb_artists_last_fetched_at ON mb_artists (last_fetched_at)",
        """
        CREATE TABLE IF NOT EXISTS mb_artist_aliases (
            id SERIAL PRIMARY KEY,
            alias_norm VARCHAR(512) NOT NULL UNIQUE,
            alias_raw VARCHAR(512),
            artist_mbid VARCHAR(64) NOT NULL REFERENCES mb_artists(artist_mbid) ON DELETE CASCADE,
            source VARCHAR(64) NOT NULL DEFAULT 'musicbrainz',
            is_manual BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
            last_seen_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
        )
        """,
        "CREATE INDEX IF NOT EXISTS ix_mb_artist_aliases_artist_mbid ON mb_artist_aliases (artist_mbid)",
        "CREATE INDEX IF NOT EXISTS ix_mb_artist_aliases_is_manual ON mb_artist_aliases (is_manual)",
        "CREATE INDEX IF NOT EXISTS ix_mb_artist_aliases_last_seen_at ON mb_artist_aliases (last_seen_at)",
        # Source tracking on cover_links: 'musicbrainz' | 'local'
        "ALTER TABLE cover_links ADD COLUMN IF NOT EXISTS source VARCHAR(64) NOT NULL DEFAULT 'musicbrainz'",
    ]
    with engine.connect() as conn:
        for sql in migrations:
            conn.execute(text(sql))
        conn.commit()


def get_session():
    with Session(engine) as session:
        yield session