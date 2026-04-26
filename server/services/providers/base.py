from typing import Protocol, runtime_checkable, Any

@runtime_checkable
class MetadataProvider(Protocol):
    """Structural type for metadata providers.

    Each concrete provider implements:
      - source: str  — provider identifier ("musicbrainz")
      - supports_download: bool
      - search(query) -> list[dict]
      - resolve_id(title, artist, album) -> str | None
      - get_track(track_id) -> dict | None
      - get_artist(artist_id) -> dict | None
      - get_album(album_id) -> dict | None
    """

    @property
    def source(self) -> str: ...

    @property
    def supports_download(self) -> bool: ...

    async def search(self, query: str) -> list[dict[str, Any]]: ...

    async def resolve_id(self, title: str, artist: str, album: str | None = None) -> str | None: ...

    async def get_track(self, track_id: str) -> dict[str, Any] | None: ...

    async def get_artist(self, artist_id: str) -> dict[str, Any] | None: ...

    async def get_album(self, album_id: str) -> dict[str, Any] | None: ...