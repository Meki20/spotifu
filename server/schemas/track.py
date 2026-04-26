from pydantic import BaseModel

from models import TrackStatus


class DownloadedTrackListItem(BaseModel):
    """Row for /settings/tracks (downloaded track management)."""
    id: int
    title: str
    artist: str
    artist_credit: str | None = None
    album: str
    status: TrackStatus
    local_file_path: str | None
    mb_id: str | None


class DownloadedTracksListResponse(BaseModel):
    """Response for GET /settings/tracks."""
    tracks: list[DownloadedTrackListItem]


class TrackOut(BaseModel):
    mb_id: str
    track_id: int | None = None
    title: str
    artist: str
    artist_credit: str | None = None
    album: str
    album_cover: str | None = None
    preview_url: str | None = None
    duration: int = 0
    is_cached: bool = False
    local_stream_url: str | None = None
    mb_release_id: str | None = None
    mb_release_group_id: str | None = None
    mb_artist_id: str | None = None
    release_date: str | None = None
    genre: str | None = None