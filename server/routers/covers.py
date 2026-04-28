import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from deps import get_current_user
from models import User
from services.covers import get_cover_url, get_cover_urls_batch

_CACHE_DIR = os.environ.get("CACHE_DIR") or "/home/lukaarch/Documents/src/SpotiFU/cache"

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


@router.post("/recordings", response_model=CoverBatchResponse)
async def batch_recording_covers(body: CoverBatchRequest, user: User = Depends(get_current_user)):
    urls = await get_cover_urls_batch("recording", body.ids)
    return CoverBatchResponse(urls=urls)


@router.post("/release-groups", response_model=CoverBatchResponse)
async def batch_release_group_covers(body: CoverBatchRequest, user: User = Depends(get_current_user)):
    urls = await get_cover_urls_batch("release_group", body.ids)
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

