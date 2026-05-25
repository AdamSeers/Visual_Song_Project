import { useEffect, useRef, useState } from 'react'
import { type ColorBucket, rgbToBaseFreq, bucketWeight, startChord } from '../audio/colorChord'

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

interface NoteGraphProps {
    buckets: ColorBucket[]
    maxBuckets: number
    octaveOffset: number
}

function NoteGraph({ buckets, maxBuckets, octaveOffset }: NoteGraphProps) {
    if (buckets.length === 0) return null

    // Get the top N buckets that will actually sound
    const top = [...buckets]
        .sort((a, b) => bucketWeight(b) - bucketWeight(a))
        .slice(0, maxBuckets)

    // Compute frequencies (with octave transposition applied so the graph
    // matches what the user hears when pressing the "A" key at semitone 0)
    const transposeFactor = Math.pow(2, octaveOffset)
    const notes = top.map(b => ({
        bucket: b,
        freq: rgbToBaseFreq(b.r, b.g, b.b) * transposeFactor,
        weight: bucketWeight(b),
    }))

    if (notes.length === 0) return null

    const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

    // Determine frequency range (log scale, since pitch is perceived
    // logarithmically — an octave is a doubling of frequency)
    const minFreq = Math.min(...notes.map(n => n.freq))
    const maxFreq = Math.max(...notes.map(n => n.freq))
    const maxWeight = Math.max(...notes.map(n => n.weight))

    // SVG dimensions
    const W = 600, H = 160
    const PAD_LEFT = 30, PAD_RIGHT = 10, PAD_TOP = 10, PAD_BOTTOM = 30
    const plotW = W - PAD_LEFT - PAD_RIGHT
    const plotH = H - PAD_TOP - PAD_BOTTOM

    // Position a frequency on the X axis (log scale, with a small margin
    // so the leftmost and rightmost bars don't touch the edges)
    const logMin = Math.log2(minFreq * 0.95)
    const logMax = Math.log2(maxFreq * 1.05)
    const freqToX = (f: number) => PAD_LEFT + ((Math.log2(f) - logMin) / (logMax - logMin)) * plotW

    // Find octave gridlines within the visible range (powers of 2)
    const gridlines: number[] = []
    let g = Math.pow(2, Math.ceil(logMin))
    while (g < Math.pow(2, logMax)) {
        gridlines.push(g)
        g *= 2
    }

    const BAR_WIDTH = 4

    function freqToNoteName(freq: number): string {
        // A4 = 440 Hz is our reference; convert to semitones away from A4
        const semitonesFromA4 = 12 * Math.log2(freq / 440)
        const rounded = Math.round(semitonesFromA4)
        const cents = Math.round((semitonesFromA4 - rounded) * 100)
        const names = ['A', 'A♯', 'B', 'C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯']
        const noteIdx = ((rounded % 12) + 12) % 12
        const octave = 4 + Math.floor((rounded + 9) / 12)   // A4 is reference; offset for C-based octaves
        const centsStr = cents === 0 ? '' : (cents > 0 ? ` +${cents}¢` : ` ${cents}¢`)
        return `${names[noteIdx]}${octave}${centsStr}`
    }

    const hovered = hoveredIdx !== null ? notes[hoveredIdx] : null

    return (
        <div className="note-graph">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
                {/* Octave gridlines */}
                {gridlines.map(freq => (
                    <line
                        key={freq}
                        x1={freqToX(freq)} x2={freqToX(freq)}
                        y1={PAD_TOP} y2={H - PAD_BOTTOM}
                        stroke="var(--rule)"
                        strokeDasharray="2,3"
                    />
                ))}

                {/* Bars — one per note */}
                {notes.map((note, i) => {
                    const x = freqToX(note.freq)
                    const heightPx = (note.weight / maxWeight) * plotH
                    const y = H - PAD_BOTTOM - heightPx
                    const { r, g, b } = note.bucket
                    // Widen the hover hitbox so the bar isn't impossible to hit
                    const HIT_PAD = 4
                    return (
                        <g key={i}>
                            <rect
                                x={x - BAR_WIDTH / 2}
                                y={y}
                                width={BAR_WIDTH}
                                height={heightPx}
                                fill={`rgb(${r}, ${g}, ${b})`}
                                opacity={hoveredIdx === i ? 1 : 0.85}
                            />
                            {/* Invisible wider rect to catch hover */}
                            <rect
                                x={x - BAR_WIDTH / 2 - HIT_PAD}
                                y={PAD_TOP}
                                width={BAR_WIDTH + HIT_PAD * 2}
                                height={plotH}
                                fill="transparent"
                                onMouseEnter={() => setHoveredIdx(i)}
                                onMouseLeave={() => setHoveredIdx(null)}
                                style={{ cursor: 'pointer' }}
                            />
                        </g>
                    )
                })}

                {/* X-axis baseline */}
                <line
                    x1={PAD_LEFT} x2={W - PAD_RIGHT}
                    y1={H - PAD_BOTTOM} y2={H - PAD_BOTTOM}
                    stroke="var(--rule)"
                />

                {/* Frequency labels on gridlines */}
                {gridlines.map(freq => (
                    <text
                        key={freq}
                        x={freqToX(freq)}
                        y={H - PAD_BOTTOM + 16}
                        fill="var(--ink-faint)"
                        fontSize="10"
                        textAnchor="middle"
                        fontFamily="JetBrains Mono, monospace"
                    >
                        {freq < 1000 ? `${Math.round(freq)}Hz` : `${(freq / 1000).toFixed(1)}kHz`}
                    </text>
                ))}

                {/* Y-axis label */}
                <text
                    x={PAD_LEFT - 8} y={PAD_TOP + plotH / 2}
                    fill="var(--ink-faint)"
                    fontSize="10"
                    textAnchor="end"
                    fontFamily="JetBrains Mono, monospace"
                    transform={`rotate(-90, ${PAD_LEFT - 8}, ${PAD_TOP + plotH / 2})`}
                >
                    weight
                </text>
            </svg>
            {hovered && (
                <div
                    className="note-tooltip"
                    style={{
                        left: `${(freqToX(hovered.freq) / W) * 100}%`,
                    }}
                >
                    <div className="note-tooltip-swatch" style={{ background: `rgb(${hovered.bucket.r}, ${hovered.bucket.g}, ${hovered.bucket.b})` }} />
                    <div className="note-tooltip-text">
                        <div className="note-tooltip-pitch">{freqToNoteName(hovered.freq)}</div>
                        <div className="note-tooltip-detail">
                            {Math.round(hovered.freq)} Hz · rgb({hovered.bucket.r}, {hovered.bucket.g}, {hovered.bucket.b})
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

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
            .sort((a, b) => bucketWeight(b) - bucketWeight(a))
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
                <h1><span className="word w1">Image to sound</span></h1>
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
                    <h2 className="panel-title">notes detected</h2>
                    <p style={{ color: 'var(--ink-dim)', fontSize: '0.9rem', marginBottom: '1rem' }}>
                        Each bar is a note in the chord. Position = pitch, height = volume, color = source color from your image.
                    </p>
                    <NoteGraph
                        buckets={buckets}
                        maxBuckets={maxBuckets}
                        octaveOffset={octaveOffset}
                    />
                </section>
            )}

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