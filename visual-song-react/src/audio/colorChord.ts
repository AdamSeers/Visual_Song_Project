// Shared color → frequency → chord synthesis logic.
// Used by both the Notes page (single chord) and Song page (sequence of chords).

export interface ColorBucket {
    r: number
    g: number
    b: number
    count: number
    saturation: number
    brightness: number
    whiteness: number
}

export function rgbToBaseFreq(r: number, g: number, b: number): number {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const delta = max - min
    if (delta === 0) {
        return wavelengthToHz(575)
    }
    let h: number
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
    const wavelength = 700 - (h / 360) * 320
    return wavelengthToHz(wavelength)
}

export function wavelengthToHz(nm: number): number {
    const lightHz = 299792458 / (nm * 1e-9)
    let f = lightHz
    while (f > 500) f /= 2
    return f
}

export function bucketWeight(b: ColorBucket): number {
    return b.count * (0.2 + 0.8 * b.saturation) * (0.2 + 0.8 * b.brightness)
}

// Build a ColorBucket from a single hex color string ("#rrggbb").
// Used by the Song page where each color is a manual pick, not an
// extracted statistic from an image.
export function colorFromHex(hex: string): ColorBucket {
    const h = hex.replace('#', '')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    return {
        r, g, b,
        count: 1,
        saturation: max === 0 ? 0 : (max - min) / max,
        brightness: max / 255,
        whiteness: min / 255,
    }
}

// Live-oscillator chord synthesis. Returns a stop function for release.
// Used by Notes for piano keys; we'll reuse it for Song preview playback.
export function startChord(
    ctx: AudioContext,
    buckets: ColorBucket[],
    transposeSemitones: number,
    analyser: AnalyserNode | null = null,
): () => void {
    if (buckets.length === 0) return () => { }

    const master = ctx.createGain()
    master.gain.setValueAtTime(0, ctx.currentTime)
    master.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 0.05)
    if (analyser) {
        master.connect(analyser)
        analyser.connect(ctx.destination)
    } else {
        master.connect(ctx.destination)
    }

    const weighted = buckets
        .map(b => ({ ...b, weight: bucketWeight(b) }))
        .sort((a, b) => b.weight - a.weight)

    const totalWeight = weighted.reduce((s, b) => s + b.weight, 0)
    const transposeFactor = Math.pow(2, transposeSemitones / 12)

    const oscillators: { osc: OscillatorNode; gain: GainNode }[] = []

    for (const bucket of weighted) {
        const baseFreq = rgbToBaseFreq(bucket.r, bucket.g, bucket.b)
        const freq = baseFreq * transposeFactor
        if (freq < 20 || freq > ctx.sampleRate / 2) continue

        const amp = (bucket.weight / totalWeight) * 0.8
        const harmonics: { ratio: number; amp: number }[] = [{ ratio: 1, amp: 1.0 }]
        if (bucket.whiteness > 0.3) {
            const h = bucket.whiteness
            harmonics.push({ ratio: 2, amp: 0.3 * h })
            harmonics.push({ ratio: 3, amp: 0.15 * h })
        }

        for (const harm of harmonics) {
            const partialFreq = freq * harm.ratio
            if (partialFreq > ctx.sampleRate / 2) continue
            const osc = ctx.createOscillator()
            osc.type = 'sine'
            osc.frequency.value = partialFreq
            const gain = ctx.createGain()
            gain.gain.value = amp * harm.amp
            osc.connect(gain)
            gain.connect(master)
            osc.start()
            oscillators.push({ osc, gain })
        }
    }

    return () => {
        const now = ctx.currentTime
        master.gain.cancelScheduledValues(now)
        master.gain.setValueAtTime(master.gain.value, now)
        master.gain.linearRampToValueAtTime(0, now + 0.3)
        for (const { osc } of oscillators) {
            try { osc.stop(now + 0.35) } catch { }
        }
    }
}

// ===== Music theory: note name → hex color =====
// Given a note name like "A" or "F#" and an octave, find the color whose
// hue, when run through rgbToBaseFreq, produces (approximately) that
// note's frequency in equal temperament.

const NOTE_SEMITONES: { [name: string]: number } = {
    'C': -9, 'C#': -8, 'Db': -8,
    'D': -7, 'D#': -6, 'Eb': -6,
    'E': -5,
    'F': -4, 'F#': -3, 'Gb': -3,
    'G': -2, 'G#': -1, 'Ab': -1,
    'A': 0, 'A#': 1, 'Bb': 1,
    'B': 2,
}

function noteToFreq(name: string, octave: number = 3): number {
    // A4 = 440 Hz reference
    const semitonesFromA4 = NOTE_SEMITONES[name] + (octave - 4) * 12
    return 440 * Math.pow(2, semitonesFromA4 / 12)
}

// Find a wavelength (in nm) that when halved repeatedly (as in
// wavelengthToHz) lands on the target frequency.
function freqToWavelength(targetHz: number): number {
    // Reverse the halving: light freq = targetHz * 2^N for some N
    // such that wavelength = c / lightFreq is in 380..700 nm range.
    const c = 299792458
    for (let n = 30; n < 60; n++) {
        const lightHz = targetHz * Math.pow(2, n)
        const wavelength = c / lightHz * 1e9   // in nm
        if (wavelength >= 380 && wavelength <= 700) return wavelength
    }
    return 575   // fallback (yellow-ish)
}

// Convert HSV hue (0..360) at full saturation/value back to RGB.
function hueToRgb(h: number): { r: number; g: number; b: number } {
    const c = 1
    const x = 1 - Math.abs(((h / 60) % 2) - 1)
    let r = 0, g = 0, b = 0
    if (h < 60) { r = c; g = x }
    else if (h < 120) { r = x; g = c }
    else if (h < 180) { g = c; b = x }
    else if (h < 240) { g = x; b = c }
    else if (h < 300) { r = x; b = c }
    else { r = c; b = x }
    return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) }
}

// Wavelength (nm) → hue (degrees). Inverse of the wavelength = 700 - (h/360)*320 mapping.
function wavelengthToHue(nm: number): number {
    return ((700 - nm) / 320) * 360
}

export function noteToHex(name: string, octave: number = 3): string {
    const freq = noteToFreq(name, octave)
    const wavelength = freqToWavelength(freq)
    const hue = wavelengthToHue(wavelength)
    const { r, g, b } = hueToRgb(hue)
    const hex = (v: number) => v.toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}`
}

// ===== Chord recipes =====
// Each chord is a list of semitone offsets from the root.
export const CHORD_RECIPES: { [name: string]: number[] } = {
    'major': [0, 4, 7],
    'minor': [0, 3, 7],
    'dim': [0, 3, 6],
    'aug': [0, 4, 8],
    'sus2': [0, 2, 7],
    'sus4': [0, 5, 7],
    'maj7': [0, 4, 7, 11],
    'min7': [0, 3, 7, 10],
    '7': [0, 4, 7, 10],
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// Build a chord by name and type. Returns an array of hex colors.
export function buildChord(rootNote: string, chordType: string, octave: number = 3): string[] {
    const intervals = CHORD_RECIPES[chordType] || [0]
    const rootSemitone = NOTE_SEMITONES[rootNote] ?? 0
    return intervals.map(interval => {
        const noteSemitoneFromA4 = rootSemitone + interval
        // Find which named note that is (with octave wrap)
        const noteIdx = ((noteSemitoneFromA4 + 9) % 12 + 12) % 12   // 0=C, 1=C#, ...
        const noteName = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][noteIdx]
        const octaveAdjust = Math.floor((noteSemitoneFromA4 + 9) / 12)
        return noteToHex(noteName, octave + octaveAdjust)
    })
}

// ===== Offline rendering for export =====
// Renders a sequence of chord panels to a single Float32Array of audio samples.
// Uses OfflineAudioContext, which runs faster than real-time and avoids
// blocking the UI.

export type SongTransition = 'cut' | 'fade' | 'crossfade'

export interface SongPanel {
    colors: ColorBucket[]
    durationSec: number
    transition: SongTransition   // how to leave this panel into the next
}

export async function renderSongToBuffer(
    panels: SongPanel[],
    sampleRate: number = 44100,
): Promise<AudioBuffer> {
    if (panels.length === 0) {
        return new AudioBuffer({ length: 1, sampleRate, numberOfChannels: 1 })
    }

    // Total time depends on whether the last panel uses crossfade (no extra)
    // and whether crossfaded panels reduce the apparent length. For simplicity
    // we count panel.durationSec for each panel — overlaps happen but the
    // last panel determines the end.
    const totalSec = panels.reduce((s, p) => s + p.durationSec, 0)
    const totalSamples = Math.ceil(totalSec * sampleRate)
    const offlineCtx = new OfflineAudioContext(1, totalSamples, sampleRate)

    const FADE_SEC = 0.05      // 50 ms for cut/fade attack/release
    const CROSSFADE_SEC = 0.4  // 400 ms crossfade overlap

    let currentTime = 0
    for (let i = 0; i < panels.length; i++) {
        const panel = panels[i]
        const prevPanel = i > 0 ? panels[i - 1] : null

        // How does this panel come IN? Depends on the PREVIOUS panel's transition.
        const fadeInSec =
            prevPanel?.transition === 'crossfade' ? CROSSFADE_SEC :
                prevPanel?.transition === 'cut' ? FADE_SEC :
                    FADE_SEC   // 'fade' or no previous

        // How does this panel go OUT? Its own transition.
        const fadeOutSec =
            panel.transition === 'crossfade' ? CROSSFADE_SEC :
                panel.transition === 'cut' ? FADE_SEC :
                    FADE_SEC

        // If previous panel was a crossfade, this panel starts EARLY by CROSSFADE_SEC
        const adjustedStart = prevPanel?.transition === 'crossfade'
            ? currentTime - CROSSFADE_SEC
            : currentTime

        schedulePanelChord(
            offlineCtx,
            panel,
            Math.max(0, adjustedStart),
            fadeInSec,
            fadeOutSec,
        )
        currentTime += panel.durationSec
    }

    return await offlineCtx.startRendering()
}

function schedulePanelChord(
    ctx: OfflineAudioContext,
    panel: SongPanel,
    startTime: number,
    fadeInSec: number,
    fadeOutSec: number,
) {
    if (panel.colors.length === 0) return

    const endTime = startTime + panel.durationSec
    const sustainStart = startTime + fadeInSec
    const sustainEnd = Math.max(sustainStart, endTime - fadeOutSec)

    const master = ctx.createGain()
    master.gain.setValueAtTime(0, startTime)
    master.gain.linearRampToValueAtTime(0.8, sustainStart)
    master.gain.setValueAtTime(0.8, sustainEnd)
    master.gain.linearRampToValueAtTime(0, endTime)
    master.connect(ctx.destination)

    const weighted = panel.colors
        .map(b => ({ ...b, weight: bucketWeight(b) }))
    const totalWeight = weighted.reduce((s, b) => s + b.weight, 0) || 1

    for (const bucket of weighted) {
        const baseFreq = rgbToBaseFreq(bucket.r, bucket.g, bucket.b)
        if (baseFreq < 20 || baseFreq > ctx.sampleRate / 2) continue

        const amp = (bucket.weight / totalWeight) * 0.8
        const harmonics: { ratio: number; amp: number }[] = [{ ratio: 1, amp: 1.0 }]
        if (bucket.whiteness > 0.3) {
            const h = bucket.whiteness
            harmonics.push({ ratio: 2, amp: 0.3 * h })
            harmonics.push({ ratio: 3, amp: 0.15 * h })
        }

        for (const harm of harmonics) {
            const partialFreq = baseFreq * harm.ratio
            if (partialFreq > ctx.sampleRate / 2) continue
            const osc = ctx.createOscillator()
            osc.type = 'sine'
            osc.frequency.value = partialFreq
            const gain = ctx.createGain()
            gain.gain.value = amp * harm.amp
            osc.connect(gain)
            gain.connect(master)
            osc.start(startTime)
            osc.stop(endTime)
        }
    }
}