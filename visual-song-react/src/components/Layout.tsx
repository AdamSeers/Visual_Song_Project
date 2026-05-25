import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { applyTheme, resetTheme, getStoredTheme, useTheme } from '../hooks/useTheme'

export default function Layout() {
    useTheme()
    const [accent, setAccent] = useState(getStoredTheme())

    const handleAccentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value
        setAccent(val)
        applyTheme(val)
    }

    const handleReset = () => {
        resetTheme()
        setAccent('#7aa2f7')
    }

    return (
        <>
            <nav className="topnav">
                <NavLink to="/" className="brand">
                    <span className="brand-name">Visual Song Project</span>
                </NavLink>
                <ul className="nav-links">
                    <li>
                        <NavLink to="/" end className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                            Home
                        </NavLink>
                    </li>
                    <li>
                        <NavLink to="/live" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                            Live
                        </NavLink>
                    </li>
                    <li>
                        <NavLink to="/images" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                            Images
                        </NavLink>
                    </li>
                    <li>
                        <NavLink to="/notes" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                            Notes
                        </NavLink>
                    </li>
                    <li>
                        <NavLink to="/song" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                            Song
                        </NavLink>
                    </li>
                    <li>
                        <NavLink to="/about" className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                            About
                        </NavLink>
                    </li>
                </ul>
            </nav>

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
                        Please support me on PayPal so I can keep this website up
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