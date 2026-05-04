import json
import math
import random
from datetime import datetime, timedelta
from typing import List, Tuple
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


def _tags_match(search_tag: str, track_tag: str) -> bool:
    search_lower = search_tag.lower()
    track_lower = track_tag.lower()

    if search_lower in track_lower:
        return True
    if track_lower in search_lower:
        return _are_tags_compatible(search_lower, track_lower)
    return False


def _are_tags_compatible(tag1: str, tag2: str) -> bool:
    exclude_pairs = [
        ("male", "female"),
        ("man", "woman"),
        ("boys", "girls"),
        ("male vocal", "female vocal"),
        ("male vocalist", "female vocalist"),
    ]

    for a, b in exclude_pairs:
        has_a = a in tag1 or a in tag2
        has_b = b in tag1 or b in tag2
        if has_a and has_b:
            return False
    return True


def generate_tag_mix(session: Session, user_id: int, limit: int = 20) -> Tuple[List[AutoPlaylistTrack], str]:
    statement = (
        select(UserRecentlyPlayed, Track)
        .join(Track, UserRecentlyPlayed.track_id == Track.id)
        .where(UserRecentlyPlayed.user_id == user_id)
        .where(UserRecentlyPlayed.play_amount > 0)
        .where(Track.tags.isnot(None))
    )
    results = session.exec(statement).all()

    if not results:
        return [], ""

    played_tracks = [track for _, track in results if track.tags]

    if len(played_tracks) < limit:
        return [], ""

    all_tags = set()
    track_tag_map = {}
    for track in played_tracks:
        try:
            tags = json.loads(track.tags)
        except (json.JSONDecodeError, TypeError):
            tags = []
        if tags:
            track_tag_map[track.id] = tags
            for tag in tags:
                all_tags.add(tag)

    if not all_tags:
        return [], ""

    tag_list = list(all_tags)
    random.shuffle(tag_list)

    for tag in tag_list:
        candidates = []
        for track in played_tracks:
            tags = track_tag_map.get(track.id, [])
            if any(_tags_match(tag, t) for t in tags):
                candidates.append(track)

        if len(candidates) >= limit:
            return _select_diverse_tracks(candidates, limit, track_tag_map), f"{tag.title()} Mix"

    candidates_with_counts = []
    for tag in tag_list:
        count = sum(1 for track in played_tracks if any(_tags_match(tag, t) for t in track_tag_map.get(track.id, [])))
        candidates_with_counts.append((tag, count))

    candidates_with_counts.sort(key=lambda x: x[1], reverse=True)

    selected_tag = None
    accumulator = 0
    total = sum(count for _, count in candidates_with_counts)
    for tag, count in candidates_with_counts:
        probability = count / total
        accumulator += probability
        if random.random() < accumulator:
            selected_tag = tag
            break

    if not selected_tag:
        selected_tag = tag_list[0]

    final_candidates = []
    for track in played_tracks:
        tags = track_tag_map.get(track.id, [])
        if any(_tags_match(selected_tag, t) for t in tags):
            final_candidates.append(track)

    return _select_diverse_tracks(final_candidates, limit, track_tag_map), f"{selected_tag.title()} Mix"


def _select_diverse_tracks(tracks: List[Track], limit: int, track_tag_map: dict) -> List[AutoPlaylistTrack]:
    if len(tracks) <= limit:
        return _build_playlist_tracks(tracks)

    seen_tag_arrays = {}
    selected = []

    for track in tracks:
        tags = tuple(sorted(track_tag_map.get(track.id, [])))
        count = seen_tag_arrays.get(tags, 0)

        if count < 2:
            selected.append(track)
            seen_tag_arrays[tags] = count + 1

            if len(selected) >= limit:
                break

    if len(selected) < limit:
        for track in tracks:
            if track not in selected:
                selected.append(track)
                if len(selected) >= limit:
                    break

    return _build_playlist_tracks(selected[:limit])


def _build_playlist_tracks(tracks: List[Track]) -> List[AutoPlaylistTrack]:
    generated_tracks = []
    for position, track in enumerate(tracks):
        generated_tracks.append(AutoPlaylistTrack(
            position=position,
            title=track.title,
            artist=track.artist,
            album=track.album,
            mb_recording_id=track.mb_id,
            mb_artist_id=track.mb_artist_id,
            mb_release_id=track.mb_release_id,
            track_id=track.id,
            hotness_score=1.0,
        ))
    return generated_tracks