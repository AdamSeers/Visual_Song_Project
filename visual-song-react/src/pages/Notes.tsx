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
    analyser: AnalyserNode,
): () => void {
    if (buckets.length === 0) return () => { }

    // Master gain — so we can fade in on attack and fade out on release
    const master = ctx.createGain()
    master.gain.setValueAtTime(0, ctx.currentTime)
    master.gain.linearRampToValueAtTime(0.8, ctx.currentTime + 0.05)   // 50ms attack
    master.connect(analyser)
    analyser.connect(ctx.destination)

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
    const [isProcessing, setIsProcessing] = useState(false)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const audioCtxRef = useRef<AudioContext | null>(null)

    //lissajous
    const lissajousCanvasRef = useRef<HTMLCanvasElement>(null)
    const analyserRef = useRef<AnalyserNode | null>(null)
    const animationFrameRef = useRef<number | null>(null)
    const isPlayingRef = useRef(false)
    const releaseStartTimeRef = useRef<number | null>(null)

    function startLissajousLoop() {
        if (animationFrameRef.current !== null) return
        const canvas = lissajousCanvasRef.current
        const analyser = analyserRef.current
        console.log('[lissajous] start; canvas:', canvas, 'analyser:', analyser)
        if (!canvas || !analyser) {
            console.warn('[lissajous] missing canvas or analyser — aborting')
            return
        }
        const ctx2d = canvas.getContext('2d')
        if (!ctx2d) return

        const W = canvas.width, H = canvas.height
        const waveform = new Float32Array(analyser.fftSize)
        const RELEASE_MS = 500
        let frameCount = 0

        const draw = () => {
            let opacity = 1
            if (!isPlayingRef.current && releaseStartTimeRef.current !== null) {
                const elapsed = performance.now() - releaseStartTimeRef.current
                opacity = Math.max(0, 1 - elapsed / RELEASE_MS)
                if (opacity <= 0) {
                    ctx2d.fillStyle = '#000'
                    ctx2d.fillRect(0, 0, W, H)
                    animationFrameRef.current = null
                    return
                }
            }

            ctx2d.fillStyle = 'rgba(0, 0, 0, 0.25)'
            ctx2d.fillRect(0, 0, W, H)

            analyser.getFloatTimeDomainData(waveform)

            // DIAGNOSTIC: log every 30 frames (~half second)
            if (frameCount % 30 === 0) {
                let max = 0
                for (let i = 0; i < waveform.length; i++) max = Math.max(max, Math.abs(waveform[i]))
                console.log('[lissajous] frame', frameCount, 'waveform peak:', max.toFixed(4), 'W/H:', W, H)
            }
            frameCount++

            const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7aa2f7'
            ctx2d.globalAlpha = opacity
            ctx2d.strokeStyle = accent
            ctx2d.lineWidth = 1.5

            const delay = 32
            const samplesToDraw = Math.min(waveform.length - delay, 1024)
            ctx2d.beginPath()
            for (let i = 0; i < samplesToDraw; i++) {
                const x = (waveform[i] * 0.9 + 1) * 0.5 * W
                const y = (waveform[i + delay] * 0.9 + 1) * 0.5 * H
                if (i === 0) ctx2d.moveTo(x, y)
                else ctx2d.lineTo(x, y)
            }
            ctx2d.stroke()
            ctx2d.globalAlpha = 1

            animationFrameRef.current = requestAnimationFrame(draw)
        }

        draw()
    }

    function getAudioContext(): AudioContext {
        if (!audioCtxRef.current) {
            audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
            const analyser = audioCtxRef.current.createAnalyser()
            analyser.fftSize = 2048
            analyser.smoothingTimeConstant = 0
            analyserRef.current = analyser
        }
        return audioCtxRef.current
    }

    function handleFile(file: File) {
        setIsProcessing(true)
        setBuckets([])   // clear any previous chord while we re-extract
        const reader = new FileReader()
        reader.onload = (e) => {
            const url = e.target?.result as string
            setImageDataUrl(url)

            const img = new Image()
            img.onload = () => {
                // Defer the heavy work one tick so the spinner can paint first.
                // Without this, the browser jumps straight from "no spinner" to
                // "done" without ever rendering the spinner frame.
                setTimeout(() => {
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
                    setIsProcessing(false)
                }, 0)
            }
            img.onerror = () => {
                setIsProcessing(false)
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

        if (stopChordRef.current) {
            stopChordRef.current()
            stopChordRef.current = null
        }

        const topBuckets = [...buckets]
            .sort((a, b) => (b.count * b.saturation * b.brightness) - (a.count * a.saturation * a.brightness))
            .slice(0, maxBuckets)

        stopChordRef.current = startChord(ctx, topBuckets, transposeSemitones + octaveOffset * 12, analyserRef.current!)
        isPlayingRef.current = true
        releaseStartTimeRef.current = null
        startLissajousLoop()
    }

    function releaseKey() {
        if (stopChordRef.current) {
            stopChordRef.current()
            stopChordRef.current = null
        }
        isPlayingRef.current = false
        releaseStartTimeRef.current = performance.now()
    }

    useEffect(() => {
        return () => {
            if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current)
            if (stopChordRef.current) stopChordRef.current()
            if (audioCtxRef.current) audioCtxRef.current.close()
        }
    }, [])

    return (
        <>
            <header className="masthead">
                <h1><span className="word w1">Notes</span></h1>
                <p className="lede">
                    Upload an image. Every distinct color becomes a note — its hue determines the pitch, its brightness the volume, its saturation the purity. All notes play simultaneously as a chord you can transpose with the piano below.
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

                {isProcessing && (
                    <div className="processing-indicator">
                        <div className="spinner" aria-hidden="true"></div>
                        <span>Converting image to sound&hellip;</span>
                    </div>
                )}

                {!isProcessing && buckets.length > 0 && (
                    <div className="processing-indicator success">
                        <span className="check" aria-hidden="true">&#10003;</span>
                        <span>Image converted &mdash; {buckets.length} colors detected</span>
                    </div>
                )}

                {buckets.length > 0 && !isProcessing && (
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
                    <div className="chord-header">
                        <div className="chord-header-text">
                            <h2 className="panel-title">
                                <span className="num">02</span> play the chord
                            </h2>
                            <p>Press a piano key to play the chord at that pitch.</p>
                        </div>
                        <canvas
                            ref={lissajousCanvasRef}
                            className="lissajous"
                            width={140}
                            height={140}
                        />
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

                    <div className="control" style={{ marginTop: '1.25rem' }}>
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
                </section>
            )}
        </>
    )
}