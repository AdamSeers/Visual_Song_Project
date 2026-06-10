import { useEffect, useRef, useState } from 'react'
import {
    type ColorBucket, colorFromHex, startChord,
    buildChord, NOTE_NAMES, CHORD_RECIPES,
    extractTopColorsFromImage,
} from '../audio/colorChord'

type Transition = 'cut' | 'fade'

interface Panel {
    id: number              // stable identity for React keys and edits
    colors: string[]        // hex strings, e.g. "#ff8800"
    beats: number           // duration in beats (e.g. 1, 0.5, 2)
    transition: Transition  // how this panel transitions OUT to the next
}

const SONGS_KEY = 'visualsong-songs-v1'
const CURRENT_SONG_KEY = 'visualsong-current-id'
const OLD_STORAGE_KEY = 'visualsong-song-v1'   // migration only

interface SavedSong {
    id: string
    name: string
    bpm: number
    panels: { colors: string[]; beats: number; transition: 'cut' | 'fade' }[]
    updatedAt: number
}

let nextPanelId = 1

function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
}

function generateName(): string {
    const now = new Date()
    const month = now.toLocaleString('en', { month: 'short' })
    const day = now.getDate()
    const h = now.getHours().toString().padStart(2, '0')
    const m = now.getMinutes().toString().padStart(2, '0')
    return `Song — ${month} ${day}, ${h}:${m}`
}

function loadAllSongs(): SavedSong[] {
    try {
        const raw = localStorage.getItem(SONGS_KEY)
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed) && parsed.length > 0) return parsed
        }
    } catch { }
    // Migrate from old single-song format
    try {
        const old = localStorage.getItem(OLD_STORAGE_KEY)
        if (old) {
            const parsed = JSON.parse(old)
            if (parsed.bpm || parsed.panels) {
                return [{
                    id: generateId(),
                    name: 'My Song',
                    bpm: parsed.bpm ?? DEFAULT_BPM,
                    panels: Array.isArray(parsed.panels) ? parsed.panels : [],
                    updatedAt: Date.now(),
                }]
            }
        }
    } catch { }
    return []
}

// Runs once at module load. Gives useState its initial values.
function initSongState() {
    let songs = loadAllSongs()
    if (songs.length === 0) {
        const first: SavedSong = {
            id: generateId(),
            name: generateName(),
            bpm: DEFAULT_BPM,
            panels: [],
            updatedAt: Date.now(),
        }
        songs = [first]
        try { localStorage.setItem(SONGS_KEY, JSON.stringify(songs)) } catch { }
    }
    let currentId = songs[0].id
    try {
        const stored = localStorage.getItem(CURRENT_SONG_KEY)
        if (stored && songs.some(s => s.id === stored)) currentId = stored
    } catch { }
    const song = songs.find(s => s.id === currentId) ?? songs[0]
    const panels: Panel[] = song.panels.map(p => ({
        id: nextPanelId++,
        colors: Array.isArray(p.colors) ? p.colors : [],
        beats: typeof p.beats === 'number' ? p.beats : 1,
        transition: p.transition === 'cut' ? 'cut' : 'fade',
    }))
    return { songs, currentId, bpm: song.bpm, panels }
}

const _init = initSongState()
const DEFAULT_BPM = 90
const BEAT_OPTIONS = [0.25, 0.5, 1, 1.5, 2, 3, 4]
const DEFAULT_COLOR = '#7aa2f7'

function makePanel(colors: string[] = [], beats: number = 1, transition: Transition = 'fade'): Panel {
    return { id: nextPanelId++, colors, beats, transition }
}

export default function Song() {
    const [allSongs, setAllSongs] = useState<SavedSong[]>(_init.songs)
    const [currentSongId, setCurrentSongId] = useState<string>(_init.currentId)
    const [bpm, setBpm] = useState<number>(_init.bpm)
    const [panels, setPanels] = useState<Panel[]>(_init.panels)
    const [playingPanelIdx, setPlayingPanelIdx] = useState<number | null>(null)
    const [quickRoot, setQuickRoot] = useState('C')
    const [quickType, setQuickType] = useState('major')
    const [isRenaming, setIsRenaming] = useState(false)
    const [renameValue, setRenameValue] = useState('')
    const renameInputRef = useRef<HTMLInputElement>(null)

    const audioCtxRef = useRef<AudioContext | null>(null)
    const stopChordRef = useRef<(() => void) | null>(null)
    const playbackTimerRef = useRef<number | null>(null)

    const [isExporting, setIsExporting] = useState(false)

    const [draggedIdx, setDraggedIdx] = useState<number | null>(null)
    const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

    const [loop, setLoop] = useState(false)
    const loopRef = useRef(false)

    const previewStopRef = useRef<(() => void) | null>(null)
    const [previewingIdx, setPreviewingIdx] = useState<number | null>(null)

    useEffect(() => { loopRef.current = loop }, [loop])

    // Auto-save the active song whenever bpm or panels change
    useEffect(() => {
        if (!currentSongId) return
        const serialized = panels.map(p => ({
            colors: p.colors,
            beats: p.beats,
            transition: p.transition,
        }))
        setAllSongs(prev => {
            const updated = prev.map(s => s.id === currentSongId
                ? { ...s, bpm, panels: serialized, updatedAt: Date.now() }
                : s
            )
            try { localStorage.setItem(SONGS_KEY, JSON.stringify(updated)) } catch { }
            return updated
        })
    }, [bpm, panels])

    // Persist the active song ID
    useEffect(() => {
        try { localStorage.setItem(CURRENT_SONG_KEY, currentSongId) } catch { }
    }, [currentSongId])
    const [confirmDialog, setConfirmDialog] = useState<{
        title: string
        body: string
        confirmLabel: string
        onConfirm: () => void
    } | null>(null)

    const [imageDragOver, setImageDragOver] = useState(false)
    const [isExtractingImage, setIsExtractingImage] = useState(false)
    const imageInputRef = useRef<HTMLInputElement>(null)

    const previewColors = buildChord(quickRoot, quickType)

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
    async function addPanelFromImage(file: File) {
        if (!file.type.startsWith('image/')) return
        setIsExtractingImage(true)
        try {
            const colors = await extractTopColorsFromImage(file, 5)
            if (colors.length === 0) return
            setPanels(p => [...p, { id: nextPanelId++, colors, beats: 1, transition: 'fade' }])
        } catch (err) {
            console.error('Failed to extract colors from image:', err)
            alert('Could not read that image.')
        } finally {
            setIsExtractingImage(false)
        }
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

    function requestClear() {
        if (panels.length === 0) return
        setConfirmDialog({
            title: 'Clear all panels?',
            body: `This will remove all ${panels.length} panel${panels.length === 1 ? '' : 's'} and reset the tempo to ${DEFAULT_BPM} BPM. This cannot be undone.`,
            confirmLabel: 'clear all',
            onConfirm: confirmClear,
        })
    }

    function confirmClear() {
        setBpm(DEFAULT_BPM)
        setPanels([])
        setConfirmDialog(null)
    }

    function requestDeleteSong() {
        const current = allSongs.find(s => s.id === currentSongId)
        const isLast = allSongs.length === 1
        setConfirmDialog({
            title: isLast ? 'Clear this song?' : 'Delete this song?',
            body: isLast
                ? `"${current?.name}" will be cleared. This cannot be undone.`
                : `"${current?.name}" will be permanently deleted. This cannot be undone.`,
            confirmLabel: isLast ? 'clear' : 'delete',
            onConfirm: deleteCurrentSong,
        })
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
        stopPreview()
        stopPlayback()
        const ctx = getAudioContext()
        const beatDurationSec = 60 / bpm

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
                playPanel(idx + 1)
            }

            if (stopChordRef.current) {
                stopChordRef.current()
                stopChordRef.current = null
            }
            stopChordRef.current = startChord(ctx, buckets, 0)
            playbackTimerRef.current = window.setTimeout(startNext, panelDurationMs)
        }

        playPanel(0)
    }

    function saveCurrent(songsSnapshot: SavedSong[]): SavedSong[] {
        // Explicitly persist the current working state into the song list.
        // Called before switching so we don't lose edits.
        const serialized = panels.map(p => ({
            colors: p.colors, beats: p.beats, transition: p.transition,
        }))
        return songsSnapshot.map(s => s.id === currentSongId
            ? { ...s, bpm, panels: serialized, updatedAt: Date.now() }
            : s
        )
    }

    function switchToSong(song: SavedSong) {
        stopPlayback()
        // Save current before switching
        setAllSongs(prev => {
            const updated = saveCurrent(prev)
            try { localStorage.setItem(SONGS_KEY, JSON.stringify(updated)) } catch { }
            return updated
        })
        setCurrentSongId(song.id)
        setBpm(song.bpm)
        setPanels(song.panels.map(p => ({
            id: nextPanelId++,
            colors: Array.isArray(p.colors) ? p.colors : [],
            beats: typeof p.beats === 'number' ? p.beats : 1,
            transition: p.transition === 'cut' ? 'cut' : 'fade',
        })))
    }

    function createSong() {
        const newSong: SavedSong = {
            id: generateId(),
            name: generateName(),
            bpm: DEFAULT_BPM,
            panels: [],
            updatedAt: Date.now(),
        }
        setAllSongs(prev => {
            const saved = saveCurrent(prev)
            const updated = [...saved, newSong]
            try { localStorage.setItem(SONGS_KEY, JSON.stringify(updated)) } catch { }
            return updated
        })
        setCurrentSongId(newSong.id)
        setBpm(DEFAULT_BPM)
        setPanels([])
        stopPlayback()
    }

    function deleteCurrentSong() {
        if (allSongs.length === 1) {
            // Last song — just clear it instead of deleting
            setBpm(DEFAULT_BPM)
            setPanels([])
            return
        }
        const idx = allSongs.findIndex(s => s.id === currentSongId)
        const newSongs = allSongs.filter(s => s.id !== currentSongId)
        const nextSong = newSongs[Math.max(0, idx - 1)]
        try { localStorage.setItem(SONGS_KEY, JSON.stringify(newSongs)) } catch { }
        setAllSongs(newSongs)
        setCurrentSongId(nextSong.id)
        setBpm(nextSong.bpm)
        setPanels(nextSong.panels.map(p => ({
            id: nextPanelId++,
            colors: p.colors,
            beats: p.beats,
            transition: p.transition as 'cut' | 'fade',
        })))
        stopPlayback()
    }

    function startRename() {
        const current = allSongs.find(s => s.id === currentSongId)
        setRenameValue(current?.name ?? '')
        setIsRenaming(true)
        setTimeout(() => renameInputRef.current?.select(), 30)
    }

    function commitRename() {
        if (!renameValue.trim()) { setIsRenaming(false); return }
        setAllSongs(prev => {
            const updated = prev.map(s => s.id === currentSongId
                ? { ...s, name: renameValue.trim() }
                : s
            )
            try { localStorage.setItem(SONGS_KEY, JSON.stringify(updated)) } catch { }
            return updated
        })
        setIsRenaming(false)
    }

    function previewPanel(panelIdx: number) {
        // If song is playing, stop it first — only one playback at a time
        if (isPlaying) stopPlayback()

        // If this panel is already previewing, stop it (toggle)
        if (previewingIdx === panelIdx) {
            stopPreview()
            return
        }

        // Stop any other preview
        stopPreview()

        const ctx = getAudioContext()
        const panel = panels[panelIdx]
        const buckets: ColorBucket[] = panel.colors.map(colorFromHex)
        if (buckets.length === 0) return

        previewStopRef.current = startChord(ctx, buckets, 0)
        setPreviewingIdx(panelIdx)

        // Auto-stop after panel.beats at current BPM
        const beatDurationSec = 60 / bpm
        const durationMs = panel.beats * beatDurationSec * 1000
        window.setTimeout(() => {
            // Only stop if this preview is still the active one
            // (the user could have started a different preview in the meantime)
            if (previewStopRef.current) {
                previewStopRef.current()
                previewStopRef.current = null
            }
            setPreviewingIdx(curr => curr === panelIdx ? null : curr)
        }, durationMs)
    }

    function stopPreview() {
        if (previewStopRef.current) {
            previewStopRef.current()
            previewStopRef.current = null
        }
        setPreviewingIdx(null)
    }

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            stopPlayback()
            stopPreview()
            if (audioCtxRef.current) audioCtxRef.current.close()
        }
    }, [])

    const totalBeats = panels.reduce((s, p) => s + p.beats, 0)
    const totalSec = totalBeats * (60 / bpm)
    const isPlaying = playingPanelIdx !== null

    return (
        <>
            <div className="song-manager">
                <button
                    type="button"
                    className="song-manager-btn"
                    onClick={requestDeleteSong}
                    title={allSongs.length === 1 ? 'Clear song' : 'Delete song'}
                    aria-label="Delete song"
                >
                    &minus;
                </button>

                {isRenaming ? (
                    <input
                        ref={renameInputRef}
                        className="song-manager-input"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={e => {
                            if (e.key === 'Enter') commitRename()
                            if (e.key === 'Escape') setIsRenaming(false)
                        }}
                        autoFocus
                    />
                ) : (
                    <select
                        className="song-manager-select"
                        value={currentSongId}
                        onChange={e => {
                            const song = allSongs.find(s => s.id === e.target.value)
                            if (song) switchToSong(song)
                        }}
                    >
                        {allSongs.map(s => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                )}

                <button
                    type="button"
                    className="song-manager-btn"
                    onClick={isRenaming ? commitRename : startRename}
                    title={isRenaming ? 'Confirm rename' : 'Rename song'}
                    aria-label={isRenaming ? 'Confirm rename' : 'Rename song'}
                >
                    {isRenaming ? '✓' : '✏'}
                </button>

                <button
                    type="button"
                    className="song-manager-btn song-manager-new"
                    onClick={createSong}
                    title="New song"
                    aria-label="New song"
                >
                    +
                </button>
            </div>
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
                        className="btn chord-preview-btn"
                        onClick={() => addChordPanel(quickRoot, quickType)}
                    >
                        <span>add {quickRoot} {quickType} as panel</span>
                        <span className="chord-preview-swatches" aria-hidden="true">
                            {previewColors.map((color, i) => (
                                <span
                                    key={i}
                                    className="chord-preview-swatch"
                                    style={{ background: color }}
                                />
                            ))}
                        </span>
                        <span className="btn-arrow" aria-hidden="true">+</span>
                    </button>
                </div>
            </section>

            <section
                className={'panel' + (imageDragOver ? ' panel-image-drag' : '')}
                onDragEnter={(e) => {
                    // Only react to file drags, not panel-reorder drags
                    if (e.dataTransfer.types.includes('Files')) {
                        e.preventDefault()
                        setImageDragOver(true)
                    }
                }}
                onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('Files')) {
                        e.preventDefault()
                        setImageDragOver(true)
                    }
                }}
                onDragLeave={(e) => {
                    // Only clear if we're leaving the section, not entering a child
                    if (e.currentTarget.contains(e.relatedTarget as Node)) return
                    setImageDragOver(false)
                }}
                onDrop={(e) => {
                    if (!e.dataTransfer.types.includes('Files')) return
                    e.preventDefault()
                    setImageDragOver(false)
                    const file = e.dataTransfer.files[0]
                    if (file) addPanelFromImage(file)
                }}
            >
                <h2 className="panel-title">
                    <span className="num">03</span> panels &middot; {panels.length} panel{panels.length === 1 ? '' : 's'} &middot; {totalSec.toFixed(1)}s

                    <button
                        type="button"
                        className="icon-btn icon-btn-danger song-clear-btn"
                        onClick={requestClear}
                        disabled={isPlaying || isExporting || panels.length === 0}
                        title="Clear all panels"
                        aria-label="Clear all panels"
                    >
                        &#10227;
                    </button>
                </h2>

                <div className="song-panels">
                    {panels.length === 0 ? (
                        <div className="song-empty">
                            <p>No panels yet. Add one below or use the quick chord builder.</p>
                        </div>
                    ) : panels.map((panel, panelIdx) => (
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
                                {panelIdx < panels.length - 1 && (
                                    <select
                                        value={panel.transition}
                                        onChange={(e) => updateTransition(panelIdx, e.target.value as Transition)}
                                        className="song-panel-beats"
                                        title="Transition to next panel"
                                    >
                                        <option value="cut">cut</option>
                                        <option value="fade">fade</option>
                                    </select>
                                )}
                                <div className="song-panel-actions">
                                    <button
                                        type="button"
                                        onClick={() => previewPanel(panelIdx)}
                                        className={'icon-btn icon-btn-preview' + (previewingIdx === panelIdx ? ' active' : '')}
                                        title={previewingIdx === panelIdx ? 'Stop preview' : 'Preview panel'}
                                        aria-label={previewingIdx === panelIdx ? 'Stop preview' : 'Preview panel'}
                                        disabled={panel.colors.length === 0}
                                    >
                                        {previewingIdx === panelIdx ? '◼' : '▶'}
                                    </button>
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

                <div className="song-add-row">
                    <button
                        type="button"
                        onClick={addPanel}
                        className="circle-btn circle-btn-large"
                        title="Add empty panel"
                        aria-label="Add empty panel"
                    >+</button>
                    <button
                        type="button"
                        onClick={() => imageInputRef.current?.click()}
                        className="circle-btn circle-btn-large"
                        title="Add panel from image"
                        aria-label="Add panel from image"
                        disabled={isExtractingImage}
                    >
                        {isExtractingImage ? (
                            <span>…</span>
                        ) : (
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"
                                stroke="currentColor" strokeWidth="1.8"
                                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <rect x="3" y="5" width="18" height="14" rx="1.5" />
                                <circle cx="8.5" cy="10" r="1.5" />
                                <path d="M3 17l5.5-5.5 4 4L16 12l5 5" />
                            </svg>
                        )}
                    </button>
                    <input
                        type="file"
                        accept="image/*"
                        hidden
                        ref={imageInputRef}
                        onChange={(e) => {
                            const f = e.target.files?.[0]
                            if (f) addPanelFromImage(f)
                            if (imageInputRef.current) imageInputRef.current.value = ''
                        }}
                    />
                </div>
            </section>
            <section className="panel">
                <h2 className="panel-title"><span className="num">04</span> play</h2>
                <div className="song-playback-controls">
                    <button
                        type="button"
                        className="btn"
                        onClick={isPlaying ? stopPlayback : playSong}
                        disabled={isExporting || panels.length === 0}
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
                        disabled={isPlaying || isExporting || panels.length === 0}
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

            {confirmDialog && (
                <div
                    className="modal-backdrop"
                    onClick={() => setConfirmDialog(null)}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="confirm-title"
                >
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <h3 id="confirm-title" className="modal-title">{confirmDialog.title}</h3>
                        <p className="modal-body">{confirmDialog.body}</p>
                        <div className="modal-actions">
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => setConfirmDialog(null)}
                            >
                                <span>cancel</span>
                            </button>
                            <button
                                type="button"
                                className="btn modal-danger-btn"
                                onClick={() => {
                                    confirmDialog.onConfirm()
                                    setConfirmDialog(null)
                                }}
                            >
                                <span>{confirmDialog.confirmLabel}</span>
                                <span className="btn-arrow" aria-hidden="true">&times;</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}