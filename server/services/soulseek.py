"""Soulseek integration using aioslsk.

Design rules (see aioslsk docs + SoulSeek anti-DDOS warning):

- Single long-lived client; start/login once, rely on aioslsk's auto-reconnect.
- Never spin up a fresh client per request.
- Space out searches and cap concurrent downloads to avoid rate-ban.
- Wait for transfer completion via `is_finalized()` polling + state check,
  not via `TransferRemovedEvent` (that fires on removal, not completion).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import logging
import math
import os
import re
import time
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)
logging.getLogger("aioslsk").setLevel(logging.CRITICAL + 1)

CACHE_DIR = os.environ.get("CACHE_DIR", "/home/lukaarch/Documents/src/SpotiFU/cache")
_SECRETS_FILE = Path(os.environ.get("SECRETS_FILE", "/home/lukaarch/Documents/src/SpotiFU/.secrets"))

# Ban-prevention knobs
_MIN_SEARCH_INTERVAL = 3.0          # seconds between consecutive searches
_SEARCH_COLLECT_WINDOW = 6.0        # seconds to accumulate results before cutoff
_MAX_CONCURRENT_DOWNLOADS = 2
_RECONNECT_BACKOFF = 10             # seconds (aioslsk's own reconnect timer)
_SEARCH_REQUEST_TIMEOUT = 60        # seconds (server-side request TTL)
# NOTE: early-exit is intentionally strict: the result must be both high-quality
# and likely-to-start-downloading immediately (good speed + free slots).
_EXCELLENT_THRESHOLD = 0.94         # early-exit score threshold (composite)
_EXCELLENT_MIN_COLLECT = 1.5        # seconds: gather a bit before early-exit
_EXCELLENT_MIN_SPEED = 10_000_000   # bytes/sec: 10MB/s for truly "excellent"

# Module state
_client = None                       # type: Optional["SoulSeekClient"]
_start_lock = asyncio.Lock()
_ready = asyncio.Event()             # set once login succeeds
_slsk_username: str = ""
_slsk_password: str = ""

_search_lock = asyncio.Lock()        # only one search request at a time
_last_search_at: float = 0.0
_download_gate = asyncio.Semaphore(_MAX_CONCURRENT_DOWNLOADS)


# --------------------------------------------------------------------------
# Credentials persistence (.secrets file)
# --------------------------------------------------------------------------

def _load_secrets() -> tuple[str, str] | None:
    """Load credentials from .secrets file. Returns (username, password) or None."""
    if not _SECRETS_FILE.exists():
        return None
    try:
        with open(_SECRETS_FILE) as f:
            data = json.load(f)
        return (data.get("soulseek_username", ""), data.get("soulseek_password", ""))
    except Exception as e:
        logger.warning("Failed to load .secrets: %s", e)
        return None


def get_secrets_data() -> dict:
    """Load all secrets from .secrets file as dict. Returns empty dict if absent."""
    if not _SECRETS_FILE.exists():
        return {}
    try:
        with open(_SECRETS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_secrets(username: str, password: str) -> None:
    """Save credentials to .secrets file."""
    save_secrets_data({"soulseek_username": username, "soulseek_password": password})


def save_secrets_data(data: dict) -> None:
    """Write full data dict to .secrets file."""
    try:
        with open(_SECRETS_FILE, "w") as f:
            json.dump(data, f)
        os.chmod(_SECRETS_FILE, 0o600)
    except Exception as e:
        logger.error("Failed to save .secrets: %s", e)


def _clear_secrets() -> None:
    """Remove .secrets file."""
    try:
        if _SECRETS_FILE.exists():
            _SECRETS_FILE.unlink()
    except Exception as e:
        logger.warning("Failed to clear .secrets: %s", e)


# Load stored credentials on module import
# Env vars take priority (for Docker), then fall back to .secrets file
import os as _os
_slsk_username = _os.environ.get("SOULSEEK_USERNAME", "") or ""
_slsk_password = _os.environ.get("SOULSEEK_PASSWORD", "") or ""
if not _slsk_username:
    _stored = _load_secrets()
    if _stored:
        _slsk_username, _slsk_password = _stored

# Per-track progress subscriptions (key = track_id from download.py)
ProgressCallback = Callable[[int, int, float, int | None], Awaitable[None] | None]
_progress_by_track: Dict[int, ProgressCallback] = {}

# In-flight download paths: track_id → local path (set once bytes start flowing)
_inflight_paths: Dict[int, str] = {}
# In-flight expected filesizes: track_id → total bytes as reported by Soulseek at transfer start
_inflight_filesizes: Dict[int, int] = {}
# Protects all three dicts above during writes
_inflight_lock = asyncio.Lock()


def get_inflight_path(track_id: int) -> Optional[str]:
    return _inflight_paths.get(track_id)


def get_inflight_filesize(track_id: int) -> Optional[int]:
    return _inflight_filesizes.get(track_id)


async def set_inflight_filesize(track_id: int, filesize: int) -> None:
    async with _inflight_lock:
        _inflight_filesizes[track_id] = filesize


# --------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------

def set_credentials(username: str, password: str, persist: bool = True) -> None:
    """Stash credentials and optionally save to .secrets file."""
    global _slsk_username, _slsk_password
    _slsk_username = username
    _slsk_password = password
    if persist:
        _save_secrets(username, password)


def clear_credentials() -> None:
    """Clear stored credentials and remove .secrets file."""
    global _slsk_username, _slsk_password
    _slsk_username = ""
    _slsk_password = ""
    _clear_secrets()


def get_configured_username() -> Optional[str]:
    return _slsk_username or None


def has_stored_credentials() -> bool:
    """Check if credentials exist in .secrets file or env vars."""
    if _slsk_username and _slsk_password:
        return True
    creds = _load_secrets()
    return creds is not None and bool(creds[0]) and bool(creds[1])


def get_logged_in_username() -> Optional[str]:
    try:
        if _client is not None and _ready.is_set() and _client.session is not None:
            user = getattr(_client.session, "user", None)
            if user is not None:
                return getattr(user, "name", None)
    except Exception:
        logger.debug("get_logged_in_username failed", exc_info=True)
    return None


def is_connected() -> bool:
    return _ready.is_set()


# --------------------------------------------------------------------------
# Lifecycle
# --------------------------------------------------------------------------

def _build_settings():
    from aioslsk.settings import (
        Settings,
        CredentialsSettings,
        SharesSettings,
        NetworkSettings,
        ServerSettings,
        ReconnectSettings,
        ListeningSettings,
        SearchSettings,
        SearchSendSettings,
        TransfersSettings,
    )

    return Settings(
        credentials=CredentialsSettings(
            username=_slsk_username,
            password=_slsk_password,
        ),
        network=NetworkSettings(
            server=ServerSettings(
                reconnect=ReconnectSettings(auto=True, timeout=_RECONNECT_BACKOFF),
            ),
            listening=ListeningSettings(port=61000, obfuscated_port=61001),
        ),
        shares=SharesSettings(download=CACHE_DIR, scan_on_start=False),
        searches=SearchSettings(
            send=SearchSendSettings(request_timeout=_SEARCH_REQUEST_TIMEOUT),
        ),
        transfers=TransfersSettings(report_interval=0.5),
    )


async def start_client(timeout: float = 30.0) -> bool:
    """Start client and login. Idempotent — returns True if connected."""
    global _client

    if not _slsk_username:
        logger.info("Soulseek: no credentials configured, skipping start")
        return False

    async with _start_lock:
        if _client is not None and _ready.is_set():
            return True

        try:
            from aioslsk.client import SoulSeekClient
        except ImportError as e:
            logger.warning("aioslsk not available: %s", e)
            return False

        settings = _build_settings()
        client = SoulSeekClient(settings)
        _register_listeners(client)

        try:
            async with asyncio.timeout(timeout):
                await client.start()
                await client.login()
        except (TimeoutError, asyncio.TimeoutError):
            logger.error("Soulseek connect/login timed out after %ss", timeout)
            try:
                await client.stop()
            except Exception:
                logger.debug("client.stop after connect timeout (ignored)", exc_info=True)
            return False
        except Exception as e:
            logger.error("Soulseek connect/login failed: %s", e)
            try:
                await client.stop()
            except Exception:
                logger.debug("client.stop after connect failure (ignored)", exc_info=True)
            return False

        _client = client
        _ready.set()
        logger.info("Soulseek connected as %s", get_logged_in_username())
        return True


async def stop_client() -> None:
    """Stop client cleanly. Idempotent."""
    global _client
    async with _start_lock:
        _ready.clear()
        if _client is None:
            return
        try:
            await _client.stop()
        except Exception as e:
            logger.warning("Soulseek stop error (ignored): %s", e)
        finally:
            _client = None
            logger.info("Soulseek stopped")


async def restart_client() -> bool:
    await stop_client()
    return await start_client()


async def connect() -> bool:
    """Connect using stored credentials. Returns True if connected."""
    global _slsk_username, _slsk_password
    import os as _os
    if not _slsk_username:
        env_user = _os.environ.get("SOULSEEK_USERNAME", "")
        env_pass = _os.environ.get("SOULSEEK_PASSWORD", "")
        if env_user and env_pass:
            _slsk_username, _slsk_password = env_user, env_pass
        else:
            creds = _load_secrets()
            if creds:
                _slsk_username, _slsk_password = creds
    return await start_client()


async def disconnect() -> None:
    """Disconnect and clear in-memory credentials (but keep .secrets)."""
    await stop_client()


async def _wait_ready(timeout: float) -> bool:
    try:
        await asyncio.wait_for(_ready.wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        return False


# --------------------------------------------------------------------------
# Event listeners
# --------------------------------------------------------------------------

def _register_listeners(client) -> None:
    from aioslsk.events import (
        SessionInitializedEvent,
        SessionDestroyedEvent,
        ServerReconnectedEvent,
    )

    async def on_session_init(event: SessionInitializedEvent):
        user = getattr(event.session, "user", None)
        name = getattr(user, "name", None) if user else None
        logger.info("Soulseek session initialized (user=%s)", name)
        _ready.set()

    async def on_session_destroyed(event: SessionDestroyedEvent):
        logger.warning("Soulseek session destroyed")
        _ready.clear()

    async def on_server_reconnected(event: ServerReconnectedEvent):
        logger.info("Soulseek server reconnected")

    client.events.register(SessionInitializedEvent, on_session_init)
    client.events.register(SessionDestroyedEvent, on_session_destroyed)
    client.events.register(ServerReconnectedEvent, on_server_reconnected)


# --------------------------------------------------------------------------
# Progress subscriptions (used by download.py)
# --------------------------------------------------------------------------

async def set_progress_callback(track_id: int, callback: ProgressCallback) -> None:
    async with _inflight_lock:
        _progress_by_track[track_id] = callback


async def remove_progress_callback(track_id: int) -> None:
    async with _inflight_lock:
        _progress_by_track.pop(track_id, None)


# --------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------

_AUDIO_EXTS = {"flac", "mp3", "m4a", "ogg", "opus", "wav", "aac"}
_MIN_AUDIO_BYTES = 500_000
# Minimum avg_speed (bytes/s) a peer must report to be considered for ranking.
# This is intentionally conservative: very low speeds make "high quality" formats unusable.
# Override via env: SOULSEEK_MIN_AVG_SPEED (bytes/s).
_MIN_RELAY_SPEED = int(os.environ.get("SOULSEEK_MIN_AVG_SPEED", "500000"))  # ~500KB/s default

_TRACK_NUM_RE = re.compile(r'^\d{1,3}[\s.\-]+')
_EXT_RE = re.compile(r'\.[a-z0-9]{2,5}$')
_NORM_PUNCT_RE = re.compile(r'[^\w\s]')
_SUSPICIOUS_PATH_RE = re.compile(r'(^|/)(temp|tmp|incomplete|partial|\.crdownload)', re.IGNORECASE)
_HI_RES_RE = re.compile(r'24[\s\-]?bit|24/9[0-9]|24/1[0-9]{2}|9[0-9]\s?khz|1[0-9]{2}\s?khz|hi[\s\-_]?res|hirez', re.IGNORECASE)


def _normalize_tokens(s: str) -> list[str]:
    """Lowercase, strip punctuation, split into tokens."""
    s = _NORM_PUNCT_RE.sub(' ', s.lower())
    return [t for t in s.split() if t]


def _token_hit_rate(query_tokens: list[str], text: str) -> float:
    """Fraction of query tokens that appear as whole words in text."""
    if not query_tokens:
        return 0.0
    text_words = set(re.split(r'\W+', text.lower()))
    return sum(1 for t in query_tokens if t in text_words) / len(query_tokens)


def _seq_sim(a: str, b: str) -> float:
    return SequenceMatcher(None, a, b).ratio()


def _title_stem_score(
    title_tokens: list[str],
    stem_tokens: list[str],
    artist_tokens: list[str],
) -> float:
    """Title match against filename stem that penalizes extra words not in artist/title.

    Prevents "Father" matching "Father Stretch My Hands" highly — the extra
    words "stretch my hands" are noise relative to the expected title.
    Artist tokens in the stem (common in CD rips: "Artist - Title") are
    treated as expected and do NOT count as noise.
    """
    if not title_tokens or not stem_tokens:
        return 0.0
    title_set = set(title_tokens)
    stem_set = set(stem_tokens)
    artist_set = set(artist_tokens)

    # Recall: how many title words appear in stem
    common = title_set & stem_set
    recall = len(common) / len(title_set)

    # Noise: stem words that belong to neither title nor artist
    expected = title_set | artist_set
    noise_count = len(stem_set - expected)
    noise_ratio = noise_count / len(stem_set)

    # High recall but lots of noise → penalized
    return recall * (1.0 - noise_ratio * 0.7)


def _album_dirs_score(path: str, album: str) -> float:
    """Check if album name appears in the directory components (not filename). [0, 1]
    Returns 0 if album unknown — no penalty for absence."""
    if not album or not path:
        return 0.0
    path_norm = path.lower().replace("\\", "/")
    parts = [p for p in path_norm.split("/") if p]
    dirs_text = " ".join(parts[:-1])  # everything except filename
    if not dirs_text:
        return 0.0
    album_tokens = _normalize_tokens(album)
    if not album_tokens:
        return 0.0
    token_hit = _token_hit_rate(album_tokens, dirs_text)
    # Also check seq sim against each dir component individually
    best_dir_sim = max(
        (_seq_sim(" ".join(album_tokens), d) for d in parts[:-1]),
        default=0.0,
    )
    return max(token_hit, best_dir_sim)


def _path_content_score(path: str, artist: str, title: str) -> float:
    """How well does this file path match target artist + title. [0, 1]"""
    if not path:
        return 0.5  # unknown — neutral

    path_norm = path.lower().replace("\\", "/")
    parts = [p for p in path_norm.split("/") if p]
    filename = parts[-1] if parts else ""
    stem = _EXT_RE.sub('', filename)
    stem_clean = _TRACK_NUM_RE.sub('', stem).strip()
    stem_tokens = [t for t in re.split(r'\W+', stem_clean) if t]

    artist_tokens = _normalize_tokens(artist)
    title_tokens = _normalize_tokens(title)
    all_tokens = artist_tokens + title_tokens
    full_path_text = " ".join(parts)

    # F1-style title match in stem — penalizes extra words beyond title+artist
    title_stem_s = _title_stem_score(title_tokens, stem_tokens, artist_tokens)

    # Artist tokens anywhere in path (parent dirs often hold artist/album name)
    artist_in_path = _token_hit_rate(artist_tokens, full_path_text) if artist_tokens else 0.0

    # Broad token presence in full path (loose catch-all)
    path_cov = _token_hit_rate(all_tokens, full_path_text) if all_tokens else 0.5

    # Sequence similarity: stem vs "title" and "artist title" (continuous signal)
    combined_norm = " ".join(all_tokens)
    title_norm_str = " ".join(title_tokens)
    stem_sim = max(
        _seq_sim(stem_clean, combined_norm),
        _seq_sim(stem_clean, title_norm_str),
    ) if stem_clean else 0.0

    return min(
        title_stem_s * 0.40
        + artist_in_path * 0.20
        + stem_sim * 0.25
        + path_cov * 0.15,
        1.0,
    )


def _naming_quality_score(path: str) -> float:
    """Structural indicators of a well-ripped, well-organized file. [0, 1]"""
    if not path:
        return 0.0

    path_norm = path.lower().replace("\\", "/")
    parts = [p for p in path_norm.split("/") if p]
    filename = parts[-1] if parts else ""
    stem = _EXT_RE.sub('', filename)

    if _SUSPICIOUS_PATH_RE.search(path_norm):
        return 0.02

    score = 0.0

    # Path depth 3-6: Artist/Album/Track structure
    depth = len(parts)
    if 3 <= depth <= 6:
        score += 0.30
    elif depth == 2:
        score += 0.15
    elif depth > 6:
        score += 0.10

    # Track number prefix in filename → indicates CD rip
    if _TRACK_NUM_RE.match(stem):
        score += 0.25

    # " - " separator in filename (Artist - Title or 01 - Title)
    if " - " in stem:
        score += 0.25

    # No weird characters (random junk filenames have lots of these)
    weird = len(re.findall(r'[^\w\s\-\(\)\[\].,&\'!]', stem))
    if weird == 0:
        score += 0.15
    elif weird <= 2:
        score += 0.05

    # Penalize very short or suspiciously long stems
    if len(stem) < 5:
        score *= 0.5
    elif len(stem) > 120:
        score *= 0.8

    return min(score, 1.0)


def _format_score(ext: str, path: str, size: int) -> float:
    """Audio quality score based on format + size/path heuristics. [0, 1]"""
    if ext == "flac":
        if _HI_RES_RE.search(path):
            return 1.00
        if size >= 70_000_000:   # large file ≈ likely 24-bit FLAC
            return 0.95
        return 0.75              # standard 16-bit FLAC
    if ext == "mp3":
        if size >= 8_000_000:    # ~320 kbps for avg track length
            return 0.52
        return 0.38              # lower bitrate
    if ext in {"m4a", "aac"}:
        return 0.44
    if ext in {"ogg", "opus"}:
        return 0.40
    if ext == "wav":
        return 0.70
    return 0.15


_AVAIL_KEY_STRIP = str.maketrans({c: " " for c in "-_()[]{}.,:;!?\"'`~/\\&+*"})


def _availability_key(path: str) -> str:
    """Normalize a path to a coarse key for 'how many peers have this'."""
    if not path:
        return ""
    filename = path.lower().replace("\\", "/").split("/")[-1]
    stem = _EXT_RE.sub("", filename)
    stem = _TRACK_NUM_RE.sub("", stem).translate(_AVAIL_KEY_STRIP)
    tokens = [t for t in re.split(r"\W+", stem) if t and len(t) > 1]
    return " ".join(tokens[:12])


def _score_file(
    result,
    file,
    artist: str = "",
    title: str = "",
    album: str = "",
    availability: int = 1,
) -> float:
    """Composite holistic score [0, 1]. Higher = better."""
    path = file.filename or ""
    ext = (file.extension or "").lower().lstrip(".")
    size = int(file.filesize or 0)
    speed = int(result.avg_speed or 0)

    content_s = _path_content_score(path, artist, title)
    album_s = _album_dirs_score(path, album)   # 0 when album unknown — no penalty
    quality_s = _naming_quality_score(path)
    format_s = _format_score(ext, path, size)
    # log-normalize speed: 1MB/s → ~0.53, 5MB/s → ~0.85, 10MB/s → ~1.0
    speed_s = min(math.log1p(speed) / math.log1p(10_000_000), 1.0)
    # Availability: more peers offering (roughly) the same file reduces "stuck in queue" risk.
    # 1 peer → 0.0, 2 peers → ~0.39, 5 peers → ~0.86, 8+ peers → ~1.0
    avail_s = min(math.log1p(max(availability - 1, 0)) / math.log1p(7), 1.0)
    # Slot factor: free slots means likely to start now; lack of free slots is a strong negative.
    slot_s = 1.0 if getattr(result, "has_free_slots", False) else 0.0
    slot_term = 0.16 * slot_s - 0.12 * (1.0 - slot_s)

    score = (
        content_s * 0.22
        + speed_s * 0.34
        + avail_s * 0.10
        + quality_s * 0.12
        + format_s * 0.10
        + album_s * 0.04
        + slot_term
    )
    return min(max(score, 0.0), 1.0)


def _flatten_and_rank(results, artist: str = "", title: str = "", album: str = "") -> List[Tuple[str, str, int]]:
    hits: List[Tuple[float, str, str, int]] = []
    avail_counts: dict[str, int] = {}
    for r in results:
        if (r.avg_speed or 0) < _MIN_RELAY_SPEED:
            continue
        for f in r.shared_items:
            size = int(f.filesize or 0)
            if size < _MIN_AUDIO_BYTES:
                continue
            ext = (f.extension or "").lower().lstrip(".")
            if ext and ext not in _AUDIO_EXTS:
                continue
            akey = _availability_key(f.filename or "")
            avail_counts[akey] = avail_counts.get(akey, 0) + 1
            score = _score_file(r, f, artist, title, album, availability=avail_counts[akey])
            hits.append((score, r.username, f.filename, size))
    hits.sort(key=lambda x: x[0], reverse=True)
    ranked = [(u, p, s) for _score, u, p, s in hits]
    flacs = [(u, p, s) for (u, p, s) in ranked if (p or "").lower().endswith(".flac")]
    if flacs:
        return flacs
    return ranked


_QUERY_STRIP = str.maketrans({c: " " for c in "-_()[]{}.,:;!?\"'`~/\\&+*"})


def _clean_query(q: str) -> str:
    q = q.translate(_QUERY_STRIP)
    return " ".join(q.split())


def _build_query_variants(artist: str, title: str) -> List[str]:
    """Progressive fallbacks; Soulseek does strict AND on terms, so drop noisy
    words. Duplicates removed while preserving order."""
    artist = _clean_query(artist)
    title = _clean_query(title)
    first = artist.split(" ", 1)[0] if artist else ""

    variants = [
        f"{artist} {title}".strip(),
        f"{first} {title}".strip() if first else "",
        title,
    ]
    seen, out = set(), []
    for v in variants:
        if v and v.lower() not in seen:
            seen.add(v.lower())
            out.append(v)
    return out


async def search_track(
    artist: str,
    title: str,
    album: str = "",
    timeout: float = 30.0,
) -> List[Tuple[str, str, int]]:
    """Search with progressive-fallback query shapes. Returns first non-empty."""
    variants = _build_query_variants(artist, title)
    logger.debug("Query variants to try: %s", variants)
    for q in variants:
        logger.debug("Trying query: %r", q)
        hits = await search_soulseek(q, timeout=timeout, artist=artist, title=title, album=album)
        if hits:
            logger.debug("Query %r returned %d hits", q, len(hits))
            return hits
        logger.debug("Query %r returned 0 hits, trying next variant", q)
    return []


async def search_soulseek(
    query: str,
    timeout: float = 30.0,
    collect_for: float = _SEARCH_COLLECT_WINDOW,
    artist: str = "",
    title: str = "",
    album: str = "",
) -> List[Tuple[str, str, int]]:
    """Search Soulseek and return ranked `(username, remote_path, size)` hits.

    `timeout` is an upper bound for waiting-to-connect; `collect_for` is how
    long we gather incoming results before returning. `artist`/`title` are used
    for fuzzy path scoring when available.

    Early exit: if any file scores >= _EXCELLENT_THRESHOLD during collection,
    return immediately with that single best result. Collection continues in
    aioslsk's background so fallback data is available if needed.
    """
    global _last_search_at

    if not await _wait_ready(timeout):
        raise RuntimeError("Soulseek not connected")

    assert _client is not None

    async with _search_lock:
        wait = _MIN_SEARCH_INTERVAL - (time.monotonic() - _last_search_at)
        if wait > 0:
            await asyncio.sleep(wait)

        logger.info("Soulseek search: %s", query)
        request = await _client.searches.search(query)
        _last_search_at = time.monotonic()

    _SEARCH_MAX_PEERS = 100   # stop early once we have enough peer responses
    _EXCELLENT_CHECK_INTERVAL = 0.25  # poll for excellent results every N seconds

    # Track seen files to avoid duplicates across result batches
    seen_files: set[tuple[str, str]] = set()
    excellent_result: List[Tuple[str, str, int]] | None = None
    # Track rough availability for similar filenames across peers.
    avail_counts: dict[str, int] = {}

    async def _collect_results():
        nonlocal excellent_result
        elapsed = 0.0
        interval = _EXCELLENT_CHECK_INTERVAL
        last_check = 0.0

        while elapsed < collect_for:
            best_excellent: tuple[float, str, str, int] | None = None
            # Check for new results and score them
            for r in request.results:
                for f in r.shared_items:
                    size = int(f.filesize or 0)
                    if size < _MIN_AUDIO_BYTES:
                        continue
                    ext = (f.extension or "").lower().lstrip(".")
                    if ext and ext not in _AUDIO_EXTS:
                        continue
                    file_key = (r.username, f.filename)
                    if file_key in seen_files:
                        continue
                    seen_files.add(file_key)

                    akey = _availability_key(f.filename or "")
                    avail_counts[akey] = avail_counts.get(akey, 0) + 1
                    availability = avail_counts.get(akey, 1)

                    score = _score_file(r, f, artist, title, album, availability=availability)
                    # Only consider early-exit once we've collected a bit (avoid "fast find" bias),
                    # and only if the peer is likely to start downloading immediately.
                    if (
                        elapsed >= _EXCELLENT_MIN_COLLECT
                        and getattr(r, "has_free_slots", False)
                        and int(r.avg_speed or 0) >= _EXCELLENT_MIN_SPEED
                        and (ext == "flac")
                        and score >= _EXCELLENT_THRESHOLD
                    ):
                        cand = (score, r.username, f.filename, size)
                        if best_excellent is None or cand[0] > best_excellent[0]:
                            best_excellent = cand

            if best_excellent is not None:
                score, user, path, size = best_excellent
                logger.info(
                    "EXCELLENT result: score=%.3f elapsed=%.2fs user=%r ext=%r availability=%d path=%r size=%d",
                    score, elapsed, user,
                    (path.rsplit('.', 1)[-1].lower() if '.' in path else ''),
                    avail_counts.get(_availability_key(path), 1),
                    path, size,
                )
                excellent_result = [(user, path, size)]
                return  # early exit

            if len(request.results) >= _SEARCH_MAX_PEERS:
                logger.debug("Got %d peers, stopping early", len(request.results))
                break

            # Only sleep if no excellent result found
            await asyncio.sleep(interval)
            elapsed += interval

    try:
        await _collect_results()
    finally:
        timer = getattr(request, "timer", None)
        if timer is not None:
            try:
                timer.cancel()
            except Exception:
                logger.debug("search timer cancel (ignored)", exc_info=True)
        try:
            _client.searches.remove_request(request)
        except Exception as e:
            logger.debug("remove_request failed (ignored): %s", e)

    # If we found an excellent result, return it immediately
    if excellent_result is not None:
        logger.debug("Returning excellent result immediately (score >= %s)", _EXCELLENT_THRESHOLD)
        return excellent_result

    # Full ranking: one walk of results, collect candidates, then score with final availability counts
    _candidate_rows: list[tuple[Any, Any, int, str, str]] = []  # (r, f, size, ext, akey)
    for r in request.results:
        if (r.avg_speed or 0) < _MIN_RELAY_SPEED:
            continue
        for f in r.shared_items:
            size = int(f.filesize or 0)
            if size < _MIN_AUDIO_BYTES:
                continue
            ext = (f.extension or "").lower().lstrip(".")
            if ext and ext not in _AUDIO_EXTS:
                continue
            akey = _availability_key(f.filename or "")
            _candidate_rows.append((r, f, size, ext, akey))

    avail_by_key: Counter[str] = Counter(akey for *_, akey in _candidate_rows)

    _scored_hits: List[Tuple[float, str, str, int]] = []
    for r, f, size, _ext, akey in _candidate_rows:
        availability = int(avail_by_key[akey] or 1)
        score = _score_file(r, f, artist, title, album, availability=availability)
        _scored_hits.append((score, r.username, f.filename, size))
    _scored_hits.sort(key=lambda x: x[0], reverse=True)
    hits_all = [(u, p, s) for _sc, u, p, s in _scored_hits]
    hits_flac = [(u, p, s) for (u, p, s) in hits_all if (p or "").lower().endswith(".flac")]
    # MP3 should be last resort: if we have any FLAC candidates, prefer them exclusively.
    # Slow/queued behavior is handled by speed/slot gating and (optionally) future mid-download aborts.
    hits = hits_flac or hits_all

    logger.info(
        "Soulseek search '%s' → %d users, %d ranked hits",
        query, len(request.results), len(hits),
    )
    logger.debug("Raw results: %d peers responded, after ranking/filtering: %d candidates", len(request.results), len(hits))
    for i, (_sc, u, p, sz) in enumerate(_scored_hits[:10]):
        logger.debug("  [%d] score=%.3f user=%r path=%r size=%d", i+1, _sc, u, p, sz)
    return hits


# --------------------------------------------------------------------------
# Download
# --------------------------------------------------------------------------

async def _wait_finalized(transfer, poll: float = 0.5, max_wait: float = 1800.0) -> None:
    """Wait until transfer.is_finalized(). max_wait is an absolute backstop
    (default 30 min) so a wedged transfer can't leak this coro even if the
    outer race/timeout is ever removed."""
    deadline = asyncio.get_event_loop().time() + max_wait
    while not transfer.is_finalized():
        if asyncio.get_event_loop().time() >= deadline:
            raise asyncio.TimeoutError("transfer not finalized within max_wait")
        await asyncio.sleep(poll)


async def download_file(
    username: str,
    remote_path: str,
    timeout: float = 600.0,
    track_id: Optional[int] = None,
    abort_on_no_progress: bool = True,
) -> Optional[str]:
    """Download a file and block until it finalizes. Returns local path or None.

    Every created Transfer is removed from aioslsk's internal list before
    we return — otherwise its background task re-queues QUEUED/INCOMPLETE/
    FAILED transfers on its own (see aioslsk.transfer.manager._get_queued_transfers),
    which causes the same file to be downloaded again with a `(1)`/`(2)` suffix
    long after our coroutine has exited.
    """
    from aioslsk.transfer.model import TransferState

    if not await _wait_ready(timeout):
        raise RuntimeError("Soulseek not connected")

    assert _client is not None

    async with _download_gate:
        logger.info("Soulseek download start: %s/%s", username, remote_path)
        transfer = await _client.transfers.download(username, remote_path)

        poll_task: Optional[asyncio.Task] = None
        no_progress_event = asyncio.Event()
        if track_id is not None:
            async def _poll_progress(tid: int) -> None:
                last_progress_monotonic = asyncio.get_event_loop().time()
                no_progress_ticks = 0
                while not transfer.is_finalized():
                    await asyncio.sleep(0.5)
                    cb = _progress_by_track.get(tid)
                    if cb is None:
                        continue
                    filesize = transfer.filesize or 1
                    bytes_done = transfer.bytes_transfered or 0
                    if abort_on_no_progress and bytes_done <= 0:
                        no_progress_ticks += 1
                        if no_progress_ticks >= 20:
                            logger.warning("No-progress stall detected (ticks=%d); aborting download to try next candidate: %s/%s", no_progress_ticks, username, remote_path)
                            no_progress_event.set()
                            try:
                                abort_fn = getattr(transfer, "abort", None)
                                if abort_fn is not None:
                                    res = abort_fn("no_progress")
                                    if asyncio.iscoroutine(res):
                                        await res
                            except Exception:
                                logger.debug("transfer abort no_progress (ignored)", exc_info=True)
                            break
                    elif bytes_done > 0:
                        no_progress_ticks = 0
                        last_progress_monotonic = asyncio.get_event_loop().time()
                    now = asyncio.get_event_loop().time()
                    if abort_on_no_progress and (now - last_progress_monotonic) > 30.0:
                        logger.warning("30s stall detected (no bytes progressed); aborting download to try next candidate: %s/%s", username, remote_path)
                        no_progress_event.set()
                        try:
                            abort_fn = getattr(transfer, "abort", None)
                            if abort_fn is not None:
                                res = abort_fn("no_progress")
                                if asyncio.iscoroutine(res):
                                    await res
                        except Exception:
                            logger.debug("transfer abort 30s stall (ignored)", exc_info=True)
                        break
                    if bytes_done > 0 and tid not in _inflight_paths and transfer.local_path:
                        async with _inflight_lock:
                            _inflight_paths[tid] = str(transfer.local_path)
                            if filesize > 1:
                                _inflight_filesizes[tid] = filesize
                    percent = int(min(bytes_done / filesize * 100, 100))
                    elapsed = now - last_progress_monotonic
                    speed = (bytes_done) / elapsed if elapsed > 0 else 0.0
                    fs: int | None = int(filesize) if filesize and filesize > 1 else None
                    try:
                        result = cb(percent, bytes_done, speed, fs)
                        if asyncio.iscoroutine(result):
                            await result
                    except Exception as e:
                        logger.debug("progress callback error: %s", e)
            poll_task = asyncio.create_task(_poll_progress(track_id))

        result_path: Optional[str] = None
        try:
            try:
                finalized_task = asyncio.create_task(_wait_finalized(transfer))
                stall_task = asyncio.create_task(no_progress_event.wait())
                done, pending = await asyncio.wait(
                    {finalized_task, stall_task},
                    timeout=timeout,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for t in pending:
                    t.cancel()
                if stall_task in done and no_progress_event.is_set():
                    _cleanup_partial(transfer)
                    return None
                if finalized_task not in done:
                    raise asyncio.TimeoutError()
            except asyncio.TimeoutError:
                logger.warning(
                    "Soulseek download timed out: %s/%s (state=%s, %s/%s bytes)",
                    username, remote_path, transfer.state.VALUE,
                    transfer.bytes_transfered, transfer.filesize,
                )
                _cleanup_partial(transfer)
                return None

            state = transfer.state.VALUE
            if state == TransferState.COMPLETE:
                logger.info("Soulseek download complete: %s", transfer.local_path)
                result_path = transfer.local_path
                return result_path

            logger.warning(
                "Soulseek download ended in %s (fail=%s abort=%s) for %s/%s",
                state, transfer.fail_reason, transfer.abort_reason,
                username, remote_path,
            )
            _cleanup_partial(transfer)
            return None
        finally:
            if poll_task is not None:
                poll_task.cancel()
                try:
                    await poll_task
                except asyncio.CancelledError:
                    pass
            await _purge_transfer(transfer)
            if track_id is not None:
                async with _inflight_lock:
                    _inflight_paths.pop(track_id, None)
                    _inflight_filesizes.pop(track_id, None)


async def _purge_transfer(transfer) -> None:
    """Remove a transfer from aioslsk so its manager can't auto-requeue it.

    `remove()` internally calls `abort()` first, which is a no-op on COMPLETE
    transfers (raises InvalidStateTransition, caught inside aioslsk) — safe
    for both success and failure paths.
    """
    if _client is None:
        return
    try:
        await _client.transfers.remove(transfer)
    except Exception as e:
        logger.debug("transfer remove failed (ignored) for %s/%s: %s",
                     transfer.username, transfer.remote_path, e)


def _cleanup_partial(transfer) -> None:
    """Delete the local file for an aborted/failed transfer so retry attempts
    don't accumulate `NAME (1).flac`, `(2)`, ... duplicates."""
    path = getattr(transfer, "local_path", None)
    if not path:
        return
    try:
        if os.path.isfile(path):
            os.remove(path)
            logger.info("Removed partial file: %s", path)
    except Exception as e:
        logger.debug("partial cleanup failed for %s: %s", path, e)
