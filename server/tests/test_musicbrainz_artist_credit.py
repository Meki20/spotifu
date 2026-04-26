from services.providers import musicbrainz


def test_artist_credit_string_joins_names_by_comma() -> None:
    recording = {
        "artist-credit": [
            {"name": "DECO*27", "joinphrase": " & ", "artist": {"name": "DECO*27"}},
            {"name": "TeddyLoid", "artist": {"name": "TeddyLoid"}},
        ]
    }
    assert musicbrainz._artist_credit_string(recording) == "DECO*27, TeddyLoid"


def test_artist_credit_string_dedupes_exact_names() -> None:
    recording = {
        "artist-credit": [
            {"name": "A", "artist": {"name": "A"}},
            {"name": "A", "artist": {"name": "A"}},
            {"name": "B", "artist": {"name": "B"}},
        ]
    }
    assert musicbrainz._artist_credit_string(recording) == "A, B"
