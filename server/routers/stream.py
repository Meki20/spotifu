import asyncio
import hashlib
from fastapi import APIRouter, HTTPException, Depends, Request
from fastapi.responses import StreamingResponse, Response
from sqlmodel import Session
from database import get_session
from models import Track
from services.soulseek import get_inflight_path, get_inflight_filesize
import os

router = APIRouter(prefix="/stream", tags=["stream"])


MIME_MAP = {
    ".flac": "audio/flac",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
}


def _weak_etag(file_path: str) -> str:
    """Compute a weak ETag from file path + mtime + size."""
    try:
        st = os.stat(file_path)
        raw = f"{file_path}:{st.st_mtime}:{st.st_size}".encode()
        return f'W/"{hashlib.md5(raw).hexdigest()}"'
    except OSError:
        return 'W/"0"'


def _guess_mime(file_path: str) -> str:
    ext = os.path.splitext(file_path)[1].lower()
    return MIME_MAP.get(ext, "application/octet-stream")


async def _stream_growing(file_path: str, start: int, track_id: int):
    """Stream a growing file from `start`, polling for new bytes until download completes."""
    CHUNK = 65536
    POLL_INTERVAL = 0.05  # seconds between polls when no new bytes
    MAX_SILENCE = 60.0    # give up if no bytes arrive for this long

    silence = 0.0
    try:
        f = open(file_path, "rb")
    except OSError:
        return

    try:
        f.seek(start)
        while True:
            chunk = f.read(CHUNK)
            if chunk:
                silence = 0.0
                yield chunk
            else:
                # No new bytes yet — check if the download is still running
                if get_inflight_path(track_id) != file_path:
                    # Download completed or was replaced; we've read everything there is
                    break
                await asyncio.sleep(POLL_INTERVAL)
                silence += POLL_INTERVAL
                if silence > MAX_SILENCE:
                    break
    finally:
        f.close()


def _stream_file(file_path: str, track_id: int, request: Request, inflight_filesize: int | None = None):
    is_inflight = get_inflight_path(track_id) == file_path
    media_type = _guess_mime(file_path)
    range_header = request.headers.get("range")
    file_size = os.path.getsize(file_path)

    total = inflight_filesize if (is_inflight and inflight_filesize and inflight_filesize > file_size) else file_size

    if is_inflight:
        if range_header:
            range_match = range_header.replace("bytes=", "").split("-")
            start = int(range_match[0]) if range_match[0] else 0

            # Stream from `start` to end of the expected total, holding connection open.
            # Content-Length tells the browser how many bytes to expect total; the async
            # generator delivers them as the file grows on disk.
            return StreamingResponse(
                _stream_growing(file_path, start, track_id),
                status_code=206,
                media_type=media_type,
                headers={
                    "Content-Range": f"bytes {start}-{total - 1}/{total}",
                    "Content-Length": str(total - start),
                    "Accept-Ranges": "bytes",
                },
            )

        # No Range header: return 200 with the full expected size so the browser
        # knows the real duration, then stream bytes as they arrive.
        return StreamingResponse(
            _stream_growing(file_path, 0, track_id),
            status_code=200,
            media_type=media_type,
            headers={
                "Content-Length": str(total),
                "Accept-Ranges": "bytes",
            },
        )

    # Complete file — standard range-aware serving
    if range_header:
        range_match = range_header.replace("bytes=", "").split("-")
        start = int(range_match[0]) if range_match[0] else 0
        end = int(range_match[1]) if range_match[1] else file_size - 1
        end = min(end, file_size - 1)

        if start > end:
            raise HTTPException(
                status_code=416,
                detail="Range Not Satisfiable",
                headers={"Content-Range": f"bytes */{file_size}"},
            )

        length = end - start + 1

        def file_iter(s: int, e: int):
            remaining = e - s + 1
            with open(file_path, "rb") as f:
                f.seek(s)
                while remaining > 0:
                    chunk = f.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            file_iter(start, end),
            status_code=206,
            media_type=media_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{total}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
            },
        )

    def file_iter_full():
        with open(file_path, "rb") as f:
            while chunk := f.read(1024 * 1024):
                yield chunk

    return StreamingResponse(
        file_iter_full(),
        status_code=200,
        media_type=media_type,
        headers={"Accept-Ranges": "bytes", "Content-Length": str(file_size)},
    )


@router.get("/{track_id}")
async def stream(track_id: int, request: Request, session: Session = Depends(get_session)):
    track = session.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    file_path = track.local_file_path
    if not file_path:
        file_path = get_inflight_path(track_id)

    if not file_path or not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Track not available")

    etag = _weak_etag(file_path)
    if_none_match = request.headers.get("if-none-match")
    if if_none_match and if_none_match == etag:
        return Response(status_code=304)

    inflight_filesize = get_inflight_filesize(track_id)
    response = _stream_file(file_path, track_id, request, inflight_filesize=inflight_filesize)
    response.headers["Cache-Control"] = "private, max-age=3600"
    response.headers["ETag"] = etag
    return response
