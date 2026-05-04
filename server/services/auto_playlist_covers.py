import base64
import io
from services.marble import make_marble
from typing import Literal


PlaylistCoverType = Literal["hottest_tracks", "weekly_discovery"]


def generate_playlist_cover(playlist_type: PlaylistCoverType, seed: int = None) -> str:
    if seed is None:
        import time
        seed = int(time.time() * 1000) % 10000
    if playlist_type == "hottest_tracks":
        return _generate_hottest_tracks_cover(seed)
    elif playlist_type == "weekly_discovery":
        return _generate_weekly_discovery_cover(seed)
    return _generate_default_cover(seed)


def _generate_hottest_tracks_cover(seed: int = 7) -> str:
    color_stops = [
        [0.00, 0.20, 0.02, 0.00],
        [0.15, 0.45, 0.04, 0.00],
        [0.35, 0.70, 0.10, 0.02],
        [0.55, 0.90, 0.25, 0.05],
        [0.70, 1.00, 0.45, 0.15],
        [0.85, 1.00, 0.70, 0.35],
        [1.00, 1.00, 0.85, 0.60],
    ]
    img = make_marble(1000, 1000, seed=seed, color_stops=color_stops)
    
    buffer = io.BytesIO()
    img.save(buffer, format="PNG", quality=95)
    b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{b64}"


def _generate_weekly_discovery_cover(seed: int = 13) -> str:
    color_stops = [
        [0.00, 0.20, 0.25, 0.45],
        [0.20, 0.40, 0.50, 0.70],
        [0.40, 0.55, 0.70, 0.85],
        [0.60, 0.70, 0.85, 0.95],
        [0.75, 0.85, 0.93, 1.00],
        [0.90, 0.95, 0.98, 1.00],
        [1.00, 1.00, 1.00, 1.00],
    ]
    img = make_marble(1000, 1000, seed=seed, color_stops=color_stops)
    
    buffer = io.BytesIO()
    img.save(buffer, format="PNG", quality=95)
    b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{b64}"


def _generate_default_cover(seed: int = 42) -> str:
    img = make_marble(1000, 1000, seed=seed)
    
    buffer = io.BytesIO()
    img.save(buffer, format="PNG", quality=95)
    b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
    return f"data:image/png;base64,{b64}"