import asyncio
import difflib
import os

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select
from database import get_session
from deps import get_current_user, require_permission, CurrentUser
from models import User, MbArtist, MbArtistAlias
from services.artist_alias_cache import norm_alias, upsert_from_mb_artist_json
from services.providers import MetadataService, _get_artist_images_dir
from services.providers import musicbrainz
from services.providers import _ARTIST_IMAGES_DIR
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

    # local downloaded images
    local = _get_cache("cover_artist_local", artist_id)
    if local:
        paths = local.get("banner_paths") or ([local["banner_path"]] if local.get("banner_path") else [])
        for idx, p in enumerate(paths):
            if p and os.path.isfile(os.path.join(_ARTIST_IMAGES_DIR, p)):
                banners.append(f"/covers/artist-local/{artist_id}/banner/{idx}")

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

    # local downloaded images
    local = _get_cache("cover_artist_local", artist_id)
    if local:
        paths = local.get("thumb_paths") or ([local["thumb_path"]] if local.get("thumb_path") else [])
        for idx, p in enumerate(paths):
            if p and os.path.isfile(os.path.join(_ARTIST_IMAGES_DIR, p)):
                thumbs.append(f"/covers/artist-local/{artist_id}/thumb/{idx}")

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

    # --- Try alias cache first ---
    try:
        alias_row = session.exec(
            select(MbArtistAlias, MbArtist)
            .join(MbArtist, MbArtistAlias.artist_mbid == MbArtist.artist_mbid)
            .where(MbArtistAlias.alias_norm == query_norm)
        ).first()
    except Exception:
        alias_row = None

    if alias_row:
        alias_rec, artist_rec = alias_row
        mbid = artist_rec.artist_mbid
        name = artist_rec.canonical_name

        # Gather all aliases for this artist
        try:
            alias_rows = session.exec(
                select(MbArtistAlias).where(MbArtistAlias.artist_mbid == mbid)
            ).all()
            aliases = list({a.alias_raw for a in alias_rows if a.alias_raw})
        except Exception:
            aliases = []

        # Image cache lookup (same as MB-hit path)
        ft = _get_cache("cover_fanart_artist", mbid)
        adb = _get_cache("cover_audiodb_artist", mbid)
        ddg = _get_cache("cover_ddg_thumb", name)
        image_url = (
            (ft or {}).get("thumb")
            or (adb or {}).get("thumb")
            or (ddg or {}).get("thumb")
            or None
        )

        if not image_url:
            try:
                svc = MetadataService(session)
                asyncio.create_task(svc.load_artist_visuals(mbid, artist_name=name))
            except Exception:
                pass

        return ArtistSearchResponse(
            artist_mbid=mbid,
            name=name,
            sort_name=artist_rec.sort_name,
            disambiguation=None,
            country=None,
            type=None,
            score=0.0,
            mb_score=0,
            match_type="cache",
            aliases=aliases,
            image_url=image_url,
        )

    # --- Cache miss: fall through to MusicBrainz ---
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


@router.get("/{artist_id}/ddg-search")
async def ddg_search_artist_images(
    artist_id: str,
    type: str = Query(..., description="square or banner"),
    q: str | None = Query(default=None, description="custom search query; defaults to artist name + type"),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """On-demand DDG image search. Never cached."""
    if type not in ("square", "banner"):
        raise HTTPException(status_code=400, detail="type must be 'square' or 'banner'")

    from services.providers import ddg

    if q and q.strip():
        query = q.strip()
    else:
        artist_name: str | None = None
        head = _get_cache("artist_head", artist_id)
        if isinstance(head, dict) and (head.get("name") or "").strip():
            artist_name = (head.get("name") or "").strip()

        if not artist_name:
            svc = MetadataService(session)
            async with musicbrainz.mb_interactive_calls():
                mb = await svc.get_artist_head(artist_id)
            if mb and (mb.get("name") or "").strip():
                artist_name = (mb.get("name") or "").strip()

        if not artist_name:
            raise HTTPException(status_code=400, detail="artist name not known")

        query = f"{artist_name} artist {type}"

    urls = await ddg.search_uncached(query)
    return {"results": urls}


class ImageDownloadRequest(BaseModel):
    url: str
    kind: str  # "banner" or "thumb"


@router.post("/{artist_id}/images/download")
async def download_artist_image(
    artist_id: str,
    body: ImageDownloadRequest,
    user: User = Depends(get_current_user),
):
    """Download an image from URL and cache locally for this artist."""
    if body.kind not in ("banner", "thumb"):
        raise HTTPException(status_code=400, detail="kind must be 'banner' or 'thumb'")

    import aiohttp
    import uuid

    images_dir = _get_artist_images_dir()
    ext = ".jpg"
    if body.url.lower().endswith(".png"):
        ext = ".png"

    filename = f"{artist_id}_{body.kind}_{uuid.uuid4().hex[:8]}{ext}"
    filepath = os.path.join(images_dir, filename)

    try:
        async with aiohttp.ClientSession() as http_session:
            async with http_session.get(body.url) as resp:
                if resp.status != 200:
                    raise HTTPException(status_code=502, detail="Failed to fetch image from source")
                content = await resp.read()
        with open(filepath, "wb") as f:
            f.write(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to download image: {e}")

    rel_path = os.path.join("artist_images", filename)
    from services.providers import _db_set
    existing = _get_cache("cover_artist_local", artist_id) or {}
    paths_key = "banner_paths" if body.kind == "banner" else "thumb_paths"
    old_key = "banner_path" if body.kind == "banner" else "thumb_path"
    # migrate old single-path format to list
    current = existing.get(paths_key) or ([existing.pop(old_key)] if existing.get(old_key) else [])
    existing.pop(old_key, None)
    existing[paths_key] = current + [rel_path]
    _db_set("cover_artist_local", artist_id, existing)

    return {
        "local_url": f"/covers/artist-local/{artist_id}/{body.kind}",
        "filename": rel_path,
    }


@router.delete("/{artist_id}/images/local")
async def delete_artist_local_image(
    artist_id: str,
    kind: str = Query(..., description="banner or thumb"),
    idx: int | None = Query(default=None, description="index to delete; omit to delete all of kind"),
    user: User = Depends(get_current_user),
):
    """Delete one or all locally cached images of a kind for this artist."""
    if kind not in ("banner", "thumb"):
        raise HTTPException(status_code=400, detail="kind must be 'banner' or 'thumb'")

    local = _get_cache("cover_artist_local", artist_id)
    if not local:
        return {"deleted": False}

    paths_key = f"{kind}_paths"
    old_key = f"{kind}_path"
    paths = local.get(paths_key) or ([local[old_key]] if local.get(old_key) else [])

    if idx is not None:
        if idx < 0 or idx >= len(paths):
            raise HTTPException(status_code=404, detail=f"No local {kind} at index {idx}")
        p = paths[idx]
        if p:
            full = os.path.join(_ARTIST_IMAGES_DIR, p)
            if os.path.isfile(full):
                os.remove(full)
        paths = [p for i, p in enumerate(paths) if i != idx]
    else:
        for p in paths:
            if p:
                full = os.path.join(_ARTIST_IMAGES_DIR, p)
                if os.path.isfile(full):
                    os.remove(full)
        paths = []

    local.pop(old_key, None)
    if paths:
        local[paths_key] = paths
    else:
        local.pop(paths_key, None)

    from services.providers import _db_set
    if local.get("banner_paths") or local.get("thumb_paths"):
        _db_set("cover_artist_local", artist_id, local)
    else:
        from services.providers import _db_delete
        _db_delete("cover_artist_local", artist_id)

    return {"deleted": True}