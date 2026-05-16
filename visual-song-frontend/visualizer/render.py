"""Frame renderer.

Each visible note becomes a shape on a black canvas:
    - colour  : frequency (via color.freq_to_rgb)
    - brightness : amplitude
    - shape   : timbre - round (low sharpness) -> square -> star (high sharpness)
    - size    : grows on fade-in, shrinks on fade-out

Notes are arranged in a square-cell grid that grows/shrinks with the
simultaneous count. Each surviving note keeps its grid slot frame-to-frame
so the layout doesn't churn; new notes get the lowest free slot.
"""

from __future__ import annotations

import math
from typing import List, Tuple

import numpy as np
from PIL import Image, ImageDraw

from .color import freq_to_rgb
from .tracker import Note

import colorsys

# Track when each grid slot was vacated, so we can avoid recycling slots too
# quickly (which looks like a shape teleporting from one position to another).
_slot_vacated_at: dict = {}        # slot index -> last frame it was free
_frame_counter = {"n": 0}          # local clock for the renderer
_SLOT_REUSE_DELAY_FRAMES = 45      # ≈1.5 s before a freed slot can be reused

# Persistent state across frames so the grid doesn't shrink the moment a
# note disappears. The high-water mark only relaxes after a grace period.
_grid_state = {
    "capacity": 0,            # current grid capacity in effect
    "frames_since_shrinkable": 0,  # how long the actual need has stayed below capacity
}

# How many frames the grid must be "over-sized" before it's allowed to shrink.
# At 30 fps, 90 frames ≈ 3 seconds.
_GRID_SHRINK_DELAY_FRAMES = 90


MAX_SLOTS = 8     # fixed 4x2 grid


def _vibrancy(note: Note) -> float:
    """How visually striking a note is. Loud + pure = vibrant."""
    amp = max(0.0, min(1.0, note.amplitude))
    purity = max(0.0, min(1.0, note.purity))
    return amp * (0.5 + 0.5 * purity)


def _assign_slots(notes: List[Note]) -> int:
    """Place notes in a fixed 8-slot grid, prioritizing vibrant ones,
    and ordering left-to-right by loudness.

    - Vibrant new notes can evict dull existing notes when the grid is full.
    - Every frame, the visible notes are sorted by amplitude (loudest first)
      and re-assigned to slots in that order, so loud notes sit on the left.
    """
    # Separate currently-slotted notes from new arrivals.
    slotted = [n for n in notes if 0 <= n.grid_slot < MAX_SLOTS]
    arrivals = [n for n in notes if not (0 <= n.grid_slot < MAX_SLOTS)]

    # If there's room, just admit the most vibrant arrivals.
    arrivals.sort(key=_vibrancy, reverse=True)
    free = MAX_SLOTS - len(slotted)
    admitted = arrivals[:free]
    leftover = arrivals[free:]

    # For any remaining arrivals, evict the dullest slotted note if the
    # arrival is meaningfully more vibrant.
    for newcomer in leftover:
        if not slotted:
            break
        # Find the dullest current resident
        dullest = min(slotted, key=_vibrancy)
        # Require a noticeable vibrancy advantage to evict (avoids churn).
        if _vibrancy(newcomer) > _vibrancy(dullest) * 1.2:
            dullest.grid_slot = -1   # kicked out
            slotted.remove(dullest)
            slotted.append(newcomer)
        # Else: arrival is silently dropped this frame.

    # Place newly-admitted notes into the lowest free slots.
    occupied_set = {n.grid_slot for n in slotted if 0 <= n.grid_slot < MAX_SLOTS}
    for note in admitted:
        for candidate in range(MAX_SLOTS):
            if candidate not in occupied_set:
                note.grid_slot = candidate
                occupied_set.add(candidate)
                break

    return MAX_SLOTS


def _grid_geometry(capacity: int, width: int, height: int) -> List[Tuple[float, float, float]]:
    """Fixed 4-column, 2-row grid filling the canvas with square cells."""
    cols, rows = 4, 2
    cell = min(width / cols, height / rows)
    grid_w = cols * cell
    grid_h = rows * cell
    x_off = (width - grid_w) / 2.0
    y_off = (height - grid_h) / 2.0
    positions: List[Tuple[float, float, float]] = []
    for i in range(cols * rows):
        c = i % cols
        r = i // cols
        cx = x_off + (c + 0.5) * cell
        cy = y_off + (r + 0.5) * cell
        positions.append((cx, cy, cell))
    return positions


def _draw_shape(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    cell: float,
    color: Tuple[int, int, int],
    sharpness: float,
    size_factor: float,
) -> None:
    """Draw one shape. sharpness 0 = round circle, 1 = sharp square."""
    s = cell * 0.42 * size_factor
    if s < 0.6:
        return

    # Map sharpness in [0, 1] to corner radius: 0 = full circle, 1 = sharp square.
    radius = s * (1.0 - float(np.clip(sharpness, 0.0, 1.0)))
    x0, y0, x1, y1 = cx - s, cy - s, cx + s, cy + s
    try:
        draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=color)
    except AttributeError:
        draw.rectangle([x0, y0, x1, y1], fill=color)


def render_frame(
    notes: List[Note],
    width: int = 854,
    height: int = 480,
) -> np.ndarray:
    """Render one video frame. Returns an HxWx3 uint8 RGB array."""
    img = Image.new("RGB", (width, height), (0, 0, 0))
    if not notes:
        return np.asarray(img)

    draw = ImageDraw.Draw(img)
    capacity = _assign_slots(notes)
    positions = _grid_geometry(capacity, width, height)

    center_x, center_y = width / 2.0, height / 2.0

    for note in notes:
        slot = note.grid_slot
        if slot < 0 or slot >= len(positions):
            continue
        slot_x, slot_y, slot_cell = positions[slot]

        # ---- Target position: slot, with quiet shapes pushed outward ----
        dx, dy = slot_x - center_x, slot_y - center_y
        dist = math.hypot(dx, dy)
        amp_clip = float(np.clip(note.amplitude, 0.0, 1.0))
        quietness = 1.0 - amp_clip

        if dist > 1.0:
            push = quietness * slot_cell * 0.4
            target_x = slot_x + (dx / dist) * push
            target_y = slot_y + (dy / dist) * push
        else:
            target_x, target_y = slot_x, slot_y
        target_cell = slot_cell

        # ---- Screen position: locked to slot, no easing ----
        cx, cy, cell = target_x, target_y, target_cell

        r, g, b = freq_to_rgb(note.freq)
        
        # Less pure notes (lots of overtones) → less saturated color.
        # purity=1 keeps the full vibrant hue; purity=0.2 (a voice) noticeably greys it.
        h_hsv, s_hsv, v_hsv = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        s_hsv *= float(np.clip(note.purity, 0.0, 1.0))
        # pour aller moins bas en saturation s_hsv *= 0.5 + 0.5 * float(np.clip(note.purity, 0.0, 1.0))
        r_f, g_f, b_f = colorsys.hsv_to_rgb(h_hsv, s_hsv, v_hsv)
        r, g, b = int(round(r_f * 255)), int(round(g_f * 255)), int(round(b_f * 255))

        # Amplitude controls brightness. Clamp + light shaping so very quiet
        # notes are still visible without being identical to loud ones.
        amp = float(np.clip(note.amplitude, 0.0, 1.0))
        amp = 0.15 + 0.85 * amp     # floor so quiet sounds are dim, not black

        # Fade animations modulate the whole RGB output and the size.
        fade_alpha = (1.0 - note.fade_out) * note.fade_in
        gain = amp * fade_alpha

        rgb = (
            int(round(r * gain)),
            int(round(g * gain)),
            int(round(b * gain)),
        )

        size_factor = 0.4 + 0.6 * note.fade_in

        _draw_shape(draw, cx, cy, cell, rgb, note.sharpness, size_factor)

    return np.asarray(img)
