import { useEffect, useRef, useState } from 'react'

// ===== Color → frequency (same algorithm as Live page) =====
// Returns the frequency in Hz that corresponds to a color when we treat
// the doubled-up frequency of the color's wavelength as a musical pitch.
function rgbToBaseFreq(r: number, g: number, b: number): number {
    // Convert RGB to dominant wavelength via HSV hue
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const delta = max - min
    if (delta === 0) {
        // Grey — pick middle of visible spectrum (~575 nm, yellow)
        return wavelengthToHz(575)
    }
    let h: number
    if (max === r) h = ((g - b) / delta) % 6
    else if (max === g) h = (b - r) / delta + 2
    else h = (r - g) / delta + 4
    h *= 60
    if (h < 0) h += 360
    // Map hue (0..360) to visible wavelength (380..750 nm)
    // Red (0°) → ~700 nm, Violet (270°) → ~400 nm
    const wavelength = 700 - (h / 360) * 320
    return wavelengthToHz(wavelength)
}

function wavelengthToHz(nm: number): number {
    // Light freq in Hz = c / wavelength
    const lightHz = 299792458 / (nm * 1e-9)
    // Halve repeatedly until in audible range (~20 Hz – 20 kHz)
    let f = lightHz
    while (f > 500) f /= 2
    return f
}

interface ColorBucket {
    r: number
    g: number
    b: number
    count: number
    saturation: number
    brightness: number
    whiteness: number   // 1 = pure white, 0 = pure colour
}

// Bucket pixels into ~30-step RGB cubes and aggregate
function extractBuckets(imageData: ImageData): ColorBucket[] {
    const data = imageData.data
    const map = new Map<string, ColorBucket>()
    const STEP = 30   // bucket size in RGB; smaller = more buckets

    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2]
        const alpha = data[i + 3]
        if (alpha < 32) continue   // skip transparent pixels

        const key = `${Math.floor(r / STEP)},${Math.floor(g / STEP)},${Math.floor(b / STEP)}`
        const existing = map.get(key)
        if (existing) {
            existing.count++
        } else {
            const max = Math.max(r, g, b)
            const min = Math.min(r, g, b)
            const brightness = max / 255   // 0..1
            const saturation = max === 0 ? 0 : (max - min) / max   // 0..1
            const whiteness = min / 255    // 0..1; high when all channels are bright
            map.set(key, { r, g, b, count: 1, saturation, brightness, whiteness })
        }
    }

    return Array.from(map.values())
}

// Generate a 5-second buffer of summed sines at every bucket's frequency.
// transpose = semitone offset for the piano.
// Start playing a chord from the given buckets, transposed by N semitones.
// Returns a stop function that releases the chord with a smooth fade-out.
function startChord(
    ctx: AudioContext,
    buckets: ColorBucket[],
    transposeSemitones: number,
): () => void {
    if (buckets.length === 0) return () => { }

    // Master gain — so we can fade in on attack and fade out on release
    const master = ctx.createGain()
    master.gain.setValueAtTime(0, ctx.currentTime)
    master.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 0.05)   // 50ms attack
    master.connect(ctx.destination)

    const weighted = buckets
        .map(b => ({
            ...b,
            weight: b.count * (0.2 + 0.8 * b.saturation) * (0.2 + 0.8 * b.brightness),
        }))
        .sort((a, b) => b.weight - a.weight)

    const totalWeight = weighted.reduce((s, b) => s + b.weight, 0)
    const transposeFactor = Math.pow(2, transposeSemitones / 12)

    const oscillators: { osc: OscillatorNode; gain: GainNode }[] = []

    for (const bucket of weighted) {
        const baseFreq = rgbToBaseFreq(bucket.r, bucket.g, bucket.b)
        const freq = baseFreq * transposeFactor
        if (freq < 20 || freq > ctx.sampleRate / 2) continue

        const amp = (bucket.weight / totalWeight) * 0.8

        // Build partials: fundamental plus 2nd and 3rd if note is "impure" (white-ish)
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

    // Return a stop function that fades out and disconnects everything
    return () => {
        const now = ctx.currentTime
        master.gain.cancelScheduledValues(now)
        master.gain.setValueAtTime(master.gain.value, now)
        master.gain.linearRampToValueAtTime(0, now + 0.3)   // 300ms release
        // Stop each oscillator after the fade completes
        for (const { osc } of oscillators) {
            try { osc.stop(now + 0.35) } catch { }
        }
    }
}

// Piano key labels — one octave of semitones around C
const PIANO_KEYS = [
    { label: 'C', semitone: -9, black: false },
    { label: 'C♯', semitone: -8, black: true },
    { label: 'D', semitone: -7, black: false },
    { label: 'D♯', semitone: -6, black: true },
    { label: 'E', semitone: -5, black: false },
    { label: 'F', semitone: -4, black: false },
    { label: 'F♯', semitone: -3, black: true },
    { label: 'G', semitone: -2, black: false },
    { label: 'G♯', semitone: -1, black: true },
    { label: 'A', semitone: 0, black: false },
    { label: 'A♯', semitone: 1, black: true },
    { label: 'B', semitone: 2, black: false },
    { label: 'C', semitone: 3, black: false },
]

export default function Notes() {
    const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
    const [buckets, setBuckets] = useState<ColorBucket[]>([])
    const [maxBuckets, setMaxBuckets] = useState(50)
    const [activeKey, setActiveKey] = useState<number | null>(null)
    const [octaveOffset, setOctaveOffset] = useState(0)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const audioCtxRef = useRef<AudioContext | null>(null)

    function getAudioContext(): AudioContext {
        if (!audioCtxRef.current) {
            audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
        }
        return audioCtxRef.current
    }

    function handleFile(file: File) {
        const reader = new FileReader()
        reader.onload = (e) => {
            const url = e.target?.result as string
            setImageDataUrl(url)

            const img = new Image()
            img.onload = () => {
                // Downscale to a manageable size for pixel analysis (~300px max edge)
                const maxEdge = 300
                const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
                const w = Math.floor(img.width * scale)
                const h = Math.floor(img.height * scale)
                const canvas = document.createElement('canvas')
                canvas.width = w
                canvas.height = h
                const ctx = canvas.getContext('2d')!
                ctx.drawImage(img, 0, 0, w, h)
                const pixels = ctx.getImageData(0, 0, w, h)
                const extracted = extractBuckets(pixels)
                setBuckets(extracted)
            }
            img.src = url
        }
        reader.readAsDataURL(file)
    }

    // Holds the active chord's stop function while a key is pressed
    const stopChordRef = useRef<(() => void) | null>(null)

    function pressKey(transposeSemitones: number) {
        if (buckets.length === 0) return
        const ctx = getAudioContext()

        // Stop any currently-playing chord (e.g. user pressed a new key without releasing)
        if (stopChordRef.current) {
            stopChordRef.current()
            stopChordRef.current = null
        }

        const topBuckets = [...buckets]
            .sort((a, b) => (b.count * b.saturation * b.brightness) - (a.count * a.saturation * a.brightness))
            .slice(0, maxBuckets)

        stopChordRef.current = startChord(ctx, topBuckets, transposeSemitones + octaveOffset * 12)
    }

    function releaseKey() {
        if (stopChordRef.current) {
            stopChordRef.current()
            stopChordRef.current = null
        }
    }

    useEffect(() => {
        return () => {
            if (stopChordRef.current) stopChordRef.current()
            if (audioCtxRef.current) audioCtxRef.current.close()
        }
    }, [])

    return (
        <>
            <header className="masthead">
                <h1><span className="word w1">Notes</span></h1>
                <p className="lede">
                    Upload an image. Every distinct color in it becomes a note, summed into a 5-second
                    chord that&rsquo;s literally what the image &ldquo;sounds like.&rdquo; The piano below
                    lets you transpose the whole chord up or down.
                </p>
            </header>

            <section className="panel">
                <h2 className="panel-title"><span className="num">01</span> drop in an image</h2>

                <label className="dropzone">
                    <input
                        type="file"
                        accept="image/*"
                        hidden
                        ref={fileInputRef}
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                    />
                    <div className="dropzone-inner">
                        <div className="dz-icon" aria-hidden="true">&#127912;</div>
                        <div className="dz-text">
                            <span className="dz-primary">{imageDataUrl ? 'change image' : 'choose an image'}</span>
                            <span className="dz-secondary">jpg · png · webp · gif</span>
                        </div>
                    </div>
                </label>

                {imageDataUrl && (
                    <img src={imageDataUrl} alt="uploaded" className="notes-preview" />
                )}

                {buckets.length > 0 && (
                    <div className="control" style={{ marginTop: '1.25rem' }}>
                        <label htmlFor="max_buckets">
                            <span className="control-name">Notes played simultaneously</span>
                            <span className="control-desc">
                                Top N most-prominent colors mixed together. Higher = more faithful to the image,
                                lower = cleaner chord. {buckets.length} distinct colors detected.
                            </span>
                        </label>
                        <div className="control-row">
                            <input
                                type="range"
                                id="max_buckets"
                                min={5}
                                max={Math.min(500, buckets.length)}
                                step={1}
                                value={Math.min(maxBuckets, buckets.length)}
                                onChange={(e) => setMaxBuckets(parseInt(e.target.value))}
                            />
                            <output>{Math.min(maxBuckets, buckets.length)}</output>
                        </div>
                    </div>
                )}
            </section>

            {buckets.length > 0 && (
                <section className="panel">
                    <h2 className="panel-title"><span className="num">02</span> play the chord</h2>
                    <p style={{ color: 'var(--ink-dim)', fontSize: '0.9rem', marginBottom: '1rem' }}>
                        Press a piano key to play the chord at that pitch.
                    </p>

                    <div className="control" style={{ marginBottom: '1.25rem' }}>
                        <label htmlFor="octave_offset">
                            <span className="control-name">Octave</span>
                            <span className="control-desc">
                                Shift the whole chord up or down by octaves. 0 = original, +1 = one octave up, -1 = one octave down.
                            </span>
                        </label>
                        <div className="control-row">
                            <input
                                type="range"
                                id="octave_offset"
                                min={-3}
                                max={3}
                                step={1}
                                value={octaveOffset}
                                onChange={(e) => setOctaveOffset(parseInt(e.target.value))}
                            />
                            <output>{octaveOffset >= 0 ? '+' : ''}{octaveOffset}</output>
                        </div>
                    </div>

                    <div className="piano">
                        {PIANO_KEYS.map((key, i) => (
                            <button
                                key={i}
                                className={'piano-key ' + (key.black ? 'black' : 'white') + (activeKey === i ? ' active' : '')}
                                onMouseDown={() => { setActiveKey(i); pressKey(key.semitone) }}
                                onMouseUp={() => { setActiveKey(null); releaseKey() }}
                                onMouseLeave={() => { if (activeKey === i) { setActiveKey(null); releaseKey() } }}
                                onTouchStart={(e) => { e.preventDefault(); setActiveKey(i); pressKey(key.semitone) }}
                                onTouchEnd={() => { setActiveKey(null); releaseKey() }}
                            >
                                <span className="piano-key-label">{key.label}</span>
                            </button>
                        ))}
                    </div>
                </section>
            )}
        </>
    )
}