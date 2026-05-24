"""Beat-synced image renderer.

Given an audio file: detect beats, compute the dominant color palette in each
beat-division window, fetch a matching image (or fall back to solid colors),
and pipe the frame sequence to ffmpeg.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Callable, List, Optional, Tuple

import numpy as np
import librosa
from PIL import Image

from .audio import (
    compute_stft,
    filter_harmonics,
    find_frame_peaks,
    harmonic_purity,
    load_audio,
    separate_harmonic,
)
from .color import freq_to_rgb
from .image_search import get_image, reset_cache

import colorsys

ProgressCb = Optional[Callable[[float], None]]

def _desaturate(rgb, purity):
    """Reduce a color's saturation toward grey based on purity in [0,1].

    purity=1 (pure tone, e.g. sine) -> full vibrant color.
    purity=0.2 (overtone-rich, e.g. voice) -> noticeably muted.
    Mirrors the squares-mode behavior.
    """
    r, g, b = rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    s *= max(0.0, min(1.0, purity))
    r2, g2, b2 = colorsys.hsv_to_rgb(h, s, v)
    return (int(round(r2 * 255)), int(round(g2 * 255)), int(round(b2 * 255)))

def _check_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH")


def _detect_beats(y: np.ndarray, sr: int) -> np.ndarray:
    """Return beat times in seconds, with time-varying tempo support.
    Falls back to a fixed-tempo grid if librosa can't find beats."""
    try:
        _tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, tightness=100)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr)
        if len(beat_times) < 2:
            raise ValueError("too few beats")
        return beat_times
    except Exception:
        # Fallback: assume 120 bpm
        duration = len(y) / sr
        return np.arange(0, duration, 0.5)


def _palette_for_window(
    S: np.ndarray, S_norm: np.ndarray, freqs: np.ndarray,
    frame_start: int, frame_end: int,
    min_freq: float, max_freq: float,
    n_colors: int = 5,
) -> List[Tuple[Tuple[int, int, int], float]]:
    """Aggregate spectral peaks across [frame_start, frame_end) into a palette."""
    color_weights: dict = {}   # (r, g, b) -> total weight
    for f_idx in range(frame_start, frame_end):
        if f_idx >= S.shape[1]:
            break
        mag = S[:, f_idx]
        mag_norm = S_norm[:, f_idx]
        peaks = find_frame_peaks(
            mag, freqs, min_freq=min_freq, max_freq=max_freq,
            prominence_ratio=0.05, max_peaks=20,
        )
        fundamentals = filter_harmonics(peaks)
        fundamentals = filter_harmonics(peaks)
        for freq, _amp in fundamentals:
            idx = int(np.argmin(np.abs(freqs - freq)))
            amp_n = float(mag_norm[idx])
            if amp_n < 0.1:
                continue
            purity = harmonic_purity(mag, freqs, freq)
            rgb = _desaturate(freq_to_rgb(freq), purity)
            # Bucket nearby colors so similar pitches contribute to the same entry
            key = (rgb[0] // 24 * 24, rgb[1] // 24 * 24, rgb[2] // 24 * 24)
            color_weights[key] = color_weights.get(key, 0.0) + amp_n

    if not color_weights:
        return [((0, 0, 0), 1.0)]

    # Sort by weight descending
    items = sorted(color_weights.items(), key=lambda x: -x[1])

    # Merge threshold in HSV space. Hue is a circle (0..1 wrapping), so two
    # purples that differ slightly in lightness/saturation but share a hue
    # collapse together — which raw RGB distance fails to do for purples.
    HUE_TOL = 0.06        # ~22 degrees of hue
    SV_TOL = 0.35         # allow fairly different saturation/value to still merge

    import colorsys as _cs

    def _hsv(rgb):
        return _cs.rgb_to_hsv(rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0)

    def _hue_close(h1, h2):
        d = abs(h1 - h2)
        return min(d, 1.0 - d) <= HUE_TOL    # wrap-around aware

    merged = []  # list of [ [r,g,b], weight, (h,s,v) ]
    for rgb, w in items:
        h, s, v = _hsv(rgb)
        placed = False
        for entry in merged:
            eh, es, ev = entry[2]
            # Two greys (very low saturation) merge on value alone; coloured
            # entries must share a hue and be roughly similar in s/v.
            if s < 0.15 and es < 0.15:
                if abs(v - ev) <= SV_TOL:
                    entry[1] += w
                    placed = True
                    break
            elif _hue_close(h, eh) and abs(s - es) <= SV_TOL and abs(v - ev) <= SV_TOL:
                entry[1] += w
                placed = True
                break
        if not placed:
            merged.append([[rgb[0], rgb[1], rgb[2]], w, (h, s, v)])

    # Keep only the top N after merging, then normalize weights to sum to 1
    merged = merged[:n_colors]
    total = sum(e[1] for e in merged) or 1.0
    return [((e[0][0], e[0][1], e[0][2]), e[1] / total) for e in merged]


def _make_fallback_frame(
    palette: List[Tuple[Tuple[int, int, int], float]], width: int, height: int,
) -> np.ndarray:
    """Solid color blocks proportional to the palette weights. Used when
    get_image() returns None."""
    img = Image.new("RGB", (width, height), (0, 0, 0))
    pixels = np.asarray(img).copy()
    x = 0
    for (rgb, weight) in palette:
        block_w = int(round(width * weight))
        if block_w <= 0:
            continue
        pixels[:, x:x + block_w] = rgb
        x += block_w
    if x < width:
        # Fill any remaining width with the dominant color
        pixels[:, x:] = palette[0][0]
    return pixels


# Hard cap on the source image's largest dimension before any processing.
# 1080p = 1920x1080; longest side never exceeds 1920.
MAX_IMAGE_LONG_EDGE = 1920


def _load_image_to_frame(
    path: str, width: int, height: int,
) -> np.ndarray:
    """Load an image, rotate verticals to landscape, cap at 1080p, then
    stretch to exactly width x height (no crop). Returns HxWx3 uint8."""
    img = Image.open(path).convert("RGB")

    # Respect EXIF orientation first (phone photos store rotation in metadata)
    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass

    src_w, src_h = img.size

    # Rotate portrait images 90 degrees so they're landscape like the video.
    if src_h > src_w:
        img = img.rotate(90, expand=True)
        src_w, src_h = img.size

    # Cap the source at 1080p (longest edge <= 1920) to limit memory/time.
    longest = max(src_w, src_h)
    if longest > MAX_IMAGE_LONG_EDGE:
        scale = MAX_IMAGE_LONG_EDGE / longest
        img = img.resize(
            (int(round(src_w * scale)), int(round(src_h * scale))),
            Image.LANCZOS,
        )

    # Stretch to exactly the video frame size. This distorts aspect ratio
    # on purpose (you asked for stretch, not crop).
    img = img.resize((width, height), Image.LANCZOS)
    return np.asarray(img)


def process_audio_to_image_video(
    input_audio_path: str,
    output_video_path: str,
    images_per_beat: float = 2.0,
    accuracy: float = 0.9,
    debug_no_images: bool = False,
    width: int = 854,
    height: int = 480,
    fps: int = 30,
    sample_rate: int = 22050,
    n_fft: int = 4096,
    min_freq: float = 60.0,
    max_freq: float = 8000.0,
    audio_offset: float = 0.0,
    progress_callback: ProgressCb = None,
) -> str:
    """Convert audio to a beat-synced image-cut video.

    images_per_beat:
        > 1 means multiple images per beat (e.g., 4.0 = quarter-note subdivisions
        if the beat is a quarter note, so really 16th-note cuts).
        < 1 means many beats per image (e.g., 0.25 = one image every 4 beats).
    """
    _check_ffmpeg()

    if not os.path.isfile(input_audio_path):
        raise FileNotFoundError(input_audio_path)

    reset_cache()
    
    y, sr = load_audio(input_audio_path, sr=sample_rate)
    if y.size == 0:
        raise ValueError("Audio file appears to be empty.")

    duration = len(y) / sr
    hop_length = max(1, int(round(sr / fps)))

    # Pitch analysis on harmonic part
    y_harm = separate_harmonic(y)
    freqs, _times, S = compute_stft(y_harm, sr, hop_length, n_fft=n_fft)
    eps = 1e-7
    S_db = 20.0 * np.log10(S + eps)
    db_top = float(np.percentile(S_db, 99.0))
    db_bot = db_top - 60.0
    S_norm = np.clip((S_db - db_bot) / (db_top - db_bot + 1e-9), 0.0, 1.0)

    # Beat detection
    beat_times = _detect_beats(y, sr)

    # Build the list of cut times = beat times subdivided/expanded by images_per_beat
    cut_times: List[float] = []
    if images_per_beat >= 1.0:
        # Subdivide each beat interval
        div = int(round(images_per_beat))
        for i in range(len(beat_times) - 1):
            t0, t1 = beat_times[i], beat_times[i + 1]
            for k in range(div):
                cut_times.append(t0 + (t1 - t0) * k / div)
        cut_times.append(beat_times[-1])
    else:
        # One image every N beats
        step = int(round(1.0 / images_per_beat))
        for i in range(0, len(beat_times), step):
            cut_times.append(beat_times[i])
    cut_times.append(duration)   # sentinel for the last segment

    # For each cut interval, pick a palette and fetch an image
    # ---- Pass 1: compute every segment's palette (cheap, no network) ----
    segment_palettes: List[list] = []
    for seg_idx in range(len(cut_times) - 1):
        t_start = cut_times[seg_idx]
        t_end = cut_times[seg_idx + 1]
        f_start = int(round(t_start * fps))
        f_end = max(f_start + 1, int(round(t_end * fps)))
        palette = _palette_for_window(
            S, S_norm, freqs, f_start, f_end,
            min_freq=min_freq, max_freq=max_freq,
        )
        segment_palettes.append(palette)
        if progress_callback is not None and seg_idx % 16 == 0:
            # Pass 1 is the first 15% of the progress bar
            progress_callback(0.15 * seg_idx / max(1, len(cut_times) - 1))

    # ---- Build a dedup key so repeated palettes are queried only once ----
    def _palette_key(palette):
        return tuple(
            (r // 16, g // 16, b // 16, round(w, 1))
            for (r, g, b), w in palette
        )

    # Map: dedup key -> one representative palette
    distinct_map = {}
    for palette in segment_palettes:
        k = _palette_key(palette)
        if k not in distinct_map:
            distinct_map[k] = palette

    distinct_items = list(distinct_map.items())   # [(key, palette), ...]

    # ---- Pass 2: query each DISTINCT palette once, in parallel ----
    from concurrent.futures import ThreadPoolExecutor

    images_found = 0
    images_missing = 0
    frame_cache = {}   # dedup key -> rendered HxWx3 frame

    def _resolve(item):
        key, palette = item
        img_path = get_image(
            palette, accuracy=accuracy, debug_no_images=debug_no_images
        )
        return key, palette, img_path

    total_distinct = max(1, len(distinct_items))
    done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for key, palette, img_path in pool.map(_resolve, distinct_items):
            if img_path and os.path.isfile(img_path):
                frame_cache[key] = _load_image_to_frame(img_path, width, height)
                images_found += 1
            else:
                frame_cache[key] = _make_fallback_frame(palette, width, height)
                images_missing += 1
                if img_path and not os.path.isfile(img_path):
                    print(f"[image_render] API returned a path Python can't read: {img_path}")
            done += 1
            if progress_callback is not None and done % 4 == 0:
                # Pass 2 is 15%..50% of the progress bar
                progress_callback(0.15 + 0.35 * done / total_distinct)

    # ---- Assemble per-segment frames from the cache ----
    segment_frames: List[np.ndarray] = [
        frame_cache[_palette_key(p)] for p in segment_palettes
    ]

    print(f"[image_render] {len(segment_palettes)} segments, "
          f"{len(distinct_items)} distinct palettes "
          f"({images_found} matched, {images_missing} fell back)")

    # Now emit one frame per video frame, looking up which segment we're in
    num_frames = int(round(duration * fps))

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-vcodec", "rawvideo",
        "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "-",
        "-itsoffset", f"{audio_offset:.3f}",
        "-i", input_audio_path,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264",
        "-preset", "medium",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        output_video_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    try:
        seg_idx = 0
        for f_idx in range(num_frames):
            t = f_idx / fps
            # Advance to current segment
            while seg_idx + 1 < len(cut_times) - 1 and t >= cut_times[seg_idx + 1]:
                seg_idx += 1
            if seg_idx >= len(segment_frames):
                break
            proc.stdin.write(segment_frames[seg_idx].tobytes())

            if progress_callback is not None and f_idx % 30 == 0:
                progress_callback(0.5 + 0.5 * f_idx / max(1, num_frames))
    except BrokenPipeError:
        pass
    finally:
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:
            pass
        ret = proc.wait()
        if ret != 0:
            raise RuntimeError(f"ffmpeg exited with code {ret}")

    if progress_callback is not None:
        progress_callback(1.0)

    total = images_found + images_missing
    if total:
        print(f"[image_render] {images_found}/{total} segments used real images, "
              f"{images_missing} fell back to color bars")
    return output_video_path