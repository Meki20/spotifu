import asyncio
import difflib

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session
from database import get_session
from deps import get_current_user, require_permission, CurrentUser
from models import User
from services.artist_alias_cache import norm_alias, upsert_from_mb_artist_json
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


class ArtistSearchResponse(BaseModel):
    artist_mbid: str
    name: str
    sort_name: str | None
    disambiguation: str | None
    country: str | None
    type: str | None
    score: float
    mb_score: int
    match_type: str
    aliases: list[str]
    image_url: str | None


@router.get("")
async def search_artist(
    q: str = Query(..., min_length=1),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    query_norm = norm_alias(q)
    if not query_norm:
        raise HTTPException(status_code=400, detail="Query is empty")

    async with musicbrainz.mb_interactive_calls():
        resp = await musicbrainz._mb_get(
            f"{musicbrainz.MUSICBRAINZ_API}/artist",
            {"query": q, "fmt": "json", "limit": 10},
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=503, detail="MusicBrainz API unavailable")

    artists = resp.json().get("artists", [])
    if not artists:
        raise HTTPException(status_code=404, detail="No artist found for query")

    best_hit = None
    best_score = -1.0
    best_mb_score = 0
    best_name_match = 0.0
    best_alias_match = 0.0

    for i, hit in enumerate(artists):
        mb_score = hit.get("score", 0)
        name = (hit.get("name") or "").strip()
        name_match = difflib.SequenceMatcher(None, query_norm, norm_alias(name)).ratio()

        alias_match = 0.0
        for al in hit.get("aliases", []):
            if not isinstance(al, dict):
                continue
            an = (al.get("name") or "").strip()
            if an:
                ratio = difflib.SequenceMatcher(None, query_norm, norm_alias(an)).ratio()
                if ratio > alias_match:
                    alias_match = ratio

        position_bonus = max(0, 10 - i)
        total = 100 * mb_score + 20 * name_match + 20 * alias_match + 10 * position_bonus

        if total > best_score:
            best_score = total
            best_hit = hit
            best_mb_score = mb_score
            best_name_match = name_match
            best_alias_match = alias_match

    if best_hit is None:
        raise HTTPException(status_code=404, detail="No artist found for query")

    try:
        upsert_from_mb_artist_json(best_hit, source="musicbrainz_search")
    except Exception:
        pass

    if best_name_match == 1.0:
        match_type = "exact"
    elif best_name_match > 0.8 or best_alias_match == 1.0:
        match_type = "fuzzy"
    else:
        match_type = "position"

    aliases = []
    for al in best_hit.get("aliases", []):
        if isinstance(al, dict):
            an = al.get("name")
            if an:
                aliases.append(an)

    mbid = best_hit.get("id", "")
    name = best_hit.get("name", "")

    # Read any already-cached image (non-blocking)
    ft = _get_cache("cover_fanart_artist", mbid)
    adb = _get_cache("cover_audiodb_artist", mbid)
    ddg = _get_cache("cover_ddg_thumb", name)
    image_url = (
        (ft or {}).get("thumb")
        or (adb or {}).get("thumb")
        or (ddg or {}).get("thumb")
        or None
    )

    # If nothing cached, fire a background fetch so it's ready next time
    if not image_url:
        try:
            svc = MetadataService(session)
            asyncio.create_task(svc.load_artist_visuals(mbid, artist_name=name))
        except Exception:
            pass

    return ArtistSearchResponse(
        artist_mbid=mbid,
        name=name,
        sort_name=best_hit.get("sort-name"),
        disambiguation=best_hit.get("disambiguation"),
        country=best_hit.get("country"),
        type=best_hit.get("type"),
        score=best_score,
        mb_score=best_mb_score,
        match_type=match_type,
        aliases=aliases,
        image_url=image_url,
    )


@router.get("/{artist_id}/images")
async def get_artist_images(
    artist_id: str,
    artist_name: str | None = Query(default=None),
    session: Session = Depends(get_session),
    user: CurrentUser = Depends(require_permission("can_access_apis")),
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