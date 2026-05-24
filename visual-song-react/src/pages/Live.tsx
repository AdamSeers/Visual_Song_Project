import { useEffect, useRef, useState } from 'react'

// ===== Color algorithm (Bruton wavelength->RGB, frequency-doubled) =====
function freqToVisibleThz(freqHz: number) {
    let f = freqHz
    while (f < 4e14) f *= 2
    while (f >= 8e14) f /= 2
    return f
}
function thzToWavelengthNm(thz: number) {
    return 299792458.0 / thz * 1e9
}
function wavelengthToRgb(wl: number): [number, number, number] {
    let r = 0, g = 0, b = 0
    if (wl >= 380 && wl < 440) { r = -(wl - 440) / 60; b = 1 }
    else if (wl < 490) { g = (wl - 440) / 50; b = 1 }
    else if (wl < 510) { g = 1; b = -(wl - 510) / 20 }
    else if (wl < 580) { r = (wl - 510) / 70; g = 1 }
    else if (wl < 645) { r = 1; g = -(wl - 645) / 65 }
    else if (wl <= 780) { r = 1 }
    let factor = 1
    if (wl < 420) factor = 0.3 + 0.7 * (wl - 380) / 40
    else if (wl > 700) factor = 0.3 + 0.7 * (780 - wl) / 80
    return [
        Math.round(Math.pow(r * factor, 0.8) * 255),
        Math.round(Math.pow(g * factor, 0.8) * 255),
        Math.round(Math.pow(b * factor, 0.8) * 255),
    ]
}
function freqToRgb(hz: number) {
    return wavelengthToRgb(thzToWavelengthNm(freqToVisibleThz(hz)))
}

interface Note {
    id: number
    freq: number
    amp: number
    framesObserved: number
    framesMissing: number
    fadeIn: number
    fadeOut: number
    slot: number
}

interface Peak { freq: number; amp: number }

const MAX_SLOTS = 8
const MIN_OBSERVED = 5
const FADE_IN_FRAMES = 5
const FADE_OUT_FRAMES = 12
const MATCH_TOL_CENTS = 80
const FREQ_SMOOTH = 0.18
const AMP_SMOOTH = 0.5
const FFT_SIZE = 4096

function centsDist(a: number, b: number) {
    if (a <= 0 || b <= 0) return Infinity
    return 1200 * Math.abs(Math.log2(a / b))
}

export default function Live() {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [running, setRunning] = useState(false)
    const [micStatus, setMicStatus] = useState('mic off')
    const [sensitivity, setSensitivity] = useState(0.2)

    // Refs to mutable state used inside the animation loop.
    const sensitivityRef = useRef(sensitivity)
    useEffect(() => { sensitivityRef.current = sensitivity }, [sensitivity])

    const runningRef = useRef(running)
    useEffect(() => { runningRef.current = running }, [running])

    // Refs for the audio context, so we can clean them up cleanly.
    const audioCtxRef = useRef<AudioContext | null>(null)
    const analyserRef = useRef<AnalyserNode | null>(null)
    const micStreamRef = useRef<MediaStream | null>(null)
    const notesRef = useRef<Note[]>([])
    const nextNoteIdRef = useRef(1)

    function findPeaks(magData: Uint8Array, sampleRate: number, fftSize: number): Peak[] {
        const peaks: Peak[] = []
        const binHz = sampleRate / fftSize
        const minBin = Math.max(2, Math.floor(60 / binHz))
        const maxBin = Math.min(magData.length - 2, Math.ceil(4000 / binHz))
        let maxVal = 0
        for (let i = minBin; i < maxBin; i++) if (magData[i] > maxVal) maxVal = magData[i]
        const sens = sensitivityRef.current
        const relativeRatio = 1.0 - sens
        const absoluteFloor = 60 + (1.0 - sens) * 100
        const threshold = Math.max(absoluteFloor, maxVal * relativeRatio)
        for (let i = minBin; i < maxBin; i++) {
            if (magData[i] > threshold && magData[i] > magData[i - 1] && magData[i] > magData[i + 1]) {
                const a = magData[i - 1], b = magData[i], c = magData[i + 1]
                const denom = a - 2 * b + c
                const offset = denom !== 0 ? 0.5 * (a - c) / denom : 0
                const freq = (i + offset) * binHz
                const amp = Math.min(1, b / 255)
                peaks.push({ freq, amp })
            }
        }
        peaks.sort((a, b) => a.freq - b.freq)
        const kept: Peak[] = []
        for (const p of peaks) {
            let isHarmonic = false
            for (const lower of kept) {
                const ratio = p.freq / lower.freq
                const n = Math.round(ratio)
                if (n >= 2 && n <= 10) {
                    const centsErr = 1200 * Math.abs(Math.log2(ratio / n))
                    if (centsErr < 35 && lower.amp >= p.amp * 0.25) { isHarmonic = true; break }
                }
            }
            if (!isHarmonic) kept.push(p)
        }
        return kept.slice(0, 8)
    }

    function updateTracker(peaks: Peak[]) {
        const remaining: (Peak | null)[] = peaks.slice()
        const notes = notesRef.current
        for (const note of notes) {
            if (note.fadeOut >= 1) continue
            let bestIdx = -1, bestDist = MATCH_TOL_CENTS
            for (let i = 0; i < remaining.length; i++) {
                if (!remaining[i]) continue
                const d = centsDist(note.freq, remaining[i]!.freq)
                if (d < bestDist) { bestDist = d; bestIdx = i }
            }
            if (bestIdx >= 0) {
                const obs = remaining[bestIdx]!
                note.freq = Math.exp((1 - FREQ_SMOOTH) * Math.log(note.freq) + FREQ_SMOOTH * Math.log(obs.freq))
                note.amp = (1 - AMP_SMOOTH) * note.amp + AMP_SMOOTH * obs.amp
                note.framesObserved++
                note.framesMissing = 0
                note.fadeOut = Math.max(0, note.fadeOut - 0.2)
                remaining[bestIdx] = null
            }
        }
        for (const obs of remaining) {
            if (!obs) continue
            notes.push({
                id: nextNoteIdRef.current++,
                freq: obs.freq, amp: obs.amp,
                framesObserved: 1, framesMissing: 0,
                fadeIn: 0, fadeOut: 0, slot: -1,
            })
        }
        for (const n of notes) {
            const wasUpdated = !!peaks.find(p => centsDist(n.freq, p.freq) < MATCH_TOL_CENTS)
            if (!wasUpdated) {
                n.framesMissing++
                n.fadeOut = Math.min(1, n.framesMissing / FADE_OUT_FRAMES)
            } else {
                n.fadeIn = Math.min(1, n.fadeIn + 1 / FADE_IN_FRAMES)
            }
        }
        for (let i = notes.length - 1; i >= 0; i--) {
            if (notes[i].fadeOut >= 1) notes.splice(i, 1)
        }
        const occupied = new Set(notes.filter(n => n.slot >= 0).map(n => n.slot))
        for (const n of notes) {
            if (n.slot >= 0) continue
            for (let s = 0; s < MAX_SLOTS; s++) {
                if (!occupied.has(s)) { n.slot = s; occupied.add(s); break }
            }
        }
    }

    function renderFrame(ctx: CanvasRenderingContext2D, W: number, H: number) {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, W, H)
        const cols = 4, rows = 2
        const cell = Math.min(W / cols, H / rows)
        const xOff = (W - cols * cell) / 2, yOff = (H - rows * cell) / 2
        for (const n of notesRef.current) {
            if (n.framesObserved < MIN_OBSERVED) continue
            if (n.slot < 0 || n.slot >= MAX_SLOTS) continue
            const col = n.slot % cols, row = Math.floor(n.slot / cols)
            const cx = xOff + (col + 0.5) * cell
            const cy = yOff + (row + 0.5) * cell
            const [r, g, b] = freqToRgb(n.freq)
            const fadeAlpha = (1 - n.fadeOut) * n.fadeIn
            const amp = 0.15 + 0.85 * Math.min(1, n.amp)
            const gain = amp * fadeAlpha
            ctx.fillStyle = `rgb(${Math.round(r * gain)}, ${Math.round(g * gain)}, ${Math.round(b * gain)})`
            const size = cell * 0.42 * (0.4 + 0.6 * n.fadeIn)
            const radius = size * 0.4
            ctx.beginPath()
            ctx.moveTo(cx - size + radius, cy - size)
            ctx.lineTo(cx + size - radius, cy - size)
            ctx.quadraticCurveTo(cx + size, cy - size, cx + size, cy - size + radius)
            ctx.lineTo(cx + size, cy + size - radius)
            ctx.quadraticCurveTo(cx + size, cy + size, cx + size - radius, cy + size)
            ctx.lineTo(cx - size + radius, cy + size)
            ctx.quadraticCurveTo(cx - size, cy + size, cx - size, cy + size - radius)
            ctx.lineTo(cx - size, cy - size + radius)
            ctx.quadraticCurveTo(cx - size, cy - size, cx - size + radius, cy - size)
            ctx.fill()
        }
    }

    // Initial black canvas paint
    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
    }, [])

    async function startMic() {
        console.log('[live] startMic called')
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            })
            micStreamRef.current = stream
            const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
            audioCtxRef.current = audioCtx
            const source = audioCtx.createMediaStreamSource(stream)
            const analyser = audioCtx.createAnalyser()
            analyser.fftSize = FFT_SIZE
            analyser.smoothingTimeConstant = 0.3
            source.connect(analyser)
            analyserRef.current = analyser

            setRunning(true)
            setMicStatus('listening')
            runningRef.current = true
            console.log('[live] mic acquired, about to start loop')

            const magData = new Uint8Array(FFT_SIZE / 2)
            const canvas = canvasRef.current!
            const ctx = canvas.getContext('2d')!

            let frameCount = 0
            const loop = () => {
                if (!runningRef.current) return
                analyser.getByteFrequencyData(magData)
                const peaks = findPeaks(magData, audioCtx.sampleRate, FFT_SIZE)
                if (frameCount % 60 === 0) {
                    console.log('[live] frame', frameCount, 'peaks:', peaks.length, 'notes:', notesRef.current.length, 'maxMag:', Math.max(...magData))
                }
                frameCount++
                updateTracker(peaks)
                renderFrame(ctx, canvas.width, canvas.height)
                requestAnimationFrame(loop)
            }
            loop()
        } catch (e) {
            console.error(e)
            setMicStatus('mic permission denied')
        }
    }

    function stopMic() {
        setRunning(false)
        runningRef.current = false
        if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop())
        if (audioCtxRef.current) audioCtxRef.current.close()
        audioCtxRef.current = null
        analyserRef.current = null
        micStreamRef.current = null
        notesRef.current = []
        setMicStatus('mic off')
        const canvas = canvasRef.current
        if (canvas) {
            const ctx = canvas.getContext('2d')
            if (ctx) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height) }
        }
    }

    // Cleanup on unmount (e.g. user navigates away)
    useEffect(() => {
        return () => {
            if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop())
            if (audioCtxRef.current) audioCtxRef.current.close()
        }
    }, [])

    return (
        <>
            <header className="masthead">
                <h1><span className="word w1">Live colors</span></h1>
                <p className="lede">
                    Sing, play an instrument, or hum into your microphone. The visualization runs
                    entirely in your browser &mdash; no audio leaves your device.
                </p>
                <p className="warning" role="note">
                    <strong>Photosensitivity warning:</strong> contains rapidly changing colors.
                    If you have photosensitive epilepsy, avoid or proceed with caution.
                </p>
            </header>

            <section className="panel">
                <h2 className="panel-title">Live visualization</h2>
                <canvas id="live-canvas" width={854} height={480} ref={canvasRef}></canvas>
                <div className="live-controls">
                    <button type="button" className="btn" onClick={running ? stopMic : startMic}>
                        <span>{running ? 'stop microphone' : 'start microphone'}</span>
                        <span className="btn-arrow" aria-hidden="true">&rarr;</span>
                    </button>
                    <span className="mic-status">{micStatus}</span>
                </div>

                <div className="control" style={{ marginTop: '1.25rem' }}>
                    <label htmlFor="sensitivity">
                        <span className="control-name">Sensitivity</span>
                        <span className="control-desc">
                            How loud a sound needs to be to register. Lower = only loud sounds, higher = catches quieter ones.
                        </span>
                    </label>
                    <div className="control-row">
                        <input
                            type="range"
                            id="sensitivity"
                            min={0.1}
                            max={0.9}
                            step={0.01}
                            value={sensitivity}
                            onChange={(e) => setSensitivity(parseFloat(e.target.value))}
                        />
                        <output>{sensitivity.toFixed(2)}</output>
                    </div>
                </div>
            </section>
        </>
    )
}