"""List/page endpoints must not await network cover resolution on the hot path."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from tests.factories import auth_header, make_user, make_track


@pytest.fixture
def auth(client, session):
    make_user(session, username="coveruser", password="password12345")
    return auth_header(client, "coveruser", "password12345")


def test_recently_played_does_not_await_get_cover_url(client, session, auth):
    track = make_track(session, title="Hot Path", artist="Tester")
    track.mb_id = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
    track.album_cover = None
    session.add(track)
    session.commit()
    session.refresh(track)

    from models import User, UserRecentlyPlayed
    from datetime import datetime
    from sqlmodel import select

    user = session.exec(select(User).where(User.username == "coveruser")).first()
    session.add(UserRecentlyPlayed(user_id=user.id, track_id=track.id, played_at=datetime.utcnow()))
    session.commit()

def test_recently_played_does_not_await_get_cover_url(client, session, auth):
    track = make_track(session, title="Hot Path", artist="Tester")
    track.mb_id = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"
    track.album_cover = None
    session.add(track)
    session.commit()
    session.refresh(track)

    from models import User, UserRecentlyPlayed
    from datetime import datetime
    from sqlmodel import select

    user = session.exec(select(User).where(User.username == "coveruser")).first()
    session.add(UserRecentlyPlayed(user_id=user.id, track_id=track.id, played_at=datetime.utcnow()))
    session.commit()

    cover_mock = AsyncMock(
        side_effect=AssertionError("get_cover_url must not run on recently-played hot path"),
    )
    backfill_mock = AsyncMock()
    with patch("services.covers.get_cover_url", cover_mock), patch(
        "services.covers.backfill_track_covers_task",
        backfill_mock,
    ):
        r = client.get("/playlists/recently-played", headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) >= 1
    assert body[0]["title"] == "Hot Path"
    cover_mock.assert_not_called()
    backfill_mock.assert_called_once()


def test_recently_downloaded_does_not_await_get_cover_url(client, session, auth):
    track = make_track(session, title="Downloaded", artist="Tester")
    track.mb_id = "b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22"
    track.album_cover = None
    session.add(track)
    session.commit()

    cover_mock = AsyncMock(
        side_effect=AssertionError("get_cover_url must not run on recently-downloaded hot path"),
    )
    backfill_mock = AsyncMock()
    with patch("services.covers.get_cover_url", cover_mock), patch(
        "services.covers.backfill_track_covers_task",
        backfill_mock,
    ):
        r = client.get("/playlists/recently-downloaded", headers=auth)
    assert r.status_code == 200, r.text
    cover_mock.assert_not_called()
    backfill_mock.assert_called_once()


def test_legacy_search_does_not_hydrate_release_covers(client, session, auth):
    fake_results = [
        {
            "mbid": "c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a33",
            "title": "Find Me",
            "artist": "Tester",
            "album": "Album",
            "mb_release_id": "d1eebc99-9c0b-4ef8-bb6d-6bb9bd380a44",
            "mb_release_group_id": "e1eebc99-9c0b-4ef8-bb6d-6bb9bd380a55",
        }
    ]

    from services.providers import MetadataService

    async def fake_search(self, _q: str):
        return fake_results

    cover_mock = AsyncMock(
        side_effect=AssertionError("get_cover_url must not run on legacy search hot path"),
    )
    with patch.object(MetadataService, "search", fake_search), patch(
        "services.covers.get_cover_url",
        cover_mock,
    ):
        r = client.get("/search", params={"q": "find me"}, headers=auth)
    assert r.status_code == 200, r.text
    tracks = r.json()["tracks"]
    assert len(tracks) == 1
    assert tracks[0]["title"] == "Find Me"
    cover_mock.assert_not_called()
