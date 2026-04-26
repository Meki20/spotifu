import asyncio

import pytest

from services.playlist_import import _query_normalized, parse_csv_upload


class _Upload:
    def __init__(self, data: bytes):
        self._data = data

    async def read(self) -> bytes:
        return self._data


def test_parse_csv_upload_spotify_columns() -> None:
    csv_bytes = (
        b"\xef\xbb\xbfTrack Name,Album Name,Artist Name(s)\n"
        b"Flashing Lights,Graduation,Kanye West\n"
        b"ALL THE LOVE,BULLY,Ye\n"
    )
    rows = asyncio.run(parse_csv_upload(_Upload(csv_bytes)))  # type: ignore[arg-type]
    assert len(rows) == 2
    assert rows[0].title == "Flashing Lights"
    assert rows[0].artist == "Kanye West"
    assert rows[0].album == "Graduation"


def test_query_normalized_stable() -> None:
    q1 = _query_normalized("Kanye West", "Flashing Lights (feat. Dwele)", "Graduation")
    q2 = _query_normalized("kanye west", "flashing lights", "graduation")
    assert q1 == q2

