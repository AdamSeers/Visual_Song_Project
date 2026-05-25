import { useEffect, useRef, useState } from 'react'
import {
    type ColorBucket, colorFromHex, startChord,
    buildChord, NOTE_NAMES, CHORD_RECIPES,
} from '../audio/colorChord'

type Transition = 'cut' | 'fade' | 'crossfade'

interface Panel {
    id: number              // stable identity for React keys and edits
    colors: string[]        // hex strings, e.g. "#ff8800"
    beats: number           // duration in beats (e.g. 1, 0.5, 2)
    transition: Transition  // how this panel transitions OUT to the next
}

const DEFAULT_BPM = 90
const BEAT_OPTIONS = [0.25, 0.5, 1, 1.5, 2, 3, 4]
const DEFAULT_COLOR = '#7aa2f7'

let nextPanelId = 1
function makePanel(colors: string[] = [], beats: number = 1, transition: Transition = 'fade'): Panel {
    return { id: nextPanelId++, colors, beats, transition }
}

export default function Song() {
    const [bpm, setBpm] = useState(DEFAULT_BPM)
    const [panels, setPanels] = useState<Panel[]>([
        makePanel([DEFAULT_COLOR], 1),
    ])
    const [playingPanelIdx, setPlayingPanelIdx] = useState<number | null>(null)
    const [quickRoot, setQuickRoot] = useState('C')
    const [quickType, setQuickType] = useState('major')

    const audioCtxRef = useRef<AudioContext | null>(null)
    const stopChordRef = useRef<(() => void) | null>(null)
    const playbackTimerRef = useRef<number | null>(null)

    const [isExporting, setIsExporting] = useState(false)

    const [draggedIdx, setDraggedIdx] = useState<number | null>(null)
    const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

    const [loop, setLoop] = useState(false)
    const loopRef = useRef(false)
    useEffect(() => { loopRef.current = loop }, [loop])

    function reorderPanels(fromIdx: number, toIdx: number) {
        if (fromIdx === toIdx) return
        setPanels(p => {
            const copy = [...p]
            const [moved] = copy.splice(fromIdx, 1)
            copy.splice(toIdx, 0, moved)
            return copy
        })
    }

    async function exportMp3() {
        setIsExporting(true)
        try {
            const beatDurationSec = 60 / bpm
            const renderPanels = panels.map(p => ({
                colors: p.colors.map(colorFromHex),
                durationSec: p.beats * beatDurationSec,
                transition: p.transition,
            }))
            const { renderSongToBuffer } = await import('../audio/colorChord')
            const { encodeAudioBufferToMp3 } = await import('../audio/mp3Encode')
            const audioBuffer = await renderSongToBuffer(renderPanels)
            const blob = encodeAudioBufferToMp3(audioBuffer)
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `song-${Date.now()}.mp3`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
        } catch (err) {
            console.error('Export failed:', err)
            alert('Export failed. Check the console for details.')
        } finally {
            setIsExporting(false)
        }
    }

    function getAudioContext(): AudioContext {
        if (!audioCtxRef.current) {
            audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)()
        }
        return audioCtxRef.current
    }

    // ----- panel mutation helpers -----
    function addPanel() {
        setPanels(p => [...p, makePanel([DEFAULT_COLOR], 1)])
    }
    function addChordPanel(root: string, type: string) {
        const colors = buildChord(root, type)
        setPanels(p => [...p, { id: nextPanelId++, colors, beats: 1, transition: 'fade' }])
    }
    function duplicatePanel(idx: number) {
        setPanels(p => {
            const copy = [...p]
            const source = copy[idx]
            copy.splice(idx + 1, 0, makePanel([...source.colors], source.beats))
            return copy
        })
    }
    function deletePanel(idx: number) {
        setPanels(p => p.filter((_, i) => i !== idx))
    }
    function addColor(panelIdx: number) {
        setPanels(p => p.map((panel, i) =>
            i === panelIdx ? { ...panel, colors: [...panel.colors, DEFAULT_COLOR] } : panel
        ))
    }
    function removeColor(panelIdx: number, colorIdx: number) {
        setPanels(p => p.map((panel, i) =>
            i === panelIdx
                ? { ...panel, colors: panel.colors.filter((_, j) => j !== colorIdx) }
                : panel
        ))
    }
    function updateTransition(panelIdx: number, transition: Transition) {
        setPanels(p => p.map((panel, i) =>
            i === panelIdx ? { ...panel, transition } : panel
        ))
    }
    function updateColor(panelIdx: number, colorIdx: number, hex: string) {
        setPanels(p => p.map((panel, i) =>
            i === panelIdx
                ? { ...panel, colors: panel.colors.map((c, j) => j === colorIdx ? hex : c) }
                : panel
        ))
    }
    function updateBeats(panelIdx: number, beats: number) {
        setPanels(p => p.map((panel, i) =>
            i === panelIdx ? { ...panel, beats } : panel
        ))
    }

    // ----- preview playback (live oscillators, sequential) -----
    function stopPlayback() {
        if (stopChordRef.current) { stopChordRef.current(); stopChordRef.current = null }
        if (playbackTimerRef.current !== null) {
            clearTimeout(playbackTimerRef.current)
            playbackTimerRef.current = null
        }
        setPlayingPanelIdx(null)
    }

    function playSong() {
        stopPlayback()
        const ctx = getAudioContext()
        const beatDurationSec = 60 / bpm

        const CROSSFADE_MS = 400

        const playPanel = (idx: number) => {
            if (idx >= panels.length) {
                if (loopRef.current) {
                    playPanel(0)
                    return
                }
                if (stopChordRef.current) {
                    stopChordRef.current()
                    stopChordRef.current = null
                }
                setPlayingPanelIdx(null)
                return
            }
            setPlayingPanelIdx(idx)
            const panel = panels[idx]
            const buckets: ColorBucket[] = panel.colors.map(colorFromHex)
            const panelDurationMs = panel.beats * beatDurationSec * 1000

            const startNext = () => {
                // For crossfade we kept the previous chord going; stop it now
                if (panel.transition === 'crossfade' && stopChordRef.current) {
                    stopChordRef.current()
                    stopChordRef.current = null
                }
                playPanel(idx + 1)
            }

            if (panel.transition === 'crossfade' && idx + 1 < panels.length) {
                // Start next chord slightly before stopping current
                stopChordRef.current = startChord(ctx, buckets, 0)
                playbackTimerRef.current = window.setTimeout(
                    startNext,
                    Math.max(0, panelDurationMs - CROSSFADE_MS),
                )
            } else {
                // cut or fade: stop previous, start this one cleanly
                if (stopChordRef.current) {
                    stopChordRef.current()
                    stopChordRef.current = null
                }
                stopChordRef.current = startChord(ctx, buckets, 0)
                playbackTimerRef.current = window.setTimeout(startNext, panelDurationMs)
            }
        }

        playPanel(0)
    }

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            stopPlayback()
            if (audioCtxRef.current) audioCtxRef.current.close()
        }
    }, [])

    const totalBeats = panels.reduce((s, p) => s + p.beats, 0)
    const totalSec = totalBeats * (60 / bpm)
    const isPlaying = playingPanelIdx !== null

    return (
        <>
            <header className="masthead">
                <h1><span className="word w1">Colors to sounds</span></h1>
                <p className="lede">
                    Compose a sequence of color chords. Each panel is a chord that plays for a
                    chosen number of beats; the panels play in order. Pick a tempo, add colors to
                    each panel, and listen to the result.
                </p>
            </header>

            <section className="panel">
                <h2 className="panel-title"><span className="num">01</span> tempo</h2>
                <div className="control">
                    <label htmlFor="bpm">
                        <span className="control-name">Beats per minute</span>
                    </label>
                    <div className="control-row">
                        <input
                            type="range"
                            id="bpm"
                            min={40}
                            max={200}
                            step={1}
                            value={bpm}
                            onChange={(e) => setBpm(parseInt(e.target.value))}
                        />
                        <output>{bpm}</output>
                    </div>
                </div>
            </section>

            <section className="panel">
                <h2 className="panel-title"><span className="num">02</span> quick chord</h2>
                <p style={{ color: 'var(--ink-dim)', fontSize: '0.9rem', marginBottom: '1rem' }}>
                    Pick a root note and chord type, then add it as a new panel.
                </p>

                <div className="chord-builder">
                    <div className="chord-builder-row">
                        <span className="chord-builder-label">root</span>
                        <div className="chord-builder-options">
                            {NOTE_NAMES.map(note => (
                                <button
                                    key={note}
                                    type="button"
                                    className={'chord-pill' + (quickRoot === note ? ' active' : '')}
                                    onClick={() => setQuickRoot(note)}
                                >
                                    {note}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="chord-builder-row">
                        <span className="chord-builder-label">type</span>
                        <div className="chord-builder-options">
                            {Object.keys(CHORD_RECIPES).map(type => (
                                <button
                                    key={type}
                                    type="button"
                                    className={'chord-pill' + (quickType === type ? ' active' : '')}
                                    onClick={() => setQuickType(type)}
                                >
                                    {type}
                                </button>
                            ))}
                        </div>
                    </div>
                    <button
                        type="button"
                        className="btn"
                        onClick={() => addChordPanel(quickRoot, quickType)}
                    >
                        <span>add {quickRoot} {quickType} as panel</span>
                        <span className="btn-arrow" aria-hidden="true">+</span>
                    </button>
                </div>
            </section>

            <section className="panel">
                <h2 className="panel-title">
                    <span className="num">03</span> panels &middot; {panels.length} panel{panels.length === 1 ? '' : 's'} &middot; {totalSec.toFixed(1)}s
                </h2>

                <div className="song-panels">
                    {panels.map((panel, panelIdx) => (
                        <div
                            key={panel.id}
                            className={
                                'song-panel'
                                + (playingPanelIdx === panelIdx ? ' playing' : '')
                                + (draggedIdx === panelIdx ? ' dragging' : '')
                                + (dragOverIdx === panelIdx ? ' drag-over' : '')
                            }
                            draggable
                            onDragStart={(e) => {
                                setDraggedIdx(panelIdx)
                                e.dataTransfer.effectAllowed = 'move'
                            }}
                            onDragOver={(e) => {
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                                if (dragOverIdx !== panelIdx) setDragOverIdx(panelIdx)
                            }}
                            onDragLeave={() => setDragOverIdx(null)}
                            onDrop={(e) => {
                                e.preventDefault()
                                if (draggedIdx !== null) reorderPanels(draggedIdx, panelIdx)
                                setDraggedIdx(null)
                                setDragOverIdx(null)
                            }}
                            onDragEnd={() => {
                                setDraggedIdx(null)
                                setDragOverIdx(null)
                            }}
                        >
                            <div className="song-panel-header">
                                <span className="drag-handle" aria-hidden="true">⋮⋮</span>
                                <span className="song-panel-num">#{panelIdx + 1}</span>
                                <select
                                    value={panel.beats}
                                    onChange={(e) => updateBeats(panelIdx, parseFloat(e.target.value))}
                                    className="song-panel-beats"
                                    title="Duration in beats"
                                >
                                    {BEAT_OPTIONS.map(b => (
                                        <option key={b} value={b}>{b} beat{b === 1 ? '' : 's'}</option>
                                    ))}
                                </select>
                                <select
                                    value={panel.transition}
                                    onChange={(e) => updateTransition(panelIdx, e.target.value as Transition)}
                                    className="song-panel-beats"
                                    title="Transition to next panel"
                                >
                                    <option value="cut">cut</option>
                                    <option value="fade">fade</option>
                                    <option value="crossfade">crossfade</option>
                                </select>
                                <div className="song-panel-actions">
                                    <button
                                        type="button"
                                        onClick={() => duplicatePanel(panelIdx)}
                                        className="icon-btn"
                                        title="Duplicate panel"
                                        aria-label="Duplicate panel"
                                    >&#10063;</button>
                                    <button
                                        type="button"
                                        onClick={() => deletePanel(panelIdx)}
                                        className="icon-btn icon-btn-danger"
                                        title="Delete panel"
                                        aria-label="Delete panel"
                                        disabled={panels.length === 1}
                                    >&times;</button>
                                </div>
                            </div>

                            <div className="song-panel-colors">
                                {panel.colors.map((color, colorIdx) => (
                                    <div key={colorIdx} className="song-color-swatch">
                                        <input
                                            type="color"
                                            value={color}
                                            onChange={(e) => updateColor(panelIdx, colorIdx, e.target.value)}
                                            aria-label={`Color ${colorIdx + 1}`}
                                        />
                                        {panel.colors.length > 1 && (
                                            <button
                                                type="button"
                                                onClick={() => removeColor(panelIdx, colorIdx)}
                                                className="song-color-remove"
                                                aria-label="Remove color"
                                                title="Remove color"
                                            >&times;</button>
                                        )}
                                    </div>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => addColor(panelIdx)}
                                    className="circle-btn"
                                    title="Add color"
                                    aria-label="Add color"
                                >+</button>
                            </div>
                        </div>
                    ))}
                </div>

                <button
                    type="button"
                    onClick={addPanel}
                    className="circle-btn circle-btn-large"
                    title="Add panel"
                    aria-label="Add panel"
                >+</button>
            </section>

            <section className="panel">
                <h2 className="panel-title"><span className="num">04</span> play</h2>
                <div className="song-playback-controls">
                    <button
                        type="button"
                        className="btn"
                        onClick={isPlaying ? stopPlayback : playSong}
                        disabled={isExporting}
                    >
                        <span>{isPlaying ? 'stop' : 'play'}</span>
                        <span className="btn-arrow" aria-hidden="true">{isPlaying ? '◼' : '▶'}</span>
                    </button>
                    <button
                        type="button"
                        className={'btn btn-secondary loop-btn' + (loop ? ' active' : '')}
                        onClick={() => setLoop(!loop)}
                        disabled={isExporting}
                        title={loop ? 'Loop is on — click to disable' : 'Loop is off — click to enable'}
                    >
                        <span>loop</span>
                        <span className="btn-arrow" aria-hidden="true">↻</span>
                    </button>
                    <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={exportMp3}
                        disabled={isPlaying || isExporting}
                    >
                        <span>{isExporting ? 'exporting…' : 'download MP3'}</span>
                        <span className="btn-arrow" aria-hidden="true">&darr;</span>
                    </button>
                    <span className="song-playback-info">
                        {isPlaying
                            ? `playing panel ${(playingPanelIdx ?? 0) + 1} of ${panels.length}`
                            : `${totalSec.toFixed(1)}s total`}
                    </span>
                </div>
            </section>
        </>
    )
}