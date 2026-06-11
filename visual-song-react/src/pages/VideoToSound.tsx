import { useEffect, useRef, useState } from 'react'
import { bucketWeight, rgbToBaseFreq } from '../audio/colorChord'

const POOL_SIZE = 16
const BUCKET_STEP = 30

interface DetectedBucket {
    r: number; g: number; b: number
    count: number; saturation: number; brightness: number; whiteness: number
    weight: number; freq: number
}
interface TimelineFrame { time: number; buckets: DetectedBucket[] }

interface OfflineVoice {
    osc: OscillatorNode; gain: GainNode
    harmOsc: OscillatorNode; harmGain: GainNode
    targetFreq: number
    lastFreq: number; lastGain: number
    lastHarmFreq: number; lastHarmGain: number
}

function applySaturation(r: number, g: number, b: number, sat: number): [number, number, number] {
    const s = sat / 100
    const grey = 0.299 * r + 0.587 * g + 0.114 * b
    return [
        Math.min(255, Math.max(0, Math.round(grey + (r - grey) * s))),
        Math.min(255, Math.max(0, Math.round(grey + (g - grey) * s))),
        Math.min(255, Math.max(0, Math.round(grey + (b - grey) * s))),
    ]
}

function extractBucketsFromFrame(
    video: HTMLVideoElement, canvas: HTMLCanvasElement, saturation: number,
): DetectedBucket[] {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx || video.videoWidth === 0 || video.readyState < 2) return []
    const maxEdge = 150
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight))
    const w = Math.floor(video.videoWidth * scale)
    const h = Math.floor(video.videoHeight * scale)
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
    ctx.drawImage(video, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)
    const map = new Map<string, { r: number; g: number; b: number; count: number }>()
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 32) continue
        const [r, g, b] = applySaturation(data[i], data[i + 1], data[i + 2], saturation)
        const key = `${Math.floor(r / BUCKET_STEP)},${Math.floor(g / BUCKET_STEP)},${Math.floor(b / BUCKET_STEP)}`
        const ex = map.get(key)
        if (ex) ex.count++
        else map.set(key, { r, g, b, count: 1 })
    }
    return Array.from(map.values()).map(c => {
        const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b)
        const saturation = max === 0 ? 0 : (max - min) / max
        const brightness = max / 255, whiteness = min / 255
        const bucket = { ...c, saturation, brightness, whiteness }
        return { ...bucket, weight: bucketWeight(bucket), freq: rgbToBaseFreq(c.r, c.g, c.b) }
    })
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
    return new Promise(resolve => {
        const fn = () => { video.removeEventListener('seeked', fn); resolve() }
        video.addEventListener('seeked', fn)
        video.currentTime = Math.min(t, video.duration || t)
    })
}

function createOfflineVoicePool(ctx: OfflineAudioContext, master: GainNode): OfflineVoice[] {
    return Array.from({ length: POOL_SIZE }, (_, i) => {
        const osc = ctx.createOscillator(), gain = ctx.createGain()
        const harmOsc = ctx.createOscillator(), harmGain = ctx.createGain()
        osc.type = 'sine'; harmOsc.type = 'sine'
        const f = 150 + i * 45
        osc.frequency.setValueAtTime(f, 0); harmOsc.frequency.setValueAtTime(f * 2, 0)
        gain.gain.setValueAtTime(0, 0); harmGain.gain.setValueAtTime(0, 0)
        osc.connect(gain); gain.connect(master)
        harmOsc.connect(harmGain); harmGain.connect(master)
        osc.start(0); harmOsc.start(0)
        return {
            osc, gain, harmOsc, harmGain, targetFreq: f,
            lastFreq: f, lastGain: 0, lastHarmFreq: f * 2, lastHarmGain: 0
        }
    })
}

function scheduleVoiceUpdate(
    voices: OfflineVoice[], buckets: DetectedBucket[],
    maxColors: number, intervalSec: number, atTime: number,
) {
    const top = [...buckets].sort((a, b) => b.weight - a.weight).slice(0, Math.min(maxColors, POOL_SIZE))
    const totalWeight = top.reduce((s, b) => s + b.weight, 0) || 1
    const TC = Math.max(0.04, intervalSec / 4)
    const sorted = [...top].sort((a, b) => a.freq - b.freq)
    const used = new Array(voices.length).fill(false)

    for (const color of sorted) {
        let bestIdx = -1, bestDist = Infinity
        for (let i = 0; i < voices.length; i++) {
            if (used[i]) continue
            const d = Math.abs(Math.log2(color.freq / voices[i].targetFreq))
            if (d < bestDist) { bestDist = d; bestIdx = i }
        }
        if (bestIdx < 0) break
        const v = voices[bestIdx]
        const amp = (color.weight / totalWeight) * 0.8
        const harmAmp = amp * Math.max(0, color.whiteness - 0.1) * 0.5
        v.osc.frequency.setValueAtTime(v.lastFreq, atTime)
        v.gain.gain.setValueAtTime(v.lastGain, atTime)
        v.osc.frequency.setTargetAtTime(color.freq, atTime, TC)
        v.gain.gain.setTargetAtTime(amp, atTime, TC)
        v.harmOsc.frequency.setValueAtTime(v.lastHarmFreq, atTime)
        v.harmGain.gain.setValueAtTime(v.lastHarmGain, atTime)
        v.harmOsc.frequency.setTargetAtTime(color.freq * 2, atTime, TC)
        v.harmGain.gain.setTargetAtTime(harmAmp, atTime, TC)
        v.lastFreq = color.freq; v.lastGain = amp
        v.lastHarmFreq = color.freq * 2; v.lastHarmGain = harmAmp
        v.targetFreq = color.freq; used[bestIdx] = true
    }
    for (let i = 0; i < voices.length; i++) {
        if (!used[i]) {
            const v = voices[i]
            v.gain.gain.setValueAtTime(v.lastGain, atTime)
            v.gain.gain.setTargetAtTime(0, atTime, TC)
            v.harmGain.gain.setValueAtTime(v.lastHarmGain, atTime)
            v.harmGain.gain.setTargetAtTime(0, atTime, TC)
            v.lastGain = 0; v.lastHarmGain = 0
        }
    }
}

async function renderAudioTimeline(
    timeline: TimelineFrame[], duration: number,
    maxColors: number, intervalSec: number,
): Promise<AudioBuffer> {
    const sampleRate = 44100
    const offline = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate)
    const master = offline.createGain()
    master.gain.setValueAtTime(0.9, 0)
    master.connect(offline.destination)
    const voices = createOfflineVoicePool(offline, master)
    for (const frame of timeline) {
        scheduleVoiceUpdate(voices, frame.buckets, maxColors, intervalSec, frame.time)
    }
    const end = Math.max(0.2, duration)
    for (const v of voices) {
        v.gain.gain.setValueAtTime(v.lastGain, Math.max(0, end - 0.1))
        v.gain.gain.linearRampToValueAtTime(0, end)
        v.harmGain.gain.setValueAtTime(v.lastHarmGain, Math.max(0, end - 0.1))
        v.harmGain.gain.linearRampToValueAtTime(0, end)
        v.osc.stop(end); v.harmOsc.stop(end)
    }
    return await offline.startRendering()
}

// ── AudioBuffer → 16-bit PCM WAV Blob ─────────────────────────
function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
    const numCh = buffer.numberOfChannels
    const sr = buffer.sampleRate
    const frames = buffer.length
    const bps = 2
    const blockAlign = numCh * bps
    const dataSize = frames * blockAlign
    const ab = new ArrayBuffer(44 + dataSize)
    const v = new DataView(ab)
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    str(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); str(8, 'WAVE')
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
    v.setUint16(22, numCh, true); v.setUint32(24, sr, true)
    v.setUint32(28, sr * blockAlign, true); v.setUint16(32, blockAlign, true)
    v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, dataSize, true)
    const channels = Array.from({ length: numCh }, (_, c) => buffer.getChannelData(c))
    let off = 44
    for (let i = 0; i < frames; i++) {
        for (let c = 0; c < numCh; c++) {
            const s = Math.max(-1, Math.min(1, channels[c][i]))
            v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
            off += 2
        }
    }
    return new Blob([ab], { type: 'audio/wav' })
}

// ── Component ──────────────────────────────────────────────────
type Phase = 'idle' | 'extracting' | 'rendering' | 'uploading' | 'done' | 'error'

export default function VideoToSound() {
    const videoRef = useRef<HTMLVideoElement>(null)
    const analysisCanvas = useRef(document.createElement('canvas'))

    const [file, setFile] = useState<File | null>(null)
    const [videoUrl, setVideoUrl] = useState<string | null>(null)
    const [outputUrl, setOutputUrl] = useState<string | null>(null)
    const [phase, setPhase] = useState<Phase>('idle')
    const [progress, setProgress] = useState(0)
    const [errorMsg, setErrorMsg] = useState('')
    const [dragOver, setDragOver] = useState(false)

    const [maxColors, setMaxColors] = useState(8)
    const [saturation, setSaturation] = useState(100)
    const [updateMs, setUpdateMs] = useState(400)

    useEffect(() => {
        return () => {
            if (videoUrl) URL.revokeObjectURL(videoUrl)
            if (outputUrl) URL.revokeObjectURL(outputUrl)
        }
    }, [videoUrl, outputUrl])

    function handleFile(f: File) {
        if (!f.type.startsWith('video/')) return
        if (videoUrl) URL.revokeObjectURL(videoUrl)
        if (outputUrl) { URL.revokeObjectURL(outputUrl); setOutputUrl(null) }
        setFile(f)
        setVideoUrl(URL.createObjectURL(f))
        setPhase('idle')
        setProgress(0)
        setErrorMsg('')
    }

    async function convert() {
        const video = videoRef.current
        if (!video || !videoUrl || !file) return
        setErrorMsg('')
        setOutputUrl(null)

        try {
            if (video.readyState < 1) {
                await new Promise<void>(res => {
                    const fn = () => { video.removeEventListener('loadedmetadata', fn); res() }
                    video.addEventListener('loadedmetadata', fn)
                })
            }
            video.muted = true
            const duration = video.duration
            if (!isFinite(duration) || duration <= 0) throw new Error('Could not read video duration.')

            // Phase 1: extract colors ────────────────────────────────
            setPhase('extracting')
            setProgress(0)
            const intervalSec = updateMs / 1000
            const timeline: TimelineFrame[] = []
            for (let t = 0; t < duration; t += intervalSec) {
                await seekTo(video, t)
                timeline.push({
                    time: t,
                    buckets: extractBucketsFromFrame(video, analysisCanvas.current, saturation),
                })
                setProgress(t / duration)
            }

            // Phase 2: render audio ──────────────────────────────────
            setPhase('rendering')
            setProgress(0)
            const audioBuffer = await renderAudioTimeline(timeline, duration, maxColors, intervalSec)
            const wavBlob = audioBufferToWavBlob(audioBuffer)

            // Phase 3: send to Flask for muxing ──────────────────────
            setPhase('uploading')
            setProgress(0)
            const formData = new FormData()
            formData.append('video', file, file.name)
            formData.append('audio', wavBlob, 'generated.wav')

            const resp = await fetch('/mux-video', { method: 'POST', body: formData })
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: resp.statusText }))
                throw new Error(err.error || 'Server error')
            }

            const mp4Blob = await resp.blob()
            setOutputUrl(URL.createObjectURL(mp4Blob))
            setProgress(1)
            setPhase('done')
        } catch (err) {
            console.error(err)
            setErrorMsg(err instanceof Error ? err.message : 'Conversion failed.')
            setPhase('error')
        }
    }

    const busy = phase === 'extracting' || phase === 'rendering' || phase === 'uploading'

    const phaseLabel: Record<Phase, string> = {
        idle: '', extracting: 'Analyzing colors', rendering: 'Synthesizing audio',
        uploading: 'Sending to server & muxing', done: 'Done', error: 'Error',
    }

    return (
        <>
            <header className="masthead">
                <h1><span className="word w1">Video to sounds</span></h1>
                <p className="lede">
                    Upload a video. Every frame's colors become sound.
                </p>
                <p className="warning" role="note">
                    Note that this tool is still in developpment and may not work properly.
                </p>
            </header>

            <section className="panel">
                <h2 className="panel-title"><span className="num">01</span> source video</h2>
                <label
                    className={'dropzone' + (dragOver ? ' drag' : '') + (file ? ' has-file' : '')}
                    onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
                    onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setDragOver(false) }}
                    onDrop={e => {
                        e.preventDefault(); e.stopPropagation(); setDragOver(false)
                        const f = e.dataTransfer.files[0]; if (f) handleFile(f)
                    }}
                >
                    <input type="file" accept="video/*" hidden
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
                    <div className="dropzone-inner">
                        <div className="dz-icon" aria-hidden="true">&#127909;</div>
                        <div className="dz-text">
                            <span className="dz-primary">
                                {file ? file.name : 'drop a video or click to choose'}
                            </span>
                            <span className="dz-secondary">mp4 · webm · mov · any browser-playable format</span>
                        </div>
                    </div>
                </label>

                {videoUrl && (
                    <video
                        ref={videoRef}
                        src={videoUrl ?? undefined}
                        style={{ display: 'none' }}
                        muted
                        playsInline
                        preload="metadata"
                        crossOrigin="anonymous"
                    />
                )}
            </section>

            {videoUrl && (
                <section className="panel">
                    <h2 className="panel-title"><span className="num">02</span> settings</h2>

                    <div className="control">
                        <label htmlFor="v_sat">
                            <span className="control-name">Saturation</span>
                            <span className="control-desc">
                                Shifts the perceived colors before audio conversion.
                                0% = greyscale, 100% = natural, 200%+ = vivid.
                            </span>
                        </label>
                        <div className="control-row">
                            <input type="range" id="v_sat" min={0} max={300} step={5}
                                value={saturation} onChange={e => setSaturation(parseInt(e.target.value))} disabled={busy} />
                            <output>{saturation}%</output>
                        </div>
                    </div>

                    <div className="control">
                        <label htmlFor="v_colors">
                            <span className="control-name">Simultaneous notes</span>
                            <span className="control-desc">How many colors play at once per frame.</span>
                        </label>
                        <div className="control-row">
                            <input type="range" id="v_colors" min={1} max={16} step={1}
                                value={maxColors} onChange={e => setMaxColors(parseInt(e.target.value))} disabled={busy} />
                            <output>{maxColors}</output>
                        </div>
                    </div>

                    <div className="control">
                        <label htmlFor="v_interval">
                            <span className="control-name">Update speed</span>
                            <span className="control-desc">
                                How often colors are sampled. Lower = more reactive, slower analysis.
                            </span>
                        </label>
                        <div className="control-row">
                            <input type="range" id="v_interval" min={100} max={2000} step={50}
                                value={updateMs} onChange={e => setUpdateMs(parseInt(e.target.value))} disabled={busy} />
                            <output>{(updateMs / 1000).toFixed(2)}s</output>
                        </div>
                    </div>
                </section>
            )}

            {videoUrl && (
                <section className="panel">
                    <h2 className="panel-title"><span className="num">03</span> convert</h2>

                    {busy && (
                        <>
                            <div className="progress-track">
                                <div className="progress-fill"
                                    style={phase !== 'rendering'
                                        ? { width: `${Math.round(progress * 100)}%` }
                                        : undefined}
                                />
                            </div>
                            <div className="progress-meta">
                                <span>{phaseLabel[phase]}</span>
                                <span>{phase !== 'rendering' ? `${Math.round(progress * 100)}%` : '…'}</span>
                            </div>
                        </>
                    )}

                    {phase === 'error' && (
                        <p className="warning" role="alert"><strong>Error:</strong> {errorMsg}</p>
                    )}

                    <div className="song-playback-controls" style={{ marginTop: busy ? '1.25rem' : 0 }}>
                        <button type="button" className="btn" onClick={convert} disabled={busy}>
                            <span>{busy ? 'working…' : 'convert'}</span>
                            <span className="btn-arrow" aria-hidden="true">&rarr;</span>
                        </button>
                        {phase === 'done' && outputUrl && (
                            <a className="btn btn-secondary" href={outputUrl} download="video-to-sound.mp4">
                                <span>download .mp4</span>
                                <span className="btn-arrow" aria-hidden="true">&darr;</span>
                            </a>
                        )}
                    </div>

                    {phase === 'done' && outputUrl && (
                        <video src={outputUrl} className="camera-feed"
                            style={{ marginTop: '1.25rem' }} controls playsInline />
                    )}
                </section>
            )}
        </>
    )
}