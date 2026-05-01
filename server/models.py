from sqlmodel import SQLModel, Field
from sqlalchemy import Column, Index
from enum import Enum
from typing import Optional
from datetime import datetime


class TrackStatus(str, Enum):
    FETCHING = "FETCHING"
    READY = "READY"
    ERROR = "ERROR"


class User(SQLModel, table=True):
    __tablename__ = "users"
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(unique=True, index=True, max_length=255)
    hashed_password: str = Field(max_length=128)
    preferences_json: Optional[str] = Field(default=None, max_length=32768)
    is_admin: bool = Field(default=False, index=True)


class UserPermission(SQLModel, table=True):
    __tablename__ = "user_permissions"
    user_id: int = Field(foreign_key="users.id", primary_key=True)
    can_play: bool = Field(default=False)
    can_download: bool = Field(default=False)
    can_use_soulseek: bool = Field(default=False)
    can_access_apis: bool = Field(default=False)
    can_view_recently_downloaded: bool = Field(default=False)


class SearchHistory(SQLModel, table=True):
    __tablename__ = "search_history"
    __table_args__ = (
        Index('ix_search_history_user_query_unique', 'user_id', 'query', unique=True),
    )
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    query: str = Field(max_length=512)
    searched_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class UserRecentlyPlayed(SQLModel, table=True):
    __tablename__ = "user_recently_played"
    __table_args__ = (
        Index('ix_user_recently_played_user_track_unique', 'user_id', 'track_id', unique=True),
    )
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    track_id: int = Field(foreign_key="tracks.id")
    played_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    play_amount: int = Field(default=1)


class Track(SQLModel, table=True):
    __tablename__ = "tracks"
    id: Optional[int] = Field(default=None, primary_key=True)
    title: str = Field(index=True, max_length=255)
    artist: str = Field(index=True, max_length=255)
    artist_credit: Optional[str] = Field(default=None, max_length=512)
    album: str = Field(index=True, max_length=255)
    status: TrackStatus = Field(index=True, default=TrackStatus.FETCHING)
    local_file_path: Optional[str] = Field(default=None, max_length=4096)
    quality: Optional[str] = Field(default=None, max_length=64)
    album_cover: Optional[str] = Field(default=None, max_length=4096)
    duration: int = Field(default=0)
    mb_id: Optional[str] = Field(default=None, max_length=64, index=True)
    mb_artist_id: Optional[str] = Field(default=None, max_length=64, index=True)
    mb_release_id: Optional[str] = Field(default=None, max_length=64, index=True)
    mb_release_group_id: Optional[str] = Field(default=None, max_length=64)
    preview_url: Optional[str] = Field(default=None, max_length=2000)
    release_date: Optional[str] = Field(default=None, max_length=64)
    genre: Optional[str] = Field(default=None, max_length=255)
    added_at: Optional[datetime] = Field(default_factory=datetime.utcnow, index=True)
    last_played_at: Optional[datetime] = Field(default=None, index=True)
    __table_args__ = (
        Index("ix_tracks_status_added_at", "status", "added_at"),
    )


class Playlist(SQLModel, table=True):
    __tablename__ = "playlists"
    id: Optional[int] = Field(default=None, primary_key=True)
    title: str = Field(max_length=255)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    description: Optional[str] = Field(default=None, max_length=2000)
    cover_image_url: Optional[str] = Field(default=None, max_length=4096)


class PlaylistItem(SQLModel, table=True):
    __tablename__ = "playlist_items"
    id: Optional[int] = Field(default=None, primary_key=True)
    playlist_id: int = Field(foreign_key="playlists.id", index=True, ondelete="CASCADE")
    position: int = Field(index=True)
    title: str = Field(max_length=255)
    artist: str = Field(max_length=255)
    album: str = Field(default="", max_length=255)
    mb_recording_id: str = Field(index=True, max_length=64)
    mb_artist_id: Optional[str] = Field(default=None, max_length=64, index=True)
    mb_release_id: Optional[str] = Field(default=None, max_length=64, index=True)
    mb_release_group_id: Optional[str] = Field(default=None, max_length=64, index=True)
    album_cover: Optional[str] = Field(default=None, max_length=4096)
    track_id: Optional[int] = Field(default=None, foreign_key="tracks.id", index=True)


class PlaylistImportStatus(str, Enum):
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class PlaylistImportRowState(str, Enum):
    MATCHED = "matched"
    UNMATCHED = "unmatched"
    ERROR = "error"


class PlaylistImportJob(SQLModel, table=True):
    __tablename__ = "playlist_import_jobs"
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    playlist_id: int = Field(foreign_key="playlists.id", index=True, ondelete="CASCADE")
    base_position: int = Field(default=0)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    status: PlaylistImportStatus = Field(default=PlaylistImportStatus.RUNNING, index=True)
    total: int = Field(default=0)
    matched: int = Field(default=0)
    unmatched: int = Field(default=0)
    errored: int = Field(default=0)
    error_summary: Optional[str] = Field(default=None, max_length=4000)


class PlaylistImportRow(SQLModel, table=True):
    __tablename__ = "playlist_import_rows"
    id: Optional[int] = Field(default=None, primary_key=True)
    job_id: int = Field(foreign_key="playlist_import_jobs.id", index=True, ondelete="CASCADE")
    row_index: int = Field(index=True)  # 0-based index in the CSV payload
    desired_position: int = Field(default=0, index=True)
    title: str = Field(default="", max_length=255)
    artist: str = Field(default="", max_length=255)
    album: str = Field(default="", max_length=255)
    query_normalized: str = Field(default="", index=True, max_length=512)
    state: PlaylistImportRowState = Field(default=PlaylistImportRowState.UNMATCHED, index=True)
    mb_recording_id: Optional[str] = Field(default=None, max_length=64, index=True)
    confidence: Optional[float] = Field(default=None)
    phase: Optional[str] = Field(default=None, max_length=255)
    details_json: Optional[str] = Field(default=None, max_length=20000)
    error: Optional[str] = Field(default=None, max_length=4000)


class LibraryAlbumOrder(SQLModel, table=True):
    """Custom ordering of library albums for a user."""
    __tablename__ = "library_album_order"
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True, ondelete="CASCADE")
    album_key: str = Field(index=True, max_length=512)  # "artist|album" to uniquely identify the album
    position: int


class MBLookupCache(SQLModel, table=True):
    __tablename__ = "mb_lookup_cache"
    id: Optional[int] = Field(default=None, primary_key=True)
    query_normalized: str = Field(index=True, unique=True, max_length=512)
    artist: str = Field(max_length=255)
    artist_credit: Optional[str] = Field(default=None, max_length=512)
    title: str = Field(max_length=255)
    album: str = Field(default="", max_length=255)
    mb_id: str = Field(index=True, max_length=64)
    album_cover: Optional[str] = Field(default=None, max_length=4096)
    mb_artist_id: Optional[str] = Field(default=None, max_length=64)
    mb_release_id: Optional[str] = Field(default=None, max_length=64)
    mb_release_group_id: Optional[str] = Field(default=None, max_length=64)
    fetched_at: Optional[datetime] = Field(default=None, index=True)
    related_mb_ids: Optional[str] = Field(default=None)
    top_mb_ids: Optional[str] = Field(default=None)


class MBEntityCache(SQLModel, table=True):
    """Persistent MBID-keyed cache for MB API responses and cover art URLs.

    key format: "{kind}:{mbid}"
    kind values: release | release_group | recording | artist | artist_albums |
                 artist_head | rg_ordered | cover_release | cover_rg
    """
    __tablename__ = "mb_entity_cache"
    key: str = Field(primary_key=True)
    kind: str = Field(index=True)
    payload: str  # JSON blob
    fetched_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    etag: Optional[str] = None


class CoverAsset(SQLModel, table=True):
    __tablename__ = "cover_assets"
    id: Optional[int] = Field(default=None, primary_key=True)
    url: str = Field(unique=True, index=True, max_length=4096)
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


class CoverLink(SQLModel, table=True):
    __tablename__ = "cover_links"
    id: Optional[int] = Field(default=None, primary_key=True)
    entity_kind: str = Field(index=True, max_length=64)
    entity_id: str = Field(index=True, max_length=128)
    asset_id: Optional[int] = Field(default=None, foreign_key="cover_assets.id", index=True)
    found: bool = Field(default=False, index=True)
    fetched_at: datetime = Field(default_factory=datetime.utcnow, index=True)
    source: str = Field(default="musicbrainz", max_length=64)
    __table_args__ = (
        Index("ux_cover_links_entity", "entity_kind", "entity_id", unique=True),
    )


class MbArtist(SQLModel, table=True):
    """MusicBrainz artist identity cache (canonical name + metadata).

    This is intentionally separate from ``tracks``/library concepts: it exists to speed up
    alias normalization and stable artist surface forms across the app.
    """

    __tablename__ = "mb_artists"

    artist_mbid: str = Field(primary_key=True, max_length=64)
    canonical_name: str = Field(max_length=512, index=True)
    sort_name: Optional[str] = Field(default=None, max_length=512)

    source: str = Field(default="musicbrainz", max_length=64)
    is_manual: bool = Field(default=False, index=True)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    last_fetched_at: Optional[datetime] = Field(default=None, index=True)


class MbArtistAlias(SQLModel, table=True):
    """Maps a normalized alias string to a MusicBrainz artist MBID."""

    __tablename__ = "mb_artist_aliases"

    id: Optional[int] = Field(default=None, primary_key=True)
    alias_norm: str = Field(index=True, unique=True, max_length=512)
    alias_raw: Optional[str] = Field(default=None, max_length=512)

    artist_mbid: str = Field(foreign_key="mb_artists.artist_mbid", index=True, max_length=64)

    source: str = Field(default="musicbrainz", max_length=64)
    is_manual: bool = Field(default=False, index=True)

    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_seen_at: datetime = Field(default_factory=datetime.utcnow, index=True)