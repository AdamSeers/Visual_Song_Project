import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { applyTheme, resetTheme, getStoredTheme, useTheme } from '../hooks/useTheme'

const NAV_SECTIONS = [
    {
        title: 'Sound to light',
        items: [
            { to: '/', label: 'Song → Colors', end: true },
            { to: '/images', label: 'Song → Images', end: false },
            { to: '/live', label: 'Microphone → Colors', end: false },
        ],
    },
    {
        title: 'Light to sound',
        items: [
            { to: '/notes', label: 'Image → Sound', end: false },
            { to: '/song', label: 'Colors → Sounds', end: false },
            { to: '/camera', label: 'Camera → Sounds', end: false },
            { to: '/video', label: 'Video → Sounds', end: false },
        ],
    },
    {
        title: 'Info',
        items: [
            { to: '/about', label: 'About', end: false },
        ],
    },
]

const DESKTOP_BREAKPOINT = 768

// Panel icon: a rectangle with a vertical divider on the left —
// universally understood as "toggle sidebar"
function PanelIcon() {
    return (
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none"
            stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round"
            aria-hidden="true">
            <rect x="1.5" y="1.5" width="17" height="17" rx="2.5" />
            <line x1="7" y1="1.5" x2="7" y2="18.5" />
        </svg>
    )
}

export default function Layout() {
    useTheme()
    const [accent, setAccent] = useState(getStoredTheme())
    const [sidebarOpen, setSidebarOpen] = useState(
        () => typeof window !== 'undefined' && window.innerWidth >= DESKTOP_BREAKPOINT
    )

    const handleAccentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value
        setAccent(val)
        applyTheme(val)
    }

    const handleReset = () => {
        resetTheme()
        setAccent('#7aa2f7')
    }

    useEffect(() => {
        if (!sidebarOpen) return
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setSidebarOpen(false)
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [sidebarOpen])

    useEffect(() => {
        const isMobile = window.innerWidth < DESKTOP_BREAKPOINT
        document.body.style.overflow = (sidebarOpen && isMobile) ? 'hidden' : ''
        return () => { document.body.style.overflow = '' }
    }, [sidebarOpen])

    function handleNavClick() {
        if (window.innerWidth < DESKTOP_BREAKPOINT) setSidebarOpen(false)
    }

    return (
        <>
            {/* Mobile-only backdrop */}
            <div
                className={'sidebar-backdrop' + (sidebarOpen ? ' open' : '')}
                onClick={() => setSidebarOpen(false)}
                aria-hidden="true"
            />

            <div className={'app-shell' + (sidebarOpen ? ' sidebar-open' : '')}>

                {/* ── Sidebar ── */}
                <aside
                    className={'sidebar' + (sidebarOpen ? ' open' : '')}
                    aria-label="Site navigation"
                    {...({ inert: !sidebarOpen ? '' : undefined } as any)}
                >
                    <div className="sidebar-header">
                        <span className="sidebar-title">Navigate</span>

                        {/* Desktop: panel icon. Mobile: × */}
                        <button
                            type="button"
                            className="sidebar-close"
                            onClick={() => setSidebarOpen(false)}
                            aria-label="Close navigation"
                        >
                            <span className="sidebar-close-x" aria-hidden="true">
                                &times;
                            </span>
                            <span className="sidebar-close-panel">
                                <PanelIcon />
                            </span>
                        </button>
                    </div>

                    <nav className="sidebar-nav">
                        {NAV_SECTIONS.map(section => (
                            <div key={section.title} className="sidebar-section">
                                <div className="sidebar-section-title">
                                    {section.title}
                                </div>
                                {section.items.map(item => (
                                    <NavLink
                                        key={item.to}
                                        to={item.to}
                                        end={item.end}
                                        onClick={handleNavClick}
                                        className={({ isActive }) =>
                                            'sidebar-link' + (isActive ? ' active' : '')
                                        }
                                    >
                                        <span className="sidebar-link-bullet" aria-hidden="true">
                                            &#9656;
                                        </span>
                                        <span className="sidebar-link-label">{item.label}</span>
                                    </NavLink>
                                ))}
                            </div>
                        ))}
                    </nav>
                </aside>

                {/* ── Main content ── */}
                <div className="app-content">
                    <header className="topbar">
                        <div className="topbar-left">
                            {/*
                              Desktop: panel icon shown ONLY when sidebar is closed,
                              sitting next to the logo.
                              Mobile: never shown here (hamburger below handles it).
                            */}
                            <button
                                type="button"
                                className="topbar-panel-btn"
                                onClick={() => setSidebarOpen(true)}
                                aria-label="Open navigation"
                            >
                                <PanelIcon />
                            </button>

                            <NavLink to="/" className="brand">
                                <img src="/logo.png" alt="" className="brand-logo" />
                                <span className="brand-name">Visual Song Project</span>
                            </NavLink>
                        </div>

                        {/*
                          Mobile-only hamburger — always visible on small screens,
                          toggles the overlay sidebar.
                        */}
                        <button
                            type="button"
                            className="hamburger"
                            onClick={() => setSidebarOpen(o => !o)}
                            aria-label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
                            aria-expanded={sidebarOpen}
                        >
                            <span></span>
                            <span></span>
                            <span></span>
                        </button>
                    </header>

                    <div className="spectrum-bar" aria-hidden="true"></div>

                    <main className="shell">
                        <Outlet />

                        <footer className="footer">
                            <a href="https://www.linkedin.com/in/adam-seers-69122336a"
                                target="_blank" rel="noopener noreferrer"
                                className="footer-link">
                                Adam Seers
                            </a>
                            <span className="dot">&middot;</span>
                            <a href="https://www.paypal.com/paypalme/adamseers"
                                target="_blank" rel="noopener noreferrer"
                                className="footer-link">
                                Please consider supporting me to keep this website up
                            </a>
                            <span className="footer-theme" title="Theme color">
                                <input
                                    type="color"
                                    value={accent}
                                    onChange={handleAccentChange}
                                    aria-label="Theme color"
                                />
                                <button type="button" onClick={handleReset} aria-label="Reset theme">
                                    &#10227;
                                </button>
                            </span>
                        </footer>
                    </main>
                </div>
            </div>
        </>
    )
}