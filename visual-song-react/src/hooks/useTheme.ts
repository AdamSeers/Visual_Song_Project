import { useEffect } from 'react'

const DEFAULT_ACCENT = '#7aa2f7'
const STORAGE_KEY = 'visualsong-theme'

function hexToRgb(hex: string) {
    const h = hex.replace('#', '')
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
    }
}

function rgbToHex(r: number, g: number, b: number) {
    const c = (v: number) =>
        Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
    return '#' + c(r) + c(g) + c(b)
}

function mixToward(hex: string, target: string, pct: number) {
    const a = hexToRgb(hex)
    const b = hexToRgb(target)
    return rgbToHex(
        a.r + (b.r - a.r) * pct,
        a.g + (b.g - a.g) * pct,
        a.b + (b.b - a.b) * pct,
    )
}

export function applyTheme(accent: string) {
    const root = document.documentElement.style
    root.setProperty('--bg', mixToward(accent, '#000000', 0.94))
    root.setProperty('--bg-2', mixToward(accent, '#000000', 0.88))
    root.setProperty('--bg-3', mixToward(accent, '#000000', 0.80))
    root.setProperty('--rule', mixToward(accent, '#000000', 0.72))
    root.setProperty('--ink', mixToward(accent, '#ffffff', 0.85))
    root.setProperty('--ink-dim', mixToward(accent, '#888888', 0.55))
    root.setProperty('--ink-faint', mixToward(accent, '#555555', 0.55))
    root.setProperty('--accent', accent)
    root.setProperty('--accent-2', mixToward(accent, '#ffffff', 0.45))
    localStorage.setItem(STORAGE_KEY, accent)
}

export function resetTheme() {
    localStorage.removeItem(STORAGE_KEY)
    applyTheme(DEFAULT_ACCENT)
}

export function getStoredTheme(): string {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_ACCENT
}

/** Restores the saved theme once on mount. Used by Layout. */
export function useTheme() {
    useEffect(() => {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved) applyTheme(saved)
    }, [])
}