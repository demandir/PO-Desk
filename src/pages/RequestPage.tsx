import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Turnstile } from '../components/Turnstile'
import { calculateLineTotal, calculateTotals, formatMoney } from '../lib/calculations'
import { turnstileSiteKey } from '../lib/config'
import { createSubmissionAttempt, readPendingSubmission, savePendingSubmission } from '../lib/submissionAttempt'
import { SubmissionError } from '../lib/serviceErrors'
import { flattenValidationErrors, normalizeLink, purchaseOrderSchema } from '../lib/validation'
import { dataService } from '../services/dataService'
import type { Department, LineItemInput, PurchaseOrderDraft, SubmissionReceipt } from '../types'


const makeLineItem = (): LineItemInput => ({
  id: crypto.randomUUID(),
  description: '',
  quantity: 1,
  unitPrice: 0,
})

const makeDraft = (): PurchaseOrderDraft => ({
  requesterName: '',
  departmentId: '',
  vendorName: '',
  vendorUrl: '',
  costCenter: '',
  businessReason: '',
  items: [makeLineItem()],
  currency: 'USD',
  website: '',
})

function ErrorText({ message, id }: { message?: string; id: string }) {
  return message ? (
    <span className="field-error" id={id} role="alert">
      {message}
    </span>
  ) : null
}

// Text inputs keep partial values like "1." intact while the draft stores numbers.
function DecimalInput({
  value,
  onValueChange,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number
  onValueChange: (value: number) => void
}) {
  const [text, setText] = useState(value ? String(value) : '')
  return (
    <input
      {...props}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={text}
      onChange={(event) => {
        const next = event.target.value.replace(/,/g, '').trim()
        if (!/^\d*\.?\d{0,2}$/.test(next)) return
        setText(next)
        onValueChange(Number(next) || 0)
      }}
    />
  )
}

// Validation reports fields in schema order; the summary follows the page.
const fieldOrder = ['requesterName', 'departmentId', 'vendorName', 'items', 'businessReason', 'vendorUrl']
const fieldRank = (field: string) => fieldOrder.indexOf(field.split('.')[0] ?? field)

const errorLabel = (field: string, message: string) => {
  const item = /^items\.(\d+)\./.exec(field)
  return item ? `Item ${Number(item[1]) + 1}: ${message}` : message
}

function SubmissionComplete({
  receipt,
  onAnother,
}: {
  receipt: SubmissionReceipt
  onAnother: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(receipt.requestCode)
      setCopied(true)
      setCopyError('')
      window.setTimeout(() => setCopied(false), 1600)
    } catch { setCopyError('Please write the code down or print this page.') }
  }
  return (
    <main id="main-content" className="receipt-page">
      <div className="receipt-copy">
        <h1 className="display-heading">Request received</h1>
        <p>Write down this code. You will need it to check on your request later.</p>
      </div>
      <article className="tracking-receipt" data-ui aria-label="Request code receipt">
        <div>
          <span>Your request code</span>
          <strong className="tracking-code">{receipt.requestCode}</strong>
          <button type="button" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy code'}
          </button>
          {copyError && <p role="status">{copyError}</p>}
        </div>
        <p>Sent {new Date(receipt.submittedAt).toLocaleString()}</p>
      </article>
      <div className="receipt-actions">
        <a className="button button--primary" href="#/track">
          Check status
        </a>
        <button className="button button--quiet" type="button" onClick={() => window.print()}>Print this page</button>
        <button className="button button--quiet" type="button" onClick={onAnother}>
          New request
        </button>
      </div>
    </main>
  )
}

export function RequestPage() {
  const [initialAttempt] = useState(readPendingSubmission)
  const pendingAttempt = useRef(initialAttempt)
  const [retryPending, setRetryPending] = useState(Boolean(initialAttempt))
  const [draft, setDraft] = useState<PurchaseOrderDraft>(() => initialAttempt?.draft ?? makeDraft())
  const [departments, setDepartments] = useState<Department[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null)
  const [turnstileToken, setTurnstileToken] = useState('')
  const [turnstileVersion, setTurnstileVersion] = useState(0)
  const [departmentsLoading, setDepartmentsLoading] = useState(true)
  const [optionalOpen, setOptionalOpen] = useState(Boolean(initialAttempt?.draft.vendorUrl || initialAttempt?.draft.costCenter))
  const errorSummaryRef = useRef<HTMLDivElement>(null)
  const addItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    void dataService
      .listDepartments()
      .then(setDepartments)
      .catch(() => setFormError('Departments could not be loaded. Refresh and try again.'))
      .finally(() => setDepartmentsLoading(false))
  }, [])

  const totals = useMemo(
    () => calculateTotals(draft.items),
    [draft.items],
  )

  const updateField = <K extends keyof PurchaseOrderDraft>(
    field: K,
    value: PurchaseOrderDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [field]: value }))
    setErrors((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  const updateItem = <K extends keyof LineItemInput>(
    index: number,
    field: K,
    value: LineItemInput[K],
  ) => {
    setDraft((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    }))
    setErrors((current) => {
      const next = { ...current }
      delete next[`items.${index}.${String(field)}`]
      return next
    })
  }

  const addItem = () => {
    updateField('items', [...draft.items, makeLineItem()])
    requestAnimationFrame(() => document.getElementById(`field-items.${draft.items.length}.description`)?.focus())
  }
  const removeItem = (index: number) => {
    if (draft.items.length === 1) return
    updateField('items', draft.items.filter((_, itemIndex) => itemIndex !== index))
    // Item errors are keyed by position, so they no longer match after a removal.
    setErrors((current) => Object.fromEntries(Object.entries(current).filter(([field]) => !field.startsWith('items.'))))
    addItemRef.current?.focus()
  }

  const handleTurnstile = useCallback((token: string) => setTurnstileToken(token), [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (isSubmitting) return
    setFormError('')
    const validation = purchaseOrderSchema.safeParse({ ...draft, vendorUrl: normalizeLink(draft.vendorUrl) })
    if (!pendingAttempt.current && !validation.success) {
      const nextErrors = flattenValidationErrors(validation.error)
      setErrors(nextErrors)
      if (nextErrors.vendorUrl) setOptionalOpen(true)
      requestAnimationFrame(() => errorSummaryRef.current?.focus())
      return
    }
    if (turnstileSiteKey && !turnstileToken) {
      setFormError('Complete the spam-prevention check before submitting.')
      requestAnimationFrame(() => errorSummaryRef.current?.focus())
      return
    }
    setIsSubmitting(true)
    try {
      const attempt = pendingAttempt.current ?? createSubmissionAttempt(validation.success ? validation.data : draft)
      pendingAttempt.current = attempt
      savePendingSubmission(attempt)
      const existing = retryPending ? await dataService.lookupPurchaseOrder(attempt.requestCode) : null
      const result = existing ? { requestCode: attempt.requestCode, submittedAt: existing.submittedAt } : await dataService.submitPurchaseOrder(
        attempt.draft,
        attempt.requestCode,
        attempt.idempotencyKey,
        turnstileToken,
      )
      setReceipt(result)
      pendingAttempt.current = null
      savePendingSubmission(null)
      setRetryPending(false)
      try { window.sessionStorage.setItem('po-desk-last-request-code', result.requestCode) } catch { /* The receipt remains visible. */ }
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'The request could not be submitted.')
      const rejected = error instanceof SubmissionError && error.rejected
      setRetryPending(!rejected)
      if (rejected) {
        pendingAttempt.current = null
        savePendingSubmission(null)
      }
      setTurnstileToken('')
      setTurnstileVersion((version) => version + 1)
      requestAnimationFrame(() => errorSummaryRef.current?.focus())
    } finally {
      setIsSubmitting(false)
    }
  }

  if (receipt) {
    return (
      <SubmissionComplete
        receipt={receipt}
        onAnother={() => {
          setDraft(makeDraft())
          setReceipt(null)
          setErrors({})
          setTurnstileToken('')
          setFormError('')
          setOptionalOpen(false)
        }}
      />
    )
  }

  return (
    <main id="main-content">
      <section className="request-intro">
        <h1>Request a purchase</h1>
        <p>Fill in the three parts below, then press Send request. You do not need an account.</p>
        <p>Please answer every question unless it says optional. Do not enter card numbers, bank details, ID numbers, or health information.</p>
      </section>

      <form className="po-form" id="request-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        {(Object.keys(errors).length > 0 || formError) && (
          <div className="error-summary" ref={errorSummaryRef} tabIndex={-1} role="alert">
            <strong>{retryPending ? 'We could not confirm your request was sent.' : 'Please fix these before sending:'}</strong>
            {formError && <p>{formError}</p>}
            {Object.values(errors).length > 0 && (
              <ul>
                {Object.entries(errors).sort(([a], [b]) => fieldRank(a) - fieldRank(b)).map(([field, message]) => (
                  <li key={field}>
                    <button type="button" onClick={() => document.getElementById(`field-${field}`)?.focus()}>
                      {errorLabel(field, message)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {retryPending && <p className="retry-notice" role="status">Your answers are saved. Press Try sending again below. This will not create a second request.</p>}
        <fieldset className="request-fields" disabled={isSubmitting || retryPending}>
        <section className="form-section" aria-labelledby="requester-heading">
          <h2 id="requester-heading"><span className="step-number" aria-hidden="true">1</span>About you</h2>
          <div className="field-grid">
            <label className="field">
              <span>Your name</span>
              <input
                id="field-requesterName"
                autoCapitalize="words"
                value={draft.requesterName}
                onChange={(event) => updateField('requesterName', event.target.value)}
                autoComplete="name"
                aria-invalid={Boolean(errors.requesterName)}
                aria-describedby={errors.requesterName ? 'requester-name-error' : undefined}
              />
              <ErrorText id="requester-name-error" message={errors.requesterName} />
            </label>
            <label className="field">
              <span>Your department</span>
              <select
                id="field-departmentId"
                value={draft.departmentId}
                onChange={(event) => updateField('departmentId', event.target.value)}
                aria-invalid={Boolean(errors.departmentId)}
                aria-describedby={errors.departmentId ? 'department-error' : undefined}
              >
                <option value="">{departmentsLoading ? 'Loading departments…' : departments.length ? 'Choose your department' : 'No departments available'}</option>
                {departments.map((department) => (
                  <option value={department.id} key={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
              <ErrorText id="department-error" message={errors.departmentId} />
            </label>
          </div>
        </section>

        <section className="form-section" aria-labelledby="order-heading" >
          <h2 id="order-heading"><span className="step-number" aria-hidden="true">2</span>What do you need?</h2>
          <div className="field-grid">
            <label className="field">
              <span>Store or company</span>
              <small id="vendor-help">Where will this be bought from?</small>
              <input
                id="field-vendorName"
                autoComplete="off"
                value={draft.vendorName}
                onChange={(event) => updateField('vendorName', event.target.value)}
                aria-invalid={Boolean(errors.vendorName)}
                aria-describedby={errors.vendorName ? 'vendor-help vendor-error' : 'vendor-help'}
              />
              <ErrorText id="vendor-error" message={errors.vendorName} />
            </label>
          </div>

          <div className="line-items" aria-label="Items requested">
            {draft.items.map((item, index) => (
              <div className="line-item" key={item.id}>
                <h3 className="line-item__title">Item {index + 1}</h3>
                <label className="field line-item__description">
                  <span>What is it?</span>
                  <input
                    id={`field-items.${index}.description`}
                    value={item.description}
                    onChange={(event) => updateItem(index, 'description', event.target.value)}
                    aria-invalid={Boolean(errors[`items.${index}.description`])}
                    aria-describedby={errors[`items.${index}.description`] ? `item-${index}-description-error` : undefined}
                  />
                  <ErrorText
                    id={`item-${index}-description-error`}
                    message={errors[`items.${index}.description`]}
                  />
                </label>
                <label className="field line-item__quantity">
                  <span>How many?</span>
                  <DecimalInput
                    id={`field-items.${index}.quantity`}
                    value={item.quantity}
                    onValueChange={(value) => updateItem(index, 'quantity', value)}
                    aria-invalid={Boolean(errors[`items.${index}.quantity`])}
                    aria-describedby={errors[`items.${index}.quantity`] ? `item-${index}-quantity-error` : undefined}
                  />
                  <ErrorText id={`item-${index}-quantity-error`} message={errors[`items.${index}.quantity`]} />
                </label>
                <label className="field line-item__price">
                  <span>Price for one</span>
                  <span className="money-input">
                    <span aria-hidden="true">$</span>
                    <DecimalInput
                      id={`field-items.${index}.unitPrice`}
                      value={item.unitPrice}
                      onValueChange={(value) => updateItem(index, 'unitPrice', value)}
                      aria-invalid={Boolean(errors[`items.${index}.unitPrice`])}
                      aria-describedby={errors[`items.${index}.unitPrice`] ? `item-${index}-price-error` : undefined}
                    />
                  </span>
                  <ErrorText id={`item-${index}-price-error`} message={errors[`items.${index}.unitPrice`]} />
                </label>
                <div className="line-item__total">
                  <span>Cost of this item</span>
                  <strong>{formatMoney(calculateLineTotal(item))}</strong>
                </div>
                {draft.items.length > 1 && (
                  <button className="line-item__remove" type="button" onClick={() => removeItem(index)}>
                    Remove item {index + 1}
                  </button>
                )}
              </div>
            ))}
          </div>
          <button className="button add-item" type="button" ref={addItemRef} onClick={addItem} disabled={draft.items.length >= 25}>
            Add another item
          </button>
        </section>

        <section className="form-section" aria-labelledby="reason-heading" >
          <h2 id="reason-heading"><span className="step-number" aria-hidden="true">3</span>Why do you need it?</h2>
          <label className="field">
            <span>Reason for this purchase</span>
            <small id="reason-help">One or two sentences is fine. For example: the old printer stopped working.</small>
            <textarea
              id="field-businessReason"
              rows={3}
              value={draft.businessReason}
              onChange={(event) => updateField('businessReason', event.target.value)}
              aria-invalid={Boolean(errors.businessReason)}
              aria-describedby={errors.businessReason ? 'reason-help reason-error' : 'reason-help'}
            />
            <ErrorText id="reason-error" message={errors.businessReason} />
          </label>
          <details className="optional-details" open={optionalOpen} onToggle={(event) => setOptionalOpen(event.currentTarget.open)}>
            <summary>Add a link or project code (optional)</summary>
            <div className="field-grid">
              <label className="field">
                <span>Link to the item (optional)</span>
                <small id="vendor-url-help">Copy the web address of the item and paste it here.</small>
                <input
                  id="field-vendorUrl"
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={draft.vendorUrl}
                  onChange={(event) => updateField('vendorUrl', event.target.value)}
                  onBlur={(event) => updateField('vendorUrl', normalizeLink(event.target.value))}
                  aria-invalid={Boolean(errors.vendorUrl)}
                  aria-describedby={errors.vendorUrl ? 'vendor-url-help vendor-url-error' : 'vendor-url-help'}
                />
                <ErrorText id="vendor-url-error" message={errors.vendorUrl} />
              </label>
              <label className="field">
                <span>Project code (optional)</span>
                <small id="cost-center-help">Leave this empty if you do not have one.</small>
                <input
                  id="field-costCenter"
                  autoCapitalize="characters"
                  value={draft.costCenter}
                  onChange={(event) => updateField('costCenter', event.target.value)}
                  maxLength={50}
                  aria-describedby="cost-center-help"
                />
              </label>
            </div>
          </details>
        </section>

        <label className="honeypot" aria-hidden="true">
          Website
          <input
            tabIndex={-1}
            autoComplete="off"
            value={draft.website}
            onChange={(event) => updateField('website', event.target.value)}
          />
        </label>

        </fieldset>

        <section className="submit-section" >
          <div className="submit-summary">
            <h2>Total: {formatMoney(totals.total)}</h2>
            <p>Prices are in US dollars. After you send this, you will get a code to check on your request.</p>
          </div>
          <Turnstile key={turnstileVersion} onToken={handleTurnstile} />
          <button className="button button--primary button--large" type="submit" disabled={isSubmitting || departmentsLoading || !departments.length}>
            {isSubmitting ? 'Sending…' : retryPending ? 'Try sending again' : 'Send request'}
          </button>
        </section>
      </form>
    </main>
  )
}
