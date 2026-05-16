"""Note tracking across STFT frames.

Each Note represents a persistent spectral peak. From frame to frame we
match new peaks to existing notes by frequency proximity (in cents); if a
peak doesn't match anything, a new note is born. Notes that go unseen
fade out gradually rather than popping off, which gives shapes a smooth
appear/disappear behavior.

Frequency, amplitude and timbre are exponentially smoothed inside a note
so that a glissando produces a smooth colour slide rather than a series
of discrete jumps, and timbre changes morph the shape rather than
snapping it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Tuple

# (freq_hz, amplitude, sharpness, purity) — all 0..1 except freq
Observation = Tuple[float, float, float, float]


@dataclass
class Note:
    id: int
    freq: float
    amplitude: float
    sharpness: float
    first_frame: int
    last_seen_frame: int
    purity: float = 1.0
    frames_observed: int = 1
    frames_missing: int = 0
    fade_out: float = 0.0   # 0 = fully visible, 1 = invisible
    fade_in: float = 0.0    # ramps 0 -> 1 over first few frames
    grid_slot: int = -1
    screen_x: float = -1.0    # actual rendered position, eased toward slot
    screen_y: float = -1.0
    screen_cell: float = -1.0

    def observe(
        self,
        freq: float,
        amplitude: float,
        sharpness: float,
        purity: float,
        frame_idx: int,
        freq_smooth: float,
        amp_smooth: float,
        timbre_smooth: float,
    ) -> None:
        # Smooth frequency geometrically (perceptually logarithmic)
        self.freq = math.exp(
            (1.0 - freq_smooth) * math.log(self.freq) + freq_smooth * math.log(freq)
        )
        self.amplitude = (1.0 - amp_smooth) * self.amplitude + amp_smooth * amplitude
        self.purity = (
            1.0 - timbre_smooth
        ) * self.purity + timbre_smooth * purity
        self.last_seen_frame = frame_idx
        self.frames_missing = 0
        # Gradual recovery instead of snap — matters for revived notes that
        # were already partway faded. Normal active notes were at 0 anyway.
        self.fade_out = max(0.0, self.fade_out - 0.2)
        self.frames_observed += 1


class NoteTracker:
    """Greedy frequency-distance matcher with fade-in/fade-out."""

    _next_id = 1

    def __init__(
        self,
        match_tolerance_cents: float = 80.0,
        fade_in_frames: int = 3,
        fade_out_frames: int = 8,

        # changer à 8 ou 10 si c'est encore trop rapide les carrés
        # si c'est trop lent, drop à 3
        min_observed_frames: int = 7,
        freq_smooth: float = 0.18,
        amp_smooth: float = 0.45,
        timbre_smooth: float = 0.20,
    ) -> None:
        self.notes: List[Note] = []
        self.tol = match_tolerance_cents
        self.fade_in_frames = max(1, fade_in_frames)
        self.min_observed_frames = max(1, min_observed_frames)
        self.fade_out_frames = max(1, fade_out_frames)
        self.freq_smooth = freq_smooth
        self.amp_smooth = amp_smooth
        self.timbre_smooth = timbre_smooth

    def _new_id(self) -> int:
        nid = NoteTracker._next_id
        NoteTracker._next_id += 1
        return nid

    @staticmethod
    def _cents_distance(f1: float, f2: float) -> float:
        if f1 <= 0.0 or f2 <= 0.0:
            return float("inf")
        return 1200.0 * abs(math.log2(f1 / f2))

    def update(self, peaks: List[Observation], frame_idx: int) -> None:
        # Sort existing notes by amplitude so loud notes claim matches first.
        # This avoids a quiet harmonic stealing the slot of a louder one.
        existing = sorted(self.notes, key=lambda n: -n.amplitude)
        remaining: list = list(peaks)

        for note in existing:
            if note.fade_out >= 1.0:
                continue
            best_idx = -1
            best_dist = self.tol
            for i, obs in enumerate(remaining):
                if obs is None:
                    continue
                dist = self._cents_distance(note.freq, obs[0])
                if dist < best_dist:
                    best_dist = dist
                    best_idx = i
            if best_idx >= 0:
                f, a, s, p = remaining[best_idx]
                note.observe(
                    f, a, s, p, frame_idx,
                    self.freq_smooth, self.amp_smooth, self.timbre_smooth,
                )
                remaining[best_idx] = None

        fading = [
            n for n in self.notes
            if 0.0 < n.fade_out < 0.25
            and n.frames_observed >= self.min_observed_frames
        ]
        # Sort by how-faded ascending — least-faded gets first dibs on a peak.
        fading.sort(key=lambda n: n.fade_out)

        for note in fading:
            best_idx = -1
            best_dist = 350.0     # cents — handoffs only across moderate pitch gaps
            for i, obs in enumerate(remaining):
                if obs is None:
                    continue
                dist = self._cents_distance(note.freq, obs[0])
                if dist < best_dist:
                    best_dist = dist
                    best_idx = i
            if best_idx >= 0:
                f, a, s, p = remaining[best_idx]
                note.observe(
                    f, a, s, p, frame_idx,
                    self.freq_smooth, self.amp_smooth, self.timbre_smooth,
                )
                remaining[best_idx] = None

        # Unmatched peaks -> new notes
        for obs in remaining:
            if obs is None:
                continue
            f, a, s, p = obs
            self.notes.append(
                Note(
                    id=self._new_id(),
                    freq=f,
                    amplitude=a,
                    sharpness=s,
                    first_frame=frame_idx,
                    last_seen_frame=frame_idx,
                    purity=p,
                    fade_in=0.0,
                )
            )

        # Advance fade animations for every note this frame
        for note in self.notes:
            if note.last_seen_frame != frame_idx:
                note.frames_missing += 1
                note.fade_out = min(1.0, note.frames_missing / self.fade_out_frames)
            else:
                # Active note: advance fade-in
                note.fade_in = min(
                    1.0, note.fade_in + 1.0 / self.fade_in_frames
                )

        # Drop notes that have fully faded out
        self.notes = [n for n in self.notes if n.fade_out < 1.0]

    def visible_notes(self) -> List[Note]:
        # Hide notes that haven't lived long enough — kills the flicker of
        # one-frame peaks and brief noise that doesn't represent a real note.
        return [n for n in self.notes if n.frames_observed >= self.min_observed_frames]
