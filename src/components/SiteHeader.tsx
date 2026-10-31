import { useState } from 'react'
import type { AdminProfile } from '../types'

interface SiteHeaderProps {
  profile: AdminProfile | null
  onSignOut: () => Promise<void>
}

export function SiteHeader({ profile, onSignOut }: SiteHeaderProps) {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )

  const toggleTheme = () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = nextTheme
    window.localStorage.setItem('po-desk-theme', nextTheme)
    setTheme(nextTheme)
  }

  return (
    <header className="site-header">
      <a className="wordmark" href="#/" aria-label="PO Desk home">
        <span className="wordmark__sheet" aria-hidden="true" />
        PO Desk
      </a>
      <nav className="site-nav" aria-label="Primary navigation">
        <a href="#/" aria-current={!window.location.hash || window.location.hash === '#/' ? 'page' : undefined}>New request</a>
        <a href="#/track" aria-current={window.location.hash === '#/track' ? 'page' : undefined}>Check status</a>
        <button
          className="text-button theme-toggle"
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
          {theme === 'light' ? 'Dark' : 'Light'}
        </button>
        {profile ? (
          <>
            <a href="#/admin" aria-current={window.location.hash === '#/admin' ? 'page' : undefined}>Dashboard</a>
            <button className="text-button" type="button" onClick={() => void onSignOut()}>
              Sign out
            </button>
          </>
        ) : (
          <a className="nav-action" href="#/admin/login">
            Admin sign in
          </a>
        )}
      </nav>
    </header>
  )
}
