import { useEffect, useRef, useState } from 'react'
import Slider from '../components/Slider'

type JobStatus = 'idle' | 'uploading' | 'rendering' | 'done' | 'error'

export default function Images() {
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
        const endpoint = inputMode === 'youtube' ? '/jobs/images/youtube' : '/jobs/images'
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
                <h1><span className="word w1">Song to images</span></h1>
                <p className="lede">
                    Upload a song. The tempo is detected, and the video cuts between images chosen to
                    match the colors of each beat. Loud notes contribute more strongly to the color
                    match than quiet ones.
                </p>
                <p className="warning" role="note">
                    <strong>Photosensitivity warning:</strong> rapid image cuts. If you have
                    photosensitive epilepsy, avoid or proceed with caution.
                </p>
            </header>

            <section className="panel">
                <h2 className="panel-title"><span className="num">01</span> drop in a file</h2>

                <form id="upload-form" className="form" ref={formRef} onSubmit={handleSubmit}>
                    {/*<div className="input-mode-toggle">
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
                    </div>*/}

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
                        <span>render images video</span>
                        <span className="btn-arrow" aria-hidden="true">&rarr;</span>
                    </button>

                    <details className="controls">
                        <summary className="controls-summary">
                            <span>advanced settings</span>
                            <span className="controls-chevron" aria-hidden="true">&#9656;</span>
                        </summary>
                        <p className="controls-hint">Defaults work well. Adjust if you want a different feel.</p>

                        <Slider id="images_per_beat" name="images_per_beat"
                            label="Images per beat"
                            description="Higher = more frequent cuts. Use values below 1 for slower (e.g. 0.5 = one image every 2 beats)."
                            min={0.25} max={8} step={0.25} defaultValue={2} />

                        <Slider id="accuracy" name="accuracy"
                            label="Image color accuracy"
                            description="How closely an image must match the song's colors. Higher = stricter color match, fewer but better-fitting images."
                            min={0.1} max={1.0} step={0.05} defaultValue={0.9} />

                        <Slider id="audio_offset" name="audio_offset"
                            label="Audio delay"
                            description="Delay the audio (seconds) to match the visual."
                            min={0} max={1.0} step={0.05} defaultValue={0.00} />

                        <div className="control">
                            <label className="switch-label">
                                <input type="checkbox" id="debug_no_images" name="debug_no_images" />
                                <span className="switch-track" aria-hidden="true"></span>
                                <span className="control-name">Debug: skip image search</span>
                                <span className="control-desc">
                                    When on, no images are fetched &mdash; the video shows the raw color bars instead.
                                </span>
                            </label>
                        </div>
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