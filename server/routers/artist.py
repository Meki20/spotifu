from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session
from database import get_session
from deps import get_current_user
from models import User
from services.providers import MetadataService
from services.providers import musicbrainz
from services.providers.musicbrainz import _caa_release_group_front_url, CAA_SIZE_LIST
router = APIRouter(prefix="/artist", tags=["artist"])


class ImageIndexUpdate(BaseModel):
    banner_idx: int | None = None
    picture_idx: int | None = None


def _ddg_image_urls(ddg_payload: dict | None) -> list[str]:
    """Normalize DDG cache payload: list may be missing or null in JSON; single thumb is valid."""
    if not ddg_payload or not isinstance(ddg_payload, dict):
        return []
    out: list[str] = []
    urls = ddg_payload.get("urls")
    if isinstance(urls, list):
        out.extend(str(u) for u in urls if u)
    thumb = ddg_payload.get("thumb")
    if thumb and str(thumb) not in out:
        out.append(str(thumb))
    return out


def _all_banners(artist_id: str, artist_name: str | None = None) -> list[str]:
    banners: list[str] = []
    seen = set()

    def add(urls: list[str]):
        for u in urls:
            if u and u not in seen:
                seen.add(u)
                banners.append(u)

    # fanart.tv (cache key: cover_fanart_artist)
    ft = _get_cache("cover_fanart_artist", artist_id)
    if ft:
        add(ft.get("banners", []))

    # audiodb (cache key: cover_audiodb_artist)
    adb = _get_cache("cover_audiodb_artist", artist_id)
    if adb:
        add(adb.get("banners", []))

    # ddg banners (cache key: cover_ddg_banner, keyed by artist name)
    if artist_name:
        ddg_b = _get_cache("cover_ddg_banner", artist_name)
        add(_ddg_image_urls(ddg_b))

    return banners


def _all_thumbs(artist_id: str, artist_name: str | None = None) -> list[str]:
    thumbs: list[str] = []
    seen = set()

    def add(urls: list[str]):
        for u in urls:
            if u and u not in seen:
                seen.add(u)
                thumbs.append(u)

    ft = _get_cache("cover_fanart_artist", artist_id)
    if ft:
        add(ft.get("thumbs", []))

    adb = _get_cache("cover_audiodb_artist", artist_id)
    if adb:
        add(adb.get("thumbs", []))

    if artist_name:
        ddg_t = _get_cache("cover_ddg_thumb", artist_name)
        add(_ddg_image_urls(ddg_t))

    return thumbs


def _get_cache(kind: str, key: str):
    from services.providers import _db_get
    return _db_get(kind, key)


def _save_idx(artist_id: str, banner_idx: int, picture_idx: int):
    from services.providers import _db_set
    _db_set("artist_image_idx", artist_id, {"banner_idx": banner_idx, "picture_idx": picture_idx})


def _load_idx(artist_id: str) -> tuple[int, int]:
    idx = _get_cache("artist_image_idx", artist_id) or {}
    return idx.get("banner_idx", 0), idx.get("picture_idx", 0)


@router.get("/{artist_id}/images")
async def get_artist_images(
    artist_id: str,
    artist_name: str | None = Query(default=None),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    banner_idx, picture_idx = _load_idx(artist_id)

    artist_name = (artist_name or "").strip() or None
    head = _get_cache("artist_head", artist_id)
    if isinstance(head, dict) and (head.get("name") or "").strip():
        artist_name = artist_name or (head.get("name") or "").strip()

    svc = MetadataService(session)
    if not artist_name:
        async with musicbrainz.mb_interactive_calls():
            mb = await svc.get_artist_head(artist_id)
        if mb and (mb.get("name") or "").strip():
            artist_name = (mb.get("name") or "").strip()

    if artist_name:
        await svc.load_artist_visuals(artist_id, artist_name=artist_name)

    banners = _all_banners(artist_id, artist_name)
    thumbs = _all_thumbs(artist_id, artist_name)

    return {
        "banners": banners,
        "thumbs": thumbs,
        "banner_idx": banner_idx,
        "picture_idx": picture_idx,
        "banner": banners[banner_idx] if banners and banner_idx < len(banners) else (banners[0] if banners else None),
        "thumb": thumbs[picture_idx] if thumbs and picture_idx < len(thumbs) else (thumbs[0] if thumbs else None),
    }


@router.patch("/{artist_id}/images")
async def update_artist_images(
    artist_id: str,
    body: ImageIndexUpdate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    artist_name: str | None = None
    head = _get_cache("artist_head", artist_id)
    if isinstance(head, dict) and (head.get("name") or "").strip():
        artist_name = (head.get("name") or "").strip()

    svc = MetadataService(session)
    if not artist_name:
        async with musicbrainz.mb_interactive_calls():
            mb = await svc.get_artist_head(artist_id)
        if mb and (mb.get("name") or "").strip():
            artist_name = (mb.get("name") or "").strip()

    if artist_name:
        await svc.load_artist_visuals(artist_id, artist_name=artist_name)

    banners = _all_banners(artist_id, artist_name)
    thumbs = _all_thumbs(artist_id, artist_name)

    banner_idx, picture_idx = _load_idx(artist_id)

    if body.banner_idx is not None and banners:
        banner_idx = max(0, min(body.banner_idx, len(banners) - 1))
    if body.picture_idx is not None and thumbs:
        picture_idx = max(0, min(body.picture_idx, len(thumbs) - 1))

    _save_idx(artist_id, banner_idx, picture_idx)

    return {
        "banner_idx": banner_idx,
        "picture_idx": picture_idx,
        "banner": banners[banner_idx] if banners else None,
        "thumb": thumbs[picture_idx] if thumbs else None,
    }


@router.get("/{artist_id}/albums")
async def get_artist_albums(
    artist_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    svc = MetadataService(session)
    async with musicbrainz.mb_interactive_calls():
        albums = await svc.get_artist_albums(artist_id)
    return {"albums": albums}


@router.get("/{artist_id}/albums/{rg_id}/cover")
async def get_album_cover(
    artist_id: str,
    rg_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    cover = await _caa_release_group_front_url(rg_id, CAA_SIZE_LIST)
    return {"cover": cover}


@router.get("/{artist_id}")
async def get_artist(
    artist_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    svc = MetadataService(session)
    async with musicbrainz.mb_interactive_calls():
        data = await svc.get_artist_head(artist_id)
    if not data:
        raise HTTPException(status_code=404, detail="Artist not found")
    data["top_tracks"] = []
    return data