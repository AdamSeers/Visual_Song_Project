"""Image search by color composition.

Tries a local color-matching service (see the .NET sketch in /color-api).
If the service is unreachable or returns no match, returns None — the
renderer falls back to drawing solid color bars.
"""

from __future__ import annotations

import json
import os
import tempfile
import urllib.parse
import urllib.request
from typing import List, Optional, Tuple

# (rgb_tuple, weight_in_0_to_1)
ColorWeight = Tuple[Tuple[int, int, int], float]

# The .NET service URL. Override via env var if it runs somewhere else.
API_BASE = os.environ.get("COLOR_API_BASE", "http://localhost:5050")
API_TIMEOUT_SECONDS = 2.0

# Where downloaded images get cached. Survives between requests but is
# disposable — wipe it any time.
CACHE_DIR = os.path.join(tempfile.gettempdir(), "visual_song_image_cache")
os.makedirs(CACHE_DIR, exist_ok=True)

def reset_cache() -> None:
    """Wipe the image cache. Called at the start of each render job."""
    if not os.path.isdir(CACHE_DIR):
        os.makedirs(CACHE_DIR, exist_ok=True)
        return
    for name in os.listdir(CACHE_DIR):
        path = os.path.join(CACHE_DIR, name)
        try:
            if os.path.isfile(path):
                os.remove(path)
        except OSError:
            pass


def _rgb_to_hex(rgb: Tuple[int, int, int]) -> str:
    return "{:02x}{:02x}{:02x}".format(*rgb)


def _query_api(palette: List[ColorWeight], accuracy: float = 0.7) -> Optional[str]:
    """Hit the .NET color-match API. Returns an image path or None."""
    body = {
        "accuracy": accuracy,
        "colors": [
            {"r": rgb[0], "g": rgb[1], "b": rgb[2], "weight": round(weight, 4)}
            for rgb, weight in palette
        ],
    }
    url = "{}/api/colors".format(API_BASE.rstrip("/"))
    try:
        data_bytes = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url, data=data_bytes, method="POST",
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=API_TIMEOUT_SECONDS) as resp:
            data = json.loads(resp.read())
        if "image_path" in data and data["image_path"]:
            return data["image_path"]
        if "image_url" in data and data["image_url"]:
            return _download_to_cache(data["image_url"])
    except Exception:
        return None
    return None

""" EXAMPLE
POST /api/colors HTTP/1.1
Host: localhost:5050
Content-Type: application/json
Accept: application/json
Content-Length: 187

{
  "accuracy": 0.7,
  "colors": [
    {"r": 255, "g": 120, "b": 0,   "weight": 0.45},
    {"r": 0,   "g": 216, "b": 255, "weight": 0.30},
    {"r": 120, "g": 0,   "b": 232, "weight": 0.15},
    {"r": 255, "g": 0,   "b": 0,   "weight": 0.10}
  ]
}
"""
# HAS TO RETURN AN ABSOLUTE IMAGE PATH
    # could also return a https link


def _download_to_cache(url: str) -> Optional[str]:
    """Download an image URL to the cache dir, return local path."""
    # Cache key from URL (no path traversal risk: only hex chars)
    import hashlib
    key = hashlib.sha1(url.encode("utf-8")).hexdigest()
    # Try to guess a sensible extension
    ext = ".jpg"
    for candidate in (".jpg", ".jpeg", ".png", ".webp"):
        if candidate in url.lower():
            ext = candidate
            break
    path = os.path.join(CACHE_DIR, key + ext)
    if os.path.exists(path):
        return path
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "visual-song"})
        with urllib.request.urlopen(req, timeout=API_TIMEOUT_SECONDS * 2) as resp:
            with open(path, "wb") as fh:
                fh.write(resp.read())
        return path
    except Exception:
        return None


def get_image(palette: List[ColorWeight]) -> Optional[str]:
    """Find an image matching the given color palette.

    Returns a local filesystem path, or None to fall back to color bars.
    """
    if not palette:
        return None
    return _query_api(palette)