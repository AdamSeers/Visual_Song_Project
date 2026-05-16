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
    load_audio,
    separate_harmonic,
)
from .color import freq_to_rgb
from .image_search import get_image, reset_cache


ProgressCb = Optional[Callable[[float], None]]


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
        for freq, _amp in fundamentals:
            idx = int(np.argmin(np.abs(freqs - freq)))
            amp_n = float(mag_norm[idx])
            if amp_n < 0.1:
                continue
            rgb = freq_to_rgb(freq)
            # Bucket nearby colors so similar pitches contribute to the same entry
            key = (rgb[0] // 24 * 24, rgb[1] // 24 * 24, rgb[2] // 24 * 24)
            color_weights[key] = color_weights.get(key, 0.0) + amp_n

    if not color_weights:
        return [((0, 0, 0), 1.0)]

    # Sort by weight, take top N, normalize
    items = sorted(color_weights.items(), key=lambda x: -x[1])[:n_colors]
    total = sum(w for _, w in items)
    return [(rgb, w / total) for rgb, w in items]


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


def _load_image_to_frame(
    path: str, width: int, height: int,
) -> np.ndarray:
    """Load an image, crop-to-fit width x height, return HxWx3 uint8."""
    img = Image.open(path).convert("RGB")
    # Cover-style fit: scale so the image fills the canvas, then center-crop.
    src_w, src_h = img.size
    scale = max(width / src_w, height / src_h)
    new_w, new_h = int(round(src_w * scale)), int(round(src_h * scale))
    img = img.resize((new_w, new_h), Image.LANCZOS)
    left = (new_w - width) // 2
    top = (new_h - height) // 2
    img = img.crop((left, top, left + width, top + height))
    return np.asarray(img)


def process_audio_to_image_video(
    input_audio_path: str,
    output_video_path: str,
    images_per_beat: float = 4.0,
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
    segment_frames: List[np.ndarray] = []
    for seg_idx in range(len(cut_times) - 1):
        t_start = cut_times[seg_idx]
        t_end = cut_times[seg_idx + 1]
        f_start = int(round(t_start * fps))
        f_end = max(f_start + 1, int(round(t_end * fps)))

        palette = _palette_for_window(
            S, S_norm, freqs, f_start, f_end,
            min_freq=min_freq, max_freq=max_freq,
        )
        img_path = get_image(palette)
        if img_path and os.path.isfile(img_path):
            frame = _load_image_to_frame(img_path, width, height)
        else:
            frame = _make_fallback_frame(palette, width, height)
        segment_frames.append(frame)

        if progress_callback is not None and seg_idx % 4 == 0:
            progress_callback(0.5 * seg_idx / max(1, len(cut_times) - 1))

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
        "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
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

    return output_video_path