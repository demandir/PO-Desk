import { useState } from 'react'
import { StatusBadge } from '../components/StatusBadge'
import { formatDate } from '../lib/calculations'
import { dataService } from '../services/dataService'
import type { OrderStatus, PublicOrderStatus } from '../types'

const statusMessages: Record<OrderStatus, string> = {
  submitted: 'Waiting for review',
  under_review: 'Being reviewed',
  needs_information: 'More information needed',
  approved: 'Approved for ordering',
  rejected: 'Not approved',
  ordered: 'Ordered',
}

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
    <main id="main-content" className="page-column track-page">
      <section className="page-intro">
        <h1>Check a request</h1>
        <p>Enter the code you got after sending your request.</p>
      </section>

      <form className="panel track-form" onSubmit={(event) => void lookup(event)}>
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
        {dataService.mode === 'demo' && (
          <button className="text-button" type="button" onClick={useDemo}>
            Use sample request code
          </button>
        )}
      </form>

      <div aria-live="polite">
        {result && (
          <article className="panel public-result">
            <div className="public-result__topline">
              <span>{result.requestCode}</span>
              <StatusBadge status={result.status} />
            </div>
            <h2>{statusMessages[result.status]}</h2>
            <dl>
              <div>
                <dt>Sent</dt>
                <dd>{formatDate(result.submittedAt)}</dd>
              </div>
              <div>
                <dt>Last updated</dt>
                <dd>{formatDate(result.updatedAt)}</dd>
              </div>
            </dl>
            <p>Questions about this request? Contact your department admin.</p>
          </article>
        )}
      </div>
    </main>
  )
}
