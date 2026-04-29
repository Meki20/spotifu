import os
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def extract_quality(file_path: str) -> Optional[str]:
    if not file_path or not os.path.isfile(file_path):
        return None

    try:
        from mutagen import File as MutagenFile

        audio = MutagenFile(file_path, easy=False)
        if audio is None:
            logger.warning("mutagen could not read file: %s", file_path)
            return None

        info = audio.info

        if hasattr(info, "channels") and hasattr(info, "sample_rate") and hasattr(info, "bits_per_sample"):
            sample_rate_khz = info.sample_rate / 1000.0
            bit_depth = info.bits_per_sample
            ext = Path(file_path).suffix.upper().lstrip(".")
            if ext == "FLAC":
                return f"FLAC {bit_depth}/{sample_rate_khz}khz"
            elif ext == "WAV":
                return f"WAV {bit_depth}/{sample_rate_khz}khz"

        if hasattr(info, "bitrate") and info.bitrate:
            bitrate_kbps = info.bitrate // 1000
            ext = Path(file_path).suffix.upper().lstrip(".")
            if ext == "MP3":
                return f"MP3 {bitrate_kbps}kbps"
            elif ext == "OGG":
                return f"OGG {bitrate_kbps}kbps"

        return None

    except Exception:
        logger.warning("Quality extraction failed for: %s", file_path, exc_info=True)
        return None