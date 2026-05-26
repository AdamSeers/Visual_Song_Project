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
        ],
    },
    {
        title: 'Info',
        items: [
            { to: '/about', label: 'About', end: false },
        ],
    },
]

export default function Layout() {
    useTheme()
    const [accent, setAccent] = useState(getStoredTheme())
    const [sidebarOpen, setSidebarOpen] = useState(false)

    const handleAccentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value
        setAccent(val)
        applyTheme(val)
    }

    const handleReset = () => {
        resetTheme()
        setAccent('#7aa2f7')
    }

    // Close sidebar on Escape key
    useEffect(() => {
        if (!sidebarOpen) return
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setSidebarOpen(false)
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [sidebarOpen])

    // Lock body scroll when sidebar is open
    useEffect(() => {
        document.body.style.overflow = sidebarOpen ? 'hidden' : ''
        return () => { document.body.style.overflow = '' }
    }, [sidebarOpen])

    return (
        <>
            <header className="topbar">
                <NavLink to="/" className="brand">
                    <img src="/logo.png" alt="" className="brand-logo" />
                    <span className="brand-name">Visual Song Project</span>
                </NavLink>
                <button
                    type="button"
                    className="hamburger"
                    onClick={() => setSidebarOpen(true)}
                    aria-label="Open navigation"
                    aria-expanded={sidebarOpen}
                >
                    <span></span>
                    <span></span>
                    <span></span>
                </button>
            </header>

            {/* Backdrop — clickable to close */}
            <div
                className={'sidebar-backdrop' + (sidebarOpen ? ' open' : '')}
                onClick={() => setSidebarOpen(false)}
                aria-hidden="true"
            />

            {/* Sliding sidebar */}
            <aside
                className={'sidebar' + (sidebarOpen ? ' open' : '')}
                aria-label="Site navigation"
                inert={!sidebarOpen}
            >
                <div className="sidebar-header">
                    <span className="sidebar-title">Navigate</span>
                    <button
                        type="button"
                        className="sidebar-close"
                        onClick={() => setSidebarOpen(false)}
                        aria-label="Close navigation"
                    >
                        &times;
                    </button>
                </div>

                <nav className="sidebar-nav">
                    {NAV_SECTIONS.map(section => (
                        <div key={section.title} className="sidebar-section">
                            <div className="sidebar-section-title">{section.title}</div>
                            {section.items.map(item => (
                                <NavLink
                                    key={item.to}
                                    to={item.to}
                                    end={item.end}
                                    onClick={() => setSidebarOpen(false)}
                                    className={({ isActive }) => 'sidebar-link' + (isActive ? ' active' : '')}
                                >
                                    <span className="sidebar-link-bullet" aria-hidden="true">&#9656;</span>
                                    <span className="sidebar-link-label">{item.label}</span>
                                </NavLink>
                            ))}
                        </div>
                    ))}
                </nav>
            </aside>

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
                        Please consider supporting me on PayPal so I can keep this website up
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
        </>
    )
}