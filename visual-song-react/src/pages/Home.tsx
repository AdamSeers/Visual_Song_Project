import { useEffect, useRef, useState } from 'react'
import Slider from '../components/Slider'

type JobStatus = 'idle' | 'uploading' | 'rendering' | 'done' | 'error'

export default function Home() {
    const formRef = useRef<HTMLFormElement>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)
    const [fileName, setFileName] = useState('Choose an audio file')
    const [hasFile, setHasFile] = useState(false)
    const [dragOver, setDragOver] = useState(false)

    const [status, setStatus] = useState<JobStatus>('idle')
    const [statusTitle, setStatusTitle] = useState('working…')
    const [progressPct, setProgressPct] = useState(0)
    const [progressDetail, setProgressDetail] = useState('analysing audio')
    const [resultUrl, setResultUrl] = useState<string | null>(null)
    const resultPanelRef = useRef<HTMLElement>(null)
    const [inputMode, setInputMode] = useState<'file' | 'youtube'>('file')
    const [youtubeUrl, setYoutubeUrl] = useState('')

    function pickFile(file: File) {
        setFileName(file.name)
        setHasFile(true)
        if (fileInputRef.current) {
            const dt = new DataTransfer()
            dt.items.add(file)
            fileInputRef.current.files = dt.files
        }
    }

    const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        const file = e.dataTransfer.files[0]
        if (file) pickFile(file)
    }

    async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault()
        if (inputMode === 'file' && !fileInputRef.current?.files?.[0]) return
        if (inputMode === 'youtube' && !youtubeUrl.trim()) return

        setStatus('uploading')
        setStatusTitle(inputMode === 'youtube' ? 'checking license' : 'uploading')
        setProgressPct(0)
        setProgressDetail(inputMode === 'youtube' ? 'verifying Creative Commons license & fetching audio' : 'sending file to server')
        setResultUrl(null)

        const fd = new FormData(formRef.current!)
        const endpoint = inputMode === 'youtube' ? '/jobs/youtube' : '/jobs'
        if (inputMode === 'youtube') fd.append('youtube_url', youtubeUrl.trim())

        let jobId: string
        try {
            const resp = await fetch(endpoint, { method: 'POST', body: fd })
            if (!resp.ok) {
                const j = await resp.json().catch(() => ({}))
                throw new Error(j.error || 'HTTP ' + resp.status)
            }
            const data = await resp.json()
            jobId = data.job_id
        } catch (err: any) {
            setStatus('error')
            setStatusTitle('failed: ' + err.message)
            setProgressDetail('\u00a0')
            return
        }

        setStatus('rendering')
        setStatusTitle('rendering')
        setProgressDetail('analysing pitches & rendering frames')
        poll(jobId)
    }

    function poll(jobId: string) {
        const interval = setInterval(async () => {
            try {
                const r = await fetch('/jobs/' + jobId)
                if (!r.ok) throw new Error('HTTP ' + r.status)
                const s = await r.json()
                const pct = Math.round((s.progress || 0) * 100)
                setProgressPct(pct)
                if (s.status === 'done') {
                    clearInterval(interval)
                    setResultUrl('/jobs/' + jobId + '/video')
                    setStatusTitle('done')
                    setProgressDetail('complete')
                    setStatus('done')
                } else if (s.status === 'error') {
                    clearInterval(interval)
                    setStatus('error')
                    setStatusTitle('error: ' + (s.error || 'unknown'))
                    setProgressDetail('\u00a0')
                }
            } catch (err: any) {
                clearInterval(interval)
                setStatus('error')
                setStatusTitle('poll failed: ' + err.message)
                setProgressDetail('\u00a0')
            }
        }, 1000)
    }

    useEffect(() => {
        if (status === 'done' && resultPanelRef.current) {
            resultPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }
    }, [status])

    const submitting = status === 'uploading' || status === 'rendering'
    const showStatus = status !== 'idle'
    const showResult = status === 'done' && resultUrl

    return (
        <>
            <header className="masthead">
                <h1><span className="word w1">Song to colors</span></h1>
                <p className="lede">
                    Upload a song and get back a video where every pitch is rendered as a colored shape.
                    The colors aren&rsquo;t arbitrary &mdash; each musical frequency is doubled into the
                    visible light spectrum, so an A becomes a particular orange, an E becomes a violet,
                    and so on, with all octaves of the same note sharing the same color.<br /><br />Louder notes
                    are brighter; purer tones are more saturated, while voice or strings come out softer
                    because of their overtones. Rounder shapes are mellow timbres, squarer ones are
                    brighter timbres.
                </p>
                <p className="warning" role="note">
                    <strong>Photosensitivity warning:</strong> the output video contains rapidly changing
                    colors and brightness. If you have photosensitive epilepsy or are sensitive to
                    flashing imagery, please avoid watching or proceed with caution.
                </p>
            </header>

            <section className="panel">
                <h2 className="panel-title"><span className="num">01</span> drop in a file</h2>

                <form id="upload-form" className="form" ref={formRef} onSubmit={handleSubmit}>
                    <div className="input-mode-toggle">
                        <button type="button"
                            className={'mode-btn' + (inputMode === 'file' ? ' active' : '')}
                            onClick={() => setInputMode('file')}>
                            upload a file
                        </button>
                        <button type="button"
                            className={'mode-btn' + (inputMode === 'youtube' ? ' active' : '')}
                            onClick={() => setInputMode('youtube')}>
                            YouTube link
                        </button>
                    </div>

                    {inputMode === 'file' ? (
                        <label
                            className={'dropzone' + (dragOver ? ' drag' : '') + (hasFile ? ' has-file' : '')}
                            onDragEnter={(e) => { e.preventDefault(); setDragOver(true) }}
                            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                            onDragLeave={(e) => { e.preventDefault(); setDragOver(false) }}
                            onDrop={handleDrop}
                        >
                            <input
                                type="file"
                                name="audio"
                                accept="audio/*"
                                required
                                hidden
                                ref={fileInputRef}
                                onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f) }}
                            />
                            <div className="dropzone-inner">
                                <div className="dz-icon" aria-hidden="true">&#9834;</div>
                                <div className="dz-text">
                                    <span className="dz-primary">{fileName}</span>
                                    <span className="dz-secondary">mp3 · wav · flac · ogg · m4a · aac · opus</span>
                                </div>
                            </div>
                        </label>
                    ) : (
                        <div className="control">
                            <label htmlFor="youtube_url">
                                <span className="control-name">YouTube URL</span>
                                <span className="control-desc">
                                    Only Creative Commons-licensed videos can be processed.
                                </span>
                            </label>
                            <input
                                type="url"
                                id="youtube_url"
                                placeholder="https://www.youtube.com/watch?v=..."
                                value={youtubeUrl}
                                onChange={e => setYoutubeUrl(e.target.value)}
                                className="youtube-input"
                            />
                        </div>
                    )}

                    <button type="submit" className="btn" disabled={submitting}>
                        <span>render visualization</span>
                        <span className="btn-arrow" aria-hidden="true">&rarr;</span>
                    </button>

                    <details className="controls">
                        <summary className="controls-summary">
                            <span>advanced settings</span>
                            <span className="controls-chevron" aria-hidden="true">&#9656;</span>
                        </summary>
                        <p className="controls-hint">Defaults work well. Adjust if you want a different feel.</p>

                        <Slider id="amplitude_floor" name="amplitude_floor"
                            label="Volume threshold"
                            description="How loud a note must be to show up. Higher = fewer, only-loud notes."
                            min={0} max={0.6} step={0.01} defaultValue={0.20} />

                        <Slider id="min_observed_frames" name="min_observed_frames"
                            label="Minimum note length"
                            description="How long a note must persist before it gets a shape, in frames (at 30 fps)."
                            min={1} max={30} step={1} defaultValue={7} />

                        <Slider id="freq_smooth" name="freq_smooth"
                            label="Color responsiveness"
                            description="How quickly colors react to pitch changes. Lower = calmer, smoother."
                            min={0.02} max={0.6} step={0.01} defaultValue={0.18} />

                        <Slider id="fade_in_frames" name="fade_in_frames"
                            label="Fade-in length"
                            description="Frames a new shape takes to grow in. Higher = gentler entrances."
                            min={1} max={30} step={1} defaultValue={3} />

                        <Slider id="fade_out_frames" name="fade_out_frames"
                            label="Fade-out length"
                            description="Frames a shape takes to disappear. Higher = lingering shapes."
                            min={1} max={60} step={1} defaultValue={8} />

                        <Slider id="audio_offset" name="audio_offset"
                            label="Audio delay"
                            description="Delay the audio (seconds) to match the visual. Increase if audio feels early."
                            min={0} max={1.0} step={0.05} defaultValue={0.20} />
                    </details>
                </form>
            </section>

            {showStatus && (
                <section className="panel status-panel">
                    <h2 className="panel-title">
                        <span className="num">02</span> <span>{statusTitle}</span>
                    </h2>
                    <div className="progress-track" aria-hidden="true">
                        <div className="progress-fill" style={{ width: progressPct + '%' }}></div>
                    </div>
                    <div className="progress-meta">
                        <span>{progressPct}%</span>
                        <span>{progressDetail}</span>
                    </div>
                </section>
            )}

            {showResult && (
                <section className="panel result-panel" ref={resultPanelRef as any}>
                    <h2 className="panel-title"><span className="num">03</span> here it is</h2>
                    <video src={resultUrl} controls playsInline></video>
                    <a href={resultUrl} className="btn btn-secondary" download>
                        <span>download MP4</span>
                        <span className="btn-arrow" aria-hidden="true">&darr;</span>
                    </a>
                </section>
            )}
        </>
    )
}