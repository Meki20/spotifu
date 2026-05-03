import asyncio
import logging
import time
from database import engine
from models import Track, TrackStatus
from sqlmodel import Session

logger = logging.getLogger(__name__)

_active_downloads: set[int] = set()
_active_lock = asyncio.Lock()


async def download_track_background(track_id: int, title: str, artist: str, album: str = "", mb_id: str | None = None, duration: int = 0):
    async with _active_lock:
        if track_id in _active_downloads:
            logger.info("Download already in flight for track_id=%s, skipping", track_id)
            return
        _active_downloads.add(track_id)
    try:
        await _run_download(track_id, title, artist, album, mb_id, duration)
    finally:
        _active_downloads.discard(track_id)


async def _run_download(track_id: int, title: str, artist: str, album: str = "", mb_id: str | None = None, duration: int = 0):
    from services.soulseek import (
        search_track_with_variants,
        search_title_fallback_hits,
        download_file,
        set_progress_callback,
        remove_progress_callback,
        set_inflight_filesize,
    )
    from main import ws_manager
    from sqlmodel import select

    query = f"{artist} - {title}"
    local_path = None
    status = TrackStatus.ERROR

    logger.debug("Progress callback registered for track_id=%s mb_id=%r", track_id, mb_id)

    _started_emitted = False

    async def progress_callback(percent: int, bytes_downloaded: int, speed: float, filesize: int | None = None):
        nonlocal _started_emitted
        msg: dict = {
            "type": "download_progress",
            "track_id": track_id,
            "percent": percent,
            "bytes_downloaded": bytes_downloaded,
            "speed": speed,
        }
        if filesize:
            msg["filesize"] = filesize
            await set_inflight_filesize(track_id, filesize)
        if mb_id:
            msg["mb_id"] = mb_id
        await ws_manager.broadcast(msg)
        if not _started_emitted and bytes_downloaded > 0:
            _started_emitted = True
            started: dict = {
                "type": "download_started",
                "track_id": track_id,
                "local_stream_url": f"/stream/{track_id}",
                "duration": duration,
            }
            if mb_id:
                started["mb_id"] = mb_id
            await ws_manager.broadcast(started)

    await set_progress_callback(track_id, progress_callback)

    await ws_manager.broadcast({
        "type": "download_searching",
        "track_id": track_id,
        "local_stream_url": f"/stream/{track_id}",
        **({"mb_id": mb_id} if mb_id else {}),
    })

    try:
        logger.debug("Searching: artist=%r title=%r album=%r query=%r", artist, title, album, query)
        variant_results = await search_track_with_variants(artist, title, album=album, timeout=30.0)
        results_flat = [hit for _q, hits in variant_results for hit in hits]

        if not results_flat:
            logger.warning("No Soulseek results for: %s", query)
            await ws_manager.broadcast({
                "type": "download_error",
                "track_id": track_id,
                "error": "No results found on Soulseek",
            })
            with Session(engine) as session:
                track = session.get(Track, track_id)
                if track and track.status == TrackStatus.FETCHING:
                    track.status = TrackStatus.ERROR
                    session.add(track)
                    session.commit()
            return

        best_variant = next(((q, hits) for (q, hits) in variant_results if hits), ("", []))
        logger.debug("Got Soulseek candidates. First non-empty variant=%r hits=%d", best_variant[0], len(best_variant[1]))

        def _is_last_fetching_track() -> bool:
            try:
                with Session(engine) as session:
                    ids = session.exec(select(Track.id).where(Track.status == TrackStatus.FETCHING)).all()
                    return len(ids) <= 1
            except Exception:
                logger.debug("Failed to compute fetching queue size; assuming not last", exc_info=True)
                return False

        last_in_queue = _is_last_fetching_track()

        MAX_ATTEMPTS_PER_VARIANT = 3

        async def attempt_downloads(
            variant_idx: int,
            variant_query: str,
            results: list[tuple[str, str, int]],
        ) -> str | None:
            if not results:
                return None
            logger.debug(
                "Trying Soulseek variant slot=%d query=%r hits=%d",
                variant_idx + 1,
                variant_query,
                len(results),
            )
            attempt_rows = results[:MAX_ATTEMPTS_PER_VARIANT]
            only_candidate = len(attempt_rows) <= 1
            for i, (username, remote_path, file_size) in enumerate(attempt_rows):
                logger.debug(
                    "Attempting download variant=%d attempt=%d/%d: user=%r path=%r size=%d",
                    variant_idx + 1,
                    i + 1,
                    len(attempt_rows),
                    username,
                    remote_path,
                    file_size,
                )
                lower_path = (remote_path or "").lower()
                if lower_path.endswith((".png", ".jpg", ".jpeg")):
                    logger.warning("Skipping non-audio Soulseek candidate: %s/%s", username, remote_path)
                    continue
                if variant_idx > 0 or i > 0:
                    logger.info("Soulseek retry: %s from %s (%s bytes)", remote_path, username, file_size)
                try:
                    abort_on_no_progress = not (only_candidate or last_in_queue)
                    got = await download_file(
                        username,
                        remote_path,
                        timeout=600.0,
                        track_id=track_id,
                        abort_on_no_progress=abort_on_no_progress,
                    )
                    if got:
                        logger.info("Download succeeded: %s", got)
                        return got
                    logger.debug("Download returned None for %s/%s, trying next", username, remote_path)
                except Exception as e:
                    logger.warning("Download attempt failed for %s/%s: %s", username, remote_path, e)
                    continue
            return None

        local_path: str | None = None
        for variant_idx, (variant_query, results) in enumerate(variant_results):
            local_path = await attempt_downloads(variant_idx, variant_query, results)
            if local_path:
                break

        # Strict search returned hits but every download failed — try title-only once.
        if not local_path and len(variant_results) == 1 and variant_results[0][1]:
            tq, fb_hits = await search_title_fallback_hits(artist, title, album=album, timeout=30.0)
            if fb_hits:
                logger.info(
                    "Soulseek title-only fallback after strict failures query=%r hits=%d",
                    tq,
                    len(fb_hits),
                )
                local_path = await attempt_downloads(1, tq, fb_hits)

        if local_path:
            status = TrackStatus.READY
            logger.info("Download complete: %s", local_path)
        else:
            logger.error("Download failed for track %d", track_id)
            await ws_manager.broadcast({
                "type": "download_error",
                "track_id": track_id,
                "error": "Download failed",
            })

    except Exception as e:
        logger.error("Soulseek download failed for track %d: %s", track_id, e)
        await ws_manager.broadcast({
            "type": "download_error",
            "track_id": track_id,
            "error": str(e),
        })
    finally:
        await remove_progress_callback(track_id)

    mb_id_for_ws: str | None = None
    mb_recording_id_for_cover: str | None = None
    mb_release_id_for_cover: str | None = None
    mb_rg_id_for_cover: str | None = None
    with Session(engine) as session:
        track = session.get(Track, track_id)
        if track:
            track.status = status
            track.local_file_path = local_path
            if status == TrackStatus.READY and local_path:
                from services.audio_quality import extract_quality
                track.quality = extract_quality(local_path)
            if not track.artist_credit:
                track.artist_credit = track.artist
            mb_id_for_ws = track.mb_id
            if status == TrackStatus.READY and not track.mb_id:
                from services.providers import musicbrainz
                try:
                    async with musicbrainz.mb_prefetch_calls():
                        mb_id_resolved = await musicbrainz.resolve_id(
                            track.title, track.artist, track.album
                        )
                    if mb_id_resolved:
                        track.mb_id = mb_id_resolved
                        mb_id_for_ws = mb_id_resolved
                except Exception:
                    logger.exception("mb resolve_id after download for track_id=%s", track_id)
            if track.title and track.artist:
                logger.info("[tags]Fetching tags for track_id=%s artist=%s title=%s",
                    track_id, track.artist, track.title)
                try:
                    from services.providers import lastfm
                    tags = await lastfm.track_top_tags(
                        track=track.title,
                        artist=track.artist,
                    )
                    if tags:
                        import json
                        track.tags = json.dumps([t.get("name") for t in tags if t.get("name")])
                        logger.info("[tags]Fetched %d tags for track_id=%s: %s", len(tags), track_id, track.tags)
                    else:
                        logger.info("[tags]No tags found for track_id=%s", track_id)
                except Exception:
                    logger.info("[tags]Failed to fetch tags for track_id=%s", track_id, exc_info=True)
            else:
                logger.info("[tags]Skipping tag fetch for track_id=%s: no artist/title available", track_id)
            mb_recording_id_for_cover = track.mb_id
            mb_release_id_for_cover = track.mb_release_id
            mb_rg_id_for_cover = track.mb_release_group_id
            session.add(track)
            session.commit()

    if status == TrackStatus.READY and local_path:
        from services.covers import upsert_local_cover
        try:
            await upsert_local_cover(
                local_path,
                track_id,
                recording_id=mb_recording_id_for_cover,
                release_id=mb_release_id_for_cover,
                release_group_id=mb_rg_id_for_cover,
            )
        except Exception:
            logger.debug("Local cover upsert failed for track_id=%s", track_id, exc_info=True)

    if status == TrackStatus.READY:
        with Session(engine) as session:
            track = session.get(Track, track_id)
            quality = track.quality if track else None
        payload: dict = {
            "type": "track_ready",
            "track_id": track_id,
            "local_stream_url": f"/stream/{track_id}",
        }
        if quality:
            payload["quality"] = quality
        if mb_id_for_ws:
            payload["mb_id"] = mb_id_for_ws
        await ws_manager.broadcast(payload)