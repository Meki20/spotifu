from sqlmodel import select

from tests.factories import auth_header, make_user
from models import Playlist, PlaylistItem, User

_MBID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"


def test_playlist_round_trip_and_user_delete_cascade(client, session):
    make_user(session, username="pl1", password="p1" * 5)
    h = auth_header(client, "pl1", "p1" * 5)
    r1 = client.post(
        "/playlists",
        headers=h,
        json={"title": "T1", "description": "d", "cover_image_url": None},
    )
    assert r1.status_code == 200, r1.text
    pid = r1.json()["id"]

    r2 = client.post(
        f"/playlists/{pid}/items",
        headers=h,
        json={
            "title": "Song",
            "artist": "Art",
            "album": "",
            "mb_recording_id": _MBID,
        },
    )
    assert r2.status_code == 200, r2.text
    item_id = r2.json()["id"]
    n_items = len(
        session.exec(select(PlaylistItem).where(PlaylistItem.playlist_id == pid)).all()
    )
    assert n_items == 1

    r3 = client.delete(
        f"/playlists/{pid}/items/{item_id}",
        headers=h,
    )
    assert r3.status_code == 200
    u = session.exec(select(User).where(User.username == "pl1")).first()
    assert u
    session.delete(u)
    session.commit()

    assert session.exec(select(Playlist).where(Playlist.id == pid)).first() is None
    assert session.exec(select(PlaylistItem).where(PlaylistItem.id == item_id)).first() is None
