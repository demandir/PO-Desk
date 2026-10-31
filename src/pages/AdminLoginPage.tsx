import { useState } from 'react'
import { dataService } from '../services/dataService'
import type { AdminProfile, AdminRole } from '../types'

export function AdminLoginPage({
  onAuthenticated,
}: {
  onAuthenticated: (profile: AdminProfile) => void
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setLoading(true)
    try {
      onAuthenticated(await dataService.signIn(username.trim(), password))
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Sign in failed.')
    } finally {
      setLoading(false)
    }
  }

  const enterDemo = async (role: AdminRole) => {
    setError('')
    try {
      onAuthenticated(await dataService.enterDemo(role))
    } catch (demoError) {
      setError(demoError instanceof Error ? demoError.message : 'Demo access failed.')
    }
  }

  return (
    <main id="main-content" className="login-page">
      <section className="login-intro">
        <h1 className="display-heading">Review purchase requests</h1>
        <p>
          Department administrators see only their own queue. Global administrators can review every
          department and company-wide totals.
        </p>
      </section>
      <section className="login-panel" data-reveal>
        {dataService.mode === 'demo' ? (
          <div className="demo-access">
            <div>
              <h2>Department view</h2>
              <p>See the Operations queue and make decisions only inside that department.</p>
              <button
                className="button button--deep"
                type="button"
                onClick={() => void enterDemo('department_admin')}
              >
                Open department view
              </button>
            </div>
            <div>
              <h2>Global view</h2>
              <p>See every request, company-wide statistics, and department management.</p>
              <button
                className="button button--primary"
                type="button"
                onClick={() => void enterDemo('global_admin')}
              >
                Open global view
              </button>
            </div>
            {error && <p className="form-message form-message--error" role="alert">{error}</p>}
          </div>
        ) : (
          <form className="login-form" onSubmit={(event) => void signIn(event)}>
            <label className="field">
              <span>Username</span>
              <input
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {error && <p className="form-message form-message--error" role="alert">{error}</p>}
            <button className="button button--primary" type="submit" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
      </section>
    </main>
  )
}
