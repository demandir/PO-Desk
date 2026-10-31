import { useState } from 'react'
import { StatusBadge } from '../components/StatusBadge'
import { formatDate } from '../lib/calculations'
import { dataService } from '../services/dataService'
import type { PublicOrderStatus } from '../types'

export function TrackPage() {
  const [requestCode, setRequestCode] = useState(() => {
    try { return window.sessionStorage.getItem('po-desk-last-request-code') ?? '' } catch { return '' }
  })
  const [result, setResult] = useState<PublicOrderStatus | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const lookup = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    setResult(null)
    if (!requestCode.trim()) {
      setError('Enter the request code from your receipt.')
      return
    }
    setLoading(true)
    try {
      const order = await dataService.lookupPurchaseOrder(requestCode)
      if (!order) setError('No request matched that code.')
      else setResult(order)
    } catch (lookupError) {
      setError(lookupError instanceof Error ? lookupError.message : 'The request could not be checked.')
    } finally {
      setLoading(false)
    }
  }

  const useDemo = () => {
    setRequestCode('7K2M-B4WN')
    setResult(null)
    setError('')
  }

  return (
    <main id="main-content" className="track-page">
      <section className="track-intro">
        <h1 className="display-heading">Check a request</h1>
        <p>
          Enter the single request code shown after submission. The lookup reveals status only,
          never requester or purchasing details.
        </p>
        {dataService.mode === 'demo' && (
          <button className="text-button text-button--strong" type="button" onClick={useDemo}>
            Use sample request code
          </button>
        )}
      </section>

      <section className="track-workspace" data-reveal>
        <form className="track-form" onSubmit={(event) => void lookup(event)}>
          <label className="field">
            <span>Request code</span>
            <input
              value={requestCode}
              onChange={(event) => { setRequestCode(event.target.value.toUpperCase()); setResult(null); setError('') }}
              placeholder="7K2M-B4WN"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          {error && <p className="form-message form-message--error" role="alert">{error}</p>}
          <button className="button button--primary" type="submit" disabled={loading}>
            {loading ? 'Checking…' : 'Check status'}
          </button>
        </form>

        <article className="public-status" data-ui aria-live="polite">
          {result ? (
            <>
              <div className="public-status__topline">
                <span>{result.requestCode}</span>
                <StatusBadge status={result.status} />
              </div>
              <h2>{result.status === 'approved' ? 'Approved for ordering' : 'Your request is in the record'}</h2>
              <dl>
                <div>
                  <dt>Submitted</dt>
                  <dd>{formatDate(result.submittedAt)}</dd>
                </div>
                <div>
                  <dt>Last updated</dt>
                  <dd>{formatDate(result.updatedAt)}</dd>
                </div>
              </dl>
              <p>Contact your department administrator if more information is needed.</p>
            </>
          ) : (
            <>
              <span className="public-status__blank-mark" aria-hidden="true">PO</span>
              <h2>Status appears here</h2>
              <p>Only the current state and dates are returned from a public lookup.</p>
            </>
          )}
        </article>
      </section>
    </main>
  )
}
