# visual song

A small web app that turns an audio file into a 480p MP4 visualization
in which **every pitch becomes a coloured shape on a black canvas**.

- **Colour** ← pitch (frequency doubled into the visible-light band, then
  mapped to RGB using Dan Bruton's piecewise approximation).
- **Brightness** ← amplitude.
- **Shape** ← timbre — mellow tones round, bright/jangly tones squarer
  and ultimately star-like.
- **Position** ← a dynamic grid that grows and shrinks as notes appear
  and disappear.

The video keeps the original audio track and plays it alongside the visualization.

## How the pitch-to-colour mapping works

```
audio frequency (Hz)
    │
    │  repeatedly × 2  (or ÷ 2)
    ▼
frequency in the visible band (~400-790 THz)
    │
    │  λ = c / f
    ▼
wavelength (nm)
    │
    │  Dan Bruton's piecewise RGB approximation
    ▼
RGB colour
```

The visible spectrum spans almost exactly one octave, so the mapping is
**octave-periodic** — A2, A3, A4, A5 all land at the same orange-red. Every
other note maps consistently regardless of which octave it's in.

Pitch detection runs on a continuous frequency axis (FFT peaks with
parabolic interpolation) — there's no snapping to the 12-tone scale.
Glissandi and microtonal pitches slide smoothly through their colour
gradients.

## Project layout

```
song_visualizer/
├── app.py                    # Flask server
├── visualizer/
│   ├── color.py              # Pitch → RGB (Bruton)
│   ├── audio.py              # STFT, peak detection, harmonic filter, timbre
│   ├── tracker.py            # Match peaks across frames into persistent notes
│   ├── render.py             # Per-frame shape drawing
│   └── pipeline.py           # Audio file → MP4 (drives ffmpeg)
├── templates/index.html      # Upload page
├── static/style.css
├── requirements.txt
└── README.md
```

## Requirements

- Python 3.10+
- `ffmpeg` available on `PATH` (used for video encoding and audio mux)
- The Python packages in `requirements.txt`

On Debian/Ubuntu:

```bash
sudo apt install ffmpeg
```

On macOS (Homebrew):

```bash
brew install ffmpeg
```

## Setup

```bash
git clone <this directory> visualsong
cd visualsong
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
python app.py
```

Then open <http://localhost:5000> in a browser. Drop in an audio file
(mp3, wav, flac, ogg, m4a, aac, opus). The page will poll the server
while it renders and show the result in-page when it's done; a download
button is also provided.

The upload size limit is 75 MB by default — adjust `MAX_UPLOAD_BYTES`
in `app.py` if you need more.

## How long does rendering take?

Order-of-magnitude: rendering takes roughly **1×–2× real-time** on a
modern laptop (e.g. a 3-minute song produces in 3–6 minutes). The bulk
of the work is per-frame STFT peak detection and shape drawing; ffmpeg
encoding is fast in comparison.

If you want it faster, the cheap knobs are:

- Lower `n_fft` (default 4096) in `pipeline.py` — less frequency resolution.
- Lower `max_peaks` in `find_frame_peaks` — fewer shapes considered per frame.
- Lower `fps` (default 30) — fewer frames to render.

## Design notes / spec mapping

| Spec item | Implementation |
| --- | --- |
| Pitch → colour via frequency doubling + Bruton | `visualizer/color.py` |
| Continuous pitch (no note snapping) | FFT peaks + parabolic interpolation in `audio.py` |
| Shape per simultaneous frequency component | `tracker.py` matches peaks across frames |
| Brightness ← volume | `render.py` (amplitude scales RGB) |
| Shape ← timbre | `harmonic_timbre_sharpness` in `audio.py`; `_draw_shape` in `render.py` |
| Smooth slides / morphs | Exponential smoothing inside `Note.observe` (log-frequency, linear amplitude, linear timbre) |
| Dynamic grid, no max simultaneous count | `_assign_slots` + `_grid_geometry` in `render.py` |
| Black background | `render.py` (`Image.new("RGB", ..., (0, 0, 0))`) |
| Percussion handling | HPSS via `librosa.effects.hpss` in `audio.py` removes drums from analysis (the original audio still plays in the video). Pitch detection on noisy percussive transients was not robust enough to justify keeping them as shapes, so the spec's "otherwise, ignore percussion entirely" branch was taken. |
| 480p / 30fps / MP4 | `process_audio_to_video` defaults; H.264 video + AAC audio in MP4 container |

### Harmonic suppression

A naive FFT-peaks approach gives a separate shape for every overtone of
each note, which makes the screen busy and doesn't match the spec's
"shapes for sounds, with timbre encoded in shape." `filter_harmonics`
collapses harmonic stacks: a peak at *n × f* is dropped if there's a
stronger peak at *f* (n = 2…10). The remaining set of fundamentals is
what gets rendered, and the harmonic envelope of each fundamental is
what computes its timbre / sharpness.

### Pitch slides

Each `Note` smooths its frequency in log-space, so when the underlying
peak moves a few cents per frame the shape's colour glides through the
spectrum rather than snapping.

### Note lifecycle

- New peaks → new notes, fade in over 3 frames (~100 ms at 30 fps).
- A note that goes unmatched for one frame starts fading out.
- After 8 frames unseen, it's removed entirely.
- A surviving note keeps its grid slot; a new note takes the lowest free
  slot, so the grid stays compact.

## Knobs worth knowing

In `process_audio_to_video`:

- `min_freq=60`, `max_freq=8000` — pitch detection range.
- `amplitude_floor=0.08` — peaks below this normalised amplitude are
  ignored (cuts background noise).
- `n_fft=4096`, `sample_rate=22050` — STFT parameters.

In `NoteTracker.__init__`:

- `match_tolerance_cents=80` — how far a peak can drift between frames
  and still be counted as the same note.
- `fade_in_frames`, `fade_out_frames` — animation durations.
- `freq_smooth`, `amp_smooth`, `timbre_smooth` — smoothing factors.

## Limitations

- Vocals and other broadband, slightly inharmonic sources can produce
  more or fewer shapes than perceptual "voices" — pitch detection from a
  pure FFT is approximate. CREPE or YIN would give cleaner fundamentals
  but is much slower; not worth the complexity for an MVP.
- Glissandi that traverse more than ~80 cents per frame (~24 cents/10 ms)
  can break tracking and cause a colour pop. Raise
  `match_tolerance_cents` if your material does this often.
- The Flask job table is in-memory and single-process. For real
  deployment, swap in Redis/RQ or Celery and serve videos from a CDN.
