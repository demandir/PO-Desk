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
    <main id="main-content" className="page-column login-page">
      <section className="page-intro">
        <h1>Admin sign in</h1>
        <p>Department admins see their own department's requests. The super admin sees every department.</p>
      </section>
      {dataService.mode === 'demo' ? (
        <section className="panel demo-choices" aria-label="Demo access">
          <div className="demo-choice">
            <div>
              <h2>Department admin</h2>
              <p>Review and decide requests for one department.</p>
            </div>
            <button className="button button--quiet" type="button" onClick={() => void enterDemo('department_admin')}>
              Open department view
            </button>
          </div>
          <div className="demo-choice">
            <div>
              <h2>Super admin</h2>
              <p>See every department, spending, and department settings.</p>
            </div>
            <button className="button button--primary" type="button" onClick={() => void enterDemo('global_admin')}>
              Open super admin view
            </button>
          </div>
          {error && <p className="form-message form-message--error" role="alert">{error}</p>}
        </section>
      ) : (
        <form className="panel login-form" onSubmit={(event) => void signIn(event)}>
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
    </main>
  )
}
