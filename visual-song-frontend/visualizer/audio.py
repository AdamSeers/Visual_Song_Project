"""Audio analysis: STFT, peak detection, and local spectral features.

Pitch detection uses raw FFT peaks with parabolic interpolation for
sub-bin frequency accuracy. This gives a *continuous* frequency estimate
rather than snapping to discrete musical notes.
"""

from __future__ import annotations

from typing import List, Tuple, Optional

import numpy as np
import librosa
from scipy.signal import find_peaks


def load_audio(path: str, sr: int = 22050) -> Tuple[np.ndarray, int]:
    """Load an audio file (any format librosa supports) as a mono float waveform."""
    y, sr = librosa.load(path, sr=sr, mono=True)
    return y, sr


def separate_harmonic(y: np.ndarray) -> np.ndarray:
    """Strip percussion from the signal using HPSS.

    The visualization treats percussion as out-of-scope unless pitch
    detection on it is trivial; HPSS is a clean way to suppress it.
    """
    y_harm, _y_perc = librosa.effects.hpss(y, margin=2.0)
    return y_harm


def compute_stft(
    y: np.ndarray, sr: int, hop_length: int, n_fft: int = 4096
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (freqs, times, magnitude_spectrogram)."""
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop_length, window="hann"))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    times = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr, hop_length=hop_length)
    return freqs, times, S


def find_frame_peaks(
    magnitude_column: np.ndarray,
    freqs: np.ndarray,
    min_freq: float = 60.0,
    max_freq: float = 8000.0,
    prominence_ratio: float = 0.04,
    min_distance_bins: int = 3,
    max_peaks: int = 60,
) -> List[Tuple[float, float]]:
    """Detect prominent spectral peaks in a single STFT frame.

    Returns a list of (frequency_hz, amplitude) tuples, strongest first.
    Frequencies are refined via parabolic interpolation.
    """
    mask = (freqs >= min_freq) & (freqs <= max_freq)
    band_freqs = freqs[mask]
    band_mag = magnitude_column[mask]

    if band_mag.size == 0 or band_mag.max() < 1e-7:
        return []

    prominence = float(band_mag.max() * prominence_ratio)
    peaks, _ = find_peaks(
        band_mag, prominence=prominence, distance=min_distance_bins
    )
    if peaks.size == 0:
        return []

    # Keep the strongest N
    order = np.argsort(band_mag[peaks])[::-1][:max_peaks]
    peaks = peaks[order]

    bin_width = band_freqs[1] - band_freqs[0] if len(band_freqs) > 1 else 0.0
    results: List[Tuple[float, float]] = []
    for p in peaks:
        if 0 < p < len(band_mag) - 1:
            a, b, c = band_mag[p - 1], band_mag[p], band_mag[p + 1]
            denom = a - 2.0 * b + c
            offset = 0.5 * (a - c) / denom if abs(denom) > 1e-12 else 0.0
            freq = float(band_freqs[p] + offset * bin_width)
        else:
            freq = float(band_freqs[p])
        amplitude = float(band_mag[p])
        results.append((freq, amplitude))
    return results


def filter_harmonics(
    peaks: List[Tuple[float, float]],
    tol_cents: float = 35.0,
    max_harmonic: int = 10,
    parent_ratio: float = 0.25,
) -> List[Tuple[float, float]]:
    """Remove peaks that are integer harmonics of stronger, lower peaks.

    A peak at ~n * f_low (n in 2..max_harmonic) is dropped if there's a
    lower peak at f_low whose amplitude is at least `parent_ratio` times
    the higher peak's amplitude (so a loud harmonic of a quiet phantom
    fundamental survives, but the usual case - quiet harmonics riding on
    a loud root - is cleaned up).

    Input may be in any order. Output preserves input order minus drops.
    """
    n = len(peaks)
    if n <= 1:
        return list(peaks)

    indexed = list(enumerate(peaks))
    # Sort by frequency so we can check each peak against lower ones.
    indexed.sort(key=lambda x: x[1][0])

    drop = [False] * n
    for j in range(len(indexed)):
        i_high, (f_high, a_high) = indexed[j]
        if drop[i_high]:
            continue
        for k in range(j):
            i_low, (f_low, a_low) = indexed[k]
            if drop[i_low] or f_low <= 0:
                continue
            ratio = f_high / f_low
            n_h = int(round(ratio))
            if n_h < 2 or n_h > max_harmonic:
                continue
            # How close to an integer multiple? (in cents)
            cents_err = 1200.0 * abs(np.log2(ratio / n_h))
            if cents_err > tol_cents:
                continue
            if a_low >= parent_ratio * a_high:
                drop[i_high] = True
                break

    return [p for i, p in enumerate(peaks) if not drop[i]]


def harmonic_timbre_sharpness(
    magnitude_column: np.ndarray,
    freqs: np.ndarray,
    fundamental: float,
    n_harmonics: int = 8,
) -> float:
    """Estimate timbre 'sharpness' from the harmonic envelope of one note.

    Sharpness in [0, 1]:
      - 0 = pure sine / mellow / round.
      - 1 = lots of strong upper harmonics, or noisy / inharmonic content.
    """
    if fundamental <= 0:
        return 0.4

    # Sample magnitude at each expected harmonic (nearest bin)
    harmonics_amp = []
    for h in range(1, n_harmonics + 1):
        f_h = fundamental * h
        if f_h > freqs[-1]:
            break
        idx = int(np.argmin(np.abs(freqs - f_h)))
        # Take the max within +/- 1 bin to be robust to slight detuning
        lo = max(0, idx - 1)
        hi = min(len(magnitude_column), idx + 2)
        harmonics_amp.append(float(magnitude_column[lo:hi].max()))

    if len(harmonics_amp) < 2 or harmonics_amp[0] <= 1e-9:
        return 0.4

    h_arr = np.asarray(harmonics_amp)
    total = float(h_arr.sum())
    if total <= 0.0:
        return 0.4

    # Centre-of-mass over the harmonic series. 1 = energy at fundamental;
    # higher = energy concentrated in upper harmonics.
    weights = np.arange(1, len(h_arr) + 1, dtype=float)
    com = float((weights * h_arr).sum() / total)
    # Map COM in [1, n_harmonics] to [0, 1].
    bright_term = np.clip((com - 1.0) / (len(h_arr) - 1), 0.0, 1.0)

    # Inharmonicity: noise floor between the harmonic peaks. High = noisy.
    lo = max(0, int(np.argmin(np.abs(freqs - fundamental * 0.7))))
    hi = min(
        len(magnitude_column),
        int(np.argmin(np.abs(freqs - fundamental * (len(h_arr) + 0.5)))) + 1,
    )
    band = magnitude_column[lo:hi] + 1e-10
    if band.size > 4:
        geo = float(np.exp(np.mean(np.log(band))))
        ari = float(band.mean())
        flatness = geo / ari
    else:
        flatness = 0.0
    flat_term = np.clip(flatness * 3.0, 0.0, 1.0)

    sharpness = 0.65 * bright_term + 0.35 * flat_term
    return float(np.clip(sharpness, 0.0, 1.0))




def harmonic_purity(
    magnitude_column: np.ndarray,
    freqs: np.ndarray,
    fundamental: float,
    n_harmonics: int = 8,
) -> float:
    """Estimate spectral purity in [0, 1].

    1.0 = all energy at the fundamental (pure sine).
    Low values = energy spread across many overtones (voice, brass, strings).
    """
    if fundamental <= 0:
        return 0.5
    amps = []
    for h in range(1, n_harmonics + 1):
        f_h = fundamental * h
        if f_h > freqs[-1]:
            break
        idx = int(np.argmin(np.abs(freqs - f_h)))
        lo = max(0, idx - 1)
        hi = min(len(magnitude_column), idx + 2)
        amps.append(float(magnitude_column[lo:hi].max()))
    if not amps or sum(amps) <= 1e-9:
        return 0.5
    return float(amps[0] / sum(amps))