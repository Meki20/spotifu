import os
import tempfile

from tests.factories import auth_header, make_user, make_track
from models import TrackStatus


def test_range_returns_206_and_etag_304(client, session):
    fd, path = tempfile.mkstemp(suffix=".mp3")
    os.write(fd, b"\x00" * 2000)
    os.close(fd)
    try:
        make_user(session, username="st", password="st" * 4)
        t = make_track(
            session,
            title="x",
            artist="y",
            status=TrackStatus.READY,
            local_path=path,
        )
        h = auth_header(client, "st", "st" * 4)
        r0 = client.get(
            f"/stream/{t.id}",
            headers=h,
        )
        assert r0.status_code == 200, r0.text
        etag = r0.headers.get("etag")
        assert etag

        r1 = client.get(
            f"/stream/{t.id}",
            headers={**h, "range": "bytes=0-99", "if-none-match": ""},
        )
        assert r1.status_code == 206, r1.text
        assert "content-range" in (k.lower() for k in r1.headers.keys()) or "Content-Range" in r1.headers

        r304 = client.get(
            f"/stream/{t.id}",
            headers={**h, "if-none-match": etag},
        )
        assert r304.status_code == 304, r304.text
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def test_stream_404_no_file(client, session):
    u = make_user(session, username="n2", password="n2" * 4)
    t = make_track(session, title="orphan", artist="a", local_path=None)
    h = auth_header(client, "n2", "n2" * 4)
    r = client.get(f"/stream/{t.id}", headers=h)
    assert r.status_code == 404
