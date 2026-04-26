"""Release-group ordering: prefer Album over Single."""

from services.providers.musicbrainz import (
    official_releases_latest_first,
    _release_groups_albums_then_singles,
)


def _rel(rid: str, date: str, primary: str | None, status: str = "Official") -> dict:
    rg = {}
    if primary:
        rg = {"primary-type": primary, "secondary-types": []}
    return {
        "id": rid,
        "date": date,
        "status": status,
        "release-group": rg if primary else {},
    }


def test_official_releases_prefers_album_over_single_same_recording() -> None:
    single_first = _rel("s1", "2020-01-01", "Single")
    album_newer = _rel("a1", "2020-06-01", "Album")
    out = official_releases_latest_first([single_first, album_newer])
    assert [r["id"] for r in out] == ["a1", "s1"]


def test_official_releases_single_when_no_album() -> None:
    s1 = _rel("s1", "2019-01-01", "Single")
    s2 = _rel("s2", "2020-01-01", "Single")
    out = official_releases_latest_first([s1, s2])
    assert [r["id"] for r in out] == ["s2", "s1"]


def test_official_releases_newest_album_first_among_albums() -> None:
    a_old = _rel("a1", "2018-01-01", "Album")
    a_new = _rel("a2", "2021-01-01", "Album")
    out = official_releases_latest_first([a_old, a_new])
    assert [r["id"] for r in out] == ["a2", "a1"]


def test_official_releases_prefers_ep_over_single() -> None:
    ep = _rel("e1", "2019-01-01", "EP")
    s1 = _rel("s1", "2020-01-01", "Single")
    out = official_releases_latest_first([s1, ep])
    assert [r["id"] for r in out] == ["e1", "s1"]


def test_release_groups_album_ep_single_order() -> None:
    from services.providers.musicbrainz import _release_groups_discography_order

    rgs = [
        {"id": "s", "primary-type": "Single", "first-release-date": "2020-01-01"},
        {"id": "e", "primary-type": "EP", "first-release-date": "2019-06-01"},
        {"id": "a", "primary-type": "Album", "first-release-date": "2018-01-01"},
    ]
    out = _release_groups_discography_order(rgs)
    assert [rg["id"] for rg in out] == ["a", "e", "s"]


def test_release_groups_albums_then_singles() -> None:
    rgs = [
        {"id": "1", "primary-type": "Single", "first-release-date": "2020-01-01", "title": "S"},
        {"id": "2", "primary-type": "Album", "first-release-date": "2019-01-01", "title": "A"},
    ]
    out = _release_groups_albums_then_singles(rgs)
    assert [rg["id"] for rg in out] == ["2", "1"]
