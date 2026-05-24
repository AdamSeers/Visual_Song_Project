"""End-to-end audio file -> MP4 visualization pipeline.

Stages:
    1. Load audio (mono, 22050 Hz).
    2. Strip percussion via HPSS so the visualization stays pitch-driven.
    3. Compute one STFT column per video frame (hop = sr / fps).
    4. For each frame: detect spectral peaks, estimate per-peak timbre.
    5. Update the NoteTracker, render the frame, push to ffmpeg over stdin.
    6. ffmpeg muxes the rendered video with the ORIGINAL (unfiltered) audio.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import Callable, Optional

import numpy as np

from .audio import (
    compute_stft,
    filter_harmonics,
    find_frame_peaks,
    harmonic_timbre_sharpness,
    load_audio,
    separate_harmonic,
    harmonic_purity,
)
from .render import render_frame
from .tracker import NoteTracker


ProgressCb = Optional[Callable[[float], None]]


def _check_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg not found on PATH. Install it (e.g. `apt install ffmpeg` "
            "or `brew install ffmpeg`) and try again."
        )


def process_audio_to_video(
    input_audio_path: str,
    output_video_path: str,
    width: int = 854,
    height: int = 480,
    fps: int = 30,
    sample_rate: int = 22050,
    n_fft: int = 4096,
    min_freq: float = 60.0,
    max_freq: float = 8000.0,
    amplitude_floor: float = 0.20,
    min_observed_frames: int = 7,
    freq_smooth: float = 0.18,
    fade_in_frames: int = 3,
    fade_out_frames: int = 8,
    audio_offset: float = 0.2,
    progress_callback: ProgressCb = None,
) -> str:
    """Convert an audio file into a 480p MP4 visualization.

    The output contains the ORIGINAL audio (HPSS is only used for analysis,
    not for the soundtrack).
    """
    _check_ffmpeg()

    if not os.path.isfile(input_audio_path):
        raise FileNotFoundError(input_audio_path)

    y, sr = load_audio(input_audio_path, sr=sample_rate)
    if y.size == 0:
        raise ValueError("Audio file appears to be empty.")

    duration = len(y) / sr
    hop_length = max(1, int(round(sr / fps)))

    # Pitch-only signal for analysis
    y_harm = separate_harmonic(y)
    freqs, _times, S = compute_stft(y_harm, sr, hop_length, n_fft=n_fft)

    # Normalize the spectrogram to a perceptually reasonable 0-1 range.
    eps = 1e-7
    S_db = 20.0 * np.log10(S + eps)
    db_top = float(np.percentile(S_db, 99.0))
    db_bot = db_top - 60.0     # 60 dB of dynamic range
    S_norm = np.clip((S_db - db_bot) / (db_top - db_bot + 1e-9), 0.0, 1.0)

    tracker = NoteTracker(
        match_tolerance_cents=80.0,
        fade_in_frames=fade_in_frames,
        fade_out_frames=fade_out_frames,
        min_observed_frames=min_observed_frames,
        freq_smooth=freq_smooth,
    )

    num_frames = min(S.shape[1], int(round(duration * fps)))

    cmd = [
        "ffmpeg", "-y",
        "-loglevel", "error",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "-",
        "-itsoffset", f"{audio_offset:.3f}",
        "-i", input_audio_path,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "libx264",
        "-preset", "medium",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        output_video_path,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)

    try:
        for f_idx in range(num_frames):
            mag = S[:, f_idx]
            mag_norm = S_norm[:, f_idx]

            raw_peaks = find_frame_peaks(
                mag, freqs,
                min_freq=min_freq, max_freq=max_freq,
                prominence_ratio=0.05, max_peaks=60,
            )
            # Collapse harmonic stacks into their fundamentals so we render
            # one shape per note, not one per overtone.
            fundamentals = filter_harmonics(raw_peaks)

            observations = []
            for freq, _amp in fundamentals:
                idx = int(np.argmin(np.abs(freqs - freq)))
                amp_n = float(mag_norm[idx])
                if amp_n < amplitude_floor:
                    continue
                sharpness = harmonic_timbre_sharpness(mag, freqs, freq)
                purity = harmonic_purity(mag, freqs, freq)
                observations.append((freq, amp_n, sharpness, purity))

            tracker.update(observations, f_idx)
            frame_rgb = render_frame(tracker.visible_notes(), width, height)
            proc.stdin.write(frame_rgb.tobytes())

            if progress_callback is not None and f_idx % 15 == 0:
                progress_callback(f_idx / max(1, num_frames))
    except BrokenPipeError:
        # ffmpeg died early; capture its error below
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
