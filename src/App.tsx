import { lazy, Suspense, useEffect, useState } from 'react'
import { AppFooter } from './components/AppFooter'
import { ModeNotice } from './components/ModeNotice'
import { SiteHeader } from './components/SiteHeader'
import { RequestPage } from './pages/RequestPage'
import { TrackPage } from './pages/TrackPage'
import { dataService } from './services/dataService'
import { configurationError } from './lib/config'
import type { AdminProfile } from './types'

// Most visitors only submit or track a request, so admin screens load on demand.
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage').then((module) => ({ default: module.AdminDashboardPage })))
const AdminLoginPage = lazy(() => import('./pages/AdminLoginPage').then((module) => ({ default: module.AdminLoginPage })))

const readRoute = () => window.location.hash.replace(/^#/, '') || '/'

export default function App() {
  const [route, setRoute] = useState(readRoute)
  const [profile, setProfile] = useState<AdminProfile | null>(null)
  const [profileReady, setProfileReady] = useState(false)
  const [sessionError, setSessionError] = useState('')

  useEffect(() => {
    const onHashChange = () => {
      setRoute(readRoute())
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    void dataService.getCurrentProfile().then((value) => {
      setProfile(value)
    }).catch(() => setSessionError('Administrator session could not be restored. Please sign in again.'))
      .finally(() => setProfileReady(true))
  }, [])

  useEffect(() => {
    const titles: Record<string, string> = {
      '/': 'Request · PO Desk',
      '/track': 'Track · PO Desk',
      '/admin/login': 'Admin sign in · PO Desk',
      '/admin': 'Dashboard · PO Desk',
    }
    document.title = titles[route] ?? 'PO Desk'
    const elements = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'))
    if (!('IntersectionObserver' in window)) {
      elements.forEach((element) => element.classList.add('is-in'))
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in')
            observer.unobserve(entry.target)
          }
        })
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    elements.forEach((element) => observer.observe(element))
    const fallback = window.setTimeout(
      () => elements.forEach((element) => element.classList.add('is-in')),
      1400,
    )
    return () => {
      window.clearTimeout(fallback)
      observer.disconnect()
    }
  }, [route])

  const handleProfile = (nextProfile: AdminProfile) => {
    setSessionError('')
    setProfile(nextProfile)
    window.location.hash = '/admin'
  }

  const handleSignOut = async () => {
    try {
      await dataService.signOut()
      setProfile(null)
      setSessionError('')
      window.location.hash = '/'
    } catch { setSessionError('Sign out failed. Check your connection and try again.') }
  }

  let page
  if (route === '/track') page = <TrackPage />
  else if (route === '/admin/login') {
    page = profile ? (
      <AdminDashboardPage profile={profile} onSignOut={handleSignOut} />
    ) : (
      <AdminLoginPage onAuthenticated={handleProfile} />
    )
  } else if (route === '/admin') {
    page = !profileReady ? (
      <main className="loading-page" aria-live="polite">Loading your workspace…</main>
    ) : profile ? (
      <AdminDashboardPage profile={profile} onSignOut={handleSignOut} />
    ) : (
      <AdminLoginPage onAuthenticated={handleProfile} />
    )
  } else page = <RequestPage />

  const isDashboard = route === '/admin' && Boolean(profile)

  if (configurationError) return <main className="loading-page"><h1>Connection setup needed</h1><p>{configurationError}</p></main>

  return (
    <>
      <a className="skip-link" href="#main-content" onClick={(event) => {
        event.preventDefault()
        const main = document.getElementById('main-content')
        main?.setAttribute('tabindex', '-1')
        main?.focus()
      }}>Skip to content</a>
      <ModeNotice />
      <SiteHeader profile={profile} onSignOut={handleSignOut} />
      {sessionError && <p className="dashboard-error" role="alert">{sessionError}</p>}
      <Suspense fallback={<main className="loading-page" aria-live="polite">Loading…</main>}>{page}</Suspense>
      {!isDashboard && <AppFooter />}
    </>
  )
}
