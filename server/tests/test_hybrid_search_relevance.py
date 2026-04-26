"""Unit tests for MB-only hybrid search helpers (no network)."""

from services.hybrid_search import (
    _normalize,
    _query_match_row,
    _score_row,
    build_lucene_query_for_pairs,
    get_artist_recording_pairs,
    lucene_escape_phrase,
)


def test_lucene_escape_phrase() -> None:
    assert lucene_escape_phrase('foo"bar') == 'foo\\"bar'
    assert lucene_escape_phrase("a\\b") == "a\\\\b"
    assert lucene_escape_phrase("") == ""


def test_get_artist_recording_pairs_two_words() -> None:
    pairs = get_artist_recording_pairs("adele hello")
    assert ("adele", "hello") in pairs
    assert ("hello", "adele") in pairs
    assert len(pairs) == 2


def test_get_artist_recording_pairs_three_words() -> None:
    pairs = get_artist_recording_pairs("kanye flashing lights")
    assert ("kanye", "flashing lights") in pairs
    assert ("flashing lights", "kanye") in pairs
    assert ("kanye flashing", "lights") in pairs
    assert ("lights", "kanye flashing") in pairs
    assert len(pairs) == 4


def test_get_artist_recording_pairs_single_word() -> None:
    assert get_artist_recording_pairs("adele") == []


def test_build_lucene_query_for_pairs() -> None:
    pairs = [("kanye", "flashing lights"), ("flashing lights", "kanye")]
    q = build_lucene_query_for_pairs(pairs)
    assert 'artist:"kanye"' in q
    assert 'recording:"flashing lights"' in q
    assert ' OR ' in q


def test_build_lucene_query_escapes_quotes() -> None:
    pairs = [('artist "name"', "song")]
    q = build_lucene_query_for_pairs(pairs)
    assert '\\"' in q


def test_score_row_higher_for_better_match() -> None:
    good = {"title": "Flashing Lights", "artist": "Kanye West", "mb_score": 100}
    bad = {"title": "Other Song", "artist": "Other Artist", "mb_score": 50}
    assert _score_row("kanye flashing lights", good) > _score_row("kanye flashing lights", bad)


def test_score_row_nonzero() -> None:
    row = {"title": "Hey Jude", "artist": "The Beatles", "album": "", "mb_score": 70}
    assert _score_row("beatles hey jude", row) > 0.3


def test_normalize_strips_feat() -> None:
    assert _normalize("Song (feat. Someone)") == "song"
    assert _normalize("Track ft. Other") == "track"
