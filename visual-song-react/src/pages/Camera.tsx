import { useEffect, useRef, useState } from 'react'
import { bucketWeight, rgbToBaseFreq, getNoiseBuffer } from '../audio/colorChord'

// ── Constants ─────────────────────────────────────────────────────────────
const POOL_SIZE = 16
const BUCKET_STEP = 30

// ── Types ─────────────────────────────────────────────────────────────────
interface Voice {
    osc: OscillatorNode
    gain: GainNode
    noiseSrc: AudioBufferSourceNode
    bandpass: BiquadFilterNode
    noiseGain: GainNode
    targetFreq: number
}

interface DetectedBucket {
    r: number; g: number; b: number
    count: number
    saturation: number
    brightness: number
    whiteness: number
    weight: number
    freq: number
    hex: string
}

// ── Helpers ────────────────────────────────────────────────────────────────
function applySaturation(
    r: number, g: number, b: number, sat: number
): [number, number, number] {
    const s = sat / 100
    const grey = 0.299 * r + 0.587 * g + 0.114 * b
    return [
        Math.min(255, Math.max(0, Math.round(grey + (r - grey) * s))),
        Math.min(255, Math.max(0, Math.round(grey + (g - grey) * s))),
        Math.min(255, Math.max(0, Math.round(grey + (b - grey) * s))),
    ]
}

function extractBuckets(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    saturation: number,
): DetectedBucket[] {
    if (video.readyState < 2 || video.videoWidth === 0) return []
    const ctx = canvas.getContext('2d')
    if (!ctx) return []

    const maxEdge = 150
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight))
    const w = Math.floor(video.videoWidth * scale)
    const h = Math.floor(video.videoHeight * scale)
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
    }

    ctx.drawImage(video, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)

    const map = new Map<string, { r: number; g: number; b: number; count: number }>()
    for (let i = 0; i < data.length; i += 4) {
        const rawR = data[i], rawG = data[i + 1], rawB = data[i + 2], a = data[i + 3]
        if (a < 32) continue
        const [r, g, b] = applySaturation(rawR, rawG, rawB, saturation)
        const key = `${Math.floor(r / BUCKET_STEP)},${Math.floor(g / BUCKET_STEP)},${Math.floor(b / BUCKET_STEP)}`
        const ex = map.get(key)
        if (ex) ex.count++
        else map.set(key, { r, g, b, count: 1 })
    }

    return Array.from(map.values()).map(c => {
        const max = Math.max(c.r, c.g, c.b)
        const min = Math.min(c.r, c.g, c.b)
        const saturation = max === 0 ? 0 : (max - min) / max
        const brightness = max / 255
        const whiteness = min / 255
        const bucket = { ...c, saturation, brightness, whiteness }
        const weight = bucketWeight(bucket)
        const freq = rgbToBaseFreq(c.r, c.g, c.b)
        const cv = (v: number) => v.toString(16).padStart(2, '0')
        return { ...bucket, weight, freq, hex: `#${cv(c.r)}${cv(c.g)}${cv(c.b)}` }
    })
}

// ── Voice pool ─────────────────────────────────────────────────────────────
function createVoicePool(ctx: AudioContext, master: GainNode): Voice[] {
    return Array.from({ length: POOL_SIZE }, (_, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        const initFreq = 150 + i * 45
        osc.frequency.setValueAtTime(initFreq, ctx.currentTime)
        gain.gain.setValueAtTime(0, ctx.currentTime)
        osc.connect(gain)
        gain.connect(master)
        osc.start()

        // Persistent noise voice (band-pass filtered)
        const noiseSrc = ctx.createBufferSource()
        noiseSrc.buffer = getNoiseBuffer(ctx)
        noiseSrc.loop = true
        const bandpass = ctx.createBiquadFilter()
        bandpass.type = 'bandpass'
        bandpass.frequency.setValueAtTime(initFreq, ctx.currentTime)
        bandpass.Q.setValueAtTime(1, ctx.currentTime)
        const noiseGain = ctx.createGain()
        noiseGain.gain.setValueAtTime(0, ctx.currentTime)
        noiseSrc.connect(bandpass)
        bandpass.connect(noiseGain)
        noiseGain.connect(master)
        noiseSrc.start()

        return { osc, gain, noiseSrc, bandpass, noiseGain, targetFreq: initFreq }
    })
}

// ── Core update ────────────────────────────────────────────────────────────
function updateVoices(
    voices: Voice[],
    buckets: DetectedBucket[],
    maxColors: number,
    updateIntervalSec: number,
    ctx: AudioContext,
) {
    const top = [...buckets]
        .sort((a, b) => b.weight - a.weight)
        .slice(0, Math.min(maxColors, POOL_SIZE))

    const totalWeight = top.reduce((s, b) => s + b.weight, 0) || 1
    const now = ctx.currentTime
    const TC = Math.max(0.04, updateIntervalSec / 4)

    const sorted = [...top].sort((a, b) => a.freq - b.freq)
    const voiceUsed = new Array(voices.length).fill(false)

    for (const color of sorted) {
        let bestIdx = -1
        let bestDist = Infinity
        for (let i = 0; i < voices.length; i++) {
            if (voiceUsed[i]) continue
            const dist = Math.abs(Math.log2(color.freq / voices[i].targetFreq))
            if (dist < bestDist) { bestDist = dist; bestIdx = i }
        }
        if (bestIdx < 0) break

        const voice = voices[bestIdx]
        const amp = (color.weight / totalWeight) * 0.8

        // Saturation decides tone-vs-noise: grey (low saturation) = noise at
        // any brightness; vivid color (high saturation) = clean tone.
        const sat = color.saturation
        const purity = sat
        const noiseLevel = 1 - sat

        // Tonal sine — loud only when saturated
        const curFreq = voice.osc.frequency.value
        const curGain = voice.gain.gain.value
        voice.osc.frequency.cancelScheduledValues(now)
        voice.gain.gain.cancelScheduledValues(now)
        voice.osc.frequency.setValueAtTime(curFreq, now)
        voice.gain.gain.setValueAtTime(curGain, now)
        voice.osc.frequency.setTargetAtTime(color.freq, now, TC)
        voice.gain.gain.setTargetAtTime(amp * purity, now, TC)

        // Noise band — loud when desaturated (grey/white)
        const noiseAmp = amp * noiseLevel * 0.3
        const curBp = voice.bandpass.frequency.value
        const curNg = voice.noiseGain.gain.value
        voice.bandpass.frequency.cancelScheduledValues(now)
        voice.noiseGain.gain.cancelScheduledValues(now)
        voice.bandpass.frequency.setValueAtTime(curBp, now)
        voice.noiseGain.gain.setValueAtTime(curNg, now)

        // Pure noise sits in a comfortable mid band; saturated colors track pitch
        const NOISE_CENTER = 700
        const rawCenter = color.freq * sat + NOISE_CENTER * (1 - sat)
        const bpCenter = Math.min(2000, Math.max(300, rawCenter))
        const bpQ = Math.max(0.4, 0.4 + sat)
        voice.bandpass.frequency.setTargetAtTime(bpCenter, now, TC)
        voice.bandpass.Q.setTargetAtTime(bpQ, now, TC)

        voice.noiseGain.gain.setTargetAtTime(noiseAmp, now, TC)

        voice.targetFreq = color.freq
        voiceUsed[bestIdx] = true
    }

    // Fade out unused voices
    for (let i = 0; i < voices.length; i++) {
        if (!voiceUsed[i]) {
            const v = voices[i]
            const cg = v.gain.gain.value
            const cng = v.noiseGain.gain.value
            v.gain.gain.cancelScheduledValues(now)
            v.gain.gain.setValueAtTime(cg, now)
            v.gain.gain.setTargetAtTime(0, now, TC)
            v.noiseGain.gain.cancelScheduledValues(now)
            v.noiseGain.gain.setValueAtTime(cng, now)
            v.noiseGain.gain.setTargetAtTime(0, now, TC)
        }
    }
}

// ── Component ──────────────────────────────────────────────────────────────
export default function Camera() {
    const videoRef = useRef<HTMLVideoElement>(null)
    const offscreenCanvas = useRef(document.createElement('canvas'))

    const [running, setRunning] = useState(false)
    const [statusText, setStatusText] = useState('camera off')
    const [currentColors, setCurrentColors] = useState<DetectedBucket[]>([])
    const [maxColors, setMaxColors] = useState(8)
    const [updateMs, setUpdateMs] = useState(500)
    const [saturation, setSaturation] = useState(100)

    const runningRef = useRef(false)
    const maxColorsRef = useRef(maxColors)
    const updateMsRef = useRef(updateMs)
    const saturationRef = useRef(saturation)
    useEffect(() => { maxColorsRef.current = maxColors }, [maxColors])
    useEffect(() => { updateMsRef.current = updateMs }, [updateMs])
    useEffect(() => { saturationRef.current = saturation }, [saturation])

    const audioCtxRef = useRef<AudioContext | null>(null)
    const masterGainRef = useRef<GainNode | null>(null)
    const voicePoolRef = useRef<Voice[]>([])
    const streamRef = useRef<MediaStream | null>(null)
    const intervalRef = useRef<number | null>(null)

    function ensureAudio() {
        if (!audioCtxRef.current) {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
            const master = ctx.createGain()
            master.gain.setValueAtTime(0.9, ctx.currentTime)
            master.connect(ctx.destination)
            voicePoolRef.current = createVoicePool(ctx, master)
            audioCtxRef.current = ctx
            masterGainRef.current = master
        }
        if (audioCtxRef.current.state === 'suspended') {
            audioCtxRef.current.resume()
        }
        return audioCtxRef.current
    }

    function tick() {
        if (!runningRef.current || !videoRef.current) return
        const ctx = ensureAudio()
        const buckets = extractBuckets(
            videoRef.current,
            offscreenCanvas.current,
            saturationRef.current,
        )
        updateVoices(
            voicePoolRef.current,
            buckets,
            maxColorsRef.current,
            updateMsRef.current / 1000,
            ctx,
        )
        setCurrentColors(
            [...buckets].sort((a, b) => b.weight - a.weight).slice(0, maxColorsRef.current)
        )
    }

    async function startCamera() {
        try {
            let stream: MediaStream
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
                })
            } catch {
                stream = await navigator.mediaDevices.getUserMedia({ video: true })
            }
            streamRef.current = stream
            if (videoRef.current) {
                videoRef.current.srcObject = stream
                await videoRef.current.play()
            }
            ensureAudio()
            runningRef.current = true
            setRunning(true)
            setStatusText('analyzing')
        } catch (e) {
            console.error(e)
            setStatusText('camera permission denied')
        }
    }

    function stopCamera() {
        runningRef.current = false
        setRunning(false)
        setStatusText('camera off')
        setCurrentColors([])

        if (intervalRef.current !== null) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }

        if (audioCtxRef.current && voicePoolRef.current.length > 0) {
            const now = audioCtxRef.current.currentTime
            for (const voice of voicePoolRef.current) {
                const cg = voice.gain.gain.value
                const cng = voice.noiseGain.gain.value
                voice.gain.gain.cancelScheduledValues(now)
                voice.gain.gain.setValueAtTime(cg, now)
                voice.gain.gain.setTargetAtTime(0, now, 0.2)
                voice.noiseGain.gain.cancelScheduledValues(now)
                voice.noiseGain.gain.setValueAtTime(cng, now)
                voice.noiseGain.gain.setTargetAtTime(0, now, 0.2)
            }
        }

        if (streamRef.current) {
            streamRef.current.getTracks().forEach(t => t.stop())
            streamRef.current = null
        }
        if (videoRef.current) videoRef.current.srcObject = null
    }

    useEffect(() => {
        if (!running) return
        tick()
        intervalRef.current = window.setInterval(tick, updateMs)
        return () => {
            if (intervalRef.current !== null) clearInterval(intervalRef.current)
        }
    }, [running, updateMs])

    useEffect(() => {
        return () => {
            stopCamera()
            if (audioCtxRef.current) {
                audioCtxRef.current.close()
                audioCtxRef.current = null
                voicePoolRef.current = []
            }
        }
    }, [])

    const totalCount = currentColors.reduce((s, c) => s + c.count, 0) || 1

    return (
        <>
            <header className="masthead">
                <h1><span className="word w1">Camera to sounds</span></h1>
                <p className="lede">
                    Point your camera at anything. The dominant colors become notes —
                    updated continuously as the scene changes. This runs entirely in your browser — nothing leaves your device.
                </p>
            </header>

            <section className="panel">
                <h2 className="panel-title">Live feed</h2>

                <video
                    ref={videoRef}
                    className="camera-feed"
                    playsInline
                    muted
                    style={{ filter: `saturate(${saturation}%)` }}
                />

                <div className="live-controls" style={{ marginTop: '1rem' }}>
                    <button
                        type="button"
                        className="btn"
                        onClick={running ? stopCamera : startCamera}
                    >
                        <span>{running ? 'stop camera' : 'start camera'}</span>
                        <span className="btn-arrow" aria-hidden="true">&rarr;</span>
                    </button>
                    <span className="mic-status">{statusText}</span>
                </div>

                <div className="control" style={{ marginTop: '1.5rem' }}>
                    <label htmlFor="cam_sat">
                        <span className="control-name">Saturation filter</span>
                        <span className="control-desc">
                            Affects both the visual feed and the audio. 0% = greyscale (flat
                            mid-range tones), 100% = natural, 200%+ = vivid oversaturated colors.
                        </span>
                    </label>
                    <div className="control-row">
                        <input
                            type="range"
                            id="cam_sat"
                            min={0}
                            max={300}
                            step={5}
                            value={saturation}
                            onChange={e => setSaturation(parseInt(e.target.value))}
                        />
                        <output>{saturation}%</output>
                    </div>
                </div>
            </section>

            {running && (
                <section className="panel">
                    <h2 className="panel-title">detected colors</h2>

                    <div className="camera-swatches">
                        {currentColors.length === 0 ? (
                            <span className="camera-no-colors">Sampling…</span>
                        ) : currentColors.map((color, i) => (
                            <div
                                key={i}
                                className="camera-swatch"
                                style={{
                                    background: color.hex,
                                    opacity: 0.3 + 0.7 * (color.weight / (currentColors[0]?.weight || 1)),
                                }}
                                title={`${color.hex} · ${Math.round(color.count / totalCount * 100)}%`}
                            />
                        ))}
                    </div>

                    <div className="control" style={{ marginTop: '1.5rem' }}>
                        <label htmlFor="cam_colors">
                            <span className="control-name">Simultaneous notes</span>
                            <span className="control-desc">
                                How many colors play at once. More = richer texture, fewer = cleaner chord.
                            </span>
                        </label>
                        <div className="control-row">
                            <input
                                type="range"
                                id="cam_colors"
                                min={1}
                                max={16}
                                step={1}
                                value={maxColors}
                                onChange={e => setMaxColors(parseInt(e.target.value))}
                            />
                            <output>{maxColors}</output>
                        </div>
                    </div>

                    <div className="control">
                        <label htmlFor="cam_interval">
                            <span className="control-name">Update speed</span>
                            <span className="control-desc">
                                How often colors are re-sampled and tones shift.
                                Lower = snappy and reactive, higher = slow and meditative.
                            </span>
                        </label>
                        <div className="control-row">
                            <input
                                type="range"
                                id="cam_interval"
                                min={100}
                                max={3000}
                                step={100}
                                value={updateMs}
                                onChange={e => setUpdateMs(parseInt(e.target.value))}
                            />
                            <output>{(updateMs / 1000).toFixed(1)}s</output>
                        </div>
                    </div>
                </section>
            )}
        </>
    )
}