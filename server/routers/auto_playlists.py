from datetime import datetime
import random
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from sqlmodel import Session, select, delete, func
from database import get_session
from deps import get_current_user
from models import AutoPlaylistDefinition, AutoPlaylistTrack, User, Track
from services.auto_playlist import generate_hottest_tracks, generate_tag_mix
from services.auto_playlist_covers import generate_playlist_cover


router = APIRouter(prefix="/auto-playlists", tags=["auto-playlists"])


class AutoPlaylistDefinitionOut(BaseModel):
    id: int
    name: str
    playlist_type: str
    is_enabled: bool
    last_generated_at: datetime | None
    created_at: datetime
    track_count: int = 0
    cover_url: str


class AutoPlaylistTrackOut(BaseModel):
    id: int
    position: int
    title: str
    artist: str
    album: str | None
    mb_recording_id: str | None
    hotness_score: float


class AutoPlaylistToggle(BaseModel):
    is_enabled: bool


def _get_or_create_definition(session: Session, user_id: int, playlist_type: str) -> AutoPlaylistDefinition:
    stmt = select(AutoPlaylistDefinition).where(
        AutoPlaylistDefinition.user_id == user_id,
        AutoPlaylistDefinition.playlist_type == playlist_type
    )
    definition = session.exec(stmt).first()
    
    if not definition:
        name_map = {
            "hottest_tracks": "Your Hottest Tracks",
            "weekly_discovery": "Weekly Discovery",
        }
        definition = AutoPlaylistDefinition(
            user_id=user_id,
            name=name_map.get(playlist_type, playlist_type),
            playlist_type=playlist_type,
        )
        session.add(definition)
        session.commit()
        session.refresh(definition)
    
    return definition


@router.get("", response_model=list[AutoPlaylistDefinitionOut])
def list_auto_playlists(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    # Auto-create definitions if they don't exist
    _ensure_default_definitions(session, current_user.id)
    
    stmt = select(AutoPlaylistDefinition).where(
        AutoPlaylistDefinition.user_id == current_user.id
    )
    definitions = session.exec(stmt).all()
    
    results = []
    for d in definitions:
        count_stmt = select(func.count()).select_from(AutoPlaylistTrack).where(
            AutoPlaylistTrack.definition_id == d.id
        )
        track_count = session.exec(count_stmt).one()
        
        cover_url = d.cover_image or generate_playlist_cover(d.playlist_type)
        
        results.append(AutoPlaylistDefinitionOut(
            id=d.id,
            name=d.name,
            playlist_type=d.playlist_type,
            is_enabled=d.is_enabled,
            last_generated_at=d.last_generated_at,
            created_at=d.created_at,
            track_count=track_count,
            cover_url=cover_url,
        ))
    
    return results


def _ensure_default_definitions(session: Session, user_id: int):
    """Ensure default auto-playlist definitions exist for a user."""
    default_types = ["hottest_tracks", "tag_mix"]
    for playlist_type in default_types:
        stmt = select(AutoPlaylistDefinition).where(
            AutoPlaylistDefinition.user_id == user_id,
            AutoPlaylistDefinition.playlist_type == playlist_type
        )
        existing = session.exec(stmt).first()
        if not existing:
            name_map = {
                "hottest_tracks": "Your Hottest Tracks",
                "tag_mix": "Your Tag Mix",
            }
            definition = AutoPlaylistDefinition(
                user_id=user_id,
                name=name_map.get(playlist_type, playlist_type),
                playlist_type=playlist_type,
                is_enabled=True,
            )
            session.add(definition)
    session.commit()


@router.get("/{playlist_type}/tracks", response_model=list[AutoPlaylistTrackOut])
def get_auto_playlist_tracks(
    playlist_type: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    definition = _get_or_create_definition(session, current_user.id, playlist_type)
    
    if not definition.last_generated_at:
        raise HTTPException(status_code=404, detail="Playlist not yet generated")
    
    stmt = select(AutoPlaylistTrack).where(
        AutoPlaylistTrack.definition_id == definition.id
    ).order_by(AutoPlaylistTrack.position)
    tracks = session.exec(stmt).all()
    
    return [
        AutoPlaylistTrackOut(
            id=t.id,
            position=t.position,
            title=t.title,
            artist=t.artist,
            album=t.album,
            mb_recording_id=t.mb_recording_id,
            hotness_score=t.hotness_score,
        )
        for t in tracks
    ]


@router.get("/detail/{definition_id}")
def get_auto_playlist_detail(
    definition_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    definition = session.get(AutoPlaylistDefinition, definition_id)
    if not definition or definition.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Playlist not found")
    
    if not definition.last_generated_at:
        raise HTTPException(status_code=404, detail="Playlist not yet generated")
    
    stmt = select(AutoPlaylistTrack).where(
        AutoPlaylistTrack.definition_id == definition_id
    ).order_by(AutoPlaylistTrack.position)
    tracks = session.exec(stmt).all()
    
    cover_url = definition.cover_image or generate_playlist_cover(definition.playlist_type)

    track_ids = [t.track_id for t in tracks if t.track_id is not None]
    duration_by_id: dict[int, int] = {}
    if track_ids:
        for tr in session.exec(select(Track).where(Track.id.in_(track_ids))).all():
            duration_by_id[tr.id] = int(tr.duration or 0)
    
    return {
        "id": definition.id,
        "title": definition.name,
        "description": None,
        "cover_image_url": cover_url,
        "items": [
            {
                "id": t.id,
                "position": t.position,
                "title": t.title,
                "artist": t.artist,
                "album": t.album,
                "mb_recording_id": t.mb_recording_id,
                "mb_artist_id": t.mb_artist_id,
                "mb_release_id": t.mb_release_id,
                "mb_release_group_id": None,
                "album_cover": None,
                "track_id": t.track_id,
                "is_cached": t.track_id is not None and session.get(Track, t.track_id) is not None and session.get(Track, t.track_id).local_file_path is not None,
                "duration": duration_by_id.get(t.track_id, 0) if t.track_id is not None else 0,
            }
            for t in tracks
        ]
    }


@router.post("/{playlist_type}/regenerate")
def regenerate_playlist(
    playlist_type: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if playlist_type not in ["hottest_tracks", "weekly_discovery", "tag_mix"]:
        raise HTTPException(status_code=400, detail="Invalid playlist type")
    
    definition = _get_or_create_definition(session, current_user.id, playlist_type)
    
    def run_generation():
        from database import engine
        from sqlmodel import Session
        with Session(engine) as sess:
            _do_generation(sess, definition.id, playlist_type)
    
    background_tasks.add_task(run_generation)
    
    return {"status": "regeneration_started", "definition_id": definition.id}


def _do_generation(session: Session, definition_id: int, playlist_type: str):
    definition = session.get(AutoPlaylistDefinition, definition_id)
    if not definition:
        return
    
    if playlist_type == "hottest_tracks":
        tracks = generate_hottest_tracks(session, definition.user_id, limit=20)
    elif playlist_type == "tag_mix":
        tracks, playlist_name = generate_tag_mix(session, definition.user_id, limit=20)
    else:
        tracks = []
    
    if not tracks:
        return
    
    if playlist_type == "tag_mix":
        definition.name = playlist_name
    
    delete_stmt = delete(AutoPlaylistTrack).where(
        AutoPlaylistTrack.definition_id == definition_id
    )
    session.exec(delete_stmt)
    
    for track in tracks:
        track.definition_id = definition_id
        session.add(track)
    
    definition.last_generated_at = datetime.utcnow()
    session.commit()


@router.patch("/{playlist_type}/toggle", response_model=AutoPlaylistDefinitionOut)
def toggle_playlist(
    playlist_type: str,
    body: AutoPlaylistToggle,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    definition = _get_or_create_definition(session, current_user.id, playlist_type)
    definition.is_enabled = body.is_enabled
    session.commit()
    session.refresh(definition)
    
    count_stmt = select(func.count()).select_from(AutoPlaylistTrack).where(
        AutoPlaylistTrack.definition_id == definition.id
    )
    track_count = session.exec(count_stmt).one()
    cover_url = definition.cover_image or generate_playlist_cover(playlist_type)
    
    return AutoPlaylistDefinitionOut(
        id=definition.id,
        name=definition.name,
        playlist_type=definition.playlist_type,
        is_enabled=definition.is_enabled,
        last_generated_at=definition.last_generated_at,
        created_at=definition.created_at,
        track_count=track_count,
        cover_url=cover_url,
    )


@router.post("/{playlist_type}/generate")
def generate_playlist(
    playlist_type: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if playlist_type not in ["hottest_tracks", "weekly_discovery", "tag_mix"]:
        raise HTTPException(status_code=400, detail="Invalid playlist type")
    
    definition = _get_or_create_definition(session, current_user.id, playlist_type)
    _do_generation(session, definition.id, playlist_type)
    
    seed = random.randint(1, 9999)
    cover_url = generate_playlist_cover(playlist_type, seed=seed)
    definition.cover_image = cover_url
    session.add(definition)
    session.commit()
    session.refresh(definition)
    
    count_stmt = select(func.count()).select_from(AutoPlaylistTrack).where(
        AutoPlaylistTrack.definition_id == definition.id
    )
    track_count = session.exec(count_stmt).one()
    
    return AutoPlaylistDefinitionOut(
        id=definition.id,
        name=definition.name,
        playlist_type=definition.playlist_type,
        is_enabled=definition.is_enabled,
        last_generated_at=definition.last_generated_at,
        created_at=definition.created_at,
        track_count=track_count,
        cover_url=cover_url,
    )