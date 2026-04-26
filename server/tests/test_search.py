from tests.factories import auth_header, make_user, make_track
from models import TrackStatus


def test_empty_query_422_for_search_and_hybrid(client, session):
    make_user(session, username="s1", password="p1" * 4)
    h = auth_header(client, "s1", "p1" * 4)
    for path in ("/search?q=", "/search/hybrid?q="):
        r = client.get(path, headers=h)
        assert r.status_code == 422, path
    r2 = client.get("/search?local=1", headers=h)  # missing q
    assert r2.status_code == 422


def test_local_search_respects_local_limit(client, session):
    make_user(session, username="s2", password="p2" * 4)
    h = auth_header(client, "s2", "p2" * 4)
    for i in range(3):
        make_track(
            session,
            title=f"hello song {i}",
            artist="LocalArtist",
            status=TrackStatus.READY,
        )
    r = client.get(
        "/search?q=hello&local=1&local_limit=2",
        headers=h,
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["tracks"]) <= 2
