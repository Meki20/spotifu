import math
from datetime import datetime, timedelta
from typing import List
from sqlmodel import Session, select
from models import UserRecentlyPlayed, Track, AutoPlaylistDefinition, AutoPlaylistTrack


def generate_hottest_tracks(session: Session, user_id: int, limit: int = 20) -> List[AutoPlaylistTrack]:
    now = datetime.utcnow()

    statement = (
        select(UserRecentlyPlayed, Track)
        .join(Track, UserRecentlyPlayed.track_id == Track.id)
        .where(UserRecentlyPlayed.user_id == user_id)
        .where(UserRecentlyPlayed.play_amount > 0)
    )
    results = session.exec(statement).all()

    if not results:
        return []

    max_plays = max(r.UserRecentlyPlayed.play_amount for r in results)
    if max_plays == 0:
        max_plays = 1

    scored = []
    for urp, track in results:
        recency_score = math.pow(2, -max(0, (now - urp.played_at).days) / 30)
        play_score = urp.play_amount / max_plays
        hotness = (recency_score * 0.50) + (play_score * 0.50)

        scored.append((hotness, urp, track))

    scored.sort(key=lambda x: x[0], reverse=True)
    unique_tracks = []
    seen_mb_ids = set()

    for hotness, urp, track in scored:
        mb_id = track.mb_id or f"local_{track.id}"
        if mb_id not in seen_mb_ids:
            seen_mb_ids.add(mb_id)
            unique_tracks.append((hotness, urp, track))
            if len(unique_tracks) >= limit:
                break

    generated_tracks = []
    for position, (hotness, urp, track) in enumerate(unique_tracks):
        generated_tracks.append(AutoPlaylistTrack(
            position=position,
            title=track.title,
            artist=track.artist,
            album=track.album,
            mb_recording_id=track.mb_id,
            mb_artist_id=track.mb_artist_id,
            mb_release_id=track.mb_release_id,
            track_id=track.id,
            hotness_score=hotness,
        ))

    return generated_tracks