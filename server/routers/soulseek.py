import asyncio
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from database import engine
from models import Track, TrackStatus, User
from services.download_direct import (
    download_track_direct,
    get_active_downloads,
    get_download_history,
    search_soulseek_direct,
)
from services.soulseek import is_connected
from deps import get_current_user, require_permission, CurrentUser

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/soulseek", tags=["soulseek"])


class SearchQuery(BaseModel):
    query: str
    timeout: float = 30.0


class DownloadRequest(BaseModel):
    username: str
    remote_path: str
    title: str
    artist: str
    album: Optional[str] = ""


class DirectDownloadResponse(BaseModel):
    track_id: int
    status: str
    local_path: Optional[str] = None


@router.get("/status")
def get_soulseek_status(user: CurrentUser = Depends(require_permission("can_use_soulseek"))) -> dict:
    return {
        "connected": is_connected(),
    }


@router.post("/search")
async def search(
    body: SearchQuery,
    user: CurrentUser = Depends(require_permission("can_use_soulseek")),
) -> dict:
    if not is_connected():
        raise HTTPException(status_code=503, detail="Soulseek not connected")

    try:
        results = await search_soulseek_direct(
            body.query,
            timeout=body.timeout,
        )
        return {"results": results}
    except Exception as e:
        logger.error("Soulseek search failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/download", response_model=DirectDownloadResponse)
async def download(
    body: DownloadRequest,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(require_permission("can_use_soulseek")),
) -> DirectDownloadResponse:
    if not is_connected():
        raise HTTPException(status_code=503, detail="Soulseek not connected")

    with Session(engine) as session:
        existing = session.exec(
            select(Track).where(
                Track.title == body.title,
                Track.artist == body.artist,
            )
        ).first()

        if existing:
            logger.info(
                "Track already exists: %s - %s (id=%d)",
                body.artist, body.title, existing.id,
            )
            if existing.status == TrackStatus.READY:
                return DirectDownloadResponse(
                    track_id=existing.id,
                    status="already_exists",
                    local_path=existing.local_file_path,
                )
            elif existing.status == TrackStatus.FETCHING:
                return DirectDownloadResponse(
                    track_id=existing.id,
                    status="already_fetching",
                )

        track = Track(
            title=body.title,
            artist=body.artist,
            album=body.album or "",
            artist_credit=body.artist,
            status=TrackStatus.FETCHING,
            local_file_path=None,
            added_at=datetime.utcnow(),
            last_played_at=datetime.utcnow(),
            duration=0,
        )
        session.add(track)
        session.commit()
        session.refresh(track)
        track_id = track.id
        logger.info("Created direct download track: id=%d title=%r artist=%r", track_id, body.title, body.artist)

    background_tasks.add_task(
        download_track_direct,
        track_id,
        body.username,
        body.remote_path,
        body.title,
        body.artist,
        body.album or "",
    )

    return DirectDownloadResponse(
        track_id=track_id,
        status="started",
    )


@router.get("/downloads")
def get_downloads(user: CurrentUser = Depends(require_permission("can_use_soulseek"))) -> dict:
    return {
        "active": get_active_downloads(),
        "recent": get_download_history(),
    }