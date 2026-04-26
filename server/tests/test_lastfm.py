import httpx
import pytest


@pytest.mark.asyncio
async def test_lastfm_similar_tracks_mbid_fallback_to_text(monkeypatch):
    """
    If MBID lookup fails / returns no tracks, we should fall back
    to the plain text params (track+artist).
    """
    from services.providers import lastfm

    calls = []

    def _resp(payload, status=200, headers=None):
        req = httpx.Request("GET", "https://ws.audioscrobbler.com/2.0/")
        return httpx.Response(status_code=status, headers=headers or {}, json=payload, request=req)

    async def fake_get(_path, *, params=None, **_kw):
        calls.append(dict(params or {}))
        # First call: mbid attempt returns empty similartracks
        if params and params.get("mbid") == "mbid-123":
            return _resp({"similartracks": {"track": []}})
        # Second call: text attempt returns 2 tracks
        return _resp(
            {
                "similartracks": {
                    "track": [
                        {"name": "Song A", "artist": {"name": "Artist A"}, "match": "0.9", "mbid": ""},
                        {"name": "Song B", "artist": {"name": "Artist B"}, "match": "0.7"},
                    ]
                }
            }
        )

    monkeypatch.setenv("LASTFM_API_KEY", "test_key")
    monkeypatch.setattr(lastfm.LASTFM_CLIENT, "get", fake_get)

    out = await lastfm.track_similar(track="X", artist="Y", track_mbid="mbid-123", limit=2)
    assert len(out) == 2
    assert out[0]["name"] == "Song A"
    assert out[0]["artist"] == "Artist A"
    assert out[0]["match"] == pytest.approx(0.9)
    assert any(c.get("mbid") == "mbid-123" for c in calls)
    assert any(c.get("track") == "X" and c.get("artist") == "Y" for c in calls)


@pytest.mark.asyncio
async def test_lastfm_retries_on_429(monkeypatch):
    from services.providers import lastfm

    seen = {"n": 0}

    def _resp(payload, status=200, headers=None):
        req = httpx.Request("GET", "https://ws.audioscrobbler.com/2.0/")
        return httpx.Response(status_code=status, headers=headers or {}, json=payload, request=req)

    async def fake_get(_path, *, params=None, **_kw):
        seen["n"] += 1
        if seen["n"] == 1:
            return _resp({"error": 29, "message": "Rate limit"}, status=429, headers={"Retry-After": "0"})
        return _resp({"toptracks": {"track": [{"name": "T", "artist": {"name": "A"}}]}})

    async def fast_sleep(_s):
        return None

    monkeypatch.setenv("LASTFM_API_KEY", "test_key")
    monkeypatch.setattr(lastfm.LASTFM_CLIENT, "get", fake_get)
    monkeypatch.setattr(lastfm.asyncio, "sleep", fast_sleep)

    out = await lastfm.artist_top_tracks(artist="A", limit=1)
    assert out and out[0]["name"] == "T"
    assert seen["n"] >= 2


@pytest.mark.asyncio
async def test_lastfm_similar_tracks_fallback_when_empty(monkeypatch):
    from services.providers import lastfm

    def _resp(payload, status=200, headers=None):
        req = httpx.Request("GET", "https://ws.audioscrobbler.com/2.0/")
        return httpx.Response(status_code=status, headers=headers or {}, json=payload, request=req)

    async def fake_get(_path, *, params=None, **_kw):
        method = (params or {}).get("method")
        if method == "track.getsimilar":
            return _resp({"similartracks": {"track": [], "@attr": {}}})
        if method == "artist.getsimilar":
            return _resp({"similarartists": {"artist": [{"name": "Other Artist", "match": "0.9"}]}})
        if method == "artist.gettoptracks":
            return _resp({"toptracks": {"track": [{"name": "Hit", "artist": {"name": "Other Artist"}}]}})
        return _resp({})

    monkeypatch.setenv("LASTFM_API_KEY", "test_key")
    monkeypatch.setattr(lastfm.LASTFM_CLIENT, "get", fake_get)

    out = await lastfm.track_similar(track="Library Thugs", artist="Jonas Aden", limit=5)
    assert out
    assert any(t.get("name") == "Hit" for t in out)

