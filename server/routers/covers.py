import json
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlmodel import Session

from database import engine
from deps import get_current_user
from models import User
from services.covers import (
    get_cover_url,
    get_cover_urls_batch,
    iter_cover_urls_batch,
    lookup_cached_covers_batch,
)
from services.providers import _db_get, _get_artist_images_dir

_CACHE_DIR = os.environ.get("CACHE_DIR") or str(Path(__file__).parent.parent.parent / "cache")

router = APIRouter(prefix="/covers", tags=["covers"])


class CoverResponse(BaseModel):
    url: str | None = None


class CoverBatchRequest(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=2000)


class CoverBatchResponse(BaseModel):
    urls: dict[str, str | None]


@router.get("/recordings/{recording_mbid}", response_model=CoverResponse)
async def get_recording_cover(recording_mbid: str, user: User = Depends(get_current_user)):
    r = await get_cover_url("recording", recording_mbid)
    return CoverResponse(url=r.url)


@router.get("/release-groups/{rg_mbid}", response_model=CoverResponse)
async def get_release_group_cover(rg_mbid: str, user: User = Depends(get_current_user)):
    r = await get_cover_url("release_group", rg_mbid)
    return CoverResponse(url=r.url)


@router.get("/releases/{release_mbid}", response_model=CoverResponse)
async def get_release_cover(release_mbid: str, user: User = Depends(get_current_user)):
    r = await get_cover_url("release", release_mbid)
    return CoverResponse(url=r.url)


async def _stream_ndjson(entity_kind, ids: list[str]):
    async for eid, url in iter_cover_urls_batch(entity_kind, ids):
        yield (json.dumps({"id": eid, "url": url}) + "\n").encode("utf-8")


# NOTE: behind nginx, this route needs `proxy_buffering off` so per-id NDJSON
# lines reach the browser as they're emitted, not after the whole batch
# finishes. No GZipMiddleware is installed (see server/main.py); if added,
# disable for this route too.
@router.post("/recordings")
async def batch_recording_covers(body: CoverBatchRequest, user: User = Depends(get_current_user)):
    return StreamingResponse(
        _stream_ndjson("recording", body.ids),
        media_type="application/x-ndjson",
    )


@router.post("/release-groups")
async def batch_release_group_covers(body: CoverBatchRequest, user: User = Depends(get_current_user)):
    return StreamingResponse(
        _stream_ndjson("release_group", body.ids),
        media_type="application/x-ndjson",
    )


@router.post("/recordings/cached", response_model=CoverBatchResponse)
def cached_recording_covers(body: CoverBatchRequest, user: User = Depends(get_current_user)):
    """DB-only batch lookup. Returns immediately with cached URLs;
    ids absent from the response indicate a cache miss the caller must resolve
    via the streaming endpoint.
    """
    with Session(engine) as session:
        urls = lookup_cached_covers_batch(session, entity_kind="recording", ids=body.ids)
    return CoverBatchResponse(urls=urls)


@router.post("/release-groups/cached", response_model=CoverBatchResponse)
def cached_release_group_covers(body: CoverBatchRequest, user: User = Depends(get_current_user)):
    with Session(engine) as session:
        urls = lookup_cached_covers_batch(session, entity_kind="release_group", ids=body.ids)
    return CoverBatchResponse(urls=urls)


@router.post("/recordings/eager", response_model=CoverBatchResponse, include_in_schema=False)
async def batch_recording_covers_eager(body: CoverBatchRequest, user: User = Depends(get_current_user)):
    """Legacy non-streaming batch — kept for any internal callers."""
    urls = await get_cover_urls_batch("recording", body.ids)
    return CoverBatchResponse(urls=urls)


@router.get("/local/{filename}")
async def get_local_cover(filename: str):
    if "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = os.path.join(_CACHE_DIR, "covers", filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Cover not found")
    media_type = "image/png" if filename.endswith(".png") else "image/jpeg"
    return FileResponse(path, media_type=media_type)


@router.get("/artist-local/{artist_id}/{kind}/{idx}")
async def get_artist_local_image(artist_id: str, kind: str, idx: int):
    """Serve a locally cached artist image by index."""
    if kind not in ("banner", "thumb"):
        raise HTTPException(status_code=400, detail="kind must be 'banner' or 'thumb'")

    local = _db_get("cover_artist_local", artist_id)
    if not local:
        raise HTTPException(status_code=404, detail="No local images for this artist")

    paths = local.get(f"{kind}_paths") or ([local[f"{kind}_path"]] if local.get(f"{kind}_path") else [])
    if idx >= len(paths) or not paths[idx]:
        raise HTTPException(status_code=404, detail=f"No local {kind} at index {idx}")

    filepath = os.path.join(_get_artist_images_dir(), os.path.basename(paths[idx]))
    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="Image file not found")

    media_type = "image/png" if filepath.endswith(".png") else "image/jpeg"
    return FileResponse(filepath, media_type=media_type)

