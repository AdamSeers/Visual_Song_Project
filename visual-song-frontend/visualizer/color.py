"""Pitch-to-color mapping.

Algorithm (per flutopedia.com/sound_color.htm):
    1. Take an audio frequency in Hz.
    2. Double it repeatedly until it lands inside the visible-light band
       (~400-790 THz). The visible spectrum spans almost exactly one octave,
       so the resulting hue repeats every musical octave - A in any octave
       always lands near the red end, etc.
    3. Convert that visible-light frequency to wavelength, then to RGB
       using Dan Bruton's piecewise approximation.

The mapping is continuous: there's no snapping to discrete musical notes.
"""

from __future__ import annotations

# Constants
_SPEED_OF_LIGHT = 2.99792458e8        # m / s
_VIS_MIN_THZ = 400.0                  # red edge of visible light
_VIS_MAX_THZ = 790.0                  # violet edge of visible light


def freq_to_visible_thz(f_hz: float) -> float:
    """Double or halve the audio frequency until it lands in the visible band.

    Returns the equivalent visible-light frequency in THz, or 0.0 if the input
    is non-positive.
    """
    if f_hz <= 0.0:
        return 0.0
    f_thz = f_hz / 1.0e12
    # Double up into the visible range
    while f_thz < _VIS_MIN_THZ:
        f_thz *= 2.0
    # Halve down if we overshot
    while f_thz >= _VIS_MAX_THZ:
        f_thz /= 2.0
    return f_thz


def thz_to_wavelength_nm(f_thz: float) -> float:
    """Convert a frequency in THz to a wavelength in nanometres."""
    if f_thz <= 0.0:
        return 0.0
    f_hz = f_thz * 1.0e12
    return (_SPEED_OF_LIGHT / f_hz) * 1.0e9


def wavelength_to_rgb(wavelength_nm: float, gamma: float = 0.8) -> tuple[int, int, int]:
    """Dan Bruton's piecewise wavelength-to-RGB approximation.

    Input wavelength is in nm (visible band ~ 380-780 nm).
    Returns an (R, G, B) tuple of 0-255 integers.
    """
    w = wavelength_nm

    # Base spectral colour
    if 380.0 <= w < 440.0:
        r = -(w - 440.0) / (440.0 - 380.0)
        g = 0.0
        b = 1.0
    elif 440.0 <= w < 490.0:
        r = 0.0
        g = (w - 440.0) / (490.0 - 440.0)
        b = 1.0
    elif 490.0 <= w < 510.0:
        r = 0.0
        g = 1.0
        b = -(w - 510.0) / (510.0 - 490.0)
    elif 510.0 <= w < 580.0:
        r = (w - 510.0) / (580.0 - 510.0)
        g = 1.0
        b = 0.0
    elif 580.0 <= w < 645.0:
        r = 1.0
        g = -(w - 645.0) / (645.0 - 580.0)
        b = 0.0
    elif 645.0 <= w <= 780.0:
        r = 1.0
        g = 0.0
        b = 0.0
    else:
        return 0, 0, 0

    # Intensity falloff at the spectrum edges
    if 380.0 <= w < 420.0:
        factor = 0.3 + 0.7 * (w - 380.0) / (420.0 - 380.0)
    elif 420.0 <= w < 701.0:
        factor = 1.0
    elif 701.0 <= w <= 780.0:
        factor = 0.3 + 0.7 * (780.0 - w) / (780.0 - 700.0)
    else:
        factor = 0.0

    def _channel(c: float) -> int:
        if c <= 0.0:
            return 0
        return int(round(255.0 * (c * factor) ** gamma))

    return _channel(r), _channel(g), _channel(b)


def freq_to_rgb(f_hz: float) -> tuple[int, int, int]:
    """Audio frequency in Hz -> (R, G, B) 0-255 via frequency-doubling + Bruton."""
    if f_hz <= 0.0:
        return 0, 0, 0
    return wavelength_to_rgb(thz_to_wavelength_nm(freq_to_visible_thz(f_hz)))
